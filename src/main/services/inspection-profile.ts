/**
 * 巡检口径：一台集群一套判定线，以及「一份草稿怎么变成一份可用口径」的规则。
 *
 * 默认阈值是按「一个正常集群长什么样」定的，但一个常年 5 万积压的集群天天被报「关注」，
 * 结果不是让人紧张而是让人把这一栏划掉。所以口径必须能按集群改。
 *
 * 改口径带来一个新问题：两次巡检之间判定线动过，环比里的「恶化」就有一部分根本不是集群变的，
 * 是线变严了。于是每次巡检把当次真正生效的口径抄进报告，环比时再对一次——
 * 这个文件负责的就是「口径怎么算出来、怎么比」。字段的名称与区间在
 * shared/inspection-caliber.ts，界面上的表单和主进程的校验共用同一张表。
 *
 * 越界一律报错而不是静默钳制：把用户写的 500 万悄悄按上限 100 万存下来，
 * 报告就会用他以为没配过的口径判红，这比拒收一条输入坏得多。
 */
import {
    INSPECTION_DEFAULTS,
    INSPECTION_THRESHOLDS,
    SAMPLING_LIMITS,
    THRESHOLD_FIELDS,
    THRESHOLD_LABELS,
    THRESHOLD_LIMITS,
} from '../../shared/inspection-caliber';
import type {InspectionThresholdChange, InspectionThresholds, InspectionThresholdsDraft} from '../../shared/types';

function invalid(message: string): Error {
    return new Error(`巡检口径不合法：${message}`);
}

function checkNumber(field: keyof InspectionThresholds, value: unknown): number {
    const {min, max, integer} = THRESHOLD_LIMITS[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw invalid(`${THRESHOLD_LABELS[field]} 必须是一个有限的数字`);
    }
    if (integer && !Number.isInteger(value)) {
        throw invalid(`${THRESHOLD_LABELS[field]} 只能是整数`);
    }
    if (value < min || value > max) {
        throw invalid(`${THRESHOLD_LABELS[field]} 只能在 ${min} 到 ${max} 之间`);
    }
    // 浮点输入（1.1 这种）直接进 Markdown 会变成 1.1000000000000001，先抹掉噪声
    return integer ? value : Math.round(value * 100) / 100;
}

/** 草稿 → 完整口径：没填的字段落回默认值，填了的逐个校验。 */
export function resolveThresholds(draft: InspectionThresholdsDraft | undefined): InspectionThresholds {
    const next: InspectionThresholds = {...INSPECTION_THRESHOLDS};
    for (const field of THRESHOLD_FIELDS) {
        const value = draft?.[field];
        if (value !== undefined && value !== null) {
            next[field] = checkNumber(field, value);
        }
    }
    // 这一条不在区间里：两个数各自都合法，合在一起却让分级反过来——
    // 超过关注线却永远到不了严重线，报告里就再没有红字，而那是配置错误不是好消息。
    if (next.backlogCrit < next.backlogWarn) {
        throw invalid('积压严重线不能低于关注线，否则积压只会报到「关注」就停住');
    }
    return next;
}

/** 采样上限：这一次巡检没填时，落回集群口径表里的值，再落回默认。 */
export function resolveSampling(input: {maxNamespaces?: number; maxTopics?: number}): {
    maxNamespaces: number;
    maxTopics: number;
} {
    const out = {
        maxNamespaces: input.maxNamespaces ?? INSPECTION_DEFAULTS.maxNamespaces,
        maxTopics: input.maxTopics ?? INSPECTION_DEFAULTS.maxTopics,
    };
    for (const key of ['maxNamespaces', 'maxTopics'] as const) {
        const {min, max} = SAMPLING_LIMITS[key];
        const label = key === 'maxNamespaces' ? '命名空间采样上限' : 'topic 采样上限';
        if (!Number.isInteger(out[key]) || out[key] < min || out[key] > max) {
            throw invalid(`${label}只能在 ${min} 到 ${max} 之间`);
        }
    }
    return out;
}

/** 与默认口径不同的字段。界面上的「默认 / 已调整」标记和导出的口径行都靠它。 */
export function thresholdOverrides(thresholds: InspectionThresholds): (keyof InspectionThresholds)[] {
    return THRESHOLD_FIELDS.filter(field => thresholds[field] !== INSPECTION_THRESHOLDS[field]);
}

/** 两次口径的逐字段差别；只有两边都知道时才谈得上「变没变」。 */
export function diffThresholds(
    previous: InspectionThresholds,
    current: InspectionThresholds,
): InspectionThresholdChange[] {
    const changes: InspectionThresholdChange[] = [];
    for (const field of THRESHOLD_FIELDS) {
        if (previous[field] !== current[field]) {
            changes.push({field, label: THRESHOLD_LABELS[field], previous: previous[field], current: current[field]});
        }
    }
    return changes;
}
