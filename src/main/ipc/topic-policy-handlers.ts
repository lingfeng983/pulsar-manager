import {
    MutationAudit,
    TopicPolicyClearSchema,
    TopicPolicyGetSchema,
    TopicPolicySetSchema,
    registerClientHandler,
    registerMutationHandler,
} from './_shared';
import type {TopicPolicyField} from '../../shared/types';

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
}
