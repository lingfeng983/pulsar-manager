import {
  z,
  updateCluster,
  registerClientHandler,
  ClusterIdSchema,
  TenantPathSchema,
  NamespacePathSchema,
  TopicPathSchema,
  SubscriptionPathSchema,
  CreateSubscriptionSchema,
  ResetCursorSchema,
  SkipMessagesSchema,
} from './_shared'

const ClusterOnlySchema = z.object({ clusterId: ClusterIdSchema })

const TopicPathWithPersistenceSchema = TopicPathSchema.extend({
  persistent: z.boolean().optional().default(true),
})

const UpdateTopicConfigSchema = TopicPathWithPersistenceSchema.extend({
  config: z.record(z.unknown()),
})

export function registerResourceHandlers() {
  registerClientHandler(
    'resources:getTenants',
    ClusterOnlySchema,
    ([clusterId]) => ({ clusterId }),
    async (client, { clusterId }) => {
      try {
        const tenants = await client.getTenants()
        updateCluster(clusterId, { status: 'connected' })
        return tenants
      } catch (error) {
        updateCluster(clusterId, { status: 'disconnected' })
        throw error
      }
    },
  )

  registerClientHandler(
    'resources:getNamespaces',
    TenantPathSchema,
    ([clusterId, tenant]) => ({ clusterId, tenant }),
    (client, { tenant }) => client.getNamespaces(tenant),
  )

  registerClientHandler(
    'resources:getTopics',
    NamespacePathSchema,
    ([clusterId, tenant, namespace]) => ({ clusterId, tenant, namespace }),
    (client, { tenant, namespace }) => client.getTopics(tenant, namespace),
  )

  registerClientHandler(
    'resources:getTopicStats',
    TopicPathWithPersistenceSchema,
    ([clusterId, tenant, namespace, topic, persistent]) => ({
      clusterId,
      tenant,
      namespace,
      topic,
      persistent: persistent ?? true,
    }),
    (client, { tenant, namespace, topic, persistent }) =>
      client.getTopicStats(tenant, namespace, topic, persistent),
  )

  registerClientHandler(
    'resources:getTopicConfig',
    TopicPathWithPersistenceSchema,
    ([clusterId, tenant, namespace, topic, persistent]) => ({
      clusterId,
      tenant,
      namespace,
      topic,
      persistent: persistent ?? true,
    }),
    (client, { tenant, namespace, topic, persistent }) =>
      client.getTopicConfig(tenant, namespace, topic, persistent),
  )

  registerClientHandler(
    'resources:updateTopicConfig',
    UpdateTopicConfigSchema,
    ([clusterId, tenant, namespace, topic, config, persistent]) => ({
      clusterId,
      tenant,
      namespace,
      topic,
      config,
      persistent: persistent ?? true,
    }),
    (client, { tenant, namespace, topic, config, persistent }) =>
      client.updateTopicConfig(tenant, namespace, topic, config, persistent),
  )

  registerClientHandler(
    'resources:getSubscriptions',
    TopicPathSchema,
    ([clusterId, tenant, namespace, topic]) => ({ clusterId, tenant, namespace, topic }),
    (client, { tenant, namespace, topic }) => client.getSubscriptions(tenant, namespace, topic),
  )

  registerClientHandler(
    'resources:getTenantInfo',
    TenantPathSchema,
    ([clusterId, tenant]) => ({ clusterId, tenant }),
    (client, { tenant }) => client.getTenantInfo(tenant),
  )

  registerClientHandler(
    'resources:getNamespaceInfo',
    NamespacePathSchema,
    ([clusterId, tenant, namespace]) => ({ clusterId, tenant, namespace }),
    (client, { tenant, namespace }) => client.getNamespaceInfo(tenant, namespace),
  )

  registerClientHandler(
    'resources:createSubscription',
    CreateSubscriptionSchema,
    ([clusterId, tenant, namespace, topic, subscription, type]) => ({
      clusterId,
      tenant,
      namespace,
      topic,
      subscription,
      type,
    }),
    (client, { tenant, namespace, topic, subscription, type }) =>
      client.createSubscription(tenant, namespace, topic, subscription, type),
  )

  registerClientHandler(
    'resources:deleteSubscription',
    SubscriptionPathSchema,
    ([clusterId, tenant, namespace, topic, subscription]) => ({
      clusterId,
      tenant,
      namespace,
      topic,
      subscription,
    }),
    (client, { tenant, namespace, topic, subscription }) =>
      client.deleteSubscription(tenant, namespace, topic, subscription),
  )

  registerClientHandler(
    'resources:resetCursor',
    ResetCursorSchema,
    ([clusterId, tenant, namespace, topic, subscription, position, timestamp]) => ({
      clusterId,
      tenant,
      namespace,
      topic,
      subscription,
      position,
      timestamp,
    }),
    async (client, { tenant, namespace, topic, subscription, position, timestamp }) => {
      if (position === 'earliest') {
        return client.resetCursorToEarliest(tenant, namespace, topic, subscription)
      }
      if (position === 'latest') {
        return client.resetCursorToLatest(tenant, namespace, topic, subscription)
      }
      // 时间戳模式必须带有效时间戳，否则以前会什么都不做却返回成功
      if (!timestamp) {
        throw new Error('A timestamp is required when resetting the cursor by time')
      }
      return client.resetCursor(tenant, namespace, topic, subscription, timestamp)
    },
  )

  registerClientHandler(
    'resources:skipMessages',
    SkipMessagesSchema,
    ([clusterId, tenant, namespace, topic, subscription, count]) => ({
      clusterId,
      tenant,
      namespace,
      topic,
      subscription,
      count,
    }),
    (client, { tenant, namespace, topic, subscription, count }) =>
      client.skipMessages(tenant, namespace, topic, subscription, count),
  )

  registerClientHandler(
    'resources:deleteTopic',
    TopicPathSchema,
    ([clusterId, tenant, namespace, topic]) => ({ clusterId, tenant, namespace, topic }),
    (client, { tenant, namespace, topic }) => client.deleteTopic(tenant, namespace, topic),
  )
}
