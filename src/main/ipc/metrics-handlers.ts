import {z, registerClientHandler, ClusterIdSchema, markClusterStatus} from './_shared';

const ClusterOnlySchema = z.object({clusterId: ClusterIdSchema});

// 拓扑规模上限由渲染层按场景传入，服务端仍会与全局上限取较小值
const TopologySchema = z.object({
    clusterId: ClusterIdSchema,
    limits: z
        .object({
            maxTenants: z.number().int().positive().optional(),
            maxNamespacesPerTenant: z.number().int().positive().optional(),
            maxTopicsPerNamespace: z.number().int().positive().optional(),
            maxTopics: z.number().int().positive().optional(),
        })
        .optional()
        .nullable(),
});

export function registerMetricsHandlers() {
    // 获取集群聚合统计
    registerClientHandler(
        'metrics:getAggregatedStats',
        ClusterOnlySchema,
        ([clusterId]) => ({clusterId}),
        async (client, {clusterId}) => {
            try {
                const stats = await client.getAggregatedStats();
                markClusterStatus(clusterId, 'connected');
                return stats;
            } catch (error) {
                markClusterStatus(clusterId, 'disconnected');
                throw error;
            }
        },
    );

    // 获取 Broker 列表
    registerClientHandler(
        'metrics:getBrokers',
        ClusterOnlySchema,
        ([clusterId]) => ({clusterId}),
        client => client.getBrokers(),
    );

    // ========== 拓扑 ==========

    // 获取集群拓扑
    registerClientHandler(
        'topology:getClusterTopology',
        TopologySchema,
        ([clusterId, limits]) => ({clusterId, limits}),
        (client, {limits}) => client.getClusterTopology(limits ?? undefined),
    );
}
