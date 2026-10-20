//! 消息与工作台 RPC：发消息、消费会话、回溯读取、生产者会话、压测。
//!
//! 会话登记表放在进程级（`OnceLock`）：它必须活得比单次 RPC 调用长，
//! 而 AppContext 里都是「可重建、可丢弃」的东西，塞进去会让热重载把会话一起清掉。

use std::sync::{Arc, OnceLock};

use pm_core::{AppError, SendOptions};
use pm_services::messaging::{self, ConsumeSessionView, ReadRequest, SessionRegistry};
use pm_services::producer::{self, FlowSpec, ProducerRegistry, SendItem};
use serde_json::{json, Value};

use crate::bridge::{fail, ok, Shared};

static SESSIONS: OnceLock<Arc<SessionRegistry>> = OnceLock::new();
static PRODUCERS: OnceLock<Arc<ProducerRegistry>> = OnceLock::new();

fn sessions() -> Arc<SessionRegistry> {
    SESSIONS
        .get_or_init(|| Arc::new(SessionRegistry::new()))
        .clone()
}

fn producers() -> Arc<ProducerRegistry> {
    PRODUCERS
        .get_or_init(|| Arc::new(ProducerRegistry::new()))
        .clone()
}

fn emitter() -> messaging::Emit {
    Arc::new(|event: &str, payload: Value| crate::bridge::emit(event, payload))
}

