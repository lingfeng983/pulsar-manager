//! 策略与 Function Worker 的 RPC。
//!
//! 参数都是单个对象（与 `src/preload.ts` 里的 `params` 对应），字段名 camelCase。
//! 命名空间/topic 批量同步的语义是「让目标在所选字段上等于源」，plan 与 apply
//! 各自重新读一遍 broker，界面那份预览只用于核对，不是执行依据。

use serde_json::{json, Value};

use crate::bridge::{fail, ok, Shared};

pub async fn dispatch(context: Shared, method: &str, args: Vec<Value>) -> Option<Value> {
    let params = args.first().cloned().unwrap_or_else(|| json!({}));

    let handled = matches!(
        method,
        "namespace:policies:get"
            | "namespace:policy:set"
            | "namespace:policy:clear"
            | "namespace:policies:sync:plan"
            | "namespace:policies:sync:apply"
            | "topic:policy:get"
            | "topic:policy:set"
            | "topic:policy:clear"
            | "topic:policy:sync:plan"
            | "topic:policy:sync:apply"
            | "worker:state"
            | "worker:items:list"
            | "worker:item:get"
            | "worker:item:create"
            | "worker:item:control"
            | "worker:item:delete"
            | "worker:function:trigger"
            | "worker:builtin:list"
            | "worker:builtin:reload"
    );
    if !handled {
        return None;
    }

    let cluster = text(&params, "clusterId");
    let client = match admin(&context, &cluster).await {
        Ok(client) => client,
        Err(payload) => return Some(payload),
    };

    Some(match method {
        // ---------- 命名空间策略 ----------
        "namespace:policies:get" => settle(
            client
                .namespace_policy_view(&text(&params, "tenant"), &text(&params, "namespace"))
                .await,
        ),
        "namespace:policy:set" => {
            let field = text(&params, "field");
            let value = params.get("value").cloned().unwrap_or(Value::Null);
            settle(
                client
                    .set_namespace_policy(
                        &text(&params, "tenant"),
                        &text(&params, "namespace"),
                        &field,
                        value,
                    )
                    .await,
            )
        }
        "namespace:policy:clear" => {
            let field = text(&params, "field");
            let quota_type = params
                .get("quotaType")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            settle(
                client
                    .clear_namespace_policy(
                        &text(&params, "tenant"),
                        &text(&params, "namespace"),
                        &field,
                        quota_type.as_deref(),
                    )
                    .await,
            )
        }
        "namespace:policies:sync:plan" | "namespace:policies:sync:apply" => {
            let source = params.get("source").cloned().unwrap_or_else(|| json!({}));
            let source = pm_pulsar::policies::SyncScope {
                tenant: text(&source, "tenant"),
                namespace: text(&source, "namespace"),
            };
            let targets: Vec<pm_pulsar::policies::SyncScope> = params
                .get("targets")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .map(|item| pm_pulsar::policies::SyncScope {
                            tenant: text(item, "tenant"),
                            namespace: text(item, "namespace"),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let fields = strings(&params, "fields");
            if method.ends_with("plan") {
                settle(client.plan_namespace_sync(&source, &targets, &fields).await)
            } else {
                settle(client.apply_namespace_sync(&source, &targets, &fields).await)
            }
        }

        // ---------- topic 级策略 ----------
        "topic:policy:get" => settle(
            client
                .topic_policy_view(
                    &text(&params, "tenant"),
                    &text(&params, "namespace"),
                    &text(&params, "topic"),
                    boolean(&params, "persistent", true),
                )
                .await,
        ),
        "topic:policy:set" => {
            let field = text(&params, "field");
            let value = params.get("value").cloned().unwrap_or(Value::Null);
            settle(
                client
                    .set_topic_policy(
                        &text(&params, "tenant"),
                        &text(&params, "namespace"),
                        &text(&params, "topic"),
                        &field,
                        value,
                        boolean(&params, "persistent", true),
                    )
                    .await,
            )
        }
        "topic:policy:clear" => {
            let field = text(&params, "field");
            settle(
                client
                    .clear_topic_policy(
                        &text(&params, "tenant"),
                        &text(&params, "namespace"),
                        &text(&params, "topic"),
                        &field,
                        boolean(&params, "persistent", true),
                    )
                    .await,
            )
        }
        "topic:policy:sync:plan" | "topic:policy:sync:apply" => {
            let source = params.get("source").cloned().unwrap_or_else(|| json!({}));
            let scope = |value: &Value| pm_pulsar::policies::TopicScope {
                tenant: text(value, "tenant"),
                namespace: text(value, "namespace"),
                topic: text(value, "topic"),
                persistent: boolean(value, "persistent", true),
            };
            let source = scope(&source);
            let targets: Vec<pm_pulsar::policies::TopicScope> = params
                .get("targets")
                .and_then(Value::as_array)
                .map(|items| items.iter().map(scope).collect())
                .unwrap_or_default();
            let fields = strings(&params, "fields");
            if method.ends_with("plan") {
                settle(client.plan_topic_sync(&source, &targets, &fields).await)
            } else {
                settle(client.apply_topic_sync(&source, &targets, &fields).await)
            }
        }

        // ---------- Function Worker ----------
        "worker:state" => settle(client.worker_state().await),
        "worker:items:list" => settle(
            client
                .worker_items(
                    &text(&params, "kind"),
                    &text(&params, "tenant"),
                    &text(&params, "namespace"),
                )
                .await,
        ),
        "worker:item:get" => settle(
            client
                .worker_item(
                    &text(&params, "kind"),
                    &text(&params, "tenant"),
                    &text(&params, "namespace"),
                    &text(&params, "name"),
                )
                .await,
        ),
        "worker:item:create" => {
            let kind = text(&params, "kind");
            let config = build_runtime_config(&params);
            let package = params
                .get("localPackagePath")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let archive = params
                .get("archive")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty());
            // 本地包只接受刚在系统对话框里选过的那个路径：渲染层不能自己拼一个路径让主进程去读
            if let Some(path) = package.as_deref() {
                if !crate::bridge::picked_package_allowed(path) {
                    return Some(fail(pm_core::AppError::Other(
                        "这个本地包不在本次选择的记录里，请用「选择文件」重新选一次".into(),
                    )));
                }
            }
            settle(
                client
                    .register_runtime(
                        &kind,
                        &text(&params, "tenant"),
                        &text(&params, "namespace"),
                        &text(&params, "name"),
                        &config.to_string(),
                        package.as_deref(),
                        archive,
                    )
                    .await,
            )
        }
        "worker:item:control" => {
            let instance = params.get("instanceId").and_then(Value::as_i64);
            settle(
                client
                    .worker_control(
                        &text(&params, "kind"),
                        &text(&params, "tenant"),
                        &text(&params, "namespace"),
                        &text(&params, "name"),
                        &text(&params, "action"),
                        instance,
                    )
                    .await,
            )
        }
        "worker:item:delete" => settle(
            client
                .worker_delete(
                    &text(&params, "kind"),
                    &text(&params, "tenant"),
                    &text(&params, "namespace"),
                    &text(&params, "name"),
                )
                .await,
        ),
        "worker:function:trigger" => {
            let data = params.get("data").and_then(Value::as_str).unwrap_or("");
            settle(
                client
                    .worker_trigger(
                        &text(&params, "tenant"),
                        &text(&params, "namespace"),
                        &text(&params, "name"),
                        &text(&params, "topic"),
                        data,
                    )
                    .await,
            )
        }
        "worker:builtin:list" => settle(client.worker_builtins(&text(&params, "kind")).await),
        "worker:builtin:reload" => settle(client.worker_reload_builtins(&text(&params, "kind")).await),

        other => json!({
            "success": false,
            "error": format!("尚未迁移的方法：{other}"),
        }),
    })
}

/// 与 `WorkerAPI.buildCreateBody` 同口径：空字段不发，避免被 Jackson 的严格反序列化拒掉。
fn build_runtime_config(params: &Value) -> Value {
    let kind = text(params, "kind");
    let mut body = json!({
        "tenant": text(params, "tenant"),
        "namespace": text(params, "namespace"),
        "name": text(params, "name"),
    });
    let map = body.as_object_mut().expect("刚构造的对象");

    let class_name = text(params, "className");
    if !class_name.is_empty() {
        map.insert("className".into(), json!(class_name));
    }

    // 本地包只把文件名写进包字段：字节在 data 段里，worker 只看 jar/py/go 哪个非空推断运行时
    let archive = params
        .get("archive")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            params
                .get("localPackagePath")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(|path| {
                    std::path::Path::new(path)
                        .file_name()
                        .map(|name| name.to_string_lossy().to_string())
                        .unwrap_or_default()
                })
        });
    if let Some(archive) = archive.filter(|value| !value.is_empty()) {
        let key = if kind == "function" {
            match text(params, "runtime").to_uppercase().as_str() {
                "PYTHON" => "py",
                "GO" => "go",
                _ => "jar",
            }
        } else {
            "archive"
        };
        map.insert(key.into(), json!(archive));
    }

    let inputs = strings(params, "inputs");
    if !inputs.is_empty() {
        map.insert("inputs".into(), json!(inputs));
    }

    // 连接器没有单一输出字段：sink 的目的地在 configs 里，只有 source 叫 topicName
    let output = text(params, "output");
    if !output.is_empty() && kind != "sink" {
        let key = if kind == "function" { "output" } else { "topicName" };
        map.insert(key.into(), json!(output));
    }

    let log_topic = text(params, "logTopic");
    if !log_topic.is_empty() {
        map.insert("logTopic".into(), json!(log_topic));
    }

    let parallelism = params.get("parallelism").and_then(Value::as_i64).unwrap_or(0);
    if parallelism > 1 {
        map.insert("parallelism".into(), json!(parallelism));
    }

    let guarantee = text(params, "processingGuarantee");
    if !guarantee.is_empty() {
        map.insert("processingGuarantees".into(), json!(guarantee));
    }

    let cpu = params.get("cpu").and_then(Value::as_f64);
    let ram = params.get("ramMb").and_then(Value::as_i64);
    let disk = params.get("diskMb").and_then(Value::as_i64);
    if cpu.is_some() || ram.is_some() || disk.is_some() {
        // broker 的 ram / disk 是字节，界面统一按 MB 收口
        map.insert(
            "resources".into(),
            json!({
                "cpu": cpu.unwrap_or(1.0),
                "ram": ram.unwrap_or(1024) * 1024 * 1024,
                "disk": disk.unwrap_or(10240) * 1024 * 1024,
            }),
        );
    }

    if let Some(config) = params.get("userConfig").and_then(Value::as_object) {
        if !config.is_empty() {
            let key = if kind == "function" { "userConfig" } else { "configs" };
            map.insert(key.into(), Value::Object(config.clone()));
        }
    }

    body
}

async fn admin(context: &Shared, cluster_id: &str) -> Result<pm_pulsar::AdminClient, Value> {
    let context = context.clone();
    let id = cluster_id.to_string();
    match tokio::task::spawn_blocking(move || context.admin_for(&id)).await {
        Ok(Ok(client)) => Ok(client),
        Ok(Err(error)) => Err(fail(error)),
        Err(error) => Err(json!({ "success": false, "error": format!("任务失败：{error}") })),
    }
}

fn settle<T: serde::Serialize>(result: pm_core::AppResult<T>) -> Value {
    match result {
        Ok(value) => ok(value),
        Err(error) => fail(error),
    }
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn boolean(value: &Value, key: &str, fallback: bool) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(fallback)
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}
