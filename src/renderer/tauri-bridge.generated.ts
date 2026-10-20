// 由 scripts/gen-tauri-bridge.mjs 生成，请勿手改。
// 唯一真源：src/preload.ts —— 改完 preload 后重新运行 `node scripts/gen-tauri-bridge.mjs`。
import type {
    ClusterConfigDraft,
    AppSettings,
    ConsumerConfigCopyParams,
    ConsumerConfigUpsertParams,
    ConfigBundle,
    ConsumeStartParams,
    ConsumerAckParams,
    LoadTestParams,
    LoadTestProgress,
    MessageBatch,
    MessageSendParams,
    MessageTemplateUpsertParams,
    NamespacePolicyClearParams,
    NamespacePolicyScopeParams,
    NamespacePolicySetParams,
    NamespacePolicySyncParams,
    PeekParams,
    ProducerFlowParams,
    ProducerRunStats,
    ProducerSendOnceParams,
    ProducerSendParams,
    ProducerSetRateParams,
    ProducerStartParams,
    ReadStartParams,
    SendHistoryListParams,
    SessionEndEvent,
    SSHConfig,
    K8sForwardConfig,
    SubscriptionPathParams,
    WorkbenchCopyParams,
    WorkbenchScopeParams,
    TopicConfigPatch,
    TopicPolicyClearParams,
    TopicPolicyScopeParams,
    TopicPolicySetParams,
    TopicPolicySyncParams,
    BrokerSchemaType,
    SchemaCompatibilityPolicy,
    PulsarAuthAction,
    MetricsSnapshotInput,
    MetricsSnapshotQuery,
    AlertPush,
    AlertEventQuery,
    AlertRuleUpsertParams,
    PulsarResourceKind,
    PulsarRuntimeCreateParams,
    InspectionRunParams,
    InspectionProfileDraft,
    InspectionScheduleDraft,
    InspectionScheduledPush,
    InspectionFleetRunParams,
    InspectionFleetProgress,
    NotifyChannelDraft,
    MailProfileDraft,
    TopologyLimits,
} from '../shared/types';

// sandbox 的 preload 只能 require 白名单模块（electron 等），相对路径的运行时 import
// 会让 Electron 静默跳过整个 preload——桥接对象凭空消失且不打日志，极难定位。
// 通道名因此只能在本地写死，并用 shared/types 的字面量类型钉住：那边改名这边就编译失败。
type StreamChannel = typeof import('../shared/types').MESSAGE_STREAM_CHANNELS;
const CONSUME_BATCH_CHANNEL: StreamChannel['consumeBatch'] = 'msg:consume-batch';
const READ_BATCH_CHANNEL: StreamChannel['readBatch'] = 'msg:read-batch';
const SESSION_END_CHANNEL: StreamChannel['sessionEnd'] = 'msg:session-end';
const PRODUCER_STATS_CHANNEL: StreamChannel['producerStats'] = 'msg:producer-stats';
const LOAD_TEST_PROGRESS_CHANNEL: typeof import('../shared/types').LOAD_TEST_CHANNEL = 'benchmark:progress';
const ALERT_EVENT_CHANNEL: typeof import('../shared/types').ALERT_EVENT_CHANNEL = 'alert:event';
const INSPECTION_SCHEDULE_CHANNEL: typeof import('../shared/types').INSPECTION_SCHEDULE_CHANNEL =
    'inspection:scheduled';
const INSPECTION_FLEET_CHANNEL: typeof import('../shared/types').INSPECTION_FLEET_CHANNEL = 'inspection:fleet-progress';

// 主进程 → 渲染进程的下行订阅。返回反订阅闭包：组件卸载时必须能摘掉监听，
// 否则切了标签页还在往旧组件推数据。载荷只允许纯 JSON（sandbox 下传不了类实例）。

// 暴露安全的 API 给渲染进程

