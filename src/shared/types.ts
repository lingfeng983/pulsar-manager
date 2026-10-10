// 主进程、preload、渲染进程共用的领域类型与 IPC 契约。
//
// 这些类型此前在 src/preload.ts、src/renderer/types/index.ts、
// src/main/services/http-client.ts 三处各写一份，字段还互相不一致（同一个
// TopicStats 在一处必填、另一处可选、第三处直接缺字段），改接口时极易漏改。
// 这里给出唯一的规范定义，三侧统一引用。
//
// 收敛规则：
// 1. 字段并集取全，避免任何一侧丢字段；
// 2. 主进程从 Pulsar Admin API 解析出的"额外字段"标为可选——主进程写入时
//    仍然给全，渲染进程读取时不假设一定存在；
// 3. 字面量联合优先于宽泛 string（如 status / result），保留更强的约束。

// ========== 通用 IPC 响应包 ==========

export interface APIResponse<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
}

// ========== 集群与隧道配置 ==========

// 已持久化的集群配置，id 必然存在
export interface ClusterConfig {
    id: string;
    name: string;
    serviceUrl: string;
    webServiceUrl?: string;
    authPlugin?: string;
    // authParams / tlsTrustCerts 属于凭据，只用于写入（新增、更新时提交明文）。
    // 主进程读取集群列表时不会回传凭据，只回传下面两个"是否已配置"的布尔标记。
    authParams?: string;
    tlsEnabled?: boolean;
    tlsTrustCerts?: string;
    hasAuthParams?: boolean;
    hasTlsTrustCerts?: boolean;
    useSshTunnel?: boolean;
    sshConfigId?: string;
    ssh?: SSHTunnelSummary;
    adminApiTimeout?: number;
    status?: 'connected' | 'disconnected' | 'warning';
    version?: string;
    createdAt?: string;
    updatedAt?: string;
}

// 新增/测试连接时提交的集群配置，此时还没有 id
export type ClusterConfigDraft = Omit<ClusterConfig, 'id'> & {id?: string};

export interface SSHConfig {
    // 已落库的隧道行 id；不带表示新建。测试通过后渲染层会把它回填到表单，
    // 避免"测一次留一条、保存再留一条"的孤儿配置。
    id?: string;
    host: string;
    port?: number;
    username: string;
    authType: 'password' | 'privateKey';
    password?: string;
    privateKey?: string;
    passphrase?: string;
    remoteHost?: string;
    remoteAdminPort?: number;
    remoteBrokerPort?: number;
}

// 随集群列表下发的隧道摘要：凭据一律不回传，只给"是否已配置"的标记。
export interface SSHTunnelSummary {
    host: string;
    port?: number;
    username: string;
    authType: 'password' | 'privateKey';
    hasPassword?: boolean;
    hasPrivateKey?: boolean;
    remoteHost?: string;
    remoteAdminPort?: number;
    remoteBrokerPort?: number;
    // 当前是否已有活的本地端口转发
    tunnelActive?: boolean;
}

export interface SSHTunnel {
    id: string;
    host: string;
    port: number;
    username: string;
    authType: 'password' | 'privateKey';
    status?: 'connected' | 'disconnected' | 'error';
    localAdminPort?: number;
    localBrokerPort?: number;
    remoteHost?: string;
    remoteAdminPort?: number;
    remoteBrokerPort?: number;
}

// ========== 资源 ==========

export interface Tenant {
    name: string;
    adminRoles: string[];
    allowedClusters: string[];
}

export interface Namespace {
    name: string;
    tenant: string;
    clusters: string[];
    replicationClusters: string[];
}

export interface Topic {
    // 形如 tenant/ns/topic（已去掉 persistent:// 前缀）
    name: string;
    persistent: boolean;
    // 原始 topicUri，分区 topic 时为基名
    topicUri: string;
    // 实测：命名空间与租户级列表把分区 topic 逐分区列出（...-partition-0、-1...），
    // 这里折叠回基名，因此分区 URI 列表不需要额外请求即为真值；
    // 长度即分区数，非分区 topic 为空数组。
    partitions: string[];
}

// Topic 配置：主进程按实测可用的端点拼装。
// 注意 `GET {topic}/info` 在 broker 上并不存在（实测 404），所以配置值来自
// /partitions 元数据、topic 级 retention、permissions 与 /stats 里的生效值；
// 取不到的字段保持 undefined，而不是回退成 0 或空串冒充"已配置"。
export interface TopicConfig {
    // tenant/ns/topic
    topicName: string;
    persistent: boolean;
    // 分区 URI 列表，长度即分区数
    partitions: string[];
    ownerBrokers: string[];
    // topic 级覆盖，broker 未设置该覆盖时为 undefined（此时生效值来自命名空间/broker）
    retentionTimeInMinutes?: number;
    retentionSizeInMB?: number;
    permissions?: Record<string, string[]>;
    // 以下取自 stats / partitioned-stats，是实际生效值，通常是命名空间或 broker 默认
    backlogQuotaLimitSize?: number;
    backlogQuotaLimitTime?: number;
    deduplicationEnabled?: boolean;
}

