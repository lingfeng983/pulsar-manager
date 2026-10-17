import {randomUUID} from 'crypto';
import {z, registerClientHandler, registerHandler, ClusterIdSchema, getClusterById} from './_shared';
import {
    deleteInspections,
    getInspectionById,
    getInspectionProfile,
    getPreviousInspection,
    insertInspection,
    listAlertEvents,
    listInspections,
    pruneInspections,
    upsertInspectionProfile,
    type InspectionListRow,
    type InspectionProfileRecord,
    type InspectionRecord,
} from '../database/sqlite';
import {runInspection, renderInspectionMarkdown, type InspectionAlertRow} from '../services/cluster-inspection';
import {resolveSampling, resolveThresholds} from '../services/inspection-profile';
import {buildInspectionDiff} from '../services/inspection-diff';
import type {
    InspectionCheck,
    InspectionHistoryRow,
    InspectionProfile,
    InspectionReport,
    InspectionRunResult,
    InspectionScope,
    InspectionThresholds,
} from '../../shared/types';
import {createLogger} from '../utils/logger';

const log = createLogger('Inspection');

// 限额由渲染层传，但区间在这里钉死：巡检是最容易把一个 REST 客户端用成压力源的功能，
// 放开上限等于允许一次点击往 broker 打几千个请求。
const RunSchema = z.object({
    clusterId: ClusterIdSchema,
    maxNamespaces: z.number().int().min(1).max(200).optional(),
    maxTopics: z.number().int().min(1).max(1000).optional(),
});

const HistorySchema = z.object({
    clusterId: ClusterIdSchema,
    limit: z.number().int().min(1).max(200).optional(),
});

const DetailSchema = z.object({id: z.string().uuid()});

// 六个阈值在这里只认「是不是这几个名字、是不是数字」，区间与互相矛盾的组合
// 交给 resolveThresholds 判：那套规则要在自测里跑，也要在这条通道上用，
// 分成两处写迟早一处放宽一处收紧。未知字段用 strict 挡掉——静默丢一个拼错的键，
// 用户会以为自己已经把严重线改小了。
const ThresholdDraftSchema = z
    .object({
        backlogWarn: z.number().nullable().optional(),
        backlogCrit: z.number().nullable().optional(),
        unackedWarn: z.number().nullable().optional(),
        rateRatio: z.number().nullable().optional(),
        rateMinIn: z.number().nullable().optional(),
        detailTopN: z.number().nullable().optional(),
    })
    .strict();

const ProfileSchema = z
    .object({
        clusterId: ClusterIdSchema,
        thresholds: ThresholdDraftSchema.optional(),
        maxNamespaces: z.number().optional(),
        maxTopics: z.number().optional(),
    })
    .strict();

// 每簇保留的报告份数。历史的价值在「最近几次怎么变的」，不在归档：
// 一次报告几十 KB 不算大，但没人会读第 200 次巡检，留着只是让列表翻不到有用的那几条。
const HISTORY_KEEP = 30;
const HISTORY_LIST_LIMIT = 50;

function collectOpenAlerts(clusterId: string): InspectionAlertRow[] {
    // 只取这台集群的未恢复事件；上限 50 条足够列进报告，也不至于让证据行长到没人读
    return listAlertEvents({clusterId, state: 'firing', limit: 50}).map(event => ({
        ruleName: event.rule_name,
        scopeLabel: event.scope_label,
        message: event.message,
    }));
}

/** 库里存的 JSON 复原成报告。解析失败当作数据被外部改过处理，直接抛而不是渲染半份报告。 */
function toReport(record: InspectionRecord): InspectionReport {
    return {
        clusterId: record.cluster_id,
        clusterName: record.cluster_name,
        generatedAt: record.generated_at,
        version: record.version ?? null,
        scope: JSON.parse(record.scope_json) as InspectionScope,
        checks: JSON.parse(record.checks_json) as InspectionCheck[],
        totals: {ok: record.ok, warn: record.warn, crit: record.crit, skip: record.skip},
        // null 就是没有：v2.8 的报告按当时的代码只可能是默认口径，但这句话是推出来的不是记下来的，
        // 所以宁可留空，让环比放弃「口径没变」这个结论
        thresholds: record.thresholds_json ? (JSON.parse(record.thresholds_json) as InspectionThresholds) : undefined,
    };
}

function toHistoryRow(row: InspectionListRow): InspectionHistoryRow {
    return {
        id: row.id,
        clusterId: row.cluster_id,
        clusterName: row.cluster_name,
        generatedAt: row.generated_at,
        version: row.version ?? null,
        totals: {ok: row.ok, warn: row.warn, crit: row.crit, skip: row.skip},
        scope: JSON.parse(row.scope_json) as InspectionScope,
    };
}

function toProfile(record: InspectionProfileRecord): InspectionProfile {
    return {
        clusterId: record.cluster_id,
        thresholds: JSON.parse(record.thresholds_json) as InspectionThresholds,
        maxNamespaces: record.max_namespaces,
        maxTopics: record.max_topics,
        updatedAt: record.updated_at,
    };
}

