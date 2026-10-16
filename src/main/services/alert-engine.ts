import {Notification} from 'electron';
import {getMainWindow} from '../index';
import {AGGREGATION_LIMITS} from '../config/constants';
import {
    cleanupAlertEvents,
    getAlertEventById,
    getAlertRuleById,
    getClusterById,
    getOpenAlertEvent,
    insertAlertEvent,
    listAlertRules,
    observeAlertEvent,
    resolveAlertEvent,
    type AlertEventRecord,
    type AlertRuleRecord,
} from '../database/sqlite';
import {readAppSettings} from './app-config';
import {
    alertMetric,
    buildAlertMessage,
    buildRecoveredMessage,
    formatAlertScope,
    formatAlertValue,
} from '../../shared/alert-metrics';
import type {
    AggregatedStats,
    AlertComparator,
    AlertEvent,
    AlertMetricKey,
    AlertProbeResult,
    AlertPush,
    AlertRule,
    AlertScope,
    TopicStats,
} from '../../shared/types';
import type {PulsarAdminClient} from './pulsar-admin';
import {createLogger} from '../utils/logger';

const log = createLogger('AlertEngine');

// 告警引擎只在主进程跑：评估要读 broker，而 broker I/O 不许出现在渲染层；
// 窗口收进托盘时它也得继续盯着，所以不能挂在监控页的轮询节奏上。
//
// 本模块不 import ipc/_shared（那一层反过来依赖这里）：需要 admin 客户端与下行推送时，
// 由 registerAlertHandlers() 把这两个能力注入进来，见 bindAlertEngineDeps。
// getMainWindow 是唯一的例外——它只是个取窗口的函数，调用发生在运行期，
// index ↔ 本模块的循环 require 因此拿到的是已加载完的导出（与 ipc/stream 同一套）。

interface AlertSample {
    backlog: number;
    msgRateIn: number;
    msgRateOut: number;
    throughputIn: number;
    throughputOut: number;
    storageSize: number;
    producers: number;
    consumers: number;
}

// 采样的键与可比对的指标正好同集，取指标就是 sample[rule.metric]：
// 多一层 switch 就多一处"加了指标忘了改这里"的地方。
const EMPTY_SAMPLE: AlertSample = {
    backlog: 0,
    msgRateIn: 0,
    msgRateOut: 0,
    throughputIn: 0,
    throughputOut: 0,
    storageSize: 0,
    producers: 0,
    consumers: 0,
};

export interface AlertEngineDeps {
    /** clusterId → admin 客户端；返回 null 表示集群已不存在 */
    getClient: (clusterId: string) => Promise<PulsarAdminClient | null>;
    /** 主进程 → 渲染进程的下行推送 */
    publish: (push: AlertPush) => void;
}

let deps: AlertEngineDeps | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let kickoff: ReturnType<typeof setTimeout> | null = null;
// 上一轮没跑完就跳过这一轮，而不是把 tick 排成长队：大集群 + 慢 broker 时排队会让
// 请求堆积，表现得像应用在攻击自己的 broker。
let evaluating = false;
// 连续命中计数只活在内存里：重启后从头数，代价是"连续 N 轮"的判定慢一轮启动，
// 换来的是不必为一串瞬时计数维护一张表。
const hitCounts = new Map<string, number>();

export function bindAlertEngineDeps(next: AlertEngineDeps): void {
    deps = next;
}

// ========== 行 → 领域对象 ==========

export function toAlertRule(record: AlertRuleRecord): AlertRule {
    return {
        id: record.id,
        clusterId: record.cluster_id,
        name: record.name,
        enabled: record.enabled === 1,
        scope: record.scope as AlertScope,
        tenant: record.tenant,
        namespace: record.namespace,
        topic: record.topic,
        persistent: record.persistent === 1,
        metric: record.metric as AlertMetricKey,
        comparator: record.comparator as AlertComparator,
        threshold: record.threshold,
        consecutive: record.consecutive,
        notify: record.notify === 1,
        createdAt: record.created_at,
        updatedAt: record.updated_at,
    };
}

