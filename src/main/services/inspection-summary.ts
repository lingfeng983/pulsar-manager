import {
    getAllClusters,
    listInspectionSchedules,
    listLatestInspections,
    type InspectionLatestRow,
    type InspectionScheduleRecord,
} from '../database/sqlite';
import {executeInspection, toInspectionHistoryRow} from './inspection-run';
import {toInspectionSchedule} from './inspection-schedule';
import {
    compareFleetClusters,
    fleetFreshness,
    groupFleetChecks,
    resolveFleetLimit,
    summarizeFleet,
} from '../../shared/inspection-summary';
import type {
    InspectionCheck,
    InspectionFleetCluster,
    InspectionFleetFailure,
    InspectionFleetProgress,
    InspectionFleetRunResult,
    InspectionFleetSkipped,
    InspectionFleetSummary,
    InspectionSchedule,
} from '../../shared/types';
import type {PulsarAdminClient} from './pulsar-admin';
import {createLogger} from '../utils/logger';

const log = createLogger('InspectionFleet');

// 跨集群巡检汇总：把「每台集群自己最近的一份报告」摆成一屏，再把同一类严重项合并。
//
// 读的那一半不碰 broker——它只查库，所以打开页面永远是瞬时的，代价是数字可能已经是几小时前的，
// 因此每行都必须带上「最近一次」的时间与新鲜度，而不是只带计数。
// 跑的那一半复用 inspection-run 的 executeInspection：手点、定时、逐台必须走同一条路，
// 否则汇总里的行与单集群页面的报告会对不上。

function indexSchedules(records: InspectionScheduleRecord[]): Map<string, InspectionSchedule> {
    const byCluster = new Map<string, InspectionSchedule>();
    for (const record of records) {
        byCluster.set(record.cluster_id, toInspectionSchedule(record));
    }
    return byCluster;
}

/** 同一毫秒里手点一次、定时一次会出两行，按集群保留第一行而不是让汇总出现重复集群。 */
function indexLatest(rows: InspectionLatestRow[]): Map<string, InspectionLatestRow> {
    const byCluster = new Map<string, InspectionLatestRow>();
    for (const row of rows) {
        if (!byCluster.has(row.cluster_id)) {
            byCluster.set(row.cluster_id, row);
        }
    }
    return byCluster;
}

function parseChecks(row: InspectionLatestRow | undefined): InspectionCheck[] {
    if (!row) {
        return [];
    }
    try {
        return JSON.parse(row.checks_json) as InspectionCheck[];
    } catch {
        // 库里这一格被外部改坏过：这一台的分组信息当作没有，但不毁掉整屏汇总
        log.warn(`cluster ${row.cluster_id} checks_json 解析失败，按无检查项处理`);
        return [];
    }
}

/** 拼出汇总：一簇一行，没跑过的也占一行——「没人看过」本身就是汇总要报告的事。 */
export function buildFleetSummary(nowMs: number = Date.now()): InspectionFleetSummary {
    const latest = indexLatest(listLatestInspections());
    const schedules = indexSchedules(listInspectionSchedules());

    const clusters: InspectionFleetCluster[] = getAllClusters().map(cluster => {
        const row = latest.get(cluster.id);
        const schedule = schedules.get(cluster.id) ?? null;
        return {
            clusterId: cluster.id,
            // 报告行里那一份 cluster_name 只在有报告时存在：改名之后历史报告仍带旧名，
            // 但汇总这一行说的是「现在这台集群」，取当前集群表的 name
            clusterName: cluster.name,
            latest: row ? toInspectionHistoryRow(row) : null,
            checks: parseChecks(row),
            schedule,
            freshness: fleetFreshness(row ? {generatedAt: row.generated_at} : null, nowMs, schedule),
        };
    });

    clusters.sort((a, b) => compareFleetClusters(a, b, nowMs));

    return {
        generatedAt: new Date(nowMs).toISOString(),
        clusters,
        critGroups: groupFleetChecks(clusters),
        totals: summarizeFleet(clusters, nowMs),
        failures: [],
        skipped: [],
    };
}

export interface FleetRunArgs {
    /** 与巡检引擎同一个注入口径：服务层不 import ipc，客户端与推送由调用方给 */
    getClient: (clusterId: string) => Promise<PulsarAdminClient | null>;
    publish: (progress: InspectionFleetProgress) => void;
    /** 一次最多跑几台（主进程上限 20） */
    limit?: number;
    maxNamespaces?: number;
    maxTopics?: number;
}

/**
 * 逐台跑一遍巡检，然后按跑完的库重算汇总。
 *
 * 串行：一次巡检本身会按采样上限打几百个请求，并发跑等于把「一次点击的请求量」这个
 * 已经定死的前提悄悄乘以集群数。
 * 逐台捕获：一台连不上只让它进 failures，其余照常跑完——一份汇总不该因为一台集群关机而消失。
 */
export async function runFleetInspection(args: FleetRunArgs): Promise<InspectionFleetRunResult> {
    const limit = resolveFleetLimit(args.limit);
    const all = getAllClusters();
    const targets = all.slice(0, limit);
    const skipped: InspectionFleetSkipped[] = all.slice(limit).map(cluster => ({
        clusterId: cluster.id,
        clusterName: cluster.name,
    }));

    const failures: InspectionFleetFailure[] = [];
    let ran = 0;

    for (const [index, cluster] of targets.entries()) {
        args.publish({
            clusterId: cluster.id,
            clusterName: cluster.name,
            index,
            total: targets.length,
            status: 'started',
            totals: null,
            message: `正在巡检 ${cluster.name}`,
        });
        try {
            const client = await args.getClient(cluster.id);
            if (!client) {
                throw new Error('集群已不存在');
            }
            const result = await executeInspection({
                client,
                clusterId: cluster.id,
                clusterName: cluster.name,
                source: 'manual',
                maxNamespaces: args.maxNamespaces,
                maxTopics: args.maxTopics,
            });
            ran += 1;
            args.publish({
                clusterId: cluster.id,
                clusterName: cluster.name,
                index,
                total: targets.length,
                status: 'done',
                totals: result.report.totals,
                message:
                    `${cluster.name}：严重 ${result.report.totals.crit} 项、` +
                    `关注 ${result.report.totals.warn} 项、未覆盖 ${result.report.totals.skip} 项`,
            });
        } catch (error) {
            // 另一轮（定时或另一台手点）正占着这台集群时也会到这里：跳过这一台，
            // 它的旧报告仍在汇总里，新鲜度会说明那份有多旧
            const message = error instanceof Error ? error.message : String(error);
            failures.push({clusterId: cluster.id, clusterName: cluster.name, message});
            args.publish({
                clusterId: cluster.id,
                clusterName: cluster.name,
                index,
                total: targets.length,
                status: 'failed',
                totals: null,
                message: `${cluster.name}：${message}`,
            });
            log.warn(`fleet inspection failed for ${cluster.id}: ${message}`);
        }
    }

    // 跑完之后按新的库重算：这一行不能省，否则界面上要自己再把每台的结果拼一遍，
    // 而拼出来的口径会和单集群页那份报告对不上。
    // 跑坏的那台保留它旧的那一份报告，由 failures 说明「这一轮没跑成」——
    // 直接把它的行抹掉会让人以为这台集群消失了
    const summary = buildFleetSummary(Date.now());
    summary.failures = failures;
    summary.skipped = skipped;

    return {summary, ran, failed: failures.length};
}
