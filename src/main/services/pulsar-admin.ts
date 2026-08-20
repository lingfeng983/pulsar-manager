import { AxiosInstance } from 'axios'
import {
  createAxiosClient,
  Semaphore,
  withRetry,
  PulsarAdminConfig,
} from './http-client'
import { REQUEST_CONFIG } from '../config/constants'
import { ResourceAPI } from './resource-api'
import { MetricsAPI } from './metrics-api'

// Re-export all types and infrastructure from sub-modules
export * from './http-client'
export { ResourceAPI } from './resource-api'
export { MetricsAPI } from './metrics-api'

// Re-export specific types for convenience (handlers.ts imports these)
export type {
  ClusterInfo,
  Tenant,
  Namespace,
  Topic,
  TopicStats,
  SubscriptionStats,
  ProducerStats,
  ConsumerStats,
  BrokerStats,
  Message,
  TopicConfig,
  AuthConfig,
  TLSConfig,
  PulsarAdminConfig,
} from './http-client'

// ========== PulsarAdminClient (Facade) ==========

// Pulsar Admin API 客户端 - thin facade that delegates to ResourceAPI and MetricsAPI
export class PulsarAdminClient {
  private http: AxiosInstance
  private semaphore: Semaphore
  private resourceAPI: ResourceAPI
  private metricsAPI: MetricsAPI

  constructor(config: PulsarAdminConfig) {
    this.http = createAxiosClient(config)
    this.semaphore = new Semaphore(REQUEST_CONFIG.MAX_CONCURRENT)
    this.resourceAPI = new ResourceAPI(this.http, this.semaphore)
    this.metricsAPI = new MetricsAPI(this.http, this.semaphore, this.resourceAPI)
  }

  // ========== 集群操作 ==========

  async getClusterInfo() {
    return this.resourceAPI.getClusterInfo()
  }

  // ========== 租户操作 ==========

  async getTenants() {
    return this.resourceAPI.getTenants()
  }

  async createTenant(name: string, config: any) {
    return this.resourceAPI.createTenant(name, config)
  }

  async updateTenant(name: string, config: any) {
    return this.resourceAPI.updateTenant(name, config)
  }

  async deleteTenant(name: string) {
    return this.resourceAPI.deleteTenant(name)
  }

  async getTenantInfo(tenant: string) {
    return this.resourceAPI.getTenantInfo(tenant)
  }

  // ========== 命名空间操作 ==========

  async getNamespaces(tenant: string) {
    return this.resourceAPI.getNamespaces(tenant)
  }

  async getNamespaceInfo(tenant: string, namespace: string) {
    return this.resourceAPI.getNamespaceInfo(tenant, namespace)
  }

  async createNamespace(tenant: string, namespace: string) {
    return this.resourceAPI.createNamespace(tenant, namespace)
  }

  async deleteNamespace(tenant: string, namespace: string) {
    return this.resourceAPI.deleteNamespace(tenant, namespace)
  }

  // ========== Topic 操作 ==========

  async getTopics(tenant: string, namespace: string) {
    return this.resourceAPI.getTopics(tenant, namespace)
  }

  async getTopicStats(tenant: string, namespace: string, topic: string, persistent: boolean = true) {
    return this.resourceAPI.getTopicStats(tenant, namespace, topic, persistent)
  }

  async getTopicConfig(tenant: string, namespace: string, topic: string, persistent: boolean = true) {
    return this.resourceAPI.getTopicConfig(tenant, namespace, topic, persistent)
  }

  async updateTopicConfig(tenant: string, namespace: string, topic: string, config: any, persistent: boolean = true) {
    return this.resourceAPI.updateTopicConfig(tenant, namespace, topic, config, persistent)
  }

  async createPartitionedTopic(tenant: string, namespace: string, topic: string, partitions: number) {
    return this.resourceAPI.createPartitionedTopic(tenant, namespace, topic, partitions)
  }

  async deleteTopic(tenant: string, namespace: string, topic: string) {
    return this.resourceAPI.deleteTopic(tenant, namespace, topic)
  }

  // ========== 订阅操作 ==========

  async getSubscriptions(tenant: string, namespace: string, topic: string) {
    return this.resourceAPI.getSubscriptions(tenant, namespace, topic)
  }

