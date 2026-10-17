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
    useK8sForward?: boolean;
    k8sConfigId?: string;
    k8s?: K8sForwardSummary;
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

// K8s 端口转发（kubectl port-forward）。与 SSH 隧道的区别只在"怎么把本地端口接到远端"：
// 这里不填跳板机与凭据，而是填 kubeconfig 里已有的上下文 + 命名空间 + 资源名，
// 认证完全交给 kubectl 自己。
export interface K8sForwardConfig {
    // 已落库的转发行 id；不带表示新建。测试通过后渲染层回填，避免留孤儿配置。
    id?: string;
    namespace: string;
    // kubectl 的资源标识，形如 service/pulsar-broker、statefulset/pulsar-broker、pod/xxx
    resource: string;
    context?: string;
    kubeconfigPath?: string;
    // kubectl 可执行文件；留空按 PATH 里的 kubectl
    kubectlPath?: string;
    // 转发到的远端端口。留空时按集群自身的 Admin / Broker 地址端口解析
    remoteAdminPort?: number;
    remoteBrokerPort?: number;
}

// 随集群列表下发的转发摘要。这里没有凭据字段——kubeconfig 才是凭据所在，
// 本表只存它的路径字符串，所以路径可以下发（表单要回填），而内容绝不读进库。
export interface K8sForwardSummary {
    namespace: string;
    resource: string;
    context?: string;
    kubeconfigPath?: string;
    kubectlPath?: string;
    remoteAdminPort?: number;
    remoteBrokerPort?: number;
    // 当前是否已有活的本地转发（kubectl 进程还在）
    forwardActive?: boolean;
}

