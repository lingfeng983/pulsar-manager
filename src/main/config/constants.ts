export const API_ENDPOINTS = {
  CLUSTERS: '/admin/v2/clusters',
  TENANTS: '/admin/v2/tenants',
  NAMESPACES: '/admin/v2/namespaces',
  TOPICS: '/admin/v2/topics',
  TOPICS_STATS: '/admin/v2/persistent',
  SUBSCRIPTIONS: '/admin/v2/subscriptions',
  HEALTH: '/admin/v2/health',
  HEALTH_ALT: '/health',
}

export const REQUEST_CONFIG = {
  TIMEOUT: 5000,
  MAX_CONCURRENT: 5,
  // 聚合类任务使用独立信号量，避免与叶子请求共用许可造成死锁
  MAX_CONCURRENT_AGGREGATE: 2,
  // 等待请求许可的上限，超时后报错而不是无限挂起
  ACQUIRE_TIMEOUT: 30000,
  REQUEST_DELAY: 50,
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000,
}

// 聚合遍历的规模上限：避免在大集群上产生数千次请求
export const AGGREGATION_LIMITS = {
  MAX_TENANTS: 50,
  MAX_NAMESPACES_PER_TENANT: 50,
  MAX_TOPICS_PER_NAMESPACE: 200,
}

export const CACHE_CONFIG = {
  TENANTS_MAX_SIZE: 100,
  TENANTS_TTL: 5 * 60 * 1000,
  NAMESPACES_MAX_SIZE: 200,
  NAMESPACES_TTL: 5 * 60 * 1000,
  TOPICS_MAX_SIZE: 300,
  TOPICS_TTL: 1 * 60 * 1000,
  TOPIC_STATS_MAX_SIZE: 500,
  TOPIC_STATS_TTL: 30 * 1000,
}

export const DB_CONFIG = {
  DATABASE_NAME: 'pulsar_manager.db',
  MAX_OPERATION_LOGS: 10000,
}

export const ENCRYPTION_CONFIG = {
  KEY_SIZE: 256,
}

export const LOG_LEVEL = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
} as const

export type LogLevel = typeof LOG_LEVEL[keyof typeof LOG_LEVEL]