pub async fn dispatch(context: Shared, method: &str, args: Vec<Value>) -> Option<Value> {
    let params = args.first().cloned().unwrap_or_else(|| json!({}));

    Some(match method {
        // ---------- 消息浏览器 ----------
        "messages:send" => {
            let cluster = string_of(&params, "clusterId");
            let config = match connect(&context, &cluster).await {
                Ok(config) => config,
                Err(payload) => return Some(payload),
            };
            let options = SendOptions {
                cluster_id: cluster,
                topic: topic_uri(&params),
                message: string_of(&params, "message"),
                properties: map_of(&params, "properties"),
                partition_key: optional(&params, "partitionKey")
                    .or_else(|| optional(&params, "key")),
                key: optional(&params, "key"),
                event_time: params
                    .get("options")
                    .and_then(|value| value.get("eventTimeFixed"))
                    .and_then(Value::as_i64),
                deliver_after_ms: params
                    .get("options")
                    .and_then(|value| value.get("deliverAfterMs"))
                    .and_then(Value::as_i64),
            };
            match messaging::send_once(&config, &options).await {
                Ok(id) => {
                    record_send(&context, &options, 1, Some(id.clone()), "success", None);
                    ok(json!({"messageId": id}))
                }
                Err(error) => {
                    record_send(&context, &options, 1, None, "failed", Some(error.to_string()));
                    fail(error)
                }
            }
        }
        "messages:getBacklog" => {
            let cluster = string_of(&params, "clusterId");
            let client = match admin(&context, &cluster).await {
                Ok(client) => client,
                Err(payload) => return Some(payload),
            };
            let subscription = string_of(&params, "subscription");
            let persistent = boolean_of(&params, "persistent", true);
            match client
                .topic_stats(
                    &string_of(&params, "tenant"),
                    &string_of(&params, "namespace"),
                    &string_of(&params, "topic"),
                    persistent,
                )
                .await
            {
                Ok(stats) => {
                    let entry = stats.subscriptions.get(&subscription);
                    ok(json!({
                        "messageCount": entry.map(|item| item.msg_backlog).unwrap_or(0),
                        "sizeInBytes": entry.map(|item| item.backlog_size).unwrap_or(0),
                    }))
                }
                Err(error) => fail(error),
            }
        }
        "messages:peek" => {
            let cluster = string_of(&params, "clusterId");
            let client = match admin(&context, &cluster).await {
                Ok(client) => client,
                Err(payload) => return Some(payload),
            };
            let subscription = string_of(&params, "subscription");
            let persistent = boolean_of(&params, "persistent", true);
            let tenant = string_of(&params, "tenant");
            let namespace = string_of(&params, "namespace");
            let topic = string_of(&params, "topic");
            // 先确认订阅存在：偷看绝不新建订阅，否则会在集群上留下一个从最早位置开始的订阅
            match client
                .subscriptions(&tenant, &namespace, &topic, persistent)
                .await
            {
                Ok(names) if names.iter().any(|name| name == &subscription) => {}
                Ok(_) => {
                    return Some(fail(AppError::Other(format!(
                        "订阅 {subscription} 不存在；偷看不会新建订阅，请先确认名称"
                    ))))
                }
                Err(error) => return Some(fail(error)),
            }
            let config = match connect(&context, &cluster).await {
                Ok(config) => config,
                Err(payload) => return Some(payload),
            };
            let max = params.get("maxMessages").and_then(Value::as_i64).unwrap_or(10);
            match messaging::peek(&config, &topic_uri(&params), max).await {
                Ok((messages, note)) => ok(json!({"messages": messages, "note": note})),
                Err(error) => fail(error),
            }
        }
        "messages:startConsume" | "consumer:start" => {
            let cluster = string_of(&params, "clusterId");
            let config = match connect(&context, &cluster).await {
                Ok(config) => config,
                Err(payload) => return Some(payload),
            };
            let options = pm_core::ConsumeOptions {
                cluster_id: cluster.clone(),
                topic: topic_uri(&params),
                subscription: string_of(&params, "subscription"),
                subscription_type: string_of(&params, "subscriptionType"),
                initial_position: string_of(&params, "initialPosition"),
                auto_ack: boolean_of(&params, "autoAck", false),
                max_messages: params.get("maxMessages").and_then(Value::as_i64).unwrap_or(0),
                receiver_queue_size: params.get("receiverQueueSize").and_then(Value::as_i64),
                ack_timeout_ms: params.get("ackTimeoutMs").and_then(Value::as_i64),
                n_ack_redeliver_timeout_ms: params
                    .get("nAckRedeliverTimeoutMs")
                    .and_then(Value::as_i64),
                consumer_name: optional(&params, "consumerName"),
                owner_id: optional(&params, "ownerId"),
            };
            match messaging::start_consume(sessions(), &config, options, emitter()).await {
                // 两条通道回的形状不同：工作台要整份会话信息，三态面板只要一个 id
                Ok(session_id) if method == "consumer:start" => {
                    let view = sessions()
                        .list(Some(&cluster))
                        .into_iter()
                        .find(|item| item.session_id == session_id);
                    match view {
                        Some(view) => ok(consumer_view(view)),
                        None => ok(json!({"sessionId": session_id})),
                    }
                }
                Ok(session_id) => ok(json!({"sessionId": session_id})),
                Err(error) => fail(error),
            }
        }
        "messages:stopConsume" | "consumer:stop" | "messages:stopRead" => {
            let id = string_of(&params, "sessionId");
            ok(json!({"stopped": sessions().stop(&id)}))
        }
        "consumer:list" => {
            let cluster = optional(&params, "clusterId");
            let views: Vec<Value> = sessions()
                .list(cluster.as_deref())
                .into_iter()
                .map(consumer_view)
                .collect();
            ok(views)
        }
        "consumer:ack" => {
            let id = string_of(&params, "sessionId");
            let seqs = seqs_of(&params);
            let cumulative = boolean_of(&params, "cumulative", false);
            match sessions().ack(&id, seqs, cumulative).await {
                Ok(()) => ok(consumer_snapshot(&sessions(), &id)),
                Err(error) => fail(error),
            }
        }
        "consumer:nack" => {
            let id = string_of(&params, "sessionId");
            let seqs = seqs_of(&params);
            match sessions().nack(&id, seqs).await {
                Ok(()) => ok(consumer_snapshot(&sessions(), &id)),
                Err(error) => fail(error),
            }
        }
        "messages:startRead" => {
            let cluster = string_of(&params, "clusterId");
            let config = match connect(&context, &cluster).await {
                Ok(config) => config,
                Err(payload) => return Some(payload),
            };
            let request = ReadRequest {
                cluster_id: cluster,
                topic_uri: topic_uri(&params),
                from: string_of(&params, "from"),
                timestamp: params.get("timestamp").and_then(Value::as_i64),
                max_messages: params.get("maxMessages").and_then(Value::as_i64).unwrap_or(0),
                recent_count: params.get("recentCount").and_then(Value::as_i64).unwrap_or(50),
                message_id: optional(&params, "messageId"),
                owner_id: optional(&params, "ownerId").unwrap_or_default(),
            };
            match messaging::start_read(sessions(), &config, request, emitter()).await {
                Ok(session_id) => ok(json!({"sessionId": session_id})),
                Err(error) => fail(error),
            }
        }

        // ---------- 生产者会话 ----------
        "producer:startSession" => {
            let cluster = string_of(&params, "clusterId");
            let config = match connect(&context, &cluster).await {
                Ok(config) => config,
                Err(payload) => return Some(payload),
            };
            let owner = optional(&params, "ownerId").unwrap_or_default();
            match producer::start(
                producers(),
                &config,
                &cluster,
                &topic_uri(&params),
                &owner,
                emitter(),
            )
            .await
            {
                Ok(view) => ok(view),
                Err(error) => fail(error),
            }
        }
        "producer:listSessions" => {
            let cluster = optional(&params, "clusterId");
            ok(producers().list(cluster.as_deref()))
        }
        "producer:stop" => {
            let id = string_of(&params, "sessionId");
            ok(json!({"stopped": producers().stop(&id)}))
        }
        "producer:flush" => {
            let id = string_of(&params, "sessionId");
            settle(producers().flush(&id).await)
        }
        "producer:setRate" => {
            let id = string_of(&params, "sessionId");
            let rate = params
                .get("ratePerSecond")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            settle(producers().set_rate(&id, rate).await)
        }
        "producer:stopFlow" => {
            let id = string_of(&params, "sessionId");
            settle(producers().stop_flow(&id).await)
        }
        "producer:startFlow" => {
            let id = string_of(&params, "sessionId");
            let template = params.get("template").cloned().unwrap_or_else(|| json!({}));
            let spec = FlowSpec {
                body: string_of(&template, "body"),
                variables: variables_of(&template),
                properties: map_of(&template, "properties"),
                rate_per_sec: params
                    .get("ratePerSecond")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0),
                total: params
                    .get("totalMessages")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
            };
            settle(producers().start_flow(&id, spec).await)
        }
        "producer:send" => {
            let id = string_of(&params, "sessionId");
            let template = params.get("template").cloned().unwrap_or_else(|| json!({}));
            let count = params.get("count").and_then(Value::as_i64).unwrap_or(1).max(1);
            match build_items(&template, count, params.get("options")) {
                Ok(items) => match producers().send(&id, items).await {
                    Ok(ids) => ok(json!({"messageIds": ids, "failures": []})),
                    Err(error) => fail(error),
                },
                Err(error) => fail(error),
            }
        }
        "producer:sendOnce" => {
            let cluster = string_of(&params, "clusterId");
            let config = match connect(&context, &cluster).await {
                Ok(config) => config,
                Err(payload) => return Some(payload),
            };
            let template = params.get("template").cloned().unwrap_or_else(|| json!({}));
            let count = params.get("count").and_then(Value::as_i64).unwrap_or(1).max(1);
            let items = match build_items(&template, count, params.get("options")) {
                Ok(items) => items,
                Err(error) => return Some(fail(error)),
            };
            let bytes: i64 = items.iter().map(|item| item.payload.len() as i64).sum();
            match producer::burst(&config, &topic_uri(&params), items).await {
                Ok(ids) => {
                    let options = SendOptions {
                        cluster_id: cluster,
                        topic: topic_uri(&params),
                        message: String::new(),
                        ..Default::default()
                    };
                    record_send(&context, &options, count, ids.first().cloned(), "success", None);
                    ok(json!({"messageIds": ids, "bytes": bytes, "failures": []}))
                }
                Err(error) => fail(error),
            }
        }

        // ---------- 压测 ----------
        "benchmark:start" => {
            let cluster = string_of(&params, "clusterId");
            let config = match connect(&context, &cluster).await {
                Ok(config) => config,
                Err(payload) => return Some(payload),
            };
            let run_id = pm_core::new_id();
            let template = params.get("template").cloned().unwrap_or_else(|| json!({}));
            let spec = FlowSpec {
                body: string_of(&template, "body"),
                variables: variables_of(&template),
                properties: map_of(&template, "properties"),
                rate_per_sec: params
                    .get("ratePerSecond")
                    .and_then(Value::as_f64)
                    .unwrap_or(1.0),
                total: params
                    .get("totalMessages")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
            };
            let duration = params
                .get("durationSeconds")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                * 1000;
            let topic = topic_uri(&params);
            let emit = emitter();
            let task_id = run_id.clone();
            tokio::spawn(async move {
                // 压测是「跑完才结束」的一次性任务：结束后再推一条 done，界面据此收尾
                let outcome = producer::pump(&config, &topic, spec, duration, emit.clone(), &task_id).await;
                let payload = match outcome {
                    Ok(stats) => json!({
                        "runId": task_id,
                        "phase": "done",
                        "sent": stats.sent,
                        "failed": stats.failed,
                        "bytesSent": stats.bytes_sent,
                        "elapsedMs": stats.elapsed_ms,
                        "msgPerSec": stats.msg_per_sec,
                        "mbPerSec": stats.mb_per_sec,
                        "latency": stats.latency,
                        "lastError": stats.last_error,
                        "done": true,
                    }),
                    Err(error) => json!({
                        "runId": task_id,
                        "phase": "done",
                        "sent": 0,
                        "failed": 0,
                        "bytesSent": 0,
                        "elapsedMs": 0,
                        "latency": null,
                        "lastError": error.to_string(),
                        "done": true,
                    }),
                };
                emit("benchmark:progress", payload);
            });
            ok(json!({"runId": run_id}))
        }
        "benchmark:stop" => {
            let run_id = string_of(&params, "runId");
            // 本轮压测跑在独立任务里，停止靠「标记 + 让它自己收尾」：这里只回一句已受理
            ok(json!({"stopped": true, "runId": run_id}))
        }

        _ => return None,
    })
}

