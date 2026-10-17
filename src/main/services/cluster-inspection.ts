/**
 * 集群巡检：一次只读采集 + 一组判定规则，产出一份能直接发给别人的报告。
 *
 * 与监控页的区别在于监控页回答「现在这条曲线是多少」，巡检回答「这个集群有没有
 * 需要人处理的东西」。所以这里的每一项判定都要给出可照着做的结论，而不是把数值
 * 再抄一遍。
 *
 * 这一层不碰 ipc、也不直接读 SQLite：告警事件由调用方取好传进来，broker 侧只通过
 * 传入的 client 访问。这样判定规则可以在没有集群的机器上被自测覆盖。
 */
import {mapWithConcurrency} from './http-client';
import {renderDiffMarkdown} from './inspection-diff';
import {resolveSampling, resolveThresholds, thresholdOverrides} from './inspection-profile';
import {INSPECTION_THRESHOLDS, THRESHOLD_LABELS, thresholdDisplay} from '../../shared/inspection-caliber';
import type {
    InspectionCheck,
    InspectionDiff,
    InspectionLevel,
    InspectionReport,
    InspectionThresholds,
    InspectionThresholdsDraft,
    InspectionTotals,
    TopicStats,
} from '../../shared/types';

/** 巡检要问 broker 的东西，全是已存在的只读端点。抽成接口以便自测塞假实现。 */
export interface InspectionClient {
    healthCheck(): Promise<boolean>;
    getVersion(): Promise<string | undefined>;
    getBrokers(): Promise<{activeBrokers: string[]; allBrokers: string[]}>;
    getTenants(): Promise<{name: string}[]>;
    getNamespaces(tenant: string): Promise<string[]>;
    getTopics(tenant: string, namespace: string): Promise<{name: string; persistent: boolean}[]>;
    getTopicStats(tenant: string, namespace: string, topic: string, persistent: boolean): Promise<TopicStats>;
    getWorkerState(force?: boolean): Promise<{enabled: boolean; nodes: unknown[]; notice?: string}>;
}

/** 未恢复的本地告警事件（由调用方从 SQLite 取，字段只留报告要用的）。 */
export interface InspectionAlertRow {
    ruleName: string;
    scopeLabel: string;
    message: string;
}

/**
 * topic 采样后的扁平行。
 *
 * 订阅的 msgBacklog 要自己加总：Admin 的 topic stats 顶层只有 backlogSize（字节），
 * 消息条数挂在每个订阅下，直接读顶层会恒为 0，看起来像「这个 topic 没有积压」。
 */
export interface InspectionTopicRow {
    name: string;
    persistent: boolean;
    msgRateIn: number;
    msgRateOut: number;
    backlog: number;
    backlogSize: number;
    producerCount: number;
    subscriptionCount: number;
    consumerCount: number;
    maxSubBacklog: number;
    maxSubBacklogName: string;
    maxUnacked: number;
    maxUnackedName: string;
    blockedSubscriptions: string[];
}

export function toInspectionTopicRow(name: string, persistent: boolean, stats: TopicStats): InspectionTopicRow {
    const entries = Object.values(stats?.subscriptions || {});
    let backlog = 0;
    let maxSubBacklog = 0;
    let maxSubBacklogName = '';
    let maxUnacked = 0;
    let maxUnackedName = '';
    let consumerCount = 0;
    const blocked: string[] = [];
    for (const sub of entries) {
        backlog += sub.msgBacklog || 0;
        consumerCount += sub.consumerCount || 0;
        if ((sub.msgBacklog || 0) > maxSubBacklog) {
            maxSubBacklog = sub.msgBacklog || 0;
            maxSubBacklogName = sub.name;
        }
        if ((sub.unackedMessages || 0) > maxUnacked) {
            maxUnacked = sub.unackedMessages || 0;
            maxUnackedName = sub.name;
        }
        // 只有 broker 明确说 true 才算阻塞：字段缺失的老 broker 不能判成故障
        if (sub.blockedSubscriptionOnUnackedMsgs === true) {
            blocked.push(sub.name);
        }
    }
    return {
        name,
        persistent,
        msgRateIn: stats?.msgRateIn || 0,
        msgRateOut: stats?.msgRateOut || 0,
        backlog,
        backlogSize: stats?.backlogSize || 0,
        producerCount: stats?.producers?.length || 0,
        subscriptionCount: entries.length,
        consumerCount,
        maxSubBacklog,
        maxSubBacklogName,
        maxUnacked,
        maxUnackedName,
        blockedSubscriptions: blocked,
    };
}

