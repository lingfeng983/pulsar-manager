#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod logging;
mod rpc;
mod scheduler;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::bridge::QUITTING;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 用户主动把窗口收进了托盘。
/// 有这个标记之后，任何「页面加载完成」都不许再把窗口弹回来——WebView2 在内存紧张时
/// 会丢弃并重载页面，重载会再触发一次 on_page_load；不看这个标记的话，用户关掉的
/// 窗口会在几分钟后自己出现在屏幕上。
static USER_HIDDEN: AtomicBool = AtomicBool::new(false);

/// 窗口是否已经显示过。
/// 3 秒兜底只为「页面加载失败、on_page_load 永远不来」准备，判断条件必须是
/// 「从没显示过」而不是「现在不可见」：后者会在启动 3 秒内点叉时把窗口重新弹出来，
/// 也就是用户看到的「关掉又自己弹开」。
static EVER_SHOWN: AtomicBool = AtomicBool::new(false);

/// 托盘双击是否要唤回窗口：只认左键。
/// tauri 的 `DoubleClick` 在 Windows 上也可能是右键（底层分支里有 `WM_RBUTTONDBLCLK`），
/// 而右键是专门用来开菜单的；按按钮过滤，任何右键操作都不该把窗口叫回来。
/// 这是防御性收紧，退出期间的主要保障是下面 `QUITTING` 的那一层闸门。
fn tray_double_click_should_show(button: MouseButton) -> bool {
    matches!(button, MouseButton::Left)
}

/// 页面加载完成后是否自动显示窗口。退出中、或用户已把窗口收进托盘，都不许弹。
fn should_show_on_page_load(quitting: bool, user_hidden: bool) -> bool {
    !quitting && !user_hidden
}

/// 3 秒兜底是否补一次显示：只为「从没显示过、且现在确实不可见」准备。
/// 退出中一律不补，否则退出流程末尾窗口会闪回来。
fn should_show_on_fallback(
    quitting: bool,
    user_hidden: bool,
    ever_shown: bool,
    visible: bool,
) -> bool {
    !quitting && !user_hidden && !ever_shown && !visible
}

