// 渲染层类型入口：跨进程共享的领域类型统一从 src/shared/types 转出，
// 这里只保留渲染层独有的视图类型。
export type {
    APIResponse,
    ClusterConfig,
    ClusterConfigDraft,
    SSHConfig,
    SSHTunnel,
    Tenant,
    Namespace,
    Topic,
    TopicStats,
    SubscriptionStats,
    ProducerStats,
    ConsumerStats,
    BrokerInfo,
    AggregatedStats,
    NamespaceStats,
    Message,
    MessageBrowseParams,
    MessageSendParams,
    MetricData,
    TimeRange,
    TopologyLimits,
    ClusterTopology,
    OperationLog,
} from '../../shared/types';

// 订阅
export interface Subscription {
    name: string;
    msgBacklog: number;
    consumers: Consumer[];
    type: 'Exclusive' | 'Failover' | 'Shared' | 'Key_Shared';
}

export interface Consumer {
    consumerName: string;
    availablePermits: number;
    connectedSince: string;
}

// 资源树节点
export interface ResourceTreeNode {
    key: string;
    title: string;
    type: 'cluster' | 'tenant' | 'namespace' | 'topic' | 'subscription';
    status?: 'connected' | 'disconnected' | 'warning';
    children?: ResourceTreeNode[];
    isLeaf?: boolean;
    clusterId?: string;
    tenant?: string;
    namespace?: string;
    topic?: string;
}