export function toAlertEvent(record: AlertEventRecord): AlertEvent {
    return {
        id: record.id,
        ruleId: record.rule_id,
        clusterId: record.cluster_id,
        ruleName: record.rule_name,
        scopeLabel: record.scope_label,
        metric: record.metric as AlertMetricKey,
        comparator: record.comparator as AlertComparator,
        threshold: record.threshold,
        value: record.value,
        lastValue: record.last_value,
        // 状态以 resolved_at 为准：两者由同一段代码写，但只有一份能当真相
        state: record.resolved_at === null || record.resolved_at === undefined ? 'firing' : 'resolved',
        message: record.message,
        firedAt: record.fired_at,
        lastSeenAt: record.last_seen_at,
        resolvedAt: record.resolved_at,
        ackedAt: record.acked_at,
    };
}

// ========== 取数 ==========

function fromTopicStats(stats: TopicStats): AlertSample {
    const backlog = Object.values(stats.subscriptions ?? {}).reduce((sum, sub) => sum + (sub?.msgBacklog || 0), 0);
    return {
        backlog,
        msgRateIn: stats.msgRateIn || 0,
        msgRateOut: stats.msgRateOut || 0,
        throughputIn: stats.msgThroughputIn || 0,
        throughputOut: stats.msgThroughputOut || 0,
        storageSize: stats.storageSize || 0,
        producers: stats.producers?.length || 0,
        // 消费者数取扁平列表长度：与聚合统计里 totalConsumers 同源，
        // 否则同一个数字会在两个页面显示成两样
        consumers: stats.consumers?.length || 0,
    };
}

function sumSamples(total: AlertSample, part: AlertSample): AlertSample {
    return {
        backlog: total.backlog + part.backlog,
        msgRateIn: total.msgRateIn + part.msgRateIn,
        msgRateOut: total.msgRateOut + part.msgRateOut,
        throughputIn: total.throughputIn + part.throughputIn,
        throughputOut: total.throughputOut + part.throughputOut,
        storageSize: total.storageSize + part.storageSize,
        producers: total.producers + part.producers,
        consumers: total.consumers + part.consumers,
    };
}

function fromAggregated(stats: AggregatedStats): AlertSample {
    return {
        backlog: stats.totalBacklog || 0,
        msgRateIn: stats.totalMsgRateIn || 0,
        msgRateOut: stats.totalMsgRateOut || 0,
        throughputIn: stats.totalThroughputIn || 0,
        throughputOut: stats.totalThroughputOut || 0,
        // 聚合口径没有存储量（参数校验已禁止这个组合），留 0 只为让类型齐整
        storageSize: 0,
        producers: stats.totalProducers || 0,
        consumers: stats.totalConsumers || 0,
    };
}

async function fetchSample(client: PulsarAdminClient, rule: AlertRule): Promise<AlertSample> {
    if (rule.scope === 'topic') {
        const stats = await client.getTopicStats(rule.tenant, rule.namespace, rule.topic, rule.persistent);
        return fromTopicStats(stats);
    }
    if (rule.scope === 'cluster') {
        return fromAggregated(await client.getAggregatedStats());
    }
    // 命名空间口径：逐 topic 求和，规模上限与监控页聚合同一个数
    const topics = (await client.getTopics(rule.tenant, rule.namespace)).slice(
        0,
        AGGREGATION_LIMITS.MAX_TOPICS_PER_NAMESPACE,
    );
    if (topics.length === 0) {
        return EMPTY_SAMPLE;
    }
    let failed = 0;
    const parts = await Promise.all(
        topics.map(async topic => {
            try {
                const stats = await client.getTopicStats(rule.tenant, rule.namespace, topic.name, topic.persistent);
                return fromTopicStats(stats);
            } catch {
                // 单条 topic 读不到按 0 计入总和：偏保守（少报），但不让一条坏 topic
                // 把整个命名空间本轮作废
                failed += 1;
                return null;
            }
        }),
    );
    // 全读不到时不能拿 0 冒充"指标正常"：那会把正在烧的事件误判成已恢复
    if (failed === topics.length) {
        throw new Error(`命名空间 ${rule.tenant}/${rule.namespace} 下所有 Topic 的统计都读不到`);
    }
    return parts.filter(Boolean).reduce(sumSamples, EMPTY_SAMPLE);
}