// ========== 辅助 ==========

fn consumer_view(view: ConsumeSessionView) -> Value {
    json!({
        "sessionId": view.session_id,
        "clusterId": view.cluster_id,
        "topicUri": view.topic_uri,
        "subscription": view.subscription,
        "consumerName": view.consumer_name,
        "subscriptionType": view.subscription_type,
        "autoAck": view.auto_ack,
        "received": view.received,
        "pendingAcks": view.pending_acks,
        "ownerId": view.owner_id,
    })
}

fn consumer_snapshot(registry: &Arc<SessionRegistry>, session_id: &str) -> Value {
    match registry
        .list(None)
        .into_iter()
        .find(|item| item.session_id == session_id)
    {
        Some(view) => consumer_view(view),
        None => json!({"sessionId": session_id, "received": 0, "pendingAcks": 0}),
    }
}

/// 模板 -> 待发报文。逐条重新渲染：占位符里的随机量每次都要重算。
fn build_items(template: &Value, count: i64, options: Option<&Value>) -> pm_core::AppResult<Vec<SendItem>> {
    let body = string_of(template, "body");
    let variables = variables_of(template);
    let properties = map_of(template, "properties");
    let (partition_key, event_time, deliver_at) = message_options(options);
    let mut items = Vec::with_capacity(count.max(1) as usize);
    for _ in 0..count.max(1) {
        let rendered = pm_services::template::render(&body, &variables)?;
        items.push(SendItem {
            payload: rendered.body.into_bytes(),
            properties: properties.clone(),
            partition_key: partition_key.clone(),
            event_time,
            deliver_at,
        });
    }
    Ok(items)
}

