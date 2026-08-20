import axios, { AxiosInstance, AxiosError, InternalAxiosRequestConfig } from 'axios'
import { REQUEST_CONFIG } from '../config/constants'

// ========== Type Definitions ==========

export interface ClusterInfo {
  name: string
  serviceUrl: string
  brokerServiceUrl?: string
  version?: string
}

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
  partitionIndex: number  // -1 表示非分区 Topic
  topicUri: string
}

export interface TopicStats {
  name: string
  persistent: boolean
  partitionIndex: number
  // 存储相关
  totalStorageSize: number
  storageSize: number
  backlogSize: number
  // 消息统计
  msgRateIn: number
  msgRateOut: number
  msgThroughputIn: number
  msgThroughputOut: number
  // 订阅信息
  subscriptions: Record<string, SubscriptionStats>
  producers: ProducerStats[]
  consumers: ConsumerStats[]
  // 非分区 Topic 的分区数
  numPartitions: number
}

export interface SubscriptionStats {
  name: string
  msgBacklog: number
  msgRateExpired: number
  consumerCount: number
  blockedSubscriptionOnUnackedMsgs: boolean
  lastExpireTimestamp: number
  lastConsumedFlowTimestamp: number
  msgConsumerBacklog: number
  unackedMessages: number
  type: string  // exclusive, shared, failover, key_shared
}

export interface ProducerStats {
  producerId: number
  producerName: string
  connected: boolean
  msgRateOut: number
  msgThroughputOut: number
  avgMsgSize: number
  clientVersion: string
}

export interface ConsumerStats {
  consumerId: number
  consumerName: string
  connected: boolean
  msgRateOut: number
  msgRateRedeliver: number
  msgThroughputOut: number
  msgBacklog: number
  unackedMessages: number
  blockedConsumerOnUnackedMsgs: boolean
  clientVersion: string
}

export interface BrokerStats {
  brokerId: string
  brokerName: string
  connected: boolean
  msgRateIn: number
  msgRateOut: number
  msgThroughputIn: number
  msgThroughputOut: number
  topicsCount: number
  partitionsCount: number
  cpuUsage: number
  memoryUsage: number
  directMemoryUsage: number
  bandwidthIn: number
  bandwidthOut: number
  lastUpdateTimestamp: number
  loadReport?: {
    cpuUsage: number
    directMemoryUsage: number
    bandwidthIn: number
    bandwidthOut: number
    memoryUsage: number
    msgRateIn: number
    msgRateOut: number
    totalConnections: number
    topicsCount: number
    partitionsCount: number
  }
}

export interface Message {
  messageId: string
  producerName: string
  sequenceId: number
  publishTime: number
  properties: Record<string, string>
  data: string  // Base64 encoded
  topicName: string
}

export interface TopicConfig {
  topicName: string
  numPartitions?: number
  permissions?: Record<string, string[]>
}

// 认证配置
export interface AuthConfig {
  authPlugin?: string
  authParams?: string
}

// TLS 配置
export interface TLSConfig {
  enabled: boolean
  trustCerts?: string
  clientCert?: string
  clientKey?: string
}

// Pulsar Admin 客户端配置
export interface PulsarAdminConfig {
  serviceUrl: string
  webServiceUrl?: string
  timeout?: number
  auth?: AuthConfig
  tls?: TLSConfig
}

// ========== HTTP Client Factory ==========

/**
 * Create an Axios instance with authentication interceptor and error handling.
 *
 * NOTE: The authParams in the config must already be decrypted before being
 * passed to this function. Decryption happens at client creation time (in
 * handlers.ts getAdminClient), NOT per-request in the interceptor.
 */
export function createAxiosClient(config: PulsarAdminConfig): AxiosInstance {
  const client = axios.create({
    baseURL: config.webServiceUrl || config.serviceUrl.replace('pulsar://', 'http://'),
    timeout: config.timeout || REQUEST_CONFIG.TIMEOUT,
    headers: {
      'Content-Type': 'application/json',
    },
  })

  // Request interceptor - add authentication header.
  // authParams is already decrypted at client creation time, so we use it directly
  // without calling decrypt() again. This fixes the double-decryption bug where
  // authParams was decrypted both at client creation and on every HTTP request.
  client.interceptors.request.use((axiosConfig: InternalAxiosRequestConfig) => {
    if (config.auth?.authPlugin && config.auth?.authParams) {
      axiosConfig.headers.set('Authorization', `Bearer ${config.auth.authParams}`)
    }
    return axiosConfig
  })

  // Response interceptor - error handling
  client.interceptors.response.use(
    (response) => response,
    (error: AxiosError) => {
      if (error.response?.status === 404) {
        return Promise.resolve({ data: null, status: 404 } as any)
      }
      if (error.response?.status === 401) {
        console.warn('[PulsarAdmin] Authentication failed')
      }
      if (error.response?.status === 403) {
        console.warn('[PulsarAdmin] Forbidden access')
      }
      console.error('[PulsarAdmin] API Error:', getErrorMessage(error))
      throw normalizeError(error)
    }
  )

  return client
}

// ========== Error Utilities ==========

export function getErrorMessage(error: AxiosError): string {
  if (error.response) {
    const { status, data } = error.response
    const message = (data as any)?.reason || (data as any)?.message || `HTTP ${status}`
    return `${message} (${status})`
  }
  return error.message
}

export function normalizeError(error: AxiosError): Error {
  if (error.response) {
    const status = error.response.status
    const data = error.response.data as any
    const message = data?.reason || data?.message || `HTTP ${status}`
    return new Error(`Pulsar API Error (${status}): ${message}`)
  } else if (error.request) {
    return new Error('Network Error: Unable to connect to Pulsar cluster')
  }
  return new Error(error.message)
}

// ========== Concurrency Control ==========

// Semaphore 实现用于并发控制
export class Semaphore {
  private active = 0
  private waiting: Array<() => void> = []

  constructor(private maxConcurrent: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++
      return
    }
    return new Promise<void>(resolve => {
      this.waiting.push(resolve)
    })
  }

  release(): void {
    this.active--
    if (this.waiting.length > 0 && this.active < this.maxConcurrent) {
      const next = this.waiting.shift()
      if (next) {
        this.active++
        next()
      }
    }
  }

  reset(): void {
    this.waiting = []
    this.active = 0
  }
}

// ========== Retry Utilities ==========

// 判断是否为可重试错误
export function isRetryableError(error: Error): boolean {
  return error.message.includes('503') || error.message.includes('Network')
}

// 重试装饰器
export function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  return fn().catch(async (error) => {
    if (retries > 0 && isRetryableError(error)) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      return withRetry(fn, retries - 1)
    }
    throw error
  })
}

