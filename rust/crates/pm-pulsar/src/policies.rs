//! 策略端点：命名空间级、topic 级，以及两者的批量同步。
//!
//! 口径严格对齐原 Electron 版的 namespace-policy-api.ts 与 topic-policy-api.ts
//! （那两份已随 Electron 一起删除，需要逐行对照时在 git 历史里查）：
//! - 命名空间：读一份 Policies 大对象 + 五个限速专用端点，按字段表逐个写；
//! - topic：broker 不返回整份对象，一个字段一条端点，N 条 GET 拼一份视图；
//! - 写请求的动词与形状由字段表决定，用错动词只会得到不带提示的 405。

use std::collections::{BTreeMap, BTreeSet};

use futures::stream::{self, StreamExt};
use pm_core::{
    seg, AppError, AppResult, NamespaceBacklogQuota, NamespacePolicyView, NamespaceRateLimit,
    PolicyUnavailable, TopicPolicyView,
};
use serde_json::{json, Map, Value};

use crate::client::AdminClient;
use crate::resource::{short_topic_name, topic_base};

pub const QUOTA_TYPES: [&str; 2] = ["destination_storage", "message_age"];
pub const RETENTION_POLICIES: [&str; 3] = [
    "producer_request_hold",
    "producer_exception",
    "consumer_backlog_eviction",
];

/// 一次同步的字段并发数与目标数上限，与 TS 版同口径。
pub const SYNC_FANOUT: usize = 6;
pub const SYNC_MAX_TARGETS: usize = 20;

const UNLIMITED_INT: i64 = 2_147_483_647;

const SCHEMA_COMPATIBILITY_STRATEGIES: [&str; 9] = [
    "UNDEFINED",
    "ALWAYS_COMPATIBLE",
    "ALWAYS_INCOMPATIBLE",
    "BACKWARD",
    "BACKWARD_TRANSITIVE",
    "FORWARD",
    "FORWARD_TRANSITIVE",
    "FULL",
    "FULL_TRANSITIVE",
];

const SCHEMA_AUTO_UPDATE_STRATEGIES: [&str; 7] = [
    "AutoUpdateDisabled",
    "Backward",
    "Forward",
    "Full",
    "AlwaysCompatible",
    "BackwardTransitive",
    "ForwardTransitive",
];

// ========== 字段表 ==========

#[derive(Clone, Copy, PartialEq, Eq)]
enum Verb {
    Post,
    Put,
}

struct FieldSpec {
    field: &'static str,
    /// 相对命名空间路径的端点后缀
    path: &'static str,
    verb: Verb,
    /// broker 侧有没有 DELETE 端点
    clearable: bool,
}

/// 顺序即界面顺序，也是同步计划的产出顺序。
const NAMESPACE_FIELDS: [FieldSpec; 24] = [
    FieldSpec {
        field: "messageTtlSeconds",
        path: "messageTTL",
        verb: Verb::Post,
        clearable: true,
    },
    FieldSpec {
        field: "subscriptionExpirationTimeMinutes",
        path: "subscriptionExpirationTime",
        verb: Verb::Post,
        clearable: true,
    },
    FieldSpec {
        field: "retention",
        path: "retention",
        verb: Verb::Post,
        clearable: true,
    },
    FieldSpec {
        field: "deduplicationEnabled",
        path: "deduplication",
        verb: Verb::Post,
        clearable: true,
    },
    FieldSpec {
        field: "deduplicationSnapshotIntervalSeconds",
        path: "deduplicationSnapshotInterval",
        verb: Verb::Post,
        clearable: false,
    },
    FieldSpec {
        field: "backlogQuota",
        path: "backlogQuota",
        verb: Verb::Post,
        clearable: true,
    },
    FieldSpec {
        field: "maxProducersPerTopic",
        path: "maxProducersPerTopic",
        verb: Verb::Post,
        clearable: true,
    },
    FieldSpec {
        field: "maxConsumersPerTopic",
        path: "maxConsumersPerTopic",
        verb: Verb::Post,
        clearable: true,
    },
    FieldSpec {
        field: "maxConsumersPerSubscription",
        path: "maxConsumersPerSubscription",
        verb: Verb::Post,
        clearable: true,
    },
    FieldSpec {
        field: "maxUnackedMessagesPerConsumer",
        path: "maxUnackedMessagesPerConsumer",
        verb: Verb::Post,
        clearable: true,
    },
    FieldSpec {
        field: "maxUnackedMessagesPerSubscription",
        path: "maxUnackedMessagesPerSubscription",
        verb: Verb::Post,
        clearable: true,
    },
    FieldSpec {
        field: "maxSubscriptionsPerTopic",
        path: "maxSubscriptionsPerTopic",
        verb: Verb::Post,
        clearable: true,
    },
    FieldSpec {
        field: "maxTopicsPerNamespace",
        path: "maxTopicsPerNamespace",
        verb: Verb::Post,
        clearable: true,
    },
    FieldSpec {
        field: "compactionThreshold",
        path: "compactionThreshold",
        verb: Verb::Put,
        clearable: true,
    },
    FieldSpec {
        field: "schemaValidationEnforced",
        path: "schemaValidationEnforced",
        verb: Verb::Post,
        clearable: false,
    },
    FieldSpec {
        field: "schemaCompatibilityStrategy",
        path: "schemaCompatibilityStrategy",
        verb: Verb::Put,
        clearable: false,
    },
    FieldSpec {
        field: "schemaAutoUpdateStrategy",
        path: "schemaAutoUpdateCompatibilityStrategy",
        verb: Verb::Put,
        clearable: false,
    },
    FieldSpec {
        field: "allowAutoUpdateSchema",
        path: "isAllowAutoUpdateSchema",
        verb: Verb::Post,
        clearable: false,
    },
    FieldSpec {
        field: "encryptionRequired",
        path: "encryptionRequired",
        verb: Verb::Post,
        clearable: false,
    },
    FieldSpec {
        field: "dispatchRate",
        path: "dispatchRate",
        verb: Verb::Post,
        clearable: true,
    },
    FieldSpec {
        field: "subscriptionDispatchRate",
        path: "subscriptionDispatchRate",
        verb: Verb::Post,
        clearable: true,
    },
    FieldSpec {
        field: "replicatorDispatchRate",
        path: "replicatorDispatchRate",
        verb: Verb::Post,
        clearable: true,
    },
    FieldSpec {
        field: "subscribeRate",
        path: "subscribeRate",
        verb: Verb::Post,
        clearable: true,
    },
    FieldSpec {
        field: "publishRate",
        path: "publishRate",
        verb: Verb::Post,
        clearable: true,
    },
];

// replicationClusters 排在最后：端点收裸数组，形状与其它字段都不同。
const NAMESPACE_EXTRA_FIELDS: [FieldSpec; 1] = [FieldSpec {
    field: "replicationClusters",
    path: "replication",
    verb: Verb::Post,
    clearable: false,
}];

fn namespace_spec(field: &str) -> Option<&'static FieldSpec> {
    NAMESPACE_FIELDS
        .iter()
        .chain(NAMESPACE_EXTRA_FIELDS.iter())
        .find(|spec| spec.field == field)
}

pub fn clearable_namespace_fields() -> Vec<String> {
    NAMESPACE_FIELDS
        .iter()
        .chain(NAMESPACE_EXTRA_FIELDS.iter())
        .filter(|spec| spec.clearable)
        .map(|spec| spec.field.to_string())
        .collect()
}

struct TopicFieldSpec {
    field: &'static str,
    path: &'static str,
    label: &'static str,
    /// query = 值进查询参数、请求体留空；body = 值原样进请求体
    query_key: Option<&'static str>,
}

const TOPIC_FIELDS: [TopicFieldSpec; 5] = [
    TopicFieldSpec {
        field: "retention",
        path: "retention",
        label: "保留策略",
        query_key: None,
    },
    TopicFieldSpec {
        field: "messageTtlSeconds",
        path: "messageTTL",
        label: "消息 TTL",
        query_key: Some("messageTTL"),
    },
    TopicFieldSpec {
        field: "deduplicationEnabled",
        path: "deduplicationEnabled",
        label: "服务端去重",
        query_key: None,
    },
    TopicFieldSpec {
        field: "maxUnackedMessagesPerConsumer",
        path: "maxUnackedMessagesOnConsumer",
        label: "每消费者未确认上限",
        query_key: None,
    },
    TopicFieldSpec {
        field: "maxUnackedMessagesPerSubscription",
        path: "maxUnackedMessagesOnSubscription",
        label: "每订阅未确认上限",
        query_key: None,
    },
];

fn topic_spec(field: &str) -> Option<&'static TopicFieldSpec> {
    TOPIC_FIELDS.iter().find(|spec| spec.field == field)
}

pub fn topic_policy_field_names() -> Vec<String> {
    TOPIC_FIELDS
        .iter()
        .map(|spec| spec.field.to_string())
        .collect()
}

// ========== 取值与校验 ==========

fn pick<'a>(source: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    for key in keys {
        if let Some(value) = source.get(*key) {
            if !value.is_null() {
                return Some(value);
            }
        }
    }
    None
}

fn as_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn as_int(value: Option<&Value>) -> Option<i64> {
    value.and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_f64().filter(|v| v.is_finite()).map(|v| v as i64))
    })
}

fn as_bool(value: Option<&Value>) -> Option<bool> {
    value.and_then(Value::as_bool)
}

