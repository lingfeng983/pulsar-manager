//! 系统类 RPC：主题、设置、配置、日志、版本、插件。
//!
//! 与 Electron 版的 handler 一一对应，返回值结构保持逐字一致。

use pm_core::AppError;
use pm_services::AppContext;
use pm_store::{logs, settings};
use serde_json::{json, Map, Value};

use crate::bridge::{blocking, Shared};

/// 版本号取 Cargo workspace 的那一份，别写死：写死后升版会漏改，
/// 而「设置 → 关于」和在线更新的版本比对读的都是它。
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 与 TS 版 `APP_CONFIG_DEFAULTS` 完全一致。库里没有的键就用这里的值，
/// 一个脏行不能让整份配置带崩。
fn default_settings() -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("truncateLength".into(), json!(50));
    map.insert("autoRefresh".into(), json!(true));
    map.insert("refreshIntervalSeconds".into(), json!(30));
    map.insert("fontSize".into(), json!("large"));
    map.insert("statusRefreshSeconds".into(), json!(60));
    map.insert("sendHistoryFullBody".into(), json!(false));
    map.insert("metricsSnapshotEnabled".into(), json!(false));
    map.insert("metricsRetentionDays".into(), json!(7));
    map.insert("alertEnabled".into(), json!(false));
    map.insert("alertCheckSeconds".into(), json!(60));
    map.insert("alertRetentionDays".into(), json!(30));
    // 空串 = 使用默认目录（%APPDATA%\pulsar-manager\logs），不写死绝对路径，
    // 这样导出/导入配置换机器后仍然可用。
    map.insert("logDirectory".into(), json!(""));
    map
}

fn merged_settings(context: &AppContext) -> pm_core::AppResult<Value> {
    let mut merged = default_settings();
    for (key, raw) in settings::raw_all(&context.store)? {
        let Some(slot) = merged.get_mut(&key) else { continue };
        let decoded = match slot {
            Value::Bool(_) => match raw.as_str() {
                "true" => Some(json!(true)),
                "false" => Some(json!(false)),
                _ => None,
            },
            Value::Number(_) => raw.parse::<i64>().ok().map(|value| json!(value)),
            _ => Some(json!(raw)),
        };
        if let Some(value) = decoded {
            *slot = value;
        }
    }
    Ok(Value::Object(merged))
}

/// 只接受默认表里出现过的键，避免前端一次误写把无关设置也塞进库。
fn write_setting(context: &AppContext, key: &str, value: &Value) -> pm_core::AppResult<()> {
    let defaults = default_settings();
    if !defaults.contains_key(key) {
        return Err(AppError::config(format!("未知的配置项：{key}")));
    }
    let text = match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    settings::set(&context.store, key, &text)
}

