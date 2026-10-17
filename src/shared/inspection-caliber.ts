/**
 * 巡检口径的唯一出处：默认阈值、默认采样上限、每个字段的中文名与合法区间。
 *
 * 主进程的校验、报告的 Markdown、界面上的表单都从这里取值（与 shared/alert-metrics.ts
 * 同一个理由）：分成两处写，迟早一处放宽一处收紧，用户在表单里填得进去的数字
 * 到判定那边被拒掉。
 */
import type {InspectionThresholds} from './types';

/** 采样上限的默认值：太小会漏掉东西，太大就变成一次点击打几千个请求。 */
export const INSPECTION_DEFAULTS = {maxNamespaces: 20, maxTopics: 60};

/**
 * 默认阈值按「一个正常集群长什么样」定：
 * 积压分级看的是单个 topic 的最大值而不是总量——一个 100 万条的 topic 比十个 1 万条的紧急得多。
 */
export const INSPECTION_THRESHOLDS: InspectionThresholds = {
    backlogWarn: 10_000,
    backlogCrit: 1_000_000,
    unackedWarn: 5_000,
    // 入向速率是出向的多少倍算「消费跟不上」。比例之下还有绝对量下限，
    // 否则一个每秒 0.01 条的 topic 会因为除不尽而被报成故障。
    rateRatio: 3,
    rateMinIn: 10,
    detailTopN: 8,
};

export type ThresholdField = keyof InspectionThresholds;

export const THRESHOLD_FIELDS = [
    'backlogWarn',
    'backlogCrit',
    'unackedWarn',
    'rateRatio',
    'rateMinIn',
    'detailTopN',
] as ThresholdField[];

export const THRESHOLD_LABELS: Record<ThresholdField, string> = {
    backlogWarn: '积压关注线',
    backlogCrit: '积压严重线',
    unackedWarn: '未 ack 关注线',
    rateRatio: '入向/出向倍数',
    rateMinIn: '速率判定的入向下限',
    detailTopN: '明细最多列几条',
};

const THRESHOLD_UNITS: Record<ThresholdField, string> = {
    backlogWarn: '条',
    backlogCrit: '条',
    unackedWarn: '条',
    rateRatio: '倍',
    rateMinIn: '条/秒',
    detailTopN: '条',
};

/**
 * 每个字段允许的区间。上限是给「误填一个亿」兜底，不是给用户自由发挥的空间；
 * integer=false 的两个字段允许小数，每秒 0.5 条这种下限只有浮点能表达。
 */
export const THRESHOLD_LIMITS: Record<ThresholdField, {min: number; max: number; integer: boolean}> = {
    backlogWarn: {min: 0, max: 100_000_000, integer: true},
    backlogCrit: {min: 0, max: 1_000_000_000, integer: true},
    unackedWarn: {min: 0, max: 100_000_000, integer: true},
    rateRatio: {min: 1, max: 1000, integer: false},
    rateMinIn: {min: 0, max: 1_000_000, integer: false},
    detailTopN: {min: 1, max: 50, integer: true},
};

export const SAMPLING_LIMITS = {
    maxNamespaces: {min: 1, max: 200},
    maxTopics: {min: 1, max: 1000},
};

/** 界面上与导出文件里显示的「数值 + 单位」，单位跟着字段名走而不是写死在文案里。 */
export function thresholdDisplay(field: ThresholdField, value: number): string {
    return `${value} ${THRESHOLD_UNITS[field]}`;
}

/** 一个字段调没调过：界面上的「默认 / 已调整」标记与导出的口径行都靠它。 */
export function isThresholdOverridden(field: ThresholdField, value: number): boolean {
    return value !== INSPECTION_THRESHOLDS[field];
}
