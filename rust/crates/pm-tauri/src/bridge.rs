//! RPC 桥：把前端 157 个 `electronAPI.xxx()` 调用转成 Rust 侧的服务调用。
//!
//! 契约与 Electron 版保持逐字一致：单通道、方法名就是原来的 IPC 通道名、位置参数
//! 原样传入、返回 `{success, data?, error?, code?}`，永不 reject。

use std::path::PathBuf;
use std::sync::Arc;

use pm_core::AppError;
use pm_services::AppContext;
use serde::Serialize;
use serde_json::{json, Value};

pub type Shared = Arc<AppContext>;

/// 全局 AppHandle：后台任务（告警引擎、定时巡检、消费会话）都要往渲染进程推事件，
/// 但它们拿不到 command 的参数，所以在这里留一个句柄。
static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

pub fn set_app_handle(app: &tauri::AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
}

/// 推送失败只记一行日志：界面没开或正在重载时监听器不存在，不是业务错误。
pub fn emit(event: &str, payload: Value) {
    use tauri::Emitter;
    if let Some(app) = APP_HANDLE.get() {
        if let Err(error) = app.emit(event, payload) {
            pm_core::pm_warn!("[emit] {event} 推送失败：{error}");
        }
    }
}

/// 退出应用：拉起安装器后必须让位，否则安装器写文件时本进程还占着 exe 与 dll。
pub fn quit(code: i32) {
    if let Some(app) = APP_HANDLE.get() {
        app.exit(code);
    }
}

/// 用户刚在系统对话框里选过的本地包路径。
///
/// 白名单而不是「按路径读文件」通道：渲染层只能让主进程读它刚刚被授权读的那一个文件，
/// 拼一个任意路径过来是读不到的。
static PICKED_PACKAGES: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

pub fn remember_picked_package(path: &std::path::Path) {
    let mut list = PICKED_PACKAGES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = path.to_path_buf();
    if !list.iter().any(|item| item == &path) {
        list.push(path);
        // 只留最近 20 个：这是一次会话里的授权记录，不是配置
        if list.len() > 20 {
            list.remove(0);
        }
    }
}

pub fn picked_package_allowed(path: &str) -> bool {
    let list = PICKED_PACKAGES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    list.iter().any(|item| item.to_string_lossy() == path)
}

pub fn init() -> pm_core::AppResult<AppContext> {
    let db_path = pm_store::default_db_path();
    let dir = db_path
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    std::fs::create_dir_all(&dir).map_err(AppError::from)?;
    let context = AppContext::open(&db_path, &dir)?;
    Ok(context)
}

#[tauri::command]
pub async fn rpc(
    state: tauri::State<'_, Shared>,
    method: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    // 先把 Arc 拷出来：async command 里不能跨 await 持有 State 的借用。
    let context = state.inner().clone();
    Ok(dispatch(context, &method, args).await)
}

async fn dispatch(context: Shared, method: &str, args: Vec<Value>) -> Value {
    // 方法名常开：排障时先看"界面到底有没有发请求"。args 默认不打——里面可能
    // 有消息正文或凭据；需要时用 PM_RPC_LOG=1 打开完整载荷。
    pm_core::pm_log!("[rpc] {method}");
    if std::env::var("PM_RPC_LOG").is_ok() {
        pm_core::pm_log!("[rpc] {method} args={args:?}");
    }
    // 参数按方法逐个解构，未迁移的分支暂时用不到，等 S2 铺开后再由编译器兜底检查。
    let _ = &args;

    // 按业务域分发，命中即返回；未命中落到下面的兜底分支。
    if let Some(value) = crate::rpc::system::dispatch(context.clone(), method, args.clone()).await {
        return value;
    }
    if let Some(value) = crate::rpc::resource::dispatch(context.clone(), method, args.clone()).await
    {
        return value;
    }
    if let Some(value) = crate::rpc::cluster::dispatch(context.clone(), method, args.clone()).await
    {
        return value;
    }
    if let Some(value) = crate::rpc::observe::dispatch(context.clone(), method, args.clone()).await
    {
        return value;
    }
    if let Some(value) = crate::rpc::policy::dispatch(context.clone(), method, args.clone()).await {
        return value;
    }
    if let Some(value) =
        crate::rpc::workbench::dispatch(context.clone(), method, args.clone()).await
    {
        return value;
    }
    if let Some(value) = crate::rpc::inspect::dispatch(context.clone(), method, args.clone()).await
    {
        return value;
    }
    if let Some(value) = crate::rpc::message::dispatch(context.clone(), method, args.clone()).await
    {
        return value;
    }

    match method {
        // ---------- 诊断 ----------
        "debug:probe" => {
            let detail = args.first().and_then(Value::as_str).unwrap_or("<无载荷>");
            pm_core::pm_log!("[probe] {detail}");
            json!({ "success": true, "data": null })
        }

        other => json!({
            "success": false,
            "error": format!("尚未迁移的方法：{other}"),
        }),
    }
}

