import {
    MutationAudit,
    TopicPolicyClearSchema,
    TopicPolicyGetSchema,
    TopicPolicySetSchema,
    TopicPolicySyncSchema,
    registerClientHandler,
    registerMutationHandler,
} from './_shared';
import {applyTopicPolicySync, planTopicPolicySync} from '../services/topic-policy-sync';
import type {TopicPolicyField, TopicPolicySyncParams, TopicPolicySyncScope} from '../../shared/types';

// Topic 级策略与命名空间策略一样是纯 broker 状态：值存在 broker 那边才改得动，
// 导出配置包时也跟着集群走，不需要在本地 SQLite 里再留一份副本。

// strict:false 之下 z.infer 出来的属性全是可选，三条通道的 audit 与参数又几乎同形，
// 所以共用一份宽松的入参类型，参数在服务调用处逐键补齐。
interface TopicPolicyInput {
    tenant?: string;
    namespace?: string;
    topic?: string;
    persistent?: boolean;
    field?: TopicPolicyField;
    value?: unknown;
}

function scopeOf(input: TopicPolicyInput): string {
    const persistent = input.persistent ?? true;
    return `${persistent ? 'persistent' : 'non-persistent'}/${input.tenant}/${input.namespace}/${input.topic}`;
}

function topicAudit(action: string) {
    return (input: TopicPolicyInput): MutationAudit => ({
        action,
        resource_type: 'pulsar_topic',
        resource_id: scopeOf(input),
        resource_name: input.field || 'unknown',
        // 值原样进 details：策略改动事后要查的就是「改成了什么」。
        // 载荷形状由字段表限死（裸标量或两键对象），不会把整段文档写进日志。
        details: JSON.stringify({field: input.field, value: input.value ?? null}),
    });
}

function passThrough([params]: unknown[]) {
    return params ?? {};
}

// 批量同步的入参形状：字段全部写成可选，理由与 TopicPolicyInput 相同
// （strict:false 之下 z.infer 的属性看着就是可选，两处各写一遍迟早漂移）。
interface SyncInput {
    clusterId?: string;
    source?: Partial<TopicPolicySyncScope>;
    targets?: Partial<TopicPolicySyncScope>[];
    fields?: TopicPolicyField[];
}

// 把那份「全是可选」的解析结果换成服务层要的必填形状。这些键在 schema 那一层
// 已经保证存在，所以这里用非空断言收口，而不是给编排层加一条「参数缺失」的分支。
// persistent 走 ?? true 而不是非空断言：schema 里它是必填布尔，
// 但这里的类型是 Partial，写断言会让「没带 persistent」在类型上看不出来。
function toSyncParams(input: SyncInput): TopicPolicySyncParams {
    const scope = (value: Partial<TopicPolicySyncScope>): TopicPolicySyncScope => ({
        tenant: value.tenant!,
        namespace: value.namespace!,
        topic: value.topic!,
        persistent: value.persistent ?? true,
    });
    return {
        clusterId: input.clusterId!,
        source: scope(input.source ?? {}),
        targets: (input.targets ?? []).map(scope),
        fields: input.fields ?? [],
    };
}

// 一次同步改的是十几个 topic × 若干字段，逐条落日志会把「谁改了什么」淹在行数里；
// 这里记一整笔：源、目标清单、字段清单。改坏了要回滚，按这笔的 fields + targets 反着来即可。
function syncAudit(input: SyncInput): MutationAudit {
    const source = scopeOf(input.source ?? {});
    return {
        action: 'sync_topic_policies',
        resource_type: 'pulsar_topic',
        resource_id: source,
        resource_name: `${input.targets?.length ?? 0} 个目标 topic`,
        details: JSON.stringify({
            source,
            targets: (input.targets ?? []).map(target => scopeOf(target)),
            fields: input.fields ?? [],
        }),
    };
}

export function registerTopicPolicyHandlers() {
    registerClientHandler('topic:policy:get', TopicPolicyGetSchema, passThrough, (client, input) =>
        client.getTopicPolicies(input.tenant!, input.namespace!, input.topic!, input.persistent ?? true),
    );

    // 写与清都是 topic 级覆盖的变更：清除不是「关掉这一项」，而是撤销覆盖、
    // 退回命名空间的值，那个值可能正好相反，所以两条通道都落审计。
    registerMutationHandler(
        'topic:policy:set',
        TopicPolicySetSchema,
        passThrough,
        topicAudit('update_topic_policy'),
        (client, input) =>
            client.setTopicPolicy(
                input.tenant!,
                input.namespace!,
                input.topic!,
                input.field!,
                input.value,
                input.persistent ?? true,
            ),
    );

    registerMutationHandler(
        'topic:policy:clear',
        TopicPolicyClearSchema,
        passThrough,
        topicAudit('clear_topic_policy'),
        (client, input) =>
            client.clearTopicPolicy(
                input.tenant!,
                input.namespace!,
                input.topic!,
                input.field!,
                input.persistent ?? true,
            ),
    );

    // 预览与执行是两条通道：预览只读，界面可以放心多点几次；
    // 执行自己重新读一遍两边的值再算差异，界面上那份预览只用于核对，不是执行依据——
    // 否则中间有人改了策略，执行就会按过期视图覆盖现值。
    registerClientHandler('topic:policy:sync:plan', TopicPolicySyncSchema, passThrough, (client, input) =>
        planTopicPolicySync(client, toSyncParams(input)),
    );

    registerMutationHandler('topic:policy:sync:apply', TopicPolicySyncSchema, passThrough, syncAudit, (client, input) =>
        applyTopicPolicySync(client, toSyncParams(input)),
    );
}
