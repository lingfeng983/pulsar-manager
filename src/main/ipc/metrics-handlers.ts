import {
    z,
    registerClientHandler,
    registerHandler,
    ensureDbInitialized,
    ClusterIdSchema,
    markClusterStatus,
} from './_shared';
import {cleanupMetricsSnapshots, insertMetricsSnapshot, listMetricsSnapshots} from '../database/sqlite';
import {readAppSettings} from '../services/app-config';

const ClusterOnlySchema = z.object({clusterId: ClusterIdSchema});

// 快照写入：数值来自渲染层这一轮已经采到的统计，时间戳一律用主进程的时钟——
// 渲染层的 Date.now() 与库里的其它行不必同源，混用会让趋势图的时间轴出现跳点。
const SnapshotSchema = z.object({
    clusterId: ClusterIdSchema,
    // 空串 = 集群总体口径（与 metrics_snapshots.topic_uri 的约定一致）
    topicUri: z.string().max(512).default(''),
    msgRateIn: z.number().finite().default(0),
    msgRateOut: z.number().finite().default(0),
    throughputIn: z.number().finite().default(0),
    throughputOut: z.number().finite().default(0),
    backlog: z.number().int().nonnegative().default(0),
    producers: z.number().int().nonnegative().default(0),
    consumers: z.number().int().nonnegative().default(0),
});

const SnapshotQuerySchema = z.object({
    clusterId: ClusterIdSchema,
    topicUri: z.string().max(512).default(''),
    hours: z
        .number()
        .int()
        .min(1)
        .max(24 * 90)
        .default(24),
    limit: z.number().int().min(1).max(20_000).default(5_000),
});

// 清理按保留天数走，但不必每个采样点都扫一遍表：写入节奏最快是秒级，
// 五次分钟一次的清理足够把旧行压住。
let lastPruneAt = 0;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

function pruneOldSnapshots(retentionDays: number): void {
    const now = Date.now();
    if (now - lastPruneAt < PRUNE_INTERVAL_MS) {
        return;
    }
    lastPruneAt = now;
    cleanupMetricsSnapshots(retentionDays);
}

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

    // ========== 时序留存 ==========

    registerHandler('metrics:recordSnapshot', async (params: unknown) => {
        const input = SnapshotSchema.parse(params);
        ensureDbInitialized();
        const settings = readAppSettings();
        // 开关是渲染层也读的，但真正决定落不落库的是这里：界面被绕过也拦得住
        if (!settings.metricsSnapshotEnabled) {
            return null;
        }
        insertMetricsSnapshot({
            cluster_id: input.clusterId,
            topic_uri: input.topicUri,
            msg_rate_in: input.msgRateIn,
            msg_rate_out: input.msgRateOut,
            throughput_in: input.throughputIn,
            throughput_out: input.throughputOut,
            backlog: input.backlog,
            producers: input.producers,
            consumers: input.consumers,
            captured_at: Date.now(),
        });
        pruneOldSnapshots(settings.metricsRetentionDays);
        return null;
    });

    registerHandler('metrics:listSnapshots', async (params: unknown) => {
        const {clusterId, topicUri, hours, limit} = SnapshotQuerySchema.parse(params);
        ensureDbInitialized();
        // 读取侧也清一次超期行：写入侧只在留存开着时清，用户关掉开关后
        // 已有的快照就再没有清理时机，留着只会让库一直变大
        cleanupMetricsSnapshots(readAppSettings().metricsRetentionDays);
        const rows = listMetricsSnapshots(clusterId, topicUri, Date.now() - hours * 3600 * 1000, limit);
        return rows.map(row => ({
            clusterId: row.cluster_id,
            topicUri: row.topic_uri,
            msgRateIn: row.msg_rate_in,
            msgRateOut: row.msg_rate_out,
            throughputIn: row.throughput_in,
            throughputOut: row.throughput_out,
            backlog: row.backlog,
            producers: row.producers,
            consumers: row.consumers,
            capturedAt: row.captured_at,
        }));
    });
}
