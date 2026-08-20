import {
  ipcMain,
  uuidv4,
  getAllClusters,
  getClusterById,
  insertCluster,
  updateCluster,
  deleteCluster,
  insertOperationLog,
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
      console.error('[IPC] cluster:list error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('cluster:add', async (_, config) => {
    try {
      ensureDbInitialized()
      const validated = ClusterConfigSchema.parse(config)

      const id = uuidv4()
      const encrypted = encryptSensitiveFields(validated)

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

      // 记录操作日志
      insertOperationLog({
        cluster_id: id,
        action: 'create',
        resource_type: 'cluster',
        resource_id: id,
        resource_name: validated.name,
        result: 'success',
      })

      return {
        success: true,
        data: { id, ...validated },
      }
    } catch (error) {
      console.error('[IPC] cluster:add error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('cluster:update', async (_, id, config) => {
    try {
      ensureDbInitialized()
      const validated = ClusterConfigSchema.parse(config)
      const encrypted = encryptSensitiveFields(validated)

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

      // 记录操作日志
      insertOperationLog({
        cluster_id: id,
        action: 'update',
        resource_type: 'cluster',
        resource_id: id,
        resource_name: validated.name,
        result: 'success',
      })

      return { success: true, data: { id, ...validated } }
    } catch (error) {
      console.error('[IPC] cluster:update error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('cluster:delete', async (_, id) => {
    try {
      ensureDbInitialized()
      const cluster = getClusterById(id)

      // 先记录操作日志（在删除之前）
      if (cluster) {
        insertOperationLog({
          cluster_id: id,
          action: 'delete',
          resource_type: 'cluster',
          resource_id: id,
          resource_name: cluster.name,
          result: 'success',
        })
      }

      deleteCluster(id)

      // 清除客户端缓存
      clientManager.removeClient(id)

      return { success: true }
    } catch (error) {
      console.error('[IPC] cluster:delete error:', error)
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
      console.error('[IPC] cluster:testConnection error:', error)
      return { success: false, error: formatError(error) }
    }
  })
}
