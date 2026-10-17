// 渲染层类型入口：跨进程共享的领域类型统一从 src/shared/types 转出，
// 这里只保留渲染层独有的视图类型。
export type {
    APIResponse,
    ClusterConfig,
    ClusterConfigDraft,
    SSHConfig,
    SSHTunnel,
    Tenant,
    Namespace,
    Topic,
    TopicConfig,
    TopicConfigPatch,
    TopicStats,
    BrokerSchemaInfo,
    BrokerSchemaType,
    SchemaCompatibilityPolicy,
    PulsarAuthAction,
    PermissionMap,
    MetricsSnapshot,
    MetricsSnapshotInput,
    MetricsSnapshotQuery,
    TopicOwnershipSource,
    SubscriptionStats,
    ProducerStats,
    ConsumerStats,
    BrokerInfo,
    AggregatedStats,
    Message,
    TopicPathParams,
    SubscriptionPathParams,
    MessageSendParams,
    ConsumeStartParams,
    ConsumerAckParams,
    ReadStartParams,
    MessageBatch,
    PeekParams,
    PeekResult,
    SessionEndEvent,
    BacklogInfo,
    TopologyLimits,
    ClusterTopology,
    OperationLog,
    LoadTestParams,
    LoadTestProgress,
    LoadTestLatency,
    LoadTestPhase,
    LoadTestCompression,
    FontSizeLevel,
    AppSettings,
    ConfigBundle,
    ConfigImportResult,
    ConfigMeta,
    ExportedClusterConfig,
    BenchmarkPreset,
    BenchmarkPresetParams,
    PluginEntry,
    PluginListResult,
    PluginLoadError,
    PluginSource,
    TopicTemplate,
    // 生产者 / 消费者工作台
    ConsumerConfigDraft,
    ConsumerConfigUpsertParams,
    ConsumerConfigCopyParams,
    ConsumerSessionConfig,
    ConsumerSessionInfo,
    DeadLetterConfig,
    MessageTemplate,
    MessageTemplateBody,
    MessageTemplateUpsertParams,
    ProducerFlowParams,
    ProducerMessageOptions,
    ProducerOptions,
    ProducerRunStats,
    ProducerSendOnceParams,
    ProducerSendParams,
    ProducerSendResult,
    ProducerSessionInfo,
    ProducerStartParams,
    SendHistoryEntry,
    SendHistoryListParams,
    TemplateSchemaMode,
    TemplateVariable,
    WorkbenchCopyParams,
    WorkbenchScopeParams,
    // 告警
    AlertComparator,
    AlertEvent,
    AlertEventQuery,
    AlertEventState,
    AlertMetricKey,
    AlertProbeResult,
    AlertPush,
    AlertRule,
    AlertRuleUpsertParams,
    AlertScope,
    // 函数与连接器
    PulsarBuiltinDefinition,
    PulsarFunctionInstance,
    PulsarFunctionStats,
    PulsarResourceKind,
    PulsarRuntimeConfig,
    PulsarRuntimeCreateParams,
    PulsarRuntimeItem,
    PulsarRuntimeStatus,
    PulsarTriggerResult,
    PulsarWorkerNode,
    PulsarWorkerState,
    // 命名空间策略
    NamespaceBacklogQuota,
    NamespaceBacklogQuotaValue,
    NamespacePolicyClearParams,
    NamespacePolicyField,
    NamespacePolicyScopeParams,
    NamespacePolicySetParams,
    NamespacePolicyView,
    NamespaceRateLimit,
    NamespaceRateValue,
    NamespaceRetentionValue,
} from '../../shared/types';

// 订阅
export interface Subscription {
    name: string;
    msgBacklog: number;
    consumers: Consumer[];
    type: 'Exclusive' | 'Failover' | 'Shared' | 'Key_Shared';
}

export interface Consumer {
    consumerName: string;
    availablePermits: number;
    connectedSince: string;
}

// 资源树节点
export interface ResourceTreeNode {
    key: string;
    title: string;
    type: 'cluster' | 'tenant' | 'namespace' | 'topic' | 'subscription';
    status?: 'connected' | 'disconnected' | 'warning';
    children?: ResourceTreeNode[];
    isLeaf?: boolean;
    clusterId?: string;
    tenant?: string;
    namespace?: string;
    topic?: string;
}