// 只有这两个策略在本 broker 上有 topic 级写入口（POST {topic}/retention），
// 分区数走 PUT {topic}/partitions。其余字段没有 topic 级端点，
// 收进 patch 会被拒绝，避免表单静默丢数据。
export interface TopicConfigPatch {
    retentionTimeInMinutes?: number;
    retentionSizeInMB?: number;
    numPartitions?: number;
}

// ========== 统计 ==========
//
// 下列类型描述的是主进程归一化之后的形状。Admin API v2 的 `/stats` 原始响应
// 与之并不一一对应，实测差异：生产者列表叫 `publishers` 且只有入向速率，
// 消费者挂在 `subscriptions[sub].consumers` 下，订阅对象本身没有 name，
// 顶层也没有 name / numPartitions 字段。归一化集中在 getTopicStats 一处做，
// 渲染层因此可以稳定依赖这些字段。

export interface SubscriptionStats {
    name: string;
    msgBacklog: number;
    // 积压字节数（API 的 backlogSize）
    backlogSize: number;
    msgRateExpired: number;
    consumerCount: number;
    unackedMessages: number;
    // exclusive / shared / failover / key_shared / None
    type: string;
    blockedSubscriptionOnUnackedMsgs?: boolean;
    lastExpireTimestamp?: number;
    lastConsumedFlowTimestamp?: number;
    msgRateOut?: number;
    msgThroughputOut?: number;
    durable?: boolean;
}

export interface ProducerStats {
    producerId: number;
    producerName: string;
    connected: boolean;
    // 生产者的速率是入向的（它往 topic 写消息）
    msgRateIn: number;
    msgThroughputIn: number;
    avgMsgSize?: number;
    address?: string;
    connectedSince?: string;
    clientVersion?: string;
}

export interface ConsumerStats {
    consumerName: string;
    connected: boolean;
    msgRateOut: number;
    msgThroughputOut?: number;
    msgRateRedeliver?: number;
    unackedMessages: number;
    availablePermits?: number;
    blockedConsumerOnUnackedMsgs?: boolean;
    address?: string;
    connectedSince?: string;
    clientVersion?: string;
    // 该消费者所属订阅，用于在扁平列表里区分来源
    subscription: string;
}

export interface TopicStats {
    // tenant/ns/topic
    name: string;
    persistent: boolean;
    msgRateIn: number;
    msgRateOut: number;
    msgThroughputIn: number;
    msgThroughputOut: number;
    storageSize: number;
    backlogSize: number;
    producers: ProducerStats[];
    consumers: ConsumerStats[];
    subscriptions: Record<string, SubscriptionStats>;
    // 分区 URI 列表，长度即分区数：非分区 topic 为空数组。
    // 分区 topic 的 /stats 不存在（实测 404），主进程改读 /partitioned-stats 并以
    // 其 partitions 键集合填这里。
    partitions: string[];
    // 承载该 topic（或其某个分区）的 broker，实测为 `host:port`，
    // 与 /admin/v2/brokers 的取值一致。分区 topic 的分区可能落在不同 broker 上，
    // 所以是列表而不是单值。
    ownerBrokers: string[];
    deduplicationStatus?: string;
    backlogQuotaLimitSize?: number;
    backlogQuotaLimitTime?: number;
    avgMsgSize?: number;
}

export interface BrokerInfo {
    activeBrokers: string[];
    allBrokers: string[];
}

export interface AggregatedStats {
    totalTopics: number;
    totalPartitions: number;
    totalSubscriptions: number;
    totalProducers: number;
    totalConsumers: number;
    totalMsgRateIn: number;
    totalMsgRateOut: number;
    totalThroughputIn: number;
    totalThroughputOut: number;
    totalBacklog: number;
}

export interface NamespaceStats {
    topicCount: number;
    subscriptionCount: number;
    producerCount: number;
    consumerCount: number;
    totalMsgRateIn: number;
    totalMsgRateOut: number;
    totalThroughputIn: number;
    totalThroughputOut: number;
    totalBacklog: number;
}

// ========== 消息 ==========