fn as_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn as_strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| match item {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                })
                .filter(|item| !item.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn require_int(label: &str, value: &Value, min: i64, max: i64) -> AppResult<i64> {
    let number = value
        .as_i64()
        .or_else(|| {
            value
                .as_f64()
                .filter(|v| v.fract() == 0.0)
                .map(|v| v as i64)
        })
        .ok_or_else(|| AppError::config(format!("{label}需要一个整数，收到 {value}")))?;
    if number < min || number > max {
        return Err(AppError::config(format!(
            "{label}需要在 {min}..{max} 之间，收到 {number}"
        )));
    }
    Ok(number)
}

fn require_bool(label: &str, value: &Value) -> AppResult<bool> {
    value
        .as_bool()
        .ok_or_else(|| AppError::config(format!("{label}需要 true 或 false，收到 {value}")))
}

fn require_enum(label: &str, value: &Value, allowed: &[&str]) -> AppResult<String> {
    let text = value
        .as_str()
        .map(str::trim)
        .filter(|text| allowed.contains(text))
        .ok_or_else(|| {
            AppError::config(format!(
                "{label}必须是 {} 之一，收到 {value}",
                allowed.join(" / ")
            ))
        })?;
    Ok(text.to_string())
}

fn number_value(raw: &Value) -> Value {
    match raw {
        Value::Number(_) => raw.clone(),
        Value::String(text) => text
            .parse::<f64>()
            .map(|value| json!(value))
            .unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

// ========== 读取：命名空间 ==========

fn fold_rate(data: Option<&Value>) -> Option<NamespaceRateLimit> {
    let source = data?.as_object()?;
    let text = |keys: &[&str]| -> Option<f64> {
        for key in keys {
            if let Some(value) = source.get(*key) {
                if let Some(number) = value.as_f64() {
                    return Some(number);
                }
            }
        }
        None
    };
    Some(NamespaceRateLimit {
        msg_per_period: text(&[
            "dispatchThrottlingRateInMsg",
            "publishThrottlingRateInMsg",
            "subscribeThrottlingRatePerConsumer",
        ])
        .unwrap_or(-1.0),
        byte_per_period: text(&[
            "dispatchThrottlingRateInByte",
            "publishThrottlingRateInByte",
        ])
        .unwrap_or(-1.0),
        period_in_seconds: text(&["ratePeriodInSecond"]),
        raw: Value::Object(source.clone()),
    })
}

fn fold_backlog_quotas(source: &Value) -> Vec<NamespaceBacklogQuota> {
    let map =
        match pick(source, &["backlog_quota_map", "backlogQuotaMap"]).and_then(Value::as_object) {
            Some(map) => map,
            None => return Vec::new(),
        };
    let mut quotas: Vec<NamespaceBacklogQuota> = map
        .iter()
        .filter_map(|(key, raw)| {
            let quota = raw.as_object()?;
            Some(NamespaceBacklogQuota {
                quota_type: key.clone(),
                limit_size_bytes: as_int(pick(raw, &["limitSize", "limit"]))
                    .or_else(|| as_number(pick(raw, &["limitSize", "limit"])).map(|v| v as i64))
                    .unwrap_or(0),
                limit_time_seconds: as_int(pick(raw, &["limitTime"]))
                    .or_else(|| as_number(pick(raw, &["limitTime"])).map(|v| v as i64))
                    .unwrap_or(0),
                policy: as_text(quota.get("policy"))
                    .unwrap_or_else(|| "producer_request_hold".to_string()),
            })
        })
        .collect();
    // 已知类型在前，未知类型按字符串排序垫后，保证界面顺序稳定
    quotas.sort_by_key(|quota| {
        (
            QUOTA_TYPES
                .iter()
                .position(|known| *known == quota.quota_type)
                .unwrap_or(usize::MAX),
            quota.quota_type.clone(),
        )
    });
    quotas
}

/// 把整份 Policies 折成视图。键名在 broker 上是混的（下划线与驼峰同体），
/// 所以每个字段都两种写法都试。
pub fn fold_namespace_policies(raw: &Value) -> NamespacePolicyView {
    let retention = pick(raw, &["retention_policies", "retentionPolicies"])
        .cloned()
        .unwrap_or(Value::Null);

    NamespacePolicyView {
        message_ttl_seconds: as_int(pick(
            raw,
            &["messageTtlInSeconds", "message_ttl_in_seconds"],
        )),
        subscription_expiration_time_minutes: as_int(pick(
            raw,
            &[
                "subscriptionExpirationTimeMinutes",
                "subscription_expiration_time_minutes",
            ],
        )),
        retention_time_in_minutes: as_int(pick(&retention, &["retentionTimeInMinutes"])),
        retention_size_in_mb: as_int(pick(&retention, &["retentionSizeInMB"])),
        deduplication_enabled: as_bool(pick(
            raw,
            &["deduplicationEnabled", "deduplication_enabled"],
        )),
        deduplication_snapshot_interval_seconds: as_int(pick(
            raw,
            &["deduplicationSnapshotIntervalSeconds"],
        )),
        backlog_quotas: fold_backlog_quotas(raw),
        max_producers_per_topic: as_int(pick(
            raw,
            &["maxProducersPerTopic", "max_producers_per_topic"],
        )),
        max_consumers_per_topic: as_int(pick(
            raw,
            &["maxConsumersPerTopic", "max_consumers_per_topic"],
        )),
        max_consumers_per_subscription: as_int(pick(
            raw,
            &[
                "maxConsumersPerSubscription",
                "max_consumers_per_subscription",
            ],
        )),
        max_unacked_messages_per_consumer: as_int(pick(
            raw,
            &[
                "maxUnackedMessagesPerConsumer",
                "max_unacked_messages_per_consumer",
            ],
        )),
        max_unacked_messages_per_subscription: as_int(pick(
            raw,
            &[
                "maxUnackedMessagesPerSubscription",
                "max_unacked_messages_per_subscription",
            ],
        )),
        max_subscriptions_per_topic: as_int(pick(
            raw,
            &["maxSubscriptionsPerTopic", "max_subscriptions_per_topic"],
        )),
        max_topics_per_namespace: as_int(pick(
            raw,
            &["maxTopicsPerNamespace", "max_topics_per_namespace"],
        )),
        compaction_threshold: as_int(pick(raw, &["compactionThreshold", "compaction_threshold"])),
        schema_validation_enforced: as_bool(pick(
            raw,
            &["schemaValidationEnforced", "schema_validation_enforced"],
        )),
        schema_compatibility_strategy: as_text(pick(
            raw,
            &[
                "schemaCompatibilityStrategy",
                "schema_compatibility_strategy",
            ],
        )),
        schema_auto_update_strategy: as_text(pick(
            raw,
            &[
                "schemaAutoUpdateCompatibilityStrategy",
                "schema_auto_update_compatibility_strategy",
            ],
        )),
        allow_auto_update_schema: as_bool(pick(
            raw,
            &["isAllowAutoUpdateSchema", "is_allow_auto_update_schema"],
        )),
        encryption_required: as_bool(pick(raw, &["encryptionRequired", "encryption_required"])),
        subscription_types_enabled: as_strings(pick(
            raw,
            &["subscriptionTypesEnabled", "subscription_types_enabled"],
        )),
        subscription_auth_mode: as_text(pick(
            raw,
            &["subscriptionAuthMode", "subscription_auth_mode"],
        )),
        replication_clusters: as_strings(pick(
            raw,
            &["replicationClusters", "replication_clusters"],
        )),
        allowed_clusters: as_strings(pick(raw, &["allowedClusters", "allowed_clusters"])),
        resource_group_name: as_text(pick(raw, &["resourceGroupName", "resource_group_name"])),
        dispatch_rate: None,
        subscription_dispatch_rate: None,
        subscribe_rate: None,
        publish_rate: None,
        replicator_dispatch_rate: None,
        clearable_fields: clearable_namespace_fields(),
        // 两个分支原本一样：retention_policies 早就并进 raw 一起返回了
        raw: raw.clone(),
    }
}

impl AdminClient {
    fn namespace_base(tenant: &str, namespace: &str) -> String {
        format!("/admin/v2/namespaces/{}/{}", seg(tenant), seg(namespace))
    }

    /// 读命名空间策略：主对象一次 GET，五个限速再各发一条专用端点。
    /// 限速端点在老 broker 上可能不存在，读不到就显示「未设置」，
    /// 不能让一个 404 把整页策略变成加载失败。
    pub async fn namespace_policy_view(
        &self,
        tenant: &str,
        namespace: &str,
    ) -> AppResult<NamespacePolicyView> {
        let base = Self::namespace_base(tenant, namespace);
        let raw = self.get_json::<Value>(&base).await?;
        let mut view = fold_namespace_policies(&raw);

        let dispatch = format!("{base}/dispatchRate");
        let subscription_dispatch = format!("{base}/subscriptionDispatchRate");
        let subscribe = format!("{base}/subscribeRate");
        let publish = format!("{base}/publishRate");
        let replicator = format!("{base}/replicatorDispatchRate");
        let rates = futures::join!(
            self.get_opt_json::<Value>(&dispatch),
            self.get_opt_json::<Value>(&subscription_dispatch),
            self.get_opt_json::<Value>(&subscribe),
            self.get_opt_json::<Value>(&publish),
            self.get_opt_json::<Value>(&replicator),
        );
        view.dispatch_rate = fold_rate(rates.0.ok().flatten().as_ref());
        view.subscription_dispatch_rate = fold_rate(rates.1.ok().flatten().as_ref());
        view.subscribe_rate = fold_rate(rates.2.ok().flatten().as_ref());
        view.publish_rate = fold_rate(rates.3.ok().flatten().as_ref());
        view.replicator_dispatch_rate = fold_rate(rates.4.ok().flatten().as_ref());
        Ok(view)
    }

    async fn policy_request(
        &self,
        base: &str,
        path: &str,
        verb: Verb,
        body: Value,
        query: &[(String, String)],
    ) -> AppResult<()> {
        let url = format!("{base}/{path}");
        match verb {
            Verb::Put => {
                if query.is_empty() {
                    self.put_json(&url, body).await
                } else {
                    self.execute_put(&url, body, query).await
                }
            }
            Verb::Post => self.post_with_query(&url, Some(body), query).await,
        }
    }

    pub async fn set_namespace_policy(
        &self,
        tenant: &str,
        namespace: &str,
        field: &str,
        value: Value,
    ) -> AppResult<()> {
        let spec = namespace_spec(field)
            .ok_or_else(|| AppError::config(format!("不支持修改的命名空间字段：{field}")))?;
        let (body, query) = encode_namespace_value(field, &value)?;
        self.policy_request(
            &Self::namespace_base(tenant, namespace),
            spec.path,
            spec.verb,
            body,
            &query,
        )
        .await
    }

    pub async fn clear_namespace_policy(
        &self,
        tenant: &str,
        namespace: &str,
        field: &str,
        quota_type: Option<&str>,
    ) -> AppResult<()> {
        let spec = namespace_spec(field)
            .ok_or_else(|| AppError::config(format!("不支持修改的命名空间字段：{field}")))?;
        if !spec.clearable {
            return Err(AppError::config(format!(
                "{field} 在 broker 侧没有删除端点，只能改成别的值，无法清除回默认"
            )));
        }
        let mut query = Vec::new();
        if field == "backlogQuota" {
            let value = quota_type.unwrap_or_default();
            let text = require_enum("配额类型", &json!(value), &QUOTA_TYPES)?;
            query.push(("backlogQuotaType".to_string(), text));
        }
        let url = format!(
            "{}/{path}",
            Self::namespace_base(tenant, namespace),
            path = spec.path
        );
        self.delete_with_query(&url, &query).await
    }

    // ========== 读取：topic ==========

    fn topic_base(tenant: &str, namespace: &str, topic: &str, persistent: bool) -> String {
        topic_base(tenant, namespace, short_topic_name(topic), persistent)
    }

    /// 逐端点拼出 topic 级策略视图。
    ///
    /// 先探一次 topic 本体：topic 不存在与「这台 broker 没有这个 topic 级端点」都是 404，
    /// 少了这一步，五个端点会各报一句「没有 topic 级端点」，而真因可能是 topic 名字打错了。
    pub async fn topic_policy_view(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        persistent: bool,
    ) -> AppResult<TopicPolicyView> {
        let base = Self::topic_base(tenant, namespace, topic, persistent);
        let probe = self
            .get_opt_json::<Value>(&format!("{base}/permissions"))
            .await?;
        if probe.is_none() {
            return Err(AppError::Other(format!(
                "读不到 topic {tenant}/{namespace}/{}：topic 或所属命名空间不存在",
                short_topic_name(topic)
            )));
        }

        let mut view = TopicPolicyView {
            topic_name: format!("{tenant}/{namespace}/{}", short_topic_name(topic)),
            persistent,
            clearable_fields: topic_policy_field_names(),
            raw: Value::Object(Map::new()),
            ..Default::default()
        };
        let mut raw = Map::new();

        for spec in TOPIC_FIELDS.iter() {
            match self
                .get_opt_json::<Value>(&format!("{base}/{}", spec.path))
                .await
            {
                Ok(value) => {
                    let value = value.unwrap_or(Value::Null);
                    raw.insert(spec.field.to_string(), value.clone());
                    fold_topic_field(&mut view, spec.field, &value);
                }
                Err(error) => match describe_topic_read_failure(&error) {
                    Some(reason) => view.unavailable.push(PolicyUnavailable {
                        field: spec.field.to_string(),
                        reason,
                    }),
                    None => return Err(error),
                },
            }
        }
        view.raw = Value::Object(raw);
        Ok(view)
    }

    pub async fn set_topic_policy(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        field: &str,
        value: Value,
        persistent: bool,
    ) -> AppResult<()> {
        let spec = topic_spec(field)
            .ok_or_else(|| AppError::config(format!("不支持在 topic 级设置的字段：{field}")))?;
        let base = Self::topic_base(tenant, namespace, topic, persistent);
        let url = format!("{base}/{}", spec.path);
        let encoded = encode_topic_value(spec, &value)?;
        match spec.query_key {
            Some(key) => {
                // 值全在查询参数里；POST 没有实体会被 REST 层当成缺参数，
                // 所以照 broker 客户端自己的做法发一个空字符串实体。
                let query = vec![(key.to_string(), encoded_text(&encoded))];
                self.post_with_query(&url, Some(Value::String(String::new())), &query)
                    .await
            }
            None => self.post_with_query(&url, Some(encoded), &[]).await,
        }
    }

    pub async fn clear_topic_policy(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        field: &str,
        persistent: bool,
    ) -> AppResult<()> {
        let spec = topic_spec(field)
            .ok_or_else(|| AppError::config(format!("不支持在 topic 级设置的字段：{field}")))?;
        let base = Self::topic_base(tenant, namespace, topic, persistent);
        self.delete(&format!("{base}/{}", spec.path)).await
    }
}

fn encoded_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}

fn describe_topic_read_failure(error: &AppError) -> Option<String> {
    match error {
        AppError::Http { status: 405 | 501, .. } => Some(
            "该 broker 未开启 topic 级策略（broker.conf 的 topicLevelPoliciesEnabled=true 才能设置）".to_string(),
        ),
        AppError::NotFound(_) => Some("该 broker 上没有这个 topic 级端点（Pulsar 版本过旧）".to_string()),
        AppError::Http { status: 404, .. } => Some("该 broker 上没有这个 topic 级端点（Pulsar 版本过旧）".to_string()),
        AppError::Http { message, .. } if message.to_lowercase().contains("topic level policy is disabled") => {
            Some("该 broker 未开启 topic 级策略（broker.conf 的 topicLevelPoliciesEnabled=true 才能设置）".to_string())
        }
        _ => None,
    }
}

fn fold_topic_field(view: &mut TopicPolicyView, field: &str, data: &Value) {
    match field {
        "retention" => {
            // 未显式设置过 topic 级保留时 broker 回空 body，按「未设置」处理
            let object = match data.as_object() {
                Some(object) => object,
                None => return,
            };
            view.retention_time_in_minutes = as_int(object.get("retentionTimeInMinutes"));
            view.retention_size_in_mb = as_int(object.get("retentionSizeInMB"));
        }
        "messageTtlSeconds" => {
            let value = number_value(data);
            view.message_ttl_seconds = as_int(Some(&value));
        }
        "deduplicationEnabled" => view.deduplication_enabled = data.as_bool(),
        "maxUnackedMessagesPerConsumer" => {
            let value = number_value(data);
            view.max_unacked_messages_per_consumer = as_int(Some(&value));
        }
        "maxUnackedMessagesPerSubscription" => {
            let value = number_value(data);
            view.max_unacked_messages_per_subscription = as_int(Some(&value));
        }
        _ => {}
    }
}

// ========== 编码 ==========

/// 把界面传来的值编成 broker 认的请求体与查询参数。
fn encode_namespace_value(field: &str, value: &Value) -> AppResult<(Value, Vec<(String, String)>)> {
    let mut query = Vec::new();
    let body = match field {
        "messageTtlSeconds" => json!(require_int("消息 TTL（秒）", value, 0, UNLIMITED_INT)?),
        "subscriptionExpirationTimeMinutes" => {
            json!(require_int(
                "订阅过期时间（分钟）",
                value,
                0,
                UNLIMITED_INT
            )?)
        }
        "retention" => {
            let object = value.as_object().ok_or_else(|| {
                AppError::config(format!(
                    "保留策略需要 {{timeInMinutes, sizeInMB}} 形状，收到 {value}"
                ))
            })?;
            json!({
                "retentionTimeInMinutes": require_int("保留时长", object.get("timeInMinutes").unwrap_or(&Value::Null), -1, UNLIMITED_INT)?,
                "retentionSizeInMB": require_int("保留容量", object.get("sizeInMB").unwrap_or(&Value::Null), -1, i64::MAX)?,
            })
        }
        "deduplicationEnabled" => json!(require_bool("服务端去重", value)?),
        "deduplicationSnapshotIntervalSeconds" => {
            json!(require_int("去重快照间隔（秒）", value, 1, UNLIMITED_INT)?)
        }
        "backlogQuota" => {
            let object = value.as_object().ok_or_else(|| {
                AppError::config(format!(
                    "积压配额需要 {{type, limitSizeBytes, limitTimeSeconds, policy}} 形状，收到 {value}"
                ))
            })?;
            let quota_type = require_enum(
                "配额类型",
                object.get("type").unwrap_or(&Value::Null),
                &QUOTA_TYPES,
            )?;
            let policy = require_enum(
                "超限处理策略",
                object.get("policy").unwrap_or(&Value::Null),
                &RETENTION_POLICIES,
            )?;
            query.push(("backlogQuotaType".to_string(), quota_type));
            // 请求体里多出来的 type 键 broker 不认识，会被 Jackson 拒成 400
            json!({
                "limitSize": require_int("配额大小", object.get("limitSizeBytes").unwrap_or(&Value::Null), 0, i64::MAX)?,
                "limitTime": require_int("配额时长", object.get("limitTimeSeconds").unwrap_or(&Value::Null), 0, UNLIMITED_INT)?,
                "policy": policy,
            })
        }
        "maxProducersPerTopic" => {
            json!(require_int("单 Topic 生产者上限", value, 0, UNLIMITED_INT)?)
        }
        "maxConsumersPerTopic" => {
            json!(require_int("单 Topic 消费者上限", value, 0, UNLIMITED_INT)?)
        }
        "maxConsumersPerSubscription" => {
            json!(require_int("单订阅消费者上限", value, 0, UNLIMITED_INT)?)
        }
        "maxUnackedMessagesPerConsumer" => {
            json!(require_int("每消费者未确认上限", value, 0, UNLIMITED_INT)?)
        }
        "maxUnackedMessagesPerSubscription" => {
            json!(require_int("每订阅未确认上限", value, 0, UNLIMITED_INT)?)
        }
        "maxSubscriptionsPerTopic" => {
            json!(require_int("单 Topic 订阅上限", value, 0, UNLIMITED_INT)?)
        }
        "maxTopicsPerNamespace" => json!(require_int(
            "单命名空间 Topic 上限",
            value,
            0,
            UNLIMITED_INT
        )?),
        "compactionThreshold" => json!(require_int("压缩阈值", value, 0, i64::MAX)?),
        "schemaValidationEnforced" => json!(require_bool("Schema 校验开关", value)?),
        "schemaCompatibilityStrategy" => {
            json!(require_enum(
                "Schema 兼容策略",
                value,
                &SCHEMA_COMPATIBILITY_STRATEGIES
            )?)
        }
        "schemaAutoUpdateStrategy" => {
            json!(require_enum(
                "Schema 自动更新策略",
                value,
                &SCHEMA_AUTO_UPDATE_STRATEGIES
            )?)
        }
        "allowAutoUpdateSchema" => json!(require_bool("自动更新 Schema 开关", value)?),
        "encryptionRequired" => json!(require_bool("强制加密", value)?),
        "dispatchRate" => encode_rate("分发限速", value, true, "dispatch")?,
        "subscriptionDispatchRate" => encode_rate("订阅分发限速", value, true, "dispatch")?,
        "replicatorDispatchRate" => encode_rate("复制分发限速", value, true, "dispatch")?,
        "subscribeRate" => encode_rate("订阅限速", value, true, "subscribe")?,
        "publishRate" => encode_rate("发布限速", value, false, "publish")?,
        "replicationClusters" => {
            let list = value.as_array().ok_or_else(|| {
                AppError::config(format!("复制集群需要一个字符串数组，收到 {value}"))
            })?;
            let mut names: Vec<String> = list
                .iter()
                .map(|item| match item {
                    Value::String(text) => text.trim().to_string(),
                    other => other.to_string(),
                })
                .filter(|item| !item.is_empty())
                .collect();
            let unique: BTreeSet<&String> = names.iter().collect();
            if unique.len() != names.len() {
                return Err(AppError::config("复制集群列表里有重复项"));
            }
            names.shrink_to_fit();
            // 端点收裸 JSON 字符串数组，不能包成 {clusterIds:[...]}
            Value::Array(names.into_iter().map(Value::String).collect())
        }
        other => {
            return Err(AppError::config(format!(
                "不支持修改的命名空间字段：{other}"
            )))
        }
    };
    Ok((body, query))
}

fn encode_rate(label: &str, value: &Value, with_period: bool, kind: &str) -> AppResult<Value> {
    let object = value.as_object().ok_or_else(|| {
        AppError::config(format!(
            "{label}需要 {{msgPerPeriod, bytePerPeriod}} 形状，收到 {value}"
        ))
    })?;
    let msg = require_int(
        &format!("{label}的条数限速"),
        object.get("msgPerPeriod").unwrap_or(&Value::Null),
        -1,
        UNLIMITED_INT,
    )?;
    let byte = require_int(
        &format!("{label}的字节限速"),
        object.get("bytePerPeriod").unwrap_or(&Value::Null),
        -1,
        i64::MAX,
    )?;
    // 限速必须整对象写回：少一个键 broker 按 0 处理，等于把那个维度全禁
    match kind {
        "subscribe" => {
            let period = if with_period {
                require_int(
                    &format!("{label}的周期（秒）"),
                    object.get("periodInSeconds").unwrap_or(&Value::Null),
                    1,
                    3600,
                )?
            } else {
                1
            };
            Ok(json!({
                "subscribeThrottlingRatePerConsumer": msg,
                "ratePeriodInSecond": period,
            }))
        }
        "publish" => Ok(json!({
            "publishThrottlingRateInMsg": msg,
            "publishThrottlingRateInByte": byte,
        })),
        _ => {
            let period = if with_period {
                require_int(
                    &format!("{label}的周期（秒）"),
                    object.get("periodInSeconds").unwrap_or(&Value::Null),
                    1,
                    3600,
                )?
            } else {
                1
            };
            Ok(json!({
                "dispatchThrottlingRateInMsg": msg,
                "dispatchThrottlingRateInByte": byte,
                "ratePeriodInSecond": period,
            }))
        }
    }
}

fn encode_topic_value(spec: &TopicFieldSpec, value: &Value) -> AppResult<Value> {
    let label = spec.label;
    match spec.field {
        "retention" => {
            let object = value.as_object().ok_or_else(|| {
                AppError::config(format!(
                    "{label}需要 {{timeInMinutes, sizeInMB}} 形状，收到 {value}"
                ))
            })?;
            // POST /retention 是整体替换：两个维度必须一起发，缺的那个不能猜 0
            Ok(json!({
                "retentionTimeInMinutes": require_int(&format!("{label}的时长（分钟）"), object.get("timeInMinutes").unwrap_or(&Value::Null), -1, UNLIMITED_INT)?,
                "retentionSizeInMB": require_int(&format!("{label}的容量（MB）"), object.get("sizeInMB").unwrap_or(&Value::Null), -1, i64::MAX)?,
            }))
        }
        "messageTtlSeconds" => Ok(json!(require_int(
            "消息 TTL（秒）",
            value,
            0,
            UNLIMITED_INT
        )?)),
        "deduplicationEnabled" => Ok(json!(require_bool("服务端去重", value)?)),
        "maxUnackedMessagesPerConsumer" => Ok(json!(require_int(
            "每消费者未确认上限",
            value,
            0,
            UNLIMITED_INT
        )?)),
        "maxUnackedMessagesPerSubscription" => Ok(json!(require_int(
            "每订阅未确认上限",
            value,
            0,
            UNLIMITED_INT
        )?)),
        other => Err(AppError::config(format!(
            "不支持在 topic 级设置的字段：{other}"
        ))),
    }
}

// ========== 比对：读回来的形状 vs 写回去的形状 ==========

fn rate_value_of(rate: &Option<NamespaceRateLimit>, with_period: bool) -> Value {
    let Some(rate) = rate else {
        return Value::Null;
    };
    if with_period {
        let period = rate
            .period_in_seconds
            .filter(|value| *value > 0.0)
            .unwrap_or(1.0);
        json!({
            "msgPerPeriod": rate.msg_per_period,
            "bytePerPeriod": rate.byte_per_period,
            "periodInSeconds": period,
        })
    } else {
        json!({
            "msgPerPeriod": rate.msg_per_period,
            "bytePerPeriod": rate.byte_per_period,
        })
    }
}

/// 折叠视图还原成「这个字段再次写入时要传的值」。`Null` 表示确实没设过。
pub fn namespace_policy_value(view: &NamespacePolicyView, field: &str) -> Value {
    match field {
        "messageTtlSeconds" => opt_int(view.message_ttl_seconds),
        "subscriptionExpirationTimeMinutes" => opt_int(view.subscription_expiration_time_minutes),
        "deduplicationSnapshotIntervalSeconds" => {
            opt_int(view.deduplication_snapshot_interval_seconds)
        }
        "retention" => {
            // 只读出一半的保留策略不能写：整体替换会把缺的那个数字变成 0
            match (view.retention_time_in_minutes, view.retention_size_in_mb) {
                (Some(time), Some(size)) => json!({"timeInMinutes": time, "sizeInMB": size}),
                _ => Value::Null,
            }
        }
        "backlogQuota" => serde_json::to_value(&view.backlog_quotas).unwrap_or(Value::Null),
        "deduplicationEnabled" => opt_bool(view.deduplication_enabled),
        "maxProducersPerTopic" => opt_int(view.max_producers_per_topic),
        "maxConsumersPerTopic" => opt_int(view.max_consumers_per_topic),
        "maxConsumersPerSubscription" => opt_int(view.max_consumers_per_subscription),
        "maxUnackedMessagesPerConsumer" => opt_int(view.max_unacked_messages_per_consumer),
        "maxUnackedMessagesPerSubscription" => opt_int(view.max_unacked_messages_per_subscription),
        "maxSubscriptionsPerTopic" => opt_int(view.max_subscriptions_per_topic),
        "maxTopicsPerNamespace" => opt_int(view.max_topics_per_namespace),
        "compactionThreshold" => opt_int(view.compaction_threshold),
        "schemaValidationEnforced" => opt_bool(view.schema_validation_enforced),
        "allowAutoUpdateSchema" => opt_bool(view.allow_auto_update_schema),
        "encryptionRequired" => opt_bool(view.encryption_required),
        "schemaCompatibilityStrategy" => opt_text(&view.schema_compatibility_strategy),
        "schemaAutoUpdateStrategy" => opt_text(&view.schema_auto_update_strategy),
        "dispatchRate" => rate_value_of(&view.dispatch_rate, true),
        "subscriptionDispatchRate" => rate_value_of(&view.subscription_dispatch_rate, true),
        "replicatorDispatchRate" => rate_value_of(&view.replicator_dispatch_rate, true),
        "subscribeRate" => rate_value_of(&view.subscribe_rate, true),
        "publishRate" => rate_value_of(&view.publish_rate, false),
        "replicationClusters" => {
            serde_json::to_value(&view.replication_clusters).unwrap_or(Value::Null)
        }
        _ => Value::Null,
    }
}

pub fn topic_policy_value(view: &TopicPolicyView, field: &str) -> Value {
    match field {
        "retention" => match (view.retention_time_in_minutes, view.retention_size_in_mb) {
            (Some(time), Some(size)) => json!({"timeInMinutes": time, "sizeInMB": size}),
            _ => Value::Null,
        },
        "messageTtlSeconds" => opt_int(view.message_ttl_seconds),
        "deduplicationEnabled" => opt_bool(view.deduplication_enabled),
        "maxUnackedMessagesPerConsumer" => opt_int(view.max_unacked_messages_per_consumer),
        "maxUnackedMessagesPerSubscription" => opt_int(view.max_unacked_messages_per_subscription),
        _ => Value::Null,
    }
}

fn opt_int(value: Option<i64>) -> Value {
    value.map(|value| json!(value)).unwrap_or(Value::Null)
}

fn opt_bool(value: Option<bool>) -> Value {
    value.map(|value| json!(value)).unwrap_or(Value::Null)
}

fn opt_text(value: &Option<String>) -> Value {
    value
        .as_ref()
        .map(|value| json!(value))
        .unwrap_or(Value::Null)
}

/// 规范化比较键：数组按集合比（broker 把复制集群当集合用），
/// null 与缺失同一个键，「没读到」和「读回来是 null」在比对上是同一件事。
pub fn canonical(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Array(items) => {
            let mut parts: Vec<String> = items.iter().map(canonical).collect();
            parts.sort();
            format!("[{}]", parts.join(","))
        }
        Value::Object(map) => {
            let mut pairs: Vec<(String, String)> = map
                .iter()
                .map(|(key, value)| (key.clone(), canonical(value)))
                .collect();
            pairs.sort();
            let body: Vec<String> = pairs
                .into_iter()
                .map(|(key, value)| format!("{key}:{value}"))
                .collect();
            format!("{{{}}}", body.join(","))
        }
        other => other.to_string(),
    }
}

// ========== 同步：命名空间 ==========

#[derive(Debug, Clone)]
pub struct SyncScope {
    pub tenant: String,
    pub namespace: String,
}

impl SyncScope {
    pub fn key(&self) -> String {
        format!("{}/{}", self.tenant, self.namespace)
    }
}

fn normalize_targets(source: &SyncScope, targets: &[SyncScope]) -> AppResult<Vec<SyncScope>> {
    let mut seen = BTreeSet::new();
    seen.insert(source.key());
    let mut list = Vec::new();
    for target in targets {
        let key = target.key();
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        list.push(target.clone());
    }
    if list.is_empty() {
        return Err(AppError::config(
            "没有可同步的目标命名空间：目标不能为空，也不能就是源本身",
        ));
    }
    if list.len() > SYNC_MAX_TARGETS {
        return Err(AppError::config(format!(
            "一次最多同步 {SYNC_MAX_TARGETS} 个命名空间（本次 {} 个）：每个目标要读 6 个端点、写 N 个字段，放大了会把 broker 的请求队列占满",
            list.len()
        )));
    }
    Ok(list)
}

fn display_view(mut view: NamespacePolicyView) -> NamespacePolicyView {
    fn strip(mut rate: NamespaceRateLimit) -> NamespaceRateLimit {
        rate.raw = Value::Object(Map::new());
        rate
    }
    view.raw = Value::Object(Map::new());
    view.dispatch_rate = view.dispatch_rate.map(strip);
    view.subscription_dispatch_rate = view.subscription_dispatch_rate.map(strip);
    view.subscribe_rate = view.subscribe_rate.map(strip);
    view.publish_rate = view.publish_rate.map(strip);
    view.replicator_dispatch_rate = view.replicator_dispatch_rate.map(strip);
    view
}

fn plan_backlog_quota(source: &NamespacePolicyView, target: &NamespacePolicyView) -> Vec<Value> {
    let mut deltas = Vec::new();
    let target_by_type: BTreeMap<&str, &NamespaceBacklogQuota> = target
        .backlog_quotas
        .iter()
        .map(|quota| (quota.quota_type.as_str(), quota))
        .collect();
    let source_types: BTreeSet<&str> = source
        .backlog_quotas
        .iter()
        .map(|quota| quota.quota_type.as_str())
        .collect();

    for quota in &source.backlog_quotas {
        if let Some(current) = target_by_type.get(quota.quota_type.as_str()) {
            let left = serde_json::to_value(quota).unwrap_or(Value::Null);
            let right = serde_json::to_value(current).unwrap_or(Value::Null);
            if canonical(&left) == canonical(&right) {
                continue;
            }
        }
        let usable = QUOTA_TYPES.contains(&quota.quota_type.as_str())
            && RETENTION_POLICIES.contains(&quota.policy.as_str());
        if usable {
            deltas.push(json!({
                "field": "backlogQuota",
                "action": "set",
                "quotaType": quota.quota_type,
                "value": {
                    "type": quota.quota_type,
                    "limitSizeBytes": quota.limit_size_bytes,
                    "limitTimeSeconds": quota.limit_time_seconds,
                    "policy": quota.policy,
                },
            }));
        } else {
            let reason = if !QUOTA_TYPES.contains(&quota.quota_type.as_str()) {
                format!(
                    "配额类型 {} 不在当前 broker 支持的枚举内，写入会被拒绝",
                    quota.quota_type
                )
            } else {
                format!(
                    "超限策略 {} 不在当前 broker 支持的枚举内，写入会被拒绝",
                    quota.policy
                )
            };
            deltas.push(json!({
                "field": "backlogQuota",
                "action": "skip",
                "quotaType": quota.quota_type,
                "reason": reason,
            }));
        }
    }
    for quota in &target.backlog_quotas {
        if !source_types.contains(quota.quota_type.as_str()) {
            deltas.push(json!({
                "field": "backlogQuota",
                "action": "clear",
                "quotaType": quota.quota_type,
            }));
        }
    }
    deltas
}

fn plan_namespace_field(
    source: &NamespacePolicyView,
    target: &NamespacePolicyView,
    field: &str,
) -> Vec<Value> {
    if field == "backlogQuota" {
        return plan_backlog_quota(source, target);
    }
    let from = namespace_policy_value(source, field);
    let to = namespace_policy_value(target, field);
    if canonical(&from) == canonical(&to) {
        return Vec::new();
    }
    if from.is_null() {
        let clearable = namespace_spec(field).is_some_and(|spec| spec.clearable);
        if !clearable {
            return vec![json!({
                "field": field,
                "action": "skip",
                "reason": "源命名空间未设置该项，而这个字段在 broker 侧没有清除端点，目标上的现有值保持不变",
            })];
        }
        return vec![json!({"field": field, "action": "clear"})];
    }
    vec![json!({"field": field, "action": "set", "value": from})]
}

/// 单个目标的差异计划。字段顺序按字段表走而不是按调用方顺序：
/// 预览、执行、操作日志要用同一套顺序。
pub fn plan_namespace_policy_sync(
    source: &NamespacePolicyView,
    target: &NamespacePolicyView,
    fields: &[String],
) -> Vec<Value> {
    let wanted: BTreeSet<&str> = fields.iter().map(String::as_str).collect();
    let mut deltas = Vec::new();
    for spec in NAMESPACE_FIELDS.iter().chain(NAMESPACE_EXTRA_FIELDS.iter()) {
        if wanted.contains(spec.field) {
            deltas.extend(plan_namespace_field(source, target, spec.field));
        }
    }
    deltas
}

impl AdminClient {
    /// 预览：只读、只算差异。源读不出来时返回结构化错误而不是整条失败，
    /// 预览面板要把原因显示在界面上，而不是让弹窗空白。
    pub async fn plan_namespace_sync(
        &self,
        source: &SyncScope,
        targets: &[SyncScope],
        fields: &[String],
    ) -> AppResult<Value> {
        let targets = normalize_targets(source, targets)?;
        let source_view = match self
            .namespace_policy_view(&source.tenant, &source.namespace)
            .await
        {
            Ok(view) => view,
            Err(error) => {
                return Ok(json!({
                    "source": {"tenant": source.tenant, "namespace": source.namespace},
                    "sourceError": error.to_string(),
                    "targets": [],
                }))
            }
        };

        let plans: Vec<Value> = stream::iter(targets.into_iter().map(|target| {
            let source_view = source_view.clone();
            let fields = fields.to_vec();
            async move {
                let mut plan = json!({
                    "tenant": target.tenant,
                    "namespace": target.namespace,
                    "deltas": [],
                });
                match self
                    .namespace_policy_view(&target.tenant, &target.namespace)
                    .await
                {
                    Ok(view) => {
                        plan["view"] =
                            serde_json::to_value(display_view(view.clone())).unwrap_or(Value::Null);
                        plan["deltas"] =
                            json!(plan_namespace_policy_sync(&source_view, &view, &fields));
                    }
                    Err(error) => plan["error"] = json!(error.to_string()),
                }
                plan
            }
        }))
        .buffer_unordered(SYNC_FANOUT)
        .collect()
        .await;

        Ok(json!({
            "source": {"tenant": source.tenant, "namespace": source.namespace},
            "sourceView": serde_json::to_value(display_view(source_view)).unwrap_or(Value::Null),
            "targets": plans,
        }))
    }

    /// 执行：每个目标重新读一遍再算差异（不信界面上那份预览），
    /// 目标内按字段顺序串行写，某一项失败就中止该目标。
    pub async fn apply_namespace_sync(
        &self,
        source: &SyncScope,
        targets: &[SyncScope],
        fields: &[String],
    ) -> AppResult<Value> {
        let targets = normalize_targets(source, targets)?;
        let source_view = self
            .namespace_policy_view(&source.tenant, &source.namespace)
            .await
            .map_err(|error| {
                AppError::Other(format!("读取源命名空间 {} 失败：{error}", source.key()))
            })?;

        let results: Vec<Value> = stream::iter(targets.into_iter().map(|target| {
            let source_view = source_view.clone();
            let fields = fields.to_vec();
            async move {
                let mut result = json!({
                    "tenant": target.tenant,
                    "namespace": target.namespace,
                    "items": [],
                });
                let view = match self
                    .namespace_policy_view(&target.tenant, &target.namespace)
                    .await
                {
                    Ok(view) => view,
                    Err(error) => {
                        // 读不出目标就一个字段都不动：这时候写下去的依据全是猜的
                        result["error"] = json!(format!("读取目标命名空间策略失败：{error}"));
                        return result;
                    }
                };
                let mut items = Vec::new();
                for delta in plan_namespace_policy_sync(&source_view, &view, &fields) {
                    let field = delta["field"].as_str().unwrap_or_default().to_string();
                    let action = delta["action"].as_str().unwrap_or_default().to_string();
                    if action == "skip" {
                        items.push(json!({
                            "field": field,
                            "action": "skip",
                            "quotaType": delta["quotaType"],
                            "ok": true,
                            "message": delta["reason"],
                        }));
                        continue;
                    }
                    let mut item = json!({
                        "field": field,
                        "action": action,
                        "quotaType": delta["quotaType"],
                        "ok": true,
                    });
                    let outcome = if action == "clear" {
                        self.clear_namespace_policy(
                            &target.tenant,
                            &target.namespace,
                            &field,
                            delta["quotaType"].as_str(),
                        )
                        .await
                    } else {
                        self.set_namespace_policy(
                            &target.tenant,
                            &target.namespace,
                            &field,
                            delta["value"].clone(),
                        )
                        .await
                    };
                    if let Err(error) = outcome {
                        item["ok"] = json!(false);
                        item["message"] = json!(error.to_string());
                        items.push(item);
                        // 中止本目标：剩下的项没执行，也不假装执行过
                        break;
                    }
                    items.push(item);
                }
                result["items"] = json!(items);
                result
            }
        }))
        .buffer_unordered(SYNC_FANOUT)
        .collect()
        .await;

        let (mut succeeded, mut failed) = (0, 0);
        for target in &results {
            if let Some(items) = target["items"].as_array() {
                for item in items {
                    if item["action"] == "skip" {
                        continue;
                    }
                    if item["ok"] == true {
                        succeeded += 1;
                    } else {
                        failed += 1;
                    }
                }
            }
        }
        Ok(json!({"targets": results, "succeeded": succeeded, "failed": failed}))
    }
}

// ========== 同步：topic ==========

#[derive(Debug, Clone)]
pub struct TopicScope {
    pub tenant: String,
    pub namespace: String,
    pub topic: String,
    pub persistent: bool,
}

impl TopicScope {
    pub fn key(&self) -> String {
        format!(
            "{}/{}/{}/{}",
            if self.persistent {
                "persistent"
            } else {
                "non-persistent"
            },
            self.tenant,
            self.namespace,
            self.topic
        )
    }

    fn value(&self) -> Value {
        json!({
            "tenant": self.tenant,
            "namespace": self.namespace,
            "topic": self.topic,
            "persistent": self.persistent,
        })
    }
}

fn normalize_topic_targets(
    source: &TopicScope,
    targets: &[TopicScope],
) -> AppResult<Vec<TopicScope>> {
    let mut seen = BTreeSet::new();
    seen.insert(source.key());
    let mut list = Vec::new();
    for target in targets {
        let key = target.key();
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        list.push(target.clone());
    }
    if list.is_empty() {
        return Err(AppError::config(
            "没有可同步的目标 topic：目标不能为空，也不能就是源本身",
        ));
    }
    if list.len() > SYNC_MAX_TARGETS {
        return Err(AppError::config(format!(
            "一次最多同步 {SYNC_MAX_TARGETS} 个 topic（本次 {} 个）",
            list.len()
        )));
    }
    Ok(list)
}

fn display_topic_view(mut view: TopicPolicyView) -> TopicPolicyView {
    view.raw = Value::Object(Map::new());
    view
}

pub fn plan_topic_policy_sync(
    source: &TopicPolicyView,
    target: &TopicPolicyView,
    fields: &[String],
) -> Vec<Value> {
    let wanted: BTreeSet<&str> = fields.iter().map(String::as_str).collect();
    let mut deltas = Vec::new();
    // 读不出来的端点不参与比对：那是 broker 侧开关没开，不是「未设置」
    let unavailable: BTreeSet<&str> = target
        .unavailable
        .iter()
        .map(|item| item.field.as_str())
        .collect();
    for spec in TOPIC_FIELDS.iter() {
        if !wanted.contains(spec.field) || unavailable.contains(spec.field) {
            continue;
        }
        let from = topic_policy_value(source, spec.field);
        let to = topic_policy_value(target, spec.field);
        if canonical(&from) == canonical(&to) {
            continue;
        }
        // 五个 topic 级端点都有 DELETE，源没设过就撤销覆盖
        if from.is_null() {
            deltas.push(json!({"field": spec.field, "action": "clear"}));
        } else {
            deltas.push(json!({"field": spec.field, "action": "set", "value": from}));
        }
    }
    deltas
}

impl AdminClient {
    pub async fn plan_topic_sync(
        &self,
        source: &TopicScope,
        targets: &[TopicScope],
        fields: &[String],
    ) -> AppResult<Value> {
        let targets = normalize_topic_targets(source, targets)?;
        let source_view = match self
            .topic_policy_view(
                &source.tenant,
                &source.namespace,
                &source.topic,
                source.persistent,
            )
            .await
        {
            Ok(view) => view,
            Err(error) => {
                return Ok(json!({
                    "source": source.value(),
                    "sourceError": error.to_string(),
                    "targets": [],
                }))
            }
        };

        let plans: Vec<Value> = stream::iter(targets.into_iter().map(|target| {
            let source_view = source_view.clone();
            let fields = fields.to_vec();
            async move {
                let mut plan = json!({
                    "tenant": target.tenant,
                    "namespace": target.namespace,
                    "topic": target.topic,
                    "persistent": target.persistent,
                    "deltas": [],
                });
                match self
                    .topic_policy_view(
                        &target.tenant,
                        &target.namespace,
                        &target.topic,
                        target.persistent,
                    )
                    .await
                {
                    Ok(view) => {
                        plan["view"] = serde_json::to_value(display_topic_view(view.clone()))
                            .unwrap_or(Value::Null);
                        plan["deltas"] =
                            json!(plan_topic_policy_sync(&source_view, &view, &fields));
                    }
                    Err(error) => plan["error"] = json!(error.to_string()),
                }
                plan
            }
        }))
        .buffer_unordered(SYNC_FANOUT)
        .collect()
        .await;

        Ok(json!({
            "source": source.value(),
            "sourceView": serde_json::to_value(display_topic_view(source_view)).unwrap_or(Value::Null),
            "targets": plans,
        }))
    }

    pub async fn apply_topic_sync(
        &self,
        source: &TopicScope,
        targets: &[TopicScope],
        fields: &[String],
    ) -> AppResult<Value> {
        let targets = normalize_topic_targets(source, targets)?;
        let source_view = self
            .topic_policy_view(
                &source.tenant,
                &source.namespace,
                &source.topic,
                source.persistent,
            )
            .await
            .map_err(|error| {
                AppError::Other(format!("读取源 topic {} 失败：{error}", source.key()))
            })?;

        let results: Vec<Value> = stream::iter(targets.into_iter().map(|target| {
            let source_view = source_view.clone();
            let fields = fields.to_vec();
            async move {
                let mut result = json!({
                    "tenant": target.tenant,
                    "namespace": target.namespace,
                    "topic": target.topic,
                    "persistent": target.persistent,
                    "items": [],
                });
                let view = match self
                    .topic_policy_view(
                        &target.tenant,
                        &target.namespace,
                        &target.topic,
                        target.persistent,
                    )
                    .await
                {
                    Ok(view) => view,
                    Err(error) => {
                        result["error"] = json!(format!("读取目标 topic 策略失败：{error}"));
                        return result;
                    }
                };
                let mut items = Vec::new();
                for delta in plan_topic_policy_sync(&source_view, &view, &fields) {
                    let field = delta["field"].as_str().unwrap_or_default().to_string();
                    let action = delta["action"].as_str().unwrap_or_default().to_string();
                    let mut item = json!({"field": field, "action": action, "ok": true});
                    let outcome = if action == "clear" {
                        self.clear_topic_policy(
                            &target.tenant,
                            &target.namespace,
                            &target.topic,
                            &field,
                            target.persistent,
                        )
                        .await
                    } else {
                        self.set_topic_policy(
                            &target.tenant,
                            &target.namespace,
                            &target.topic,
                            &field,
                            delta["value"].clone(),
                            target.persistent,
                        )
                        .await
                    };
                    if let Err(error) = outcome {
                        item["ok"] = json!(false);
                        item["message"] = json!(error.to_string());
                        items.push(item);
                        break;
                    }
                    items.push(item);
                }
                result["items"] = json!(items);
                result
            }
        }))
        .buffer_unordered(SYNC_FANOUT)
        .collect()
        .await;

        let (mut succeeded, mut failed) = (0, 0);
        for target in &results {
            if let Some(items) = target["items"].as_array() {
                for item in items {
                    if item["ok"] == true {
                        succeeded += 1;
                    } else {
                        failed += 1;
                    }
                }
            }
        }
        Ok(json!({"targets": results, "succeeded": succeeded, "failed": failed}))
    }
}

// ========== Function Worker ==========

const WORKER_BASE: &str = "/admin/v2/worker";

pub const WORKER_UNAVAILABLE_MESSAGE: &str =
    "该集群没有可用的 Function Worker：/admin/v2/worker 与 /admin/v3/functions 都不存在。函数与连接器要求 broker 配置 functionWorkerEnabled=true，或另起一个 worker 节点；只做消息收发的部署本来就没有这两个端点。";

fn runtime_base(kind: &str) -> AppResult<&'static str> {
    match kind {
        "function" | "functions" => Ok("/admin/v3/functions"),
        "sink" | "sinks" => Ok("/admin/v3/sinks"),
        "source" | "sources" => Ok("/admin/v3/sources"),
        other => Err(AppError::Unsupported(format!("未知 runtime 类型 {other}"))),
    }
}

