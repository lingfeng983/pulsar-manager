/**
 * 跨集群巡检汇总的纯逻辑：新鲜度怎么判、谁该排在最上面、同一类严重项怎么合并、
 * 整份汇总导出成文本时哪些话必须说。
 *
 * 放在 shared 与 inspection-caliber / inspection-schedule 同一个理由：这些判定决定了
 * 「一眼看过去先处理哪台集群」，而它们必须在没有集群、没有窗口的机器上被
 * scripts/inspection-summary-selftest.cjs 逐条证伪。汇总页最容易犯的错是把
 * 「每台集群各自最近的一份报告」读成「同一时刻的全局快照」，所以这里的排序、分组
 * 与导出文案都把这件事当成首要敌人。
 */
import type {
    FleetSection,
    InspectionFleetCluster,
    InspectionFleetGroup,
    InspectionFleetSummary,
    InspectionFleetTotals,
    InspectionSchedule,
    InspectionScope,
    InspectionSource,
} from './types';

/**
 * 没开定时时用来判新鲜度的窗口：24 小时。
 *
 * 为什么不全局写死一个数：一台把间隔配成 7 天的集群按 24 小时判会永远显示「太久没看」，
 * 于是这个标签从此没有信息量——用户看到的是一屏过期，真实情况是他自己把节奏调慢了。
 * 所以开了定时的集群用他自己的间隔当窗口。
 */
export const FLEET_DEFAULT_WINDOW_MS = 24 * 60 * 60_000;

/** 超过窗口但不到 3 倍只算「偏旧」：比自己的节奏慢一点点，不至于让人以为巡检坏了。 */
export const FLEET_STALE_FACTOR = 3;

/** 一次「全部巡检」最多连着跑几台。理由与采样上限一样：一次点击不该变成几十次巡检。 */
export const FLEET_RUN_MAX_CLUSTERS = 20;

export type FleetFreshness = 'never' | 'fresh' | 'aging' | 'stale';

/** 新鲜度窗口：开着定时就按这台集群自己的间隔，下限一小时（30 分钟一轮时时判过期没有意义）。 */
export function fleetWindowMs(schedule: InspectionSchedule | null): number {
    if (schedule && schedule.enabled) {
        return Math.max(schedule.intervalMinutes, 60) * 60_000;
    }
    return FLEET_DEFAULT_WINDOW_MS;
}

/**
 * 这一份报告相对这台集群自己的节奏有多旧。
 *
 * 时间戳解析不出来判 stale 而不是 never：库里确实有这一行，说「从没看过」是假话，
 * 但它的年龄无法可信地算出来，按最旧处理才不会让一个坏时间戳把这台排进干净那堆。
 * 时间戳在将来判 fresh：那说明刚刚跑过，时钟倒挂不是巡检的故障。
 */
export function fleetFreshness(
    latest: {generatedAt: string} | null,
    nowMs: number,
    schedule: InspectionSchedule | null = null,
): FleetFreshness {
    if (!latest) {
        return 'never';
    }
    const generatedAt = Date.parse(latest.generatedAt);
    if (!Number.isFinite(generatedAt)) {
        return 'stale';
    }
    const window = fleetWindowMs(schedule);
    const age = nowMs - generatedAt;
    if (age <= window) {
        return 'fresh';
    }
    return age <= window * FLEET_STALE_FACTOR ? 'aging' : 'stale';
}

export const FLEET_FRESHNESS_LABEL: Record<FleetFreshness, string> = {
    never: '从没看过',
    fresh: '新鲜',
    aging: '偏旧',
    stale: '太久没看',
};

/**
 * 这台集群落在汇总的哪一堆。
 *
 * 没跑过的排在「看着干净」之前：「没人看过」与「看过且没事」在界面上必须分得开，
 * 后者可以放心翻过去，前者是这份汇总唯一还没资格下结论的地方。
 */
export function fleetSectionOf(cluster: InspectionFleetCluster): FleetSection {
    const totals = cluster.latest?.totals;
    if (!totals) {
        return 'never';
    }
    if (totals.crit > 0) {
        return 'crit';
    }
    return totals.warn > 0 ? 'warn' : 'quiet';
}

export const FLEET_SECTION_LABEL: Record<FleetSection, string> = {
    crit: '有严重项',
    warn: '需要关注',
    never: '还没巡检过',
    quiet: '这一份没看出问题',
};

const SECTION_ORDER: Record<FleetSection, number> = {crit: 0, warn: 1, never: 2, quiet: 3};

/** 报告有多旧；没有报告或时间戳读不出来的算「无穷旧」，排序时沉到这堆的最前面。 */
function fleetAgeMs(cluster: InspectionFleetCluster, nowMs: number): number {
    const generatedAt = cluster.latest ? Date.parse(cluster.latest.generatedAt) : Number.NaN;
    return Number.isFinite(generatedAt) ? Math.max(0, nowMs - generatedAt) : Number.POSITIVE_INFINITY;
}