export interface K8sForward {
    id: string;
    namespace: string;
    resource: string;
    context?: string;
    kubeconfigPath?: string;
    kubectlPath?: string;
    status?: 'connected' | 'disconnected' | 'error';
    localAdminPort?: number;
    localBrokerPort?: number;
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
// /partitions 元数据、permissions 与 /stats 里的生效值；
// 取不到的字段保持 undefined，而不是回退成 0 或空串冒充"已配置"。
//
// 保留策略、TTL 这类 topic 级覆盖不在这里读：它们各自是一条策略端点，
// 统一由 TopicPolicyView（topic-policy-api）给出，两条路径各读一份迟早对不上。
export interface TopicConfig {
    // tenant/ns/topic
    topicName: string;
    persistent: boolean;
    // 分区 URI 列表，长度即分区数
    partitions: string[];
    ownerBrokers: string[];
    permissions?: Record<string, string[]>;
    // 以下取自 stats / partitioned-stats，是实际生效值，通常是命名空间或 broker 默认
    backlogQuotaLimitSize?: number;
    backlogQuotaLimitTime?: number;
    deduplicationEnabled?: boolean;
}

// 这一条通道只改 topic 本体（分区数）。topic 级策略走 topic:policy:* 通道：
// 策略端点的语义是"设置/撤销覆盖"，与"留空表示不改"的补丁形状不是一回事。
export interface TopicConfigPatch {
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

// worker 按「jar / py / go 哪一个非空」推断函数的运行时，连接器没有这个概念（只有 NAR）。
// 界面上让用户直接说清楚，比让他猜该填哪个包字段强。
export type PulsarFunctionRuntime = 'JAVA' | 'PYTHON' | 'GO';

// 只列界面一定会展示的字段。broker 返回的 FunctionConfig 有几十个键，
// 全量映射的结果是一张没人读完的表；其余键原样留在 raw 里给详情抽屉。
export interface PulsarRuntimeConfig {
    kind: PulsarResourceKind;
    tenant: string;
    namespace: string;
    name: string;
    className?: string;
    // 包位置：函数取 jar / py / go 之一，连接器取 archive
    archive?: string;
    // 只有函数有运行时；worker 回什么就用什么，没回就由包字段反推
    runtime?: PulsarFunctionRuntime;
    inputs?: string[];
    // 函数的 output、来源的 topicName；连接器没有单一输出字段（目的地在 configs 里）
    output?: string;
    logTopic?: string;
    parallelism?: number;
    processingGuarantee?: string;
    // 函数与连接器共用 resources:{cpu,ram,disk}，broker 侧 ram/disk 是字节，这里统一折成 MB
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
// 包来源两档，界面只能选一档：archive 是 worker 自己取得到的坐标（内置插件的
// builtin://、包存储里的 function://、http(s) 地址），localPackagePath 是本机文件。
// 后者不需要先上传——注册请求自己就带 data 文件段，worker 落包并把坐标记进函数元数据。
export interface PulsarRuntimeCreateParams {
    clusterId: string;
    kind: PulsarResourceKind;
    tenant: string;
    namespace: string;
    name: string;
    // GO 运行时不需要入口类（worker 不校验），JAVA/PYTHON 少了它 worker 直接拒
    className?: string;
    archive?: string;
    // 与 archive 二选一：本机的包文件，注册请求里当 data 文件段发出去
    localPackagePath?: string;
    // 只有函数用；留空按 JAVA 处理（worker 自己也是这个默认）
    runtime?: PulsarFunctionRuntime;
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

// 文件选择对话框的返回：path 只在主进程用来读这个文件，
// 界面只显示 name 与 size——把整份内容跟着过一遍 IPC 没有读者。
export interface PickedArchiveFile {
    path: string;
    name: string;
    size: number;
}

// ========== 命名空间策略（Namespace Policies）==========

// broker 的 Policies 对象在命名上就是混的：message_ttl_in_seconds 是下划线，
// deduplicationEnabled 与 autoTopicCreationOverride 是驼峰，同一个对象里两种都有。
// 折叠层按 broker 实际发出的键名取值，不能按我们的偏好统一成驼峰再解析——
// 那样老 broker 的下划线字段会全部读成「未设置」，界面显示一片空白且没有任何报错。
export type NamespaceBacklogQuotaType = 'destination_storage' | 'message_age';

// broker 侧的三种超限处理策略。第三种的官方名字是 consumer_backlog_eviction，
// 不是 consumer_backpressure：拼错的值会被 Jackson 拒绝成 400，
// 而 400 的响应体里没有字段名提示，排查成本很高。
export type NamespaceBacklogRetentionPolicy =
    'producer_request_hold' | 'producer_exception' | 'consumer_backlog_eviction';

// 读取形状对未知枚举保持宽容：broker 以后新增配额类型或超限策略时，
// 界面显示陌生的原文，比把它塞进我们认识的三个值里更接近事实。
export interface NamespaceBacklogQuota {
    type: string;
    limitSizeBytes: number;
    // 仅 message_age 配额用到；0 表示不按时间限制
    limitTimeSeconds: number;
    policy: string;
}

// 限速三兄弟的字段名互不相同（dispatch 用 ...InMsg/...InByte + ratePeriodInSecond，
// subscribe 用 subscribeThrottlingRatePerConsumer，publish 根本没有周期），
// 所以折叠成统一形状、原始体留在 raw 里，写入时再按字段表还原各自形状。
// broker 用 -1 表示「不限制」而不是省略字段，这里保留原值。
export interface NamespaceRateLimit {
    msgPerPeriod: number;
    bytePerPeriod: number;
    periodInSeconds: number | null;
    raw: Record<string, unknown>;
}

// 写入载荷的对象形状。与读取形状刻意分开：写入不带 raw；
// 读取里 -1 与 period=null 是 broker 的表达方式，写入时由字段表翻译成各自的键名。
export interface NamespaceRetentionValue {
    // -1 = 无限保留
    timeInMinutes: number;
    sizeInMB: number;
}

export interface NamespaceBacklogQuotaValue {
    type: NamespaceBacklogQuotaType;
    limitSizeBytes: number;
    limitTimeSeconds: number;
    policy: NamespaceBacklogRetentionPolicy;
}

export interface NamespaceRateValue {
    msgPerPeriod: number;
    bytePerPeriod: number;
    // publish 速率没有周期概念，其余限速必填
    periodInSeconds?: number;
}

export interface NamespacePolicyView {
    messageTtlSeconds: number | null;
    subscriptionExpirationTimeMinutes: number | null;
    // -1 是 broker 的「无限保留」写法，与 null（未设置、沿用 broker 默认）不同
    retentionTimeInMinutes: number | null;
    retentionSizeInMB: number | null;
    deduplicationEnabled: boolean | null;
    deduplicationSnapshotIntervalSeconds: number | null;
    backlogQuotas: NamespaceBacklogQuota[];
    maxProducersPerTopic: number | null;
    maxConsumersPerTopic: number | null;
    maxConsumersPerSubscription: number | null;
    maxUnackedMessagesPerConsumer: number | null;
    maxUnackedMessagesPerSubscription: number | null;
    maxSubscriptionsPerTopic: number | null;
    maxTopicsPerNamespace: number | null;
    compactionThreshold: number | null;
    schemaValidationEnforced: boolean | null;
    schemaCompatibilityStrategy: string | null;
    schemaAutoUpdateStrategy: string | null;
    allowAutoUpdateSchema: boolean | null;
    encryptionRequired: boolean | null;
    subscriptionTypesEnabled: string[];
    subscriptionAuthMode: string | null;
    replicationClusters: string[];
    allowedClusters: string[];
    resourceGroupName: string | null;
    dispatchRate: NamespaceRateLimit | null;
    subscriptionDispatchRate: NamespaceRateLimit | null;
    subscribeRate: NamespaceRateLimit | null;
    publishRate: NamespaceRateLimit | null;
    replicatorDispatchRate: NamespaceRateLimit | null;
    // 能清除的字段由主进程的字段表给出（哪一端有 DELETE 端点），
    // 界面不再自己判断一遍——两处判断一定漂移，漂移的结果是清除按钮点了得到 405
    clearableFields: NamespacePolicyField[];
    // 整份原始 Policies：不在折叠表里的字段（offload、inactive topic、persistence、
    // delayed delivery 等）靠它在详情里看全，也让界面敢说「这里只列了常用项」
    raw: Record<string, unknown>;
}

// 可写字段。取值范围与单位随字段走（见 namespace-policy-api 的字段表），
// 数字/布尔/字符串/字符串数组/对象都可能出现，所以载荷里 value 保持 unknown，
// 由字段表逐字段校验并给出中文错误——写成一张 zod 联合会变成第二张字段表。
// retention 与 backlogQuota 是整对象写入：broker 的 POST 会整体替换这两个字段，
// 只发其中一个数字会把另一个悄悄清零，所以不单独开放 retentionTimeInMinutes。
export type NamespacePolicyField =
    | 'messageTtlSeconds'
    | 'subscriptionExpirationTimeMinutes'
    | 'retention'
    | 'deduplicationEnabled'
    | 'deduplicationSnapshotIntervalSeconds'
    | 'backlogQuota'
    | 'maxProducersPerTopic'
    | 'maxConsumersPerTopic'
    | 'maxConsumersPerSubscription'
    | 'maxUnackedMessagesPerConsumer'
    | 'maxUnackedMessagesPerSubscription'
    | 'maxSubscriptionsPerTopic'
    | 'maxTopicsPerNamespace'
    | 'compactionThreshold'
    | 'schemaValidationEnforced'
    | 'schemaCompatibilityStrategy'
    | 'schemaAutoUpdateStrategy'
    | 'allowAutoUpdateSchema'
    | 'encryptionRequired'
    | 'dispatchRate'
    | 'subscriptionDispatchRate'
    | 'subscribeRate'
    | 'publishRate'
    | 'replicatorDispatchRate'
    | 'replicationClusters';

export interface NamespacePolicyScopeParams {
    clusterId: string;
    tenant: string;
    namespace: string;
}

export interface NamespacePolicySetParams extends NamespacePolicyScopeParams {
    field: NamespacePolicyField;
    value: unknown;
}

export interface NamespacePolicyClearParams extends NamespacePolicyScopeParams {
    field: NamespacePolicyField;
    // 清除 backlogQuota 必须点名是哪一条配额（按存储 / 按消息年龄）
    quotaType?: string;
}

// ========== 命名空间策略批量同步 ==========

// 一次同步动作。skip 也要单独列出来：预览差异的价值就在于「哪些不会变、为什么不会变」，
// 只列会改的项会让人误以为其余项被静默清掉了。
export type NamespacePolicySyncAction = 'set' | 'clear' | 'skip';

export interface NamespacePolicySyncDelta {
    field: NamespacePolicyField;
    action: NamespacePolicySyncAction;
    // backlogQuota 一个端点下挂多条配额，逐条比对，所以差异也逐条
    quotaType?: string;
    // set 的载荷：形状与 namespace:policy:set 的 value 完全一致，执行阶段原样转发
    value?: unknown;
    // skip 必填：说明这一项为什么不动
    reason?: string;
}

export interface NamespacePolicySyncScope {
    tenant: string;
    namespace: string;
}

export interface NamespacePolicySyncParams {
    clusterId: string;
    source: NamespacePolicySyncScope;
    targets: NamespacePolicySyncScope[];
    fields: NamespacePolicyField[];
}

// 一个目标命名空间的差异。error 非空表示这一份读不出来（老 broker 缺端点、
// 权限不足、命名空间被并发删除都会走到这里），其余目标照常继续算。
// view 是给界面算「当前值 → 同步后」两边文案用的，不带 raw：差异结论来自主进程，
// 界面只负责把值翻译成人话，不负责判断要不要改。
export interface NamespacePolicySyncTargetPlan {
    tenant: string;
    namespace: string;
    error?: string;
    view?: NamespacePolicyView;
    deltas: NamespacePolicySyncDelta[];
}

export interface NamespacePolicySyncPlanResult {
    source: NamespacePolicySyncScope;
    sourceError?: string;
    sourceView?: NamespacePolicyView;
    targets: NamespacePolicySyncTargetPlan[];
}

export interface NamespacePolicySyncItemResult {
    field: NamespacePolicyField;
    action: NamespacePolicySyncAction;
    quotaType?: string;
    ok: boolean;
    // skip 时是「为什么没动」，失败时是校验或 broker 的错误原文
    message?: string;
}

export interface NamespacePolicySyncTargetResult {
    tenant: string;
    namespace: string;
    // 整个目标失败（读不出策略）时记在这里，不伪装成某一项失败
    error?: string;
    items: NamespacePolicySyncItemResult[];
}

export interface NamespacePolicySyncApplyResult {
    targets: NamespacePolicySyncTargetResult[];
    succeeded: number;
    failed: number;
}

// ========== Topic 级策略（TopicPolicies）==========
//
// broker 把策略分成三层：broker 默认、命名空间覆盖、topic 覆盖。这一节是第三层。
// topic 级覆盖不是"另存一份全量策略"，而是一字段一端点：GET 只回那一个值
// （标量直接回裸数字/布尔，retention 回对象），POST 设置、DELETE 撤销回上层。
// 字段集合因此只列 broker 上确实存在这三件套的项——inactive topic、delayed
// delivery、offload、persistence 等虽有端点但请求体形状未核对，不臆造。

export type TopicPolicyField =
    | 'retention'
    | 'messageTtlSeconds'
    | 'deduplicationEnabled'
    | 'maxUnackedMessagesPerConsumer'
    | 'maxUnackedMessagesPerSubscription';

// 某个字段在这台 broker 上读不出来。两种原因必须分开显示：
// 404 是没有 topic 级端点（老 broker），405 是 broker.conf 里
// topicLevelPoliciesEnabled=false——后者运维改一个配置就能恢复，前者不能。
export interface TopicPolicyUnavailable {
    field: TopicPolicyField;
    reason: string;
}

export interface TopicPolicyView {
    // tenant/ns/topic（短名，不带 persistent:// 前缀）
    topicName: string;
    persistent: boolean;
    // 未设置 = 沿用命名空间/broker，与「设为 -1 / 设为 0」是三种不同事实
    retentionTimeInMinutes: number | null;
    retentionSizeInMB: number | null;
    messageTtlSeconds: number | null;
    deduplicationEnabled: boolean | null;
    maxUnackedMessagesPerConsumer: number | null;
    maxUnackedMessagesPerSubscription: number | null;
    clearableFields: TopicPolicyField[];
    unavailable: TopicPolicyUnavailable[];
    // 逐端点的原始返回：折叠表只列上面这些字段，broker 上还有更多 topic 级端点
    // （未核对形状的那几个），出问题时这是唯一的现场证据。
    raw: Record<string, unknown>;
}

export interface TopicPolicyScopeParams {
    clusterId: string;
    tenant: string;
    namespace: string;
    topic: string;
    persistent?: boolean;
}

// 写入形状与读取形状不同：retention 写回是一个对象（broker 的 POST 整体替换两个维度，
// 少发一个等于把它清零），其余字段是裸标量。value 保持 unknown 由字段表逐字段校验。
export interface TopicPolicySetParams extends TopicPolicyScopeParams {
    field: TopicPolicyField;
    value: unknown;
}

export interface TopicPolicyClearParams extends TopicPolicyScopeParams {
    field: TopicPolicyField;
}

// ========== Topic 级策略批量同步 ==========
//
// 与命名空间同步同一套语义：让目标 topic 在所选字段上「等于」源 topic，不是合并。
// 目标必须是同一个集群里的 topic（每个 topic 属于一个命名空间，而命名空间属于一个集群），
// 所以这里的 scope 比命名空间多一个 topic 与 persistent——同名 topic 可以在
// persistent 与 non-persistent 两族里同时存在，那是两个不同的 topic。

export type TopicPolicySyncAction = 'set' | 'clear' | 'skip';

export interface TopicPolicySyncDelta {
    field: TopicPolicyField;
    action: TopicPolicySyncAction;
    // set 的载荷：形状与 topic:policy:set 的 value 完全一致，执行阶段原样转发
    value?: unknown;
    // skip 必填：说明这一项为什么不动
    reason?: string;
}

export interface TopicPolicySyncScope {
    tenant: string;
    namespace: string;
    topic: string;
    persistent: boolean;
}

export interface TopicPolicySyncParams {
    clusterId: string;
    source: TopicPolicySyncScope;
    targets: TopicPolicySyncScope[];
    fields: TopicPolicyField[];
}

// view 是给界面算「目标当前值 → 同步后」两边文案用的，不带 raw：
// 差异结论来自主进程，界面只负责把值翻译成人话。
export interface TopicPolicySyncTargetPlan {
    tenant: string;
    namespace: string;
    topic: string;
    persistent: boolean;
    error?: string;
    view?: TopicPolicyView;
    deltas: TopicPolicySyncDelta[];
}

export interface TopicPolicySyncPlanResult {
    source: TopicPolicySyncScope;
    sourceError?: string;
    sourceView?: TopicPolicyView;
    targets: TopicPolicySyncTargetPlan[];
}

export interface TopicPolicySyncItemResult {
    field: TopicPolicyField;
    action: TopicPolicySyncAction;
    ok: boolean;
    // skip 时是「为什么没动」，失败时是校验或 broker 的错误原文
    message?: string;
}

export interface TopicPolicySyncTargetResult {
    tenant: string;
    namespace: string;
    topic: string;
    persistent: boolean;
    // 整个目标失败（读不出策略）时记在这里，不伪装成某一项失败
    error?: string;
    items: TopicPolicySyncItemResult[];
}

export interface TopicPolicySyncApplyResult {
    targets: TopicPolicySyncTargetResult[];
    succeeded: number;
    failed: number;
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

// 导出文件里的 K8s 转发条目。与 SSH 那条同一个尺度：这里没有一个字节是凭据——
// 凭据在 kubeconfig 那个文件里，本条目只有它的"路径"与命名空间/资源名。
// 换台机器导入时这个路径大概率不存在，用户仍要在集群表单里确认一次。
export interface ExportedK8sForwardConfig {
    namespace: string;
    resource: string;
    context?: string | null;
    kubeconfigPath?: string | null;
    kubectlPath?: string | null;
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
    k8s?: ExportedK8sForwardConfig | null;
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
    // 老导出文件里没有 k8s 这一项，所以只有真的带进来了才计数；
    // 与 tunnelsImported 分开报，用户才知道导入的到底是哪种通道
    forwardsImported: number;
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

// ========== 集群巡检（Inspection） ==========

// 四级而不是两级：巡检里「这条没跑起来（老 broker 没有该端点）」与「这条判定为危险」
// 完全是两种信息，混成同一条会让用户把所有红字都当成故障。
export type InspectionLevel = 'ok' | 'warn' | 'crit' | 'skip';

export interface InspectionCheck {
    key: string;
    title: string;
    level: InspectionLevel;
    // 一行结论，界面上直接显示、Markdown 里作为条目正文
    summary: string;
    // 证据行（topic 名、数值），只在展开态与导出文件里出现
    detail?: string[];
    // 针对这一条的可执行建议；没有建议时不写（不是每条检查都需要）
    suggestion?: string;
}

// 巡检采样到的规模。截断必须显式报出来：「没发现高积压」和「只看了前 60 个 topic，
// 里面没有高积压」是两句话，后者界面上要让用户看见。
export interface InspectionScope {
    tenants: number;
    namespacesSeen: number;
    // 命名空间里列到的 topic 总数（截断之前），与真正逐个取统计的数量分开：
    // 「见到 460 个、只采了 60 个」是报告里必须说清的一句话
    topicsSeen: number;
    topicsSampled: number;
    maxNamespaces: number;
    maxTopics: number;
    truncated: boolean;
}

export interface InspectionTotals {
    ok: number;
    warn: number;
    crit: number;
    skip: number;
}

export interface InspectionReport {
    clusterId: string;
    clusterName: string;
    // ISO 时间，导出文件的标题里也用它
    generatedAt: string;
    version: string | null;
    scope: InspectionScope;
    checks: InspectionCheck[];
    totals: InspectionTotals;
    // 这份报告实际用的口径。存进报告而不是只留在配置表里：阈值后来被人改过，
    // 老报告的级别就再也解释不出来了，环比也无从判断「变差」里有多少是判定变严了。
    // 可选只对历史行成立：v2.8 存的报告没有这一格，读出来是 undefined，
    // 含义是「口径未知」，不能拿默认值替它补一个看着有据的结论。
    thresholds?: InspectionThresholds;
}

/** 判定的六个数。字段齐整而不是可选：报告与环比都要能拿到一份完整口径。 */
export interface InspectionThresholds {
    backlogWarn: number;
    backlogCrit: number;
    unackedWarn: number;
    rateRatio: number;
    rateMinIn: number;
    detailTopN: number;
}

/** 界面上报的口径：全字段可选，缺省落回默认值。 */
export type InspectionThresholdsDraft = Partial<InspectionThresholds>;

export interface InspectionProfile {
    clusterId: string;
    thresholds: InspectionThresholds;
    maxNamespaces: number;
    maxTopics: number;
    updatedAt: string;
}

export interface InspectionProfileDraft {
    clusterId: string;
    thresholds?: InspectionThresholdsDraft;
    maxNamespaces?: number;
    maxTopics?: number;
}

/** 一次口径改动落在界面上的样子：只有真的与上一份不同才列出来。 */
export interface InspectionThresholdChange {
    field: keyof InspectionThresholds;
    label: string;
    previous: number;
    current: number;
}

export interface InspectionRunParams {
    clusterId: string;
    maxNamespaces?: number;
    maxTopics?: number;
}

// 一次巡检是谁发起的。定时行不会替手动行说话：「03:00 那一份是应用自己跑的」
// 与「这一份是你点的」在回看时是两种可信度——自动那份没人核对过采样范围。
export type InspectionSource = 'manual' | 'scheduled';

export interface InspectionRunResult {
    report: InspectionReport;
    markdown: string;
    // 与上一次巡检的差别。第一次跑（库里没有前一份）时为 null，界面就不显示对比区
    diff: InspectionDiff | null;
    source: InspectionSource;
}

// 历史列表的一行。checks 不进这个形状：列表要扫的是「哪次跑出了几项严重」，
// 把每份报告的 JSON 都解析一遍只为渲染一行是白干的活。
export interface InspectionHistoryRow {
    id: string;
    clusterId: string;
    clusterName: string;
    generatedAt: string;
    version: string | null;
    totals: InspectionTotals;
    scope: InspectionScope;
    source: InspectionSource;
}

// ========== 定时巡检（v3.1） ==========

/** 一台集群的调度行。没配过调度时整条为 null，界面据此区分「没配」与「配了但关着」。 */
export interface InspectionSchedule {
    clusterId: string;
    enabled: boolean;
    intervalMinutes: number;
    /** 判出严重项时发桌面通知；恢复也发一条，与告警规则的 notify 同一个开关口径。 */
    notifyOnCrit: boolean;
    lastRunAt: string | null;
    /** 最近一次调度跑失败的原文，手动跑不写这一格：它说的是「自动这条链路坏了」。 */
    lastError: string | null;
    /** 上一次发通知时那份报告的严重项数，用来把「还是那件事」的重复通知挡掉。 */
    lastNotifiedCrit: number;
    updatedAt: string;
}

/** 界面提交的调度改动：全字段可选，缺省落回现值或默认间隔。 */
export interface InspectionScheduleDraft {
    clusterId: string;
    enabled?: boolean;
    intervalMinutes?: number;
    notifyOnCrit?: boolean;
}

/** 主进程 → 渲染进程：一次调度跑完了（或跑坏了），让对应集群的巡检页把历史刷回来。 */
export interface InspectionScheduledPush {
    kind: 'completed' | 'failed';
    clusterId: string;
    clusterName: string;
    /** 跑坏了就是 null：没有一份报告，也就不该替它编一个全 0 的计数。 */
    totals: InspectionTotals | null;
    /** 通知文案（失败时是错误原因），界面直接用，不再各处重算一遍。 */
    message: string;
    generatedAt: string;
}

export const INSPECTION_SCHEDULE_CHANNEL = 'inspection:scheduled' as const;

// ========== 跨集群巡检汇总（v3.2） ==========

/**
 * 一台集群在汇总里的位置。
 *
 * 只有四档，且「从没看过」单独一档而不是并进 quiet：汇总对一台没跑过的集群唯一知道的事
 * 就是没人看过，把它算成「没发现问题」是最容易害人的那种误读。
 */
export type FleetSection = 'crit' | 'warn' | 'never' | 'quiet';

/** 汇总的一行：这台集群自己最近的一份报告，加上它的调度与新鲜度。 */
export interface InspectionFleetCluster {
    clusterId: string;
    clusterName: string;
    /** 库里最近的一份；从来没有过就是 null，界面与导出都必须能区分这两件事。 */
    latest: InspectionHistoryRow | null;
    /** 那一份报告的检查项。只用来挑出 crit 做跨集群分组，不复制整份报告。 */
    checks: InspectionCheck[];
    schedule: InspectionSchedule | null;
    /** 相对这台集群自己的节奏有多旧（不是相对全局写死的一个数）。 */
    freshness: 'never' | 'fresh' | 'aging' | 'stale';
}

/** 同一个检查项在多台集群上一起亮时合并成一组：这才看得出是一类问题还是一堆独立故障。 */
export interface InspectionFleetGroup {
    key: string;
    title: string;
    items: {
        clusterId: string;
        clusterName: string;
        summary: string;
        suggestion?: string;
    }[];
}

export interface InspectionFleetTotals {
    clusters: number;
    /** 有报告的台数 = clusters - never。 */
    inspected: number;
    never: number;
    crit: number;
    warn: number;
    /** 报告已经偏旧或过期的台数：这些行的数字不能当现在用。 */
    stale: number;
    /** 开着定时的台数：一屏全 0 时先确认这里不是 0。 */
    scheduled: number;
}

/** 本轮跑坏的那台，与「因为上限没跑的」是两个原因，分开列。 */
export interface InspectionFleetFailure {
    clusterId: string;
    clusterName: string;
    message: string;
}

export interface InspectionFleetSkipped {
    clusterId: string;
    clusterName: string;
}

/** 一页汇总。跨集群这份文件要能脱离应用读懂，所以口径都写在结构里而不是只留在界面上。 */
export interface InspectionFleetSummary {
    generatedAt: string;
    clusters: InspectionFleetCluster[];
    critGroups: InspectionFleetGroup[];
    totals: InspectionFleetTotals;
    /** 这一轮逐台跑时失败的集群（读最近一份汇总时为空）。 */
    failures: InspectionFleetFailure[];
    /** 这一轮因为「一次最多 N 台」而没跑的集群。 */
    skipped: InspectionFleetSkipped[];
}

/** 逐台跑的时候每完成一台推一条，界面才不会在一屏集群前挂着「加载中」猜进度。 */
export interface InspectionFleetProgress {
    clusterId: string;
    clusterName: string;
    index: number;
    total: number;
    status: 'started' | 'done' | 'failed';
    /** 跑坏了就是 null：没有一份报告，不该替它编一个全 0 的计数。 */
    totals: InspectionTotals | null;
    message: string;
}

export interface InspectionFleetRunParams {
    /** 一次最多跑几台，主进程 clamp 到 1..20。 */
    limit?: number;
    maxNamespaces?: number;
    maxTopics?: number;
}

/** 逐台跑完之后返回的那一份：summary 已经按跑完的库重算过。 */
export interface InspectionFleetRunResult {
    summary: InspectionFleetSummary;
    ran: number;
    failed: number;
}

export const INSPECTION_FLEET_CHANNEL = 'inspection:fleet-progress' as const;

export type InspectionChangeKind = 'new' | 'resolved' | 'worsened' | 'improved' | 'unchanged';

export interface InspectionDiffItem {
    key: string;
    title: string;
    kind: InspectionChangeKind;
    level: InspectionLevel | null;
    previousLevel: InspectionLevel | null;
    summary: string;
}

export interface InspectionDiff {
    previousId: string;
    previousGeneratedAt: string;
    items: InspectionDiffItem[];
    // 只在级别真的移动时有话要说：一份「全是 unchanged」的报告读起来比不读还累
    changedCount: number;
    // 两次报告的口径差别。改过阈值之后再环比，级别移动里就混着「判定变严了」这一部分，
    // 不写出来的话环比会把应用自己的改动说成集群的变化。
    thresholdChanges: InspectionThresholdChange[];
}

// ========== 外部通知渠道 ==========

/**
 * 渠道类型决定请求体长什么样：这几家的机器人 webhook 形状互不相同，
 * 但对「一条通知该说什么」没有影响，所以正文在 shared/notify-channels 里只拼一次。
 */
export type NotifyChannelKind = 'generic' | 'dingtalk' | 'feishu' | 'wecom' | 'slack';

export type NotifyEventKind =
    | 'alertFired'
    | 'alertRecovered'
    | 'inspectionCrit'
    | 'inspectionRecovered'
    | 'inspectionFailed'
    /** 手动「发送测试」造出来的那一条。渠道的订阅清单里不会有它：测试要问的是地址通不通，
     *  而不是按规则这条该不该发，所以它绕开订阅、级别与限流，但仍然照常落一条投递记录。 */
    | 'test';

/** 通知自己的级别，与巡检的 crit/warn 同词：一条渠道可以只收严重项。 */
export type NotifyLevel = 'info' | 'warn' | 'crit';

export interface NotifyChannel {
    id: string;
    name: string;
    kind: NotifyChannelKind;
    /**
     * 发给渲染层的是打码后的地址（查询串里的 token 换成 ***），落库的是完整地址的密文。
     * 地址本身就是凭据的一部分：企微/钉钉的 key 直接写在 URL 里，列表页截图发群里不能把它带出去。
     */
    url: string;
    /** 签名密钥不回填：界面只知道「这里存过东西」。 */
    hasSecret: boolean;
    enabled: boolean;
    events: NotifyEventKind[];
    minLevel: NotifyLevel;
    timeoutMs: number;
    ratePerMinute: number;
    lastSentAt: string | null;
    /** 最近一次为什么没送出去。手动测试也写这一格：配置坏了要看得见。 */
    lastError: string | null;
    /** 连续失败次数，成功一次清零：一次都没成过和昨天还能通是两种不同的坏法。 */
    failCount: number;
    createdAt: string;
    updatedAt: string;
}

/** 新建与编辑共用：不带 id 是新建；secret 缺省或空串表示「保持库里已有的那个」。 */
export interface NotifyChannelDraft {
    id?: string;
    name: string;
    kind: NotifyChannelKind;
    url: string;
    secret?: string;
    enabled?: boolean;
    events?: NotifyEventKind[];
    minLevel?: NotifyLevel;
    timeoutMs?: number;
    ratePerMinute?: number;
}

/** 要发出去的一件事。告警引擎与巡检调度都往这里给，两边都不自己拼文本。 */
export interface NotifyEvent {
    kind: NotifyEventKind;
    level: NotifyLevel;
    title: string;
    /** 多行正文，渠道格式的差异在 payload 那层处理 */
    text: string;
    clusterId: string;
    clusterName: string;
    /** epoch 毫秒：渲染与限流都用它，不做字符串时间解析 */
    atMs: number;
    /** 手动测试：跳过限流，也照实落一条投递记录 */
    test?: boolean;
}

/** 一次投递的结论，落进 notify_deliveries 给「最近投递」那页读。 */
export interface NotifyDelivery {
    id: number;
    channelId: string;
    channelName: string;
    eventKind: NotifyEventKind;
    level: NotifyLevel;
    ok: boolean;
    /** 没发出去的那一条也算结论：被级别或限流挡下时必须写明是谁挡的、为什么 */
    skipped: boolean;
    message: string;
    createdAt: string;
}

/** dispatch 的返回：每个渠道一条结论，界面据此提示「三条渠道里有一条没送到」。 */
export interface NotifyDispatchResult {
    event: {kind: NotifyEventKind; title: string};
    deliveries: {
        channelId: string;
        channelName: string;
        ok: boolean;
        skipped: boolean;
        message: string;
    }[];
}