// 同一轮里同作用域的多条规则共用一次取数（"积压 > 1 万"与"消费者 < 1"看的是同一个 /stats）。
// 缓存的是 Promise，所以并发与顺序两种调用都只发一次请求。
function sampleFor(
    client: PulsarAdminClient,
    rule: AlertRule,
    cache: Map<string, Promise<AlertSample>>,
): Promise<AlertSample> {
    const key = `${rule.scope}|${rule.tenant}|${rule.namespace}|${rule.topic}|${rule.persistent}`;
    const cached = cache.get(key);
    if (cached) {
        return cached;
    }
    const task = fetchSample(client, rule);
    cache.set(key, task);
    return task;
}

// ========== 判定 ==========

function isBreached(comparator: AlertComparator, value: number, threshold: number): boolean {
    return comparator === 'gt' ? value > threshold : value < threshold;
}

function publishAlert(record: AlertEventRecord, kind: AlertPush['kind'], notify: boolean): void {
    const event = toAlertEvent(record);
    deps?.publish({kind, event});
    if (!notify) {
        return;
    }
    // 集群名只是把通知写得更像人话，查得到就用、查不到就用 id，不为了一个标签丢掉整条通知
    const clusterName = getClusterById(event.clusterId)?.name || event.clusterId;
    const body = kind === 'fired' ? event.message : buildRecoveredMessage(event, event.lastValue);
    try {
        if (!Notification.isSupported()) {
            return;
        }
        const notification = new Notification({
            title: kind === 'fired' ? `告警：${event.ruleName}` : `告警恢复：${event.ruleName}`,
            body: `${clusterName} · ${body}`,
            urgency: kind === 'fired' ? 'critical' : 'normal',
        });
        notification.on('click', () => {
            const window = getMainWindow();
            if (window && !window.isDestroyed()) {
                if (window.isMinimized()) {
                    window.restore();
                }
                window.show();
                window.focus();
            }
        });
        notification.show();
    } catch (error) {
        // 桌面通知失败不影响事件落库：某些 Linux 桌面压根没有通知服务，这是常态不是故障
        log.warn(`desktop notification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function applySample(rule: AlertRule, value: number): void {
    const now = Date.now();
    if (isBreached(rule.comparator, value, rule.threshold)) {
        const hits = (hitCounts.get(rule.id) ?? 0) + 1;
        hitCounts.set(rule.id, hits);
        const open = getOpenAlertEvent(rule.id);
        if (open) {
            // 已经立案：只把观测值刷上去，不再弹第二次通知
            observeAlertEvent(open.id, value, now);
            return;
        }
        if (hits < rule.consecutive) {
            return;
        }
        const id = insertAlertEvent({
            rule_id: rule.id,
            cluster_id: rule.clusterId,
            rule_name: rule.name,
            scope_label: formatAlertScope(rule),
            metric: rule.metric,
            comparator: rule.comparator,
            threshold: rule.threshold,
            value,
            last_value: value,
            state: 'firing',
            // message 写的是"当时为什么立案"，此后规则改名改阈值都不回头改它
            message: buildAlertMessage(rule, value),
            fired_at: now,
            last_seen_at: now,
            resolved_at: null,
            acked_at: null,
        });
        const record = getAlertEventById(id);
        if (record) {
            publishAlert(record, 'fired', rule.notify);
        }
        return;
    }

    hitCounts.delete(rule.id);
    const open = getOpenAlertEvent(rule.id);
    if (!open) {
        return;
    }
    resolveAlertEvent(open.id, value, now);
    const record = getAlertEventById(open.id);
    if (record) {
        // 恢复通知跟立案通知共用同一个开关：只想知道"出事了"、不在乎"好了没"的人两个一起关
        publishAlert(record, 'recovered', rule.notify);
    }
}

function breakStreaks(rules: AlertRule[]): void {
    rules.forEach(rule => hitCounts.delete(rule.id));
}

async function evaluateAll(): Promise<void> {
    if (!deps) {
        return;
    }
    const rules = listAlertRules()
        .filter(record => record.enabled === 1)
        .map(toAlertRule);
    if (rules.length === 0) {
        return;
    }

    const byCluster = new Map<string, AlertRule[]>();
    for (const rule of rules) {
        const bucket = byCluster.get(rule.clusterId);
        if (bucket) {
            bucket.push(rule);
        } else {
            byCluster.set(rule.clusterId, [rule]);
        }
    }

    for (const [clusterId, clusterRules] of byCluster) {
        let client: PulsarAdminClient | null = null;
        try {
            // 经 SSH 隧道的集群会在这里把本地转发建起来：开着告警就等于按间隔唤一次隧道，
            // 这是这套设计的代价，配置中心的说明里也写了
            client = await deps.getClient(clusterId);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            log.warn(`client for cluster ${clusterId} unavailable: ${reason}`);
            breakStreaks(clusterRules);
            continue;
        }
        if (!client) {
            breakStreaks(clusterRules);
            continue;
        }

        const cache = new Map<string, Promise<AlertSample>>();
        for (const rule of clusterRules) {
            try {
                const sample = await sampleFor(client, rule, cache);
                applySample(rule, sample[rule.metric]);
            } catch (error) {
                // 读不到数绝不改判定：连续计数断掉（下一轮重新开始数），
                // 未恢复的事件保持原状，界面继续显示上一次采到的观测值
                hitCounts.delete(rule.id);
                log.warn(`rule ${rule.name} sample failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}

async function tick(): Promise<void> {
    if (evaluating) {
        return;
    }
    evaluating = true;
    try {
        const settings = readAppSettings();
        if (!settings.alertEnabled) {
            return;
        }
        await evaluateAll();
        cleanupAlertEvents(settings.alertRetentionDays);
    } catch (error) {
        log.error('alert tick failed', error instanceof Error ? error.message : String(error));
    } finally {
        evaluating = false;
    }
}

// 间隔与开关都来自库里那一行设置，所以每次配置写入之后都要重挂定时器，
// 否则"改了间隔要重启应用才生效"。
export function syncAlertEngine(): void {
    stopAlertEngine();
    if (!deps) {
        return;
    }
    const settings = readAppSettings();
    if (!settings.alertEnabled) {
        log.info('alert engine disabled');
        return;
    }
    timer = setInterval(() => void tick(), settings.alertCheckSeconds * 1000);
    // 首不等一个完整间隔：应用刚开、集群刚探活完，先跑一轮才能把隔夜那条未恢复事件的
    // 观测值刷新上来。延几秒是给隧道建立与首帧渲染让路。
    kickoff = setTimeout(() => void tick(), 5000);
    log.info(`alert engine scheduled every ${settings.alertCheckSeconds}s`);
}

export function stopAlertEngine(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    if (kickoff) {
        clearTimeout(kickoff);
        kickoff = null;
    }
}

// 规则改了（阈值、口径、连续次数）就把它的命中计数清掉：留着旧计数会让
// "连续 N 轮"在新阈值下莫名其妙地少数几轮。
export function resetAlertRuntime(ruleId?: string): void {
    if (ruleId) {
        hitCounts.delete(ruleId);
        return;
    }
    hitCounts.clear();
}

// 「试跑」：只取一次数、给一个判定，不写事件也不动连续计数。
// 阈值填成 0 还是 10 万，用户在表单里当场就能看到结果，而不是等一个评估间隔。
export async function probeAlertRule(ruleId: string): Promise<AlertProbeResult> {
    const record = getAlertRuleById(ruleId);
    if (!record) {
        throw new Error('规则不存在，可能已被删除');
    }
    if (!deps) {
        throw new Error('告警引擎尚未就绪');
    }
    const rule = toAlertRule(record);
    // deps 由 registerAlertHandlers() 在注册这条通道之前注入，走到这里必然已绑定
    const client = await deps!.getClient(rule.clusterId);
    if (!client) {
        throw new Error('集群不存在，请先在集群配置里添加');
    }
    const value = (await fetchSample(client, rule))[rule.metric];
    const meta = alertMetric(rule.metric);
    return {
        value,
        breached: isBreached(rule.comparator, value, rule.threshold),
        message: buildAlertMessage(rule, value),
        valueText: formatAlertValue(rule.metric, value),
        thresholdText: formatAlertValue(rule.metric, rule.threshold),
        metricLabel: meta.label,
    };
}