function fleetName(cluster: InspectionFleetCluster): string {
    return cluster.clusterName || cluster.clusterId;
}

/**
 * 汇总行的排序：先按堆，再按严重/关注数量，最后按「多久没人看过」。
 *
 * 同级里越旧越靠前：两台都判出 1 项严重，上周那份与十分钟前的那份需要的注意力不一样——
 * 旧的那份可能已经自己好了，先看它才不会拿着一个过期的结论去动生产。
 * 「从没看过」比「有报告但读不出时间」更该往前排，所以两者都算无穷旧时再按名字稳定兜底。
 */
export function compareFleetClusters(a: InspectionFleetCluster, b: InspectionFleetCluster, nowMs: number): number {
    const bySection = SECTION_ORDER[fleetSectionOf(a)] - SECTION_ORDER[fleetSectionOf(b)];
    if (bySection !== 0) {
        return bySection;
    }
    const byCrit = (b.latest?.totals.crit ?? 0) - (a.latest?.totals.crit ?? 0);
    if (byCrit !== 0) {
        return byCrit;
    }
    const byWarn = (b.latest?.totals.warn ?? 0) - (a.latest?.totals.warn ?? 0);
    if (byWarn !== 0) {
        return byWarn;
    }
    const byAge = fleetAgeMs(a, nowMs) - fleetAgeMs(b, nowMs);
    // 两边都没有可信时间时相减是 NaN，NaN 参与比较会留下原始顺序，这里显式按名字收口
    if (Number.isNaN(byAge)) {
        return fleetName(a).localeCompare(fleetName(b));
    }
    if (byAge !== 0) {
        // 相减为正说明 a 更旧，而更旧的要往前放，所以这里返回 -1 而不是 1
        return byAge > 0 ? -1 : 1;
    }
    return fleetName(a).localeCompare(fleetName(b));
}

/** 同一件事在几台集群上一起亮时合并成一组：这才看得出它是「一类问题」还是「一堆独立故障」。 */
export function groupFleetChecks(clusters: InspectionFleetCluster[]): InspectionFleetGroup[] {
    const groups = new Map<string, InspectionFleetGroup>();
    for (const cluster of clusters) {
        for (const check of cluster.checks) {
            if (check.level !== 'crit') {
                continue;
            }
            const group = groups.get(check.key) ?? {key: check.key, title: check.title, items: []};
            group.title = group.title || check.title;
            group.items.push({
                clusterId: cluster.clusterId,
                clusterName: cluster.clusterName,
                summary: check.summary,
                suggestion: check.suggestion,
            });
            groups.set(check.key, group);
        }
    }
    return [...groups.values()].sort((a, b) => b.items.length - a.items.length || a.title.localeCompare(b.title));
}

/** 汇总头上的那几个数。stale 把「偏旧」也算进去：这一格要回答的是「哪些报告已经不能当现在用」。 */
export function summarizeFleet(clusters: InspectionFleetCluster[], nowMs: number): InspectionFleetTotals {
    let crit = 0;
    let warn = 0;
    let never = 0;
    let stale = 0;
    let scheduled = 0;
    for (const cluster of clusters) {
        if (cluster.latest) {
            crit += cluster.latest.totals.crit;
            warn += cluster.latest.totals.warn;
        } else {
            never += 1;
        }
        const freshness = fleetFreshness(cluster.latest, nowMs, cluster.schedule);
        if (freshness === 'stale' || freshness === 'aging') {
            stale += 1;
        }
        if (cluster.schedule?.enabled) {
            scheduled += 1;
        }
    }
    return {
        clusters: clusters.length,
        inspected: clusters.length - never,
        never,
        crit,
        warn,
        stale,
        scheduled,
    };
}

/** 一次点击最多跑几台：越界是拒绝而不是夹到边界，界面要能说出「还有 N 台没跑」。 */
export function resolveFleetLimit(input?: number): number {
    if (input === undefined || input === null) {
        return FLEET_RUN_MAX_CLUSTERS;
    }
    if (typeof input !== 'number' || !Number.isFinite(input) || !Number.isInteger(input) || input < 1) {
        throw new Error('一次巡检的集群数必须是正整数');
    }
    if (input > FLEET_RUN_MAX_CLUSTERS) {
        throw new Error(`一次最多巡检 ${FLEET_RUN_MAX_CLUSTERS} 台集群，请分几轮跑`);
    }
    return input;
}

