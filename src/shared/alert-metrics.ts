// 告警指标的唯一定义处：主进程按它取数与写文案，渲染层按它渲染表单与表格。
// 阈值与观测值一律存原生单位（条、条/秒、字节/秒、字节），只有显示时才换算，
// 否则「用户填的 5」到底是 5 字节还是 5MB 这件事会跟着界面改动一起漂。
import type {AlertComparator, AlertMetricKey, AlertScope} from './types';

export interface AlertMetricMeta {
    key: AlertMetricKey;
    label: string;
    // 显示单位与换算倍数：显示值 = 原生值 / scale
    unit: string;
    scale: number;
    // 计数类指标显示时不保留小数
    integer: boolean;
    // 聚合统计里没有存储量这一项，集群口径自然取不到
    clusterSupported: boolean;
}

export const ALERT_METRICS: AlertMetricMeta[] = [
    {key: 'backlog', label: '积压消息数', unit: '条', scale: 1, integer: true, clusterSupported: true},
    {key: 'msgRateIn', label: '入向速率', unit: '条/秒', scale: 1, integer: false, clusterSupported: true},
    {key: 'msgRateOut', label: '出向速率', unit: '条/秒', scale: 1, integer: false, clusterSupported: true},
    {key: 'throughputIn', label: '入向吞吐', unit: 'KB/秒', scale: 1024, integer: false, clusterSupported: true},
    {key: 'throughputOut', label: '出向吞吐', unit: 'KB/秒', scale: 1024, integer: false, clusterSupported: true},
    {key: 'storageSize', label: '存储大小', unit: 'MB', scale: 1024 * 1024, integer: false, clusterSupported: false},
    {key: 'producers', label: '生产者数', unit: '个', scale: 1, integer: true, clusterSupported: true},
    {key: 'consumers', label: '消费者数', unit: '个', scale: 1, integer: true, clusterSupported: true},
];

const BY_KEY = new Map(ALERT_METRICS.map(meta => [meta.key, meta]));

// 认不出的键（手工改过的库）不能让整张列表渲染崩掉：退回键名本身。
export function alertMetric(key: string): AlertMetricMeta {
    return (
        BY_KEY.get(key as AlertMetricKey) ?? {
            key: key as AlertMetricKey,
            label: key,
            unit: '',
            scale: 1,
            integer: false,
            clusterSupported: true,
        }
    );
}

export const ALERT_COMPARATORS: {key: AlertComparator; symbol: string; label: string}[] = [
    {key: 'gt', symbol: '>', label: '高于'},
    {key: 'lt', symbol: '<', label: '低于'},
];

export function alertComparator(key: string) {
    return ALERT_COMPARATORS.find(item => item.key === key) ?? ALERT_COMPARATORS[0];
}

export const ALERT_SCOPES: {key: AlertScope; label: string}[] = [
    {key: 'cluster', label: '整个集群'},
    {key: 'namespace', label: '命名空间'},
    {key: 'topic', label: 'Topic'},
];

export function alertScopeLabel(key: string): string {
    return ALERT_SCOPES.find(item => item.key === key)?.label ?? key;
}

export interface AlertScopeParts {
    scope: AlertScope;
    tenant: string;
    namespace: string;
    topic: string;
    persistent: boolean;
}

// 作用域文本：立案那一刻写进事件行，规则后来改名或改作用域都不影响历史可读性。
export function formatAlertScope(parts: AlertScopeParts): string {
    if (parts.scope === 'topic') {
        const scheme = parts.persistent ? 'persistent' : 'non-persistent';
        return `${scheme}://${parts.tenant}/${parts.namespace}/${parts.topic}`;
    }
    if (parts.scope === 'namespace') {
        return `命名空间 ${parts.tenant}/${parts.namespace}`;
    }
    return '整个集群';
}

export function formatAlertValue(key: string, nativeValue: number): string {
    const meta = alertMetric(key);
    const display = nativeValue / meta.scale;
    const text = meta.integer
        ? Math.round(display).toLocaleString('zh-CN')
        : display.toLocaleString('zh-CN', {maximumFractionDigits: 2});
    return meta.unit ? `${text} ${meta.unit}` : text;
}

export interface AlertConditionParts extends AlertScopeParts {
    metric: AlertMetricKey;
    comparator: AlertComparator;
    threshold: number;
    consecutive: number;
}

// 规则表里那一行「条件」：阈值与连续次数都要看得见，
// 否则同一条规则改过一次阈值之后没人知道现在卡在哪个数上。
export function describeAlertCondition(rule: AlertConditionParts): string {
    const meta = alertMetric(rule.metric);
    const comparator = alertComparator(rule.comparator);
    const base = `${meta.label} ${comparator.symbol} ${formatAlertValue(rule.metric, rule.threshold)}`;
    return rule.consecutive > 1 ? `${base}（连续 ${rule.consecutive} 轮）` : base;
}

// 写进事件行的正文：独立于规则，因为规则随时会被改，而"当时到底超了多少"不该变。
export function buildAlertMessage(
    rule: AlertScopeParts & {metric: AlertMetricKey; comparator: AlertComparator; threshold: number},
    observedValue: number,
): string {
    const comparator = alertComparator(rule.comparator);
    return (
        `${formatAlertScope(rule)} ${alertMetric(rule.metric).label} ${comparator.label} ` +
        `${formatAlertValue(rule.metric, rule.threshold)}：当前 ${formatAlertValue(rule.metric, observedValue)}`
    );
}

// 恢复文案读的是事件行上那份副本（scope_label 等），不是当前规则：
// 规则中途改了作用域，恢复通知也该说清"当初立案的那个对象现在不超标了"。
export function buildRecoveredMessage(
    event: {scopeLabel: string; metric: AlertMetricKey; comparator: AlertComparator; threshold: number},
    observedValue: number,
): string {
    const comparator = alertComparator(event.comparator);
    const backTo = comparator.key === 'gt' ? '回落到' : '恢复到';
    return (
        `${event.scopeLabel} ${alertMetric(event.metric).label} ${backTo} ` +
        `${formatAlertValue(event.metric, observedValue)}` +
        `（阈值 ${comparator.symbol} ${formatAlertValue(event.metric, event.threshold)}）`
    );
}