/// broker 的 FunctionConfig/SinkConfig/SourceConfig 有几十个键；这里只挑界面
/// 一定会展示的字段，其余原样留在 raw 里给详情抽屉。
fn normalize_runtime_item(
    kind: &str,
    tenant: &str,
    namespace: &str,
    name: &str,
    raw: Value,
    status: Option<Value>,
    stats: Option<Value>,
) -> Value {
    let text = |key: &str| raw.get(key).and_then(Value::as_str).map(str::to_string);
    let class_name = text("className")
        .or_else(|| text("sinkClassName"))
        .or_else(|| text("sourceClassName"));
    let archive = text("archive")
        .or_else(|| text("jar"))
        .or_else(|| text("py"))
        .or_else(|| text("go"));
    let runtime = text("runtime")
        .map(|value| value.to_ascii_uppercase())
        .or_else(|| {
            if raw.get("jar").and_then(Value::as_str).is_some() {
                Some("JAVA".into())
            } else if raw.get("py").and_then(Value::as_str).is_some() {
                Some("PYTHON".into())
            } else if raw.get("go").and_then(Value::as_str).is_some() {
                Some("GO".into())
            } else {
                None
            }
        });
    let resources = raw.get("resources");
    let cpu = resources
        .and_then(|value| value.get("cpu"))
        .and_then(Value::as_f64);
    let ram_mb = resources
        .and_then(|value| value.get("ram"))
        .and_then(Value::as_i64)
        .map(|bytes| bytes / (1024 * 1024));
    let disk_mb = resources
        .and_then(|value| value.get("disk"))
        .and_then(Value::as_i64)
        .map(|bytes| bytes / (1024 * 1024));
    // source 没有 inputs，用 topicName 表示输出；sink 的 inputs 是消费的 topic。
    let inputs = raw.get("inputs").cloned().unwrap_or(Value::Null);
    let output = raw
        .get("output")
        .cloned()
        .or_else(|| raw.get("topicName").cloned())
        .unwrap_or(Value::Null);

    json!({
        "config": {
            "kind": kind,
            "tenant": tenant,
            "namespace": namespace,
            "name": name,
            "className": class_name,
            "archive": archive,
            "runtime": runtime,
            "inputs": inputs,
            "output": output,
            "logTopic": raw.get("logTopic").cloned().unwrap_or(Value::Null),
            "parallelism": raw.get("parallelism").cloned().unwrap_or(Value::Null),
            "processingGuarantee": raw
                .get("processingGuarantees")
                .cloned()
                .unwrap_or(Value::Null),
            "cpu": cpu,
            "ramMb": ram_mb,
            "diskMb": disk_mb,
            "autoAck": raw.get("autoAck").cloned().unwrap_or(Value::Null),
            "timeoutMs": raw.get("timeoutMs").cloned().unwrap_or(Value::Null),
            "raw": raw,
        },
        "status": status.and_then(normalize_runtime_status),
        "stats": stats.and_then(normalize_runtime_stats),
    })
}

