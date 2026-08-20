import { ipcMain } from 'electron'
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
} from '../database/sqlite'
import { encrypt, decrypt } from '../services/encryption'
import { PulsarAdminClient, clientManager } from '../services/pulsar-admin'

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

export const TopicSchema = z.string().min(1)

export const SubscriptionSchema = z.string().min(1)

export const TopicPathSchema = z.object({
  clusterId: ClusterIdSchema,
  tenant: TenantSchema,
  namespace: NamespaceSchema,
  topic: TopicSchema,
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
  if (!cluster) return null

  return clientManager.getClient(clusterId, {
    serviceUrl: cluster.service_url,
    webServiceUrl: cluster.web_service_url,
    timeout: cluster.admin_api_timeout,
    auth: cluster.auth_plugin
      ? { authPlugin: cluster.auth_plugin, authParams: decrypt(cluster.auth_params) }
      : undefined,
  })
}

// 关闭数据库
export function cleanupDatabase() {
  closeDatabase()
  dbInitialized = false
}
