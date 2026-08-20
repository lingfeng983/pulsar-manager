import { contextBridge, ipcRenderer } from 'electron'
import type {
  APIResponse,
  AggregatedStats,
  BrokerInfo,
  ClusterConfig,
  ClusterConfigDraft,
  ClusterTopology,
  Message,
  MessageBrowseParams,
  MessageSendParams,
  MetricData,
  NamespaceStats,
  OperationLog,
  SSHConfig,
  SSHTunnel,
  Tenant,
  TimeRange,
  Topic,
  TopicStats,
  TopologyLimits,
} from './shared/types'


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
    updateTopicConfig: (clusterId: string, tenant: string, namespace: string, topic: string, config: any, persistent?: boolean) =>
      ipcRenderer.invoke('resources:updateTopicConfig', clusterId, tenant, namespace, topic, config, persistent),
    getSubscriptions: (clusterId: string, tenant: string, namespace: string, topic: string) =>
      ipcRenderer.invoke('resources:getSubscriptions', clusterId, tenant, namespace, topic),
    getTenantInfo: (clusterId: string, tenant: string) =>
      ipcRenderer.invoke('resources:getTenantInfo', clusterId, tenant),
    getNamespaceInfo: (clusterId: string, tenant: string, namespace: string) =>
      ipcRenderer.invoke('resources:getNamespaceInfo', clusterId, tenant, namespace),
    createSubscription: (clusterId: string, tenant: string, namespace: string, topic: string, name: string, type: string) =>
      ipcRenderer.invoke('resources:createSubscription', clusterId, tenant, namespace, topic, name, type),
    deleteSubscription: (clusterId: string, tenant: string, namespace: string, topic: string, name: string) =>
      ipcRenderer.invoke('resources:deleteSubscription', clusterId, tenant, namespace, topic, name),
    resetCursor: (clusterId: string, tenant: string, namespace: string, topic: string, subscription: string, position: 'earliest' | 'latest' | 'timestamp', timestamp?: number) =>
      ipcRenderer.invoke('resources:resetCursor', clusterId, tenant, namespace, topic, subscription, position, timestamp),
    skipMessages: (clusterId: string, tenant: string, namespace: string, topic: string, subscription: string, count: number) =>
      ipcRenderer.invoke('resources:skipMessages', clusterId, tenant, namespace, topic, subscription, count),
    deleteTopic: (clusterId: string, tenant: string, namespace: string, topic: string) =>
      ipcRenderer.invoke('resources:deleteTopic', clusterId, tenant, namespace, topic),
  },

  // 消息操作
  messages: {
    browse: (params: MessageBrowseParams) => ipcRenderer.invoke('messages:browse', params),
    send: (params: MessageSendParams) => ipcRenderer.invoke('messages:send', params),
  },

  // 监控
  metrics: {
    query: (clusterId: string, query: string, range: TimeRange) =>
      ipcRenderer.invoke('metrics:query', clusterId, query, range),
    getAggregatedStats: (clusterId: string) =>
      ipcRenderer.invoke('metrics:getAggregatedStats', clusterId),
    getBrokers: (clusterId: string) =>
      ipcRenderer.invoke('metrics:getBrokers', clusterId),
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
})

// 全局类型声明

declare global {
  interface Window {
    electronAPI: {
      cluster: {
        list: () => Promise<APIResponse<ClusterConfig[]>>
        add: (config: ClusterConfigDraft) => Promise<APIResponse<{ id: string }>>
        update: (id: string, config: ClusterConfigDraft) => Promise<APIResponse<void>>
        delete: (id: string) => Promise<APIResponse<void>>
        testConnection: (config: ClusterConfigDraft) => Promise<APIResponse<{ connected: boolean; version?: string }>>

      }
      resources: {
        getTenants: (clusterId: string) => Promise<APIResponse<Tenant[]>>
        getNamespaces: (clusterId: string, tenant: string) => Promise<APIResponse<string[]>>
        getTopics: (clusterId: string, tenant: string, namespace: string) => Promise<APIResponse<Topic[]>>
        getTopicStats: (clusterId: string, tenant: string, namespace: string, topic: string, persistent?: boolean) => Promise<APIResponse<TopicStats>>
        getTopicConfig: (clusterId: string, tenant: string, namespace: string, topic: string, persistent?: boolean) => Promise<APIResponse<any>>
        updateTopicConfig: (clusterId: string, tenant: string, namespace: string, topic: string, config: any, persistent?: boolean) => Promise<APIResponse<void>>
        getSubscriptions: (clusterId: string, tenant: string, namespace: string, topic: string) => Promise<APIResponse<string[]>>
        getTenantInfo: (clusterId: string, tenant: string) => Promise<APIResponse<{ adminRoles: string[]; allowedClusters: string[] }>>
        getNamespaceInfo: (clusterId: string, tenant: string, namespace: string) => Promise<APIResponse<{ replicationClusters: string[]; clusters: string[] }>>
        createSubscription: (clusterId: string, tenant: string, namespace: string, topic: string, name: string, type: string) => Promise<APIResponse<void>>
        deleteSubscription: (clusterId: string, tenant: string, namespace: string, topic: string, name: string) => Promise<APIResponse<void>>
        resetCursor: (clusterId: string, tenant: string, namespace: string, topic: string, subscription: string, position: 'earliest' | 'latest' | 'timestamp', timestamp?: number) => Promise<APIResponse<void>>
        skipMessages: (clusterId: string, tenant: string, namespace: string, topic: string, subscription: string, count: number) => Promise<APIResponse<void>>
        deleteTopic: (clusterId: string, tenant: string, namespace: string, topic: string) => Promise<APIResponse<void>>
      }
      messages: {
        browse: (params: MessageBrowseParams) => Promise<APIResponse<Message[]>>
        send: (params: MessageSendParams) => Promise<APIResponse<void>>
      }
      metrics: {
        query: (clusterId: string, query: string, range: TimeRange) => Promise<APIResponse<MetricData[]>>
        getAggregatedStats: (clusterId: string) => Promise<APIResponse<AggregatedStats>>
        getBrokers: (clusterId: string) => Promise<APIResponse<BrokerInfo>>
        getNamespaceStats: (clusterId: string, tenant: string, namespace: string) => Promise<APIResponse<NamespaceStats>>
      }
      topology: {
        getClusterTopology: (clusterId: string, limits?: TopologyLimits) => Promise<APIResponse<ClusterTopology>>

      }
      ssh: {
        list: () => Promise<APIResponse<SSHTunnel[]>>
        connect: (config: SSHConfig) => Promise<APIResponse<{ tunnelId: string; localPort: number; localBrokerPort: number }>>
        disconnect: (tunnelId: string) => Promise<APIResponse<void>>
      }
      theme: {
        set: (theme: string) => Promise<APIResponse<void>>
        get: () => Promise<APIResponse<string>>
      }
      settings: {
        get: (key: string) => Promise<APIResponse<string | undefined>>
        set: (key: string, value: string) => Promise<APIResponse<void>>
      }
      logs: {
        getRecent: (limit?: number) => Promise<APIResponse<OperationLog[]>>
      }
      system: {
        checkUpdate: () => Promise<APIResponse<{ currentVersion: string; latestVersion: string; hasUpdate: boolean }>>
      }
    }
  }
}

export {}

