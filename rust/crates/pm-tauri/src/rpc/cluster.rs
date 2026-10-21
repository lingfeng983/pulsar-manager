//! 集群类 RPC：列表、探活、增删改、连接测试。
//!
//! 前端传 camelCase，`ClusterDraft` 用 `rename_all = "camelCase"` 接收，
//! 这里不能再转 snake_case——两套转换叠加会让 `serviceUrl` 变成 `service_url`，
//! 反序列化直接报 missing field `serviceUrl`。

use serde::Deserialize;
use serde_json::{json, Value};

use crate::bridge::{fail, ok, Shared};

pub async fn dispatch(context: Shared, method: &str, args: Vec<Value>) -> Option<Value> {
    Some(match method {
        "cluster:list" => {
            let context = context.clone();
            crate::bridge::blocking(move || context.list_clusters()).await
        }

        "cluster:checkStatus" => {
            let context = context.clone();
            let list = match crate::bridge::blocking({
                let context = context.clone();
                move || context.list_clusters()
            })
            .await
            {
                value if value.get("success").and_then(Value::as_bool) == Some(true) => value,
                other => return Some(other),
            };

            let ids: Vec<String> = list
                .get("data")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.get("id").and_then(Value::as_str))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();

            // 逐集群并发探活：单集群内部 healthCheck 的候选端点是顺序试的，
            // 并发只发生在集群之间，不会把一个 broker 打满。
            let mut tasks = tokio::task::JoinSet::new();
            for id in ids {
                let context = context.clone();
                tasks.spawn(async move {
                    let probe = context.probe(&id).await;
                    if let Ok(result) = &probe {
                        let status = if result.connected {
                            "connected"
                        } else {
                            "disconnected"
                        };
                        let _ = context.set_status(&id, status, result.version.as_deref());
                    }
                });
            }
            while tasks.join_next().await.is_some() {}

            let context = context.clone();
            crate::bridge::blocking(move || context.list_clusters()).await
        }

        "cluster:testConnection" => {
            let draft = parse_draft(args.first());
            let context = context.clone();
            match draft {
                Ok(draft) => match context.test_connection(&draft).await {
                    Ok(result) => ok(result),
                    Err(error) => fail(error),
                },
                Err(error) => json!({ "success": false, "error": error }),
            }
        }

        "cluster:add" | "cluster:update" => {
            // add 的载荷是第 1 个参数；update 的签名是 (id, payload)，
            // 错位取 args[0] 会把 id 字符串当结构体反序列化，报 invalid type。
            let is_update = method == "cluster:update";
            let mut draft = match parse_draft(draft_payload(method, &args)) {
                Ok(draft) => draft,
                Err(error) => return Some(json!({ "success": false, "error": error })),
            };
            if is_update {
                // update 的 id 在第一个位置参数上，草稿里可能没有
                draft.id = args
                    .first()
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or(draft.id);
            }
            let save_context = context.clone();
            let saved = crate::bridge::blocking(move || save_context.save_cluster(&draft)).await;
            if saved.get("success").and_then(Value::as_bool) != Some(true) {
                return Some(saved);
            }
            let id = saved
                .get("data")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let context = context.clone();
            crate::bridge::blocking(move || context.view_cluster(&id)).await
        }

        "cluster:delete" => {
            let id = args
                .first()
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let context = context.clone();
            crate::bridge::blocking(move || context.delete_cluster(&id)).await
        }

        _ => return None,
    })
}

/// add 的载荷只有第 1 个参数；update 是 (id, payload)，载荷在第 2 个。
fn draft_payload<'a>(method: &str, args: &'a [Value]) -> Option<&'a Value> {
    if method == "cluster:update" {
        args.get(1)
    } else {
        args.first()
    }
}

/// 直接按 camelCase 反序列化（见文件头注释）；失败时给出可读原因。
fn parse_draft(value: Option<&Value>) -> Result<pm_core::ClusterDraft, String> {
    let raw = value.cloned().unwrap_or_else(|| json!({}));
    pm_core::ClusterDraft::deserialize(&raw).map_err(|error| format!("集群配置不合法：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draft_accepts_frontend_camel_case() {
        let raw = json!({
            "name": "local",
            "serviceUrl": "pulsar://localhost:6650",
            "webServiceUrl": "http://localhost:8080",
            "tlsEnabled": false,
            "adminApiTimeout": 5000
        });
        let draft = parse_draft(Some(&raw)).expect("camelCase 草稿应当能解析");
        assert_eq!(draft.service_url, "pulsar://localhost:6650");
        assert_eq!(
            draft.web_service_url.as_deref(),
            Some("http://localhost:8080")
        );
        assert_eq!(draft.admin_api_timeout, Some(5000));
    }

    #[test]
    fn update_payload_is_the_second_argument() {
        let args = vec![
            json!("cluster-id"),
            json!({ "serviceUrl": "pulsar://localhost:6650" }),
        ];
        let draft = parse_draft(draft_payload("cluster:update", &args)).unwrap();
        assert_eq!(draft.service_url, "pulsar://localhost:6650");
        let add = parse_draft(draft_payload(
            "cluster:add",
            &[json!({ "serviceUrl": "pulsar://x" })],
        ));
        assert_eq!(add.unwrap().service_url, "pulsar://x");
    }

    #[test]
    fn draft_tolerates_missing_optional_fields() {
        let raw = json!({ "name": "local", "serviceUrl": "pulsar://localhost:6650" });
        let draft = parse_draft(Some(&raw)).expect("只有必填项时也要能解析");
        assert_eq!(draft.service_url, "pulsar://localhost:6650");
        assert!(!draft.tls_enabled);
    }
}
