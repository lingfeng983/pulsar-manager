import {
  ipcMain,
  ensureDbInitialized,
  formatError,
  getAdminClient,
  validateClusterId,
} from './_shared'
import { updateCluster } from '../database/sqlite'

export function registerMetricsHandlers() {
  // 获取集群聚合统计
  ipcMain.handle('metrics:getAggregatedStats', async (_, clusterId) => {
    try {
      if (!validateClusterId(clusterId)) {
        return { success: false, error: 'Invalid cluster ID' }
      }

      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      const stats = await client.getAggregatedStats()

      // 更新集群状态为连接
      updateCluster(clusterId, { status: 'connected' })

      return { success: true, data: stats }
    } catch (error) {
      console.error('[IPC] metrics:getAggregatedStats error:', error)
      // 更新集群状态为断开
      updateCluster(clusterId, { status: 'disconnected' })
      return { success: false, error: formatError(error) }
    }
  })

  // 获取 Broker 列表
  ipcMain.handle('metrics:getBrokers', async (_, clusterId) => {
    try {
      if (!validateClusterId(clusterId)) {
        return { success: false, error: 'Invalid cluster ID' }
      }

      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      const brokers = await client.getBrokers()

      return { success: true, data: brokers }
    } catch (error) {
      console.error('[IPC] metrics:getBrokers error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  // 获取命名空间统计
  ipcMain.handle('metrics:getNamespaceStats', async (_, clusterId, tenant, namespace) => {
    try {
      if (!validateClusterId(clusterId)) {
        return { success: false, error: 'Invalid cluster ID' }
      }

      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      const stats = await client.getNamespaceStats(tenant, namespace)

      return { success: true, data: stats }
    } catch (error) {
      console.error('[IPC] metrics:getNamespaceStats error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  // 查询 metrics 指标
  ipcMain.handle('metrics:query', async (_, clusterId, query, range) => {
    try {
      if (!validateClusterId(clusterId)) {
        return { success: false, error: 'Invalid cluster ID' }
      }

      if (typeof query !== 'string' || query.trim() === '') {
        return { success: false, error: 'Invalid query parameter' }
      }

      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      const metrics = await client.getMetrics(query, range)

      return { success: true, data: metrics }
    } catch (error) {
      console.error('[IPC] metrics:query error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  // ========== 拓扑 ==========

  // 获取集群拓扑
  ipcMain.handle('topology:getClusterTopology', async (_, clusterId) => {
    try {
      if (!validateClusterId(clusterId)) {
        return { success: false, error: 'Invalid cluster ID' }
      }

      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      const topology = await client.getClusterTopology()

      return { success: true, data: topology }
    } catch (error) {
      console.error('[IPC] topology:getClusterTopology error:', error)
      return { success: false, error: formatError(error) }
    }
  })
}