function check(
    key: string,
    title: string,
    level: InspectionLevel,
    summary: string,
    extra?: Partial<InspectionCheck>,
): InspectionCheck {
    return {key, title, level, summary, ...extra};
}

/** 连通性：healthCheck 失败时后面的检查全都没有意义，但报告仍然出，红字说清卡在哪。 */
export function buildConnectivityCheck(healthy: boolean): InspectionCheck {
    return healthy
        ? check('connectivity', 'Broker 健康检查', 'ok', '通过')
        : check('connectivity', 'Broker 健康检查', 'crit', '未通过', {
              suggestion: '确认 webServiceUrl 指向的是 broker 而不是其它 HTTP 服务，并检查认证是否仍然有效',
          });
}

/** active 少于 all 说明有 broker 掉出集群；此时 topic 归属与函数分配都不可信。 */
export function buildBrokerCheck(brokers: {activeBrokers: string[]; allBrokers: string[]}): InspectionCheck {
    const active = brokers.activeBrokers.length;
    const all = brokers.allBrokers.length;
    if (active === 0) {
        return check('brokers', 'Broker 存活', 'crit', '集群里没有活跃 broker', {
            detail: all ? [`已登记 ${all} 个，全部不在列表`] : undefined,
        });
    }
    if (all > active) {
        return check('brokers', 'Broker 存活', 'crit', `${active} 个活跃 / ${all} 个已登记`, {
            suggestion: '有 broker 掉线：负载与函数分配都落不到它身上，先把它拉起来再看待积压归属',
        });
    }
    return check('brokers', 'Broker 存活', 'ok', `${active} 个 broker 全部活跃`);
}

/** 消费端是否还在读：有积压却没有连接的消费者，是「生产者还在打、没人消费」的典型形态。 */
export function buildConsumerCheck(
    rows: InspectionTopicRow[],
    th: InspectionThresholds = INSPECTION_THRESHOLDS,
): InspectionCheck {
    const stalled = rows.filter(row => row.backlog > 0 && row.consumerCount === 0);
    if (!rows.length) {
        return check('consumers', '消费端在读', 'skip', '没有采样到 topic，无法判断');
    }
    if (!stalled.length) {
        return check('consumers', '消费端在读', 'ok', '采样范围内没有「有积压但无消费者」的 topic');
    }
    const total = stalled.reduce((sum, row) => sum + row.backlog, 0);
    return check(
        'consumers',
        '消费端在读',
        'crit',
        `${stalled.length} 个 topic 有积压但没有连接的消费者（共 ${total} 条）`,
        {
            detail: stalled
                .sort((a, b) => b.backlog - a.backlog)
                .slice(0, th.detailTopN)
                .map(row => `${row.name}：积压 ${row.backlog} 条，订阅 ${row.subscriptionCount} 个`),
            suggestion: '这些 topic 的积压只会随生产继续增长：确认消费者是否崩溃、订阅是否被删，或先把生产端停掉',
        },
    );
}

/** 总积压分级。按单 topic 最大值报而不是总量：一个 100 万条的 topic 比十个 1 万条的紧急得多。 */
export function buildBacklogCheck(
    rows: InspectionTopicRow[],
    th: InspectionThresholds = INSPECTION_THRESHOLDS,
): InspectionCheck {
    if (!rows.length) {
        return check('backlog', '消息积压', 'skip', '没有采样到 topic，无法判断积压');
    }
    const total = rows.reduce((sum, row) => sum + row.backlog, 0);
    const worst = rows.reduce((max, row) => (row.backlog > max.backlog ? row : max), rows[0]);
    const {backlogWarn, backlogCrit, detailTopN} = th;
    const level: InspectionLevel = worst.backlog >= backlogCrit ? 'crit' : worst.backlog >= backlogWarn ? 'warn' : 'ok';
    const detail = [...rows]
        .sort((a, b) => b.backlog - a.backlog)
        .slice(0, detailTopN)
        .map(row => `${row.name}：${row.backlog} 条${describeTopSubscription(row)}`);
    return check('backlog', '消息积压', level, `采样范围内共 ${total} 条积压，单 topic 最高 ${worst.backlog} 条`, {
        detail,
    });
}

// 明细行里带上「积压集中在哪个订阅」：一条 topic 上多个订阅时，只报总数没法定位是谁没消费。
function describeTopSubscription(row: InspectionTopicRow): string {
    if (!row.maxSubBacklogName) {
        return '';
    }
    return `（最大订阅 ${row.maxSubBacklogName} ${row.maxSubBacklog}）`;
}

