import {REQUEST_CONFIG} from '../config/constants';
import {mapWithConcurrency} from './http-client';
import {isUnset, canonical} from './namespace-policy-sync';
import {TOPIC_POLICY_FIELDS, isClearableTopicPolicyField, topicPolicyValueOf} from './topic-policy-api';
import type {
    TopicPolicyField,
    TopicPolicySyncApplyResult,
    TopicPolicySyncDelta,
    TopicPolicySyncItemResult,
    TopicPolicySyncParams,
    TopicPolicySyncPlanResult,
    TopicPolicySyncScope,
    TopicPolicySyncTargetPlan,
    TopicPolicySyncTargetResult,
    TopicPolicyView,
} from '../../shared/types';

// Topic 级策略的批量同步：把一个「已经调好的」topic 覆盖推到同集群的多个 topic 上。
//
// 与命名空间同步共用同一套口径（plan 与 apply 都在主进程重新读两边、界面传来的值不作依据），
// 但 topic 级多一条只有它才有的坑：这里的读是五条端点拼一份视图，任何一条读不通
// 都会落进 view.unavailable。老 broker 缺端点、topicLevelPoliciesEnabled=false
// 都会让五个字段整片「读不出来」，而读不出来在折叠层就是 null——
// 如果不把 unavailable 单独挡掉，同步会把「读不到」当成「源没设过」，
// 于是对每个目标发一次 DELETE：那是一次把别人配好的覆盖批量清空的破坏性操作。
// 所以比对前先看这一项在两边各自能不能读，读不到就 skip 并带上 broker 的原因。

// 单次同步的目标上限。每个目标要读 6 个端点（1 次存在性探针 + 5 个字段），
// 再乘上字段数就是写入次数；这里的单位是 topic，数量级比命名空间更敏感，
// 放到 50 个目标会在共享的 broker 上排出一条长队。
export const TOPIC_SYNC_MAX_TARGETS = 20;

// 只依赖三个方法的结构化接口：facade（PulsarAdminClient）天然满足，
// 自测里的假客户端也不用继承它，避免同步逻辑和客户端管理器绑死。
interface TopicPolicyClient {
    getTopicPolicies(tenant: string, namespace: string, topic: string, persistent?: boolean): Promise<TopicPolicyView>;
    setTopicPolicy(
        tenant: string,
        namespace: string,
        topic: string,
        field: TopicPolicyField,
        value: unknown,
        persistent?: boolean,
    ): Promise<void>;
    clearTopicPolicy(
        tenant: string,
        namespace: string,
        topic: string,
        field: TopicPolicyField,
        persistent?: boolean,
    ): Promise<void>;
}

function scopeKey(scope: TopicPolicySyncScope): string {
    return `${scope.persistent ? 'persistent' : 'non-persistent'}/${scope.tenant}/${scope.namespace}/${scope.topic}`;
}

function unavailableReason(view: TopicPolicyView, field: TopicPolicyField): string | undefined {
    return view.unavailable.find(item => item.field === field)?.reason;
}

/**
 * 单个字段在某个 topic 上的「可比依据」。三种结果：
 * - 可比对：给出这个字段再次写入时的值；
 * - 这一项读不出来：broker 缺端点或没开开关，不能参与同步；
 * - 保留策略只读出一半：不知道该写成什么，也不能拿它去清别人。
 */
function comparableOf(view: TopicPolicyView, field: TopicPolicyField): {unusable: string} | {value: unknown} {
    const reason = unavailableReason(view, field);
    if (reason) {
        return {unusable: `读不到该项（${reason}）`};
    }
    if (field === 'retention' && (view.retentionTimeInMinutes === null) !== (view.retentionSizeInMB === null)) {
        // POST /retention 是整体替换：只读出一半时既不知道该写什么，
        // 更不能按「未设置」去清目标——那会把两个维度一起删掉。
        return {unusable: 'topic 级保留策略只读出一个维度，无法还原成整对象'};
    }
    return {value: topicPolicyValueOf(view, field)};
}

