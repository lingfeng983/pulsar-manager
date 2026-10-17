import {REQUEST_CONFIG} from '../config/constants';
import {mapWithConcurrency} from './http-client';
import {
    QUOTA_TYPES,
    RETENTION_POLICIES,
    isClearablePolicyField,
    policyValueOf,
    POLICY_FIELDS,
} from './namespace-policy-api';
import type {
    NamespaceBacklogQuota,
    NamespacePolicyField,
    NamespacePolicySyncApplyResult,
    NamespacePolicySyncDelta,
    NamespacePolicySyncItemResult,
    NamespacePolicySyncParams,
    NamespacePolicySyncPlanResult,
    NamespacePolicySyncScope,
    NamespacePolicySyncTargetPlan,
    NamespacePolicySyncTargetResult,
    NamespacePolicyView,
} from '../../shared/types';

// 命名空间策略的批量同步：把一份「已经调好的」命名空间策略推到同集群的多个目标上。
//
// 这里刻意不接收渲染层算好的差异，也不接收任意值：plan 与 apply 都在主进程重新读一遍
// 两边的 Policies 再算。界面传来什么值就写什么值，等于把字段表的取值校验绕过去了一半。
//
// 语义是「让目标在所选字段上等于源」，不是「合并两边的配置」：
// 源上未设置、目标上设过 → 清除目标（前提是该字段有 DELETE 端点，没有就如实说不能动）；
// 源上有值 → 整值覆盖目标。所以选字段时要克制，retention 与 backlogQuota 都是整体替换。

// 单次同步的目标上限。每个目标要读 6 个端点（1 份 Policies + 5 个限速），
// 再乘上字段数就是写入次数；放到 50 个目标会在共享的 broker 上排出一条长队。
export const NAMESPACE_SYNC_MAX_TARGETS = 20;

// 只依赖三个方法的结构化接口：facade（PulsarAdminClient）天然满足，
// 自测里的假客户端也不用继承它，避免同步逻辑和客户端管理器绑死。
interface PolicyClient {
    getPolicies(tenant: string, namespace: string): Promise<NamespacePolicyView>;
    setNamespacePolicy(tenant: string, namespace: string, field: NamespacePolicyField, value: unknown): Promise<void>;
    clearNamespacePolicy(
        tenant: string,
        namespace: string,
        field: NamespacePolicyField,
        quotaType?: string,
    ): Promise<void>;
}

function scopeKey(scope: NamespacePolicySyncScope): string {
    return `${scope.tenant}/${scope.namespace}`;
}

/**
 * 规范化比较键。两处口径需要说明：
 * - 数组按集合比较：broker 把 replication_clusters 当集合用，顺序不同不算差异，
 *   否则每次同步都会把同样的名单重下一遍，操作日志里全是没意义的改动。
 * - null 与 undefined 同一个键：折叠层的「没读到」和「读回来是 null」在比对上是同一件事。
 *
 * 导出给 topic 级同步复用：比较口径写两份，迟早一边认顺序、另一边认集合。
 */
export function canonical(value: unknown): string {
    if (value === null || value === undefined) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return JSON.stringify(value.map(item => canonical(item)).sort());
    }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return JSON.stringify(
            Object.keys(record)
                .sort()
                .map(key => [key, canonical(record[key])]),
        );
    }
    return JSON.stringify(value);
}

export function isUnset(value: unknown): boolean {
    return value === null || value === undefined;
}

/** 配额能不能原样写回：未知枚举写回去只会被 broker 拒成 400，先把话说清楚。 */
function quotaValue(quota: NamespaceBacklogQuota): {value: unknown; unusable?: string} {
    if (!QUOTA_TYPES.includes(quota.type)) {
        return {value: null, unusable: `配额类型 ${quota.type} 不在当前 broker 支持的枚举内，写入会被拒绝`};
    }
    if (!RETENTION_POLICIES.includes(quota.policy)) {
        return {value: null, unusable: `超限策略 ${quota.policy} 不在当前 broker 支持的枚举内，写入会被拒绝`};
    }
    return {
        value: {
            type: quota.type,
            limitSizeBytes: quota.limitSizeBytes,
            limitTimeSeconds: quota.limitTimeSeconds,
            policy: quota.policy,
        },
    };
}

