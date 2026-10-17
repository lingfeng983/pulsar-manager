import {
    MutationAudit,
    NamespacePolicyClearSchema,
    NamespacePolicyGetSchema,
    NamespacePolicySetSchema,
    registerClientHandler,
    registerMutationHandler,
} from './_shared';

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
}
