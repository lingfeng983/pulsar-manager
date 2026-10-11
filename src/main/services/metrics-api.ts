import {AxiosInstance} from 'axios';
import {Semaphore, withRetry, withSemaphore, seg} from './http-client';
import {AGGREGATION_LIMITS, REQUEST_CONFIG} from '../config/constants';
import type {BrokerStats, TopicStats} from './http-client';
import type {ClusterTopology, Topic, TopologyLimits} from '../../shared/types';
import type {ResourceAPI} from './resource-api';

// ========== Metrics & Topology API ==========

// 将调用方传入的上限收敛到 [1, globalMax] 区间。
// 第二个参数既是"未传/非法时的默认值"，也是"调用方不得突破的硬上限"——
// 调用方只能把范围收得更窄，不能放得更宽。
function clampLimit(value: number | undefined, globalMax: number): number {
    if (!value || value <= 0) {
        return globalMax;
    }
    return Math.min(Math.floor(value), globalMax);
}

// ownerBroker 与 /brokers 列出的标识可能一个带端口一个不带；对不上就不连线，
// 不做"看起来差不多算它归属"的猜测。
function brokerMatches(listed: string, owner: string): boolean {
    if (listed === owner) {
        return true;
    }
    const cut = (v: string) => {
        const idx = v.lastIndexOf(':');
        return idx > 0 ? v.slice(0, idx) : v;
    };
    return cut(listed) === cut(owner);
}

/**
 * 由各 topic 的 ownerBrokers 反向聚合出 brokers[].topics。
 * 归属来源不可得时绝不编造映射：单 broker 集群下所有 topic 必然落在它上面，
 * 这是事实而非猜测，标成 singleBroker 并回填 ownerBrokers；
 * 多 broker 且无归属信息则标成 none，让渲染层明确降级。
 */
function assignTopicOwnership(topology: ClusterTopology): void {
    const hasOwner = topology.topics.some(topic => topic.ownerBrokers.length > 0);

    if (!hasOwner) {
        if (topology.brokers.length !== 1) {
            topology.ownershipSource = 'none';
            return;
        }
        const only = topology.brokers[0].name;
        topology.topics.forEach(topic => {
            topic.ownerBrokers = [only];
        });
        topology.ownershipSource = 'singleBroker';
    } else {
        topology.ownershipSource = 'brokerStats';
    }

    for (const topic of topology.topics) {
        const resolved: string[] = [];
        for (const owner of topic.ownerBrokers) {
            const broker = topology.brokers.find(b => brokerMatches(b.name, owner));
            if (!broker) {
                continue;
            }
            // 统一成 /brokers 列出的写法，渲染层按名字匹配节点即可对上，
            // 不必再处理 `host` 与 `host:port` 的差异
            if (!resolved.includes(broker.name)) {
                resolved.push(broker.name);
            }
            if (!broker.topics.includes(topic.name)) {
                broker.topics.push(topic.name);
            }
        }
        topic.ownerBrokers = resolved;
    }
}

export class MetricsAPI {
    constructor(
        private http: AxiosInstance,
        private semaphore: Semaphore,
        private resourceAPI: ResourceAPI,
        // 聚合任务使用独立信号量：聚合方法会调用 resourceAPI 的限流方法，
        // 若共用同一信号量，外层持有许可等待内层获取许可即会死锁。
        private aggregateSemaphore: Semaphore,
    ) {}

