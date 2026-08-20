import {AxiosInstance} from 'axios';
import {Semaphore, withRetry, withSemaphore, seg} from './http-client';
import {AGGREGATION_LIMITS} from '../config/constants';
import type {BrokerStats, TopicStats} from './http-client';
import type {TopologyLimits} from '../../shared/types';
import type {ResourceAPI} from './resource-api';

// ========== Metrics & Topology API ==========

// 将调用方传入的上限收敛到 [1, fallback] 区间；未传或非法时用全局上限。
function clampLimit(value: number | undefined, fallback: number): number {
    if (!value || value <= 0) {
        return fallback;
    }
    return Math.min(value, fallback);
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

    // 聚合任务限流：不得在其中再获取 this.semaphore 的许可
    private async enqueueAggregate<T>(fn: () => Promise<T>): Promise<T> {
        return withSemaphore(this.aggregateSemaphore, fn);
    }

    // ========== Broker 相关 ==========

    // 获取 Broker 运行信息
    async getBrokers(): Promise<{activeBrokers: string[]; allBrokers: string[]}> {
        return this.enqueue(async () => {
            try {
                // 获取活跃的 Broker
                const activeResponse = await withRetry(() => this.http.get('/admin/v2/brokers'));
                const activeBrokers = activeResponse.data || [];

                // 尝试获取所有 Broker（如果有这个 API）
                let allBrokers = activeBrokers;
                try {
                    const allResponse = await this.http.get('/admin/v2/brokers/all');
                    allBrokers = allResponse.data || activeBrokers;
                } catch {
                    // 某些版本可能不支持 /brokers/all
                    console.log('[PulsarAdmin] /brokers/all not available');
                }

                return {activeBrokers, allBrokers};
            } catch (error) {
                console.error('[PulsarAdmin] getBrokers error:', error);
                return {activeBrokers: [], allBrokers: []};
            }
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
            } catch (error) {
                console.error('[PulsarAdmin] getBrokerStats error:', error);
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
                                        return await this.resourceAPI.getTopicStats(tenant.name, namespace, topic.name);
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

                        if (topicStats.numPartitions > 0) {
                            stats.totalPartitions += topicStats.numPartitions;
                        }
                    }
                }
            } catch (error) {
                console.error('[PulsarAdmin] getAggregatedStats error:', error);
            }

            return stats;
        });
    }

    // 获取命名空间级别的聚合统计
    async getNamespaceStats(
        tenant: string,
        namespace: string,
    ): Promise<{
        topicCount: number;
        subscriptionCount: number;
        producerCount: number;
        consumerCount: number;
        totalMsgRateIn: number;
        totalMsgRateOut: number;
        totalThroughputIn: number;
        totalThroughputOut: number;
        totalBacklog: number;
    }> {
        return this.enqueueAggregate(async () => {
            const stats = {
                topicCount: 0,
                subscriptionCount: 0,
                producerCount: 0,
                consumerCount: 0,
                totalMsgRateIn: 0,
                totalMsgRateOut: 0,
                totalThroughputIn: 0,
                totalThroughputOut: 0,
                totalBacklog: 0,
            };

            try {
                const allTopics = await this.resourceAPI.getTopics(tenant, namespace);
                stats.topicCount = allTopics.length;
                const topics = allTopics.slice(0, AGGREGATION_LIMITS.MAX_TOPICS_PER_NAMESPACE);

                for (const topic of topics) {
                    try {
                        const topicStats = await this.resourceAPI.getTopicStats(tenant, namespace, topic.name);

                        stats.subscriptionCount += Object.keys(topicStats.subscriptions || {}).length;
                        stats.producerCount += topicStats.producers?.length || 0;
                        stats.consumerCount += topicStats.consumers?.length || 0;
                        stats.totalMsgRateIn += topicStats.msgRateIn || 0;
                        stats.totalMsgRateOut += topicStats.msgRateOut || 0;
                        stats.totalThroughputIn += topicStats.msgThroughputIn || 0;
                        stats.totalThroughputOut += topicStats.msgThroughputOut || 0;

                        if (topicStats.subscriptions) {
                            Object.values(topicStats.subscriptions).forEach((sub: any) => {
                                stats.totalBacklog += sub.msgBacklog || 0;
                            });
                        }
                    } catch {
                        // 忽略单个 Topic 错误
                    }
                }
            } catch (error) {
                console.error('[PulsarAdmin] getNamespaceStats error:', error);
            }

            return stats;
        });
    }

    // ========== 拓扑相关 ==========

    // 获取完整的拓扑结构
    // limits 允许调用方（如首页概览）把规模上限下推到聚合过程，避免只为展示少量节点而遍历整个集群。
    // 传入值只能收紧、不能放宽全局上限。
    async getClusterTopology(limits?: TopologyLimits): Promise<{
        brokers: Array<{name: string; topics: string[]; stats?: any}>;
        topics: Array<{
            name: string;
            tenant: string;
            namespace: string;
            partitions: number;
            subscriptions: string[];
            producers: number;
            consumers: number;
            msgRateIn: number;
            msgRateOut: number;
            backlogSize: number;
        }>;
    }> {
        const maxTenants = clampLimit(limits?.maxTenants, AGGREGATION_LIMITS.MAX_TENANTS);
        const maxNamespaces = clampLimit(limits?.maxNamespacesPerTenant, AGGREGATION_LIMITS.MAX_NAMESPACES_PER_TENANT);
        const maxTopicsPerNamespace = clampLimit(
            limits?.maxTopicsPerNamespace,
            AGGREGATION_LIMITS.MAX_TOPICS_PER_NAMESPACE,
        );
        const maxTopics = limits?.maxTopics && limits.maxTopics > 0 ? limits.maxTopics : undefined;

        return this.enqueueAggregate(async () => {
            const result = {
                brokers: [] as any[],
                topics: [] as any[],
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

                                const topicStatsPromises = topics.map(async topic => {
                                    try {
                                        const topicStats = await this.resourceAPI.getTopicStats(
                                            tenant.name,
                                            namespace,
                                            topic.name,
                                        );
                                        const subscriptions = Object.keys(topicStats.subscriptions || {});

                                        return {
                                            name: topic.name,
                                            tenant: tenant.name,
                                            namespace,
                                            partitions: topicStats.numPartitions || 0,
                                            subscriptions,
                                            producers: topicStats.producers?.length || 0,
                                            consumers: topicStats.consumers?.length || 0,
                                            msgRateIn: topicStats.msgRateIn || 0,
                                            msgRateOut: topicStats.msgRateOut || 0,
                                            backlogSize: topicStats.backlogSize || 0,
                                        };
                                    } catch {
                                        return null;
                                    }
                                });

                                return await Promise.all(topicStatsPromises);
                            } catch {
                                return [] as any[];
                            }
                        });

                        const namespaceTopics = await Promise.all(namespaceTopicPromises);
                        return namespaceTopics.flat().filter(Boolean);
                    } catch {
                        return [] as any[];
                    }
                });

                const allTopics = await Promise.all(tenantTopicPromises);
                const flattenedTopics = maxTopics ? allTopics.flat().slice(0, maxTopics) : allTopics.flat();

                result.topics = flattenedTopics;

                flattenedTopics.forEach(topic => {
                    const topicPath = `${topic.tenant}/${topic.namespace}/${topic.name}`;
                    result.brokers.forEach(broker => {
                        broker.topics.push(topicPath);
                    });
                });
            } catch (error) {
                console.error('[PulsarAdmin] getClusterTopology error:', error);
            }

            return result;
        });
    }

    // 查询 metrics 指标
    async getMetrics(query: string, range?: {start: number; end: number}): Promise<any> {
        return this.enqueue(async () => {
            try {
                const params: Record<string, any> = {};
                if (range) {
                    params.start = range.start;
                    params.end = range.end;
                }

                const response = await this.http.get('/admin/v2/metrics/query', {
                    params: {
                        query,
                        ...params,
                    },
                });

                return response.data;
            } catch (error) {
                console.error('[PulsarAdmin] getMetrics error:', error);
                return [];
            }
        });
    }

    // 获取 Topic 的订阅者分布
    async getTopicSubscriptions(
        tenant: string,
        namespace: string,
        topic: string,
    ): Promise<
        {
            name: string;
            type: string;
            msgBacklog: number;
            consumers: number;
        }[]
    > {
        return this.enqueue(async () => {
            try {
                const subscriptions = await this.http.get(
                    `/admin/v2/persistent/${seg(tenant)}/${seg(namespace)}/${seg(topic)}/subscriptions`,
                );

                const result = [];
                for (const subName of (subscriptions.data as string[]) || []) {
                    try {
                        const stats = await this.http.get(
                            `/admin/v2/persistent/${seg(tenant)}/${seg(namespace)}/${seg(topic)}/subscription/${seg(subName)}/stats`,
                        );
                        result.push({
                            name: subName,
                            type: stats.data?.type || 'unknown',
                            msgBacklog: stats.data?.msgBacklog || 0,
                            consumers: stats.data?.consumers?.length || 0,
                        });
                    } catch {
                        result.push({
                            name: subName,
                            type: 'unknown',
                            msgBacklog: 0,
                            consumers: 0,
                        });
                    }
                }

                return result;
            } catch (error) {
                console.error('[PulsarAdmin] getTopicSubscriptions error:', error);
                return [];
            }
        });
    }
}
