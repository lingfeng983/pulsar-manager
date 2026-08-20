import {
  insertOperationLog,
  MessageBrowseSchema,
  MessageSendSchema,
  registerClientHandler,
} from './_shared'

export function registerMessageHandlers() {
  registerClientHandler(
    'messages:browse',
    MessageBrowseSchema,
    ([params]) => params,
    (client, { tenant, namespace, topic, subscription, count }) =>
      client.peekMessages(tenant, namespace, topic, subscription, count),
  )

  registerClientHandler(
    'messages:send',
    MessageSendSchema,
    ([params]) => params,
    async (client, { clusterId, tenant, namespace, topic, message, properties }) => {
      const result = await client.sendMessage(tenant, namespace, topic, message, properties)

      // Producer API 未启用等情况会返回 success: false，此时不应记为成功日志，
      // 也不应让上层以为消息已发出
      if (!result.success) {
        throw new Error(result.error || '发送失败')
      }

      insertOperationLog({
        cluster_id: clusterId,
        action: 'send',
        resource_type: 'message',
        resource_id: `${tenant}/${namespace}/${topic}`,
        resource_name: topic,
        details: `Sent message to ${tenant}/${namespace}/${topic}`,
        result: 'success',
      })

      return { messageId: result.messageId }
    },
  )
}
