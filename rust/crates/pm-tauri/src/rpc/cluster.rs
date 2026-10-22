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
                    match &probe {
                        Ok(result) => {
                            let status = if result.connected {
                                "connected"
                            } else {
                                "disconnected"
                            };
                            let _ = context.set_status(&id, status, result.version.as_deref());
                            if result.connected {
                                (id, None)
                            } else {
                                // 探活失败的具体原因（webServiceUrl 端口、TLS、Token……）
                                // 必须跟着结果回到界面：只写日志的话，用户点完「刷新」
                                // 只看得到一个笼统的失败提示，无从下手。
                                (
                                    id,
                                    Some(result.error.clone().unwrap_or_else(|| {
                                        "探活失败，未返回具体原因（详见「设置 → 日志」）".into()
                                    })),
                                )
                            }
                        }
                        // 连探活都没发起（可达性检查拦下、凭据/证书读不到等）。
                        Err(error) => {
                            let reason = error.to_string();
                            pm_core::pm_warn!("[cluster] 探活 {id} 未能发起：{reason}");
                            (id, Some(reason))
                        }
                    }
                });
            }

            let mut probes: Vec<(String, Option<String>)> = Vec::new();
            while let Some(joined) = tasks.join_next().await {
                match joined {
                    Ok(result) => probes.push(result),
                    // 任务 panic 的集群这一轮没有结论，如实记一笔，别静默当成探活通过。
                    Err(error) => pm_core::pm_warn!("[cluster] 探活任务异常退出：{error}"),
                }
            }
            let status_errors = collect_status_errors(probes);

            let context = context.clone();
            let mut body = crate::bridge::blocking(move || context.list_clusters()).await;
            if body.get("success").and_then(Value::as_bool) == Some(true) {
                if let Some(object) = body.as_object_mut() {
                    // 原因与 data 平级下发：它是「本轮探活的结论」，不该被写回集群配置，
                    // 也不该顶掉已有的 status/version。
                    object.insert("statusErrors".into(), json!(status_errors));
                }
            }
            body
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

/// 把一轮探活结果压成 id → 失败原因：只有真正失败的集群才进表，
/// 探活通过的集群不占位（前端据此判断「全绿」还是「有失败」）。
fn collect_status_errors(
    probes: Vec<(String, Option<String>)>,
) -> std::collections::BTreeMap<String, String> {
    probes
        .into_iter()
        .filter_map(|(id, reason)| reason.map(|reason| (id, reason)))
        .collect()
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
    fn status_errors_keep_failures_and_drop_successes() {
        let errors = collect_status_errors(vec![
            ("a".into(), None),
            (
                "b".into(),
                Some("无法连接 http://192.168.222.121:8080：connection refused".into()),
            ),
            ("c".into(), Some("集群尚未配置 Admin API 地址".into())),
        ]);
        assert_eq!(errors.len(), 2);
        assert!(
            !errors.contains_key("a"),
            "探活通过的集群不该出现在错误表里"
        );
        assert_eq!(
            errors.get("b").map(String::as_str).unwrap_or_default(),
            "无法连接 http://192.168.222.121:8080：connection refused"
        );
        assert!(errors
            .get("c")
            .is_some_and(|reason| reason.contains("Admin API")));
    }

    #[test]
    fn draft_tolerates_missing_optional_fields() {
        let raw = json!({ "name": "local", "serviceUrl": "pulsar://localhost:6650" });
        let draft = parse_draft(Some(&raw)).expect("只有必填项时也要能解析");
        assert_eq!(draft.service_url, "pulsar://localhost:6650");
        assert!(!draft.tls_enabled);
    }
}
