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
    ConsumeStartParams,
    MessageBatch,
    MessageSendParams,
    NamespaceStats,
    OperationLog,
    ReadStartParams,
    SessionEndEvent,
    SSHConfig,
    SSHTunnel,
    SubscriptionPathParams,
    Tenant,
    Topic,
    TopicConfig,
    TopicConfigPatch,
    TopicStats,
    TopologyLimits,
} from './shared/types';

// sandbox 的 preload 只能 require 白名单模块（electron 等），相对路径的运行时 import
// 会让 Electron 静默跳过整个 preload——桥接对象凭空消失且不打日志，极难定位。
// 通道名因此只能在本地写死，并用 shared/types 的字面量类型钉住：那边改名这边就编译失败。
type StreamChannel = typeof import('./shared/types').MESSAGE_STREAM_CHANNELS;
const CONSUME_BATCH_CHANNEL: StreamChannel['consumeBatch'] = 'msg:consume-batch';
const READ_BATCH_CHANNEL: StreamChannel['readBatch'] = 'msg:read-batch';
const SESSION_END_CHANNEL: StreamChannel['sessionEnd'] = 'msg:session-end';

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
        getNamespaceInfo: (clusterId: string, tenant: string, namespace: string) =>
            ipcRenderer.invoke('resources:getNamespaceInfo', clusterId, tenant, namespace),
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
        onConsumeBatch: (callback: (batch: MessageBatch) => void) => subscribe(CONSUME_BATCH_CHANNEL, callback),
        onReadBatch: (callback: (batch: MessageBatch) => void) => subscribe(READ_BATCH_CHANNEL, callback),
        onSessionEnd: (callback: (event: SessionEndEvent) => void) => subscribe(SESSION_END_CHANNEL, callback),
    },

    // 监控
    metrics: {
        getAggregatedStats: (clusterId: string) => ipcRenderer.invoke('metrics:getAggregatedStats', clusterId),
        getBrokers: (clusterId: string) => ipcRenderer.invoke('metrics:getBrokers', clusterId),
        getNamespaceStats: (clusterId: string, tenant: string, namespace: string) =>
            ipcRenderer.invoke('metrics:getNamespaceStats', clusterId, tenant, namespace),
    },

    // 拓扑
    topology: {
        getClusterTopology: (clusterId: string, limits?: TopologyLimits) =>
            ipcRenderer.invoke('topology:getClusterTopology', clusterId, limits),
    },

    // SSH 隧道
    ssh: {
        list: () => ipcRenderer.invoke('ssh:list'),
        connect: (config: SSHConfig) => ipcRenderer.invoke('ssh:connect', config),
        disconnect: (tunnelId: string) => ipcRenderer.invoke('ssh:disconnect', tunnelId),
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

    // 操作日志
    logs: {
        getRecent: (limit?: number) => ipcRenderer.invoke('logs:getRecent', limit),
    },

    // 系统
    system: {
        checkUpdate: () => ipcRenderer.invoke('system:checkUpdate'),
    },
});

// 全局类型声明

declare global {
    interface Window {
        electronAPI: {
            cluster: {
                list: () => Promise<APIResponse<ClusterConfig[]>>;
                add: (config: ClusterConfigDraft) => Promise<APIResponse<{id: string}>>;
                update: (id: string, config: ClusterConfigDraft) => Promise<APIResponse<void>>;
                delete: (id: string) => Promise<APIResponse<void>>;
                testConnection: (
                    config: ClusterConfigDraft,
                ) => Promise<APIResponse<{connected: boolean; version?: string}>>;
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
                getNamespaceInfo: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                ) => Promise<APIResponse<{replicationClusters: string[]; clusters: string[]}>>;
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
                onConsumeBatch: (callback: (batch: MessageBatch) => void) => () => void;
                onReadBatch: (callback: (batch: MessageBatch) => void) => () => void;
                onSessionEnd: (callback: (event: SessionEndEvent) => void) => () => void;
            };
            metrics: {
                getAggregatedStats: (clusterId: string) => Promise<APIResponse<AggregatedStats>>;
                getBrokers: (clusterId: string) => Promise<APIResponse<BrokerInfo>>;
                getNamespaceStats: (
                    clusterId: string,
                    tenant: string,
                    namespace: string,
                ) => Promise<APIResponse<NamespaceStats>>;
            };
            topology: {
                getClusterTopology: (
                    clusterId: string,
                    limits?: TopologyLimits,
                ) => Promise<APIResponse<ClusterTopology>>;
            };
            ssh: {
                list: () => Promise<APIResponse<SSHTunnel[]>>;
                connect: (
                    config: SSHConfig,
                ) => Promise<APIResponse<{tunnelId: string; localPort: number; localBrokerPort: number}>>;
                disconnect: (tunnelId: string) => Promise<APIResponse<void>>;
            };
            theme: {
                set: (theme: string) => Promise<APIResponse<void>>;
                get: () => Promise<APIResponse<string>>;
            };
            settings: {
                get: (key: string) => Promise<APIResponse<string | undefined>>;
                set: (key: string, value: string) => Promise<APIResponse<void>>;
            };
            logs: {
                getRecent: (limit?: number) => Promise<APIResponse<OperationLog[]>>;
            };
            system: {
                checkUpdate: () => Promise<
                    APIResponse<{currentVersion: string; latestVersion: string; hasUpdate: boolean}>
                >;
            };
        };
    }
}

export {};
