use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

// ========== 集群 ==========

/// 落库形态：凭据只以密文出现，读列表时不会被带出去。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Cluster {
    pub id: String,
    pub name: String,
    pub service_url: String,
    pub web_service_url: Option<String>,
    pub auth_plugin: Option<String>,
    pub auth_params_enc: Option<String>,
    pub tls_enabled: bool,
    pub tls_trust_certs_enc: Option<String>,
    pub use_ssh_tunnel: bool,
    pub ssh_config_id: Option<String>,
    pub use_k8s_forward: bool,
    pub k8s_config_id: Option<String>,
    pub admin_api_timeout: i64,
    pub status: String,
    pub version: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Cluster {
    /// 从 serviceUrl 推 Admin API 地址（见 [`crate::path::resolve_base_url`] 的说明）。
    pub fn admin_config(
        &self,
        auth_params: Option<String>,
        trust_certs: Option<String>,
    ) -> AdminConfig {
        AdminConfig {
            service_url: self.service_url.clone(),
            web_service_url: self.web_service_url.clone(),
            timeout_ms: if self.admin_api_timeout > 0 {
                self.admin_api_timeout as u64
            } else {
                5000
            },
            auth_plugin: self.auth_plugin.clone(),
            auth_params,
            tls_enabled: self.tls_enabled,
            trust_certs,
        }
    }
}

/// 界面用形态：凭据一律不回传，只给「是否已配置」。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterView {
    pub id: String,
    pub name: String,
    pub service_url: String,
    pub web_service_url: Option<String>,
    pub auth_plugin: Option<String>,
    pub tls_enabled: bool,
    pub has_auth_params: bool,
    pub has_tls_trust_certs: bool,
    pub use_ssh_tunnel: bool,
    pub ssh_config_id: Option<String>,
    pub use_k8s_forward: bool,
    pub k8s_config_id: Option<String>,
    pub admin_api_timeout: i64,
    pub status: String,
    pub version: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
// default 让旧版前端/导入文件只带部分字段时也能落到"空值 + 一条人话校验"，
// 而不是一句 missing field 把整个保存流程挡在反序列化阶段。
#[serde(rename_all = "camelCase", default)]
pub struct ClusterDraft {
    pub id: Option<String>,
    pub name: String,
    pub service_url: String,
    pub web_service_url: Option<String>,
    pub auth_plugin: Option<String>,
    /// 明文。`None` 或空串表示「不改动已保存的凭据」。
    pub auth_params: Option<String>,
    pub tls_enabled: bool,
    pub tls_trust_certs: Option<String>,
    pub use_ssh_tunnel: bool,
    pub ssh_config_id: Option<String>,
    pub use_k8s_forward: bool,
    pub k8s_config_id: Option<String>,
    pub admin_api_timeout: Option<i64>,
}