fn show_main_window(app: &tauri::AppHandle) {
    // 退出已经开始时，托盘双击、菜单「显示主窗口」、单实例唤回都不许把窗口叫回来。
    // 这一步必须在最前面：下面的 show() 会清掉 USER_HIDDEN，晚一步就拦不住了。
    if QUITTING.load(Ordering::SeqCst) {
        pm_core::pm_warn!("[tray] 正在退出，忽略唤回窗口的请求");
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // 托盘/单实例唤回是用户主动要看的，清掉「收进托盘」的标记
    USER_HIDDEN.store(false, Ordering::SeqCst);
    EVER_SHOWN.store(true, Ordering::SeqCst);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// 应用自身的页面：`tauri://` 与 WebView2 上的 `http://tauri.localhost`。
/// 之外的一切都算外链。
fn is_app_page(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// 外链一律交给系统浏览器。
///
/// 两条路都得拦：文档中心的「打开原文」走 `window.open`，WebView2 会开一个
/// 没有任何桥接的新窗口（里面 `electronAPI` 是 undefined）；`<a href>` 直接
/// 导航则会把整个应用换成一个网页，点一下就回不来了。
fn open_external(url: &str) {
    // 只放行 http/https：file:// 或自定义协议等于「点链接就能起任意本地程序」
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        pm_core::pm_warn!("[link] 拒绝打开非 http(s) 地址：{url}");
        return;
    }
    #[cfg(windows)]
    {
        // 走 url.dll 而不是 `cmd /C start`：cmd 会自己解释 & 之类的字符
        let _ = std::process::Command::new("rundll32")
            .arg("url.dll,FileProtocolHandler")
            .arg(url)
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

/// 托盘动作与 Electron 版一致：显示主窗口 / 分隔线 / 退出。
/// 右键弹菜单，双击图标回到窗口（Windows 上单击留给菜单是系统惯例，弹窗走右键）。
fn create_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &separator, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../icons/icon.png"
        ))?)
        .tooltip("Pulsar Manager")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => {
                pm_core::pm_log!("[tray] 用户选择退出");
                // 先立旗再退出：CloseRequested 与所有自动显示路径见到它才会让路。
                // 这里直接用回调给的 app，不绕全局句柄，避免句柄尚未就绪时退出变成空操作。
                QUITTING.store(true, Ordering::SeqCst);
                // 立刻把窗口藏起来：用户看到的「点退出反而弹出页面」就是窗口在退出流程里
                // 重新可见。先 hide 一次，配合上面的旗子，退出期间不会再有页面留在屏幕上。
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick { button, .. } = event {
                if tray_double_click_should_show(button) {
                    show_main_window(tray.app_handle());
                }
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    // 日志先于一切：初始化失败时它是唯一的证据，而且要在无控制台的 release
    // 里也留得下来。sink 安装不依赖数据库，先装不影响后续报错落盘。
    let log_path = logging::init();
    // 每次启动都留一条基准线：用户反馈"没有日志"时，先看有没有这一行；
    // 有它但之后什么都没有，说明是业务没有触发，而不是 sink 没装上。
    pm_core::pm_log!(
        "[app] Pulsar Manager {} 启动，数据库 {}，日志 {}",
        env!("CARGO_PKG_VERSION"),
        pm_store::default_db_path().display(),
        log_path.display()
    );

    let context = match bridge::init() {
        Ok(context) => Arc::new(context),
        Err(error) => {
            // 数据库或密钥库不可用时直接退出：不能退化成明文存储，也不能带着半个
            // 初始化状态进主循环，否则后面每个 RPC 都会各自报一次同样的错。
            // 窗口还没建，用系统对话框把原因说出来，不要留一个闪一下就没的黑框。
            rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Error)
                .set_title("Pulsar Manager 启动失败")
                .set_description(format!("{error}\n\n日志：{}", logging::path().display()))
                .show();
            panic!("初始化失败：{error}");
        }
    };

    // 设置里的 Admin 并发上限在这里推给 pm-pulsar 的进程级闸门：闸门是进程级的，
    // 谁先建 AdminClient 都一样，启动时先落一次才能保证首轮请求就按用户设置跑。
    // 读库失败不阻断启动（闸门停在该 crate 的出厂值上），但必须留痕——否则用户
    // 看到的就是"改了设置没生效"却查不到原因。
    match context.apply_admin_concurrency() {
        Ok(limit) => pm_core::pm_log!("[app] Admin 并发上限 {limit}，取自设置"),
        Err(error) => pm_core::pm_warn!("[app] Admin 并发上限读取失败，沿用出厂值：{error}"),
    }

    // 诊断模式：页面脚本执行前挂上错误捕获，白屏时能直接看到 CSP 违规或
    // 运行时异常，而不是对着一片白猜。
    let diagnose = std::env::var("PM_RPC_LOG").is_ok();

    tauri::Builder::default()
        // 单实例：第二次启动把已有窗口叫到前台，而不是再开一个进程各跑一套后台任务。
        // 必须第一个注册，否则其余插件会在两个进程里各初始化一次。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .manage(context)
        .invoke_handler(tauri::generate_handler![bridge::rpc])
        .setup(move |app| {
            // 后台任务（定时巡检、告警引擎）靠这个句柄往渲染进程推事件
            bridge::set_app_handle(app.handle());
            // 告警评估与定时巡检：两者都只在主进程跑，窗口收进托盘也照样按间隔执行
            scheduler::start(
                app.state::<std::sync::Arc<pm_services::AppContext>>()
                    .inner()
                    .clone(),
            );

            create_tray(app.handle())?;

            let mut builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Pulsar Manager")
                    .inner_size(1400.0, 900.0)
                    .min_inner_size(1000.0, 700.0)
                    // 与 Electron 版一样先不显示，首帧画完再亮，免得白屏闪一下
                    .visible(false)
                    .on_page_load(|window, payload| {
                        // 只有首帧（或重载后用户本来就在看）才显示；收进托盘期间的重载不能弹窗，
                        // 退出流程里的重载更不能——那会把正在退出的窗口又叫回来
                        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                            && should_show_on_page_load(
                                QUITTING.load(Ordering::SeqCst),
                                USER_HIDDEN.load(Ordering::SeqCst),
                            )
                        {
                            EVER_SHOWN.store(true, Ordering::SeqCst);
                            let _ = window.show();
                        }
                    })
                    .on_navigation(|url| {
                        if is_app_page(url) {
                            return true;
                        }
                        open_external(url.as_str());
                        false
                    })
                    .on_new_window(|url, _features| {
                        open_external(url.as_str());
                        tauri::webview::NewWindowResponse::Deny
                    })
                    .center();

            if diagnose {
                builder = builder.initialization_script(ERROR_CAPTURE_JS);
            }

            let window = builder.build()?;

            // 关闭 = 收进托盘
            let closer = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if !QUITTING.load(Ordering::SeqCst) {
                        api.prevent_close();
                        // 先立标记再藏：晚一步的话，藏起来的同一瞬间若有重载事件到达就会弹回来
                        USER_HIDDEN.store(true, Ordering::SeqCst);
                        let _ = closer.hide();
                    }
                }
            });

            // 页面加载失败时 on_page_load 不会来。没有这层兜底，用户只能对着托盘图标
            // 猜窗口去哪了——而那时候恰恰是最需要看到错误画面的。
            // 只在「从没显示过」时补一次：已经显示过的窗口此时不可见，只可能是用户自己收进了托盘。
            let fallback = window.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                if should_show_on_fallback(
                    QUITTING.load(Ordering::SeqCst),
                    USER_HIDDEN.load(Ordering::SeqCst),
                    EVER_SHOWN.load(Ordering::SeqCst),
                    fallback.is_visible().unwrap_or(true),
                ) {
                    EVER_SHOWN.store(true, Ordering::SeqCst);
                    let _ = fallback.show();
                }
            });

            if diagnose {
                let handle = window.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
                    let _ = handle.eval(PROBE_JS);
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 启动失败")
        .run(|_, event| {
            // 隧道是子进程，不会跟着主进程一起消失：退出前统一收掉
            if let tauri::RunEvent::Exit = event {
                pm_services::tunnel::stop_all();
            }
        });
}

