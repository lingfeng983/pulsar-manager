import { AxiosInstance } from 'axios'
import { Semaphore, withRetry } from './http-client'
import { API_ENDPOINTS } from '../config/constants'
import type {
  ClusterInfo,
  Tenant,
  Topic,
  TopicStats,
  TopicConfig,
  Message,
} from './http-client'

// ========== Resource API ==========

export class ResourceAPI {
  constructor(
    private http: AxiosInstance,
    private semaphore: Semaphore,
  ) {}

  private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    await this.semaphore.acquire()
    try {
      return await fn()
    } finally {
      this.semaphore.release()
    }
  }

  // ========== 集群操作 ==========

  // 获取集群信息
  async getClusterInfo(): Promise<ClusterInfo> {
    return this.enqueue(async () => {
      const response = await withRetry(() =>
        this.http.get('/admin/v2/clusters')
      )
      // clusters API 返回集群名称列表
      const clusterName = response.data[0]
      const info = await this.http.get(`/admin/v2/clusters/${clusterName}`)
      return {
        name: clusterName,
        serviceUrl: info.data.serviceUrl,
        brokerServiceUrl: info.data.brokerServiceUrl,
        version: info.data.version,
      }
    })
  }

  // ========== 租户操作 ==========

  // 获取所有租户
  async getTenants(): Promise<Tenant[]> {
    return this.enqueue(async () => {
      const response = await withRetry(() =>
        this.http.get('/admin/v2/tenants')
      )
      const tenants = response.data as string[]

      // 并行获取每个租户的详细信息
      const tenantInfos = await Promise.all(
        tenants.map(async (name) => {
          const detail = await this.http.get(`/admin/v2/tenants/${name}`)
          return {
            name,
            adminRoles: detail.data.adminRoles || [],
            allowedClusters: detail.data.allowedClusters || [],
          }
        })
      )

      return tenantInfos
    })
  }

  // 创建租户
  async createTenant(name: string, config: Partial<Tenant>): Promise<void> {
    return this.enqueue(async () => {
      await this.http.put(`/admin/v2/tenants/${name}`, {
        adminRoles: config.adminRoles || [],
        allowedClusters: config.allowedClusters || [],
      })
    })
  }

  // 更新租户
  async updateTenant(name: string, config: Partial<Tenant>): Promise<void> {
    return this.createTenant(name, config)
  }

  // 删除租户
  async deleteTenant(name: string): Promise<void> {
    return this.enqueue(async () => {
      await this.http.delete(`/admin/v2/tenants/${name}`)
    })
  }

  // 获取租户信息
  async getTenantInfo(tenant: string): Promise<{ adminRoles: string[]; allowedClusters: string[] }> {
    return this.enqueue(async () => {
      const response = await withRetry(() =>
        this.http.get(`/admin/v2/tenants/${tenant}`)
      )
      return response.data
    })
  }

  // ========== 命名空间操作 ==========

  // 获取租户下的所有命名空间
  async getNamespaces(tenant: string): Promise<string[]> {
    return this.enqueue(async () => {
      const response = await withRetry(() =>
        this.http.get(`/admin/v2/namespaces/${tenant}`)
      )
      // 响应格式: ["tenant/namespace1", "tenant/namespace2"]
      return response.data.map((ns: string) => {
        const parts = ns.split('/')
        return parts.length > 1 ? parts.slice(1).join('/') : ns
      })
    })
  }

  // 获取命名空间详情
  async getNamespaceInfo(tenant: string, namespace: string): Promise<{ replicationClusters: string[]; clusters: string[] }> {
    return this.enqueue(async () => {
      const response = await withRetry(() =>
        this.http.get(`/admin/v2/namespaces/${tenant}/${namespace}`)
      )
      return response.data
    })
  }

  // 创建命名空间
  async createNamespace(tenant: string, namespace: string): Promise<void> {
    return this.enqueue(async () => {
      await this.http.put(`/admin/v2/namespaces/${tenant}/${namespace}`)
    })
  }

  // 删除命名空间
  async deleteNamespace(tenant: string, namespace: string): Promise<void> {
    return this.enqueue(async () => {
      await this.http.delete(`/admin/v2/namespaces/${tenant}/${namespace}`)
    })
  }

  // ========== Topic 操作 ==========

  // 获取命名空间下的所有 Topic
  async getTopics(tenant: string, namespace: string): Promise<Topic[]> {
    return this.enqueue(async () => {
      // 获取命名空间下的所有Topic（包括分区和非分区）
      const response = await withRetry(() =>
        this.http.get(`/admin/v2/namespaces/${tenant}/${namespace}/topics`)
      )

      const topics: Topic[] = []

      for (const topicUri of response.data || []) {
        const topicName = topicUri.split('://').pop()!
        topics.push({
          name: topicName,
          persistent: topicUri.startsWith('persistent://'),
          partitionIndex: -1,
          topicUri,
        })
      }

      return topics
    })
  }

  // 获取 Topic 统计信息
  async getTopicStats(tenant: string, namespace: string, topic: string, persistent: boolean = true): Promise<TopicStats> {
    return this.enqueue(async () => {
      let topicName = topic

      if (topic.includes('/')) {
        const parts = topic.split('/')
        if (parts.length >= 3) {
          topicName = parts[parts.length - 1]
        }
      }

      const topicType = persistent ? 'persistent' : 'non-persistent'

      const response = await withRetry(() =>
        this.http.get(`/admin/v2/${topicType}/${tenant}/${namespace}/${topicName}/stats`)
      )

      if (response.status === 404 || response.data === null) {
        return {
          name: `${tenant}/${namespace}/${topicName}`,
          persistent,
          partitionIndex: -1,
          totalStorageSize: 0,
          storageSize: 0,
          backlogSize: 0,
          msgRateIn: 0,
          msgRateOut: 0,
          msgThroughputIn: 0,
          msgThroughputOut: 0,
          subscriptions: {},
          producers: [],
          consumers: [],
          numPartitions: 0,
        }
      }

      return { ...response.data, persistent }
    })
  }

  // 获取 Topic 配置
  async getTopicConfig(tenant: string, namespace: string, topic: string, persistent: boolean = true): Promise<TopicConfig> {
    return this.enqueue(async () => {
      const topicType = persistent ? 'persistent' : 'non-persistent'
      const response = await this.http.get(
        `/admin/v2/${topicType}/${tenant}/${namespace}/${topic}/info`
      )
      return {
        topicName: `${tenant}/${namespace}/${topic}`,
        numPartitions: response.data.numPartitions,
        permissions: response.data.policies?.permissions,
      }
    })
  }

  // 更新 Topic 配置
  async updateTopicConfig(tenant: string, namespace: string, topic: string, config: Partial<TopicConfig>, persistent: boolean = true): Promise<void> {
    return this.enqueue(async () => {
      const topicType = persistent ? 'persistent' : 'non-persistent'
      await this.http.put(
        `/admin/v2/${topicType}/${tenant}/${namespace}/${topic}/config`,
        config
      )
    })
  }

  // 创建 Topic（分区）
  async createPartitionedTopic(
    tenant: string,
    namespace: string,
    topic: string,
    partitions: number
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.http.put(
        `/admin/v2/persistent/${tenant}/${namespace}/${topic}/partitions`,
        partitions
      )
    })
  }

  // 删除 Topic
  async deleteTopic(tenant: string, namespace: string, topic: string): Promise<void> {
    return this.enqueue(async () => {
      await this.http.delete(`/admin/v2/persistent/${tenant}/${namespace}/${topic}`)
    })
  }

  // ========== 订阅操作 ==========

  // 获取 Topic 的所有订阅
  async getSubscriptions(tenant: string, namespace: string, topic: string): Promise<string[]> {
    return this.enqueue(async () => {
      const response = await withRetry(() =>
        this.http.get(`/admin/v2/persistent/${tenant}/${namespace}/${topic}/subscriptions`)
      )
      return response.data
    })
  }

  // 删除订阅
  async deleteSubscription(
    tenant: string,
    namespace: string,
    topic: string,
    subscription: string
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.http.delete(
        `/admin/v2/persistent/${tenant}/${namespace}/${topic}/subscription/${subscription}`
      )
    })
  }

  // 创建订阅
  async createSubscription(
    tenant: string,
    namespace: string,
    topic: string,
    name: string,
    type: string
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.http.put(
        `/admin/v2/persistent/${tenant}/${namespace}/${topic}/subscription/${name}`,
        { type }
      )
    })
  }

  // 跳过指定数量的消息
  async skipMessages(
    tenant: string,
    namespace: string,
    topic: string,
    subscription: string,
    numMessages: number
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.http.post(
        `/admin/v2/persistent/${tenant}/${namespace}/${topic}/subscription/${subscription}/skip/${numMessages}`
      )
    })
  }

  // 重置订阅游标到指定时间戳
  async resetCursor(
    tenant: string,
    namespace: string,
    topic: string,
    subscription: string,
    timestamp: number
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.http.post(
        `/admin/v2/persistent/${tenant}/${namespace}/${topic}/subscription/${subscription}/resetcursor`,
        { timestamp }
      )
    })
  }

  // 重置订阅游标到最早位置
  async resetCursorToEarliest(
    tenant: string,
    namespace: string,
    topic: string,
    subscription: string
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.http.post(
        `/admin/v2/persistent/${tenant}/${namespace}/${topic}/subscription/${subscription}/seekEarliest`
      )
    })
  }

  // 重置订阅游标到最新位置
  async resetCursorToLatest(
    tenant: string,
    namespace: string,
    topic: string,
    subscription: string
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.http.post(
        `/admin/v2/persistent/${tenant}/${namespace}/${topic}/subscription/${subscription}/seekLatest`
      )
    })
  }

  // ========== 消息操作 ==========

  // 消费消息
  async peekMessages(
    tenant: string,
    namespace: string,
    topic: string,
    subscription: string,
    count: number = 10
  ): Promise<Message[]> {
    return this.enqueue(async () => {
      const response = await withRetry(
        () =>
          this.http.get(
            `/admin/v2/persistent/${tenant}/${namespace}/${topic}/subscription/${subscription}/peek/${count}`
          ),
        2
      )
      return response.data
    })
  }

  // 发送消息（通过 HTTP Producer）
  async sendMessage(
    tenant: string,
    namespace: string,
    topic: string,
    message: string,
    properties?: Record<string, string>
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      // Pulsar HTTP Producer API
      const response = await this.http.post(
        `/admin/v2/producers/${tenant}/${namespace}/${topic}/send`,
        {
          payload: Buffer.from(message).toString('base64'),
          properties: properties || {},
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        }
      )

      return {
        success: true,
        messageId: response.data?.messageId || response.data,
      }
    } catch (error: any) {
      console.error('[PulsarAdmin] Send message error:', error)

      // 检查是否是 HTTP 405 (Method Not Allowed) - 表示 Producer API 未启用
      if (error.response?.status === 405) {
        return {
          success: false,
          error: 'HTTP Producer 未启用。请在 broker.conf 中启用 httpEnable(true) 或使用 Pulsar Client SDK 发送消息',
        }
      }

      return {
        success: false,
        error: error.response?.data?.reason || error.message || '发送失败',
      }
    }
  }

  // 获取积压消息数量
  async getBacklog(
    tenant: string,
    namespace: string,
    topic: string,
    subscription: string
  ): Promise<number> {
    return this.enqueue(async () => {
      const response = await this.http.get(
        `/admin/v2/persistent/${tenant}/${namespace}/${topic}/subscription/${subscription}/backlog`
      )
      return response.data
    })
  }

  // ========== 连接测试 ==========

  // 健康检查 - 尝试多种可能的端点
  async healthCheck(): Promise<boolean> {
    const endpoints = [
      API_ENDPOINTS.CLUSTERS,
      API_ENDPOINTS.TENANTS,
      API_ENDPOINTS.HEALTH,
      API_ENDPOINTS.HEALTH_ALT,
    ]

    for (const endpoint of endpoints) {
      try {
        const response = await this.http.get(endpoint, { timeout: 3000 })
        // 检查状态码是否在成功范围内 (200-399)
        if (response.status >= 200 && response.status < 400) {
          return true
        }
        // 如果状态码不在成功范围，继续尝试下一个端点
      } catch {
        // 继续尝试下一个端点
      }
    }
    return false
  }
}