/** 这份报告相对它前一份的环比；库里没有前一份时返回 null（第一次跑没有可比对象）。 */
function diffAgainstPrevious(record: InspectionRecord, current: InspectionReport) {
    const previous = getPreviousInspection(record.cluster_id, record.generated_at, record.id);
    if (!previous) {
        return null;
    }
    const previousReport = toReport(previous);
    return buildInspectionDiff(previous.id, previousReport.generatedAt, previousReport.checks, current.checks, {
        previous: previousReport.thresholds ?? null,
        current: current.thresholds ?? null,
    });
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
            // 口径按集群取，没配过就是默认。采样上限允许这一次单独覆盖：
            // 「这次只想扫前 10 个命名空间」是临时意图，不该写进这台集群的长期配置。
            const stored = getInspectionProfile(params.clusterId);
            const profile = stored ? toProfile(stored) : null;
            const sampling = resolveSampling({
                maxNamespaces: params.maxNamespaces ?? profile?.maxNamespaces,
                maxTopics: params.maxTopics ?? profile?.maxTopics,
            });
            // runInspection 内部逐段捕获：读不到的端点变成一条 skip 检查，
            // 而不是让整份报告以一个 404 收场。
            const report = await runInspection(client, {
                clusterId: params.clusterId,
                clusterName: cluster.name,
                alerts: collectOpenAlerts(params.clusterId),
                options: sampling,
                thresholds: profile?.thresholds,
            });
            const record: InspectionRecord = {
                id: randomUUID(),
                cluster_id: params.clusterId,
                // 名字按当时刻意抄一份进记录：集群后来改名不该让历史列表里的报告变成新名字
                cluster_name: cluster.name,
                version: report.version,
                generated_at: report.generatedAt,
                crit: report.totals.crit,
                warn: report.totals.warn,
                ok: report.totals.ok,
                skip: report.totals.skip,
                scope_json: JSON.stringify(report.scope),
                checks_json: JSON.stringify(report.checks),
                thresholds_json: JSON.stringify(report.thresholds),
                markdown: '',
            };
            const diff = diffAgainstPrevious(record, report);
            // 环比写进导出的文件而不是只留在界面上：报告发出去之后，
            // 读到的人只有这一份文件，"积压比上次涨了 20 倍"这句话不能只在这台机器上看得到
            record.markdown = renderInspectionMarkdown(report, diff);
            insertInspection(record);
            const removed = pruneInspections(params.clusterId, HISTORY_KEEP);
            log.info(
                `inspection ${params.clusterId}: crit=${report.totals.crit} warn=${report.totals.warn} ` +
                    `sampled=${report.scope.topicsSampled} diff=${diff ? diff.changedCount : 'none'}`,
            );
            if (removed) {
                log.info(`inspection ${params.clusterId}: pruned ${removed} older reports`);
            }
            return {report, markdown: record.markdown, diff} satisfies InspectionRunResult;
        },
    );

    registerHandler('inspection:history', async (params: unknown) => {
        const input = HistorySchema.parse(params);
        return listInspections(input.clusterId, input.limit ?? HISTORY_LIST_LIMIT).map(toHistoryRow);
    });

    registerHandler('inspection:detail', async (params: unknown) => {
        const {id} = DetailSchema.parse(params);
        const record = getInspectionById(id);
        if (!record) {
            throw new Error('这份巡检报告不存在，可能已被清理');
        }
        const report = toReport(record);
        // markdown 取库里那份原文而不是重新渲染：历史报告重渲染会用当前代码的文案，
        // 导出的文件与它当初存下来的样子就悄悄不一致了
        return {
            report,
            markdown: record.markdown,
            diff: diffAgainstPrevious(record, report),
        } satisfies InspectionRunResult;
    });

    registerHandler('inspection:clear', async (params: unknown) => {
        const input = HistorySchema.parse(params);
        return deleteInspections(input.clusterId);
    });

    // 没配过就返回 null 而不是替它造一份默认口径：界面上「这台集群没改过判定线」
    // 与「这台集群的判定线恰好等于默认值」是两句话，后者会让人以为有人配过
    registerHandler('inspection:profile:get', async (params: unknown) => {
        const input = ProfileSchema.parse(params);
        const record = getInspectionProfile(input.clusterId);
        return record ? toProfile(record) : null;
    });

    registerHandler('inspection:profile:save', async (params: unknown) => {
        const input = ProfileSchema.parse(params);
        // 校验顺序是「先判口径合不合法，再落库」：resolveThresholds 会拒掉
        // 严重线低于关注线这类每个字段都合规、合起来让分级反过来的组合
        const thresholds = resolveThresholds(input.thresholds);
        const existing = getInspectionProfile(input.clusterId);
        const sampling = resolveSampling({
            maxNamespaces: input.maxNamespaces ?? (existing ? toProfile(existing).maxNamespaces : undefined),
            maxTopics: input.maxTopics ?? (existing ? toProfile(existing).maxTopics : undefined),
        });
        const record: InspectionProfileRecord = {
            cluster_id: input.clusterId,
            thresholds_json: JSON.stringify(thresholds),
            max_namespaces: sampling.maxNamespaces,
            max_topics: sampling.maxTopics,
            updated_at: new Date().toISOString(),
        };
        upsertInspectionProfile(record);
        log.info(`inspection profile ${input.clusterId}: thresholds 已保存`);
        return toProfile(record);
    });
}