function planBacklogQuota(source: NamespacePolicyView, target: NamespacePolicyView): NamespacePolicySyncDelta[] {
    const deltas: NamespacePolicySyncDelta[] = [];
    const targetByType = new Map(target.backlogQuotas.map(quota => [quota.type, quota]));
    const sourceTypes = new Set(source.backlogQuotas.map(quota => quota.type));

    for (const quota of source.backlogQuotas) {
        const current = targetByType.get(quota.type);
        if (current && canonical(quota) === canonical(current)) {
            continue;
        }
        const {value, unusable} = quotaValue(quota);
        deltas.push(
            unusable
                ? {field: 'backlogQuota', action: 'skip', quotaType: quota.type, reason: unusable}
                : {field: 'backlogQuota', action: 'set', quotaType: quota.type, value},
        );
    }

    // 源上没有、目标上有的那一条：同步的语义是「等于源」，所以这里清除而不是留着。
    // 老 broker 上没读到的配额类型不会被列出来，也就不会被误删。
    for (const quota of target.backlogQuotas) {
        if (!sourceTypes.has(quota.type)) {
            deltas.push({field: 'backlogQuota', action: 'clear', quotaType: quota.type});
        }
    }
    return deltas;
}

function planField(
    field: NamespacePolicyField,
    source: NamespacePolicyView,
    target: NamespacePolicyView,
): NamespacePolicySyncDelta[] {
    if (field === 'backlogQuota') {
        return planBacklogQuota(source, target);
    }
    const from = policyValueOf(source, field);
    const to = policyValueOf(target, field);
    if (canonical(from) === canonical(to)) {
        return [];
    }
    if (isUnset(from)) {
        // 源没设过、目标设过：能清就清，不能清就讲明白为什么这次不动它
        if (!isClearablePolicyField(field)) {
            return [
                {
                    field,
                    action: 'skip',
                    reason: '源命名空间未设置该项，而这个字段在 broker 侧没有清除端点，目标上的现有值保持不变',
                },
            ];
        }
        return [{field, action: 'clear'}];
    }
    return [{field, action: 'set', value: from}];
}

/**
 * 单个目标的差异计划。字段顺序按字段表走而不是按调用方传来的顺序：
 * 预览、执行、操作日志要用同一套顺序，否则同一份配置两次同步出的日志对不上。
 */
export function planPolicySync(
    source: NamespacePolicyView,
    target: NamespacePolicyView,
    fields: NamespacePolicyField[],
): NamespacePolicySyncDelta[] {
    const wanted = new Set(fields);
    const deltas: NamespacePolicySyncDelta[] = [];
    for (const field of POLICY_FIELDS) {
        if (wanted.has(field)) {
            deltas.push(...planField(field, source, target));
        }
    }
    return deltas;
}

function normalizeTargets(
    source: NamespacePolicySyncScope,
    targets: NamespacePolicySyncScope[],
): NamespacePolicySyncScope[] {
    const seen = new Set([scopeKey(source)]);
    const list: NamespacePolicySyncScope[] = [];
    for (const target of targets) {
        const key = scopeKey(target);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        list.push({tenant: target.tenant, namespace: target.namespace});
    }
    if (list.length === 0) {
        throw new Error('没有可同步的目标命名空间：目标不能为空，也不能就是源本身');
    }
    if (list.length > NAMESPACE_SYNC_MAX_TARGETS) {
        throw new Error(
            `一次最多同步 ${NAMESPACE_SYNC_MAX_TARGETS} 个命名空间（本次 ${list.length} 个）：` +
                '每个目标要读 6 个端点、写 N 个字段，放大了会把 broker 的请求队列占满',
        );
    }
    return list;
}

