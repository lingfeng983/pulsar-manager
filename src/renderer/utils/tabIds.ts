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

// 标题也要带区分：两个同名 topic 的页签并排时只写着 t1 和 t1，点开之前根本分不出
// 哪个是非持久化那条（id 已经区分了，但 id 不显示给用户）。
const topicTitle = ({topic, persistent}: TopicTabRef): string => (persistent === false ? `${topic}（非持久）` : topic);

export const topicTab = (ref: TopicTabRef): TabItem => ({
    id: topicTabId(ref),
    title: topicTitle(ref),
    type: 'topic',
    data: {...ref, persistent: ref.persistent !== false},
});

// 生产者工作台与 Topic 详情分成两个页签（id 前缀不同但都从 topicTabId 派生）：
// 详情里的轻量发送不留连接，工作台挂的是常驻 producer，同一个页签里用户会分不清
// 关掉这个标签到底断没断掉那条 producer。
// 工作台允许对同一条 topic 多开：base id 只用来认归属（集群/topic），tabs.addTab
// 看到 MULTI_INSTANCE_TYPES 会给每个实例发一个带序号的独立 id。
export const producerTab = (ref: TopicTabRef): TabItem => ({
    id: `producer-${topicTabId(ref)}`,
    title: `${topicTitle(ref)} 生产`,
    type: 'producer',
    data: {...ref, persistent: ref.persistent !== false},
});

// 消费者工作台同样独立成页签：一条 topic 上常常要一边看着订阅收消息、
// 一边在详情里翻订阅列表，两个方向各自留一个页签比挤在一页里清楚。多开规则同生产者。
export const consumerTab = (ref: TopicTabRef): TabItem => ({
    id: `consumer-${topicTabId(ref)}`,
    title: `${topicTitle(ref)} 消费`,
    type: 'consumer',
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

// 不带 clusterId 的是资源树工具栏/首页入口的"全局拓扑"（多集群同屏），
// 带上则是某个集群的单簇拓扑页签（集群气泡下钻、资源树右键进来的都是它）。
export const topologyTabId = (clusterId?: string): string => (clusterId ? `topology-${clusterId}` : 'topology');

export const topologyTab = (clusterId?: string, clusterName?: string): TabItem => ({
    id: topologyTabId(clusterId),
    title: clusterId ? `${clusterName || '集群'}拓扑` : '集群拓扑',
    type: 'topology',
    data: clusterId ? {clusterId} : undefined,
});

// 不带 clusterId 的是资源树工具栏里的"全局监控"（跨集群自动选一个），带上则是某个集群的监控页签。
export const metricsTabId = (clusterId?: string): string => (clusterId ? `metrics-${clusterId}` : 'metrics');

export const metricsTab = (clusterId?: string, clusterName?: string): TabItem => ({
    id: metricsTabId(clusterId),
    title: clusterId ? `${clusterName || '集群'}监控` : '监控仪表盘',
    type: 'metrics',
    data: clusterId ? {clusterId} : undefined,
});

// 告警中心是全局单页：规则本来就跨集群列一张表，按集群过滤在页内做，
// 所以不给每个集群开一个页签（那样徽标与"未恢复"总数就没有落脚点了）。
export const alertTab = (): TabItem => ({id: 'alerts', title: '告警中心', type: 'alerts'});

// 文档中心同样是全局单页，而且和集群无关：内容是随应用打包的 8 篇 Pulsar 文档，
// 按集群开页签只会得到 8 个一模一样的页面。
export const docCenterTab = (): TabItem => ({id: 'docs', title: '文档中心', type: 'docs'});

// 函数与连接器按集群各开一页：worker 是每套部署自己的东西，
// 在 A 集群列出的函数不可能出现在 B 集群的表里，合并成一张表只会让人误读归属。
export const workerTabId = (clusterId?: string): string => (clusterId ? `worker-${clusterId}` : 'worker');

export const workerTab = (clusterId?: string, clusterName?: string): TabItem => ({
    id: workerTabId(clusterId),
    title: clusterId ? `${clusterName || '集群'}函数与连接器` : '函数与连接器',
    type: 'worker',
    data: clusterId ? {clusterId} : undefined,
});

// 巡检按集群各开一页：报告是「某个集群在某一时刻的快照」，
// 两个集群的结果挤进同一个页签，导出的 Markdown 会说不清自己属于谁。
export const inspectionTabId = (clusterId?: string): string => (clusterId ? `inspection-${clusterId}` : 'inspection');

export const inspectionTab = (clusterId?: string, clusterName?: string): TabItem => ({
    id: inspectionTabId(clusterId),
    title: clusterId ? `${clusterName || '集群'}巡检` : '集群巡检',
    type: 'inspection',
    data: clusterId ? {clusterId} : undefined,
});

// 跨集群汇总与告警中心、文档中心同样是全局单页：它说的就是「所有集群摆在一起」，
// 按集群各开一页会得到 N 份一模一样的表。
export const fleetInspectionTab = (): TabItem => ({
    id: 'fleet-inspection',
    title: '巡检汇总',
    type: 'fleet-inspection',
});