  async deleteSubscription(tenant: string, namespace: string, topic: string, subscription: string) {
    return this.resourceAPI.deleteSubscription(tenant, namespace, topic, subscription)
  }

  async createSubscription(tenant: string, namespace: string, topic: string, name: string, type: string) {
    return this.resourceAPI.createSubscription(tenant, namespace, topic, name, type)
  }

  async skipMessages(tenant: string, namespace: string, topic: string, subscription: string, numMessages: number) {
    return this.resourceAPI.skipMessages(tenant, namespace, topic, subscription, numMessages)
  }

  async resetCursor(tenant: string, namespace: string, topic: string, subscription: string, timestamp: number) {
    return this.resourceAPI.resetCursor(tenant, namespace, topic, subscription, timestamp)
  }

  async resetCursorToEarliest(tenant: string, namespace: string, topic: string, subscription: string) {
    return this.resourceAPI.resetCursorToEarliest(tenant, namespace, topic, subscription)
  }

  async resetCursorToLatest(tenant: string, namespace: string, topic: string, subscription: string) {
    return this.resourceAPI.resetCursorToLatest(tenant, namespace, topic, subscription)
  }

  // ========== 消息操作 ==========

  async peekMessages(tenant: string, namespace: string, topic: string, subscription: string, count: number = 10) {
    return this.resourceAPI.peekMessages(tenant, namespace, topic, subscription, count)
  }

  async sendMessage(tenant: string, namespace: string, topic: string, message: string, properties?: Record<string, string>) {
    return this.resourceAPI.sendMessage(tenant, namespace, topic, message, properties)
  }

  async getBacklog(tenant: string, namespace: string, topic: string, subscription: string) {
    return this.resourceAPI.getBacklog(tenant, namespace, topic, subscription)
  }

  // ========== 连接测试 ==========

  async healthCheck() {
    return this.resourceAPI.healthCheck()
  }

  async testConnection(): Promise<{ connected: boolean; version?: string }> {
    try {
      const isHealthy = await this.healthCheck()
      if (!isHealthy) {
        return { connected: false }
      }

      let version: string | undefined
      try {
        const info = await this.getClusterInfo()
        version = info.version
      } catch {
        // 如果无法获取版本信息，仍然认为连接成功
      }

      return {
        connected: true,
        version,
      }
    } catch (error) {
      console.error('[PulsarAdmin] Test connection error:', error)
      return { connected: false }
    }
  }

  // ========== 监控相关 ==========

  async getBrokers() {
    return this.metricsAPI.getBrokers()
  }

  async getBrokerStats(broker: string) {
    return this.metricsAPI.getBrokerStats(broker)
  }

  async getAggregatedStats() {
    return this.metricsAPI.getAggregatedStats()
  }

  async getNamespaceStats(tenant: string, namespace: string) {
    return this.metricsAPI.getNamespaceStats(tenant, namespace)
  }

  // ========== 拓扑相关 ==========

  async getClusterTopology() {
    return this.metricsAPI.getClusterTopology()
  }

  async getMetrics(query: string, range?: { start: number; end: number }) {
    return this.metricsAPI.getMetrics(query, range)
  }

  async getTopicSubscriptions(tenant: string, namespace: string, topic: string) {
    return this.metricsAPI.getTopicSubscriptions(tenant, namespace, topic)
  }

  // ========== 生命周期 ==========

  // 清理客户端资源
  destroy(): void {
    this.semaphore.reset()
  }
}

// ========== Client Manager ==========

// 客户端管理器 - 管理多个集群连接
export class PulsarAdminClientManager {
  private clients: Map<string, PulsarAdminClient> = new Map()

  // 获取或创建客户端
  getClient(clusterId: string, config: PulsarAdminConfig): PulsarAdminClient {
    const existing = this.clients.get(clusterId)
    if (existing) {
      return existing
    }

    const client = new PulsarAdminClient(config)
    this.clients.set(clusterId, client)
    return client
  }

  // 移除客户端
  removeClient(clusterId: string): void {
    this.clients.delete(clusterId)
  }

  // 清除所有客户端
  clear(): void {
    this.clients.clear()
  }
}

// 导出单例
export const clientManager = new PulsarAdminClientManager()