async function readView(client: PolicyClient, scope: NamespacePolicySyncScope): Promise<NamespacePolicyView> {
    return client.getPolicies(scope.tenant, scope.namespace);
}

// 界面要把「目标当前值 → 同步后」两边都翻译成文案，所以视图跟着差异一起返回。
// 但整份 raw（Policies 与每个限速的原始体）不过 IPC：一次预览就是 20 个目标各带一份，
// 体积到了几百 KB，而折叠字段已经够界面画出值了。
function stripRate(rate: NamespacePolicyView['dispatchRate']): NamespacePolicyView['dispatchRate'] {
    return rate ? {...rate, raw: {}} : null;
}

function toDisplayView(view: NamespacePolicyView): NamespacePolicyView {
    return {
        ...view,
        raw: {},
        dispatchRate: stripRate(view.dispatchRate),
        subscriptionDispatchRate: stripRate(view.subscriptionDispatchRate),
        subscribeRate: stripRate(view.subscribeRate),
        publishRate: stripRate(view.publishRate),
        replicatorDispatchRate: stripRate(view.replicatorDispatchRate),
    };
}

/** 只读、只算差异：预览与执行共用这一条读取路径，保证「看到的」与「写下去依据的」是同一份数。 */
export async function planNamespacePolicySync(
    client: PolicyClient,
    params: NamespacePolicySyncParams,
): Promise<NamespacePolicySyncPlanResult> {
    const targets = normalizeTargets(params.source, params.targets);
    let source: NamespacePolicyView;
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
        const plan: NamespacePolicySyncTargetPlan = {tenant: target.tenant, namespace: target.namespace, deltas: []};
        try {
            const view = await readView(client, target);
            plan.view = toDisplayView(view);
            plan.deltas = planPolicySync(source, view, params.fields);
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
 * 一个命名空间读不通往往意味着整片都写不通，继续往后写只会把 broker 的错误
 * 一条条堆进操作日志，而前一项失败恰恰是后一项的前提（例如限速整对象替换）。
 */
export async function applyNamespacePolicySync(
    client: PolicyClient,
    params: NamespacePolicySyncParams,
): Promise<NamespacePolicySyncApplyResult> {
    const targets = normalizeTargets(params.source, params.targets);
    let source: NamespacePolicyView;
    try {
        source = await readView(client, params.source);
    } catch (error) {
        throw new Error(`读取源命名空间 ${scopeKey(params.source)} 失败：${(error as Error).message}`);
    }

    const results = await mapWithConcurrency(
        targets,
        REQUEST_CONFIG.FANOUT_CONCURRENCY,
        async (target): Promise<NamespacePolicySyncTargetResult> => {
            const result: NamespacePolicySyncTargetResult = {
                tenant: target.tenant,
                namespace: target.namespace,
                items: [],
            };
            let view: NamespacePolicyView;
            try {
                view = await readView(client, target);
            } catch (error) {
                // 读不出目标就一个字段都不动：这时候写下去的依据全是猜的
                result.error = `读取目标命名空间策略失败：${(error as Error).message}`;
                return result;
            }

            for (const delta of planPolicySync(source, view, params.fields)) {
                if (delta.action === 'skip') {
                    result.items.push({
                        field: delta.field,
                        action: 'skip',
                        quotaType: delta.quotaType,
                        ok: true,
                        message: delta.reason,
                    });
                    continue;
                }
                const item: NamespacePolicySyncItemResult = {
                    field: delta.field,
                    action: delta.action,
                    quotaType: delta.quotaType,
                    ok: true,
                };
                try {
                    if (delta.action === 'clear') {
                        await client.clearNamespacePolicy(
                            target.tenant,
                            target.namespace,
                            delta.field,
                            delta.quotaType,
                        );
                    } else {
                        await client.setNamespacePolicy(target.tenant, target.namespace, delta.field, delta.value);
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
