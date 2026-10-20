//! 工作台的本地存储类 RPC：报文模板、消费者会话配置、发送历史。
//!
//! 这些全是 SQLite 里的事，集群离线也能用；消息收发本身在 `session` 模块。

use std::collections::BTreeMap;

use pm_core::MessageTemplate;
use pm_store::consumer_configs::{self, ConsumerSessionConfig};
use serde_json::{json, Value};

use crate::bridge::{blocking, fail, ok, Shared};

pub async fn dispatch(context: Shared, method: &str, args: Vec<Value>) -> Option<Value> {
    Some(match method {
        // ---------- 报文模板 ----------
        "template:list" => {
            let params = args.first().cloned().unwrap_or_else(|| json!({}));
            let cluster = text(&params, "clusterId");
            let topic = params
                .get("topicUri")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let context = context.clone();
            blocking(move || pm_store::templates::list(&context.store, &cluster, topic.as_deref())).await
        }
        "template:create" | "template:update" => {
            let params = args.first().cloned().unwrap_or_else(|| json!({}));
            let context = context.clone();
            blocking(move || upsert_template(&context, &params)).await
        }
        "template:delete" => {
            let params = args.first().cloned().unwrap_or_else(|| json!({}));
            let id = text(&params, "id");
            let context = context.clone();
            blocking(move || {
                let existing = pm_store::templates::get(&context.store, &id)?;
                let Some(template) = existing else {
                    return Ok(json!({"deleted": false}));
                };
                pm_store::templates::delete(&context.store, &id)?;
                let _ = context.log(
                    Some(&template.cluster_id),
                    "delete",
                    "message_template",
                    Some(&id),
                    Some(&template.name),
                    "success",
                    None,
                );
                Ok(json!({"deleted": true}))
            })
            .await
        }
        "template:copy" => {
            let params = args.first().cloned().unwrap_or_else(|| json!({}));
            let context = context.clone();
            blocking(move || {
                let source = pm_store::templates::get(&context.store, &text(&params, "id"))?
                    .ok_or_else(|| pm_core::AppError::NotFound("模板".into()))?;
                let mut copy = source.clone();
                copy.id = String::new();
                copy.name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| value.trim().to_string())
                    .unwrap_or_else(|| format!("{} 副本", source.name));
                if let Some(topic) = params.get("topicUri").and_then(Value::as_str) {
                    copy.topic_uri = topic.to_string();
                }
                copy.created_at = String::new();
                copy.updated_at = String::new();
                let id = pm_store::templates::save(&context.store, &copy)?;
                let _ = context.log(
                    Some(&source.cluster_id),
                    "create",
                    "message_template",
                    Some(&id),
                    Some(&copy.name),
                    "success",
                    None,
                );
                pm_store::templates::get(&context.store, &id)?
                    .ok_or_else(|| pm_core::AppError::NotFound(format!("模板 {id}")))
            })
            .await
        }

        // ---------- 消费者会话配置 ----------
        "consumerConfig:list" => {
            let params = args.first().cloned().unwrap_or_else(|| json!({}));
            let cluster = text(&params, "clusterId");
            let topic = params
                .get("topicUri")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let context = context.clone();
            blocking(move || {
                let rows = consumer_configs::list(&context.store, &cluster, topic.as_deref())?;
                Ok::<_, pm_core::AppError>(rows.iter().map(flatten_config).collect::<Vec<_>>())
            })
            .await
        }
        "consumerConfig:create" | "consumerConfig:update" => {
            let params = args.first().cloned().unwrap_or_else(|| json!({}));
            let context = context.clone();
            blocking(move || upsert_consumer_config(&context, &params)).await
        }
        "consumerConfig:delete" => {
            let params = args.first().cloned().unwrap_or_else(|| json!({}));
            let id = text(&params, "id");
            let context = context.clone();
            blocking(move || {
                let existing = consumer_configs::get(&context.store, &id)?;
                let Some(config) = existing else {
                    return Ok(json!({"deleted": false}));
                };
                consumer_configs::delete(&context.store, &id)?;
                let _ = context.log(
                    Some(&config.cluster_id),
                    "delete",
                    "consumer_config",
                    Some(&id),
                    Some(&config.name),
                    "success",
                    None,
                );
                Ok(json!({"deleted": true}))
            })
            .await
        }
        "consumerConfig:copy" => {
            let params = args.first().cloned().unwrap_or_else(|| json!({}));
            let context = context.clone();
            blocking(move || {
                let id = consumer_configs::duplicate(
                    &context.store,
                    &text(&params, "id"),
                    params.get("name").and_then(Value::as_str),
                    params.get("topicUri").and_then(Value::as_str),
                    params.get("subscription").and_then(Value::as_str),
                )?;
                let config = consumer_configs::require(&context.store, &id)?;
                let _ = context.log(
                    Some(&config.cluster_id),
                    "create",
                    "consumer_config",
                    Some(&id),
                    Some(&config.name),
                    "success",
                    None,
                );
                Ok(flatten_config(&config))
            })
            .await
        }

        // ---------- 发送历史 ----------
        "sendHistory:list" => {
            let params = args.first().cloned().unwrap_or_else(|| json!({}));
            let cluster = text(&params, "clusterId");
            let topic = text(&params, "topicUri");
            let limit = params.get("limit").and_then(Value::as_i64).unwrap_or(200);
            let context = context.clone();
            blocking(move || pm_store::history::list_for_topic(&context.store, &cluster, &topic, limit)).await
        }
        "sendHistory:get" => {
            let params = args.first().cloned().unwrap_or_else(|| json!({}));
            let id = params.get("id").and_then(Value::as_i64).unwrap_or_default();
            let context = context.clone();
            blocking(move || pm_store::history::get(&context.store, id)).await
        }

        _ => return None,
    })
}