pub async fn dispatch(context: Shared, method: &str, args: Vec<Value>) -> Option<Value> {
    Some(match method {
        // ---------- 主题 ----------
        "theme:get" => {
            let context = context.clone();
            blocking(move || {
                Ok(settings::get(&context.store, "theme")?.unwrap_or_else(|| "light".into()))
            })
            .await
        }
        "theme:set" => {
            let theme = text_arg(&args, 0);
            let context = context.clone();
            blocking(move || settings::set(&context.store, "theme", &theme)).await
        }

        // ---------- 设置 ----------
        "settings:get" => {
            let key = text_arg(&args, 0);
            let context = context.clone();
            blocking(move || settings::get_raw(&context.store, &key)).await
        }
        "settings:set" => {
            let key = text_arg(&args, 0);
            let value = text_arg(&args, 1);
            let context = context.clone();
            blocking(move || settings::set(&context.store, &key, &value)).await
        }

        // ---------- 配置 ----------
        "config:getAll" => {
            let context = context.clone();
            blocking(move || merged_settings(&context)).await
        }
        "config:update" => {
            let patch = args.first().cloned().unwrap_or_else(|| json!({}));
            let context = context.clone();
            blocking(move || {
                if let Some(map) = patch.as_object() {
                    for (key, value) in map {
                        write_setting(&context, key, value)?;
                    }
                }
                merged_settings(&context)
            })
            .await
        }
        "config:reset" => {
            let context = context.clone();
            blocking(move || {
                for (key, value) in default_settings() {
                    write_setting(&context, &key, &value)?;
                }
                // 恢复默认也把运行中的日志 sink 切回默认目录，否则要等下次启动
                let _ = crate::logging::set_dir(&pm_store::default_log_dir());
                merged_settings(&context)
            })
            .await
        }
        "config:meta" => {
            let path = pm_store::default_db_path().display().to_string();
            let log_path = crate::logging::path();
            let log_dir = log_path
                .parent()
                .map(|dir| dir.display().to_string())
                .unwrap_or_default();
            // 走 bridge::ok 而不是手写 json!：前端契约是 camelCase，
            // 这里手写 snake_case 会让"运行信息"里的路径整行显示为空。
            crate::bridge::ok(json!({
                "app_version": APP_VERSION,
                "database_path": path,
                "log_path": log_path.display().to_string(),
                "log_dir": log_dir,
            }))
        }
        "config:export" => {
            let context = context.clone();
            blocking(move || {
                let settings = merged_settings(&context)?;
                Ok(json!({
                    "format": "pulsar-manager-config",
                    "version": 1,
                    "settings": settings,
                    "clusters": [],
                    "shortcuts": Value::Null,
                }))
            })
            .await
        }
        "config:import" => {
            let bundle = args.first().cloned().unwrap_or_else(|| json!({}));
            let context = context.clone();
            blocking(move || {
                if let Some(settings) = bundle.get("settings").and_then(Value::as_object) {
                    for (key, value) in settings {
                        write_setting(&context, key, value)?;
                    }
                    // 导入的日志目录立即生效，不用等重启；空串回默认目录
                    if let Some(value) = settings.get("logDirectory").and_then(Value::as_str) {
                        let dir = if value.trim().is_empty() {
                            pm_store::default_log_dir()
                        } else {
                            std::path::PathBuf::from(value.trim())
                        };
                        crate::logging::set_dir(&dir)?;
                    }
                }
                merged_settings(&context)
            })
            .await
        }
        "config:clearLogs" => {
            let context = context.clone();
            blocking(move || logs::clear(&context.store).map(|deleted| json!({ "deleted": deleted })))
                .await
        }

        // ---------- 日志与版本 ----------
        "logs:getRecent" => {
            let limit = args.first().and_then(Value::as_i64).unwrap_or(200);
            let context = context.clone();
            blocking(move || logs::list(&context.store, limit)).await
        }
        // 导出走系统"另存为"对话框：浏览器式 download 只会静默落到默认下载目录，
        // 用户既看不到文件去了哪，也没法选位置。
        "logs:export" => export_logs(context).await,
        "logs:openDir" => {
            let dir = crate::logging::path()
                .parent()
                .map(|dir| dir.to_path_buf())
                .unwrap_or_else(pm_store::default_log_dir);
            let _ = std::fs::create_dir_all(&dir);
            #[cfg(target_os = "windows")]
            let failure = std::process::Command::new("explorer").arg(&dir).spawn().err();
            #[cfg(target_os = "macos")]
            let failure = std::process::Command::new("open").arg(&dir).spawn().err();
            #[cfg(all(unix, not(target_os = "macos")))]
            let failure = std::process::Command::new("xdg-open").arg(&dir).spawn().err();
            json!({
                "success": true,
                "data": {
                    "dir": dir.display().to_string(),
                    "failure": failure.map(|error| format!("打开目录失败：{error}")),
                }
            })
        }
        // 目录只能由系统对话框产生：开一条"按路径写日志"的通道等于把任意目录
        // 交给页面。选完立刻切换 sink，并落库供下次启动使用。
        "logs:chooseDir" => {
            let picked = tokio::task::spawn_blocking(|| {
                rfd::FileDialog::new()
                    .set_title("选择运行时日志目录")
                    .pick_folder()
            })
            .await;
            match picked {
                Ok(None) => json!({ "success": true, "data": null }),
                Ok(Some(dir)) => match crate::logging::set_dir(&dir) {
                    Ok(path) => {
                        let text = dir.to_string_lossy().to_string();
                        let context = context.clone();
                        let saved = blocking(move || {
                            settings::set(&context.store, "logDirectory", &text)
                                .map(|_| json!({ "dir": text }))
                        })
                        .await;
                        if saved.get("success").and_then(Value::as_bool) != Some(true) {
                            return Some(saved);
                        }
                        json!({
                            "success": true,
                            "data": {
                                "dir": dir.display().to_string(),
                                "path": path.display().to_string(),
                            }
                        })
                    }
                    Err(error) => crate::bridge::fail(error),
                },
                Err(error) => crate::bridge::fail(AppError::Other(format!("对话框失败：{error}"))),
            }
        }
        "update:getVersion" => json!({ "success": true, "data": APP_VERSION }),

        // ---------- 检查更新 ----------
        "update:check" => {
            let watermark = format!("rust/{APP_VERSION}");
            match pm_services::update::check(APP_VERSION, &watermark).await {
                Ok(result) => crate::bridge::ok(result),
                Err(error) => {
                    // 更新源是公开仓：401/403/404 都说明「源本身不可读」，别说成用户少配了什么
                    let text = error.to_string();
                    if text.contains("404") || text.contains("403") || text.contains("401") {
                        json!({
                            "success": false,
                            "error": "更新源不可读：公开分发仓库 pulsar-manager-dist 还没有发行版，或它已被改为私有/删除"
                        })
                    } else {
                        crate::bridge::fail(error)
                    }
                }
            }
        }
        "update:download" => {
            let url = args.first().and_then(Value::as_str).unwrap_or("").to_string();
            let dir = pm_services::update::updates_dir(&context_dir());
            let emit: pm_services::messaging::Emit =
                std::sync::Arc::new(|event: &str, payload: Value| crate::bridge::emit(event, payload));
            match pm_services::update::download(&url, &dir, emit).await {
                Ok(file) => json!({ "success": true, "data": { "file": file } }),
                Err(error) => crate::bridge::fail(error),
            }
        }
        "update:install" => match pm_services::update::launch_installer() {
            Ok(_) => {
                // 安装器已经拉起，本进程必须让位：它占着 exe 与 dll，边写边装只会装出半个版本
                crate::bridge::quit(0);
                json!({ "success": true, "data": null })
            }
            Err(error) => crate::bridge::fail(error),
        },

        // ---------- 端口转发 ----------
        //
        // 不做协议实现：交给用户机器上已经配好的 ssh / kubectl，顺带继承 ProxyJump、
        // kubeconfig 上下文与证书插件。代价是密码登录无法自动化（ssh 从终端读密码）。
        "ssh:connect" => {
            let config = args.first().cloned().unwrap_or_else(|| json!({}));
            let remote_host = {
                let remote = string_arg(&config, "remoteHost");
                if remote.is_empty() {
                    string_arg(&config, "host")
                } else {
                    remote
                }
            };
            let spec = pm_services::tunnel::SshSpec {
                host: string_arg(&config, "host"),
                port: number_arg(&config, "port", 22),
                username: string_arg(&config, "username"),
                private_key: config
                    .get("privateKey")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string),
                remote_host,
                remote_admin_port: number_arg(&config, "remoteAdminPort", 8080),
                remote_broker_port: number_arg(&config, "remoteBrokerPort", 6650),
            };
            if spec.private_key.is_none() {
                crate::bridge::fail(AppError::Unsupported(
                    "SSH 隧道需要密钥登录：请在集群配置里填私钥（或先在本机建好 ssh agent），密码登录无法在桌面进程里自动完成".into(),
                ))
            } else {
                match pm_services::tunnel::start_ssh(&spec) {
                    Ok(endpoint) => json!({
                        "success": true,
                        "data": {
                            "tunnelId": endpoint.tunnel_id,
                            "localPort": endpoint.local_admin_port,
                            "localBrokerPort": endpoint.local_broker_port,
                        }
                    }),
                    Err(error) => crate::bridge::fail(error),
                }
            }
        }
        "ssh:disconnect" => {
            let id = args.first().and_then(Value::as_str).unwrap_or("");
            json!({ "success": true, "data": pm_services::tunnel::stop(id) })
        }
        "k8s:connect" => {
            let config = args.first().cloned().unwrap_or_else(|| json!({}));
            let spec = pm_services::tunnel::K8sSpec {
                namespace: string_arg(&config, "namespace"),
                resource: string_arg(&config, "resource"),
                context: config
                    .get("context")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string),
                kubeconfig_path: config
                    .get("kubeconfigPath")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string),
                kubectl_path: config
                    .get("kubectlPath")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string),
                remote_admin_port: number_arg(&config, "remoteAdminPort", 8080),
                remote_broker_port: number_arg(&config, "remoteBrokerPort", 6650),
            };
            match pm_services::tunnel::start_k8s(&spec) {
                Ok(endpoint) => json!({
                    "success": true,
                    "data": {
                        "forwardId": endpoint.tunnel_id,
                        "localAdminPort": endpoint.local_admin_port,
                        "localBrokerPort": endpoint.local_broker_port,
                    }
                }),
                Err(error) => crate::bridge::fail(error),
            }
        }
        "k8s:disconnect" => {
            let id = args.first().and_then(Value::as_str).unwrap_or("");
            json!({ "success": true, "data": pm_services::tunnel::stop(id) })
        }

        // ---------- 插件 ----------
        //
        // 插件是**声明式数据**：只贡献压测预设和 Topic 模板，不加载也不执行任何插件代码。
        // 所以这里可以放心读写目录——最坏情况只是某个插件文件解析失败，界面上会给出
        // 文件名和原因，不会把应用带崩。
        "plugin:list" => {
            let context = context.clone();
            blocking(move || pm_services::plugins::list(&context.store)).await
        }
        "plugin:installOfficial" => {
            let id = args
                .first()
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let context = context.clone();
            blocking(move || pm_services::plugins::install_official(&context.store, &id)).await
        }
        // 渲染层把文件读成文本发过来，这里只认内容：不收路径，避免被指到机器上的任意文件
        "plugin:import" => {
            let text = args
                .first()
                .and_then(|value| value.get("text"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let context = context.clone();
            blocking(move || pm_services::plugins::install_from_text(&context.store, &text)).await
        }
        "plugin:uninstall" => {
            let id = args
                .first()
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let context = context.clone();
            blocking(move || pm_services::plugins::uninstall(&context.store, &id)).await
        }
        "plugin:setEnabled" => {
            let payload = args.first().cloned().unwrap_or_else(|| json!({}));
            let id = payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let enabled = payload.get("enabled").and_then(Value::as_bool).unwrap_or(false);
            let context = context.clone();
            blocking(move || pm_services::plugins::set_enabled(&context.store, &id, enabled)).await
        }
        // 只是打开插件目录，不依赖插件运行时
        "plugin:revealDir" => {
            let dir = pm_services::plugins::plugins_dir();
            let _ = std::fs::create_dir_all(&dir);
            #[cfg(target_os = "windows")]
            let failure = std::process::Command::new("explorer").arg(&dir).spawn().err();
            #[cfg(target_os = "macos")]
            let failure = std::process::Command::new("open").arg(&dir).spawn().err();
            #[cfg(all(unix, not(target_os = "macos")))]
            let failure = std::process::Command::new("xdg-open").arg(&dir).spawn().err();
            json!({
                "success": true,
                "data": {
                    "dir": dir.to_string_lossy(),
                    "failure": failure.map(|error| format!("打开目录失败：{error}")),
                }
            })
        }

        // ---------- 本地包选择 ----------
        //
        // 路径只能由系统对话框产生：开一条「按路径读文件」的通道等于把整台机器交给页面。
        "file:pickArchive" => {
            let picked = tokio::task::spawn_blocking(|| {
                rfd::FileDialog::new()
                    .set_title("选择函数 / 连接器的包")
                    .add_filter("常见的包（jar / nar / zip / py）", &["jar", "nar", "zip", "py"])
                    .pick_file()
            })
            .await;
            match picked {
                Ok(None) => json!({ "success": true, "data": null }),
                Ok(Some(path)) => match std::fs::metadata(&path) {
                    Ok(meta) if !meta.is_file() => json!({ "success": false, "error": "选中的不是文件" }),
                    Ok(meta) if meta.len() == 0 => json!({
                        "success": false,
                        "error": "这个文件是空的，worker 取过去也加载不了"
                    }),
                    Ok(meta) => {
                        crate::bridge::remember_picked_package(&path);
                        json!({
                            "success": true,
                            "data": {
                                "path": path.to_string_lossy(),
                                "name": path
                                    .file_name()
                                    .map(|name| name.to_string_lossy().to_string())
                                    .unwrap_or_default(),
                                "size": meta.len(),
                            }
                        })
                    }
                    Err(error) => {
                        crate::bridge::fail(AppError::Other(format!("读不到这个文件：{error}")))
                    }
                },
                Err(error) => crate::bridge::fail(AppError::Other(format!("对话框失败：{error}"))),
            }
        }

        _ => return None,
    })
}

