import {contextBridge, ipcRenderer} from 'electron';
import type {IpcRendererEvent} from 'electron';
import type {
    APIResponse,
    AggregatedStats,
    BacklogInfo,
    BrokerInfo,
    ClusterConfig,
    ClusterConfigDraft,
    ClusterTopology,
    AppSettings,
    ConsumerConfigCopyParams,
    ConsumerConfigUpsertParams,
    ConsumerSessionConfig,
    ConfigBundle,
    ConfigImportResult,
    ConfigMeta,
    ConsumeStartParams,
    ConsumerAckParams,
    ConsumerSessionInfo,
    LoadTestParams,
    LoadTestProgress,
    MessageBatch,
    MessageSendParams,
    MessageTemplate,
    MessageTemplateUpsertParams,
    NamespacePolicyClearParams,
    NamespacePolicyScopeParams,
    NamespacePolicySetParams,
    NamespacePolicySyncApplyResult,
    NamespacePolicySyncParams,
    NamespacePolicySyncPlanResult,
    NamespacePolicyView,
    OperationLog,
    PeekParams,
    PluginEntry,
    PluginListResult,
    ProducerFlowParams,
    ProducerRunStats,
    ProducerSendOnceParams,
    ProducerSendParams,
    PeekResult,
    ProducerSendResult,
    ProducerSessionInfo,
    ProducerSetRateParams,
    ProducerStartParams,
    ReadStartParams,
    SendHistoryEntry,
    SendHistoryListParams,
    SessionEndEvent,
    SSHConfig,
    K8sForwardConfig,
    SubscriptionPathParams,
    WorkbenchCopyParams,
    WorkbenchScopeParams,
    Tenant,
    Topic,
    TopicConfig,
    TopicConfigPatch,
    TopicPolicyClearParams,
    TopicPolicyScopeParams,
    TopicPolicySetParams,
    TopicPolicySyncApplyResult,
    TopicPolicySyncParams,
    TopicPolicySyncPlanResult,
    TopicPolicyView,
    TopicStats,
    BrokerSchemaInfo,
    BrokerSchemaType,
    SchemaCompatibilityPolicy,
    PulsarAuthAction,
    PermissionMap,
    MetricsSnapshot,
    MetricsSnapshotInput,
    MetricsSnapshotQuery,
    AlertPush,
    AlertEvent,
    AlertEventQuery,
    AlertRule,
    AlertRuleUpsertParams,
    AlertProbeResult,
    PulsarBuiltinDefinition,
    PulsarResourceKind,
    PulsarRuntimeCreateParams,
    PulsarRuntimeItem,
    PulsarTriggerResult,
    PulsarWorkerState,
    PickedArchiveFile,
    InspectionRunParams,
    InspectionHistoryRow,
    InspectionProfile,
    InspectionProfileDraft,
    InspectionRunResult,
    InspectionSchedule,
    InspectionScheduleDraft,
    InspectionScheduledPush,
    InspectionFleetRunParams,
    InspectionFleetSummary,
    InspectionFleetRunResult,
    InspectionFleetProgress,
    NotifyChannel,
    NotifyChannelDraft,
    NotifyDelivery,
    MailProfile,
    MailProfileDraft,
    NotifyDispatchResult,
    TopologyLimits,
} from './shared/types';

// sandbox 的 preload 只能 require 白名单模块（electron 等），相对路径的运行时 import
// 会让 Electron 静默跳过整个 preload——桥接对象凭空消失且不打日志，极难定位。
// 通道名因此只能在本地写死，并用 shared/types 的字面量类型钉住：那边改名这边就编译失败。
type StreamChannel = typeof import('./shared/types').MESSAGE_STREAM_CHANNELS;
const CONSUME_BATCH_CHANNEL: StreamChannel['consumeBatch'] = 'msg:consume-batch';
const READ_BATCH_CHANNEL: StreamChannel['readBatch'] = 'msg:read-batch';
const SESSION_END_CHANNEL: StreamChannel['sessionEnd'] = 'msg:session-end';
const PRODUCER_STATS_CHANNEL: StreamChannel['producerStats'] = 'msg:producer-stats';
const LOAD_TEST_PROGRESS_CHANNEL: typeof import('./shared/types').LOAD_TEST_CHANNEL = 'benchmark:progress';
const ALERT_EVENT_CHANNEL: typeof import('./shared/types').ALERT_EVENT_CHANNEL = 'alert:event';
const INSPECTION_SCHEDULE_CHANNEL: typeof import('./shared/types').INSPECTION_SCHEDULE_CHANNEL = 'inspection:scheduled';
const INSPECTION_FLEET_CHANNEL: typeof import('./shared/types').INSPECTION_FLEET_CHANNEL = 'inspection:fleet-progress';

// 主进程 → 渲染进程的下行订阅。返回反订阅闭包：组件卸载时必须能摘掉监听，
// 否则切了标签页还在往旧组件推数据。载荷只允许纯 JSON（sandbox 下传不了类实例）。
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
    const listener = (_event: IpcRendererEvent, payload: T) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => {
        ipcRenderer.removeListener(channel, listener);
    };
}

