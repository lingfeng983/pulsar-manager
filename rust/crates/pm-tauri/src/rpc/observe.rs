//! 观测类 RPC：指标聚合、拓扑、告警规则与事件、通知渠道与投递记录。
//!
//! 告警与通知都是「本地库 + 少量外发」的组合：规则/渠道存在 SQLite 里，写操作不碰 broker，
//! 只有「试跑规则」「发送测试」这两条真的会连出去。

use serde_json::{json, Value};

use crate::bridge::{blocking, fail, ok, Shared};

pub async fn dispatch(context: Shared, method: &str, args: Vec<Value>) -> Option<Value> {
    let payload = args.first().cloned().unwrap_or_else(|| json!({}));

    Some(match method {
        // ---------- 指标 ----------
        "metrics:getAggregatedStats" | "metrics:getBrokers" | "topology:getClusterTopology" => {
            let cluster = text(&args, 0);
            let client = match admin(&context, &cluster).await {
                Ok(client) => client,
                Err(payload) => return Some(payload),
            };
            match method {
                "metrics:getAggregatedStats" => settle(client.aggregated_stats().await),
                "metrics:getBrokers" => settle(client.brokers().await),
                _ => {
                    let limits = args
                        .get(1)
                        .cloned()
                        .and_then(|raw| serde_json::from_value(raw).ok());
                    settle(client.cluster_topology(limits.as_ref()).await)
                }
            }
        }
        "metrics:recordSnapshot" => {
            let draft = payload.clone();
            let context = context.clone();
            blocking(move || {
                // 开关是渲染层也读的，但真正决定落不落库的是这里：界面被绕过也拦得住
                let enabled = pm_store::settings::get(&context.store, "metricsSnapshotEnabled")?
                    .map(|value| value == "true")
                    .unwrap_or(false);
                if !enabled {
                    return Ok(Value::Null);
                }
                let point = pm_core::MetricsPoint {
                    cluster_id: string_of(&draft, "clusterId"),
                    topic_uri: string_of(&draft, "topicUri"),
                    msg_rate_in: number_of(&draft, "msgRateIn"),
                    msg_rate_out: number_of(&draft, "msgRateOut"),
                    throughput_in: number_of(&draft, "throughputIn"),
                    throughput_out: number_of(&draft, "throughputOut"),
                    backlog: number_of(&draft, "backlog") as i64,
                    producers: number_of(&draft, "producers") as i64,
                    consumers: number_of(&draft, "consumers") as i64,
                    captured_at: pm_core::now_ms(),
                };
                pm_store::metrics::insert(&context.store, &point)?;
                let days = pm_store::settings::get(&context.store, "metricsRetentionDays")?
                    .and_then(|value| value.parse::<i64>().ok())
                    .unwrap_or(7);
                pm_store::metrics::prune(&context.store, days)?;
                Ok(Value::Null)
            })
            .await
        }
        "metrics:listSnapshots" => {
            let draft = payload.clone();
            let context = context.clone();
            blocking(move || {
                let hours = number_of(&draft, "hours").max(1.0) as i64;
                let limit = number_of(&draft, "limit").max(1.0) as i64;
                pm_store::metrics::series(
                    &context.store,
                    &string_of(&draft, "clusterId"),
                    &string_of(&draft, "topicUri"),
                    pm_core::now_ms() - hours * 3_600_000,
                    limit,
                )
            })
            .await
        }

        // ---------- 告警（读取） ----------
        "alert:rules:list" => {
            let cluster = string_of(&payload, "clusterId");
            let context = context.clone();
            blocking(move || pm_store::alerts::list_rules(&context.store, &cluster)).await
        }
        "alert:rules:count" => {
            let context = context.clone();
            blocking(move || {
                // 顶部徽标只关心"当前有多少条待处理"，按 500 条上限读一次够用
                let events = pm_store::alerts::list_events(&context.store, None, 500)?;
                Ok(events.iter().filter(|event| event.state == "firing").count() as i64)
            })
            .await
        }
        "alert:events:list" => {
            let cluster = payload
                .get("clusterId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let limit = payload.get("limit").and_then(Value::as_i64).unwrap_or(200);
            let context = context.clone();
            blocking(move || pm_store::alerts::list_events(&context.store, cluster.as_deref(), limit))
                .await
        }

        // ---------- 告警（写入） ----------
        "alert:rule:upsert" => {
            let draft = payload.clone();
            let context = context.clone();
            let result = blocking(move || save_rule(&context.store, &draft)).await;
            // 阈值/口径/连续次数都可能在这一次被改掉，旧的命中计数在新判定下没有意义
            if let Some(id) = result
                .get("data")
                .and_then(|data| data.get("id"))
                .and_then(Value::as_str)
            {
                crate::scheduler::reset_hits(Some(id));
            }
            result
        }
        "alert:rule:delete" => {
            let id = string_of(&payload, "id");
            let context = context.clone();
            let removed = blocking({
                let id = id.clone();
                move || {
                    if pm_store::alerts::get_rule(&context.store, &id)?.is_none() {
                        // 已经没了不算失败：界面要的是「这条现在不在了」
                        return Ok(0);
                    }
                    pm_store::alerts::delete_rule(&context.store, &id)?;
                    Ok(1)
                }
            })
            .await;
            crate::scheduler::reset_hits(Some(&id));
            removed
        }
        "alert:rule:test" => {
            let id = string_of(&payload, "id");
            let rule = match pm_store::alerts::get_rule(&context.store, &id) {
                Ok(Some(rule)) => rule,
                Ok(None) => {
                    return Some(fail(pm_core::AppError::NotFound(
                        "规则不存在，可能已被删除".into(),
                    )))
                }
                Err(error) => return Some(fail(error)),
            };
            let client = match admin(&context, &rule.cluster_id).await {
                Ok(client) => client,
                Err(payload) => return Some(payload),
            };
            match pm_services::alerts::probe(&client, &rule).await {
                Ok(probe) => ok(json!({
                    "value": probe.value,
                    "breached": probe.breached,
                    "message": probe.message,
                    "value_text": probe.value_text,
                    "threshold_text": probe.threshold_text,
                    "metric_label": probe.metric_label,
                })),
                Err(error) => fail(error),
            }
        }
        "alert:events:ack" => {
            let ids = numbers(&payload, "ids");
            let context = context.clone();
            blocking(move || {
                for id in &ids {
                    pm_store::alerts::ack_event(&context.store, *id)?;
                }
                Ok(ids.len() as i64)
            })
            .await
        }
        "alert:events:delete" => {
            let ids = numbers(&payload, "ids");
            let context = context.clone();
            blocking(move || pm_store::alerts::delete_events(&context.store, &ids)).await
        }

        // ---------- 通知（读取） ----------
        "notify:channel:list" => {
            let context = context.clone();
            blocking(move || {
                pm_services::notify_center::list_channels_view(&context.store, &context.secrets)
            })
            .await
        }
        "notify:delivery:list" => {
            let limit = payload.get("limit").and_then(Value::as_i64).unwrap_or(100);
            let context = context.clone();
            blocking(move || pm_store::notify::deliveries(&context.store, limit)).await
        }
        "notify:mail:list" => {
            let context = context.clone();
            blocking(move || pm_services::notify_center::list_mail_view(&context.store)).await
        }

        // ---------- 通知（写入） ----------
        "notify:channel:save" => {
            let draft = payload.clone();
            let context = context.clone();
            blocking(move || {
                pm_services::notify_center::save_channel(&context.store, &context.secrets, &draft)
            })
            .await
        }
        "notify:channel:delete" => {
            let id = string_of(&payload, "id");
            let context = context.clone();
            blocking(move || {
                pm_services::notify_center::remove_channel(&context.store, &id)?;
                Ok(json!({"deleted": true}))
            })
            .await
        }
        "notify:channel:enable" => {
            let id = string_of(&payload, "id");
            let enabled = payload.get("enabled").and_then(Value::as_bool).unwrap_or(true);
            let context = context.clone();
            blocking(move || {
                let updated = pm_services::notify_center::set_enabled(&context.store, &id, enabled)?;
                Ok(json!({"updated": updated}))
            })
            .await
        }
        "notify:channel:test" => {
            let id = string_of(&payload, "id");
            settle(
                pm_services::notify_center::test_channel(&context.store, &context.secrets, &id).await,
            )
        }
        "notify:mail:save" => {
            let draft = payload.clone();
            let context = context.clone();
            blocking(move || {
                pm_services::notify_center::save_mail(&context.store, &context.secrets, &draft)
            })
            .await
        }
        "notify:mail:delete" => {
            let id = string_of(&payload, "id");
            let context = context.clone();
            blocking(move || {
                let (deleted, channels_using) =
                    pm_services::notify_center::remove_mail(&context.store, &id)?;
                Ok(json!({"deleted": deleted, "channels_using": channels_using}))
            })
            .await
        }
        "notify:mail:test" => {
            let id = string_of(&payload, "id");
            let to = payload
                .get("to")
                .and_then(Value::as_str)
                .map(str::to_string);
            match pm_services::notify_center::test_mail(
                &context.store,
                &context.secrets,
                &id,
                to.as_deref(),
            )
            .await
            {
                Ok((ok_flag, message)) => ok(json!({"ok": ok_flag, "message": message})),
                Err(error) => fail(error),
            }
        }

        _ => return None,
    })
}

/// 规则的新建与编辑共用一条路径：作用域决定哪些定位字段有意义，其余一律清空，
/// 否则「整个集群」的规则会带着上次选过的命名空间，缓存键与文案都会跟着错。
fn save_rule(store: &pm_store::Store, draft: &Value) -> pm_core::AppResult<Value> {
    let id = string_of(draft, "id");
    let existing = if id.is_empty() {
        None
    } else {
        pm_store::alerts::get_rule(store, &id)?
    };
    if !id.is_empty() && existing.is_none() {
        return Err(pm_core::AppError::Other("规则不存在，可能已被删除".into()));
    }

    let cluster_id = string_of(draft, "clusterId");
    if cluster_id.is_empty() {
        return Err(pm_core::AppError::Other("集群不存在，请先添加该集群".into()));
    }
    let name = string_of(draft, "name");
    if name.is_empty() {
        return Err(pm_core::AppError::Other("规则名字不能是空的".into()));
    }
    let scope = draft
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("cluster")
        .to_string();
    if !matches!(scope.as_str(), "cluster" | "namespace" | "topic") {
        return Err(pm_core::AppError::Other(format!("未知的告警作用域 {scope}")));
    }
    let (tenant, namespace, topic) = match scope.as_str() {
        "cluster" => (String::new(), String::new(), String::new()),
        "namespace" => (string_of(draft, "tenant"), string_of(draft, "namespace"), String::new()),
        _ => (
            string_of(draft, "tenant"),
            string_of(draft, "namespace"),
            string_of(draft, "topic"),
        ),
    };

    let metric = string_of(draft, "metric");
    if metric.is_empty() {
        return Err(pm_core::AppError::Other("告警指标不能为空".into()));
    }
    let comparator = draft
        .get("comparator")
        .and_then(Value::as_str)
        .unwrap_or("gt")
        .to_string();
    if !matches!(comparator.as_str(), "gt" | "gte" | "lt" | "lte") {
        return Err(pm_core::AppError::Other(format!("未知的比较方式 {comparator}")));
    }

    let rule = pm_core::AlertRule {
        id,
        cluster_id,
        name,
        enabled: draft.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        scope,
        tenant,
        namespace,
        topic,
        persistent: draft.get("persistent").and_then(Value::as_bool).unwrap_or(true),
        metric,
        comparator,
        threshold: number_of(draft, "threshold"),
        consecutive: number_of(draft, "consecutive").max(1.0) as i64,
        notify: draft.get("notify").and_then(Value::as_bool).unwrap_or(true),
        created_at: existing.as_ref().map(|item| item.created_at.clone()).unwrap_or_default(),
        updated_at: String::new(),
    };
    let saved_id = pm_store::alerts::save_rule(store, &rule)?;
    match pm_store::alerts::get_rule(store, &saved_id)? {
        Some(saved) => Ok(serde_json::to_value(saved)?),
        None => Ok(Value::Null),
    }
}

async fn admin(context: &Shared, cluster_id: &str) -> Result<pm_pulsar::AdminClient, Value> {
    let context = context.clone();
    let id = cluster_id.to_string();
    let result = tokio::task::spawn_blocking(move || context.admin_for(&id)).await;
    match result {
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

fn text(args: &[Value], index: usize) -> String {
    args.get(index)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn string_of(payload: &Value, key: &str) -> String {
    payload
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn number_of(payload: &Value, key: &str) -> f64 {
    payload.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn numbers(payload: &Value, key: &str) -> Vec<i64> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default()
}