function planField(field: TopicPolicyField, source: TopicPolicyView, target: TopicPolicyView): TopicPolicySyncDelta[] {
    const from = comparableOf(source, field);
    if ('unusable' in from) {
        return [{field, action: 'skip', reason: `源 topic 上${from.unusable}`}];
    }
    const to = comparableOf(target, field);
    if ('unusable' in to) {
        // 目标读不出来就连清除也做不了：我们并不知道它现在是什么
        return [{field, action: 'skip', reason: `目标 topic 上${to.unusable}`}];
    }
    if (canonical(from.value) === canonical(to.value)) {
        return [];
    }
    if (isUnset(from.value)) {
        // 源没设过、目标设过：同步语义是「等于源」，所以撤销目标上的 topic 级覆盖。
        // 五个端点都有 DELETE，正常走不到 skip；留着这条分支是因为清除名单来自主进程字段表，
        // 以后收到没有 DELETE 的端点时不该静默清掉别人的覆盖。
        if (!isClearableTopicPolicyField(field)) {
            return [
                {
                    field,
                    action: 'skip',
                    reason: '源 topic 未设置该项，而这个字段在 broker 侧没有清除端点，目标上的现有值保持不变',
                },
            ];
        }
        return [{field, action: 'clear'}];
    }
    return [{field, action: 'set', value: from.value}];
}

/**
 * 单个目标的差异计划。字段顺序按字段表走而不是按调用方传来的顺序：
 * 预览、执行、操作日志要用同一套顺序，否则同一份配置两次同步出的日志对不上。
 */
export function planTopicPolicyDiff(
    source: TopicPolicyView,
    target: TopicPolicyView,
    fields: TopicPolicyField[],
): TopicPolicySyncDelta[] {
    const wanted = new Set(fields);
    const deltas: TopicPolicySyncDelta[] = [];
    for (const field of TOPIC_POLICY_FIELDS) {
        if (wanted.has(field)) {
            deltas.push(...planField(field, source, target));
        }
    }
    return deltas;
}

function normalizeTargets(source: TopicPolicySyncScope, targets: TopicPolicySyncScope[]): TopicPolicySyncScope[] {
    const seen = new Set([scopeKey(source)]);
    const list: TopicPolicySyncScope[] = [];
    for (const target of targets) {
        const scope: TopicPolicySyncScope = {
            tenant: target.tenant,
            namespace: target.namespace,
            topic: target.topic,
            persistent: target.persistent,
        };
        const key = scopeKey(scope);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        list.push(scope);
    }
    if (list.length === 0) {
        throw new Error(
            '没有可同步的目标 topic：目标不能为空，也不能就是源本身' +
                '（persistent 与 non-persistent 下的同名 topic 是两个不同的 topic）',
        );
    }
    if (list.length > TOPIC_SYNC_MAX_TARGETS) {
        throw new Error(
            `一次最多同步 ${TOPIC_SYNC_MAX_TARGETS} 个 topic（本次 ${list.length} 个）：` +
                '每个目标要读 6 个端点、写 N 个字段，放大了会把 broker 的请求队列占满',
        );
    }
    return list;
}

async function readView(client: TopicPolicyClient, scope: TopicPolicySyncScope): Promise<TopicPolicyView> {
    return client.getTopicPolicies(scope.tenant, scope.namespace, scope.topic, scope.persistent);
}

function toDisplayView(view: TopicPolicyView): TopicPolicyView {
    // 一次预览带 20 个目标，每个目标的 raw 是五份端点原文；折叠字段已经够界面画值了
    return {...view, raw: {}};
}