fn upsert_template(context: &Shared, params: &Value) -> pm_core::AppResult<MessageTemplate> {
    let id = text(params, "id");
    let existing = if id.is_empty() {
        None
    } else {
        pm_store::templates::get(&context.store, &id)?
    };
    if !id.is_empty() && existing.is_none() {
        return Err(pm_core::AppError::NotFound(format!("模板 {id}")));
    }

    let schema_mode = {
        let mode = text(params, "schemaMode");
        if mode.is_empty() {
            "none".to_string()
        } else {
            mode
        }
    };
    let template = MessageTemplate {
        id: id.clone(),
        cluster_id: text(params, "clusterId"),
        topic_uri: text(params, "topicUri"),
        name: text(params, "name"),
        body: text(params, "body"),
        variables: params
            .get("variables")
            .cloned()
            .map(|value| serde_json::from_value(value).unwrap_or_default())
            .unwrap_or_default(),
        properties: params
            .get("properties")
            .cloned()
            .map(|value| serde_json::from_value::<BTreeMap<String, String>>(value).unwrap_or_default())
            .unwrap_or_default(),
        producer_options: params
            .get("producerOptions")
            .cloned()
            .unwrap_or(Value::Null),
        // 非 inline 一律不存 schema：切回「不校验」后还留着旧内容，
        // 下次再选 inline 时会拿一份没人看过的 schema 去校验
        schema_json: if schema_mode == "inline" {
            params.get("schemaJson").and_then(Value::as_str).map(str::to_string)
        } else {
            None
        },
        schema_mode,
        created_at: String::new(),
        updated_at: String::new(),
    };
    if template.cluster_id.is_empty() {
        return Err(pm_core::AppError::config("缺少集群 id"));
    }
    if template.name.trim().is_empty() {
        return Err(pm_core::AppError::config("模板名称不能为空"));
    }

    let saved = pm_store::templates::save(&context.store, &template)?;
    let action = if existing.is_some() { "update" } else { "create" };
    let _ = context.log(
        Some(&template.cluster_id),
        action,
        "message_template",
        Some(&saved),
        Some(&template.name),
        "success",
        None,
    );
    pm_store::templates::get(&context.store, &saved)?
        .ok_or_else(|| pm_core::AppError::NotFound(format!("模板 {saved}")))
}