/// 在文档创建时注入，早于页面自己的任何脚本，且不受页面 CSP 限制。
const ERROR_CAPTURE_JS: &str = r#"
window.__pmErrors = [];
window.addEventListener('error', function (e) {
  if (e.target && e.target !== window) {
    window.__pmErrors.push('resource: ' + (e.target.src || e.target.href || e.target.tagName));
    return;
  }
  window.__pmErrors.push('error: ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0) + ':' + (e.colno || 0));
}, true);
window.addEventListener('unhandledrejection', function (e) {
  var reason = e.reason;
  window.__pmErrors.push('rejection: ' + String((reason && reason.message) || reason));
});
document.addEventListener('securitypolicyviolation', function (e) {
  window.__pmErrors.push('csp: ' + e.violatedDirective + ' blocked ' + e.blockedURI);
});
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_double_click_only_left_button_reveals_window() {
        assert!(tray_double_click_should_show(MouseButton::Left));
        // 右键是开菜单用的，Windows 会为右键双击也发 DoubleClick
        assert!(!tray_double_click_should_show(MouseButton::Right));
        assert!(!tray_double_click_should_show(MouseButton::Middle));
    }

    #[test]
    fn page_load_never_reveals_window_while_quitting_or_hidden() {
        assert!(should_show_on_page_load(false, false));
        assert!(!should_show_on_page_load(false, true));
        assert!(!should_show_on_page_load(true, false));
        assert!(!should_show_on_page_load(true, true));
    }

    #[test]
    fn fallback_only_fires_once_for_a_never_shown_invisible_window() {
        assert!(should_show_on_fallback(false, false, false, false));
        assert!(!should_show_on_fallback(false, false, true, false));
        assert!(!should_show_on_fallback(false, false, false, true));
        assert!(!should_show_on_fallback(false, true, false, false));
        assert!(!should_show_on_fallback(true, false, false, false));
    }
}

const PROBE_JS: &str = r#"
(function () {
  var root = document.getElementById('root');
  window.__TAURI__.core.invoke('rpc', {
    method: 'debug:probe',
    args: [JSON.stringify({
      rootLen: root ? root.innerHTML.length : -1,
      hasApi: typeof window.electronAPI,
      errors: (window.__pmErrors || []).slice(0, 12),
      errorCount: (window.__pmErrors || []).length
    })]
  });
})();
"#;