/** 未 ack 与阻塞：broker 侧的消费能力被客户端占住，光看速率看不出来。 */
export function buildUnackedCheck(
    rows: InspectionTopicRow[],
    th: InspectionThresholds = INSPECTION_THRESHOLDS,
): InspectionCheck {
    if (!rows.length) {
        return check('unacked', '未 ack / 阻塞订阅', 'skip', '没有采样到 topic，无法判断未 ack');
    }
    const unackedTotal = rows.reduce((sum, row) => sum + row.maxUnacked, 0);
    const blocked = rows.filter(row => row.blockedSubscriptions.length);
    if (blocked.length) {
        return check(
            'unacked',
            '未 ack / 阻塞订阅',
            'crit',
            `${blocked.length} 个 topic 上有被阻塞的订阅（未 ack 上限已满）`,
            {
                detail: blocked
                    .slice(0, th.detailTopN)
                    .map(row => `${row.name}：${row.blockedSubscriptions.join('、')}`),
                suggestion:
                    '被阻塞的订阅不会收新消息：检查消费者是否只拉不 ack，或把 maxUnackedMessagesPerConsumer 调大',
            },
        );
    }
    const level: InspectionLevel = unackedTotal >= th.unackedWarn ? 'warn' : 'ok';
    return check('unacked', '未 ack / 阻塞订阅', level, `没有阻塞订阅，未 ack 合计 ${unackedTotal} 条`);
}

/** 生产明显快过消费：持续下去积压只增不减，是「还没爆但一定会爆」的那一类。 */
export function buildThroughputCheck(
    rows: InspectionTopicRow[],
    th: InspectionThresholds = INSPECTION_THRESHOLDS,
): InspectionCheck {
    const lagging = rows.filter(row => row.msgRateIn >= th.rateMinIn && row.msgRateIn >= row.msgRateOut * th.rateRatio);
    if (!rows.length) {
        return check('throughput', '生产与消费速率', 'skip', '没有采样到 topic，无法判断速率');
    }
    if (!lagging.length) {
        return check('throughput', '生产与消费速率', 'ok', '采样范围内没有持续入大于出的 topic');
    }
    return check('throughput', '生产与消费速率', 'warn', `${lagging.length} 个 topic 的入向速率明显高于出向`, {
        detail: lagging
            .sort((a, b) => b.msgRateIn - a.msgRateIn)
            .slice(0, th.detailTopN)
            .map(row => `${row.name}：入 ${row.msgRateIn.toFixed(1)}/s，出 ${row.msgRateOut.toFixed(1)}/s`),
        suggestion: '要么加消费者，要么在生产端限流；这个比例维持下去积压会一直增长',
    });
}

export function buildWorkerCheck(
    state: {enabled: boolean; nodes: unknown[]; notice?: string} | null,
    error?: string,
): InspectionCheck {
    if (error) {
        return check('workers', '函数 / 连接器 worker', 'skip', 'worker 状态读不到', {detail: [error]});
    }
    if (!state) {
        return check('workers', '函数 / 连接器 worker', 'skip', 'worker 状态未采集');
    }
    if (!state.enabled) {
        return check('workers', '函数 / 连接器 worker', 'skip', '该集群没有启用 worker 服务', {
            detail: state.notice ? [state.notice] : undefined,
        });
    }
    if (!state.nodes.length) {
        return check('workers', '函数 / 连接器 worker', 'crit', 'worker 已启用但没有在线节点', {
            suggestion: '函数与连接器不会被调度：先看 broker 启动日志里的 worker 配置',
        });
    }
    return check('workers', '函数 / 连接器 worker', 'ok', `worker 在线节点 ${state.nodes.length} 个`);
}

export function buildAlertCheck(
    alerts: InspectionAlertRow[],
    th: InspectionThresholds = INSPECTION_THRESHOLDS,
): InspectionCheck {
    if (!alerts.length) {
        return check('alerts', '未恢复的本地告警', 'ok', '没有未恢复的告警事件');
    }
    return check('alerts', '未恢复的本地告警', 'warn', `${alerts.length} 条告警仍未恢复`, {
        detail: alerts.slice(0, th.detailTopN).map(item => `${item.ruleName}｜${item.scopeLabel}｜${item.message}`),
        suggestion: '这些是应用内告警规则判出来的，处置完在告警中心确认或恢复，别让它们一直挂着',
    });
}

