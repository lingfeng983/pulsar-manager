import {z, registerClientHandler, ClusterIdSchema, getClusterById} from './_shared';
import {listAlertEvents} from '../database/sqlite';
import {
    runInspection,
    renderInspectionMarkdown,
    INSPECTION_DEFAULTS,
    type InspectionAlertRow,
} from '../services/cluster-inspection';
import type {InspectionRunResult} from '../../shared/types';
import {createLogger} from '../utils/logger';

const log = createLogger('Inspection');

// 限额由渲染层传，但区间在这里钉死：巡检是最容易把一个 REST 客户端用成压力源的功能，
// 放开上限等于允许一次点击往 broker 打几千个请求。
const RunSchema = z.object({
    clusterId: ClusterIdSchema,
    maxNamespaces: z.number().int().min(1).max(200).optional(),
    maxTopics: z.number().int().min(1).max(1000).optional(),
});

function collectOpenAlerts(clusterId: string): InspectionAlertRow[] {
    // 只取这台集群的未恢复事件；上限 50 条足够列进报告，也不至于让证据行长到没人读
    return listAlertEvents({clusterId, state: 'firing', limit: 50}).map(event => ({
        ruleName: event.rule_name,
        scopeLabel: event.scope_label,
        message: event.message,
    }));
}

export function registerInspectionHandlers() {
    registerClientHandler(
        'inspection:run',
        RunSchema,
        ([input]) => input,
        async (client, params) => {
            const cluster = getClusterById(params.clusterId);
            if (!cluster) {
                throw new Error('Cluster not found');
            }
            // runInspection 内部逐段捕获：读不到的端点变成一条 skip 检查，
            // 而不是让整份报告以一个 404 收场。
            const report = await runInspection(client, {
                clusterId: params.clusterId,
                clusterName: cluster.name,
                alerts: collectOpenAlerts(params.clusterId),
                options: {
                    maxNamespaces: params.maxNamespaces ?? INSPECTION_DEFAULTS.maxNamespaces,
                    maxTopics: params.maxTopics ?? INSPECTION_DEFAULTS.maxTopics,
                },
            });
            log.info(
                `inspection ${params.clusterId}: crit=${report.totals.crit} warn=${report.totals.warn} ` +
                    `sampled=${report.scope.topicsSampled}`,
            );
            return {report, markdown: renderInspectionMarkdown(report)} satisfies InspectionRunResult;
        },
    );
}