/** 只读、只算差异：预览与执行共用这一条读取路径，保证「看到的」与「写下去依据的」是同一份数。 */
export async function planTopicPolicySync(
    client: TopicPolicyClient,
    params: TopicPolicySyncParams,
): Promise<TopicPolicySyncPlanResult> {
    const targets = normalizeTargets(params.source, params.targets);
    let source: TopicPolicyView;
    try {
        source = await readView(client, params.source);
    } catch (error) {
        // 源都读不出来就没有可比的东西，这时返回结构化错误而不是抛：
        // 预览面板要能把原因显示在界面上，而不是整张弹窗空白
        return {
            source: params.source,
            sourceError: error instanceof Error ? error.message : String(error),
            targets: [],
        };
    }

    const plans = await mapWithConcurrency(targets, REQUEST_CONFIG.FANOUT_CONCURRENCY, async target => {
        const plan: TopicPolicySyncTargetPlan = {
            tenant: target.tenant,
            namespace: target.namespace,
            topic: target.topic,
            persistent: target.persistent,
            deltas: [],
        };
        try {
            const view = await readView(client, target);
            plan.view = toDisplayView(view);
            plan.deltas = planTopicPolicyDiff(source, view, params.fields);
        } catch (error) {
            plan.error = error instanceof Error ? error.message : String(error);
        }
        return plan;
    });

    return {source: params.source, sourceView: toDisplayView(source), targets: plans};
}

/**
 * 执行同步。每个目标重新读一遍再算差异（不信界面上那份预览），
 * 目标内按字段顺序串行写，某一项失败就中止该目标：
 * 一个 topic 读不通往往意味着整片都写不通，继续往后写只会把 broker 的错误
 * 一条条堆进操作日志，而前一项失败恰恰是后一项的前提（例如 retention 整对象替换）。
 */
export async function applyTopicPolicySync(
    client: TopicPolicyClient,
    params: TopicPolicySyncParams,
): Promise<TopicPolicySyncApplyResult> {
    const targets = normalizeTargets(params.source, params.targets);
    let source: TopicPolicyView;
    try {
        source = await readView(client, params.source);
    } catch (error) {
        throw new Error(`读取源 topic ${scopeKey(params.source)} 失败：${(error as Error).message}`);
    }

    const results = await mapWithConcurrency(
        targets,
        REQUEST_CONFIG.FANOUT_CONCURRENCY,
        async (target): Promise<TopicPolicySyncTargetResult> => {
            const result: TopicPolicySyncTargetResult = {
                tenant: target.tenant,
                namespace: target.namespace,
                topic: target.topic,
                persistent: target.persistent,
                items: [],
            };
            let view: TopicPolicyView;
            try {
                view = await readView(client, target);
            } catch (error) {
                // 读不出目标就一个字段都不动：这时候写下去的依据全是猜的
                result.error = `读取目标 topic 策略失败：${(error as Error).message}`;
                return result;
            }

            for (const delta of planTopicPolicyDiff(source, view, params.fields)) {
                if (delta.action === 'skip') {
                    result.items.push({field: delta.field, action: 'skip', ok: true, message: delta.reason});
                    continue;
                }
                const item: TopicPolicySyncItemResult = {field: delta.field, action: delta.action, ok: true};
                try {
                    if (delta.action === 'clear') {
                        await client.clearTopicPolicy(
                            target.tenant,
                            target.namespace,
                            target.topic,
                            delta.field,
                            target.persistent,
                        );
                    } else {
                        await client.setTopicPolicy(
                            target.tenant,
                            target.namespace,
                            target.topic,
                            delta.field,
                            delta.value,
                            target.persistent,
                        );
                    }
                } catch (error) {
                    item.ok = false;
                    item.message = (error as Error).message;
                    result.items.push(item);
                    // 中止本目标：剩下的项没执行，也不假装执行过
                    return result;
                }
                result.items.push(item);
            }
            return result;
        },
    );

    let succeeded = 0;
    let failed = 0;
    for (const target of results) {
        for (const item of target.items) {
            if (item.action === 'skip') {
                continue;
            }
            if (item.ok) {
                succeeded += 1;
            } else {
                failed += 1;
            }
        }
    }
    return {targets: results, succeeded, failed};
}
