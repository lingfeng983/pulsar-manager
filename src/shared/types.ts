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
    // 生产者的接入类型：ExclusiveMode / SharedMode / Peer 之类，broker 原样报什么就存什么；
    // 老版本 broker 不给这个字段，界面上按"未知"处理而不是硬造一个默认值
    accessMode?: string;
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
    // 订阅类型（exclusive/shared/failover/key_shared），消费者级字段优先、
    // 订阅级兜底，两级都没有就留给界面显示"未知"
    subscriptionType?: string;
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
    // 手动确认会话里主进程发的句柄：确认要拿它找回原生 Message 对象。
    // 不用 messageId 当键——批消息里多条的 id 字符串可能相同，会串消息。
    ackSeq?: number;
    // MessageId.serialize() 的 base64：绑定只有 deserialize，没有 fromString，
    // 想按 id 回放就必须把字节带出来。
    messageIdBytes?: string;
    // 超出可确认窗口被淘汰后为 false：界面据此提示"将由 broker 重投"而不是假装能确认
    ackable?: boolean;
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
    // 路由键 / 事件时间 / 延时投递这些逐条参数。消息浏览器的发送面板与工作台的
    // 单发用同一份，界面列出来的就是这里能传的，不会多出一个填不了也没生效的字段。
    options?: ProducerMessageOptions;
}

// 死信策略：原生绑定确认存在 ConsumerConfig.deadLetterPolicy。
// deadLetterTopic 给的是 topic 名，落到哪个 tenant/ns 由主进程按当前 topic 补全。
export interface DeadLetterConfig {
    topicName: string;
    maxRedeliverCount: number;
    initialSubscriptionName?: string;
}

export interface ConsumeStartParams extends SubscriptionPathParams {
    subscriptionType: 'Exclusive' | 'Shared' | 'Failover' | 'Key_Shared';
    initialPosition: 'Latest' | 'Earliest';
    autoAck: boolean;
    // 0 表示不限条数，一直收到手动停止为止
    maxMessages?: number;
    // 以下都是可选的，缺省沿用原生默认值——旧的三态面板不传也能继续工作。
    receiverQueueSize?: number;
    ackTimeoutMs?: number;
    nAckRedeliverTimeoutMs?: number;
    consumerName?: string;
    deadLetter?: DeadLetterConfig;
}

// 手动确认的按序号选条。seqs 为空 = 处理登记表里的全部（界面上的「全部确认」按钮）；
// cumulative 只对流式可累计的类型有意义，broker 拒绝时那句原生错误原样回给界面。
export interface ConsumerAckParams {
    sessionId: string;
    seqs: number[];
    cumulative?: boolean;
}

export interface ReadStartParams extends TopicPathParams {
    // recent = 回溯尾部：原生 Reader 没有"从末尾倒数 N 条"的锚点，broker 也没有
    // lastMessageId 的 REST 路由，主进程只能从 earliest 扫过去留最后 N 条，
    // 所以它带的是一次性扫描的量（recentCount），不是持续读取的上限（maxMessages）。
    // messageId = 按 ID 定位：同样是"没有锚点只能扫"，扫到那条就停（护栏同 recent）。
    from: 'earliest' | 'latest' | 'timestamp' | 'recent' | 'messageId';
    timestamp?: number;
    maxMessages?: number;
    recentCount?: number;
    messageId?: string;
}

// 偷看：一次性、不确认、不建会话。主进程给目标订阅临时挂一条 Shared 消费者
// 取几条就撤，关闭时未确认的消息全部回到积压，原订阅游标不动。
export interface PeekParams extends TopicPathParams {
    subscription: string;
    maxMessages?: number;
}

