import {
  ipcMain,
  uuidv4,
  getAllClusters,
  getClusterById,
  insertCluster,
  updateCluster,
  deleteCluster,
  insertOperationLog,
  runInTransaction,
  PulsarAdminClient,
  clientManager,
  ClusterConfigSchema,
  ClusterTestSchema,
  ensureDbInitialized,
  encryptSensitiveFields,
  decryptSensitiveFields,
  normalizeCluster,
  formatError,
} from './_shared'
import { createLogger } from '../utils/logger'

const log = createLogger('IPC')

export function registerClusterHandlers() {
  ipcMain.handle('cluster:list', async () => {
    try {
      ensureDbInitialized()
      const clusters = getAllClusters()
      return {
        success: true,
        data: clusters.map(normalizeCluster).map(decryptSensitiveFields),
      }
    } catch (error) {
      log.error('cluster:list failed', formatError(error))
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('cluster:add', async (_, config) => {
    try {
      ensureDbInitialized()
      const validated = ClusterConfigSchema.parse(config)

      const id = uuidv4()
      const encrypted = encryptSensitiveFields(validated)

      // 集群记录与操作日志必须一起提交，避免出现只写了一半的状态
      runInTransaction(() => {
        insertCluster({
          id,
          name: encrypted.name,
          service_url: encrypted.serviceUrl,
          web_service_url: encrypted.webServiceUrl,
          auth_plugin: encrypted.authPlugin,
          auth_params: encrypted.authParams,
          tls_enabled: encrypted.tlsEnabled ? 1 : 0,
          tls_trust_certs: encrypted.tlsTrustCerts,
          use_ssh_tunnel: encrypted.useSshTunnel ? 1 : 0,
          ssh_config_id: encrypted.sshConfigId,
          admin_api_timeout: encrypted.adminApiTimeout || 5000,
          status: 'disconnected',
        })

        insertOperationLog({
          cluster_id: id,
          action: 'create',
          resource_type: 'cluster',
          resource_id: id,
          resource_name: validated.name,
          result: 'success',
        })
      })

      return {
        success: true,
        data: { id, ...validated },
      }
    } catch (error) {
      log.error('cluster:add failed', formatError(error))
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('cluster:update', async (_, id, config) => {
    try {
      ensureDbInitialized()
      const validated = ClusterConfigSchema.parse(config)
      const encrypted = encryptSensitiveFields(validated)

      runInTransaction(() => {
        updateCluster(id, {
          name: encrypted.name,
          service_url: encrypted.serviceUrl,
          web_service_url: encrypted.webServiceUrl,
          auth_plugin: encrypted.authPlugin,
          auth_params: encrypted.authParams,
          tls_enabled: encrypted.tlsEnabled ? 1 : 0,
          tls_trust_certs: encrypted.tlsTrustCerts,
          use_ssh_tunnel: encrypted.useSshTunnel ? 1 : 0,
          ssh_config_id: encrypted.sshConfigId,
          admin_api_timeout: encrypted.adminApiTimeout || 5000,
        })

        insertOperationLog({
          cluster_id: id,
          action: 'update',
          resource_type: 'cluster',
          resource_id: id,
          resource_name: validated.name,
          result: 'success',
        })
      })

      // 必须丢弃缓存的客户端，否则后续请求仍使用旧的地址、凭据和超时设置
      clientManager.removeClient(id)

      return { success: true, data: { id, ...validated } }
    } catch (error) {
      log.error('cluster:update failed', formatError(error))
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('cluster:delete', async (_, id) => {
    try {
      ensureDbInitialized()
      const cluster = getClusterById(id)

      runInTransaction(() => {
        deleteCluster(id)

        if (cluster) {
          insertOperationLog({
            cluster_id: null,
            action: 'delete',
            resource_type: 'cluster',
            resource_id: id,
            resource_name: cluster.name,
            result: 'success',
          })
        }
      })

      // 清除客户端缓存
      clientManager.removeClient(id)

      return { success: true }
    } catch (error) {
      log.error('cluster:delete failed', formatError(error))
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('cluster:testConnection', async (_, config) => {
    try {
      const validated = ClusterTestSchema.parse(config)

      // 创建临时客户端测试连接
      const client = new PulsarAdminClient({
        serviceUrl: validated.serviceUrl,
        webServiceUrl: validated.webServiceUrl,
        timeout: validated.adminApiTimeout || 5000,
        auth: validated.authPlugin
          ? { authPlugin: validated.authPlugin, authParams: validated.authParams }
          : undefined,
      })

      const result = await client.testConnection()

      // 清理临时客户端
      client.destroy()

      if (!result.connected) {
        return {
          success: false,
          error: '无法连接到 Pulsar 集群，请检查服务地址和认证配置',
        }
      }

      return {
        success: true,
        data: { connected: result.connected, version: result.version },
      }
    } catch (error) {
      log.error('cluster:testConnection failed', formatError(error))
      return { success: false, error: formatError(error) }
    }
  })
}