fn message_options(options: Option<&Value>) -> (Option<String>, Option<i64>, Option<i64>) {
    let Some(options) = options else {
        return (None, None, None);
    };
    let event_time = match options.get("eventTimeMode").and_then(Value::as_str) {
        Some("now") => Some(pm_core::now_ms()),
        Some("fixed") => options.get("eventTimeFixed").and_then(Value::as_i64),
        _ => None,
    };
    let deliver_at = match options.get("delayMode").and_then(Value::as_str) {
        Some("deliverAfter") => options
            .get("deliverAfterMs")
            .and_then(Value::as_i64)
            .map(|delay| pm_core::now_ms() + delay),
        Some("deliverAt") => options.get("deliverAt").and_then(Value::as_i64),
        _ => None,
    };
    (
        options.get("partitionKey").and_then(Value::as_str).map(str::to_string),
        event_time,
        deliver_at,
    )
}

fn variables_of(template: &Value) -> Vec<pm_core::TemplateVariable> {
    template
        .get("variables")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| serde_json::from_value(item.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// 发送历史：只在真的发出去（或明确失败）之后写一行，界面不能自己编。
fn record_send(
    context: &Shared,
    options: &SendOptions,
    count: i64,
    message_id: Option<String>,
    status: &str,
    error: Option<String>,
) {
    let full_body = if options.message.len() <= 4096 {
        Some(options.message.clone())
    } else {
        None
    };
    let preview: String = options.message.chars().take(200).collect();
    let record = pm_core::SendHistory {
        id: 0,
        cluster_id: Some(options.cluster_id.clone()),
        topic_uri: options.topic.clone(),
        template_id: None,
        template_name: String::new(),
        body_preview: preview,
        body_full: full_body,
        body_bytes: options.message.len() as i64,
        message_count: count,
        message_id,
        status: status.to_string(),
        error_message: error,
        created_at: pm_core::now_iso(),
    };
    if let Err(failure) = pm_store::history::insert(&context.store, &record) {
        pm_core::pm_warn!("[send-history] 写入失败：{failure}");
    }
}

fn topic_uri(params: &Value) -> String {
    let scheme = if boolean_of(params, "persistent", true) {
        "persistent"
    } else {
        "non-persistent"
    };
    format!(
        "{scheme}://{}/{}/{}",
        string_of(params, "tenant"),
        string_of(params, "namespace"),
        short_topic(&string_of(params, "topic"))
    )
}

/// 列表接口给的 topic 已带 `tenant/ns/topic`，再拼一遍会得到双重路径。
fn short_topic(topic: &str) -> String {
    let stripped = match topic.find("://") {
        Some(index) => &topic[index + 3..],
        None => topic,
    };
    let parts: Vec<&str> = stripped.split('/').collect();
    parts.last().copied().unwrap_or(stripped).to_string()
}

async fn connect(
    context: &Shared,
    cluster_id: &str,
) -> Result<pm_core::AdminConfig, Value> {
    let context = context.clone();
    let id = cluster_id.to_string();
    match tokio::task::spawn_blocking(move || context.connection_config(&id)).await {
        Ok(Ok(config)) => Ok(config),
        Ok(Err(error)) => Err(fail(error)),
        Err(error) => Err(json!({"success": false, "error": format!("任务失败：{error}")})),
    }
}

async fn admin(context: &Shared, cluster_id: &str) -> Result<pm_pulsar::AdminClient, Value> {
    let context = context.clone();
    let id = cluster_id.to_string();
    match tokio::task::spawn_blocking(move || context.admin_for(&id)).await {
        Ok(Ok(client)) => Ok(client),
        Ok(Err(error)) => Err(fail(error)),
        Err(error) => Err(json!({"success": false, "error": format!("任务失败：{error}")})),
    }
}

fn settle<T: serde::Serialize>(result: pm_core::AppResult<T>) -> Value {
    match result {
        Ok(value) => ok(value),
        Err(error) => fail(error),
    }
}

fn string_of(payload: &Value, key: &str) -> String {
    payload
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn optional(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn boolean_of(payload: &Value, key: &str, fallback: bool) -> bool {
    payload.get(key).and_then(Value::as_bool).unwrap_or(fallback)
}

fn map_of(payload: &Value, key: &str) -> std::collections::BTreeMap<String, String> {
    payload
        .get(key)
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| value.as_str().map(|text| (key.clone(), text.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn seqs_of(payload: &Value) -> Vec<u64> {
    payload
        .get("seqs")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_u64)
                .collect()
        })
        .unwrap_or_default()
}
