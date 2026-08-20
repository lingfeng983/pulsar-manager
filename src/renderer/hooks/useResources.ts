import { useState, useCallback, useMemo } from 'react'
import type { Tenant, Topic, TopicStats } from '../types'

// LRU Cache 实现
class LRUCache<T> {
  private cache: Map<string, { data: T; timestamp: number }> = new Map()
  private maxSize: number
  private ttl: number // 毫秒

  constructor(maxSize: number, ttl: number) {
    this.maxSize = maxSize
    this.ttl = ttl
  }

  get(key: string): T | null {
    const item = this.cache.get(key)
    if (!item) return null

    // 检查过期
    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key)
      return null
    }

    // 重新排序（移到末尾表示最近使用）
    this.cache.delete(key)
    this.cache.set(key, item)
    return item.data
  }

  set(key: string, data: T): void {
    // 如果已存在，先删除
    if (this.cache.has(key)) {
      this.cache.delete(key)
    }

    // 如果缓存满了，删除最旧的
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey) {
        this.cache.delete(oldestKey)
      }
    }

    this.cache.set(key, { data, timestamp: Date.now() })
  }

  clear(): void {
    this.cache.clear()
  }
}

interface UseResourcesResult {
  // 租户
  tenants: Tenant[]
  tenantsLoading: boolean
  tenantsError: string | null
  fetchTenants: (clusterId: string) => Promise<void>

  // 命名空间
  namespaces: string[]
  namespacesLoading: boolean
  namespacesError: string | null
  fetchNamespaces: (clusterId: string, tenant: string) => Promise<void>

  // Topics
  topics: Topic[]
  topicsLoading: boolean
  topicsError: string | null
  fetchTopics: (clusterId: string, tenant: string, namespace: string) => Promise<void>

  // Topic 统计
  topicStats: TopicStats | null
  topicStatsLoading: boolean
  topicStatsError: string | null
  fetchTopicStats: (clusterId: string, tenant: string, namespace: string, topic: string) => Promise<void>

  // 缓存管理
  clearCache: () => void
}

export function useResources(): UseResourcesResult {
  // 创建实例级缓存（使用 useMemo 确保只创建一次）
  const tenantsCache = useMemo(() => new LRUCache<Tenant[]>(100, 5 * 60 * 1000), [])
  const namespacesCache = useMemo(() => new LRUCache<string[]>(200, 5 * 60 * 1000), [])
  const topicsCache = useMemo(() => new LRUCache<Topic[]>(300, 1 * 60 * 1000), [])
  const topicStatsCache = useMemo(() => new LRUCache<TopicStats>(500, 30 * 1000), [])

  // 租户状态
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [tenantsLoading, setTenantsLoading] = useState(false)
  const [tenantsError, setTenantsError] = useState<string | null>(null)

  // 命名空间状态
  const [namespaces, setNamespaces] = useState<string[]>([])
  const [namespacesLoading, setNamespacesLoading] = useState(false)
  const [namespacesError, setNamespacesError] = useState<string | null>(null)

  // Topics 状态
  const [topics, setTopics] = useState<Topic[]>([])
  const [topicsLoading, setTopicsLoading] = useState(false)
  const [topicsError, setTopicsError] = useState<string | null>(null)

  // Topic 统计状态
  const [topicStats, setTopicStats] = useState<TopicStats | null>(null)
  const [topicStatsLoading, setTopicStatsLoading] = useState(false)
  const [topicStatsError, setTopicStatsError] = useState<string | null>(null)

  // 获取租户列表
  const fetchTenants = useCallback(async (clusterId: string) => {
    const cacheKey = `tenants:${clusterId}`
    const cached = tenantsCache.get(cacheKey)
    if (cached) {
      setTenants(cached)
      return
    }

    setTenantsLoading(true)
    setTenantsError(null)
    try {
      const response = await window.electronAPI.resources.getTenants(clusterId)
      if (response.success && response.data) {
        setTenants(response.data)
        tenantsCache.set(cacheKey, response.data)
      } else {
        setTenantsError(response.error || 'Failed to fetch tenants')
      }
    } catch (error) {
      setTenantsError(String(error))
    } finally {
      setTenantsLoading(false)
    }
  }, [tenantsCache])

  // 获取命名空间列表
  const fetchNamespaces = useCallback(async (clusterId: string, tenant: string) => {
    const cacheKey = `namespaces:${clusterId}:${tenant}`
    const cached = namespacesCache.get(cacheKey)
    if (cached) {
      setNamespaces(cached)
      return
    }

    setNamespacesLoading(true)
    setNamespacesError(null)
    try {
      const response = await window.electronAPI.resources.getNamespaces(clusterId, tenant)
      if (response.success && response.data) {
        setNamespaces(response.data)
        namespacesCache.set(cacheKey, response.data)
      } else {
        setNamespacesError(response.error || 'Failed to fetch namespaces')
      }
    } catch (error) {
      setNamespacesError(String(error))
    } finally {
      setNamespacesLoading(false)
    }
  }, [namespacesCache])

  // 获取 Topics 列表
  const fetchTopics = useCallback(async (clusterId: string, tenant: string, namespace: string) => {
    const cacheKey = `topics:${clusterId}:${tenant}:${namespace}`
    const cached = topicsCache.get(cacheKey)
    if (cached) {
      setTopics(cached)
      return
    }

    setTopicsLoading(true)
    setTopicsError(null)
    try {
      const response = await window.electronAPI.resources.getTopics(clusterId, tenant, namespace)
      if (response.success && response.data) {
        setTopics(response.data)
        topicsCache.set(cacheKey, response.data)
      } else {
        setTopicsError(response.error || 'Failed to fetch topics')
      }
    } catch (error) {
      setTopicsError(String(error))
    } finally {
      setTopicsLoading(false)
    }
  }, [topicsCache])

  // 获取 Topic 统计
  const fetchTopicStats = useCallback(
    async (clusterId: string, tenant: string, namespace: string, topic: string) => {
      const cacheKey = `topicStats:${clusterId}:${tenant}:${namespace}:${topic}`
      const cached = topicStatsCache.get(cacheKey)
      if (cached) {
        setTopicStats(cached)
        return
      }

      setTopicStatsLoading(true)
      setTopicStatsError(null)
      try {
        const response = await window.electronAPI.resources.getTopicStats(
          clusterId,
          tenant,
          namespace,
          topic
        )
        if (response.success && response.data) {
          setTopicStats(response.data)
          topicStatsCache.set(cacheKey, response.data)
        } else {
          setTopicStatsError(response.error || 'Failed to fetch topic stats')
        }
      } catch (error) {
        setTopicStatsError(String(error))
      } finally {
        setTopicStatsLoading(false)
      }
    },
    [topicStatsCache]
  )

  // 清除缓存
  const clearCache = useCallback(() => {
    tenantsCache.clear()
    namespacesCache.clear()
    topicsCache.clear()
    topicStatsCache.clear()
  }, [tenantsCache, namespacesCache, topicsCache, topicStatsCache])

  return {
    tenants,
    tenantsLoading,
    tenantsError,
    fetchTenants,
    namespaces,
    namespacesLoading,
    namespacesError,
    fetchNamespaces,
    topics,
    topicsLoading,
    topicsError,
    fetchTopics,
    topicStats,
    topicStatsLoading,
    topicStatsError,
    fetchTopicStats,
    clearCache,
  }
}