/** 采样范围那一格：截断必须写出来，否则「这台没有高积压」会被读成「这台没有积压」。 */
export function fleetSamplingNote(scope: InspectionScope | null): string {
    if (!scope) {
        return '没有报告';
    }
    return scope.truncated
        ? `共 ${scope.topicsSeen} 个 topic、只采了 ${scope.topicsSampled} 个`
        : `采到 ${scope.topicsSampled} 个 topic`;
}

function sourceLabel(source: InspectionSource): string {
    return source === 'scheduled' ? '自动' : '手动';
}

/**
 * 整份汇总导出成 Markdown。
 *
 * 顶部那段口径声明不是客套：这份文件离开应用之后，读到的人只有这些字。
 * 「每台集群用的是它自己最近的一份报告」不说清，就会被读成「此时此刻整个 fleet 的状态」，
 * 而这两者的差别恰恰是决定要不要半夜起来处理的那一条。
 */
export function renderFleetMarkdown(summary: InspectionFleetSummary): string {
    const lines: string[] = [];
    lines.push(`# Pulsar 集群巡检汇总：${summary.totals.clusters} 台`);
    lines.push('');
    lines.push(`- 汇总生成：${summary.generatedAt}`);
    lines.push(
        '- 口径：**每一行是那台集群自己最近的一份报告，不是同一时刻的快照**，' + '最旧的一份与最新的一份可能差好几天。',
    );
    lines.push(
        '- 各台集群的判定线可能按集群各自调过，跨集群直接比数值大小没有意义；' + '要看单台的判定线请导出它那一份报告。',
    );
    lines.push(
        `- 范围：${summary.totals.clusters} 台里有报告 ${summary.totals.inspected} 台、` +
            `从没巡检过 ${summary.totals.never} 台；合计严重 ${summary.totals.crit} 项、` +
            `关注 ${summary.totals.warn} 项；报告已偏旧或过期 ${summary.totals.stale} 台；` +
            `开着定时的 ${summary.totals.scheduled} 台。`,
    );
    if (summary.skipped.length) {
        lines.push(
            `- 本轮没跑的 ${summary.skipped.length} 台：${summary.skipped.map(item => item.clusterName).join('、')}` +
                `（一次最多 ${FLEET_RUN_MAX_CLUSTERS} 台，再多分几轮）。`,
        );
    }
    if (summary.failures.length) {
        lines.push(`- 本轮跑坏的 ${summary.failures.length} 台见下面单独一段。`);
    }
    lines.push('');

    lines.push('## 逐台最近一份报告');
    lines.push('');
    if (!summary.clusters.length) {
        lines.push('（集群表是空的）');
    } else {
        lines.push('| 集群 | 最近一次 | 来源 | 严重 | 关注 | 未覆盖 | 采样 | 新鲜度 |');
        lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
        for (const cluster of summary.clusters) {
            const latest = cluster.latest;
            const cells = latest
                ? [
                      cell(latest.generatedAt),
                      sourceLabel(latest.source),
                      String(latest.totals.crit),
                      String(latest.totals.warn),
                      String(latest.totals.skip),
                      cell(fleetSamplingNote(latest.scope)),
                  ]
                : ['—', '—', '—', '—', '—', '—'];
            lines.push(
                `| ${cell(fleetName(cluster))} | ${cells.join(' | ')} |` +
                    ` ${cell(FLEET_FRESHNESS_LABEL[cluster.freshness])} |`,
            );
        }
    }
    lines.push('');

    if (summary.failures.length) {
        lines.push('## 本轮没能跑成的集群');
        lines.push('');
        for (const failure of summary.failures) {
            lines.push(`- ${failure.clusterName}：${failure.message}`);
        }
        lines.push('');
    }

    lines.push('## 跨集群的严重项');
    lines.push('');
    if (summary.critGroups.length) {
        for (const group of summary.critGroups) {
            lines.push(`### ${group.title}（${group.items.length} 台）`);
            for (const item of group.items) {
                lines.push(`- ${item.clusterName}：${item.summary}`);
                if (item.suggestion) {
                    lines.push(`  - 建议：${item.suggestion}`);
                }
            }
            lines.push('');
        }
    } else {
        lines.push('这些最近一份报告里没有严重项。「没有」只对这些报告成立，不等于此刻没问题。');
        lines.push('');
    }

    const neverClusters = summary.clusters.filter(cluster => !cluster.latest);
    if (neverClusters.length) {
        lines.push('## 还没巡检过的集群');
        lines.push('');
        for (const cluster of neverClusters) {
            lines.push(`- ${fleetName(cluster)}`);
        }
        lines.push('');
        lines.push('这几台不在上面的结论之内：汇总对它们唯一知道的事就是「没人看过」。');
        lines.push('');
    }

    return `${lines.join('\n')}\n`;
}

/** 表格单元格：竖线会把表格撑坏，换行会把一行拆成两行。 */
function cell(text: string): string {
    return text.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}
