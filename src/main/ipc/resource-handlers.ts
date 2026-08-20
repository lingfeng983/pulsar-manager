import {
  ipcMain,
  updateCluster,
  ensureDbInitialized,
  formatError,
  getAdminClient,
  validateTopicPath,
} from './_shared'

export function registerResourceHandlers() {
  ipcMain.handle('resources:getTenants', async (_, clusterId) => {
    try {
      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      const tenants = await client.getTenants()

      // 更新集群状态
      updateCluster(clusterId, { status: 'connected' })

      return { success: true, data: tenants }
    } catch (error) {
      console.error('[IPC] resources:getTenants error:', error)
      // 更新集群状态为断开
      updateCluster(clusterId, { status: 'disconnected' })
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('resources:getNamespaces', async (_, clusterId, tenant) => {
    try {
      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      const namespaces = await client.getNamespaces(tenant)

      return { success: true, data: namespaces }
    } catch (error) {
      console.error('[IPC] resources:getNamespaces error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('resources:getTopics', async (_, clusterId, tenant, namespace) => {
    try {
      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      const topics = await client.getTopics(tenant, namespace)

      return { success: true, data: topics }
    } catch (error) {
      console.error('[IPC] resources:getTopics error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('resources:getTopicStats', async (_, clusterId, tenant, namespace, topic, persistent = true) => {
    try {
      if (!validateTopicPath({ clusterId, tenant, namespace, topic })) {
        return { success: false, error: 'Invalid input parameters' }
      }

      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      const stats = await client.getTopicStats(tenant, namespace, topic, persistent)

      return { success: true, data: stats }
    } catch (error) {
      console.error('[IPC] resources:getTopicStats error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('resources:getTopicConfig', async (_, clusterId, tenant, namespace, topic, persistent = true) => {
    try {
      if (!validateTopicPath({ clusterId, tenant, namespace, topic })) {
        return { success: false, error: 'Invalid input parameters' }
      }

      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      const config = await client.getTopicConfig(tenant, namespace, topic, persistent)

      return { success: true, data: config }
    } catch (error) {
      console.error('[IPC] resources:getTopicConfig error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('resources:updateTopicConfig', async (_, clusterId, tenant, namespace, topic, config, persistent = true) => {
    try {
      if (!validateTopicPath({ clusterId, tenant, namespace, topic })) {
        return { success: false, error: 'Invalid input parameters' }
      }

      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      await client.updateTopicConfig(tenant, namespace, topic, config, persistent)

      return { success: true }
    } catch (error) {
      console.error('[IPC] resources:updateTopicConfig error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('resources:getSubscriptions', async (_, clusterId, tenant, namespace, topic) => {
    try {
      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      const subscriptions = await client.getSubscriptions(tenant, namespace, topic)

      return { success: true, data: subscriptions }
    } catch (error) {
      console.error('[IPC] resources:getSubscriptions error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('resources:getTenantInfo', async (_, clusterId, tenant) => {
    try {
      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      const tenantInfo = await client.getTenantInfo(tenant)

      return { success: true, data: tenantInfo }
    } catch (error) {
      console.error('[IPC] resources:getTenantInfo error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('resources:getNamespaceInfo', async (_, clusterId, tenant, namespace) => {
    try {
      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      const namespaceInfo = await client.getNamespaceInfo(tenant, namespace)

      return { success: true, data: namespaceInfo }
    } catch (error) {
      console.error('[IPC] resources:getNamespaceInfo error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('resources:createSubscription', async (_, clusterId, tenant, namespace, topic, name, type) => {
    try {
      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      await client.createSubscription(tenant, namespace, topic, name, type)

      return { success: true }
    } catch (error) {
      console.error('[IPC] resources:createSubscription error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('resources:deleteSubscription', async (_, clusterId, tenant, namespace, topic, name) => {
    try {
      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      await client.deleteSubscription(tenant, namespace, topic, name)

      return { success: true }
    } catch (error) {
      console.error('[IPC] resources:deleteSubscription error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('resources:resetCursor', async (_, clusterId, tenant, namespace, topic, subscription, position, timestamp) => {
    try {
      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      if (position === 'earliest') {
        await client.resetCursorToEarliest(tenant, namespace, topic, subscription)
      } else if (position === 'latest') {
        await client.resetCursorToLatest(tenant, namespace, topic, subscription)
      } else if (position === 'timestamp' && timestamp) {
        await client.resetCursor(tenant, namespace, topic, subscription, timestamp)
      }

      return { success: true }
    } catch (error) {
      console.error('[IPC] resources:resetCursor error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('resources:skipMessages', async (_, clusterId, tenant, namespace, topic, subscription, count) => {
    try {
      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      await client.skipMessages(tenant, namespace, topic, subscription, count)

      return { success: true }
    } catch (error) {
      console.error('[IPC] resources:skipMessages error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('resources:deleteTopic', async (_, clusterId, tenant, namespace, topic) => {
    try {
      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      await client.deleteTopic(tenant, namespace, topic)

      return { success: true }
    } catch (error) {
      console.error('[IPC] resources:deleteTopic error:', error)
      return { success: false, error: formatError(error) }
    }
  })
}