/// 草稿字段直接展开在行上：作用域与名称以列上的值为准，
/// config_json 里若残留旧值也不能把它盖掉。
fn flatten_config(row: &ConsumerSessionConfig) -> Value {
    let mut merged = match &row.config {
        Value::Object(map) => map.clone(),
        _ => serde_json::Map::new(),
    };
    merged.insert("id".into(), json!(row.id));
    merged.insert("clusterId".into(), json!(row.cluster_id));
    merged.insert("topicUri".into(), json!(row.topic_uri));
    merged.insert("subscription".into(), json!(row.subscription));
    merged.insert("name".into(), json!(row.name));
    merged.insert("createdAt".into(), json!(row.created_at));
    merged.insert("updatedAt".into(), json!(row.updated_at));
    Value::Object(merged)
}

fn upsert_consumer_config(context: &Shared, params: &Value) -> pm_core::AppResult<Value> {
    let id = text(params, "id");
    let existing = if id.is_empty() {
        None
    } else {
        consumer_configs::get(&context.store, &id)?
    };
    if !id.is_empty() && existing.is_none() {
        return Err(pm_core::AppError::NotFound(format!("消费配置 {id}")));
    }

    // 存进 config_json 的只有会话参数本身：作用域与名称是列，重复存一份就有两处真相
    let mut draft = serde_json::Map::new();
    for key in [
        "subscriptionType",
        "initialPosition",
        "autoAck",
        "maxMessages",
        "receiverQueueSize",
        "ackTimeoutMs",
        "nAckRedeliverTimeoutMs",
        "consumerName",
        "deadLetter",
    ] {
        if let Some(value) = params.get(key) {
            draft.insert(key.to_string(), value.clone());
        }
    }

    let config = ConsumerSessionConfig {
        id: id.clone(),
        cluster_id: text(params, "clusterId"),
        topic_uri: text(params, "topicUri"),
        subscription: text(params, "subscription"),
        name: text(params, "name"),
        config: Value::Object(draft),
        created_at: String::new(),
        updated_at: String::new(),
    };
    if config.cluster_id.is_empty() {
        return Err(pm_core::AppError::config("缺少集群 id"));
    }
    if config.name.trim().is_empty() {
        return Err(pm_core::AppError::config("配置名称不能为空"));
    }

    let saved = consumer_configs::save(&context.store, &config)?;
    let action = if existing.is_some() { "update" } else { "create" };
    let _ = context.log(
        Some(&config.cluster_id),
        action,
        "consumer_config",
        Some(&saved),
        Some(&config.name),
        "success",
        None,
    );
    Ok(flatten_config(&consumer_configs::require(&context.store, &saved)?))
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// 供会话模块写发送历史时复用：成功与失败都要落一行，界面才有东西可查。
#[allow(dead_code)]
#[allow(clippy::too_many_arguments)] // 参数就是这几列，拆成结构体只会多一层转发
pub fn record_send(
    context: &Shared,
    cluster_id: &str,
    topic_uri: &str,
    template_name: &str,
    body: &str,
    message_id: Option<&str>,
    error: Option<&str>,
    keep_full: bool,
) {
    let preview: String = body.chars().take(200).collect();
    let row = pm_core::SendHistory {
        id: 0,
        cluster_id: Some(cluster_id.to_string()),
        topic_uri: topic_uri.to_string(),
        template_id: None,
        template_name: template_name.to_string(),
        body_preview: preview,
        body_full: if keep_full { Some(body.to_string()) } else { None },
        body_bytes: body.len() as i64,
        message_count: 1,
        message_id: message_id.map(str::to_string),
        status: if error.is_some() { "failure" } else { "success" }.to_string(),
        error_message: error.map(str::to_string),
        created_at: pm_core::now_iso(),
    };
    if let Err(error) = pm_store::history::insert(&context.store, &row) {
        pm_core::pm_warn!("[history] 写入发送历史失败：{error}");
    }
}

/// 让编译器确认 `ok`/`fail` 在这个模块里仍然被使用（模板编辑返回的是结构体）。
#[allow(dead_code)]
fn _unused(value: pm_core::AppResult<Value>) -> Value {
    match value {
        Ok(value) => ok(value),
        Err(error) => fail(error),
    }
}