export interface PeekResult {
    messages: Message[];
    // 没偷到 / 撞超时 / 临时订阅没删干净——这句必须送到界面，静默空列表读起来像"topic 没消息"
    note?: string;
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

// ========== 报文模板与变量 ==========

// 模板正文里的占位符只允许出现在 JSON 字符串值内部，所以模板永远是合法 JSON，
// 编辑器能高亮、能格式化；解析时"整个值恰好是一个占位符"会替换整个值（保住
// 数字/布尔类型），否则做字符串插值。类型定义随引擎放在一起，避免两处各写一份。
export type {TemplateVariable} from './template-engine';
import type {TemplateVariable} from './template-engine';

export type TemplateSchemaMode = 'none' | 'inline' | 'broker';

export interface MessageTemplateBody {
    body: string;
    variables: TemplateVariable[];
    properties?: Record<string, string>;
    // 发送时的结构校验：'inline' 用 schemaJson（JSON Schema 子集，见
    // shared/json-schema-lite.ts）逐条校验解析后的正文；'broker' 想走 broker 注册的
    // schema，但原生客户端与 Admin REST 都没有"给一条报文做 schema 校验"的入口，
    // 发送路径遇到它会明确拒绝而不是假装校验过。缺省 'none' 不校验。
    schemaMode?: TemplateSchemaMode;
    schemaJson?: string;
}

// 落库后的模板行（渲染层看到的形状，字段名已从 snake_case 转过）。
export interface MessageTemplate extends MessageTemplateBody {
    id: string;
    clusterId: string;
    // '' 表示不绑定 topic 的通用模板
    topicUri: string;
    name: string;
    producerOptions?: ProducerOptions;
    schemaMode: TemplateSchemaMode;
    useCount: number;
    lastUsedAt?: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface MessageTemplateUpsertParams extends MessageTemplateBody {
    id?: string;
    clusterId: string;
    topicUri: string;
    name: string;
    producerOptions?: ProducerOptions;
    schemaMode: TemplateSchemaMode;
}

// 模板与会话配置的取数范围：不传 topicUri 拿该集群全部；传了拿「这个 topic 能用
// 的」，即该 topic 自己的加上通用条目（topic_uri = ''）。
export interface WorkbenchScopeParams {
    clusterId: string;
    topicUri?: string;
}

export interface WorkbenchCopyParams {
    id: string;
    // 留空由主进程按「原名 副本」生成，同作用域重名直接拒绝
    name?: string;
    topicUri?: string;
}

export interface ConsumerConfigCopyParams extends WorkbenchCopyParams {
    subscription?: string;
}

export interface SendHistoryListParams {
    clusterId: string;
    topicUri: string;
    limit?: number;
}

// ========== 生产者工作台 ==========

// 字段与原生 ProducerConfig / ProducerMessage 一一对应（pulsar-client 1.18 绑定实测）。
// 注意绑定里没有事务、没有 getStats、没有分区定向 API，所以这些不在选项里。
export interface ProducerOptions {
    producerName?: string;
    sendTimeoutMs: number;
    maxPendingMessages: number;
    blockIfQueueFull: boolean;
    batchingEnabled: boolean;
    batchingMaxMessages: number;
    batchingMaxPublishDelayMs: number;
    batchingMaxAllowedSizeInBytes?: number;
    compressionType: LoadTestCompression;
    chunkingEnabled: boolean;
    messageRoutingMode?: 'UseSinglePartition' | 'RoundRobinDistribution' | 'CustomPartition';
    hashingScheme?: 'Murmur3_32Hash' | 'BoostHash' | 'JavaStringHash';
    accessMode?: 'Shared' | 'Exclusive' | 'WaitForExclusive' | 'ExclusiveWithFencing';
    // 每条消息的固定路由键；不带则按消息自身字段决定
    partitionKey?: string;
    usePartitionKeyFromField?: boolean;
    partitionKeyField?: string;
    eventTimeMode: 'none' | 'now' | 'fromField' | 'fixed';
    eventTimeField?: string;
    eventTimeFixed?: number;
    delayMode: 'none' | 'deliverAfter' | 'deliverAt';
    deliverAfterMs?: number;
    deliverAt?: number;
    // 带 seed 时随机走可复现的 xorshift，预览与实发才能逐字节一致
    seed?: number;
}

export interface ProducerStartParams extends TopicPathParams {
    options: ProducerOptions;
}

export interface ProducerSessionInfo {
    sessionId: string;
    clusterId: string;
    topicUri: string;
    producerName: string;
    connected: boolean;
    flowRunning: boolean;
}

// 工作台自己统计的发送速率与延迟。名字不能叫 ProducerStats：那已经是 broker
// /stats 里单个生产者的结构，同名接口在同一个文件里会静默合并成一个大对象。
export interface ProducerRunStats {
    sessionId: string;
    sent: number;
    failed: number;
    bytesSent: number;
    elapsedMs: number;
    msgPerSec: number;
    mbPerSec: number;
    latency: LoadTestLatency | null;
    lastError?: string;
    flowRunning: boolean;
    // 终态原因（会话已被停止/出错结束时给出）
    error?: string;
}

// 逐条报文级别的参数：producer 的配置在 createProducer 时就定死了（原生绑定没有
// 提供修改入口），一条报文自己能动只有这几项，见 pulsar-client 的 ProducerMessage。
// 单列一个接口而不是从 ProducerOptions 里 Pick：工作台每次发送都要重新决定
// 「路由键取哪个字段」「事件时间取哪个字段」，这两个开关本就属于报文层。
export interface ProducerMessageOptions {
    partitionKey?: string;
    usePartitionKeyFromField?: boolean;
    partitionKeyField?: string;
    // 这几项故意留成可选而不是 'none' 默认：工作台不填表示"沿用建会话时的设置"，
    // 填了才覆盖。给它一个默认值等于把"没填"这个信息抹掉，回落就永远不生效。
    eventTimeMode?: 'none' | 'now' | 'fromField' | 'fixed';
    eventTimeField?: string;
    eventTimeFixed?: number;
    delayMode?: 'none' | 'deliverAfter' | 'deliverAt';
    deliverAfterMs?: number;
    deliverAt?: number;
    // 带 seed 时随机走可复现的 xorshift，预览与实发才能逐字节一致
    seed?: number;
}

export interface ProducerSendParams extends TopicPathParams {
    sessionId: string;
    template: MessageTemplateBody;
    // 一次点"发送"投几条（每条重新解析占位符）
    count: number;
    options?: ProducerMessageOptions;
    // 只用于发送历史那一行：这一批是哪个模板发的、模板叫什么名字
    templateName?: string;
    templateId?: string;
}

export interface ProducerSendResult {
    messageIds: string[];
    bytes: number;
    // 解析后超过 broker 单条上限时给出，界面提示而不是静默丢
    failures: {index: number; error: string}[];
    // 一次性发送收尾（flush → close）失败时给出：前面的 messageIds 仍然有效，
    // 但批量队列里的最后一段可能没走完，界面必须把这句单独说出来。
    closeError?: string;
}

export interface ProducerFlowParams {
    sessionId: string;
    template: MessageTemplateBody;
    // 只给发送历史用：留空表示内联报文
    templateName?: string;
    templateId?: string;
    // 0 = 不限速，全速投
    ratePerSecond: number;
    // 0 = 一直投到手动停止
    totalMessages: number;
    maxInFlight: number;
    stopOnError: boolean;
    options?: ProducerMessageOptions;
}

export interface ProducerSetRateParams {
    sessionId: string;
    ratePerSecond: number;
}

// 一次性单发（不建常驻会话）：给 TopicDetail 的轻量发送与新页面的"发一条试试"共用。
export interface ProducerSendOnceParams extends TopicPathParams {
    template: MessageTemplateBody;
    count: number;
    options?: ProducerOptions;
    // 同 ProducerSendParams：只写进发送历史，不参与发送本身
    templateName?: string;
    templateId?: string;
}

// ========== 消费者工作台 ==========

export interface ConsumerConfigDraft {
    subscriptionType: ConsumeStartParams['subscriptionType'];
    initialPosition: ConsumeStartParams['initialPosition'];
    autoAck: boolean;
    maxMessages: number;
    receiverQueueSize?: number;
    ackTimeoutMs?: number;
    nAckRedeliverTimeoutMs?: number;
    consumerName?: string;
    deadLetter?: DeadLetterConfig;
}

export interface ConsumerSessionConfig extends ConsumerConfigDraft {
    id: string;
    clusterId: string;
    topicUri: string;
    subscription: string;
    name: string;
    useCount: number;
    lastUsedAt?: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface ConsumerConfigUpsertParams extends ConsumerConfigDraft {
    id?: string;
    clusterId: string;
    topicUri: string;
    subscription: string;
    name: string;
}

export interface ConsumerSessionInfo {
    sessionId: string;
    clusterId: string;
    topicUri: string;
    subscription: string;
    consumerName?: string;
    subscriptionType: ConsumeStartParams['subscriptionType'];
    autoAck: boolean;
    received: number;
    pendingAcks: number;
}

// ========== Topic 的 broker Schema 注册表 ==========
//
// Admin REST /schemas 端点返回的 SchemaInfo。这是 broker 侧的「主题 schema」，
// 与模板发送时的内联 JSON Schema 校验（见 json-schema-lite）是两回事：
// 前者约束 broker 如何序列化/校验落到存储的报文，后者只是客户端发送前的自检。

// broker 认识的 schema 类型；NONE 或读不到视为该 topic 未注册 schema。
export type BrokerSchemaType = 'NONE' | 'STRING' | 'JSON' | 'AVRO' | 'PARQUET' | 'BSON';

export interface BrokerSchemaInfo {
    type: string;
    // 定义体：AVRO/JSON 是 schema 文本，STRING 通常为空，PARQUET/BSON 可能是内联描述
    schema?: string;
    properties?: Record<string, string>;
    // broker 侧的版本号（自增）与创建时间（毫秒时间戳）
    version?: number;
    timestamp?: number;
}

// schema 兼容性策略：新增/演化 schema 时 broker 用什么规则放行。
export type SchemaCompatibilityPolicy =
    | 'ALWAYS'
    | 'BACKWARD'
    | 'BACKWARD_TRANSITIVE'
    | 'FORWARD'
    | 'FORWARD_TRANSITIVE'
    | 'FULL'
    | 'FULL_TRANSITIVE'
    | 'NEVER';

// ========== 权限（ACL）==========

// broker 的 AuthAction 只有这两个值，字面量全小写。
export type PulsarAuthAction = 'produce' | 'consume';

// role -> 动作列表；broker 返回的就是这张 Map，未授权的角色不会出现在里面。
export type PermissionMap = Record<string, string[]>;

// ========== 发送历史 ==========

export interface SendHistoryEntry {
    id: number;
    clusterId?: string | null;
    topicUri: string;
    templateId?: string | null;
    templateName: string;
    bodyPreview: string;
    // 全文留存（配置中心开关）开启时落库的完整正文；没开、超过上限或老行为 null。
    // 只有它才能"原样重发"——正文前缀是截断过的，拿去重发只会发出一条半截报文。
    bodyFull?: string | null;
    bodyBytes: number;
    messageCount: number;
    messageId?: string | null;
    status: 'success' | 'failure';
    errorMessage?: string | null;
    createdAt: string;
}

// 主进程 → 渲染进程的推送通道名（preload 与 ipc/stream 共用，避免两处各写一份字面量）
export const MESSAGE_STREAM_CHANNELS = {
    consumeBatch: 'msg:consume-batch',
    readBatch: 'msg:read-batch',
    sessionEnd: 'msg:session-end',
    producerStats: 'msg:producer-stats',
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

// 界面字号四档；large 就是改版以来的默认尺寸，xlarge 在它之上再放大一档。
// 实际取值写在 index.css 的 --font-size-*（DOM 文字）和 renderer/utils/fontScale.ts
// 的基准表（antd 与图表文字），两处必须一致，否则界面与图表各按一套比例缩放。
export type FontSizeLevel = 'small' | 'medium' | 'large' | 'xlarge';

// 界面与刷新相关的可持久化设置。每一项都必须被真实消费：
// truncateLength 用于消息列表正文截断，autoRefresh / refreshIntervalSeconds
// 是监控页的刷新节奏，statusRefreshSeconds 是首页与侧边栏集群状态的轮询节奏。
// 加了字段不接线，就是又一个死设置。
export interface AppSettings {
    truncateLength: number;
    autoRefresh: boolean;
    refreshIntervalSeconds: number;
    fontSize: FontSizeLevel;
    statusRefreshSeconds: number;
    // 发送历史是否连带正文全文落库（单行上限 512KB），关掉就只留 400 字符前缀。
    sendHistoryFullBody: boolean;
    // 监控曲线是否落库；关掉后趋势图只剩本次会话的内存点。
    metricsSnapshotEnabled: boolean;
    // 快照保留天数，写入侧顺带按它清理旧行。
    metricsRetentionDays: number;
    // 告警引擎总开关：关掉就不挂定时器，规则留着也不会评估。
    alertEnabled: boolean;
    // 评估间隔（秒）。下限挡的是"每秒把全集群扫一遍"，上限 1 小时。
    alertCheckSeconds: number;
    // 已恢复事件的保留天数；未恢复的事件不受保留期约束，一直留到人确认或恢复。
    alertRetentionDays: number;
}

// ========== 监控时序快照 ==========

// 一次轮询采到的一组同刻数值。topicUri 为空串表示「集群总体」口径。
export interface MetricsSnapshot {
    clusterId: string;
    topicUri: string;
    msgRateIn: number;
    msgRateOut: number;
    throughputIn: number;
    throughputOut: number;
    backlog: number;
    producers: number;
    consumers: number;
    // epoch 毫秒
    capturedAt: number;
}

// 渲染层上报的采样点：不带 capturedAt，写入侧统一用主进程时钟。
export type MetricsSnapshotInput = Omit<MetricsSnapshot, 'capturedAt'>;

export interface MetricsSnapshotQuery {
    clusterId: string;
    // 空串 = 集群总体口径
    topicUri?: string;
    hours?: number;
    limit?: number;
}

// ========== 告警 ==========

export type AlertScope = 'cluster' | 'namespace' | 'topic';
export type AlertComparator = 'gt' | 'lt';
export type AlertEventState = 'firing' | 'resolved';

// 采样口径取自归一化后的 TopicStats / AggregatedStats，见 shared/alert-metrics.ts
// 里每个键的数据源与显示单位。
export type AlertMetricKey =
    | 'backlog'
    | 'msgRateIn'
    | 'msgRateOut'
    | 'throughputIn'
    | 'throughputOut'
    | 'storageSize'
    | 'producers'
    | 'consumers';

export interface AlertRule {
    id: string;
    clusterId: string;
    name: string;
    enabled: boolean;
    scope: AlertScope;
    // 定位三件套：scope 不是 topic/namespace 时用不到的项一律存空串，
    // 不用 NULL——空串是这套表里"该维度不参与定位"的既有约定。
    tenant: string;
    namespace: string;
    topic: string;
    persistent: boolean;
    metric: AlertMetricKey;
    comparator: AlertComparator;
    // 阈值存原生单位（条、条/秒、字节/秒、字节），显示换算见 alert-metrics
    threshold: number;
    // 连续命中多少轮才立案：一轮抖动不算告警
    consecutive: number;
    notify: boolean;
    createdAt: string;
    updatedAt: string;
}

// 新建与编辑共用：不带 id 就是新建（id 由主进程生成）。时间戳由主进程写。
// 'id' 必须一起 Omit 掉：留着 AlertRule 上那个必填 id 再交集一个可选 id，
// 得到的仍然是必填，"新建时不传 id"会编译不过。
export type AlertRuleUpsertParams = Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'> & {id?: string};

export interface AlertEvent {
    id: number;
    ruleId: string;
    clusterId: string;
    // 立案那一刻的规则名与作用域文本：规则后来改名、改阈值都不该改写历史
    ruleName: string;
    scopeLabel: string;
    metric: AlertMetricKey;
    comparator: AlertComparator;
    threshold: number;
    // 首次立案时的观测值与最近一轮的观测值（未恢复期间持续刷新）
    value: number;
    lastValue: number;
    state: AlertEventState;
    message: string;
    // 以下时间都是 epoch 毫秒：事件按时间范围清理与排序，数值比较不用解析字符串
    firedAt: number;
    lastSeenAt: number;
    resolvedAt?: number | null;
    ackedAt?: number | null;
}

export interface AlertEventQuery {
    clusterId?: string;
    state?: AlertEventState;
    limit?: number;
}

// 主进程 → 渲染进程的新告警推送（桌面通知之外的应用内提醒）。
// recovered 为真表示这是一条"已恢复"通知。
export interface AlertPush {
    kind: 'fired' | 'recovered';
    event: AlertEvent;
}

export const ALERT_EVENT_CHANNEL = 'alert:event' as const;

// 「试跑」一条规则的结果：主进程即时取一次数，判定与显示文本都在那边算好，
// 单位换算规则因此只有 shared/alert-metrics 那一份。
export interface AlertProbeResult {
    value: number;
    breached: boolean;
    message: string;
    valueText: string;
    thresholdText: string;
    metricLabel: string;
}

export interface PulsarWorkerState {
    enabled: boolean;
    // 每个 worker 节点自己报的 id/地址：函数跑在哪个节点上，出问题时第一个要看的就是这个
    nodes: PulsarWorkerNode[];
    // 未启用时这里写的是「为什么没启用」的人话原因，不是原始 404
    notice?: string;
}

export interface PulsarWorkerNode {
    workerId: string;
    workerHostname?: string;
    port?: number;
    isLeader?: boolean;
    // 坐标服务分配的编号，-1 通常意味着这个节点还没拿到 leader 身份
    assignmentOffset?: number;
}

export type PulsarInstanceStatus = 'running' | 'stopped' | 'error' | 'unknown';

export interface PulsarFunctionInstance {
    instanceId: number;
    status: PulsarInstanceStatus;
    error?: string;
    numRestarts?: number;
    workerId?: string;
}

// 一个函数/连接器的实例状态折叠成一行摘要：列表页要按实例总数与「有没有出错」着色，
// 逐个实例展开是详情页的事。
export interface PulsarRuntimeStatus {
    numInstances: number;
    running: number;
    stopped: number;
    error: number;
    instances: PulsarFunctionInstance[];
}

export type PulsarResourceKind = 'function' | 'sink' | 'source';

// 只列界面一定会展示的字段。broker 返回的 FunctionConfig 有几十个键，
// 全量映射的结果是一张没人读完的表；其余键原样留在 raw 里给详情抽屉。
export interface PulsarRuntimeConfig {
    kind: PulsarResourceKind;
    tenant: string;
    namespace: string;
    name: string;
    className?: string;
    // 包位置：function:// 是 worker 已存包的坐标，其余是本地路径或 http(s) 地址
    archive?: string;
    inputs?: string[];
    output?: string;
    logTopic?: string;
    parallelism?: number;
    processingGuarantee?: string;
    // 函数与连接器共用这套资源字段
    cpu?: number;
    ramMb?: number;
    diskMb?: number;
    autoAck?: boolean;
    timeoutMs?: number;
    // sink/source 特有的 topicToSerDeClassName / configs 等都只出现在 raw 里
    raw: Record<string, unknown>;
}

export interface PulsarRuntimeItem {
    config: PulsarRuntimeConfig;
    // 状态取不到（例如 worker 正在初始化）时为空，列表按「未知」显示而不是隐藏这一行
    status?: PulsarRuntimeStatus;
    stats?: PulsarFunctionStats;
}

export interface PulsarFunctionStats {
    received: number;
    processed: number;
    successfullyProcessed: number;
    unsuccessfullyProcessed: number;
    emitted: number;
    exceptions: number;
}

// 触发一次函数的结果：output 是 broker 原样返回的字符串，可能为空——
// 没有 output topic 的函数返回空是正常现象，不能当成失败。
export interface PulsarTriggerResult {
    output: string;
}

// 内置函数与内置连接器插件：新建表单的候选就来自这里，
// 让用户手抄 connector.class 全限定名是错的来源。
export interface PulsarBuiltinDefinition {
    kind: PulsarResourceKind;
    name: string;
    className: string;
    // 内置包坐标，创建时直接填给 archive 字段
    archive?: string;
    description?: string;
    // 内置连接器的配置项 schema（原始 JSON），详情抽屉里折叠展示
    configDefinition?: Record<string, unknown>;
    inputs?: unknown;
    multiDataInputs?: unknown;
    output?: unknown;
}

// 新建函数/连接器的表单载荷：主进程把它拼成 multipart 请求，
// 只带已填字段，未填的键根本不进请求体。
// 包只能是坐标（内置函数的 function://、worker 已存过的包、http(s) 地址）：
// 上传本地 jar 需要文件选择框与流式 multipart，这条实现路径在本机没有可对照的
// worker 可验，与其上一个测不出对错的入口，不如把坐标写清楚。
export interface PulsarRuntimeCreateParams {
    clusterId: string;
    kind: PulsarResourceKind;
    tenant: string;
    namespace: string;
    name: string;
    className: string;
    archive?: string;
    inputs?: string[];
    output?: string;
    logTopic?: string;
    parallelism?: number;
    cpu?: number;
    ramMb?: number;
    diskMb?: number;
    processingGuarantee?: string;
    // 连接器参数（sinkConfig/sourceConfig 的 configs 段）与函数的 userConfig，原样透传
    userConfig?: Record<string, unknown>;
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
