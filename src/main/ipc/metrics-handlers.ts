import {
  z,
  registerClientHandler,
  ClusterIdSchema,
  NamespacePathSchema,
} from './_shared'
import { updateCluster } from '../database/sqlite'

const ClusterOnlySchema = z.object({ clusterId: ClusterIdSchema })

const MetricsQuerySchema = z.object({
  clusterId: ClusterIdSchema,
  query: z.string().trim().min(1),
  range: z
    .object({ start: z.number(), end: z.number() })
    .optional()
    .nullable(),
})

export function registerMetricsHandlers() {
  // 获取集群聚合统计
  registerClientHandler(
    'metrics:getAggregatedStats',
    ClusterOnlySchema,
    ([clusterId]) => ({ clusterId }),
    async (client, { clusterId }) => {
      try {
        const stats = await client.getAggregatedStats()
        updateCluster(clusterId, { status: 'connected' })
        return stats
      } catch (error) {
        updateCluster(clusterId, { status: 'disconnected' })
        throw error
      }
    },
  )

  // 获取 Broker 列表
  registerClientHandler(
    'metrics:getBrokers',
    ClusterOnlySchema,
    ([clusterId]) => ({ clusterId }),
    client => client.getBrokers(),
  )

  // 获取命名空间统计
  registerClientHandler(
    'metrics:getNamespaceStats',
    NamespacePathSchema,
    ([clusterId, tenant, namespace]) => ({ clusterId, tenant, namespace }),
    (client, { tenant, namespace }) => client.getNamespaceStats(tenant, namespace),
  )

  // 查询 metrics 指标
  registerClientHandler(
    'metrics:query',
    MetricsQuerySchema,
    ([clusterId, query, range]) => ({ clusterId, query, range }),
    (client, { query, range }) =>
      client.getMetrics(query, (range ?? undefined) as { start: number; end: number } | undefined),
  )

  // ========== 拓扑 ==========

  // 获取集群拓扑
  registerClientHandler(
    'topology:getClusterTopology',
    ClusterOnlySchema,
    ([clusterId]) => ({ clusterId }),
    client => client.getClusterTopology(),
  )
}