    // 叶子请求限流：仅包裹真正发起 HTTP 的调用
    private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
        return withSemaphore(this.semaphore, fn);
    }

    // 聚合任务限流：不得在其中再获取 this.semaphore 的许可。
    // 聚合本身可能跑几十秒，排队时用叶子请求的 30s 上限会误报超时，改用更宽的上限。
    private async enqueueAggregate<T>(fn: () => Promise<T>): Promise<T> {
        return withSemaphore(this.aggregateSemaphore, fn, REQUEST_CONFIG.ACQUIRE_TIMEOUT_AGGREGATE);
    }

    // ========== Broker 相关 ==========

    // 获取 Broker 运行信息
    async getBrokers(): Promise<{activeBrokers: string[]; allBrokers: string[]}> {
        return this.enqueue(async () => {
            // broker 不可达必须向上抛：连接状态判定依赖这条链路，
            // 静默返回空列表会把不可达的集群显示成"在线"。
            const activeResponse = await withRetry(() => this.http.get('/admin/v2/brokers'));
            const activeBrokers = activeResponse.data || [];

            let allBrokers = activeBrokers;
            try {
                const allResponse = await this.http.get('/admin/v2/brokers/all');
                allBrokers = allResponse.data || activeBrokers;
            } catch {
                // 部分版本不支持 /brokers/all，退回活跃列表
            }

            return {activeBrokers, allBrokers};
        });
    }

    // 获取 Broker 负载信息
    async getBrokerStats(broker: string): Promise<BrokerStats | null> {
        return this.enqueue(async () => {
            try {
                const response = await withRetry(() => this.http.get(`/admin/v2/broker-stats/${seg(broker)}`));

                // 解析响应数据为 BrokerStats 类型
                const data = response.data || {};
                return {
                    brokerId: broker,
                    brokerName: broker,
                    connected: true,
                    msgRateIn: data.msgRateIn || 0,
                    msgRateOut: data.msgRateOut || 0,
                    msgThroughputIn: data.msgThroughputIn || 0,
                    msgThroughputOut: data.msgThroughputOut || 0,
                    topicsCount: data.topicsCount || 0,
                    partitionsCount: data.partitionsCount || 0,
                    cpuUsage: data.loadReport?.cpuUsage || 0,
                    memoryUsage: data.loadReport?.memoryUsage || 0,
                    directMemoryUsage: data.loadReport?.directMemoryUsage || 0,
                    bandwidthIn: data.loadReport?.bandwidthIn || 0,
                    bandwidthOut: data.loadReport?.bandwidthOut || 0,
                    lastUpdateTimestamp: data.lastUpdateTimestamp || Date.now(),
                    loadReport: data.loadReport,
                };
            } catch {
                // 单个 broker 的负载读不到返回 null，由界面显示为离线；
                // 这是降级不是故障，轮询场景下不打印堆栈。
                return null;
            }
        });
    }

    // ========== 聚合统计 ==========

    // 获取聚合统计信息
    async getAggregatedStats(): Promise<{
        totalTopics: number;
        totalPartitions: number;
        totalSubscriptions: number;
        totalProducers: number;
        totalConsumers: number;
        totalMsgRateIn: number;
        totalMsgRateOut: number;
        totalThroughputIn: number;
        totalThroughputOut: number;
        totalBacklog: number;
    }> {
        return this.enqueueAggregate(async () => {
            const stats = {
                totalTopics: 0,
                totalPartitions: 0,
                totalSubscriptions: 0,
                totalProducers: 0,
                totalConsumers: 0,
                totalMsgRateIn: 0,
                totalMsgRateOut: 0,
                totalThroughputIn: 0,
                totalThroughputOut: 0,
                totalBacklog: 0,
            };

            try {
                const tenants = (await this.resourceAPI.getTenants()).slice(0, AGGREGATION_LIMITS.MAX_TENANTS);

                const tenantStatsPromises = tenants.map(async tenant => {
                    try {
                        const namespaces = (await this.resourceAPI.getNamespaces(tenant.name)).slice(
                            0,
                            AGGREGATION_LIMITS.MAX_NAMESPACES_PER_TENANT,
                        );

                        const namespaceStatsPromises = namespaces.map(async namespace => {
                            try {
                                const topics = (await this.resourceAPI.getTopics(tenant.name, namespace)).slice(
                                    0,
                                    AGGREGATION_LIMITS.MAX_TOPICS_PER_NAMESPACE,
                                );

                                const topicStatsPromises = topics.map(async topic => {
                                    try {
                                        return await this.resourceAPI.getTopicStats(
                                            tenant.name,
                                            namespace,
                                            topic.name,
                                            topic.persistent,
                                        );
                                    } catch {
                                        return null;
                                    }
                                });

                                const topicStatsResults = await Promise.all(topicStatsPromises);

                                return {
                                    topicCount: topics.length,
                                    topicStats: topicStatsResults.filter(Boolean) as TopicStats[],
                                };
                            } catch {
                                return {topicCount: 0, topicStats: []};
                            }
                        });

                        const namespaceStatsResults = await Promise.all(namespaceStatsPromises);

                        return namespaceStatsResults.reduce(
                            (acc, ns) => ({
                                topicCount: acc.topicCount + ns.topicCount,
                                topicStats: [...acc.topicStats, ...ns.topicStats],
                            }),
                            {topicCount: 0, topicStats: [] as TopicStats[]},
                        );
                    } catch {
                        return {topicCount: 0, topicStats: [] as TopicStats[]};
                    }
                });

                const tenantStatsResults = await Promise.all(tenantStatsPromises);

                for (const tenantResult of tenantStatsResults) {
                    stats.totalTopics += tenantResult.topicCount;

                    for (const topicStats of tenantResult.topicStats) {
                        stats.totalSubscriptions += Object.keys(topicStats.subscriptions || {}).length;
                        stats.totalProducers += topicStats.producers?.length || 0;
                        stats.totalConsumers += topicStats.consumers?.length || 0;
                        stats.totalMsgRateIn += topicStats.msgRateIn || 0;
                        stats.totalMsgRateOut += topicStats.msgRateOut || 0;
                        stats.totalThroughputIn += topicStats.msgThroughputIn || 0;
                        stats.totalThroughputOut += topicStats.msgThroughputOut || 0;

                        if (topicStats.subscriptions) {
                            Object.values(topicStats.subscriptions).forEach((sub: any) => {
                                stats.totalBacklog += sub.msgBacklog || 0;
                            });
                        }

                        // 归一化后的 TopicStats 直接带分区 URI 列表，长度即分区数
                        const partitions = topicStats.partitions?.length || 0;
                        if (partitions > 0) {
                            stats.totalPartitions += partitions;
                        }
                    }
                }
            } catch (error) {
                // 租户列表拉不动说明集群不可达；向上抛，连接状态判定依赖这个信号
                throw error instanceof Error ? error : new Error(String(error));
            }

            return stats;
        });
    }

    // ========== 拓扑相关 ==========

    // 获取完整的拓扑结构
    // limits 允许调用方（如首页概览）把规模上限下推到聚合过程，避免只为展示少量节点而遍历整个集群。
    // 传入值只能收紧、不能放宽全局上限。
    async getClusterTopology(limits?: TopologyLimits): Promise<ClusterTopology> {
        const maxTenants = clampLimit(limits?.maxTenants, AGGREGATION_LIMITS.MAX_TENANTS);
        const maxNamespaces = clampLimit(limits?.maxNamespacesPerTenant, AGGREGATION_LIMITS.MAX_NAMESPACES_PER_TENANT);
        const maxTopicsPerNamespace = clampLimit(
            limits?.maxTopicsPerNamespace,
            AGGREGATION_LIMITS.MAX_TOPICS_PER_NAMESPACE,
        );
        const maxTopics = clampLimit(limits?.maxTopics, AGGREGATION_LIMITS.MAX_TOPICS);

        return this.enqueueAggregate(async () => {
            const result: ClusterTopology = {
                brokers: [],
                topics: [],
                ownershipSource: 'none',
            };

            try {
                const {activeBrokers} = await this.getBrokers();

                activeBrokers.forEach(broker => {
                    result.brokers.push({name: broker, topics: []});
                });

                const tenants = (await this.resourceAPI.getTenants()).slice(0, maxTenants);

                const tenantTopicPromises = tenants.map(async tenant => {
                    try {
                        const namespaces = (await this.resourceAPI.getNamespaces(tenant.name)).slice(0, maxNamespaces);

                        const namespaceTopicPromises = namespaces.map(async namespace => {
                            try {
                                const topics = (await this.resourceAPI.getTopics(tenant.name, namespace)).slice(
                                    0,
                                    maxTopicsPerNamespace,
                                );

                                const topicEntriesPromises = topics.map(async topic =>
                                    this.buildTopologyTopic(tenant.name, namespace, topic),
                                );

                                return await Promise.all(topicEntriesPromises);
                            } catch {
                                return [] as ClusterTopology['topics'][number][];
                            }
                        });

                        const namespaceTopics = await Promise.all(namespaceTopicPromises);
                        return namespaceTopics.flat();
                    } catch {
                        return [] as ClusterTopology['topics'][number][];
                    }
                });

                const allTopics = await Promise.all(tenantTopicPromises);
                result.topics = allTopics.flat().slice(0, maxTopics);

                assignTopicOwnership(result);
            } catch (error) {
                // brokers/tenants 任一列不出来即集群不可达，向上抛而不是返回空拓扑
                throw error instanceof Error ? error : new Error(String(error));
            }

            return result;
        });
    }

    // 单个 topic 的拓扑节点：stats 读失败也要保留节点，只丢流量与归属，
    // 否则列表里存在的 topic 在图上会凭空消失，看起来像集群少了一批 topic。
    private async buildTopologyTopic(
        tenant: string,
        namespace: string,
        topic: Topic,
    ): Promise<ClusterTopology['topics'][number]> {
        const base = {
            name: topic.name,
            tenant,
            namespace,
            persistent: topic.persistent,
            partitionNames: topic.partitions,
            ownerBrokers: [] as string[],
            subscriptions: [] as string[],
            producers: 0,
            consumers: 0,
            msgRateIn: 0,
            msgRateOut: 0,
            backlogSize: 0,
        };

        try {
            const stats = await this.resourceAPI.getTopicStats(tenant, namespace, topic.name, topic.persistent);
            return {
                ...base,
                partitionNames: stats.partitions?.length ? stats.partitions : topic.partitions,
                ownerBrokers: stats.ownerBrokers || [],
                subscriptions: Object.keys(stats.subscriptions || {}),
                producers: stats.producers?.length || 0,
                consumers: stats.consumers?.length || 0,
                msgRateIn: stats.msgRateIn || 0,
                msgRateOut: stats.msgRateOut || 0,
                backlogSize: stats.backlogSize || 0,
            };
        } catch {
            return base;
        }
    }
}