/// Admin REST 客户端配置（凭据已解密）。
#[derive(Debug, Clone, Default)]
pub struct AdminConfig {
    pub service_url: String,
    pub web_service_url: Option<String>,
    pub timeout_ms: u64,
    pub auth_plugin: Option<String>,
    pub auth_params: Option<String>,
    pub tls_enabled: bool,
    pub trust_certs: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConnectionTest {
    pub connected: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

// ========== 资源 ==========

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tenant {
    /// broker 的单租户详情不返回 name（只在外层路径里），读出来后由调用方回填。
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub admin_roles: Vec<String>,
    #[serde(default)]
    pub allowed_clusters: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Topic {
    /// `tenant/ns/topic`（已去掉 `persistent://` 前缀）
    pub name: String,
    pub persistent: bool,
    pub topic_uri: String,
    /// 分区 URI 列表；非分区 topic 为空
    #[serde(default)]
    pub partitions: Vec<String>,
}

impl Topic {
    pub fn short_name(&self) -> &str {
        self.name.rsplit('/').next().unwrap_or(&self.name)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterInfo {
    /// broker 的集群详情不返回 name，路径里的名字才是唯一来源。
    #[serde(default)]
    pub name: String,
    pub service_url: String,
    pub broker_service_url: Option<String>,
    pub version: Option<String>,
}

// ========== 统计 ==========

fn zero_i64() -> i64 {
    0
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProducerStats {
    #[serde(default)]
    pub producer_id: i64,
    #[serde(default)]
    pub producer_name: String,
    #[serde(default = "default_true")]
    pub connected: bool,
    #[serde(default)]
    pub msg_rate_in: f64,
    #[serde(default)]
    pub msg_throughput_in: f64,
    #[serde(default)]
    pub average_msg_size: f64,
    pub address: Option<String>,
    pub connected_since: Option<String>,
    pub client_version: Option<String>,
    pub access_mode: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerStats {
    #[serde(default)]
    pub consumer_name: String,
    #[serde(default = "default_true")]
    pub connected: bool,
    #[serde(default)]
    pub msg_rate_out: f64,
    #[serde(default)]
    pub msg_throughput_out: f64,
    #[serde(default)]
    pub msg_rate_redeliver: f64,
    #[serde(default)]
    pub unacked_messages: i64,
    #[serde(default)]
    pub available_permits: i64,
    #[serde(default)]
    pub blocked_consumer_on_unacked_msgs: bool,
    pub address: Option<String>,
    pub connected_since: Option<String>,
    pub client_version: Option<String>,
    #[serde(default)]
    pub subscription: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionStats {
    #[serde(default)]
    pub msg_backlog: i64,
    #[serde(default)]
    pub backlog_size: i64,
    #[serde(default)]
    pub msg_rate_expired: f64,
    #[serde(default)]
    pub msg_rate_out: f64,
    #[serde(default)]
    pub msg_throughput_out: f64,
    #[serde(default)]
    pub unacked_messages: i64,
    #[serde(default = "default_sub_type")]
    pub r#type: String,
    #[serde(default)]
    pub consumers: Vec<ConsumerStats>,
    #[serde(default)]
    pub blocked_subscription_on_unacked_msgs: bool,
    #[serde(default)]
    pub durable: bool,
}

fn default_sub_type() -> String {
    "Unknown".to_string()
}

impl SubscriptionStats {
    pub fn consumer_count(&self) -> usize {
        self.consumers.len()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicStats {
    #[serde(default)]
    pub msg_rate_in: f64,
    #[serde(default)]
    pub msg_rate_out: f64,
    #[serde(default)]
    pub msg_throughput_in: f64,
    #[serde(default)]
    pub msg_throughput_out: f64,
    #[serde(default)]
    pub storage_size: f64,
    #[serde(default)]
    pub backlog_size: f64,
    #[serde(default)]
    pub msg_in_counter: f64,
    #[serde(default)]
    pub msg_out_counter: f64,
    #[serde(default)]
    pub average_msg_size: f64,
    #[serde(default, alias = "publishers")]
    pub producers: Vec<ProducerStats>,
    #[serde(default)]
    pub subscriptions: BTreeMap<String, SubscriptionStats>,
    #[serde(default)]
    pub deduplication_status: Option<String>,
    #[serde(default)]
    pub owner_broker: Option<String>,
    /// 分区 topic 的 `/partitioned-stats` 才有：分区 URI -> 该分区统计
    #[serde(default)]
    pub partitions: BTreeMap<String, TopicStats>,
    /// 派生字段：主进程拼装，不来自 broker
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub persistent: bool,
    #[serde(default)]
    pub partition_list: Vec<String>,
    #[serde(default)]
    pub owner_brokers: Vec<String>,
    #[serde(default)]
    pub backlog_quota_limit_size: Option<f64>,
    #[serde(default)]
    pub backlog_quota_limit_time: Option<f64>,
}

impl TopicStats {
    pub fn all_consumers(&self) -> Vec<ConsumerStats> {
        let mut out = Vec::new();
        for (name, sub) in &self.subscriptions {
            for consumer in &sub.consumers {
                let mut item = consumer.clone();
                if item.subscription.is_empty() {
                    item.subscription = name.clone();
                }
                out.push(item);
            }
        }
        out
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerInfo {
    #[serde(default)]
    pub active_brokers: Vec<String>,
    #[serde(default)]
    pub all_brokers: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AggregatedStats {
    #[serde(default)]
    pub total_topics: i64,
    #[serde(default)]
    pub total_partitions: i64,
    #[serde(default)]
    pub total_subscriptions: i64,
    #[serde(default)]
    pub total_producers: i64,
    #[serde(default)]
    pub total_consumers: i64,
    #[serde(default)]
    pub total_msg_rate_in: f64,
    #[serde(default)]
    pub total_msg_rate_out: f64,
    #[serde(default)]
    pub total_throughput_in: f64,
    #[serde(default)]
    pub total_throughput_out: f64,
    #[serde(default)]
    pub total_backlog: i64,
}

/// 监控时序点（落库形态）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsPoint {
    pub cluster_id: String,
    /// 空串表示「集群总体」，与既有库约定一致
    pub topic_uri: String,
    pub msg_rate_in: f64,
    pub msg_rate_out: f64,
    pub throughput_in: f64,
    pub throughput_out: f64,
    pub backlog: i64,
    pub producers: i64,
    pub consumers: i64,
    pub captured_at: i64,
}

// ========== 拓扑 ==========

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyBroker {
    pub name: String,
    /// 该 broker 承载的 topic 全路径；归属不可得时为空数组。
    #[serde(default)]
    pub topics: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyTopic {
    /// tenant/namespace/topic
    pub name: String,
    pub tenant: String,
    pub namespace: String,
    pub persistent: bool,
    #[serde(default)]
    pub partition_names: Vec<String>,
    #[serde(default)]
    pub owner_brokers: Vec<String>,
    #[serde(default)]
    pub subscriptions: Vec<String>,
    #[serde(default)]
    pub producers: i64,
    #[serde(default)]
    pub consumers: i64,
    #[serde(default)]
    pub msg_rate_in: f64,
    #[serde(default)]
    pub msg_rate_out: f64,
    #[serde(default)]
    pub backlog_size: i64,
}

/// 与渲染层 `ClusterTopology` 契约一致：brokers 按 topic 的 ownerBrokers 反向聚合，
/// `ownership_source` 明确告诉界面这是真实归属（brokerStats）、单 broker 推断
/// （singleBroker）还是拿不到（none），不编造全连接图。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterTopology {
    #[serde(default)]
    pub brokers: Vec<TopologyBroker>,
    #[serde(default)]
    pub topics: Vec<TopologyTopic>,
    #[serde(default)]
    pub ownership_source: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyLimits {
    pub max_namespaces: Option<i64>,
    pub max_topics: Option<i64>,
}

// ========== 策略 ==========

/// 命名空间积压配额的一条。`type` / `policy` 按 broker 原文保留：
/// 以后 broker 加新枚举时界面显示陌生值，比塞进已知三值更接近事实。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceBacklogQuota {
    #[serde(rename = "type", default)]
    pub quota_type: String,
    #[serde(default)]
    pub limit_size_bytes: i64,
    #[serde(default)]
    pub limit_time_seconds: i64,
    #[serde(default)]
    pub policy: String,
}

/// 限速折叠：broker 三种限速的键名互不相同，统一成 msg/byte/period，
/// 原始体留在 raw 里，写回时再由字段表还原各自形状。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceRateLimit {
    pub msg_per_period: f64,
    pub byte_per_period: f64,
    pub period_in_seconds: Option<f64>,
    #[serde(default)]
    pub raw: Value,
}

/// 命名空间策略的折叠视图。字段与 `src/shared/types.ts` 的 NamespacePolicyView 逐项对齐，
/// 顺序也按那份类型排，便于对照。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespacePolicyView {
    #[serde(default)]
    pub message_ttl_seconds: Option<i64>,
    #[serde(default)]
    pub subscription_expiration_time_minutes: Option<i64>,
    #[serde(default)]
    pub retention_time_in_minutes: Option<i64>,
    #[serde(default)]
    pub retention_size_in_mb: Option<i64>,
    #[serde(default)]
    pub deduplication_enabled: Option<bool>,
    #[serde(default)]
    pub deduplication_snapshot_interval_seconds: Option<i64>,
    #[serde(default)]
    pub backlog_quotas: Vec<NamespaceBacklogQuota>,
    #[serde(default)]
    pub max_producers_per_topic: Option<i64>,
    #[serde(default)]
    pub max_consumers_per_topic: Option<i64>,
    #[serde(default)]
    pub max_consumers_per_subscription: Option<i64>,
    #[serde(default)]
    pub max_unacked_messages_per_consumer: Option<i64>,
    #[serde(default)]
    pub max_unacked_messages_per_subscription: Option<i64>,
    #[serde(default)]
    pub max_subscriptions_per_topic: Option<i64>,
    #[serde(default)]
    pub max_topics_per_namespace: Option<i64>,
    #[serde(default)]
    pub compaction_threshold: Option<i64>,
    #[serde(default)]
    pub schema_validation_enforced: Option<bool>,
    #[serde(default)]
    pub schema_compatibility_strategy: Option<String>,
    #[serde(default)]
    pub schema_auto_update_strategy: Option<String>,
    #[serde(default)]
    pub allow_auto_update_schema: Option<bool>,
    #[serde(default)]
    pub encryption_required: Option<bool>,
    #[serde(default)]
    pub subscription_types_enabled: Vec<String>,
    #[serde(default)]
    pub subscription_auth_mode: Option<String>,
    #[serde(default)]
    pub replication_clusters: Vec<String>,
    #[serde(default)]
    pub allowed_clusters: Vec<String>,
    #[serde(default)]
    pub resource_group_name: Option<String>,
    #[serde(default)]
    pub dispatch_rate: Option<NamespaceRateLimit>,
    #[serde(default)]
    pub subscription_dispatch_rate: Option<NamespaceRateLimit>,
    #[serde(default)]
    pub subscribe_rate: Option<NamespaceRateLimit>,
    #[serde(default)]
    pub publish_rate: Option<NamespaceRateLimit>,
    #[serde(default)]
    pub replicator_dispatch_rate: Option<NamespaceRateLimit>,
    /// 能清除的字段由字段表给出（哪一端有 DELETE 端点），界面不再自己判断
    #[serde(default)]
    pub clearable_fields: Vec<String>,
    /// 整份原始 Policies：折叠表之外的字段靠它看全
    #[serde(default)]
    pub raw: Value,
}

/// topic 级策略端点读不出来的原因（老 broker 缺端点 / 未开启 topic 级策略）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyUnavailable {
    pub field: String,
    pub reason: String,
}

/// topic 级策略视图：broker 不返回整份对象，一个字段一条端点，这里是 N 条 GET 拼出来的。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicPolicyView {
    #[serde(default)]
    pub topic_name: String,
    #[serde(default)]
    pub persistent: bool,
    #[serde(default)]
    pub retention_time_in_minutes: Option<i64>,
    #[serde(default)]
    pub retention_size_in_mb: Option<i64>,
    #[serde(default)]
    pub message_ttl_seconds: Option<i64>,
    #[serde(default)]
    pub deduplication_enabled: Option<bool>,
    #[serde(default)]
    pub max_unacked_messages_per_consumer: Option<i64>,
    #[serde(default)]
    pub max_unacked_messages_per_subscription: Option<i64>,
    #[serde(default)]
    pub clearable_fields: Vec<String>,
    #[serde(default)]
    pub unavailable: Vec<PolicyUnavailable>,
    #[serde(default)]
    pub raw: Value,
}

// ========== 消息 ==========

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub message_id: String,
    pub topic_name: String,
    #[serde(default)]
    pub producer_name: String,
    #[serde(default)]
    pub publish_time: i64,
    #[serde(default)]
    pub event_time: i64,
    #[serde(default)]
    pub properties: BTreeMap<String, String>,
    #[serde(default)]
    pub data: String,
    pub partition_key: Option<String>,
    #[serde(default)]
    pub redelivery_count: u32,
    /// 超出确认窗口被淘汰后为 false
    #[serde(default = "default_true")]
    pub ackable: bool,
    #[serde(default)]
    pub ack_seq: Option<u64>,
    #[serde(default = "zero_i64")]
    pub data_bytes: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageBatch {
    pub session_id: String,
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEndEvent {
    pub session_id: String,
    pub reason: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumeOptions {
    pub cluster_id: String,
    pub topic: String,
    pub subscription: String,
    #[serde(default)]
    pub subscription_type: String,
    #[serde(default)]
    pub initial_position: String,
    #[serde(default)]
    pub auto_ack: bool,
    #[serde(default)]
    pub max_messages: i64,
    #[serde(default)]
    pub receiver_queue_size: Option<i64>,
    #[serde(default)]
    pub ack_timeout_ms: Option<i64>,
    #[serde(default)]
    pub n_ack_redeliver_timeout_ms: Option<i64>,
    #[serde(default)]
    pub consumer_name: Option<String>,
    /// 发起会话的界面实例标识：多页签指向同一 topic 时，认领只能动自己名下的会话
    #[serde(default)]
    pub owner_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendOptions {
    pub cluster_id: String,
    pub topic: String,
    pub message: String,
    #[serde(default)]
    pub properties: BTreeMap<String, String>,
    pub partition_key: Option<String>,
    pub key: Option<String>,
    #[serde(default)]
    pub event_time: Option<i64>,
    #[serde(default)]
    pub deliver_after_ms: Option<i64>,
}

// ========== 模板 ==========

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateVariable {
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageTemplate {
    pub id: String,
    pub cluster_id: String,
    /// 空串表示通用模板
    pub topic_uri: String,
    pub name: String,
    pub body: String,
    #[serde(default)]
    pub variables: Vec<TemplateVariable>,
    #[serde(default)]
    pub properties: BTreeMap<String, String>,
    #[serde(default)]
    pub producer_options: Value,
    #[serde(default)]
    pub schema_mode: String,
    pub schema_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendHistory {
    pub id: i64,
    pub cluster_id: Option<String>,
    pub topic_uri: String,
    pub template_id: Option<String>,
    pub template_name: String,
    pub body_preview: String,
    /// 全文留存开启时落库的完整正文；没开或超上限时为 None
    #[serde(default)]
    pub body_full: Option<String>,
    pub body_bytes: i64,
    pub message_count: i64,
    pub message_id: Option<String>,
    pub status: String,
    pub error_message: Option<String>,
    pub created_at: String,
}

// ========== 告警 ==========

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertRule {
    pub id: String,
    pub cluster_id: String,
    pub name: String,
    pub enabled: bool,
    /// cluster / namespace / topic
    pub scope: String,
    #[serde(default)]
    pub tenant: String,
    #[serde(default)]
    pub namespace: String,
    #[serde(default)]
    pub topic: String,
    pub persistent: bool,
    pub metric: String,
    /// gt / gte / lt / lte
    pub comparator: String,
    pub threshold: f64,
    pub consecutive: i64,
    pub notify: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertEvent {
    pub id: i64,
    pub rule_id: String,
    pub cluster_id: String,
    pub rule_name: String,
    pub scope_label: String,
    pub metric: String,
    pub comparator: String,
    pub threshold: f64,
    pub value: f64,
    pub last_value: f64,
    /// firing / resolved
    pub state: String,
    pub message: String,
    pub fired_at: i64,
    pub last_seen_at: i64,
    pub resolved_at: Option<i64>,
    pub acked_at: Option<i64>,
}

// ========== 巡检 ==========

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckLevel {
    Crit,
    Warn,
    Ok,
    /// 没跑到（集群连不上、采样被截断）——默认值，因为「没结论」不该冒充「正常」
    #[default]
    Skip,
}

impl CheckLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Crit => "crit",
            Self::Warn => "warn",
            Self::Ok => "ok",
            Self::Skip => "skip",
        }
    }
}

/// 一条检查项。字段与 `InspectionCheck` 逐项对齐：
/// `summary` 是一行结论，`detail` 是证据行（只在展开态与导出文件里出现）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionCheck {
    pub key: String,
    pub title: String,
    pub level: String,
    pub summary: String,
    #[serde(default)]
    pub detail: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
}

impl InspectionCheck {
    pub fn new(key: &str, title: &str, level: CheckLevel, summary: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            title: title.into(),
            level: level.as_str().into(),
            summary: summary.into(),
            detail: Vec::new(),
            suggestion: None,
        }
    }

    pub fn detail(mut self, lines: Vec<String>) -> Self {
        self.detail = lines;
        self
    }

    pub fn suggestion(mut self, text: impl Into<String>) -> Self {
        self.suggestion = Some(text.into());
        self
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionTotals {
    #[serde(default)]
    pub ok: i64,
    #[serde(default)]
    pub warn: i64,
    #[serde(default)]
    pub crit: i64,
    #[serde(default)]
    pub skip: i64,
}

/// 采样到的规模。截断必须显式报出来：「没发现高积压」与「只看了前 60 个 topic，
/// 里面没有高积压」是两句话。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionScope {
    #[serde(default)]
    pub tenants: i64,
    #[serde(default)]
    pub namespaces_seen: i64,
    #[serde(default)]
    pub topics_seen: i64,
    #[serde(default)]
    pub topics_sampled: i64,
    #[serde(default)]
    pub max_namespaces: i64,
    #[serde(default)]
    pub max_topics: i64,
    #[serde(default)]
    pub truncated: bool,
}

/// 判定的六个数。默认值来自 `shared/inspection-caliber.ts`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InspectionThresholds {
    pub backlog_warn: f64,
    pub backlog_crit: f64,
    pub unacked_warn: f64,
    pub rate_ratio: f64,
    pub rate_min_in: f64,
    pub detail_top_n: f64,
}

impl Default for InspectionThresholds {
    fn default() -> Self {
        Self {
            backlog_warn: 10_000.0,
            backlog_crit: 1_000_000.0,
            unacked_warn: 5_000.0,
            rate_ratio: 3.0,
            rate_min_in: 10.0,
            detail_top_n: 8.0,
        }
    }
}

impl InspectionThresholds {
    /// 明细最多列几条；小数向下取整，至少一条。
    pub fn top_n(&self) -> usize {
        (self.detail_top_n.floor() as usize).max(1)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionReport {
    /// 落库用的行标识；前端不读这一格
    #[serde(default)]
    pub id: String,
    pub cluster_id: String,
    pub cluster_name: String,
    pub generated_at: String,
    #[serde(default)]
    pub version: Option<String>,
    pub scope: InspectionScope,
    pub checks: Vec<InspectionCheck>,
    pub totals: InspectionTotals,
    /// 这份报告实际用的口径：阈值后来被改过，老报告仍解释得清当时为什么判红
    #[serde(default)]
    pub thresholds: Option<InspectionThresholds>,
    /// manual / scheduled；前端的历史行会读
    #[serde(default)]
    pub source: String,
    /// 导出文本。库里那份原文优先，重渲染会换掉当时的文案
    #[serde(default)]
    pub markdown: String,
}

impl InspectionReport {
    pub fn recompute_totals(&mut self) {
        let mut totals = InspectionTotals::default();
        for check in &self.checks {
            match check.level.as_str() {
                "crit" => totals.crit += 1,
                "warn" => totals.warn += 1,
                "ok" => totals.ok += 1,
                _ => totals.skip += 1,
            }
        }
        self.totals = totals;
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionSchedule {
    pub cluster_id: String,
    pub enabled: bool,
    pub interval_minutes: i64,
    pub notify_on_crit: bool,
    pub last_run_at: Option<String>,
    pub last_error: Option<String>,
    pub last_notified_crit: i64,
    pub updated_at: String,
}

// ========== 通知 ==========

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub security: String,
    pub username: String,
    pub password_enc: Option<String>,
    pub from_address: String,
    pub from_name: String,
    pub allow_self_signed: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyChannel {
    pub id: String,
    pub name: String,
    /// wecom / dingtalk / feishu / webhook / email
    pub kind: String,
    pub url_enc: String,
    pub secret_enc: Option<String>,
    pub mail_profile_id: Option<String>,
    #[serde(default)]
    pub recipients: String,
    pub enabled: bool,
    #[serde(default)]
    pub events: Vec<String>,
    pub min_level: String,
    pub timeout_ms: i64,
    pub rate_per_minute: i64,
    pub last_sent_at: Option<String>,
    pub last_error: Option<String>,
    pub fail_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyDelivery {
    pub id: i64,
    pub channel_id: String,
    pub channel_name: String,
    pub event_kind: String,
    pub level: String,
    pub ok: bool,
    pub skipped: bool,
    pub message: String,
    pub created_at: String,
}

// ========== 设置与日志 ==========

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub truncate_length: i64,
    pub auto_refresh: bool,
    pub refresh_interval_seconds: i64,
    pub font_size: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "light".into(),
            truncate_length: 50,
            auto_refresh: true,
            refresh_interval_seconds: 30,
            font_size: "large".into(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationLog {
    pub id: i64,
    pub cluster_id: Option<String>,
    pub action: String,
    pub resource_type: String,
    pub resource_id: Option<String>,
    pub resource_name: Option<String>,
    pub details: Option<String>,
    pub result: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broker_tenant_detail_without_name_deserializes() {
        // 实测 Pulsar 3.3.9：GET /admin/v2/tenants/public 不含 name
        let tenant: Tenant =
            serde_json::from_str(r#"{"adminRoles":[],"allowedClusters":["standalone"]}"#).unwrap();
        assert!(tenant.name.is_empty());
        assert_eq!(tenant.allowed_clusters, vec!["standalone"]);
    }

    #[test]
    fn broker_cluster_detail_without_name_deserializes() {
        // GET /admin/v2/clusters/standalone 只返回 serviceUrl / brokerServiceUrl
        let info: ClusterInfo = serde_json::from_str(
            r#"{"serviceUrl":"pulsar://localhost:6650","brokerServiceUrl":"pulsar://localhost:6650"}"#,
        )
        .unwrap();
        assert!(info.name.is_empty());
        assert_eq!(info.service_url, "pulsar://localhost:6650");
    }
}
