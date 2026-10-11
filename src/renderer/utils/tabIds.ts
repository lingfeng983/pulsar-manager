import type {TabItem} from '../store/tabs';

/**
 * 页签身份的唯一来源。
 *
 * 页签 id 就是"这个资源是否已经打开过"的判据：同一个 Topic 从资源树、搜索结果、
 * 集群拓扑点进来，必须命中同一个页签，否则用户会看到两个内容一样的页签、以及
 * 删掉一个之后另一个还挂着死链接。所有拼装都收敛在这里，别再各处手写模板串。
 */

export interface TopicTabRef {
    clusterId: string;
    tenant: string;
    namespace: string;
    topic: string;
    persistent?: boolean;
}

// persistent 必须进 id：同名 Topic 可以同时存在于 persistent 与 non-persistent 命名空间
// （例如 public/default/t1 与 non-persistent://public/default/t1），只按名字区分会撞车。
export const topicTabId = ({clusterId, tenant, namespace, topic, persistent}: TopicTabRef): string =>
    `topic-${clusterId}-${tenant}-${namespace}-${persistent === false ? 'non-persistent' : 'persistent'}-${topic}`;

export const topicTab = (ref: TopicTabRef): TabItem => ({
    id: topicTabId(ref),
    title: ref.topic,
    type: 'topic',
    data: {...ref, persistent: ref.persistent !== false},
});

export const namespaceTabId = (clusterId: string, tenant: string, namespace: string): string =>
    `ns-${clusterId}-${tenant}-${namespace}`;

export const namespaceTab = (clusterId: string, tenant: string, namespace: string): TabItem => ({
    id: namespaceTabId(clusterId, tenant, namespace),
    title: `${tenant} / ${namespace}`,
    type: 'namespace',
    data: {clusterId, tenant, namespace},
});

export const tenantTabId = (clusterId: string, tenant: string): string => `tenant-${clusterId}-${tenant}`;

export const tenantTab = (clusterId: string, tenant: string): TabItem => ({
    id: tenantTabId(clusterId, tenant),
    title: tenant,
    type: 'tenant',
    data: {clusterId, tenant},
});

export const topologyTabId = (clusterId: string): string => `topology-${clusterId}`;

export const topologyTab = (clusterId: string, clusterName?: string): TabItem => ({
    id: topologyTabId(clusterId),
    title: `${clusterName || '集群'}拓扑`,
    type: 'topology',
    data: {clusterId},
});

// 不带 clusterId 的是资源树工具栏里的"全局监控"（跨集群自动选一个），带上则是某个集群的监控页签。
export const metricsTabId = (clusterId?: string): string => (clusterId ? `metrics-${clusterId}` : 'metrics');

export const metricsTab = (clusterId?: string, clusterName?: string): TabItem => ({
    id: metricsTabId(clusterId),
    title: clusterId ? `${clusterName || '集群'}监控` : '监控仪表盘',
    type: 'metrics',
    data: clusterId ? {clusterId} : undefined,
});
