import {randomUUID} from 'crypto';
import {
    getInspectionProfile,
    getPreviousInspection,
    insertInspection,
    listAlertEvents,
    pruneInspections,
    type InspectionListRow,
    type InspectionProfileRecord,
    type InspectionRecord,
} from '../database/sqlite';
import {renderInspectionMarkdown, runInspection, type InspectionAlertRow} from './cluster-inspection';
import {dispatchQuietly} from './notify-dispatch';
import {resolveSampling} from './inspection-profile';
import {buildInspectionDiff} from './inspection-diff';
import {INSPECTION_HISTORY_KEEP} from '../../shared/inspection-schedule';
import type {
    InspectionCheck,
    InspectionDiff,
    InspectionHistoryRow,
    InspectionProfile,
    InspectionReport,
    InspectionScope,
    InspectionSource,
    InspectionThresholds,
} from '../../shared/types';
import type {PulsarAdminClient} from './pulsar-admin';
import {createLogger} from '../utils/logger';

const log = createLogger('InspectionRun');

// 一次巡检的完整序列——取数、判定、落库、环比、渲染导出文本——只写在这一份。
//
// 手点与定时必须走同一条路：两边各写一遍的话，定时跑出来的报告会少一截（少了 markdown、
// 少了环比、甚至少了 thresholds 的抄写），而这些恰恰是历史回看与导出的全部依据。
// 本模块不 import ipc/_shared，客户端由调用方取好传进来（与 alert-engine 的 deps 同一口径）。

