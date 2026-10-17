import {z, registerClientHandler, registerHandler, ClusterIdSchema, getClusterById, getAdminClient} from './_shared';
import {
    deleteInspections,
    getInspectionById,
    getInspectionProfile,
    getInspectionSchedule,
    listInspections,
    listInspectionSchedules,
    upsertInspectionProfile,
    type InspectionProfileRecord,
} from '../database/sqlite';
import {
    diffAgainstPrevious,
    executeInspection,
    toInspectionHistoryRow,
    toInspectionProfile,
    toInspectionReport,
} from '../services/inspection-run';
import {
    bindInspectionSchedulerDeps,
    saveInspectionSchedule,
    toInspectionSchedule,
} from '../services/inspection-schedule';
import {buildFleetSummary, runFleetInspection} from '../services/inspection-summary';
import {FLEET_RUN_MAX_CLUSTERS} from '../../shared/inspection-summary';
import {resolveSampling, resolveThresholds} from '../services/inspection-profile';
import {sendToRenderer} from './stream';
import type {InspectionProfileDraft, InspectionRunResult, InspectionScheduleDraft} from '../../shared/types';
import {INSPECTION_FLEET_CHANNEL, INSPECTION_SCHEDULE_CHANNEL} from '../../shared/types';
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

const ScheduleGetSchema = z.object({clusterId: ClusterIdSchema}).strict();

// 间隔只在这里挡「是不是数字」，区间（30 分钟～7 天）与「填了 5 分钟」的拒绝都归
// resolveIntervalMinutes：那条规则要在自测里跑，也要在这条通道上用，分成两处写迟早一处松一处紧。
const ScheduleSaveSchema = z
    .object({
        clusterId: ClusterIdSchema,
        enabled: z.boolean().optional(),
        intervalMinutes: z.number().optional(),
        notifyOnCrit: z.boolean().optional(),
    })
    .strict();

// 一次列表最多 50 行。历史的价值在「最近几次怎么变的」，翻到第 51 条还没找到要的那份，
// 说明该清库而不是把上限调大。
const HISTORY_LIST_LIMIT = 50;

// 汇总的「一次跑几台」与采样上限同源：区间在这里钉死，越界是拒绝而不是夹住。
// 一台集群一次巡检就打几百个请求，放开台数等于允许一次点击打出去几万
const FleetRunSchema = z
    .object({
        limit: z.number().int().min(1).max(FLEET_RUN_MAX_CLUSTERS).optional(),
        maxNamespaces: z.number().int().min(1).max(200).optional(),
        maxTopics: z.number().int().min(1).max(1000).optional(),
    })
    .strict();

export function registerInspectionHandlers() {
    // 调度引擎不 import 这一层（这一层反过来 import 它的保存入口），所以「取客户端」与「下行推送」
    // 这两个能力在这里注入——与 alert-handlers 的 bindAlertEngineDeps 同一口径。
    bindInspectionSchedulerDeps({
        // 经 SSH 隧道 / K8s 转发的集群会在这里把本地转发建起来，失败当作「这一轮跳过」
        getClient: clusterId => getAdminClient(clusterId),
        publish: push => sendToRenderer(INSPECTION_SCHEDULE_CHANNEL, push),
    });

    registerClientHandler(
        'inspection:run',
        RunSchema,
        ([input]) => input,
        async (client, params) => {
            const cluster = getClusterById(params.clusterId);
            if (!cluster) {
                throw new Error('Cluster not found');
            }
            // 执行序列整份在 services/inspection-run.ts：手动与定时必须跑同一条路，
            // 否则定时那份报告会少掉环比、导出文本或抄进去的口径
            const result = await executeInspection({
                client,
                clusterId: params.clusterId,
                clusterName: cluster.name,
                source: 'manual',
                // 采样上限允许这一次单独覆盖：「这次只想扫前 10 个命名空间」是临时意图，
                // 不该写进这台集群的长期配置
                maxNamespaces: params.maxNamespaces,
                maxTopics: params.maxTopics,
            });
            return {
                report: result.report,
                markdown: result.markdown,
                diff: result.diff,
                source: 'manual' as const,
            } satisfies InspectionRunResult;
        },
    );

    registerHandler('inspection:history', async (params: unknown) => {
        const input = HistorySchema.parse(params);
        return listInspections(input.clusterId, input.limit ?? HISTORY_LIST_LIMIT).map(toInspectionHistoryRow);
    });

    registerHandler('inspection:detail', async (params: unknown) => {
        const {id} = DetailSchema.parse(params);
        const record = getInspectionById(id);
        if (!record) {
            throw new Error('这份巡检报告不存在，可能已被清理');
        }
        const report = toInspectionReport(record);
        // markdown 取库里那份原文而不是重新渲染：历史报告重渲染会用当前代码的文案，
        // 导出的文件与它当初存下来的样子就悄悄不一致了
        return {
            report,
            markdown: record.markdown,
            diff: diffAgainstPrevious(record, report),
            source: record.source,
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
        return record ? toInspectionProfile(record) : null;
    });

    registerHandler('inspection:profile:save', async (params: unknown) => {
        const input = ProfileSchema.parse(params) as InspectionProfileDraft;
        // 校验顺序是「先判口径合不合法，再落库」：resolveThresholds 会拒掉
        // 严重线低于关注线这类每个字段都合规、合起来让分级反过来的组合
        const thresholds = resolveThresholds(input.thresholds);
        const existing = getInspectionProfile(input.clusterId);
        const sampling = resolveSampling({
            maxNamespaces: input.maxNamespaces ?? (existing ? toInspectionProfile(existing).maxNamespaces : undefined),
            maxTopics: input.maxTopics ?? (existing ? toInspectionProfile(existing).maxTopics : undefined),
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
        return toInspectionProfile(record);
    });

    // 没配过调度同样返回 null：「这台集群没定过时」与「定过时但关着」是两句话，
    // 后者意味着 last_run_at 与 last_error 还有话要说
    registerHandler('inspection:schedule:get', async (params: unknown) => {
        const {clusterId} = ScheduleGetSchema.parse(params);
        const record = getInspectionSchedule(clusterId);
        return record ? toInspectionSchedule(record) : null;
    });

    registerHandler('inspection:schedule:save', async (params: unknown) => {
        const input = ScheduleSaveSchema.parse(params) as InspectionScheduleDraft;
        return saveInspectionSchedule(input);
    });

    // 列的是所有配过调度的集群（含关着的）：配置中心要说的是「哪些集群挂着自动巡检」，
    // 只列 enabled 的会让「刚存了但还没打开」那一行凭空消失
    registerHandler('inspection:schedule:list', async () => listInspectionSchedules().map(toInspectionSchedule));

    // 只读那份汇总：每台集群最近的一份报告，一次数据库查询都不碰 broker。
    // 数字因此可能已经是几小时前的，行上的「最近一次」与新鲜度就是为了让这件事看得见
    registerHandler('inspection:summary', async () => buildFleetSummary());

    registerHandler('inspection:summary:run', async (params: unknown) => {
        const input = FleetRunSchema.parse(params);
        // 串行逐台、每台一个进度：一屏集群挂着同一个「加载中」会让人猜跑到哪一台了
        return runFleetInspection({
            getClient: clusterId => getAdminClient(clusterId),
            publish: progress => sendToRenderer(INSPECTION_FLEET_CHANNEL, progress),
            limit: input.limit,
            maxNamespaces: input.maxNamespaces,
            maxTopics: input.maxTopics,
        });
    });
}
