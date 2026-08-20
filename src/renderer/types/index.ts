// Pulsar 集群配置
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

// SSH 隧道配置
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

// 租户
export interface Tenant {
  name: string
  adminRoles: string[]
  allowedClusters: string[]
}

// 命名空间
export interface Namespace {
  name: string
  tenant: string
  clusters: string[]
  replicationClusters: string[]
}

// Topic
export interface Topic {
  name: string
  persistent: boolean
  partitionIndex: number
  topicUri: string
}

// Topic 统计信息
export interface TopicStats {
  name: string
  persistent?: boolean
  partitionIndex?: number
  numPartitions?: number
  totalStorageSize: number
  storageSize?: number
  backlogSize: number
  msgRateIn: number
  msgRateOut: number
  msgThroughputIn?: number
  msgThroughputOut?: number
  subscriptions: Record<string, SubscriptionStats>
  producers: ProducerStats[]
  consumers: ConsumerStats[]
}

// 订阅统计
export interface SubscriptionStats {
  name: string
  msgBacklog: number
  msgRateExpired: number
  consumerCount: number
  type: string
}

// 生产者统计
export interface ProducerStats {
  producerId: number
  producerName: string
  connected: boolean
  msgRateOut: number
}

// 消费者统计
export interface ConsumerStats {
  consumerId: number
  consumerName: string
  connected: boolean
  msgRateOut: number
  msgBacklog: number
}

// 消息
export interface Message {
  messageId: string
  producerName: string
  sequenceId: number
  publishTime: number
  properties: Record<string, string>
  data: string
  topicName?: string
}

// 订阅
export interface Subscription {
  name: string
  msgBacklog: number
  consumers: Consumer[]
  type: 'Exclusive' | 'Failover' | 'Shared' | 'Key_Shared'
}

export interface Consumer {
  consumerName: string
  availablePermits: number
  connectedSince: string
}

// 监控指标
export interface MetricData {
  timestamp: number
  value: number
  labels?: Record<string, string>
}

// 操作日志
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

// IPC 响应格式
export interface IPCResponse<T = any> {
  success: boolean
  data?: T
  error?: string
}

// 资源树节点
export interface ResourceTreeNode {
  key: string
  title: string
  type: 'cluster' | 'tenant' | 'namespace' | 'topic' | 'subscription'
  status?: 'connected' | 'disconnected' | 'warning'
  children?: ResourceTreeNode[]
  isLeaf?: boolean
  clusterId?: string
  tenant?: string
  namespace?: string
  topic?: string
}