// 收发全部走原生 pulsar-client：admin REST 上没有 send / peek 路由。
// 载荷必须是纯 JSON（sandbox 的 preload 收不了类实例），因此 data 一律 base64。
export interface Message {
    messageId: string;
    topicName: string;
    producerName: string;
    publishTime: number;
    eventTime: number;
    properties: Record<string, string>;
    data: string;
    partitionKey?: string;
    redeliveryCount?: number;
}

// 与主进程的 TopicPathSchema / SubscriptionPathSchema 一一对应
export interface TopicPathParams {
    clusterId: string;
    tenant: string;
    namespace: string;
    topic: string;
    persistent: boolean;
}

export interface SubscriptionPathParams extends TopicPathParams {
    subscription: string;
}

export interface MessageSendParams extends TopicPathParams {
    message: string;
    properties?: Record<string, string>;
}

export interface ConsumeStartParams extends SubscriptionPathParams {
    subscriptionType: 'Exclusive' | 'Shared' | 'Failover' | 'Key_Shared';
    initialPosition: 'Latest' | 'Earliest';
    autoAck: boolean;
    // 0 表示不限条数，一直收到手动停止为止
    maxMessages?: number;
}

export interface ReadStartParams extends TopicPathParams {
    from: 'earliest' | 'latest' | 'timestamp';
    timestamp?: number;
    maxMessages?: number;
}

export interface MessageBatch {
    sessionId: string;
    messages: Message[];
}

// 会话可能自己结束（收满 maxMessages 或循环报错），不告诉渲染端它就会一直显示运行中。
export type SessionEndReason = 'completed' | 'stopped' | 'error';

export interface SessionEndEvent {
    sessionId: string;
    reason: SessionEndReason;
    detail?: string;
}

// 主进程 → 渲染进程的推送通道名（preload 与 ipc/stream 共用，避免两处各写一份字面量）
export const MESSAGE_STREAM_CHANNELS = {
    consumeBatch: 'msg:consume-batch',
    readBatch: 'msg:read-batch',
    sessionEnd: 'msg:session-end',
} as const;

export const LOAD_TEST_CHANNEL = 'benchmark:progress' as const;

// ========== 快速压测 ==========

export type LoadTestCompression = 'None' | 'Zlib' | 'LZ4' | 'ZSTD' | 'SNAPPY';

// 一轮压测的输入。totalMessages 是总量（各生产者共用一条消息流，谁空闲谁取下一条），
// 不是每生产者的条数——按生产者平分总量时，分区快慢不一会被最慢的那条拖住。
export interface LoadTestParams {
    clusterId: string;
    tenant: string;
    namespace: string;
    topic: string;
    persistent: boolean;
    producers: number;
    totalMessages: number;
    messageSizeBytes: number;
    // 0 表示不限速，全速压
    ratePerSecond: number;
    maxInFlightPerProducer: number;
    batchingEnabled: boolean;
    compression: LoadTestCompression;
    // 开启后同一轮里并发消费，用于看端到端与消费侧吞吐
    consumeBacklog: boolean;
    subscription: string;
    // 消费会在 broker 上留下订阅与积压；勾选后运行结束退订，不留残留
    unsubscribeAfterRun: boolean;
}

export type LoadTestPhase = 'running' | 'completed' | 'stopped' | 'error';

// 发送确认延迟（客户端侧：发出到 broker 确认）。分位数来自蓄水池抽样，
// 界面必须标注抽样条数，否则用户会把它当成全量统计。
export interface LoadTestLatency {
    count: number;
    avgMs: number;
    minMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
}

export interface LoadTestProgress {
    runId: string;
    phase: LoadTestPhase;
    sent: number;
    failed: number;
    consumed: number;
    totalMessages: number;
    messageSizeBytes: number;
    producerCount: number;
    bytesSent: number;
    elapsedMs: number;
    msgPerSec: number;
    mbPerSec: number;
    latency: LoadTestLatency | null;
    // 终态原因（'stopped'/'error' 时给出）；单条发送失败的最新一条错误另放这里，
    // 因为几条失败不改变终态，但必须让用户看到失败原因
    error?: string;
    lastError?: string;
}

export interface LoadTestStartResult {
    runId: string;
    topic: string;
}

export interface BacklogInfo {
    messageCount: number;
    sizeInBytes: number;
}

// ========== 指标与拓扑 ==========

// 拓扑聚合规模上限：由调用方按场景收紧，服务端仍会与全局上限取较小值
export interface TopologyLimits {
    maxTenants?: number;
    maxNamespacesPerTenant?: number;
    maxTopicsPerNamespace?: number;
    maxTopics?: number;
}