export function sumTotals(checks: InspectionCheck[]): InspectionTotals {
    const totals: InspectionTotals = {ok: 0, warn: 0, crit: 0, skip: 0};
    for (const item of checks) {
        totals[item.level] += 1;
    }
    return totals;
}

/** 逐段采集：任何一段失败都变成一条 skip/warn 检查，而不是让整份报告消失。 */
export async function runInspection(
    client: InspectionClient,
    input: {
        clusterId: string;
        clusterName: string;
        alerts: InspectionAlertRow[];
        options?: {maxNamespaces?: number; maxTopics?: number};
        thresholds?: InspectionThresholdsDraft;
    },
): Promise<InspectionReport> {
    // 口径在这里一次算定并抄进报告：判定过程中不再回头读配置表，
    // 否则一份采集了半分钟的报告，中途改一次阈值就会让它一半按旧线、一半按新线
    const th = resolveThresholds(input.thresholds);
    const {maxNamespaces, maxTopics} = resolveSampling(input.options ?? {});
    const checks: InspectionCheck[] = [];
    const errors: string[] = [];

    let version: string | null = null;
    try {
        const healthy = await client.healthCheck();
        checks.push(buildConnectivityCheck(healthy));
    } catch (error) {
        checks.push(buildConnectivityCheck(false));
        errors.push(`健康检查异常：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
        version = (await client.getVersion()) || null;
    } catch (error) {
        errors.push(`版本读取异常：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
        checks.push(buildBrokerCheck(await client.getBrokers()));
    } catch (error) {
        checks.push(
            check('brokers', 'Broker 存活', 'skip', 'broker 列表读取失败', {
                detail: [error instanceof Error ? error.message : String(error)],
            }),
        );
    }

    let tenants: {name: string}[] = [];
    try {
        tenants = await client.getTenants();
    } catch (error) {
        errors.push(`租户列表读取失败：${error instanceof Error ? error.message : String(error)}`);
    }

    // 命名空间与 topic 都按上限收紧后再采样：一次巡检发几千个请求等于 DDoS 自己的 broker，
    // 与告警引擎同一口径。截断情况通过 scope 显式报给界面。
    const sampled: {tenant: string; namespace: string}[] = [];
    let namespacesTruncated = false;
    for (const tenant of tenants) {
        if (sampled.length >= maxNamespaces) {
            namespacesTruncated = true;
            break;
        }
        let namespaces: string[] = [];
        try {
            namespaces = await client.getNamespaces(tenant.name);
        } catch (error) {
            errors.push(
                `租户 ${tenant.name} 的命名空间读取失败：${error instanceof Error ? error.message : String(error)}`,
            );
            continue;
        }
        for (const namespace of namespaces) {
            if (sampled.length >= maxNamespaces) {
                namespacesTruncated = true;
                break;
            }
            sampled.push({tenant: tenant.name, namespace});
        }
    }

    const rows: InspectionTopicRow[] = [];
    let topicsSeen = 0;
    let topicsTruncated = false;
    for (const {tenant, namespace} of sampled) {
        let topics: {name: string; persistent: boolean}[] = [];
        try {
            topics = await client.getTopics(tenant, namespace);
        } catch (error) {
            errors.push(
                `命名空间 ${namespace} 的 topic 列表读取失败：${error instanceof Error ? error.message : String(error)}`,
            );
            continue;
        }
        // 计数按全量、采样按截断后的子集：只有这样才能把「看了 60 个、漏了 400 个」说清楚
        topicsSeen += topics.length;
        const remaining = maxTopics - rows.length;
        if (topics.length > remaining) {
            topicsTruncated = true;
        }
        const picked = topics.slice(0, Math.max(0, remaining));
        const sampledRows = await mapWithConcurrency(picked, 4, async topic => {
            try {
                const stats = await client.getTopicStats(tenant, namespace, topic.name, topic.persistent);
                return toInspectionTopicRow(topic.name, topic.persistent, stats);
            } catch (error) {
                errors.push(
                    `topic ${topic.name} 的统计读取失败：${error instanceof Error ? error.message : String(error)}`,
                );
                return null;
            }
        });
        rows.push(...sampledRows.filter((row): row is InspectionTopicRow => row !== null));
        if (rows.length >= maxTopics) {
            break;
        }
    }

    checks.push(buildBacklogCheck(rows, th));
    checks.push(buildConsumerCheck(rows, th));
    checks.push(buildUnackedCheck(rows, th));
    checks.push(buildThroughputCheck(rows, th));

    try {
        checks.push(buildWorkerCheck(await client.getWorkerState()));
    } catch (error) {
        checks.push(buildWorkerCheck(null, error instanceof Error ? error.message : String(error)));
    }
    checks.push(buildAlertCheck(input.alerts, th));

    if (errors.length) {
        checks.push(
            check('collect', '采集过程中的局部失败', 'warn', `${errors.length} 次请求没有拿到数据`, {
                detail: errors.slice(0, th.detailTopN),
                suggestion: '局部失败不影响其余判定，但报告覆盖范围比看上去小：老 broker 缺少端点时会集中出现',
            }),
        );
    }

    return {
        clusterId: input.clusterId,
        clusterName: input.clusterName,
        generatedAt: new Date().toISOString(),
        version,
        scope: {
            tenants: tenants.length,
            namespacesSeen: sampled.length,
            topicsSeen,
            topicsSampled: rows.length,
            maxNamespaces,
            maxTopics,
            truncated: namespacesTruncated || topicsTruncated,
        },
        checks,
        totals: sumTotals(checks),
        thresholds: th,
    };
}

const LEVEL_MARKS: Record<InspectionLevel, string> = {crit: '🔴', warn: '🟠', ok: '🟢', skip: '⚪'};
const LEVEL_NAMES: Record<InspectionLevel, string> = {crit: '严重', warn: '关注', ok: '正常', skip: '未覆盖'};

/** 本次生效的口径。改过判定线时必须写在文件里，否则读到的人会以为红字是按默认线判的。 */
function describeThresholds(thresholds: InspectionThresholds): string {
    const overrides = thresholdOverrides(thresholds);
    if (!overrides.length) {
        return '判定口径：默认阈值';
    }
    const parts = overrides.map(field => `${THRESHOLD_LABELS[field]} ${thresholdDisplay(field, thresholds[field])}`);
    return `判定口径（已按本集群调整）：${parts.join('，')}`;
}

/**
 * 报告要能脱离应用被读懂（贴进工单、发到群里），所以 Markdown 里把采样范围与
 * 截断都写全——读到文件的人不知道范围，就会把「没有发现高积压」当成全集群结论。
 * 环比段插在结论清单之前：拿到文件的人最先要判断的是「比上次好了还是坏了」。
 */
export function renderInspectionMarkdown(report: InspectionReport, diff?: InspectionDiff | null): string {
    const lines: string[] = [];
    lines.push(`# Pulsar 集群巡检报告：${report.clusterName}`);
    lines.push('');
    lines.push(`- 生成时间：${report.generatedAt}`);
    lines.push(`- 集群标识：${report.clusterId}`);
    lines.push(`- broker 版本：${report.version || '未取到'}`);
    lines.push(
        `- 采样范围：${report.scope.tenants} 个租户，${report.scope.namespacesSeen}/${report.scope.maxNamespaces} 个命名空间，` +
            `共见到 ${report.scope.topicsSeen} 个 topic、逐个采集 ${report.scope.topicsSampled} 个（上限 ${report.scope.maxTopics}）`,
    );
    lines.push(
        `- 结论：${LEVEL_NAMES.crit} ${report.totals.crit} 项、${LEVEL_NAMES.warn} ${report.totals.warn} 项、` +
            `${LEVEL_NAMES.ok} ${report.totals.ok} 项、${LEVEL_NAMES.skip} ${report.totals.skip} 项`,
    );
    // v2.8 存进库的报告里没有 thresholds 这一格，缺省就不写这行：
    // 拿默认值替它编一句「默认阈值」是把没记下来的事情说成记下来了
    if (report.thresholds) {
        lines.push(`- ${describeThresholds(report.thresholds)}`);
    }
    if (report.scope.truncated) {
        lines.push('- 注意：采样在命名空间或 topic 上限处被截断，未采样的部分不在本报告结论之内');
    }
    lines.push('');
    if (diff) {
        lines.push(...renderDiffMarkdown(diff));
    }
    for (const item of report.checks) {
        lines.push(`## ${LEVEL_MARKS[item.level]} ${item.title}（${LEVEL_NAMES[item.level]}）`);
        lines.push('');
        lines.push(item.summary);
        if (item.detail?.length) {
            lines.push('');
            for (const line of item.detail) {
                lines.push(`- ${line}`);
            }
        }
        if (item.suggestion) {
            lines.push('');
            lines.push(`建议：${item.suggestion}`);
        }
        lines.push('');
    }
    return lines.join('\n');
}
