import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import {
  initDatabase,
  closeDatabase,
  getAllClusters,
  getClusterById,
  insertCluster,
  updateCluster,
  deleteCluster,
  getAllSSHTunnels,
  insertSSHTunnel,
  updateSSHTunnel,
  deleteSSHTunnel,
  getSetting,
  setSetting,
  insertOperationLog,
  runInTransaction,
} from '../database/sqlite'
import { encrypt, decrypt } from '../services/encryption'
import { PulsarAdminClient, clientManager } from '../services/pulsar-admin'
import { createLogger } from '../utils/logger'

const log = createLogger('IPC')

// Re-export everything that domain handlers may need
export {
  ipcMain,
  z,
  uuidv4,
  initDatabase,
  closeDatabase,
  getAllClusters,
  getClusterById,
  insertCluster,
  updateCluster,
  deleteCluster,
  getAllSSHTunnels,
  insertSSHTunnel,
  updateSSHTunnel,
  deleteSSHTunnel,
  getSetting,
  setSetting,
  insertOperationLog,
  runInTransaction,
  encrypt,
  decrypt,
  PulsarAdminClient,
  clientManager,
}

// Zod schemas for validation
export const ClusterConfigSchema = z.object({
  name: z.string().min(1),
  serviceUrl: z.string().min(1),
  webServiceUrl: z.string().optional().nullable(),
  authPlugin: z.string().optional().nullable(),
  authParams: z.string().optional().nullable(),
  tlsEnabled: z.boolean().optional().nullable(),
  tlsTrustCerts: z.string().optional().nullable(),
  useSshTunnel: z.boolean().optional().nullable(),
  sshConfigId: z.string().optional().nullable(),
  adminApiTimeout: z.number().optional().nullable(),
})

export const ClusterTestSchema = z.object({
  serviceUrl: z.string().min(1),
  webServiceUrl: z.string().optional().nullable(),
  authPlugin: z.string().optional().nullable(),
  authParams: z.string().optional().nullable(),
  adminApiTimeout: z.number().optional().nullable(),
})

export const SSHConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().min(1).max(65535).optional(),
  username: z.string().min(1),
  authType: z.enum(['password', 'privateKey']),
  password: z.string().optional(),
  privateKey: z.string().optional(),
  passphrase: z.string().optional(),
  remoteHost: z.string().optional(),
  remoteAdminPort: z.number().optional(),
  remoteBrokerPort: z.number().optional(),
})

// 通用验证 schema
export const ClusterIdSchema = z.string().min(1).uuid()

export const TenantSchema = z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/)

export const NamespaceSchema = z.string().min(1).regex(/^[a-zA-Z0-9._-]+$/)

// Topic / Subscription 名称必须限制字符集：这些值会被拼进 Admin API 路径，
// 允许 "/" 或 ".." 会导致请求落到非预期资源上。
export const TopicSchema = z.string().min(1).max(255).regex(/^[a-zA-Z0-9._-]+$/)

export const SubscriptionSchema = z.string().min(1).max(255).regex(/^[a-zA-Z0-9._-]+$/)

export const TopicPathSchema = z.object({
  clusterId: ClusterIdSchema,
  tenant: TenantSchema,
  namespace: NamespaceSchema,
  topic: TopicSchema,
})

export const SubscriptionPathSchema = TopicPathSchema.extend({
  subscription: SubscriptionSchema,
})

export const SkipMessagesSchema = SubscriptionPathSchema.extend({
  count: z.number().int().positive().max(100000),
})

export const ResetCursorSchema = SubscriptionPathSchema.extend({
  position: z.enum(['earliest', 'latest', 'timestamp']),
  timestamp: z.number().int().positive().optional().nullable(),
})

// 订阅类型：渲染层传入的可能是小写（如 'exclusive'），
// Pulsar Admin API 要求首字母大写的形式，这里统一归一化。
const SUBSCRIPTION_TYPES = ['Exclusive', 'Shared', 'Failover', 'Key_Shared'] as const

export const SubscriptionTypeSchema = z
  .string()
  .transform(value => value.trim().toLowerCase())
  .refine(
    value => SUBSCRIPTION_TYPES.some(type => type.toLowerCase() === value),
    { message: 'Unsupported subscription type' },
  )
  .transform(value => SUBSCRIPTION_TYPES.find(type => type.toLowerCase() === value)!)

export const CreateSubscriptionSchema = SubscriptionPathSchema.extend({
  type: SubscriptionTypeSchema,
})

export const NamespacePathSchema = z.object({
  clusterId: ClusterIdSchema,
  tenant: TenantSchema,
  namespace: NamespaceSchema,
})

export const TenantPathSchema = z.object({
  clusterId: ClusterIdSchema,
  tenant: TenantSchema,
})

export const MessageBrowseSchema = z.object({
  clusterId: ClusterIdSchema,
  tenant: TenantSchema,
  namespace: NamespaceSchema,
  topic: TopicSchema,
  subscription: SubscriptionSchema,
  count: z.number().min(1).max(1000).optional().default(10),
})

export const MessageSendSchema = z.object({
  clusterId: ClusterIdSchema,
  tenant: TenantSchema,
  namespace: NamespaceSchema,
  topic: TopicSchema,
  message: z.string().min(1),
  properties: z.record(z.string()).optional(),
})

// 验证函数
export function validateClusterId(clusterId: string): boolean {
  const result = ClusterIdSchema.safeParse(clusterId)
  if (!result.success) {
    console.warn('[IPC] Invalid clusterId:', clusterId)
  }
  return result.success
}

export function validateTopicPath(params: { clusterId: string; tenant: string; namespace: string; topic: string }): boolean {
  const result = TopicPathSchema.safeParse(params)
  if (!result.success) {
    console.warn('[IPC] Invalid topic path:', params)
  }
  return result.success
}

