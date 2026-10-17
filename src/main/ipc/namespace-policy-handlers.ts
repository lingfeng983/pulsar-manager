import {
    MutationAudit,
    NamespacePolicyClearSchema,
    NamespacePolicyGetSchema,
    NamespacePolicySetSchema,
    NamespacePolicySyncSchema,
    registerClientHandler,
    registerMutationHandler,
} from './_shared';
import {applyNamespacePolicySync, planNamespacePolicySync} from '../services/namespace-policy-sync';
import type {NamespacePolicyField, NamespacePolicySyncParams} from '../../shared/types';

// 命名空间策略是纯 broker 状态：读一份 Policies、按字段端点逐个写，
// 不需要 SQLite 留存——规则存在 broker 那边才改得动，也才跟着集群走。

// strict:false 之下 z.infer 出来的属性全是可选，两个 schema 的 audit 又几乎同形，
// 所以共用一份宽松的入参类型，而不是写两份带 z.infer 标注的回调。
interface PolicyAuditInput {
    tenant?: string;
    namespace?: string;
    field?: string;
    value?: unknown;
    quotaType?: string;
}

function scopeAudit(action: string) {
    return (input: PolicyAuditInput): MutationAudit => ({
        action,
        resource_type: 'pulsar_namespace',
        resource_id: `${input.tenant}/${input.namespace}`,
        resource_name: input.field || 'unknown',
        // 值原样进 details：策略改动事后要查的就是「改成了什么」，
        // 只记字段名等于没记。载荷本身由字段表限了取值，不会写进整段文档。
        details: JSON.stringify({field: input.field, value: input.value ?? input.quotaType ?? null}),
    });
}

function passThrough([params]: unknown[]) {
    return params ?? {};
}

// 批量同步的入参形状：字段全部写成可选，理由与 PolicyAuditInput 相同
// （strict:false 之下 z.infer 的属性看着就是可选，两处各写一遍迟早漂移）。
interface SyncInput {
    clusterId?: string;
    source?: {tenant?: string; namespace?: string};
    targets?: {tenant?: string; namespace?: string}[];
    fields?: NamespacePolicyField[];
}

// 把那份「全是可选」的解析结果换成服务层要的必填形状。这些键在 schema 那一层
// 已经保证存在，所以这里用非空断言收口，而不是给编排层加一条「参数缺失」的分支。
function toSyncParams(input: SyncInput): NamespacePolicySyncParams {
    return {
        clusterId: input.clusterId!,
        source: {tenant: input.source!.tenant!, namespace: input.source!.namespace!},
        targets: (input.targets ?? []).map(target => ({
            tenant: target.tenant!,
            namespace: target.namespace!,
        })),
        fields: input.fields ?? [],
    };
}

// 一次同步改的是十几个命名空间 × 若干字段，逐条落日志会把「谁改了什么」淹在行数里；
// 这里记一整笔：源、目标清单、字段清单。改坏了要回滚，按这笔的 fields + targets 反着来即可。
function syncAudit(input: SyncInput): MutationAudit {
    const source = scopeOf(input);
    return {
        action: 'sync_namespace_policies',
        resource_type: 'pulsar_namespace',
        resource_id: source,
        resource_name: `${input.targets?.length ?? 0} 个目标命名空间`,
        details: JSON.stringify({
            source,
            targets: (input.targets ?? []).map(target => `${target.tenant}/${target.namespace}`),
            fields: input.fields ?? [],
        }),
    };
}

function scopeOf(input: SyncInput): string {
    return `${input.source?.tenant}/${input.source?.namespace}`;
}

export function registerNamespacePolicyHandlers() {
    registerClientHandler(
        'namespace:policies:get',
        NamespacePolicyGetSchema,
        passThrough,
        (client, {tenant, namespace}) => client.getPolicies(tenant, namespace),
    );

    registerMutationHandler(
        'namespace:policy:set',
        NamespacePolicySetSchema,
        passThrough,
        scopeAudit('update_namespace_policy'),
        (client, {tenant, namespace, field, value}) => client.setNamespacePolicy(tenant, namespace, field, value),
    );

    registerMutationHandler(
        'namespace:policy:clear',
        NamespacePolicyClearSchema,
        passThrough,
        scopeAudit('clear_namespace_policy'),
        (client, {tenant, namespace, field, quotaType}) =>
            client.clearNamespacePolicy(tenant, namespace, field, quotaType),
    );

    // 预览与执行是两条通道：预览只读，界面可以放心多点几次；
    // 执行自己重新读一遍再算差异，界面上那份预览只是给用户看"我打算这么做"，
    // 不是执行依据——否则中间有人改了策略，执行就会按过期视图覆盖现值。
    // 逐键重建参数而不是把 input 整个传下去：strict:false 之下 z.infer 出来的属性
    // 全是可选，直接传要改服务层签名，或让编排层去处理「参数没了」这种不存在的情况。
    registerClientHandler('namespace:policies:sync:plan', NamespacePolicySyncSchema, passThrough, (client, input) =>
        planNamespacePolicySync(client, toSyncParams(input)),
    );

    registerMutationHandler(
        'namespace:policies:sync:apply',
        NamespacePolicySyncSchema,
        passThrough,
        syncAudit,
        (client, input) => applyNamespacePolicySync(client, toSyncParams(input)),
    );
}