// 暴露安全的 API 给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
    // 集群管理
    cluster: {
        list: () => ipcRenderer.invoke('cluster:list'),
        checkStatus: () => ipcRenderer.invoke('cluster:checkStatus'),
        add: (config: ClusterConfigDraft) => ipcRenderer.invoke('cluster:add', config),
        update: (id: string, config: ClusterConfigDraft) => ipcRenderer.invoke('cluster:update', id, config),
        delete: (id: string) => ipcRenderer.invoke('cluster:delete', id),
        testConnection: (config: ClusterConfigDraft) => ipcRenderer.invoke('cluster:testConnection', config),
    },

    // 资源管理
    resources: {
        getTenants: (clusterId: string) => ipcRenderer.invoke('resources:getTenants', clusterId),
        getNamespaces: (clusterId: string, tenant: string) =>
            ipcRenderer.invoke('resources:getNamespaces', clusterId, tenant),
        getTopics: (clusterId: string, tenant: string, namespace: string) =>
            ipcRenderer.invoke('resources:getTopics', clusterId, tenant, namespace),
        getTopicStats: (clusterId: string, tenant: string, namespace: string, topic: string, persistent?: boolean) =>
            ipcRenderer.invoke('resources:getTopicStats', clusterId, tenant, namespace, topic, persistent),
        getTopicConfig: (clusterId: string, tenant: string, namespace: string, topic: string, persistent?: boolean) =>
            ipcRenderer.invoke('resources:getTopicConfig', clusterId, tenant, namespace, topic, persistent),
        updateTopicConfig: (
            clusterId: string,
            tenant: string,
            namespace: string,
            topic: string,
            config: TopicConfigPatch,
            persistent?: boolean,
        ) => ipcRenderer.invoke('resources:updateTopicConfig', clusterId, tenant, namespace, topic, config, persistent),
        getSubscriptions: (clusterId: string, tenant: string, namespace: string, topic: string, persistent?: boolean) =>
            ipcRenderer.invoke('resources:getSubscriptions', clusterId, tenant, namespace, topic, persistent),
        getTenantInfo: (clusterId: string, tenant: string) =>
            ipcRenderer.invoke('resources:getTenantInfo', clusterId, tenant),
        createSubscription: (
            clusterId: string,
            tenant: string,
            namespace: string,
            topic: string,
            name: string,
            initialPosition?: 'Latest' | 'Earliest',
            persistent?: boolean,
        ) =>
            ipcRenderer.invoke(
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
        ) => ipcRenderer.invoke('resources:deleteSubscription', clusterId, tenant, namespace, topic, name, persistent),
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
            ipcRenderer.invoke(
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
            ipcRenderer.invoke(
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
            ipcRenderer.invoke('resources:deleteTopic', clusterId, tenant, namespace, topic, persistent),

        getSchema: (clusterId: string, tenant: string, namespace: string, topic: string, persistent?: boolean) =>
            ipcRenderer.invoke('resources:getSchema', clusterId, tenant, namespace, topic, persistent),
        getSchemaStrategy: (
            clusterId: string,
            tenant: string,
            namespace: string,
            topic: string,
            persistent?: boolean,
        ) => ipcRenderer.invoke('resources:getSchemaStrategy', clusterId, tenant, namespace, topic, persistent),
        setSchemaStrategy: (
            clusterId: string,
            tenant: string,
            namespace: string,
            topic: string,
            strategy: SchemaCompatibilityPolicy,
            persistent?: boolean,
        ) =>
            ipcRenderer.invoke(
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
            ipcRenderer.invoke(
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
            ipcRenderer.invoke('resources:deleteSchema', clusterId, tenant, namespace, topic, persistent),

        getNamespacePermissions: (clusterId: string, tenant: string, namespace: string) =>
            ipcRenderer.invoke('resources:getNamespacePermissions', clusterId, tenant, namespace),
        grantNamespacePermission: (
            clusterId: string,
            tenant: string,
            namespace: string,
            role: string,
            actions: PulsarAuthAction[],
        ) => ipcRenderer.invoke('resources:grantNamespacePermission', clusterId, tenant, namespace, role, actions),
        revokeNamespacePermission: (clusterId: string, tenant: string, namespace: string, role: string) =>
            ipcRenderer.invoke('resources:revokeNamespacePermission', clusterId, tenant, namespace, role),
        getTopicPermissions: (
            clusterId: string,
            tenant: string,
            namespace: string,
            topic: string,
            persistent?: boolean,
        ) => ipcRenderer.invoke('resources:getTopicPermissions', clusterId, tenant, namespace, topic, persistent),
        grantTopicPermission: (
            clusterId: string,
            tenant: string,
            namespace: string,
            topic: string,
            role: string,
            actions: PulsarAuthAction[],
            persistent?: boolean,
        ) =>
            ipcRenderer.invoke(
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
            ipcRenderer.invoke(
                'resources:revokeTopicPermission',
                clusterId,
                tenant,
                namespace,
                topic,
                role,
                persistent,
            ),

        // Pulsar 侧集群名称列表，创建租户时 allowedClusters 用这里的值
        getPulsarClusters: (clusterId: string) => ipcRenderer.invoke('resources:getPulsarClusters', clusterId),
        createTenant: (clusterId: string, name: string, adminRoles: string[], allowedClusters: string[]) =>
            ipcRenderer.invoke('resources:createTenant', clusterId, name, adminRoles, allowedClusters),
        updateTenant: (clusterId: string, tenant: string, adminRoles: string[], allowedClusters: string[]) =>
            ipcRenderer.invoke('resources:updateTenant', clusterId, tenant, adminRoles, allowedClusters),
        deleteTenant: (clusterId: string, tenant: string) =>
            ipcRenderer.invoke('resources:deleteTenant', clusterId, tenant),
        createNamespace: (clusterId: string, tenant: string, name: string) =>
            ipcRenderer.invoke('resources:createNamespace', clusterId, tenant, name),
        deleteNamespace: (clusterId: string, tenant: string, namespace: string) =>
            ipcRenderer.invoke('resources:deleteNamespace', clusterId, tenant, namespace),
        createTopic: (
            clusterId: string,
            tenant: string,
            namespace: string,
            name: string,
            persistent?: boolean,
            partitions?: number,
        ) => ipcRenderer.invoke('resources:createTopic', clusterId, tenant, namespace, name, persistent, partitions),
    },

    // 消息操作：收发走原生客户端（admin REST 上没有 send/peek 路由）
    messages: {
        send: (params: MessageSendParams) => ipcRenderer.invoke('messages:send', params),
        startConsume: (params: ConsumeStartParams) => ipcRenderer.invoke('messages:startConsume', params),
        stopConsume: (sessionId: string) => ipcRenderer.invoke('messages:stopConsume', {sessionId}),
        startRead: (params: ReadStartParams) => ipcRenderer.invoke('messages:startRead', params),
        stopRead: (sessionId: string) => ipcRenderer.invoke('messages:stopRead', {sessionId}),
        getBacklog: (params: SubscriptionPathParams) => ipcRenderer.invoke('messages:getBacklog', params),
        peek: (params: PeekParams) => ipcRenderer.invoke('messages:peek', params),
        onConsumeBatch: (callback: (batch: MessageBatch) => void) => subscribe(CONSUME_BATCH_CHANNEL, callback),
        onReadBatch: (callback: (batch: MessageBatch) => void) => subscribe(READ_BATCH_CHANNEL, callback),
        onSessionEnd: (callback: (event: SessionEndEvent) => void) => subscribe(SESSION_END_CHANNEL, callback),
    },

    // 生产者工作台。会话结束事件与消费共用 msg:session-end——"会话没了"在两边
    // 是同一件事，渲染端不该分两个监听再去猜哪个先响。
    producer: {
        startSession: (params: ProducerStartParams) => ipcRenderer.invoke('producer:startSession', params),
        send: (params: ProducerSendParams) => ipcRenderer.invoke('producer:send', params),
        sendOnce: (params: ProducerSendOnceParams) => ipcRenderer.invoke('producer:sendOnce', params),
        flush: (sessionId: string) => ipcRenderer.invoke('producer:flush', {sessionId}),
        startFlow: (params: ProducerFlowParams) => ipcRenderer.invoke('producer:startFlow', params),
        stopFlow: (sessionId: string) => ipcRenderer.invoke('producer:stopFlow', {sessionId}),
        setRate: (params: ProducerSetRateParams) => ipcRenderer.invoke('producer:setRate', params),
        onStats: (callback: (stats: ProducerRunStats) => void) => subscribe(PRODUCER_STATS_CHANNEL, callback),
        stop: (sessionId: string) => ipcRenderer.invoke('producer:stop', {sessionId}),
        listSessions: (clusterId?: string) => ipcRenderer.invoke('producer:listSessions', {clusterId}),
    },

    // 消费者工作台。批次里不新增推送通道：消息批次与三态面板同一条
    // msg:consume-batch，界面按 sessionId 认领，多开几条会话也各收各的。
    consumer: {
        start: (params: ConsumeStartParams) => ipcRenderer.invoke('consumer:start', params),
        stop: (sessionId: string) => ipcRenderer.invoke('consumer:stop', {sessionId}),
        listSessions: (clusterId?: string) => ipcRenderer.invoke('consumer:list', {clusterId}),
        // 手动确认：按主进程登记表的序号确认/重投，回落定后的会话快照（含 pendingAcks）
        ack: (params: ConsumerAckParams) => ipcRenderer.invoke('consumer:ack', params),
        nack: (params: ConsumerAckParams) => ipcRenderer.invoke('consumer:nack', params),
    },

    // 报文模板库（生产者工作台）：纯本地 SQLite，集群离线也能翻出上次写好的报文
    template: {
        list: (params: WorkbenchScopeParams) => ipcRenderer.invoke('template:list', params),
        create: (params: MessageTemplateUpsertParams) => ipcRenderer.invoke('template:create', params),
        update: (params: MessageTemplateUpsertParams) => ipcRenderer.invoke('template:update', params),
        delete: (id: string) => ipcRenderer.invoke('template:delete', {id}),
        copy: (params: WorkbenchCopyParams) => ipcRenderer.invoke('template:copy', params),
    },

    // 消费者会话配置：同样只在本地库里
    consumerConfig: {
        list: (params: WorkbenchScopeParams) => ipcRenderer.invoke('consumerConfig:list', params),
        create: (params: ConsumerConfigUpsertParams) => ipcRenderer.invoke('consumerConfig:create', params),
        update: (params: ConsumerConfigUpsertParams) => ipcRenderer.invoke('consumerConfig:update', params),
        delete: (id: string) => ipcRenderer.invoke('consumerConfig:delete', {id}),
        copy: (params: ConsumerConfigCopyParams) => ipcRenderer.invoke('consumerConfig:copy', params),
    },

    // 发送历史只读；写入在 producer 的发送路径里，界面不能自己编一条成功记录
    sendHistory: {
        list: (params: SendHistoryListParams) => ipcRenderer.invoke('sendHistory:list', params),
        // 列表不带全文，重发时按行 id 单取
        get: (id: number) => ipcRenderer.invoke('sendHistory:get', {id}),
    },

    // 快速压测：start 拿到 runId 就返回，进度经 benchmark:progress 单向推送
    benchmark: {
        start: (params: LoadTestParams) => ipcRenderer.invoke('benchmark:start', params),
        stop: (runId: string) => ipcRenderer.invoke('benchmark:stop', {runId}),
        onProgress: (callback: (progress: LoadTestProgress) => void) => subscribe(LOAD_TEST_PROGRESS_CHANNEL, callback),
    },

    // 监控
    metrics: {
        getAggregatedStats: (clusterId: string) => ipcRenderer.invoke('metrics:getAggregatedStats', clusterId),
        getBrokers: (clusterId: string) => ipcRenderer.invoke('metrics:getBrokers', clusterId),
        recordSnapshot: (snapshot: MetricsSnapshotInput) => ipcRenderer.invoke('metrics:recordSnapshot', snapshot),
        listSnapshots: (query: MetricsSnapshotQuery) => ipcRenderer.invoke('metrics:listSnapshots', query),
    },

    // 告警：规则与事件都是本地数据，评估由主进程定时器驱动
    alert: {
        // 不选集群 = 全部；undefined 进 IPC 载荷会被结构化克隆丢掉字段，这里统一成空串
        listRules: (clusterId?: string) => ipcRenderer.invoke('alert:rules:list', {clusterId: clusterId || ''}),
        upsertRule: (params: AlertRuleUpsertParams) => ipcRenderer.invoke('alert:rule:upsert', params),
        deleteRule: (id: string) => ipcRenderer.invoke('alert:rule:delete', {id}),
        testRule: (id: string) => ipcRenderer.invoke('alert:rule:test', {id}),
        listEvents: (query: AlertEventQuery) => ipcRenderer.invoke('alert:events:list', query),
        ackEvents: (ids: number[]) => ipcRenderer.invoke('alert:events:ack', {ids}),
        deleteEvents: (ids: number[]) => ipcRenderer.invoke('alert:events:delete', {ids}),
        countOpen: () => ipcRenderer.invoke('alert:rules:count'),
        // 引擎的立案/恢复是单向推送，返回反订阅闭包
        onEvent: (callback: (push: AlertPush) => void) => subscribe(ALERT_EVENT_CHANNEL, callback),
    },

    // 函数与连接器：全部经 admin REST，主进程已经判断过 worker 是否启用，
    // 未启用时返回的是那句翻译过的说明而不是裸 404。
    worker: {
        getState: (clusterId: string, force?: boolean) => ipcRenderer.invoke('worker:state', {clusterId, force}),
        listItems: (params: {clusterId: string; kind: PulsarResourceKind; tenant: string; namespace: string}) =>
            ipcRenderer.invoke('worker:items:list', params),
        getItem: (params: {
            clusterId: string;
            kind: PulsarResourceKind;
            tenant: string;
            namespace: string;
            name: string;
        }) => ipcRenderer.invoke('worker:item:get', params),
        createItem: (params: PulsarRuntimeCreateParams) => ipcRenderer.invoke('worker:item:create', params),
        controlItem: (params: {
            clusterId: string;
            kind: PulsarResourceKind;
            tenant: string;
            namespace: string;
            name: string;
            action: 'start' | 'stop' | 'restart';
            instanceId?: number;
        }) => ipcRenderer.invoke('worker:item:control', params),
        deleteItem: (params: {
            clusterId: string;
            kind: PulsarResourceKind;
            tenant: string;
            namespace: string;
            name: string;
        }) => ipcRenderer.invoke('worker:item:delete', params),
        trigger: (params: {
            clusterId: string;
            tenant: string;
            namespace: string;
            name: string;
            topic: string;
            data?: string;
        }) => ipcRenderer.invoke('worker:function:trigger', {kind: 'function', ...params}),
        listBuiltins: (clusterId: string, kind: PulsarResourceKind) =>
            ipcRenderer.invoke('worker:builtin:list', {clusterId, kind}),
        reloadBuiltins: (clusterId: string, kind: PulsarResourceKind) =>
            ipcRenderer.invoke('worker:builtin:reload', {clusterId, kind}),
    },

    // 命名空间策略：读一次拿折叠好的视图，写按字段端点逐个走
    namespacePolicy: {
        get: (params: NamespacePolicyScopeParams) => ipcRenderer.invoke('namespace:policies:get', params),
        set: (params: NamespacePolicySetParams) => ipcRenderer.invoke('namespace:policy:set', params),
        clear: (params: NamespacePolicyClearParams) => ipcRenderer.invoke('namespace:policy:clear', params),
        syncPlan: (params: NamespacePolicySyncParams) => ipcRenderer.invoke('namespace:policies:sync:plan', params),
        syncApply: (params: NamespacePolicySyncParams) => ipcRenderer.invoke('namespace:policies:sync:apply', params),
    },

    // Topic 级策略（broker 的 TopicPolicies：一字段一端点）
    topicPolicy: {
        get: (params: TopicPolicyScopeParams) => ipcRenderer.invoke('topic:policy:get', params),
        set: (params: TopicPolicySetParams) => ipcRenderer.invoke('topic:policy:set', params),
        clear: (params: TopicPolicyClearParams) => ipcRenderer.invoke('topic:policy:clear', params),
        syncPlan: (params: TopicPolicySyncParams) => ipcRenderer.invoke('topic:policy:sync:plan', params),
        syncApply: (params: TopicPolicySyncParams) => ipcRenderer.invoke('topic:policy:sync:apply', params),
    },

    // 集群巡检：一次只读采集换一份能导出发人的报告
    inspection: {
        run: (params: InspectionRunParams) => ipcRenderer.invoke('inspection:run', params),
        history: (params: {clusterId: string; limit?: number}) => ipcRenderer.invoke('inspection:history', params),
        detail: (params: {id: string}) => ipcRenderer.invoke('inspection:detail', params),
        clear: (params: {clusterId: string}) => ipcRenderer.invoke('inspection:clear', params),
        profile: {
            get: (params: {clusterId: string}) => ipcRenderer.invoke('inspection:profile:get', params),
            save: (params: InspectionProfileDraft) => ipcRenderer.invoke('inspection:profile:save', params),
        },
        schedule: {
            get: (params: {clusterId: string}) => ipcRenderer.invoke('inspection:schedule:get', params),
            save: (params: InspectionScheduleDraft) => ipcRenderer.invoke('inspection:schedule:save', params),
        },
        // 定时那一轮跑完（或跑坏）之后推来的那一条：巡检页靠它把历史刷回来，
        // 否则用户只能自己猜应用什么时候动过手
        onScheduled: (callback: (push: InspectionScheduledPush) => void) =>
            subscribe(INSPECTION_SCHEDULE_CHANNEL, callback),
        // 跨集群汇总：读的是每台最近一份落库的报告，跑的是逐台串行
        summary: {
            get: () => ipcRenderer.invoke('inspection:summary'),
            run: (params: InspectionFleetRunParams) => ipcRenderer.invoke('inspection:summary:run', params),
        },
        onFleetProgress: (callback: (progress: InspectionFleetProgress) => void) =>
            subscribe(INSPECTION_FLEET_CHANNEL, callback),
    },

    // 外部通知渠道：告警与巡检的结论要能离开这台机器，所以这里只管配置与查投递结果，
    // 发是主进程在事件落库之后自己顺手发的
    notify: {
        channel: {
            list: () => ipcRenderer.invoke('notify:channel:list'),
            save: (draft: NotifyChannelDraft) => ipcRenderer.invoke('notify:channel:save', draft),
            delete: (params: {id: string}) => ipcRenderer.invoke('notify:channel:delete', params),
            enable: (params: {id: string; enabled: boolean}) => ipcRenderer.invoke('notify:channel:enable', params),
            test: (params: {id: string}) => ipcRenderer.invoke('notify:channel:test', params),
        },
        delivery: {
            list: (params?: {limit?: number}) => ipcRenderer.invoke('notify:delivery:list', params ?? {}),
        },
        // 邮件服务器（SMTP）：一台服务器可以多条邮件渠道共用，所以它与渠道分开管
        mail: {
            list: () => ipcRenderer.invoke('notify:mail:list'),
            save: (draft: MailProfileDraft) => ipcRenderer.invoke('notify:mail:save', draft),
            delete: (params: {id: string}) => ipcRenderer.invoke('notify:mail:delete', params),
            test: (params: {id: string; to?: string}) => ipcRenderer.invoke('notify:mail:test', params),
        },
    },

    // 拓扑
    topology: {
        getClusterTopology: (clusterId: string, limits?: TopologyLimits) =>
            ipcRenderer.invoke('topology:getClusterTopology', clusterId, limits),
    },

    // SSH 隧道
    ssh: {
        connect: (config: SSHConfig) => ipcRenderer.invoke('ssh:connect', config),
        disconnect: (tunnelId: string) => ipcRenderer.invoke('ssh:disconnect', tunnelId),
    },

    // K8s 端口转发
    k8s: {
        connect: (config: K8sForwardConfig) => ipcRenderer.invoke('k8s:connect', config),
        disconnect: (forwardId: string) => ipcRenderer.invoke('k8s:disconnect', forwardId),
    },

    // 主题
    theme: {
        set: (theme: string) => ipcRenderer.invoke('theme:set', theme),
        get: () => ipcRenderer.invoke('theme:get'),
    },

    // 设置
    settings: {
        get: (key: string) => ipcRenderer.invoke('settings:get', key),
        set: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
    },

    // 配置中心：可持久化应用设置的读写，加上导出一整套 / 导入一整套
    config: {
        getAll: () => ipcRenderer.invoke('config:getAll'),
        update: (patch: Partial<AppSettings>) => ipcRenderer.invoke('config:update', patch),
        reset: () => ipcRenderer.invoke('config:reset'),
        meta: () => ipcRenderer.invoke('config:meta'),
        export: () => ipcRenderer.invoke('config:export'),
        import: (bundle: ConfigBundle) => ipcRenderer.invoke('config:import', bundle),
        clearLogs: () => ipcRenderer.invoke('config:clearLogs'),
    },

    // 操作日志
    logs: {
        getRecent: (limit?: number) => ipcRenderer.invoke('logs:getRecent', limit),
    },

    // 本地文件选择（函数 / 连接器的包）：只回路径与元信息，内容不进渲染进程
    file: {
        pickArchive: () => ipcRenderer.invoke('file:pickArchive'),
    },

    // 插件市场：本地声明式插件，只贡献压测预设与 Topic 模板
    plugin: {
        list: () => ipcRenderer.invoke('plugin:list'),
        installOfficial: (id: string) => ipcRenderer.invoke('plugin:installOfficial', {id}),
        import: (text: string) => ipcRenderer.invoke('plugin:import', {text}),
        uninstall: (id: string) => ipcRenderer.invoke('plugin:uninstall', {id}),
        setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('plugin:setEnabled', {id, enabled}),
        revealDir: () => ipcRenderer.invoke('plugin:revealDir'),
    },

    // 在线更新
    update: {
        // 走主进程取 app.getVersion()：这里以前返回 process.versions.app，那是 Electron
        // 运行时版本，跟 package.json 的版本号没有任何关系
        getVersion: () => ipcRenderer.invoke('update:getVersion'),
        check: () => ipcRenderer.invoke('update:check'),
        download: (url: string) => ipcRenderer.invoke('update:download', url),
        install: () => ipcRenderer.invoke('update:install'),
        onProgress: (
            callback: (progress: {received: number; total: number; done?: boolean; error?: string}) => void,
        ) => {
            const listener = (_event: unknown, progress: unknown) =>
                callback(progress as {received: number; total: number; done?: boolean; error?: string});
            ipcRenderer.on('update:progress', listener);
            return () => ipcRenderer.removeListener('update:progress', listener);
        },
    },
});

// 全局类型声明

declare global {
    interface Window {
        electronAPI: {
            cluster: {
                list: () => Promise<APIResponse<ClusterConfig[]>>;
                checkStatus: () => Promise<APIResponse<ClusterConfig[]>>;
                add: (config: ClusterConfigDraft) => Promise<APIResponse<ClusterConfig>>;
                update: (id: string, config: ClusterConfigDraft) => Promise<APIResponse<ClusterConfig>>;
                delete: (id: string) => Promise<APIResponse<void>>;
                testConnection: (
                    config: ClusterConfigDraft,
                ) => Promise<
                    APIResponse<{connected: boolean; version?: string; sshConfigId?: string; k8sConfigId?: string}>
                >;
            };
            resources: {
                getTenants: (clusterId: string) => Promise<APIResponse<Tenant[]>>;
                getNamespaces: (clusterId: string, tenant: string) => Promise<APIResponse<string[]>>;
                getTopics: (clusterId: string, tenant: string, namespace: string) => Promise<APIResponse<Topic[]>>;
                getTopicStats: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                    topic: string,
                    persistent?: boolean,
                ) => Promise<APIResponse<TopicStats>>;
                getTopicConfig: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                    topic: string,
                    persistent?: boolean,
                ) => Promise<APIResponse<TopicConfig>>;
                updateTopicConfig: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                    topic: string,
                    config: TopicConfigPatch,
                    persistent?: boolean,
                ) => Promise<APIResponse<void>>;
                getSubscriptions: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                    topic: string,
                    persistent?: boolean,
                ) => Promise<APIResponse<string[]>>;
                getTenantInfo: (
                    clusterId: string,
                    tenant: string,
                ) => Promise<APIResponse<{adminRoles: string[]; allowedClusters: string[]}>>;
                createSubscription: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                    topic: string,
                    name: string,
                    initialPosition?: 'Latest' | 'Earliest',
                    persistent?: boolean,
                ) => Promise<APIResponse<void>>;
                deleteSubscription: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                    topic: string,
                    name: string,
                    persistent?: boolean,
                ) => Promise<APIResponse<void>>;
                resetCursor: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                    topic: string,
                    subscription: string,
                    position: 'earliest' | 'latest' | 'timestamp',
                    timestamp?: number,
                    persistent?: boolean,
                ) => Promise<APIResponse<void>>;
                skipMessages: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                    topic: string,
                    subscription: string,
                    count: number,
                    persistent?: boolean,
                ) => Promise<APIResponse<void>>;
                deleteTopic: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                    topic: string,
                    persistent?: boolean,
                ) => Promise<APIResponse<void>>;
                getSchema: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                    topic: string,
                    persistent?: boolean,
                ) => Promise<APIResponse<BrokerSchemaInfo | null>>;
                getSchemaStrategy: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                    topic: string,
                    persistent?: boolean,
                ) => Promise<APIResponse<{strategy: string | null; scope: 'topic' | 'namespace'}>>;
                setSchemaStrategy: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                    topic: string,
                    strategy: SchemaCompatibilityPolicy,
                    persistent?: boolean,
                ) => Promise<APIResponse<void>>;
                createSchemaVersion: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                    topic: string,
                    type: BrokerSchemaType,
                    definition: string,
                    persistent?: boolean,
                ) => Promise<APIResponse<BrokerSchemaInfo>>;
                deleteSchema: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                    topic: string,
                    persistent?: boolean,
                ) => Promise<APIResponse<void>>;
                getNamespacePermissions: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                ) => Promise<APIResponse<PermissionMap>>;
                grantNamespacePermission: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                    role: string,
                    actions: PulsarAuthAction[],
                ) => Promise<APIResponse<void>>;
                revokeNamespacePermission: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                    role: string,
                ) => Promise<APIResponse<void>>;
                getTopicPermissions: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                    topic: string,
                    persistent?: boolean,
                ) => Promise<APIResponse<PermissionMap>>;
                grantTopicPermission: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                    topic: string,
                    role: string,
                    actions: PulsarAuthAction[],
                    persistent?: boolean,
                ) => Promise<APIResponse<void>>;
                revokeTopicPermission: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                    topic: string,
                    role: string,
                    persistent?: boolean,
                ) => Promise<APIResponse<void>>;
                getPulsarClusters: (clusterId: string) => Promise<APIResponse<string[]>>;
                createTenant: (
                    clusterId: string,
                    name: string,
                    adminRoles: string[],
                    allowedClusters: string[],
                ) => Promise<APIResponse<void>>;
                updateTenant: (
                    clusterId: string,
                    tenant: string,
                    adminRoles: string[],
                    allowedClusters: string[],
                ) => Promise<APIResponse<void>>;
                deleteTenant: (clusterId: string, tenant: string) => Promise<APIResponse<void>>;
                createNamespace: (clusterId: string, tenant: string, name: string) => Promise<APIResponse<void>>;
                deleteNamespace: (clusterId: string, tenant: string, namespace: string) => Promise<APIResponse<void>>;
                createTopic: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                    name: string,
                    persistent?: boolean,
                    partitions?: number,
                ) => Promise<APIResponse<void>>;
            };
            messages: {
                send: (params: MessageSendParams) => Promise<APIResponse<{messageId: string}>>;
                startConsume: (params: ConsumeStartParams) => Promise<APIResponse<{sessionId: string}>>;
                stopConsume: (sessionId: string) => Promise<APIResponse<{stopped: boolean}>>;
                startRead: (params: ReadStartParams) => Promise<APIResponse<{sessionId: string}>>;
                stopRead: (sessionId: string) => Promise<APIResponse<{stopped: boolean}>>;
                getBacklog: (params: SubscriptionPathParams) => Promise<APIResponse<BacklogInfo>>;
                peek: (params: PeekParams) => Promise<APIResponse<PeekResult>>;
                onConsumeBatch: (callback: (batch: MessageBatch) => void) => () => void;
                onReadBatch: (callback: (batch: MessageBatch) => void) => () => void;
                onSessionEnd: (callback: (event: SessionEndEvent) => void) => () => void;
            };
            producer: {
                startSession: (params: ProducerStartParams) => Promise<APIResponse<ProducerSessionInfo>>;
                send: (params: ProducerSendParams) => Promise<APIResponse<ProducerSendResult>>;
                sendOnce: (params: ProducerSendOnceParams) => Promise<APIResponse<ProducerSendResult>>;
                flush: (sessionId: string) => Promise<APIResponse<{flushed: boolean}>>;
                startFlow: (params: ProducerFlowParams) => Promise<APIResponse<ProducerSessionInfo>>;
                stopFlow: (sessionId: string) => Promise<APIResponse<ProducerRunStats | null>>;
                setRate: (params: ProducerSetRateParams) => Promise<APIResponse<ProducerSessionInfo>>;
                onStats: (callback: (stats: ProducerRunStats) => void) => () => void;
                stop: (sessionId: string) => Promise<APIResponse<{stopped: boolean}>>;
                listSessions: (clusterId?: string) => Promise<APIResponse<ProducerSessionInfo[]>>;
            };
            consumer: {
                start: (params: ConsumeStartParams) => Promise<APIResponse<ConsumerSessionInfo>>;
                stop: (sessionId: string) => Promise<APIResponse<{stopped: boolean}>>;
                listSessions: (clusterId?: string) => Promise<APIResponse<ConsumerSessionInfo[]>>;
                ack: (params: ConsumerAckParams) => Promise<APIResponse<ConsumerSessionInfo>>;
                nack: (params: ConsumerAckParams) => Promise<APIResponse<ConsumerSessionInfo>>;
            };
            template: {
                list: (params: WorkbenchScopeParams) => Promise<APIResponse<MessageTemplate[]>>;
                create: (params: MessageTemplateUpsertParams) => Promise<APIResponse<MessageTemplate>>;
                update: (params: MessageTemplateUpsertParams) => Promise<APIResponse<MessageTemplate>>;
                delete: (id: string) => Promise<APIResponse<{deleted: boolean}>>;
                copy: (params: WorkbenchCopyParams) => Promise<APIResponse<MessageTemplate>>;
            };
            consumerConfig: {
                list: (params: WorkbenchScopeParams) => Promise<APIResponse<ConsumerSessionConfig[]>>;
                create: (params: ConsumerConfigUpsertParams) => Promise<APIResponse<ConsumerSessionConfig>>;
                update: (params: ConsumerConfigUpsertParams) => Promise<APIResponse<ConsumerSessionConfig>>;
                delete: (id: string) => Promise<APIResponse<{deleted: boolean}>>;
                copy: (params: ConsumerConfigCopyParams) => Promise<APIResponse<ConsumerSessionConfig>>;
            };
            sendHistory: {
                list: (params: SendHistoryListParams) => Promise<APIResponse<SendHistoryEntry[]>>;
                get: (id: number) => Promise<APIResponse<SendHistoryEntry | null>>;
            };
            benchmark: {
                start: (params: LoadTestParams) => Promise<APIResponse<{runId: string; topic: string}>>;
                stop: (runId: string) => Promise<APIResponse<{stopped: boolean}>>;
                onProgress: (callback: (progress: LoadTestProgress) => void) => () => void;
            };
            metrics: {
                getAggregatedStats: (clusterId: string) => Promise<APIResponse<AggregatedStats>>;
                getBrokers: (clusterId: string) => Promise<APIResponse<BrokerInfo>>;
                recordSnapshot: (snapshot: MetricsSnapshotInput) => Promise<APIResponse<null>>;
                listSnapshots: (query: MetricsSnapshotQuery) => Promise<APIResponse<MetricsSnapshot[]>>;
            };
            // 告警：规则与事件全部来自本地 SQLite，评估在主进程定时器里跑
            alert: {
                listRules: (clusterId?: string) => Promise<APIResponse<AlertRule[]>>;
                upsertRule: (params: AlertRuleUpsertParams) => Promise<APIResponse<AlertRule | null>>;
                deleteRule: (id: string) => Promise<APIResponse<number>>;
                testRule: (id: string) => Promise<APIResponse<AlertProbeResult>>;
                listEvents: (query: AlertEventQuery) => Promise<APIResponse<AlertEvent[]>>;
                ackEvents: (ids: number[]) => Promise<APIResponse<number>>;
                deleteEvents: (ids: number[]) => Promise<APIResponse<number>>;
                countOpen: () => Promise<APIResponse<number>>;
                onEvent: (callback: (push: AlertPush) => void) => () => void;
            };
            worker: {
                getState: (clusterId: string, force?: boolean) => Promise<APIResponse<PulsarWorkerState>>;
                listItems: (params: {
                    clusterId: string;
                    kind: PulsarResourceKind;
                    tenant: string;
                    namespace: string;
                }) => Promise<APIResponse<PulsarRuntimeItem[]>>;
                getItem: (params: {
                    clusterId: string;
                    kind: PulsarResourceKind;
                    tenant: string;
                    namespace: string;
                    name: string;
                }) => Promise<APIResponse<PulsarRuntimeItem>>;
                createItem: (params: PulsarRuntimeCreateParams) => Promise<APIResponse<string>>;
                controlItem: (params: {
                    clusterId: string;
                    kind: PulsarResourceKind;
                    tenant: string;
                    namespace: string;
                    name: string;
                    action: 'start' | 'stop' | 'restart';
                    instanceId?: number;
                }) => Promise<APIResponse<void>>;
                deleteItem: (params: {
                    clusterId: string;
                    kind: PulsarResourceKind;
                    tenant: string;
                    namespace: string;
                    name: string;
                }) => Promise<APIResponse<void>>;
                trigger: (params: {
                    clusterId: string;
                    tenant: string;
                    namespace: string;
                    name: string;
                    topic: string;
                    data?: string;
                }) => Promise<APIResponse<PulsarTriggerResult>>;
                listBuiltins: (
                    clusterId: string,
                    kind: PulsarResourceKind,
                ) => Promise<APIResponse<PulsarBuiltinDefinition[]>>;
                reloadBuiltins: (clusterId: string, kind: PulsarResourceKind) => Promise<APIResponse<void>>;
            };
            namespacePolicy: {
                get: (params: NamespacePolicyScopeParams) => Promise<APIResponse<NamespacePolicyView>>;
                set: (params: NamespacePolicySetParams) => Promise<APIResponse<void>>;
                clear: (params: NamespacePolicyClearParams) => Promise<APIResponse<void>>;
                syncPlan: (params: NamespacePolicySyncParams) => Promise<APIResponse<NamespacePolicySyncPlanResult>>;
                syncApply: (params: NamespacePolicySyncParams) => Promise<APIResponse<NamespacePolicySyncApplyResult>>;
            };
            topicPolicy: {
                get: (params: TopicPolicyScopeParams) => Promise<APIResponse<TopicPolicyView>>;
                set: (params: TopicPolicySetParams) => Promise<APIResponse<void>>;
                clear: (params: TopicPolicyClearParams) => Promise<APIResponse<void>>;
                syncPlan: (params: TopicPolicySyncParams) => Promise<APIResponse<TopicPolicySyncPlanResult>>;
                syncApply: (params: TopicPolicySyncParams) => Promise<APIResponse<TopicPolicySyncApplyResult>>;
            };
            inspection: {
                run: (params: InspectionRunParams) => Promise<APIResponse<InspectionRunResult>>;
                history: (params: {clusterId: string; limit?: number}) => Promise<APIResponse<InspectionHistoryRow[]>>;
                detail: (params: {id: string}) => Promise<APIResponse<InspectionRunResult>>;
                clear: (params: {clusterId: string}) => Promise<APIResponse<number>>;
                profile: {
                    get: (params: {clusterId: string}) => Promise<APIResponse<InspectionProfile | null>>;
                    save: (params: InspectionProfileDraft) => Promise<APIResponse<InspectionProfile>>;
                };
                schedule: {
                    get: (params: {clusterId: string}) => Promise<APIResponse<InspectionSchedule | null>>;
                    save: (params: InspectionScheduleDraft) => Promise<APIResponse<InspectionSchedule>>;
                };
                summary: {
                    get: () => Promise<APIResponse<InspectionFleetSummary>>;
                    run: (params: InspectionFleetRunParams) => Promise<APIResponse<InspectionFleetRunResult>>;
                };
                onScheduled: (callback: (push: InspectionScheduledPush) => void) => () => void;
                onFleetProgress: (callback: (progress: InspectionFleetProgress) => void) => () => void;
            };
            notify: {
                channel: {
                    list: () => Promise<APIResponse<NotifyChannel[]>>;
                    save: (draft: NotifyChannelDraft) => Promise<APIResponse<NotifyChannel>>;
                    delete: (params: {id: string}) => Promise<APIResponse<{deleted: boolean}>>;
                    enable: (params: {id: string; enabled: boolean}) => Promise<APIResponse<{updated: boolean}>>;
                    test: (params: {id: string}) => Promise<APIResponse<NotifyDispatchResult>>;
                };
                delivery: {
                    list: (params?: {limit?: number}) => Promise<APIResponse<NotifyDelivery[]>>;
                };
                mail: {
                    list: () => Promise<APIResponse<MailProfile[]>>;
                    save: (draft: MailProfileDraft) => Promise<APIResponse<MailProfile>>;
                    delete: (params: {id: string}) => Promise<APIResponse<{deleted: boolean; channelsUsing: number}>>;
                    test: (params: {id: string; to?: string}) => Promise<APIResponse<{ok: boolean; message: string}>>;
                };
            };
            topology: {
                getClusterTopology: (
                    clusterId: string,
                    limits?: TopologyLimits,
                ) => Promise<APIResponse<ClusterTopology>>;
            };
            ssh: {
                connect: (
                    config: SSHConfig,
                ) => Promise<APIResponse<{tunnelId: string; localPort: number; localBrokerPort: number}>>;
                disconnect: (tunnelId: string) => Promise<APIResponse<void>>;
            };
            k8s: {
                connect: (
                    config: K8sForwardConfig,
                ) => Promise<APIResponse<{forwardId: string; localAdminPort: number; localBrokerPort: number}>>;
                disconnect: (forwardId: string) => Promise<APIResponse<void>>;
            };
            theme: {
                set: (theme: string) => Promise<APIResponse<void>>;
                get: () => Promise<APIResponse<string>>;
            };
            settings: {
                get: (key: string) => Promise<APIResponse<string | undefined>>;
                set: (key: string, value: string) => Promise<APIResponse<void>>;
            };
            config: {
                getAll: () => Promise<APIResponse<AppSettings>>;
                update: (patch: Partial<AppSettings>) => Promise<APIResponse<AppSettings>>;
                reset: () => Promise<APIResponse<AppSettings>>;
                meta: () => Promise<APIResponse<ConfigMeta>>;
                export: () => Promise<APIResponse<ConfigBundle>>;
                import: (bundle: ConfigBundle) => Promise<APIResponse<ConfigImportResult>>;
                clearLogs: () => Promise<APIResponse<{deleted: number}>>;
            };
            logs: {
                getRecent: (limit?: number) => Promise<APIResponse<OperationLog[]>>;
            };
            file: {
                // 用户取消时 data 为 null，这不是失败
                pickArchive: () => Promise<APIResponse<PickedArchiveFile | null>>;
            };
            plugin: {
                list: () => Promise<APIResponse<PluginListResult>>;
                installOfficial: (id: string) => Promise<APIResponse<PluginEntry>>;
                import: (text: string) => Promise<APIResponse<PluginEntry>>;
                uninstall: (id: string) => Promise<APIResponse<{id: string}>>;
                setEnabled: (id: string, enabled: boolean) => Promise<APIResponse<PluginEntry>>;
                revealDir: () => Promise<APIResponse<{dir: string; failure: string | null}>>;
            };
            update: {
                getVersion: () => Promise<APIResponse<string>>;
                check: () => Promise<
                    APIResponse<{
                        currentVersion: string;
                        latestVersion: string;
                        hasUpdate: boolean;
                        releaseName?: string;
                        releaseNotes?: string;
                        downloadUrl?: string;
                        fileName?: string;
                        size?: number;
                    }>
                >;
                download: (url: string) => Promise<APIResponse<{file: string}>>;
                install: () => Promise<APIResponse<void>>;
                onProgress: (
                    callback: (progress: {received: number; total: number; done?: boolean; error?: string}) => void,
                ) => () => void;
            };
        };
    }
}

export {};