/** 库里存的 JSON 复原成报告。解析失败当作数据被外部改过处理，直接抛而不是渲染半份报告。 */
export function toInspectionReport(record: InspectionRecord): InspectionReport {
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

export function toInspectionHistoryRow(row: InspectionListRow): InspectionHistoryRow {
    return {
        id: row.id,
        clusterId: row.cluster_id,
        clusterName: row.cluster_name,
        generatedAt: row.generated_at,
        version: row.version ?? null,
        totals: {ok: row.ok, warn: row.warn, crit: row.crit, skip: row.skip},
        scope: JSON.parse(row.scope_json) as InspectionScope,
        // 老库的列由 v13 迁移补成 manual：那个版本没有定时这条路，这个推断有依据
        source: row.source,
    };
}

export function toInspectionProfile(record: InspectionProfileRecord): InspectionProfile {
    return {
        clusterId: record.cluster_id,
        thresholds: JSON.parse(record.thresholds_json) as InspectionThresholds,
        maxNamespaces: record.max_namespaces,
        maxTopics: record.max_topics,
        updatedAt: record.updated_at,
    };
}

/** 这份报告相对它前一份的环比；库里没有前一份时返回 null（第一次跑没有可比对象）。 */
export function diffAgainstPrevious(
    record: InspectionRecord,
    current: InspectionReport,
    previous?: InspectionRecord | null,
): InspectionDiff | null {
    const row =
        previous === undefined ? getPreviousInspection(record.cluster_id, record.generated_at, record.id) : previous;
    if (!row) {
        return null;
    }
    const previousReport = toInspectionReport(row);
    return buildInspectionDiff(row.id, previousReport.generatedAt, previousReport.checks, current.checks, {
        previous: previousReport.thresholds ?? null,
        current: current.thresholds ?? null,
    });
}

/** 只取这台集群的未恢复事件；上限 50 条足够列进报告，也不至于让证据行长到没人读。 */
function collectOpenAlerts(clusterId: string): InspectionAlertRow[] {
    return listAlertEvents({clusterId, state: 'firing', limit: 50}).map(event => ({
        ruleName: event.rule_name,
        scopeLabel: event.scope_label,
        message: event.message,
    }));
}

export interface ExecuteInspectionArgs {
    client: PulsarAdminClient;
    clusterId: string;
    /** 名字按当时刻意抄一份进记录：集群后来改名不该让历史列表里的报告变成新名字。 */
    clusterName: string;
    source: InspectionSource;
    /** 本次单独的采样上限覆盖：「这次只想扫前 10 个命名空间」是临时意图，不写进长期配置。 */
    maxNamespaces?: number;
    maxTopics?: number;
}

/**
 * 手动（含逐台汇总）跑完一次之后，要不要把这份报告也推给外部渠道。
 *
 * 定时的每一轮有 inspection-schedule 那套「与上次比是否恶化」的判断和 last_notified_crit
 * 作为依据，手动这几格都不在（它不属于任何调度周期）。这里用的是同一件事最朴素的版本：
 * 只在「这一次比上次多出了严重项」时开口——上次也是同样的 N 项就不再发一遍，
 * 否则一个人连点三次巡检按钮就往值班群发三封一样的邮件。
 *
 * 不发明「恢复」这一种：手点的一次性动作没有「开始盯着这件事」的含义，
 * 恢复由定时那一轮或告警规则的 resolve 来说，两边混着发只会让人分不清哪句话算数。
 */
function dispatchManualInspection(
    source: InspectionSource,
    clusterName: string,
    report: InspectionReport,
    previous: InspectionRecord | null,
): void {
    // 定时那一轮在 inspection-schedule 里自己发（它按跨轮次的级别变化判触发/加重/恢复），
    // 这里再发一次，同一次巡检就会在群里出现两条口径不同的消息
    if (source !== 'manual') {
        return;
    }
    if (report.totals.crit <= 0) {
        return;
    }
    const before = previous?.crit ?? 0;
    if (before >= report.totals.crit) {
        return;
    }
    const items = report.checks
        .filter(item => item.level === 'crit')
        .slice(0, 5)
        .map(item => `· ${item.title}：${item.summary}`)
        .join('\n');
    const head =
        before > 0 ? `严重项从 ${before} 项增加到 ${report.totals.crit} 项` : `有 ${report.totals.crit} 项严重`;
    dispatchQuietly({
        kind: 'inspectionCrit',
        level: 'crit',
        title: `巡检（手动）：${head}`,
        text: `${clusterName}：这一轮手动巡检${head}。\n${items}`,
        clusterId: report.clusterId,
        clusterName,
        atMs: Date.now(),
    });
}

// 一台集群同时只允许一次巡检在跑。手动连点两次与「定时正好撞上手动」都会把采样上限
// 变成两倍的请求量，而巡检的采样上限本来就是照着「一次点击最多打多少请求」定的——
// 叠两轮就等于悄悄把这个上限翻了一倍。
const inFlight = new Set<string>();

/**
 * 跑一次巡检并把它落成一份历史报告。
 *
 * runInspection 内部逐段捕获：读不到的端点变成一条 skip 检查，而不是让整份报告以一个 404 收场，
 * 所以这里不再包 try——一个坏 topic 不该让一个定时周期白跑。
 */
export async function executeInspection(args: ExecuteInspectionArgs): Promise<{
    report: InspectionReport;
    markdown: string;
    diff: InspectionDiff | null;
    pruned: number;
}> {
    if (inFlight.has(args.clusterId)) {
        throw new Error('这台集群已有一次巡检在进行中，等它跑完再发起下一次');
    }
    inFlight.add(args.clusterId);
    try {
        return await runOnce(args);
    } finally {
        inFlight.delete(args.clusterId);
    }
}

async function runOnce(args: ExecuteInspectionArgs): Promise<{
    report: InspectionReport;
    markdown: string;
    diff: InspectionDiff | null;
    pruned: number;
}> {
    const stored = getInspectionProfile(args.clusterId);
    const profile = stored ? toInspectionProfile(stored) : null;
    const sampling = resolveSampling({
        maxNamespaces: args.maxNamespaces ?? profile?.maxNamespaces,
        maxTopics: args.maxTopics ?? profile?.maxTopics,
    });
    const report = await runInspection(args.client, {
        clusterId: args.clusterId,
        clusterName: args.clusterName,
        alerts: collectOpenAlerts(args.clusterId),
        options: sampling,
        thresholds: profile?.thresholds,
    });
    const record: InspectionRecord = {
        id: randomUUID(),
        cluster_id: args.clusterId,
        cluster_name: args.clusterName,
        version: report.version,
        generated_at: report.generatedAt,
        crit: report.totals.crit,
        warn: report.totals.warn,
        ok: report.totals.ok,
        skip: report.totals.skip,
        scope_json: JSON.stringify(report.scope),
        checks_json: JSON.stringify(report.checks),
        thresholds_json: JSON.stringify(report.thresholds),
        source: args.source,
        markdown: '',
    };
    // 环比写进导出的文件而不是只留在界面上：报告发出去之后，读到的人只有这一份文件，
    // 「积压比上次涨了 20 倍」这句话不能只在这台机器上看得到
    const previous = getPreviousInspection(args.clusterId, report.generatedAt, record.id);
    const diff = diffAgainstPrevious(record, report, previous);
    record.markdown = renderInspectionMarkdown(report, diff);
    insertInspection(record);
    const pruned = pruneInspections(args.clusterId, INSPECTION_HISTORY_KEEP);
    dispatchManualInspection(args.source, args.clusterName, report, previous);
    log.info(
        `inspection ${args.clusterId} (${args.source}): crit=${report.totals.crit} warn=${report.totals.warn} ` +
            `sampled=${report.scope.topicsSampled} diff=${diff ? diff.changedCount : 'none'} pruned=${pruned}`,
    );
    return {report, markdown: record.markdown, diff, pruned};
}
