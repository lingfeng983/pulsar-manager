import {
    z,
    BuiltinConfigSchema,
    FunctionStateGetSchema,
    FunctionStateSetSchema,
    FunctionTriggerSchema,
    RuntimeControlSchema,
    RuntimeCreateSchema,
    RuntimeItemPathSchema,
    RuntimeNamespaceSchema,
    WorkerClusterSchema,
    WorkerKindSchema,
    registerClientHandler,
    registerMutationHandler,
} from './_shared';

// 函数与连接器的通道全部走 admin REST：broker 的 Function Worker 没有原生客户端口，
// 原生 pulsar-client 只提供消息收发，管不了 worker 上跑的东西。

// 变更类通道的审计口径与 topic/tenant 那批一致：resource_id 用完整坐标，
// 事后翻日志能直接定位到「哪个集群的哪个命名空间下的哪个函数」。
function itemAudit(action: string) {
    return (input: z.infer<typeof RuntimeItemPathSchema>) => ({
        action,
        resource_type: input.kind === 'function' ? 'pulsar_function' : 'pulsar_connector',
        resource_id: `${input.tenant}/${input.namespace}/${input.name}`,
        resource_name: input.name,
    });
}

function passThrough([params]: unknown[]) {
    return params ?? {};
}

export function registerWorkerHandlers() {
    registerClientHandler(
        'worker:state',
        WorkerClusterSchema.extend({force: z.boolean().default(false)}),
        passThrough,
        (client, {force}) => client.getWorkerState(force),
    );

    registerClientHandler(
        'worker:items:list',
        RuntimeNamespaceSchema,
        passThrough,
        (client, {kind, tenant, namespace}) => client.listRuntimeItems(kind, tenant, namespace),
    );

    registerClientHandler(
        'worker:item:get',
        RuntimeItemPathSchema,
        passThrough,
        (client, {kind, tenant, namespace, name}) => client.getRuntimeItem(kind, tenant, namespace, name),
    );

    registerClientHandler('worker:builtin:list', WorkerKindSchema, passThrough, (client, {kind}) =>
        client.listBuiltinRuntime(kind),
    );

    registerClientHandler('worker:builtin:config', BuiltinConfigSchema, passThrough, (client, {kind, name}) =>
        client.getBuiltinRuntimeConfig(kind, name),
    );

    // 触发一次会往 input topic 投一条消息，属于变更；审计里把 topic 记进 details，
    // 因为「谁在什么时候拿这个函数试过一条什么数据」正是事后要查的那一行。
    registerMutationHandler(
        'worker:function:trigger',
        FunctionTriggerSchema,
        passThrough,
        input => ({
            ...itemAudit('trigger')(input),
            details: JSON.stringify({topic: input.topic, hasPayload: input.data !== undefined}),
        }),
        async (client, {tenant, namespace, name, topic, data}) => {
            const result = await client.triggerFunction(tenant, namespace, name, topic, data);
            return result;
        },
    );

    registerMutationHandler(
        'worker:item:create',
        RuntimeCreateSchema,
        passThrough,
        input => ({
            ...itemAudit('create')(input),
            details: JSON.stringify({class: input.className, archive: input.archive}),
        }),
        (client, input) =>
            client.createRuntimeItem({
                clusterId: input.clusterId,
                kind: input.kind,
                tenant: input.tenant,
                namespace: input.namespace,
                name: input.name,
                className: input.className,
                archive: input.archive,
                inputs: input.inputs,
                output: input.output,
                logTopic: input.logTopic,
                parallelism: input.parallelism,
                cpu: input.cpu,
                ramMb: input.ramMb,
                diskMb: input.diskMb,
                processingGuarantee: input.processingGuarantee,
                userConfig: input.userConfig,
            }),
    );

    registerMutationHandler(
        'worker:item:control',
        RuntimeControlSchema,
        passThrough,
        input => ({
            ...itemAudit(input.action)(input),
            details: input.instanceId === undefined ? undefined : JSON.stringify({instanceId: input.instanceId}),
        }),
        async (client, {kind, tenant, namespace, name, action, instanceId}) => {
            await client.controlRuntimeItem(kind, tenant, namespace, name, action, instanceId);
        },
    );

    registerMutationHandler(
        'worker:item:delete',
        RuntimeItemPathSchema,
        passThrough,
        input => itemAudit('delete')(input),
        async (client, {kind, tenant, namespace, name}) => {
            await client.deleteRuntimeItem(kind, tenant, namespace, name);
        },
    );

    registerMutationHandler(
        'worker:builtin:reload',
        WorkerKindSchema,
        passThrough,
        input => ({
            action: 'reload',
            resource_type: input.kind === 'function' ? 'pulsar_function' : 'pulsar_connector',
            resource_id: 'builtins',
            resource_name: '内置清单',
        }),
        async (client, {kind}) => {
            await client.reloadBuiltinRuntime(kind);
        },
    );

    registerClientHandler(
        'worker:function:state:get',
        FunctionStateGetSchema,
        passThrough,
        (client, {tenant, namespace, name, key}) => client.getFunctionState(tenant, namespace, name, key),
    );

    registerMutationHandler(
        'worker:function:state:set',
        FunctionStateSetSchema,
        passThrough,
        input => ({
            ...itemAudit('set_state')(input),
            details: JSON.stringify({key: input.key, length: input.value.length}),
        }),
        async (client, {tenant, namespace, name, key, value}) => {
            await client.setFunctionState(tenant, namespace, name, key, value);
        },
    );

    registerClientHandler('worker:assignments', WorkerClusterSchema, passThrough, client =>
        client.getWorkerAssignments(),
    );
}