fn normalize_runtime_status(raw: Value) -> Option<Value> {
    let instances = raw
        .get("instances")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if instances.is_empty() && raw.get("numInstances").is_none() {
        return None;
    }
    let mut running = 0i64;
    let mut stopped = 0i64;
    let mut error = 0i64;
    let mut items = Vec::with_capacity(instances.len());
    for instance in instances {
        let status = instance.get("status");
        let is_running = status
            .and_then(|value| value.get("running"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let message = status
            .and_then(|value| value.get("error"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let state = if !message.is_empty() {
            error += 1;
            "error"
        } else if is_running {
            running += 1;
            "running"
        } else {
            stopped += 1;
            "stopped"
        };
        items.push(json!({
            "instanceId": instance.get("instanceId").and_then(Value::as_i64).unwrap_or(0),
            "status": state,
            "error": if message.is_empty() { Value::Null } else { Value::String(message) },
            "numRestarts": status
                .and_then(|value| value.get("numRestarts"))
                .and_then(Value::as_i64)
                .unwrap_or(0),
            "workerId": instance.get("workerId").and_then(Value::as_str),
        }));
    }
    let num_instances = raw
        .get("numInstances")
        .and_then(Value::as_i64)
        .unwrap_or(items.len() as i64);
    Some(json!({
        "numInstances": num_instances,
        "running": running,
        "stopped": stopped,
        "error": error,
        "instances": items,
    }))
}

fn normalize_runtime_stats(raw: Value) -> Option<Value> {
    let number = |key: &str| raw.get(key).and_then(Value::as_i64).unwrap_or(0);
    let user = number("userExceptionsTotal");
    let system = number("systemExceptionsTotal");
    let exceptions = user + system;
    let received = number("receivedTotal");
    let processed = number("processedTotal");
    let emitted = number("emittedTotal");
    if received == 0 && processed == 0 && emitted == 0 && exceptions == 0 {
        return None;
    }
    Some(json!({
        "received": received,
        "processed": processed,
        "successfullyProcessed": number("processedSuccessfullyTotal"),
        "unsuccessfullyProcessed": exceptions,
        "emitted": emitted,
        "exceptions": exceptions,
    }))
}

/// 内置清单的路径不是复数规则：functions/builtins、sinks/builtinsinks、sources/builtinsources
fn builtin_base(kind: &str) -> AppResult<String> {
    let base = runtime_base(kind)?;
    Ok(match kind {
        "function" | "functions" => format!("{base}/builtins"),
        "sink" | "sinks" => format!("{base}/builtinsinks"),
        _ => format!("{base}/builtinsources"),
    })
}

fn reload_path(kind: &str) -> AppResult<String> {
    let base = runtime_base(kind)?;
    Ok(match kind {
        "function" | "functions" => format!("{base}/builtins/reload"),
        "sink" | "sinks" => format!("{base}/reloadBuiltInSinks"),
        _ => format!("{base}/reloadBuiltInSources"),
    })
}

impl AdminClient {
    /// worker 探测：只有「端点不存在」才认定未启用，网络错误与 5xx 照原样抛，
    /// 否则一次隧道抖动就会被显示成「该集群没有 worker」。
    pub async fn worker_state(&self) -> AppResult<Value> {
        let probe = self
            .get_opt_json::<Value>(&format!("{WORKER_BASE}/cluster"))
            .await;
        match probe {
            Ok(Some(data)) => {
                let list = match &data {
                    Value::Array(items) => items.clone(),
                    Value::Null => Vec::new(),
                    other => vec![other.clone()],
                };
                let nodes: Vec<Value> = list
                    .iter()
                    .map(|item| {
                        json!({
                            "workerId": item
                                .get("workerId")
                                .or_else(|| item.get("assignorTopic"))
                                .map(|value| match value {
                                    Value::String(text) => text.clone(),
                                    other => other.to_string(),
                                })
                                .unwrap_or_default(),
                            "workerHostname": item.get("workerHostname").and_then(Value::as_str),
                            "port": item.get("port").and_then(Value::as_i64),
                            "isLeader": item.get("isLeader").and_then(Value::as_bool),
                            "assignmentOffset": item.get("assignmentOffset").and_then(Value::as_i64),
                        })
                    })
                    .collect();
                Ok(json!({ "enabled": true, "nodes": nodes }))
            }
            Ok(None) => Ok(json!({
                "enabled": false,
                "nodes": [],
                "notice": WORKER_UNAVAILABLE_MESSAGE,
            })),
            // 老 broker 上 /worker/cluster 可能回 405/501，同样按未启用处理
            Err(AppError::Http { status, .. }) if status == 405 || status == 501 => Ok(json!({
                "enabled": false,
                "nodes": [],
                "notice": WORKER_UNAVAILABLE_MESSAGE,
            })),
            Err(error) => Err(error),
        }
    }

    async fn ensure_worker(&self) -> AppResult<()> {
        let state = self.worker_state().await?;
        if state["enabled"] == true {
            Ok(())
        } else {
            Err(AppError::Unsupported(
                WORKER_UNAVAILABLE_MESSAGE.to_string(),
            ))
        }
    }

    async fn worker_config(
        &self,
        base: &str,
        tenant: &str,
        namespace: &str,
        name: &str,
    ) -> AppResult<Value> {
        self.get_json(&format!(
            "{base}/{}/{}/{}",
            seg(tenant),
            seg(namespace),
            seg(name)
        ))
        .await
    }

    async fn worker_status(
        &self,
        base: &str,
        tenant: &str,
        namespace: &str,
        name: &str,
    ) -> Option<Value> {
        self.get_opt_json::<Value>(&format!(
            "{base}/{}/{}/{}/status",
            seg(tenant),
            seg(namespace),
            seg(name)
        ))
        .await
        .ok()
        .flatten()
    }

    async fn worker_stats(
        &self,
        base: &str,
        tenant: &str,
        namespace: &str,
        name: &str,
    ) -> Option<Value> {
        self.get_opt_json::<Value>(&format!(
            "{base}/{}/{}/{}/stats",
            seg(tenant),
            seg(namespace),
            seg(name)
        ))
        .await
        .ok()
        .flatten()
    }

    /// 列表：broker 只返回名字，这里补齐成 `{config,status,stats}`，与渲染层
    /// `PulsarRuntimeItem[]` 契约一致（否则页面读 `item.config.name` 直接崩）。
    pub async fn worker_items(
        &self,
        kind: &str,
        tenant: &str,
        namespace: &str,
    ) -> AppResult<Vec<Value>> {
        self.ensure_worker().await?;
        let base = runtime_base(kind)?.to_string();
        let names = self
            .get_opt_json::<Vec<String>>(&format!("{base}/{}/{}", seg(tenant), seg(namespace)))
            .await?
            .unwrap_or_default();
        let names: Vec<String> = names.into_iter().filter(|name| !name.is_empty()).collect();
        let items = stream::iter(names.into_iter().map(|name| {
            let base = base.clone();
            let kind = kind.to_string();
            let tenant = tenant.to_string();
            let namespace = namespace.to_string();
            async move {
                // 详情取不到也要保留这一行：界面仍需要能对它做删除/启停，
                // 直接丢掉会让用户以为函数不存在。
                let config = match self.worker_config(&base, &tenant, &namespace, &name).await {
                    Ok(config) => config,
                    Err(error) => json!({ "__unavailable": error.to_string() }),
                };
                let status = self.worker_status(&base, &tenant, &namespace, &name).await;
                let stats = self.worker_stats(&base, &tenant, &namespace, &name).await;
                Ok::<Value, AppError>(normalize_runtime_item(
                    &kind, &tenant, &namespace, &name, config, status, stats,
                ))
            }
        }))
        .buffer_unordered(8)
        .filter_map(|item| async move { item.ok() })
        .collect::<Vec<Value>>()
        .await;
        let mut items = items;
        items.sort_by_key(|item| {
            item["config"]["name"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        });
        Ok(items)
    }

    pub async fn worker_item(
        &self,
        kind: &str,
        tenant: &str,
        namespace: &str,
        name: &str,
    ) -> AppResult<Value> {
        self.ensure_worker().await?;
        let base = runtime_base(kind)?;
        let config = self.worker_config(base, tenant, namespace, name).await?;
        let status = self.worker_status(base, tenant, namespace, name).await;
        let stats = self.worker_stats(base, tenant, namespace, name).await;
        Ok(normalize_runtime_item(
            kind, tenant, namespace, name, config, status, stats,
        ))
    }

    pub async fn worker_control(
        &self,
        kind: &str,
        tenant: &str,
        namespace: &str,
        name: &str,
        action: &str,
        instance_id: Option<i64>,
    ) -> AppResult<()> {
        self.ensure_worker().await?;
        let base = runtime_base(kind)?;
        if !matches!(action, "start" | "stop" | "restart") {
            return Err(AppError::config(format!("不支持的控制动作 {action}")));
        }
        let mut query = Vec::new();
        if let Some(instance) = instance_id {
            query.push(("instance-id".to_string(), instance.to_string()));
        }
        self.post_with_query(
            &format!(
                "{base}/{}/{}/{}/{}",
                seg(tenant),
                seg(namespace),
                seg(name),
                action
            ),
            None,
            &query,
        )
        .await
    }

    pub async fn worker_delete(
        &self,
        kind: &str,
        tenant: &str,
        namespace: &str,
        name: &str,
    ) -> AppResult<()> {
        self.ensure_worker().await?;
        let base = runtime_base(kind)?;
        self.delete(&format!(
            "{base}/{}/{}/{}",
            seg(tenant),
            seg(namespace),
            seg(name)
        ))
        .await
    }

    /// 注册函数/连接器。三段式：`{kind}Config` 文本段是完整定义，
    /// `url` 段让 worker 自己去取包，`data` 文件段是本地包（与 url 二选一）。
    #[allow(clippy::too_many_arguments)] // 参数就是这几列，拆成结构体只会多一层转发
    pub async fn register_runtime(
        &self,
        kind: &str,
        tenant: &str,
        namespace: &str,
        name: &str,
        config_json: &str,
        package_path: Option<&str>,
        archive_url: Option<&str>,
    ) -> AppResult<String> {
        self.ensure_worker().await?;
        let base = runtime_base(kind)?;
        let path = format!("{base}/{}/{}/{}", seg(tenant), seg(namespace), seg(name));
        let config_part = if kind == "function" {
            "functionConfig".to_string()
        } else {
            format!("{kind}Config")
        };

        let mut fields = vec![(config_part, config_json.to_string())];
        match package_path.filter(|value| !value.is_empty()) {
            Some(file_path) => {
                let file_name = std::path::Path::new(file_path)
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| "package.bin".to_string());
                let output = self
                    .post_multipart(
                        &path,
                        &fields,
                        Some((std::path::Path::new(file_path), file_name)),
                    )
                    .await?;
                Ok(output_or_default(output))
            }
            None => {
                if let Some(url) = archive_url.filter(|value| !value.is_empty()) {
                    fields.push(("url".to_string(), url.to_string()));
                }
                let output = self.post_multipart(&path, &fields, None).await?;
                Ok(output_or_default(output))
            }
        }
    }

    /// 触发函数：POST 表单到 /admin/v3/functions/{t}/{ns}/{name}/trigger。
    /// 返回的是函数自己的输出文本，不是 JSON，所以按原文取回再包成 `{output}`。
    pub async fn worker_trigger(
        &self,
        tenant: &str,
        namespace: &str,
        name: &str,
        topic: &str,
        data: &str,
    ) -> AppResult<Value> {
        self.ensure_worker().await?;
        let path = format!(
            "/admin/v3/functions/{}/{}/{}/trigger",
            seg(tenant),
            seg(namespace),
            seg(name)
        );
        let output = self
            .post_form_raw(&path, &[("topic", topic), ("data", data)])
            .await?;
        Ok(json!({ "output": output }))
    }

    pub async fn worker_builtins(&self, kind: &str) -> AppResult<Value> {
        self.ensure_worker().await?;
        let base = builtin_base(kind)?;
        let list = self
            .get_opt_json::<Vec<Value>>(&base)
            .await?
            .unwrap_or_default();
        let mut items: Vec<Value> = list
            .iter()
            .map(|raw| {
                json!({
                    "kind": kind,
                    "name": raw.get("name").and_then(Value::as_str).unwrap_or_default(),
                    "className": raw
                        .get("className")
                        .or_else(|| raw.get("sinkClass"))
                        .or_else(|| raw.get("sourceClass"))
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    "archive": raw.get("archive").and_then(Value::as_str).unwrap_or_default(),
                    "description": raw.get("description").and_then(Value::as_str),
                    "inputs": raw.get("inputs").cloned(),
                    "multiDataInputs": raw.get("multiDataInputs").cloned(),
                    "output": raw.get("output").cloned(),
                })
            })
            .filter(|item| item["name"].as_str().is_some_and(|name| !name.is_empty()))
            .collect();
        items.sort_by_key(|item| item["name"].as_str().unwrap_or_default().to_string());
        Ok(Value::Array(items))
    }

    pub async fn worker_reload_builtins(&self, kind: &str) -> AppResult<()> {
        self.ensure_worker().await?;
        self.post_empty(&reload_path(kind)?).await
    }
}

fn output_or_default(output: String) -> String {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        "已提交".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_item_matches_frontend_contract() {
        let item = normalize_runtime_item(
            "function",
            "public",
            "default",
            "word-count",
            json!({
                "className": "org.example.WordCount",
                "jar": "/pulsar/functions/word-count.jar",
                "inputs": ["persistent://public/default/in"],
                "output": "persistent://public/default/out",
                "parallelism": 2,
                "processingGuarantees": "ATLEAST_ONCE",
                "resources": {"cpu": 0.5, "ram": 1048576, "disk": 2097152}
            }),
            Some(json!({
                "numInstances": 2,
                "instances": [
                    {"instanceId": 0, "status": {"running": true, "error": ""}, "workerId": "w1"},
                    {"instanceId": 1, "status": {"running": false, "error": "boom"}, "workerId": "w2"}
                ]
            })),
            Some(json!({
                "receivedTotal": 10,
                "processedTotal": 9,
                "processedSuccessfullyTotal": 8,
                "userExceptionsTotal": 1,
                "emittedTotal": 8
            })),
        );
        assert_eq!(item["config"]["kind"], "function");
        assert_eq!(item["config"]["name"], "word-count");
        assert_eq!(item["config"]["runtime"], "JAVA");
        assert_eq!(item["config"]["ramMb"], 1);
        assert_eq!(item["config"]["diskMb"], 2);
        assert_eq!(item["status"]["numInstances"], 2);
        assert_eq!(item["status"]["running"], 1);
        assert_eq!(item["status"]["error"], 1);
        assert_eq!(item["status"]["instances"][1]["status"], "error");
        assert_eq!(item["stats"]["processed"], 9);
        assert_eq!(item["stats"]["exceptions"], 1);
    }

    #[test]
    fn runtime_item_survives_missing_config() {
        let item = normalize_runtime_item(
            "source",
            "public",
            "default",
            "mysql-source",
            json!({"__unavailable": "connection refused"}),
            None,
            None,
        );
        assert_eq!(item["config"]["name"], "mysql-source");
        assert_eq!(item["config"]["kind"], "source");
        assert!(item["status"].is_null());
        assert!(item["stats"].is_null());
    }

    #[test]
    fn folds_policies_with_mixed_key_styles() {
        let raw = json!({
            "message_ttl_in_seconds": 3600,
            "max_producers_per_topic": 5,
            "deduplicationEnabled": true,
            "retention_policies": {"retentionTimeInMinutes": 60, "retentionSizeInMB": 1024},
            "backlog_quota_map": {
                "message_age": {"limitSize": 0, "limitTime": 300, "policy": "producer_exception"},
                "destination_storage": {"limitSize": 1024, "limitTime": -1, "policy": "producer_request_hold"}
            },
            "replication_clusters": ["c1", "c2"]
        });
        let view = fold_namespace_policies(&raw);
        assert_eq!(view.message_ttl_seconds, Some(3600));
        assert_eq!(view.max_producers_per_topic, Some(5));
        assert_eq!(view.deduplication_enabled, Some(true));
        assert_eq!(view.retention_time_in_minutes, Some(60));
        assert_eq!(view.retention_size_in_mb, Some(1024));
        // 已知配额类型按字段表顺序排，存储型在前
        assert_eq!(view.backlog_quotas[0].quota_type, "destination_storage");
        assert_eq!(view.backlog_quotas[1].quota_type, "message_age");
        assert_eq!(view.replication_clusters, vec!["c1", "c2"]);
        assert!(view.clearable_fields.contains(&"backlogQuota".to_string()));
    }

    #[test]
    fn canonical_compares_arrays_as_sets() {
        assert_eq!(canonical(&json!(["b", "a"])), canonical(&json!(["a", "b"])));
        assert_eq!(canonical(&Value::Null), "null");
        assert_ne!(canonical(&json!(1)), canonical(&json!(2)));
    }

    #[test]
    fn rate_value_never_drops_period() {
        let rate = NamespaceRateLimit {
            msg_per_period: 10.0,
            byte_per_period: 20.0,
            period_in_seconds: None,
            raw: Value::Null,
        };
        let view = NamespacePolicyView {
            dispatch_rate: Some(rate),
            ..Default::default()
        };
        let value = namespace_policy_value(&view, "dispatchRate");
        // 老 broker 不返回周期时补 1，正是它自己的默认值
        assert_eq!(value["periodInSeconds"], json!(1.0));
        assert_eq!(value["msgPerPeriod"], json!(10.0));
    }

    #[test]
    fn plan_clears_target_only_fields() {
        let source = NamespacePolicyView {
            message_ttl_seconds: Some(60),
            max_topics_per_namespace: Some(3),
            ..Default::default()
        };
        let target = NamespacePolicyView {
            message_ttl_seconds: Some(120),
            max_topics_per_namespace: None,
            deduplication_snapshot_interval_seconds: Some(30),
            ..Default::default()
        };
        let deltas = plan_namespace_policy_sync(
            &source,
            &target,
            &[
                "messageTtlSeconds".into(),
                "deduplicationSnapshotIntervalSeconds".into(),
            ],
        );
        assert_eq!(deltas.len(), 2);
        assert_eq!(deltas[0]["action"], "set");
        assert_eq!(deltas[0]["value"], json!(60));
        // 源没设、目标设过，且该字段没有 DELETE 端点 → skip 并说明原因
        assert_eq!(deltas[1]["action"], "skip");
    }
}
