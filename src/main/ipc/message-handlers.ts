import {
  ipcMain,
  insertOperationLog,
  MessageBrowseSchema,
  MessageSendSchema,
  ensureDbInitialized,
  formatError,
  getAdminClient,
} from './_shared'

export function registerMessageHandlers() {
  ipcMain.handle('messages:browse', async (_, params) => {
    try {
      const validated = MessageBrowseSchema.safeParse(params)
      if (!validated.success) {
        console.warn('[IPC] messages:browse validation failed:', validated.error)
        return { success: false, error: 'Invalid input parameters' }
      }

      const { clusterId, tenant, namespace, topic, subscription, count } = validated.data

      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      const messages = await client.peekMessages(tenant, namespace, topic, subscription, count)

      return { success: true, data: messages }
    } catch (error) {
      console.error('[IPC] messages:browse error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('messages:send', async (_, params) => {
    try {
      const validated = MessageSendSchema.safeParse(params)
      if (!validated.success) {
        console.warn('[IPC] messages:send validation failed:', validated.error)
        return { success: false, error: 'Invalid input parameters' }
      }

      const { clusterId, tenant, namespace, topic, message, properties } = validated.data

      ensureDbInitialized()
      const client = getAdminClient(clusterId)
      if (!client) {
        return { success: false, error: 'Cluster not found' }
      }

      const result = await client.sendMessage(tenant, namespace, topic, message, properties)

      if (result.success) {
        // 记录操作日志
        insertOperationLog({
          cluster_id: clusterId,
          action: 'send',
          resource_type: 'message',
          resource_id: `${tenant}/${namespace}/${topic}`,
          resource_name: topic,
          details: `Sent message to ${tenant}/${namespace}/${topic}`,
          result: 'success',
        })
      }

      return result
    } catch (error) {
      console.error('[IPC] messages:send error:', error)
      return { success: false, error: formatError(error) }
    }
  })
}