// 初始化数据库
let dbInitialized = false

export function ensureDbInitialized() {
  if (!dbInitialized) {
    initDatabase()
    dbInitialized = true
  }
}

// 加密敏感字段
export function encryptSensitiveFields(config: z.infer<typeof ClusterConfigSchema>) {
  const encrypted = { ...config }
  if (config.authParams) {
    encrypted.authParams = encrypt(config.authParams)
  }
  if (config.tlsTrustCerts) {
    encrypted.tlsTrustCerts = encrypt(config.tlsTrustCerts)
  }
  return encrypted
}

// 解密敏感字段
export function decryptSensitiveFields(cluster: any) {
  const decrypted = { ...cluster }
  if (decrypted.auth_params) {
    try {
      decrypted.authParams = decrypt(decrypted.auth_params)
    } catch (error) {
      console.error('[IPC] Failed to decrypt auth_params:', error)
      throw new Error('Failed to decrypt sensitive configuration data')
    }
  }
  if (decrypted.tls_trust_certs) {
    try {
      decrypted.tlsTrustCerts = decrypt(decrypted.tls_trust_certs)
    } catch (error) {
      console.error('[IPC] Failed to decrypt tls_trust_certs:', error)
      throw new Error('Failed to decrypt sensitive configuration data')
    }
  }
  return decrypted
}

// 标准化集群数据
export function normalizeCluster(cluster: any) {
  return {
    id: cluster.id,
    name: cluster.name,
    serviceUrl: cluster.service_url,
    webServiceUrl: cluster.web_service_url,
    authPlugin: cluster.auth_plugin,
    authParams: cluster.auth_params,
    tlsEnabled: !!cluster.tls_enabled,
    tlsTrustCerts: cluster.tls_trust_certs,
    useSshTunnel: !!cluster.use_ssh_tunnel,
    sshConfigId: cluster.ssh_config_id,
    adminApiTimeout: cluster.admin_api_timeout || 5000,
    status: cluster.status || 'disconnected',
    version: cluster.version,
    createdAt: cluster.created_at,
    updatedAt: cluster.updated_at,
  }
}

// 格式化错误信息（只返回错误消息，不包含堆栈，避免泄露敏感信息）
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    // 生产环境只返回错误消息
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return JSON.stringify(error)
}

// 获取 Pulsar Admin Client（公共方法）
export function getAdminClient(clusterId: string): PulsarAdminClient | null {
  const cluster = getClusterById(clusterId)
  if (!cluster) {
    return null
  }

  return clientManager.getClient(clusterId, {
    serviceUrl: cluster.service_url,
    webServiceUrl: cluster.web_service_url,
    timeout: cluster.admin_api_timeout,
    auth: cluster.auth_plugin
      ? { authPlugin: cluster.auth_plugin, authParams: decrypt(cluster.auth_params) }
      : undefined,
    tls: cluster.tls_enabled
      ? {
          enabled: true,
          trustCerts: cluster.tls_trust_certs ? decrypt(cluster.tls_trust_certs) : undefined,
        }
      : undefined,
  })
}

// 关闭数据库
export function cleanupDatabase() {
  closeDatabase()
  dbInitialized = false
}

// ========== IPC 请求来源校验 ==========

// 只有应用自身的页面可以调用 IPC。开发环境走 Vite dev server，
// 生产环境是本地 file:// 页面；其他来源（被注入的 iframe、远程内容）一律拒绝。
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url
  if (!url) {
    return false
  }
  if (url.startsWith('file://')) {
    return true
  }
  if (process.env.NODE_ENV === 'development') {
    return url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:')
  }
  return false
}

// ========== IPC Handler 包装器 ==========

export type IpcResult<T> = { success: true; data?: T } | { success: false; error: string }

/**
 * 注册一个需要 Pulsar Admin 客户端的 IPC handler。
 *
 * 统一负责：来源校验 → 入参 zod 校验 → 数据库初始化 → 取客户端 →
 * 执行业务逻辑 → 错误捕获与脱敏。业务代码只需要提供参数映射和一行调用。
 */
export function registerClientHandler<S extends z.ZodTypeAny, T>(
  channel: string,
  schema: S,
  mapArgs: (args: unknown[]) => unknown,
  run: (client: PulsarAdminClient, input: z.infer<S>) => Promise<T>,
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<IpcResult<T>> => {
    try {
      if (!isTrustedSender(event)) {
        log.warn(`${channel}: rejected untrusted sender`)
        return { success: false, error: 'Request rejected' }
      }

      const parsed = schema.safeParse(mapArgs(args))
      if (!parsed.success) {
        const fields = parsed.error.issues.map(issue => issue.path.join('.')).join(', ')
        log.warn(`${channel}: invalid input parameters`, fields)
        return { success: false, error: 'Invalid input parameters' }
      }

      ensureDbInitialized()
      const input = parsed.data as z.infer<S>
      const clusterId = (input as { clusterId: string }).clusterId
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      const data = await run(client, input)
      return { success: true, data }
    } catch (error) {
      log.error(`${channel} failed`, formatError(error))
      return { success: false, error: formatError(error) }
    }
  })
}

/** 注册一个不需要 Admin 客户端的 IPC handler（仍做来源校验与错误兜底）。 */
export function registerHandler<T>(
  channel: string,
  run: (...args: any[]) => Promise<T>,
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<IpcResult<T>> => {
    try {
      if (!isTrustedSender(event)) {
        log.warn(`${channel}: rejected untrusted sender`)
        return { success: false, error: 'Request rejected' }
      }
      const data = await run(...args)
      return { success: true, data }
    } catch (error) {
      log.error(`${channel} failed`, formatError(error))
      return { success: false, error: formatError(error) }
    }
  })
}
