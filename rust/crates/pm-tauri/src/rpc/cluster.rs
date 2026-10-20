//! 集群类 RPC：列表、探活、增删改、连接测试。
//!
//! 前端传 camelCase，Rust 侧结构是 snake_case，这里统一走 `snakeize` 转换。

use serde::Deserialize;
use serde_json::{json, Value};

use crate::bridge::{fail, ok, snakeize, Shared};

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
                        let status = if result.connected { "connected" } else { "disconnected" };
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
                Ok(draft) => {
                    match context.test_connection(&draft).await {
                        Ok(result) => ok(result),
                        Err(error) => fail(error),
                    }
                }
                Err(error) => json!({ "success": false, "error": error }),
            }
        }

        "cluster:add" | "cluster:update" => {
            let mut draft = match parse_draft(args.first()) {
                Ok(draft) => draft,
                Err(error) => return Some(json!({ "success": false, "error": error })),
            };
            if method == "cluster:update" {
                // update 的 id 在第一个位置参数上，草稿里可能没有
                draft.id = args.first().and_then(Value::as_str).map(str::to_string).or(draft.id);
            }
            let context = context.clone();
            crate::bridge::blocking(move || context.save_cluster(&draft)).await
        }

        "cluster:delete" => {
            let id = args.first().and_then(Value::as_str).unwrap_or_default().to_string();
            let context = context.clone();
            crate::bridge::blocking(move || context.delete_cluster(&id)).await
        }

        _ => return None,
    })
}

/// 先按 camelCase 转成 snake_case，再反序列化；失败时给出可读原因。
fn parse_draft(value: Option<&Value>) -> Result<pm_core::ClusterDraft, String> {
    let raw = value.cloned().unwrap_or_else(|| json!({}));
    let snake = snakeize(raw);
    pm_core::ClusterDraft::deserialize(&snake)
        .map_err(|error| format!("集群配置不合法：{error}"))
}
