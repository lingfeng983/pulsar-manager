/**
 * 巡检环比：把「这次的结果」和「上次的结果」对起来，只说移动了的那几项。
 *
 * 一份体检报告单独看只能知道此刻有没有问题，连看两次才知道是在变好还是变坏。
 * 这一层是纯函数（输入两份检查项数组，不碰 broker、不碰库），所以判定口径
 * 可以在没有集群的机器上被 scripts/inspection-selftest.cjs 覆盖。
 */
import {diffThresholds} from './inspection-profile';
import {thresholdDisplay} from '../../shared/inspection-caliber';
import type {
    InspectionChangeKind,
    InspectionCheck,
    InspectionDiff,
    InspectionDiffItem,
    InspectionLevel,
    InspectionThresholdChange,
    InspectionThresholds,
} from '../../shared/types';

// skip 排在 ok 之上而不是之下：一项检查从「读到了、没问题」变成「读不到了」不是好消息，
// 它意味着这一格现在没人看住；但它也没有断言任何故障，所以仍在 warn 之下。
const LEVEL_RANK: Record<InspectionLevel, number> = {ok: 0, skip: 1, warn: 2, crit: 3};

// 展示顺序按「需要人处理的排前面」而不是按 key：环比列表读起来应该像待办，不像附表。
const KIND_ORDER: Record<InspectionChangeKind, number> = {worsened: 0, new: 1, resolved: 2, improved: 3, unchanged: 4};

/** 只有 crit / warn 才算「有事」：一项本来正常的检查出现或消失都不值得单独通知。 */
function isActionable(level: InspectionLevel): boolean {
    return level === 'crit' || level === 'warn';
}

function compareRank(level: InspectionLevel, previous: InspectionLevel): number {
    return LEVEL_RANK[level] - LEVEL_RANK[previous];
}

export function diffInspectionChecks(
    previousChecks: InspectionCheck[],
    currentChecks: InspectionCheck[],
): InspectionDiffItem[] {
    const previousByKey = new Map(previousChecks.map(item => [item.key, item]));
    const currentByKey = new Map(currentChecks.map(item => [item.key, item]));
    const items: InspectionDiffItem[] = [];

    for (const current of currentChecks) {
        const previous = previousByKey.get(current.key);
        if (!previous) {
            if (isActionable(current.level)) {
                items.push({
                    key: current.key,
                    title: current.title,
                    kind: 'new',
                    level: current.level,
                    previousLevel: null,
                    summary: current.summary,
                });
            }
            continue;
        }
        const delta = compareRank(current.level, previous.level);
        items.push({
            key: current.key,
            title: current.title,
            kind: delta > 0 ? 'worsened' : delta < 0 ? 'improved' : 'unchanged',
            level: current.level,
            previousLevel: previous.level,
            summary: current.summary,
        });
    }

    for (const previous of previousChecks) {
        if (currentByKey.has(previous.key) || !isActionable(previous.level)) {
            continue;
        }
        // 这一项这次没出现：上次是 crit/warn，现在读不到了（端点变化或采样范围变了），
        // 按「问题不在结论之内」报出来，但绝不写成「已恢复」——没测到不等于好了。
        items.push({
            key: previous.key,
            title: previous.title,
            kind: 'resolved',
            level: null,
            previousLevel: previous.level,
            summary: previous.summary,
        });
    }

    return items.sort((a, b) => {
        const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
        if (byKind !== 0) {
            return byKind;
        }
        const rankA = LEVEL_RANK[a.level ?? a.previousLevel ?? 'ok'];
        const rankB = LEVEL_RANK[b.level ?? b.previousLevel ?? 'ok'];
        return rankB - rankA;
    });
}

/** 一行「积压严重线 1000000 条 → 500000 条」：口径变动要能读出是哪个字段、从多少到多少。 */
function thresholdShiftText(item: InspectionThresholdChange): string {
    const from = thresholdDisplay(item.field, item.previous);
    const to = thresholdDisplay(item.field, item.current);
    return `${item.label} ${from} → ${to}`;
}

/**
 * `thresholds` 缺省表示其中一份报告的口径未知（v2.8 之前存的报告还没有这一格）。
 * 口径未知时宁可不下「判定没变」的结论，也不替它编一份默认口径——
 * 那份报告的红字到底是按哪条线判的，只有当时的代码知道。
 */
export function buildInspectionDiff(
    previousId: string,
    previousGeneratedAt: string,
    previousChecks: InspectionCheck[],
    currentChecks: InspectionCheck[],
    thresholds?: {previous: InspectionThresholds | null; current: InspectionThresholds | null},
): InspectionDiff {
    const items = diffInspectionChecks(previousChecks, currentChecks);
    const caliber =
        thresholds && thresholds.previous && thresholds.current
            ? diffThresholds(thresholds.previous, thresholds.current)
            : [];
    return {
        previousId,
        previousGeneratedAt,
        items,
        changedCount: items.filter(item => item.kind !== 'unchanged').length,
        thresholdChanges: caliber,
    };
}

/**
 * 把环比结论写进导出的 Markdown。
 * 报告发出去之后别人只看得到这一份快照，不加这段就没有人知道「积压从 2 千涨到 40 万」
 * 和「一直是 40 万」是两件完全不同的事。
 */
export function renderDiffMarkdown(diff: InspectionDiff): string[] {
    const lines: string[] = [];
    lines.push(`## 与上次巡检的差别（上次：${diff.previousGeneratedAt}）`);
    lines.push('');
    if (diff.thresholdChanges.length) {
        lines.push(`- 判定口径与上次不同：${diff.thresholdChanges.map(thresholdShiftText).join('；')}`);
        lines.push('  所以下面的级别移动里有一部分是判定线动了，不是集群变了。');
        lines.push('');
    }
    if (!diff.changedCount) {
        lines.push(
            diff.thresholdChanges.length
                ? '按新口径重判，级别与上次完全一致。'
                : '与上一次结论一致，没有项目的级别发生变化。',
        );
        lines.push('');
        return lines;
    }
    for (const item of diff.items) {
        if (item.kind === 'unchanged') {
            continue;
        }
        lines.push(`- ${KIND_LABELS[item.kind]}｜${item.title}：${item.summary}`);
    }
    lines.push('');
    return lines;
}

const KIND_LABELS: Record<InspectionChangeKind, string> = {
    new: '新增',
    resolved: '本次未出现',
    worsened: '恶化',
    improved: '好转',
    unchanged: '不变',
};

export function diffChangeLabel(kind: InspectionChangeKind): string {
    return KIND_LABELS[kind];
}