/// 导出一份日志包（操作日志 + 运行时日志文本）到用户选的位置。
///
/// 两份日志本来就是排障时一起看的：操作日志回答"谁在什么时候做了什么"，
/// 运行时日志回答"后台为什么失败"。合成一个 JSON 文件，用户只需选一次位置。
async fn export_logs(context: Shared) -> Value {
    let snapshot = {
        let context = context.clone();
        tokio::task::spawn_blocking(move || {
            let items = logs::list(&context.store, 5000)?;
            Ok::<_, AppError>((items, runtime_log_text()))
        })
        .await
    };
    let (items, runtime) = match snapshot {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => return crate::bridge::fail(error),
        Err(error) => {
            return crate::bridge::fail(AppError::Other(format!("任务失败：{error}")))
        }
    };
    let operation_log_count = items.len();

    let default_name = format!(
        "pulsar-manager-logs_{}.json",
        chrono::Local::now().format("%Y%m%d_%H%M%S")
    );
    let picked = tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("导出日志")
            .set_file_name(&default_name)
            .add_filter("日志文件", &["json"])
            .save_file()
    })
    .await;
    let path = match picked {
        Ok(None) => return json!({ "success": true, "data": null }),
        Ok(Some(path)) => path,
        Err(error) => {
            return crate::bridge::fail(AppError::Other(format!("对话框失败：{error}")))
        }
    };

    let payload = json!({
        "format": "pulsar-manager-logs",
        "version": 1,
        "exportedAt": pm_core::now_iso(),
        "appVersion": APP_VERSION,
        "runtimeLogPath": crate::logging::path().display().to_string(),
        "runtimeLog": runtime,
        "operationLogs": items,
    });
    let text = match serde_json::to_string_pretty(&payload) {
        Ok(text) => text,
        Err(error) => {
            return crate::bridge::fail(AppError::Other(format!("生成日志文件失败：{error}")))
        }
    };
    match std::fs::write(&path, text.as_bytes()) {
        Ok(()) => json!({
            "success": true,
            "data": {
                "path": path.display().to_string(),
                "bytes": text.len(),
                "operationLogCount": operation_log_count,
            }
        }),
        Err(error) => crate::bridge::fail(AppError::Other(format!(
            "写日志文件失败 {}：{error}",
            path.display()
        ))),
    }
}

/// 旧一轮 + 当前一轮按时间顺序拼接；文件都读不到时给一句人话，导出包仍是合法 JSON。
fn runtime_log_text() -> String {
    let path = crate::logging::path();
    let backup = path.with_file_name("main.1.log");
    let mut text = String::new();
    for file in [backup, path] {
        if let Ok(content) = std::fs::read_to_string(&file) {
            text.push_str(&content);
        }
    }
    if text.is_empty() {
        text.push_str("（还没有运行时日志）\n");
    }
    text
}

/// 数据目录：更新包落在 <userData>/updates，插件目录在 <userData>/plugins。
fn context_dir() -> std::path::PathBuf {
    pm_store::default_db_path()
        .parent()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

fn string_arg(payload: &Value, key: &str) -> String {
    payload
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn number_arg(payload: &Value, key: &str, fallback: u16) -> u16 {
    payload
        .get(key)
        .and_then(Value::as_u64)
        .map(|value| value as u16)
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn text_arg(args: &[Value], index: usize) -> String {
    args.get(index)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