/// 同步服务调用放到阻塞线程池，避免把 tokio worker 卡在 SQLite 的锁上。
pub(crate) async fn blocking<T, F>(work: F) -> Value
where
    T: Serialize + Send + 'static,
    F: FnOnce() -> pm_core::AppResult<T> + Send + 'static,
{
    match tokio::task::spawn_blocking(work).await {
        Ok(Ok(value)) => ok(value),
        Ok(Err(error)) => fail(error),
        Err(error) => json!({ "success": false, "error": format!("任务失败：{error}") }),
    }
}

pub(crate) fn ok<T: Serialize>(value: T) -> Value {
    match serde_json::to_value(value) {
        Ok(value) => json!({ "success": true, "data": camelize(value) }),
        Err(error) => json!({ "success": false, "error": format!("序列化失败：{error}") }),
    }
}

pub(crate) fn fail(error: AppError) -> Value {
    let mut payload = json!({ "success": false, "error": error.to_string() });
    // 与 Electron 版一致：只给有业务含义的码，普通错误不带 code，
    // 免得前端把 "ERROR" 也当成需要特殊处理的分支。
    let code = error.code();
    if code != "ERROR" {
        payload["code"] = json!(code);
    }
    payload
}

/// Rust 侧字段是 snake_case，前端契约是 camelCase，在这一层统一转换。
/// 只转结构体字段名：`subscriptions` / `properties` / `partitions` / `raw`
/// 这类值是「用户或 broker 定义键」的 map，键名必须原样保留，否则订阅名
/// `my_sub` 会变成 `mySub`、消息属性 `order_id` 会变成 `orderId`。
fn camelize(value: Value) -> Value {
    camelize_value(value, false)
}

fn camelize_value(value: Value, preserve_keys: bool) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (key, value) in map {
                if preserve_keys {
                    out.insert(key, value);
                    continue;
                }
                let dynamic_map =
                    matches!(key.as_str(), "subscriptions" | "properties" | "partitions");
                let value = if key == "raw" {
                    // raw 是 broker 原文，整体保持原样（内部键可能也是用户数据）
                    value
                } else if dynamic_map {
                    // 只保留这一层 map 的键，值仍然是结构体，要继续转字段名
                    match value {
                        Value::Object(inner) => Value::Object(
                            inner
                                .into_iter()
                                .map(|(inner_key, inner_value)| {
                                    (inner_key, camelize_value(inner_value, false))
                                })
                                .collect(),
                        ),
                        other => camelize_value(other, false),
                    }
                } else {
                    camelize_value(value, false)
                };
                out.insert(snake_to_camel(&key), value);
            }
            Value::Object(out)
        }
        Value::Array(items) => items
            .into_iter()
            .map(|item| camelize_value(item, preserve_keys))
            .collect(),
        other => other,
    }
}

fn snake_to_camel(key: &str) -> String {
    if !key.contains('_') {
        return key.to_string();
    }
    let mut out = String::with_capacity(key.len());
    let mut upper_next = false;
    for ch in key.chars() {
        if ch == '_' {
            upper_next = true;
            continue;
        }
        if upper_next {
            out.extend(ch.to_uppercase());
            upper_next = false;
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_response_keys_to_camel_case() {
        assert_eq!(snake_to_camel("service_url"), "serviceUrl");
        assert_eq!(snake_to_camel("has_auth_params"), "hasAuthParams");
        assert_eq!(snake_to_camel("name"), "name");
    }

    #[test]
    fn camelize_walks_nested_structures() {
        let input = json!({
            "service_url": "pulsar://x",
            "nested": [{ "created_at": "t" }],
            "value": "keep_key_literal"
        });
        let output = camelize(input);
        assert_eq!(output["serviceUrl"], "pulsar://x");
        assert_eq!(output["nested"][0]["createdAt"], "t");
        // 值里的下划线不能被动到
        assert_eq!(output["value"], "keep_key_literal");
    }

    #[test]
    fn camelize_keeps_dynamic_map_keys() {
        let input = json!({
            "subscriptions": { "my_sub": { "msg_backlog": 3 } },
            "properties": { "order_id": "42" },
            "partitions": { "persistent://t/ns/topic-partition-0": { "msg_rate_in": 1 } },
            "raw": { "custom_key": { "nested_key": true } }
        });
        let output = camelize(input);
        // 结构体字段仍然转 camelCase
        assert_eq!(output["subscriptions"]["my_sub"]["msgBacklog"], 3);
        // map 的键必须原样保留
        assert!(output["subscriptions"].get("my_sub").is_some());
        assert!(output["subscriptions"].get("mySub").is_none());
        assert_eq!(output["properties"]["order_id"], "42");
        assert!(output["partitions"]
            .get("persistent://t/ns/topic-partition-0")
            .is_some());
        assert!(output["raw"].get("custom_key").is_some());
        assert!(output["raw"]["custom_key"].get("nested_key").is_some());
    }
}
