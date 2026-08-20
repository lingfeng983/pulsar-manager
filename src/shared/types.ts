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
  success: boolean
  data?: T
  error?: string
}

// ========== 集群与隧道配置 ==========

// 已持久化的集群配置，id 必然存在
export interface ClusterConfig {
  id: string
  name: string
  serviceUrl: string
  webServiceUrl?: string
  authPlugin?: string
  authParams?: string
  tlsEnabled?: boolean
  tlsTrustCerts?: string
  useSshTunnel?: boolean
  sshConfigId?: string
  adminApiTimeout?: number
  status?: 'connected' | 'disconnected' | 'warning'
  version?: string
  createdAt?: string
  updatedAt?: string
}

// 新增/测试连接时提交的集群配置，此时还没有 id
export type ClusterConfigDraft = Omit<ClusterConfig, 'id'> & { id?: string }

export interface SSHConfig {
  host: string
  port?: number
  username: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKey?: string
  passphrase?: string
  remoteHost?: string
  remoteAdminPort?: number
  remoteBrokerPort?: number
}

export interface SSHTunnel {
  id: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  status?: 'connected' | 'disconnected' | 'error'
  localAdminPort?: number
  localBrokerPort?: number
  remoteHost?: string
  remoteAdminPort?: number
  remoteBrokerPort?: number
}

// ========== 资源 ==========

export interface Tenant {
  name: string
  adminRoles: string[]
  allowedClusters: string[]
}

export interface Namespace {
  name: string
  tenant: string
  clusters: string[]
  replicationClusters: string[]
}

export interface Topic {
  name: string
  persistent: boolean
  // -1 表示非分区 Topic
  partitionIndex: number
  topicUri: string
}

// ========== 统计 ==========

export interface SubscriptionStats {
  name: string
  msgBacklog: number
  msgRateExpired: number
  consumerCount: number
  // exclusive / shared / failover / key_shared
  type: string
  // 以下字段主进程会从 Admin API 补全，渲染层不保证拿到
  blockedSubscriptionOnUnackedMsgs?: boolean
  lastExpireTimestamp?: number
  lastConsumedFlowTimestamp?: number
  msgConsumerBacklog?: number
  unackedMessages?: number
}

export interface ProducerStats {
  producerId: number
  producerName: string
  connected: boolean
  msgRateOut: number
  msgThroughputOut?: number
  avgMsgSize?: number
  clientVersion?: string
}

export interface ConsumerStats {
  consumerId: number
  consumerName: string
  connected: boolean
  msgRateOut: number
  msgBacklog: number
  msgRateRedeliver?: number
  msgThroughputOut?: number
  unackedMessages?: number
  blockedConsumerOnUnackedMsgs?: boolean
  clientVersion?: string
}

export interface TopicStats {
  name: string
  totalStorageSize: number
  backlogSize: number
  msgRateIn: number
  msgRateOut: number
  subscriptions: Record<string, SubscriptionStats>
  producers: ProducerStats[]
  consumers: ConsumerStats[]
  persistent?: boolean
  partitionIndex?: number
  numPartitions?: number
  storageSize?: number
  msgThroughputIn?: number
  msgThroughputOut?: number
}

export interface BrokerInfo {
  activeBrokers: string[]
  allBrokers: string[]
}

export interface AggregatedStats {
  totalTopics: number
  totalPartitions: number
  totalSubscriptions: number
  totalProducers: number
  totalConsumers: number
  totalMsgRateIn: number
  totalMsgRateOut: number
  totalThroughputIn: number
  totalThroughputOut: number
  totalBacklog: number
}

export interface NamespaceStats {
  topicCount: number
  subscriptionCount: number
  producerCount: number
  consumerCount: number
  totalMsgRateIn: number
  totalMsgRateOut: number
  totalThroughputIn: number
  totalThroughputOut: number
  totalBacklog: number
}


// ========== 消息 ==========

export interface Message {
  messageId: string
  producerName: string
  sequenceId: number
  publishTime: number
  properties: Record<string, string>
  // Base64 编码
  data: string
  topicName?: string
}

export interface MessageBrowseParams {
  clusterId: string
  tenant: string
  namespace: string
  topic: string
  subscription: string
  count?: number
}

export interface MessageSendParams {
  clusterId: string
  tenant: string
  namespace: string
  topic: string
  message: string
  properties?: Record<string, string>
}

// ========== 指标与拓扑 ==========

export interface MetricData {
  timestamp: number
  value: number
  labels?: Record<string, string>
}

export interface TimeRange {
  start: number
  end: number
  step?: string
}

// 拓扑聚合规模上限：由调用方按场景收紧，服务端仍会与全局上限取较小值
export interface TopologyLimits {
  maxTenants?: number
  maxNamespacesPerTenant?: number
  maxTopicsPerNamespace?: number
  maxTopics?: number
}

export interface ClusterTopology {
  brokers: Array<{
    name: string
    topics: string[]
    stats?: unknown
  }>
  topics: Array<{
    name: string
    tenant: string
    namespace: string
    partitions: number
    subscriptions: string[]
    producers: number
    consumers: number
    msgRateIn: number
    msgRateOut: number
    backlogSize: number
  }>
}

// ========== 操作日志 ==========

export interface OperationLog {
  id: number
  cluster_id: string
  action: string
  resource_type: string
  resource_id: string
  resource_name: string
  details: string
  result: 'success' | 'failure'
  error_message?: string
  created_at: string
}