export interface BridgeTransport {
    /** 与 ipcRenderer.invoke 同形：通道名 + 位置参数，返回已解包的 payload。 */
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    /** 部分订阅是手写的 on/removeListener 配对，签名保留 Electron 的 (event, payload)。 */
    on: (channel: string, listener: (...args: any[]) => void) => void;
    off: (channel: string, listener: (...args: any[]) => void) => void;
    /** 主进程 → 渲染进程下行订阅，返回反订阅闭包。 */
    subscribe: <T>(channel: string, callback: (payload: T) => void) => () => void;
}

export function createBridge(transport: BridgeTransport) {
    const subscribe = <T>(channel: string, callback: (payload: T) => void): (() => void) =>
        transport.subscribe<T>(channel, callback);

    return {
        // 集群管理
        cluster: {
            list: () => transport.invoke('cluster:list'),
            checkStatus: () => transport.invoke('cluster:checkStatus'),
            add: (config: ClusterConfigDraft) => transport.invoke('cluster:add', config),
            update: (id: string, config: ClusterConfigDraft) => transport.invoke('cluster:update', id, config),
            delete: (id: string) => transport.invoke('cluster:delete', id),
            testConnection: (config: ClusterConfigDraft) => transport.invoke('cluster:testConnection', config),
        },

        // 资源管理
        resources: {
            getTenants: (clusterId: string) => transport.invoke('resources:getTenants', clusterId),
            getNamespaces: (clusterId: string, tenant: string) =>
                transport.invoke('resources:getNamespaces', clusterId, tenant),
            getTopics: (clusterId: string, tenant: string, namespace: string) =>
                transport.invoke('resources:getTopics', clusterId, tenant, namespace),
            getTopicStats: (
                clusterId: string,
                tenant: string,
                namespace: string,
                topic: string,
                persistent?: boolean,
            ) => transport.invoke('resources:getTopicStats', clusterId, tenant, namespace, topic, persistent),
            getTopicConfig: (
                clusterId: string,
                tenant: string,
                namespace: string,
                topic: string,
                persistent?: boolean,
            ) => transport.invoke('resources:getTopicConfig', clusterId, tenant, namespace, topic, persistent),
            updateTopicConfig: (
                clusterId: string,
                tenant: string,
                namespace: string,
                topic: string,
                config: TopicConfigPatch,
                persistent?: boolean,
            ) =>
                transport.invoke(
                    'resources:updateTopicConfig',
                    clusterId,
                    tenant,
                    namespace,
                    topic,
                    config,
                    persistent,
                ),
            getSubscriptions: (
                clusterId: string,
                tenant: string,
                namespace: string,
                topic: string,
                persistent?: boolean,
            ) => transport.invoke('resources:getSubscriptions', clusterId, tenant, namespace, topic, persistent),
            getTenantInfo: (clusterId: string, tenant: string) =>
                transport.invoke('resources:getTenantInfo', clusterId, tenant),
            createSubscription: (
                clusterId: string,
                tenant: string,
                namespace: string,
                topic: string,
                name: string,
                initialPosition?: 'Latest' | 'Earliest',
                persistent?: boolean,
            ) =>
                transport.invoke(
                    'resources:createSubscription',
                    clusterId,
                    tenant,
                    namespace,
                    topic,
                    name,
                    initialPosition,
                    persistent,
                ),
            deleteSubscription: (
                clusterId: string,
                tenant: string,
                namespace: string,
                topic: string,
                name: string,
                persistent?: boolean,
            ) =>
                transport.invoke('resources:deleteSubscription', clusterId, tenant, namespace, topic, name, persistent),
            resetCursor: (
                clusterId: string,
                tenant: string,
                namespace: string,
                topic: string,
                subscription: string,
                position: 'earliest' | 'latest' | 'timestamp',
                timestamp?: number,
                persistent?: boolean,
            ) =>
                transport.invoke(
                    'resources:resetCursor',
                    clusterId,
                    tenant,
                    namespace,
                    topic,
                    subscription,
                    position,
                    timestamp,
                    persistent,
                ),
            skipMessages: (
                clusterId: string,
                tenant: string,
                namespace: string,
                topic: string,
                subscription: string,
                count: number,
                persistent?: boolean,
            ) =>
                transport.invoke(
                    'resources:skipMessages',
                    clusterId,
                    tenant,
                    namespace,
                    topic,
                    subscription,
                    count,
                    persistent,
                ),
            deleteTopic: (clusterId: string, tenant: string, namespace: string, topic: string, persistent?: boolean) =>
                transport.invoke('resources:deleteTopic', clusterId, tenant, namespace, topic, persistent),

            getSchema: (clusterId: string, tenant: string, namespace: string, topic: string, persistent?: boolean) =>
                transport.invoke('resources:getSchema', clusterId, tenant, namespace, topic, persistent),
            getSchemaStrategy: (
                clusterId: string,
                tenant: string,
                namespace: string,
                topic: string,
                persistent?: boolean,
            ) => transport.invoke('resources:getSchemaStrategy', clusterId, tenant, namespace, topic, persistent),
            setSchemaStrategy: (
                clusterId: string,
                tenant: string,
                namespace: string,
                topic: string,
                strategy: SchemaCompatibilityPolicy,
                persistent?: boolean,
            ) =>
                transport.invoke(
                    'resources:setSchemaStrategy',
                    clusterId,
                    tenant,
                    namespace,
                    topic,
                    strategy,
                    persistent,
                ),
            createSchemaVersion: (
                clusterId: string,
                tenant: string,
                namespace: string,
                topic: string,
                type: BrokerSchemaType,
                definition: string,
                persistent?: boolean,
            ) =>
                transport.invoke(
                    'resources:createSchemaVersion',
                    clusterId,
                    tenant,
                    namespace,
                    topic,
                    type,
                    definition,
                    persistent,
                ),
            deleteSchema: (clusterId: string, tenant: string, namespace: string, topic: string, persistent?: boolean) =>
                transport.invoke('resources:deleteSchema', clusterId, tenant, namespace, topic, persistent),

            getNamespacePermissions: (clusterId: string, tenant: string, namespace: string) =>
                transport.invoke('resources:getNamespacePermissions', clusterId, tenant, namespace),
            grantNamespacePermission: (
                clusterId: string,
                tenant: string,
                namespace: string,
                role: string,
                actions: PulsarAuthAction[],
            ) => transport.invoke('resources:grantNamespacePermission', clusterId, tenant, namespace, role, actions),
            revokeNamespacePermission: (clusterId: string, tenant: string, namespace: string, role: string) =>
                transport.invoke('resources:revokeNamespacePermission', clusterId, tenant, namespace, role),
            getTopicPermissions: (
                clusterId: string,
                tenant: string,
                namespace: string,
                topic: string,
                persistent?: boolean,
            ) => transport.invoke('resources:getTopicPermissions', clusterId, tenant, namespace, topic, persistent),
            grantTopicPermission: (
                clusterId: string,
                tenant: string,
                namespace: string,
                topic: string,
                role: string,
                actions: PulsarAuthAction[],
                persistent?: boolean,
            ) =>
                transport.invoke(
                    'resources:grantTopicPermission',
                    clusterId,
                    tenant,
                    namespace,
                    topic,
                    role,
                    actions,
                    persistent,
                ),
            revokeTopicPermission: (
                clusterId: string,
                tenant: string,
                namespace: string,
                topic: string,
                role: string,
                persistent?: boolean,
            ) =>
                transport.invoke(
                    'resources:revokeTopicPermission',
                    clusterId,
                    tenant,
                    namespace,
                    topic,
                    role,
                    persistent,
                ),

            // Pulsar 侧集群名称列表，创建租户时 allowedClusters 用这里的值
            getPulsarClusters: (clusterId: string) => transport.invoke('resources:getPulsarClusters', clusterId),
            createTenant: (clusterId: string, name: string, adminRoles: string[], allowedClusters: string[]) =>
                transport.invoke('resources:createTenant', clusterId, name, adminRoles, allowedClusters),
            updateTenant: (clusterId: string, tenant: string, adminRoles: string[], allowedClusters: string[]) =>
                transport.invoke('resources:updateTenant', clusterId, tenant, adminRoles, allowedClusters),
            deleteTenant: (clusterId: string, tenant: string) =>
                transport.invoke('resources:deleteTenant', clusterId, tenant),
            createNamespace: (clusterId: string, tenant: string, name: string) =>
                transport.invoke('resources:createNamespace', clusterId, tenant, name),
            deleteNamespace: (clusterId: string, tenant: string, namespace: string) =>
                transport.invoke('resources:deleteNamespace', clusterId, tenant, namespace),
            createTopic: (
                clusterId: string,
                tenant: string,
                namespace: string,
                name: string,
                persistent?: boolean,
                partitions?: number,
            ) => transport.invoke('resources:createTopic', clusterId, tenant, namespace, name, persistent, partitions),
        },

        // 消息操作：收发走原生客户端（admin REST 上没有 send/peek 路由）
        messages: {
            send: (params: MessageSendParams) => transport.invoke('messages:send', params),
            startConsume: (params: ConsumeStartParams) => transport.invoke('messages:startConsume', params),
            stopConsume: (sessionId: string) => transport.invoke('messages:stopConsume', {sessionId}),
            startRead: (params: ReadStartParams) => transport.invoke('messages:startRead', params),
            stopRead: (sessionId: string) => transport.invoke('messages:stopRead', {sessionId}),
            getBacklog: (params: SubscriptionPathParams) => transport.invoke('messages:getBacklog', params),
            peek: (params: PeekParams) => transport.invoke('messages:peek', params),
            onConsumeBatch: (callback: (batch: MessageBatch) => void) => subscribe(CONSUME_BATCH_CHANNEL, callback),
            onReadBatch: (callback: (batch: MessageBatch) => void) => subscribe(READ_BATCH_CHANNEL, callback),
            onSessionEnd: (callback: (event: SessionEndEvent) => void) => subscribe(SESSION_END_CHANNEL, callback),
        },

        // 生产者工作台。会话结束事件与消费共用 msg:session-end——"会话没了"在两边
        // 是同一件事，渲染端不该分两个监听再去猜哪个先响。
        producer: {
            startSession: (params: ProducerStartParams) => transport.invoke('producer:startSession', params),
            send: (params: ProducerSendParams) => transport.invoke('producer:send', params),
            sendOnce: (params: ProducerSendOnceParams) => transport.invoke('producer:sendOnce', params),
            flush: (sessionId: string) => transport.invoke('producer:flush', {sessionId}),
            startFlow: (params: ProducerFlowParams) => transport.invoke('producer:startFlow', params),
            stopFlow: (sessionId: string) => transport.invoke('producer:stopFlow', {sessionId}),
            setRate: (params: ProducerSetRateParams) => transport.invoke('producer:setRate', params),
            onStats: (callback: (stats: ProducerRunStats) => void) => subscribe(PRODUCER_STATS_CHANNEL, callback),
            stop: (sessionId: string) => transport.invoke('producer:stop', {sessionId}),
            listSessions: (clusterId?: string) => transport.invoke('producer:listSessions', {clusterId}),
        },

        // 消费者工作台。批次里不新增推送通道：消息批次与三态面板同一条
        // msg:consume-batch，界面按 sessionId 认领，多开几条会话也各收各的。
        consumer: {
            start: (params: ConsumeStartParams) => transport.invoke('consumer:start', params),
            stop: (sessionId: string) => transport.invoke('consumer:stop', {sessionId}),
            listSessions: (clusterId?: string) => transport.invoke('consumer:list', {clusterId}),
            // 手动确认：按主进程登记表的序号确认/重投，回落定后的会话快照（含 pendingAcks）
            ack: (params: ConsumerAckParams) => transport.invoke('consumer:ack', params),
            nack: (params: ConsumerAckParams) => transport.invoke('consumer:nack', params),
        },

        // 报文模板库（生产者工作台）：纯本地 SQLite，集群离线也能翻出上次写好的报文
        template: {
            list: (params: WorkbenchScopeParams) => transport.invoke('template:list', params),
            create: (params: MessageTemplateUpsertParams) => transport.invoke('template:create', params),
            update: (params: MessageTemplateUpsertParams) => transport.invoke('template:update', params),
            delete: (id: string) => transport.invoke('template:delete', {id}),
            copy: (params: WorkbenchCopyParams) => transport.invoke('template:copy', params),
        },

        // 消费者会话配置：同样只在本地库里
        consumerConfig: {
            list: (params: WorkbenchScopeParams) => transport.invoke('consumerConfig:list', params),
            create: (params: ConsumerConfigUpsertParams) => transport.invoke('consumerConfig:create', params),
            update: (params: ConsumerConfigUpsertParams) => transport.invoke('consumerConfig:update', params),
            delete: (id: string) => transport.invoke('consumerConfig:delete', {id}),
            copy: (params: ConsumerConfigCopyParams) => transport.invoke('consumerConfig:copy', params),
        },

        // 发送历史只读；写入在 producer 的发送路径里，界面不能自己编一条成功记录
        sendHistory: {
            list: (params: SendHistoryListParams) => transport.invoke('sendHistory:list', params),
            // 列表不带全文，重发时按行 id 单取
            get: (id: number) => transport.invoke('sendHistory:get', {id}),
        },

        // 快速压测：start 拿到 runId 就返回，进度经 benchmark:progress 单向推送
        benchmark: {
            start: (params: LoadTestParams) => transport.invoke('benchmark:start', params),
            stop: (runId: string) => transport.invoke('benchmark:stop', {runId}),
            onProgress: (callback: (progress: LoadTestProgress) => void) =>
                subscribe(LOAD_TEST_PROGRESS_CHANNEL, callback),
        },

        // 监控
        metrics: {
            getAggregatedStats: (clusterId: string) => transport.invoke('metrics:getAggregatedStats', clusterId),
            getBrokers: (clusterId: string) => transport.invoke('metrics:getBrokers', clusterId),
            recordSnapshot: (snapshot: MetricsSnapshotInput) => transport.invoke('metrics:recordSnapshot', snapshot),
            listSnapshots: (query: MetricsSnapshotQuery) => transport.invoke('metrics:listSnapshots', query),
        },

        // 告警：规则与事件都是本地数据，评估由主进程定时器驱动
        alert: {
            // 不选集群 = 全部；undefined 进 IPC 载荷会被结构化克隆丢掉字段，这里统一成空串
            listRules: (clusterId?: string) => transport.invoke('alert:rules:list', {clusterId: clusterId || ''}),
            upsertRule: (params: AlertRuleUpsertParams) => transport.invoke('alert:rule:upsert', params),
            deleteRule: (id: string) => transport.invoke('alert:rule:delete', {id}),
            testRule: (id: string) => transport.invoke('alert:rule:test', {id}),
            listEvents: (query: AlertEventQuery) => transport.invoke('alert:events:list', query),
            ackEvents: (ids: number[]) => transport.invoke('alert:events:ack', {ids}),
            deleteEvents: (ids: number[]) => transport.invoke('alert:events:delete', {ids}),
            countOpen: () => transport.invoke('alert:rules:count'),
            // 引擎的立案/恢复是单向推送，返回反订阅闭包
            onEvent: (callback: (push: AlertPush) => void) => subscribe(ALERT_EVENT_CHANNEL, callback),
        },

        // 函数与连接器：全部经 admin REST，主进程已经判断过 worker 是否启用，
        // 未启用时返回的是那句翻译过的说明而不是裸 404。
        worker: {
            getState: (clusterId: string, force?: boolean) => transport.invoke('worker:state', {clusterId, force}),
            listItems: (params: {clusterId: string; kind: PulsarResourceKind; tenant: string; namespace: string}) =>
                transport.invoke('worker:items:list', params),
            getItem: (params: {
                clusterId: string;
                kind: PulsarResourceKind;
                tenant: string;
                namespace: string;
                name: string;
            }) => transport.invoke('worker:item:get', params),
            createItem: (params: PulsarRuntimeCreateParams) => transport.invoke('worker:item:create', params),
            controlItem: (params: {
                clusterId: string;
                kind: PulsarResourceKind;
                tenant: string;
                namespace: string;
                name: string;
                action: 'start' | 'stop' | 'restart';
                instanceId?: number;
            }) => transport.invoke('worker:item:control', params),
            deleteItem: (params: {
                clusterId: string;
                kind: PulsarResourceKind;
                tenant: string;
                namespace: string;
                name: string;
            }) => transport.invoke('worker:item:delete', params),
            trigger: (params: {
                clusterId: string;
                tenant: string;
                namespace: string;
                name: string;
                topic: string;
                data?: string;
            }) => transport.invoke('worker:function:trigger', {kind: 'function', ...params}),
            listBuiltins: (clusterId: string, kind: PulsarResourceKind) =>
                transport.invoke('worker:builtin:list', {clusterId, kind}),
            reloadBuiltins: (clusterId: string, kind: PulsarResourceKind) =>
                transport.invoke('worker:builtin:reload', {clusterId, kind}),
        },

        // 命名空间策略：读一次拿折叠好的视图，写按字段端点逐个走
        namespacePolicy: {
            get: (params: NamespacePolicyScopeParams) => transport.invoke('namespace:policies:get', params),
            set: (params: NamespacePolicySetParams) => transport.invoke('namespace:policy:set', params),
            clear: (params: NamespacePolicyClearParams) => transport.invoke('namespace:policy:clear', params),
            syncPlan: (params: NamespacePolicySyncParams) => transport.invoke('namespace:policies:sync:plan', params),
            syncApply: (params: NamespacePolicySyncParams) => transport.invoke('namespace:policies:sync:apply', params),
        },

        // Topic 级策略（broker 的 TopicPolicies：一字段一端点）
        topicPolicy: {
            get: (params: TopicPolicyScopeParams) => transport.invoke('topic:policy:get', params),
            set: (params: TopicPolicySetParams) => transport.invoke('topic:policy:set', params),
            clear: (params: TopicPolicyClearParams) => transport.invoke('topic:policy:clear', params),
            syncPlan: (params: TopicPolicySyncParams) => transport.invoke('topic:policy:sync:plan', params),
            syncApply: (params: TopicPolicySyncParams) => transport.invoke('topic:policy:sync:apply', params),
        },

        // 集群巡检：一次只读采集换一份能导出发人的报告
        inspection: {
            run: (params: InspectionRunParams) => transport.invoke('inspection:run', params),
            history: (params: {clusterId: string; limit?: number}) => transport.invoke('inspection:history', params),
            detail: (params: {id: string}) => transport.invoke('inspection:detail', params),
            clear: (params: {clusterId: string}) => transport.invoke('inspection:clear', params),
            profile: {
                get: (params: {clusterId: string}) => transport.invoke('inspection:profile:get', params),
                save: (params: InspectionProfileDraft) => transport.invoke('inspection:profile:save', params),
            },
            schedule: {
                get: (params: {clusterId: string}) => transport.invoke('inspection:schedule:get', params),
                save: (params: InspectionScheduleDraft) => transport.invoke('inspection:schedule:save', params),
            },
            // 定时那一轮跑完（或跑坏）之后推来的那一条：巡检页靠它把历史刷回来，
            // 否则用户只能自己猜应用什么时候动过手
            onScheduled: (callback: (push: InspectionScheduledPush) => void) =>
                subscribe(INSPECTION_SCHEDULE_CHANNEL, callback),
            // 跨集群汇总：读的是每台最近一份落库的报告，跑的是逐台串行
            summary: {
                get: () => transport.invoke('inspection:summary'),
                run: (params: InspectionFleetRunParams) => transport.invoke('inspection:summary:run', params),
            },
            onFleetProgress: (callback: (progress: InspectionFleetProgress) => void) =>
                subscribe(INSPECTION_FLEET_CHANNEL, callback),
        },

        // 外部通知渠道：告警与巡检的结论要能离开这台机器，所以这里只管配置与查投递结果，
        // 发是主进程在事件落库之后自己顺手发的
        notify: {
            channel: {
                list: () => transport.invoke('notify:channel:list'),
                save: (draft: NotifyChannelDraft) => transport.invoke('notify:channel:save', draft),
                delete: (params: {id: string}) => transport.invoke('notify:channel:delete', params),
                enable: (params: {id: string; enabled: boolean}) => transport.invoke('notify:channel:enable', params),
                test: (params: {id: string}) => transport.invoke('notify:channel:test', params),
            },
            delivery: {
                list: (params?: {limit?: number}) => transport.invoke('notify:delivery:list', params ?? {}),
            },
            // 邮件服务器（SMTP）：一台服务器可以多条邮件渠道共用，所以它与渠道分开管
            mail: {
                list: () => transport.invoke('notify:mail:list'),
                save: (draft: MailProfileDraft) => transport.invoke('notify:mail:save', draft),
                delete: (params: {id: string}) => transport.invoke('notify:mail:delete', params),
                test: (params: {id: string; to?: string}) => transport.invoke('notify:mail:test', params),
            },
        },

        // 拓扑
        topology: {
            getClusterTopology: (clusterId: string, limits?: TopologyLimits) =>
                transport.invoke('topology:getClusterTopology', clusterId, limits),
        },

        // SSH 隧道
        ssh: {
            connect: (config: SSHConfig) => transport.invoke('ssh:connect', config),
            disconnect: (tunnelId: string) => transport.invoke('ssh:disconnect', tunnelId),
        },

        // K8s 端口转发
        k8s: {
            connect: (config: K8sForwardConfig) => transport.invoke('k8s:connect', config),
            disconnect: (forwardId: string) => transport.invoke('k8s:disconnect', forwardId),
        },

        // 主题
        theme: {
            set: (theme: string) => transport.invoke('theme:set', theme),
            get: () => transport.invoke('theme:get'),
        },

        // 设置
        settings: {
            get: (key: string) => transport.invoke('settings:get', key),
            set: (key: string, value: string) => transport.invoke('settings:set', key, value),
        },

        // 配置中心：可持久化应用设置的读写，加上导出一整套 / 导入一整套
        config: {
            getAll: () => transport.invoke('config:getAll'),
            update: (patch: Partial<AppSettings>) => transport.invoke('config:update', patch),
            reset: () => transport.invoke('config:reset'),
            meta: () => transport.invoke('config:meta'),
            export: () => transport.invoke('config:export'),
            import: (bundle: ConfigBundle) => transport.invoke('config:import', bundle),
            clearLogs: () => transport.invoke('config:clearLogs'),
        },

        // 操作日志
        logs: {
            getRecent: (limit?: number) => transport.invoke('logs:getRecent', limit),
        },

        // 本地文件选择（函数 / 连接器的包）：只回路径与元信息，内容不进渲染进程
        file: {
            pickArchive: () => transport.invoke('file:pickArchive'),
        },

        // 插件市场：本地声明式插件，只贡献压测预设与 Topic 模板
        plugin: {
            list: () => transport.invoke('plugin:list'),
            installOfficial: (id: string) => transport.invoke('plugin:installOfficial', {id}),
            import: (text: string) => transport.invoke('plugin:import', {text}),
            uninstall: (id: string) => transport.invoke('plugin:uninstall', {id}),
            setEnabled: (id: string, enabled: boolean) => transport.invoke('plugin:setEnabled', {id, enabled}),
            revealDir: () => transport.invoke('plugin:revealDir'),
        },

        // 在线更新
        update: {
            // 走主进程取 app.getVersion()：这里以前返回 process.versions.app，那是 Electron
            // 运行时版本，跟 package.json 的版本号没有任何关系
            getVersion: () => transport.invoke('update:getVersion'),
            check: () => transport.invoke('update:check'),
            download: (url: string) => transport.invoke('update:download', url),
            install: () => transport.invoke('update:install'),
            onProgress: (
                callback: (progress: {received: number; total: number; done?: boolean; error?: string}) => void,
            ) => {
                const listener = (_event: unknown, progress: unknown) =>
                    callback(progress as {received: number; total: number; done?: boolean; error?: string});
                transport.on('update:progress', listener);
                return () => transport.off('update:progress', listener);
            },
        },
    };
}