// broker→topic 归属的来源，渲染层据此决定要不要标注"归属关系不可用"：
// - brokerStats：topic 的 stats / partitioned-stats 响应带了 ownerBroker，逐个真实归属；
// - singleBroker：集群只有一个 broker，全部 topic 必然落在它上面；
// - none：拿不到归属，ownerBrokers 一律为空，绝不猜。
export type TopicOwnershipSource = 'brokerStats' | 'singleBroker' | 'none';

export interface ClusterTopology {
    // brokers[].topics 由各 topic 的 ownerBrokers 反向聚合而来，归属不可用时为空数组
    brokers: Array<{
        name: string;
        topics: string[];
    }>;
    topics: Array<{
        name: string;
        tenant: string;
        namespace: string;
        persistent: boolean;
        // 分区 URI 列表，长度即分区数；非分区 topic 为空数组
        partitionNames: string[];
        ownerBrokers: string[];
        subscriptions: string[];
        producers: number;
        consumers: number;
        msgRateIn: number;
        msgRateOut: number;
        backlogSize: number;
    }>;
    ownershipSource: TopicOwnershipSource;
}

// ========== 操作日志 ==========

export interface OperationLog {
    id: number;
    // 集群被删除后写入的日志没有集群归属（cluster:delete 会写 null），
    // 表结构也允许 NULL，所以这里必须是可空的
    cluster_id: string | null;
    action: string;
    resource_type: string;
    resource_id?: string;
    resource_name?: string;
    details?: string | null;
    result: 'success' | 'failure';
    error_message?: string | null;
    created_at: string;
}

// ========== 应用配置（配置中心） ==========

// 界面与刷新相关的可持久化设置。每一项都必须被真实消费：
// truncateLength 用于消息列表正文截断，autoRefresh / refreshIntervalSeconds
// 是监控页的刷新节奏。加了字段不接线，就是又一个死设置。
export interface AppSettings {
    truncateLength: number;
    autoRefresh: boolean;
    refreshIntervalSeconds: number;
}

export interface ExportedSshConfig {
    host: string;
    port: number;
    username: string;
    authType: 'password' | 'privateKey';
    remoteHost?: string | null;
    remoteAdminPort?: number | null;
    remoteBrokerPort?: number | null;
}

// 导出文件里的集群条目：刻意没有 authParams / 密码 / 私钥，
// 明文导出文件不该携带凭据，导入后需用户在集群表单里补一次。
export interface ExportedClusterConfig {
    name: string;
    serviceUrl: string;
    webServiceUrl?: string | null;
    authPlugin?: string | null;
    tlsEnabled: boolean;
    adminApiTimeout: number;
    ssh?: ExportedSshConfig | null;
}

export interface ExportedShortcutConfig {
    version: 1;
    enabled: boolean;
    windows: Record<string, string | null>;
    mac: Record<string, string | null>;
}

export interface ConfigBundle {
    format: 'pulsar-manager-config';
    version: 1;
    settings: AppSettings;
    clusters: ExportedClusterConfig[];
    shortcuts?: ExportedShortcutConfig | null;
}

export interface ConfigImportResult {
    settingsApplied: boolean;
    clustersImported: number;
    clustersSkipped: string[];
    tunnelsImported: number;
    shortcutsApplied: boolean;
}

export interface ConfigMeta {
    appVersion: string;
    databasePath: string;
}

// ========== 插件（本地声明式扩展） ==========

export type PluginSource = 'official' | 'local';

// 压测预设里可填的那部分参数：目标（集群/租户/命名空间/topic）与订阅相关字段
// 刻意排除在外——预设不该替用户决定往哪个 topic 上打流量。
export interface BenchmarkPresetParams {
    producers: number;
    totalMessages: number;
    messageSizeBytes: number;
    ratePerSecond: number;
    maxInFlightPerProducer: number;
    batchingEnabled: boolean;
    compression: LoadTestCompression;
    consumeBacklog: boolean;
}

export interface BenchmarkPreset {
    name: string;
    description?: string;
    params: BenchmarkPresetParams;
}

export interface TopicTemplate {
    name: string;
    description?: string;
    persistent: boolean;
    partitions: number;
    namePrefix?: string;
}

export interface PluginContributions {
    benchmarkPresets?: BenchmarkPreset[];
    topicTemplates?: TopicTemplate[];
}

export interface PluginManifest {
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
    contributions: PluginContributions;
}

export interface PluginEntry extends PluginManifest {
    source: PluginSource;
    installed: boolean;
    enabled: boolean;
}

// 校验失败也要出现在界面上：静默丢掉一个装错的插件文件，用户只会以为"装了没反应"。
export interface PluginLoadError {
    file: string;
    reason: string;
}

export interface PluginListResult {
    entries: PluginEntry[];
    errors: PluginLoadError[];
    pluginsDir: string;
}
