import {AxiosInstance} from 'axios';
import {
    Semaphore,
    withRetry,
    withSemaphore,
    orNotFound,
    seg,
    mapWithConcurrency,
    NotFoundError,
    isHttpMethodRejected,
} from './http-client';
import {API_ENDPOINTS, REQUEST_CONFIG} from '../config/constants';
import type {BrokerSchemaInfo} from '../../shared/types';
import type {
    ClusterInfo,
    Tenant,
    Topic,
    TopicStats,
    TopicConfig,
    TopicConfigPatch,
    SubscriptionStats,
    ProducerStats,
    ConsumerStats,
} from './http-client';

// ========== Topic 路径 ==========

/**
 * 持久与非持久 Topic 在 Admin API 中是两段不同的路径前缀。
 * 把 `persistent` 写死会让非持久 Topic 的管理操作全部落到不存在的资源上，
 * 且 broker 返回的是 404 而不是"不支持"，看起来像 topic 不见了。
 */
function topicSegment(persistent: boolean): string {
    return persistent ? 'persistent' : 'non-persistent';
}

function topicPath(tenant: string, namespace: string, topic: string, persistent: boolean): string {
    return `/admin/v2/${topicSegment(persistent)}/${seg(tenant)}/${seg(namespace)}/${seg(topic)}`;
}

function subscriptionPath(
    tenant: string,
    namespace: string,
    topic: string,
    subscription: string,
    persistent: boolean,
): string {
    return `${topicPath(tenant, namespace, topic, persistent)}/subscription/${seg(subscription)}`;
}

/**
 * 列表接口返回的 name 已经是 `tenant/ns/topic` 完整形态（scheme 被剥掉），
 * 再拼一次前缀会得到 `tenant/ns/tenant/ns/topic`。这里统一收口。
 */
function shortTopicName(topic: string): string {
    if (!topic.includes('/')) {
        return topic;
    }
    const parts = topic.split('/');
    return parts.length >= 3 ? parts[parts.length - 1] : topic;
}

function partitionIndexOf(topicUri: string): number {
    const match = topicUri.match(/-partition-(\d+)$/);
    return match ? Number(match[1]) : -1;
}

/**
 * 把 Admin API 返回的 topic URI 列表折叠成 Topic 条目：
 * 分区行（`...-partition-N`）并回基名，分区 URI 按序号升序排列
 * （字符串序在 10 个分区以上会乱成 -1, -10, -11, -2）。
 */
function collapseTopicUris(topicUris: string[]): Topic[] {
    const byName = new Map<string, Topic>();

    for (const topicUri of topicUris) {
        const fullName = topicUri.split('://').pop() || '';
        const persistent = topicUri.startsWith('persistent://');
        const partition = fullName.match(/^(.*)-partition-(\d+)$/);
        // 去重键必须带 scheme：persistent 与 non-persistent 同名是两个不同资源，
        // 只用 fullName 会让非持久那条被先入的持久条目吃掉。
        const scope = `${persistent ? 'persistent' : 'non-persistent'}://`;

        if (!partition) {
            const key = `${scope}${fullName}`;
            if (!byName.has(key)) {
                byName.set(key, {name: fullName, persistent, topicUri: fullName, partitions: []});
            }
            continue;
        }

        const baseName = partition[1];
        const key = `${scope}${baseName}`;
        let entry = byName.get(key);
        if (!entry) {
            entry = {name: baseName, persistent, topicUri: baseName, partitions: []};
            byName.set(key, entry);
        }
        entry.partitions.push(topicUri);
    }

    for (const entry of byName.values()) {
        entry.partitions.sort((a, b) => partitionIndexOf(a) - partitionIndexOf(b));
    }

    return [...byName.values()];
}

// 实测本 broker 只有这三个策略存在 topic 级写入口，其余只能在命名空间级别设置。
const WRITABLE_TOPIC_CONFIG_KEYS: (keyof TopicConfigPatch)[] = [
    'retentionTimeInMinutes',
    'retentionSizeInMB',
    'numPartitions',
];

// 创建与更新共用同一个请求体形状，只有动词不同。
function tenantPolicy(config: Partial<Tenant>): {adminRoles: string[]; allowedClusters: string[]} {
    return {
        adminRoles: config.adminRoles || [],
        allowedClusters: config.allowedClusters || [],
    };
}

/**
 * 解析 /partitions 响应。实测本 broker 返回 `{"partitions":2,"deleted":false}`，
 * 而规范里这个端点返回分区 URI 数组，两种形态都要能落回分区 URI 列表。
 * 只有数量时按 Pulsar 固定的 `-partition-N` 命名规则还原 URI。
 */
function parsePartitionsMeta(
    data: unknown,
    tenant: string,
    namespace: string,
    topic: string,
    persistent: boolean,
): {partitions: string[]; deleted: boolean} {
    const scheme = `${topicSegment(persistent)}://`;
    const baseUri = `${scheme}${tenant}/${namespace}/${topic}`;

    if (Array.isArray(data)) {
        return {partitions: data.map(String), deleted: false};
    }

    const meta = data as {partitions?: unknown; deleted?: unknown} | null;
    if (!meta || typeof meta !== 'object') {
        return {partitions: [], deleted: false};
    }

    const deleted = meta.deleted === true;
    if (Array.isArray(meta.partitions)) {
        return {partitions: meta.partitions.map(String), deleted};
    }
    if (typeof meta.partitions === 'number') {
        return {
            partitions: Array.from({length: meta.partitions}, (_, i) => `${baseUri}-partition-${i}`),
            deleted,
        };
    }
    return {partitions: [], deleted};
}

function numberOrUndefined(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numberOr(value: unknown, fallback: number): number {
    return numberOrUndefined(value) ?? fallback;
}

// ownerBroker 在 stats 顶层（非分区）或每个分区条目里（分区聚合），取并集。
function collectOwnerBrokers(stats: any): string[] {
    const brokers = new Set<string>();
    if (typeof stats?.ownerBroker === 'string' && stats.ownerBroker) {
        brokers.add(stats.ownerBroker);
    }
    for (const partition of Object.values(stats?.partitions || {})) {
        const owner = (partition as any)?.ownerBroker;
        if (typeof owner === 'string' && owner) {
            brokers.add(owner);
        }
    }
    return [...brokers];
}

/**
 * 把 Admin API 的原始 stats 映射成 shared/types 里的 TopicStats。
 * 差异都是实测得到的：生产者叫 publishers 且速率是入向的，消费者挂在各订阅的
 * consumers 数组下，订阅对象没有 name，顶层也没有 name / 分区信息。
 * 不映射的话渲染层拿到的 producers/consumers/consumerCount 永远是空，
 * 页面显示 0，看起来像"集群没有流量"。
 */
function normalizeTopicStats(raw: unknown, base: TopicStats, partitions: string[]): TopicStats {
    const data = (raw && typeof raw === 'object' ? raw : {}) as any;
    const subscriptions: Record<string, SubscriptionStats> = {};
    const consumers: ConsumerStats[] = [];

    for (const [name, rawSub] of Object.entries((data.subscriptions as any) || {})) {
        const sub = rawSub as any;
        const subConsumers = Array.isArray(sub?.consumers) ? sub.consumers : [];
        subscriptions[name] = {
            name,
            msgBacklog: numberOr(sub?.msgBacklog, 0),
            backlogSize: numberOr(sub?.backlogSize, 0),
            msgRateExpired: numberOr(sub?.msgRateExpired, 0),
            consumerCount: subConsumers.length,
            unackedMessages: numberOr(sub?.unackedMessages, 0),
            type: typeof sub?.type === 'string' ? sub.type : 'Unknown',
            blockedSubscriptionOnUnackedMsgs: sub?.blockedSubscriptionOnUnackedMsgs,
            lastExpireTimestamp: numberOrUndefined(sub?.lastExpireTimestamp),
            lastConsumedFlowTimestamp: numberOrUndefined(sub?.lastConsumedFlowTimestamp),
            msgRateOut: numberOrUndefined(sub?.msgRateOut),
            msgThroughputOut: numberOrUndefined(sub?.msgThroughputOut),
            durable: typeof sub?.isDurable === 'boolean' ? sub.isDurable : undefined,
        };
        for (const rawConsumer of subConsumers) {
            consumers.push({
                consumerName: String(rawConsumer?.consumerName ?? ''),
                // 出现在 consumers 里就是已连接的订阅端
                connected: true,
                msgRateOut: numberOr(rawConsumer?.msgRateOut, 0),
                msgThroughputOut: numberOrUndefined(rawConsumer?.msgThroughputOut),
                msgRateRedeliver: numberOrUndefined(rawConsumer?.msgRateRedeliver),
                unackedMessages: numberOr(rawConsumer?.unackedMessages, 0),
                availablePermits: numberOrUndefined(rawConsumer?.availablePermits),
                blockedConsumerOnUnackedMsgs: rawConsumer?.blockedConsumerOnUnackedMsgs,
                address: rawConsumer?.address,
                connectedSince: rawConsumer?.connectedSince,
                clientVersion: rawConsumer?.clientVersion,
                subscription: name,
                // 消费者级 type 优先；有的 broker 只在订阅级报 type，兜底到它
                subscriptionType:
                    typeof rawConsumer?.type === 'string'
                        ? rawConsumer.type
                        : typeof sub?.type === 'string'
                          ? sub.type
                          : undefined,
            });
        }
    }

    const producers: ProducerStats[] = (Array.isArray(data.publishers) ? data.publishers : []).map((raw: any) => ({
        producerId: numberOr(raw?.producerId, 0),
        producerName: String(raw?.producerName ?? ''),
        connected: true,
        msgRateIn: numberOr(raw?.msgRateIn, 0),
        msgThroughputIn: numberOr(raw?.msgThroughputIn, 0),
        avgMsgSize: numberOrUndefined(raw?.averageMsgSize),
        address: raw?.address,
        connectedSince: raw?.connectedSince,
        clientVersion: raw?.clientVersion,
        accessMode: typeof raw?.accessMode === 'string' ? raw.accessMode : undefined,
    }));

    return {
        ...base,
        msgRateIn: numberOr(data.msgRateIn, 0),
        msgRateOut: numberOr(data.msgRateOut, 0),
        msgThroughputIn: numberOr(data.msgThroughputIn, 0),
        msgThroughputOut: numberOr(data.msgThroughputOut, 0),
        storageSize: numberOr(data.storageSize, 0),
        backlogSize: numberOr(data.backlogSize, 0),
        avgMsgSize: numberOrUndefined(data.averageMsgSize),
        producers,
        consumers,
        subscriptions,
        partitions,
        ownerBrokers: collectOwnerBrokers(data),
        deduplicationStatus: typeof data.deduplicationStatus === 'string' ? data.deduplicationStatus : undefined,
        backlogQuotaLimitSize: numberOrUndefined(data.backlogQuotaLimitSize),
        backlogQuotaLimitTime: numberOrUndefined(data.backlogQuotaLimitTime),
    };
}

// ========== Resource API ==========

export class ResourceAPI {
    constructor(
        private http: AxiosInstance,
        private semaphore: Semaphore,
    ) {}

    private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
        return withSemaphore(this.semaphore, fn);
    }

    // ========== 集群操作 ==========

    // 集群名称列表。创建租户时 allowedClusters 必须引用这里的名字，
    // 而不是应用里保存的连接名。
    async getPulsarClusters(): Promise<string[]> {
        return this.enqueue(async () => {
            const response = await withRetry(() => this.http.get('/admin/v2/clusters'));
            return ((response.data as string[]) || []).filter(Boolean);
        });
    }

    // 获取集群信息
    async getClusterInfo(): Promise<ClusterInfo> {
        return this.enqueue(async () => {
            const response = await withRetry(() => this.http.get('/admin/v2/clusters'));
            // clusters API 返回集群名称列表
            const clusters = (response.data as string[]) || [];
            if (clusters.length === 0) {
                throw new Error('No cluster found on the target Pulsar instance');
            }
            const clusterName = clusters[0];
            const info = await this.http.get(`/admin/v2/clusters/${seg(clusterName)}`);
            return {
                name: clusterName,
                serviceUrl: info.data?.serviceUrl,
                brokerServiceUrl: info.data?.brokerServiceUrl,
                version: info.data?.version,
            };
        });
    }

    // ========== 租户操作 ==========

    // 获取所有租户
    async getTenants(): Promise<Tenant[]> {
        return this.enqueue(async () => {
            const response = await withRetry(() => this.http.get('/admin/v2/tenants'));
            const tenants = (response.data as string[]) || [];

            // 逐个取租户详情。外层已持有一个许可、内部不能再 acquire（否则死锁），
            // 但也不能 Promise.all 一次性打出 N 个请求把 broker 压垮，
            // 用一个本地并发窗口兜住扇出规模。
            const tenantInfos = await mapWithConcurrency(tenants, REQUEST_CONFIG.FANOUT_CONCURRENCY, name =>
                this.fetchTenantDetail(name),
            );

            return tenantInfos;
        });
    }

    // 获取单个租户详情（供 getTenants 扇出复用；不额外占用信号量，
    // 因为外层 getTenants 已持有一个许可，这里只做真正的 HTTP 请求）
    private async fetchTenantDetail(name: string): Promise<Tenant> {
        const detail = await this.http.get(`/admin/v2/tenants/${seg(name)}`);
        return {
            name,
            adminRoles: detail.data?.adminRoles || [],
            allowedClusters: detail.data?.allowedClusters || [],
        };
    }

    // 创建租户
    async createTenant(name: string, config: Partial<Tenant>): Promise<void> {
        return this.enqueue(async () => {
            await this.http.put(`/admin/v2/tenants/${seg(name)}`, tenantPolicy(config));
        });
    }

    // 更新租户：实测必须用 POST。PUT 是创建语义，对已存在的租户返回
    // 409 `Tenant already exist`，所以之前"编辑租户"这个操作从来没能成功。
    async updateTenant(name: string, config: Partial<Tenant>): Promise<void> {
        return this.enqueue(async () => {
            await this.http.post(`/admin/v2/tenants/${seg(name)}`, tenantPolicy(config));
        });
    }

    // 删除租户
    async deleteTenant(name: string): Promise<void> {
        return this.enqueue(async () => {
            await this.http.delete(`/admin/v2/tenants/${seg(name)}`);
        });
    }

    // 获取租户信息
    async getTenantInfo(tenant: string): Promise<{adminRoles: string[]; allowedClusters: string[]}> {
        return this.enqueue(async () => {
            const response = await withRetry(() => this.http.get(`/admin/v2/tenants/${seg(tenant)}`));
            return response.data;
        });
    }

    // ========== 命名空间操作 ==========

    // 获取租户下的所有命名空间
    async getNamespaces(tenant: string): Promise<string[]> {
        return this.enqueue(() =>
            orNotFound(async () => {
                const response = await withRetry(() => this.http.get(`/admin/v2/namespaces/${seg(tenant)}`));
                // 响应格式: ["tenant/namespace1", "tenant/namespace2"]
                const namespaces = (response.data as string[]) || [];
                return namespaces.map((ns: string) => {
                    const parts = ns.split('/');
                    return parts.length > 1 ? parts.slice(1).join('/') : ns;
                });
            }, []),
        );
    }

    // 创建命名空间
    async createNamespace(tenant: string, namespace: string): Promise<void> {
        return this.enqueue(async () => {
            await this.http.put(`/admin/v2/namespaces/${seg(tenant)}/${seg(namespace)}`);
        });
    }

    // 删除命名空间
    async deleteNamespace(tenant: string, namespace: string): Promise<void> {
        return this.enqueue(async () => {
            await this.http.delete(`/admin/v2/namespaces/${seg(tenant)}/${seg(namespace)}`);
        });
    }

    // 获取命名空间下的所有 Topic（持久 + 非持久）。
    // 实测两点：
    //  1. `/namespaces/{t}/{ns}/topics` 只列 persistent，非持久必须再问一次
    //     `/non-persistent/{t}/{ns}`，否则非持久 topic 在界面上完全不可见；
    //  2. 分区 topic 按分区逐条列出（...-partition-0 / -1 / ...），
    //     折叠回基名后分区信息不需要任何额外请求即为真值。
    async getTopics(tenant: string, namespace: string): Promise<Topic[]> {
        return this.enqueue(async () => {
            const [persistentUris, nonPersistentUris] = await Promise.all([
                this.fetchTopicUris(`/admin/v2/namespaces/${seg(tenant)}/${seg(namespace)}/topics`),
                this.fetchTopicUris(`/admin/v2/non-persistent/${seg(tenant)}/${seg(namespace)}`),
            ]);
            return collapseTopicUris([...persistentUris, ...nonPersistentUris]);
        });
    }

    private async fetchTopicUris(path: string): Promise<string[]> {
        return orNotFound(async () => {
            const response = await withRetry(() => this.http.get(path));
            return ((response.data as string[]) || []).filter(Boolean);
        }, [] as string[]);
    }

    // ========== Topic 操作 ==========

    // 获取 Topic 统计信息（归一化后的形状见 shared/types 的 TopicStats）
    async getTopicStats(
        tenant: string,
        namespace: string,
        topic: string,
        persistent: boolean = true,
    ): Promise<TopicStats> {
        return this.enqueue(async () => {
            const topicName = shortTopicName(topic);
            const fullName = `${tenant}/${namespace}/${topicName}`;
            const base = topicPath(tenant, namespace, topicName, persistent);

            const empty = (): TopicStats => ({
                name: fullName,
                persistent,
                msgRateIn: 0,
                msgRateOut: 0,
                msgThroughputIn: 0,
                msgThroughputOut: 0,
                storageSize: 0,
                backlogSize: 0,
                producers: [],
                consumers: [],
                subscriptions: {},
                partitions: [],
                ownerBrokers: [],
            });

            return orNotFound(async () => {
                // 分区 topic 的基名没有 /stats 路由（实测 404），只有 /partitioned-stats；
                // 反过来非分区 topic 没有 /partitioned-stats。所以先 /stats，404 再降级。
                const stats = await orNotFound(() => withRetry(() => this.http.get(`${base}/stats`)), null);
                if (stats) {
                    // 能命中 /stats 说明它是非分区 topic（分区 topic 的基名在这里 404），
                    // 因此分区列表必然为空，不必再问一次 /partitions。
                    return normalizeTopicStats(stats.data, empty(), []);
                }

                const partitioned = await orNotFound(
                    () => withRetry(() => this.http.get(`${base}/partitioned-stats`)),
                    null,
                );
                if (!partitioned) {
                    return empty();
                }
                const partitionUris = Object.keys((partitioned.data as any)?.partitions || {});
                return normalizeTopicStats(partitioned.data, empty(), partitionUris);
            }, empty());
        });
    }

    // 获取 Topic 配置：逐个端点独立降级，任何单个策略端点缺失都不应让整份配置读不出来
    async getTopicConfig(
        tenant: string,
        namespace: string,
        topic: string,
        persistent: boolean = true,
    ): Promise<TopicConfig> {
        return this.enqueue(async () => {
            const topicName = shortTopicName(topic);
            const base = topicPath(tenant, namespace, topicName, persistent);
            const config: TopicConfig = {
                topicName: `${tenant}/${namespace}/${topicName}`,
                persistent,
                partitions: [],
                ownerBrokers: [],
            };

            // 实测本 broker 只在 topic 级提供 partitions / retention / permissions，
            // backlog-quota、ttl、max-producers 等没有 topic 级路由，
            // 生效值只能从 stats 里读（backlogQuotaLimitSize / deduplicationStatus）。
            const [partitions, retention, permissions, stats] = await Promise.all([
                orNotFound(() => this.http.get(`${base}/partitions`), null),
                orNotFound(() => this.http.get(`${base}/retention`), null),
                orNotFound(() => this.http.get(`${base}/permissions`), null),
                orNotFound(() => this.http.get(`${base}/stats`), null),
            ]);

            if (partitions) {
                config.partitions = parsePartitionsMeta(
                    partitions.data,
                    tenant,
                    namespace,
                    topicName,
                    persistent,
                ).partitions;
            }

            const retentionData = retention?.data as any;
            if (retentionData && typeof retentionData === 'object') {
                config.retentionTimeInMinutes = numberOrUndefined(retentionData.retentionTimeInMinutes);
                config.retentionSizeInMB = numberOrUndefined(retentionData.retentionSizeInMB);
            }

            const permissionData = permissions?.data as any;
            if (permissionData && typeof permissionData === 'object') {
                config.permissions = permissionData;
            }

            const statsData = stats?.data as any;
            if (statsData && typeof statsData === 'object') {
                config.backlogQuotaLimitSize = numberOrUndefined(statsData.backlogQuotaLimitSize);
                config.backlogQuotaLimitTime = numberOrUndefined(statsData.backlogQuotaLimitTime);
                if (typeof statsData.deduplicationStatus === 'string') {
                    config.deduplicationEnabled = statsData.deduplicationStatus.toLowerCase() === 'enabled';
                }
                config.ownerBrokers = collectOwnerBrokers(statsData);
            }

            return config;
        });
    }

    // 更新 Topic 配置：只写有真实 topic 级入口的策略，其余显式报错。
    // 之前是往不存在的 /config 端点 PUT 整个对象，用户改了却没生效也不报错。
    async updateTopicConfig(
        tenant: string,
        namespace: string,
        topic: string,
        patch: TopicConfigPatch,
        persistent: boolean = true,
    ): Promise<void> {
        return this.enqueue(async () => {
            const topicName = shortTopicName(topic);
            const base = topicPath(tenant, namespace, topicName, persistent);
            const keys = Object.keys(patch).filter(key => (patch as any)[key] !== undefined);

            const unsupported = keys.filter(key => !WRITABLE_TOPIC_CONFIG_KEYS.includes(key as keyof TopicConfigPatch));
            if (unsupported.length > 0) {
                throw new Error(
                    `以下策略不支持在 topic 级别设置：${unsupported.join('、')}。` +
                        '本 broker 没有对应的 topic 级 Admin 端点，请在命名空间级别修改。',
                );
            }
            if (keys.length === 0) {
                throw new Error('没有需要更新的配置项');
            }

            if (keys.includes('retentionTimeInMinutes') || keys.includes('retentionSizeInMB')) {
                // POST /retention 整体替换 RetentionPolicies：先读回现值再合并，
                // 否则只改 retentionSize 会把 retentionTime 清零。
                // 实测 topic 级 GET /retention 在没显式设置过时返回空 body，此时取命名空间
                // 的生效值；两者都读不到就用 -1，因为 broker 明确拒绝"一维为 0 另一维非 0"
                // （0 只用来配合另一维也为 0 表示整体关闭保留）。
                const [topicRetention, nsRetention] = await Promise.all([
                    orNotFound(() => this.http.get(`${base}/retention`), null),
                    orNotFound(
                        () => this.http.get(`/admin/v2/namespaces/${seg(tenant)}/${seg(namespace)}/retention`),
                        null,
                    ),
                ]);
                const current =
                    topicRetention?.data && typeof topicRetention.data === 'object'
                        ? (topicRetention.data as any)
                        : null;
                const inherited =
                    nsRetention?.data && typeof nsRetention.data === 'object' ? (nsRetention.data as any) : null;
                const resolve = (field: keyof TopicConfigPatch, patchValue: number | undefined): number => {
                    if (typeof patchValue === 'number') {
                        return patchValue;
                    }
                    return numberOr(current?.[field], numberOr(inherited?.[field], -1));
                };
                await this.http.post(`${base}/retention`, {
                    retentionTimeInMinutes: resolve('retentionTimeInMinutes', patch.retentionTimeInMinutes),
                    retentionSizeInMB: resolve('retentionSizeInMB', patch.retentionSizeInMB),
                });
            }

            if (typeof patch.numPartitions === 'number') {
                // 实测 PUT 是"创建分区 topic"，对已存在的分区 topic 返回
                // 409 `Partitioned topic already exists`；POST 才是更新分区数。
                await this.http.post(`${base}/partitions`, patch.numPartitions);
            }
        });
    }

    // 创建 Topic：partitions 省略或为 0 时创建非分区 topic（PUT topic 本体，实测 204），
    // 否则创建分区 topic（PUT /partitions，body 为裸数字）
    async createTopic(
        tenant: string,
        namespace: string,
        topic: string,
        persistent: boolean = true,
        partitions?: number,
    ): Promise<void> {
        return this.enqueue(async () => {
            const topicName = shortTopicName(topic);
            const base = topicPath(tenant, namespace, topicName, persistent);
            if (partitions && partitions > 0) {
                await this.http.put(`${base}/partitions`, partitions);
            } else {
                await this.http.put(base, {});
            }
        });
    }

    /**
     * 删除 Topic。分区 topic 删基名会被 broker 拒绝（409，要求调用 delete-partitioned-topic），
     * 实测必须用 DELETE {base}/partitions 才能连带清掉全部分区。
     */
    async deleteTopic(tenant: string, namespace: string, topic: string, persistent: boolean = true): Promise<void> {
        return this.enqueue(async () => {
            const topicName = shortTopicName(topic);
            const base = topicPath(tenant, namespace, topicName, persistent);
            const meta = await orNotFound(async () => {
                const response = await this.http.get(`${base}/partitions`);
                return response.data;
            }, null);
            const partitions = meta ? parsePartitionsMeta(meta, tenant, namespace, topicName, persistent) : null;
            await this.http.delete(partitions && partitions.partitions.length > 0 ? `${base}/partitions` : base);
        });
    }

    // ========== Schema 注册表 ==========
    //
    // /schemas/{tenant}/{ns}/{topic名} 的路径不带 persistent/non-persistent 前缀（与 topic/订阅
    // 的资源路径不同）；分区 topic 的 schema 挂在 {基名}-partition-0 上，基名路径是 404——
    // 先探一次 /partitions 元数据决定用哪个名字，而不是两条路径盲试两遍。

    private async schemaPath(tenant: string, namespace: string, topic: string, persistent: boolean): Promise<string> {
        const name = shortTopicName(topic);
        const meta = (await orNotFound(
            async () => (await this.http.get(`${topicPath(tenant, namespace, name, persistent)}/partitions`)).data,
            null,
        )) as {partitions?: unknown[] | number} | null;
        const count = Array.isArray(meta?.partitions) ? meta!.partitions.length : Number(meta?.partitions ?? 0) || 0;
        const schemaName = count > 0 ? `${name}-partition-0` : name;
        return `/admin/v2/schemas/${seg(tenant)}/${seg(namespace)}/${seg(schemaName)}`;
    }

    // topic 的最新 schema；未注册（404）返回 null——那是常态，不是错误。
    async getSchemaInfo(
        tenant: string,
        namespace: string,
        topic: string,
        persistent: boolean = true,
    ): Promise<BrokerSchemaInfo | null> {
        return this.enqueue(async () => {
            const base = await this.schemaPath(tenant, namespace, topic, persistent);
            return orNotFound(async () => {
                const response = await withRetry(() => this.http.get(base));
                return response.data as BrokerSchemaInfo;
            }, null);
        });
    }

    // 注册新的 schema 版本。broker 会按当前兼容性策略校验新 schema，拒绝时 422 带原因，
    // 原样抛给界面，不在这里猜。
    async createSchemaVersion(
        tenant: string,
        namespace: string,
        topic: string,
        info: {type: string; schema: string},
        persistent: boolean = true,
    ): Promise<BrokerSchemaInfo> {
        return this.enqueue(async () => {
            const base = await this.schemaPath(tenant, namespace, topic, persistent);
            const response = await this.http.post(`${base}/versions`, info);
            return response.data as BrokerSchemaInfo;
        });
    }

    // 删除 topic 的全部 schema 版本。
    async deleteSchema(tenant: string, namespace: string, topic: string, persistent: boolean = true): Promise<void> {
        return this.enqueue(async () => {
            const base = await this.schemaPath(tenant, namespace, topic, persistent);
            await this.http.delete(base);
        });
    }

    // 策略端点挂在 topic 资源路径下（与 schema 正文的 /schemas 路径不同），
    // 且不区分分区——分区 topic 的策略由基名承载。
    private schemaStrategyPath(tenant: string, namespace: string, topic: string, persistent: boolean): string {
        return `${topicPath(tenant, namespace, shortTopicName(topic), persistent)}/schemaCompatibilityStrategy`;
    }

    // topic 级兼容性策略。老 broker（3.0 之前）没有 topic 级端点，UNDEFINED 表示"沿用命名空间"：
    // 这两种情况都退到读命名空间级，并把生效范围如实标出来，界面不说"这是 topic 级设置"的假话。
    async getSchemaCompatibilityStrategy(
        tenant: string,
        namespace: string,
        topic: string,
        persistent: boolean = true,
    ): Promise<{strategy: string | null; scope: 'topic' | 'namespace'}> {
        return this.enqueue(async () => {
            const topicLevel = this.schemaStrategyPath(tenant, namespace, topic, persistent);
            const raw = await orNotFound(async () => (await withRetry(() => this.http.get(topicLevel))).data, null);
            if (typeof raw === 'string' && raw.trim() && raw !== 'UNDEFINED') {
                return {strategy: raw, scope: 'topic' as const};
            }
            const nsLevel = `/admin/v2/namespaces/${seg(tenant)}/${seg(namespace)}/schemaCompatibilityStrategy`;
            const fromNs = await orNotFound(() => this.http.get(nsLevel), null);
            const value = (fromNs as {data?: unknown} | null)?.data;
            return {
                strategy: typeof value === 'string' && value.trim() ? value : null,
                scope: 'namespace' as const,
            };
        });
    }

    async setSchemaCompatibilityStrategy(
        tenant: string,
        namespace: string,
        topic: string,
        strategy: string,
        persistent: boolean = true,
    ): Promise<void> {
        return this.enqueue(async () => {
            const path = this.schemaStrategyPath(tenant, namespace, topic, persistent);
            try {
                // 实测策略走 query 参数、无请求体（TopicsBaseResource 的 @QueryParam("strategy")）
                await this.http.put(path, null, {params: {strategy}});
            } catch (error) {
                if (error instanceof NotFoundError) {
                    throw new Error('该 broker 不支持 topic 级 schema 兼容性策略（需要 Pulsar 3.0 及以上）');
                }
                throw error;
            }
        });
    }

    // ========== 权限（ACL）==========
    //
    // 授权端点在 broker 版本间换过 HTTP 方法：老口径是 PUT {role} 收 ["produce","consume"]，
    // 新版（3.x/4.x 文档）改成 POST {role} 收 AuthPolicies 对象。两种都写成"先按当前文档的
    // POST，方法不被支持再退回 PUT"，否则换一套集群就整片读得到却改不动。

    private async grantOnPath(permissionsBase: string, role: string, actions: string[]): Promise<void> {
        const path = `${permissionsBase}/permissions/${seg(role)}`;
        try {
            await this.http.post(path, {role, authPolicies: actions.map(action => ({action}))});
        } catch (error) {
            if (!isHttpMethodRejected(error)) {
                throw error;
            }
            await this.http.put(path, actions);
        }
    }

    private async revokeOnPath(permissionsBase: string, role: string): Promise<void> {
        await this.http.delete(`${permissionsBase}/permissions/${seg(role)}`);
    }

    private async readPermissions(permissionsBase: string): Promise<Record<string, string[]>> {
        return orNotFound(async () => {
            const response = await withRetry(() => this.http.get(permissionsBase));
            const data = response.data as Record<string, unknown> | null;
            if (!data || typeof data !== 'object') {
                return {};
            }
            // broker 返回 Map<role, Set<AuthAction>>，但也可能是 {role: {action: ...}} 形态的
            // AuthPolicies（新版序列化），统一压成动作数组，认不出的值原样转字符串。
            return Object.entries(data).reduce<Record<string, string[]>>((acc, [role, value]) => {
                if (Array.isArray(value)) {
                    acc[role] = value.map(String);
                } else if (
                    value &&
                    typeof value === 'object' &&
                    Array.isArray((value as {authPolicies?: unknown}).authPolicies)
                ) {
                    acc[role] = ((value as {authPolicies: unknown[]}).authPolicies as Array<{action?: string}>)
                        .map(policy => policy?.action ?? '')
                        .filter(Boolean);
                } else {
                    acc[role] = [];
                }
                return acc;
            }, {});
        }, {});
    }

    async getNamespacePermissions(tenant: string, namespace: string): Promise<Record<string, string[]>> {
        return this.enqueue(() =>
            this.readPermissions(`/admin/v2/namespaces/${seg(tenant)}/${seg(namespace)}/permissions`),
        );
    }

    async grantNamespacePermission(tenant: string, namespace: string, role: string, actions: string[]): Promise<void> {
        return this.enqueue(async () => {
            await this.grantOnPath(`/admin/v2/namespaces/${seg(tenant)}/${seg(namespace)}`, role, actions);
        });
    }

    async revokeNamespacePermission(tenant: string, namespace: string, role: string): Promise<void> {
        return this.enqueue(async () => {
            await this.revokeOnPath(`/admin/v2/namespaces/${seg(tenant)}/${seg(namespace)}`, role);
        });
    }

    async getTopicPermissions(
        tenant: string,
        namespace: string,
        topic: string,
        persistent: boolean = true,
    ): Promise<Record<string, string[]>> {
        return this.enqueue(() =>
            this.readPermissions(`${topicPath(tenant, namespace, shortTopicName(topic), persistent)}/permissions`),
        );
    }

    async grantTopicPermission(
        tenant: string,
        namespace: string,
        topic: string,
        role: string,
        actions: string[],
        persistent: boolean = true,
    ): Promise<void> {
        return this.enqueue(async () => {
            const base = topicPath(tenant, namespace, shortTopicName(topic), persistent);
            await this.grantOnPath(base, role, actions);
        });
    }

    async revokeTopicPermission(
        tenant: string,
        namespace: string,
        topic: string,
        role: string,
        persistent: boolean = true,
    ): Promise<void> {
        return this.enqueue(async () => {
            const base = topicPath(tenant, namespace, shortTopicName(topic), persistent);
            await this.revokeOnPath(base, role);
        });
    }

    // ========== 订阅操作 ==========

    // 获取 Topic 的所有订阅
    async getSubscriptions(
        tenant: string,
        namespace: string,
        topic: string,
        persistent: boolean = true,
    ): Promise<string[]> {
        return this.enqueue(() =>
            orNotFound(async () => {
                const response = await withRetry(() =>
                    this.http.get(`${topicPath(tenant, namespace, shortTopicName(topic), persistent)}/subscriptions`),
                );
                return (response.data as string[]) || [];
            }, []),
        );
    }

    // 删除订阅
    async deleteSubscription(
        tenant: string,
        namespace: string,
        topic: string,
        subscription: string,
        persistent: boolean = true,
    ): Promise<void> {
        return this.enqueue(async () => {
            await this.http.delete(
                subscriptionPath(tenant, namespace, shortTopicName(topic), subscription, persistent),
            );
        });
    }

    // 创建订阅。
    // 订阅类型由第一个连上来的 consumer 决定，Admin 侧只能指定起始位置；
    // 之前把 {type} 当 body PUT 过去，broker 期望的是 MessageId 映射表，等于必然失败。
    async createSubscription(
        tenant: string,
        namespace: string,
        topic: string,
        name: string,
        persistent: boolean = true,
        initialPosition: 'Latest' | 'Earliest' = 'Latest',
    ): Promise<void> {
        return this.enqueue(async () => {
            const path = subscriptionPath(tenant, namespace, shortTopicName(topic), name, persistent);
            await this.http.put(path, null, {params: {initialPosition}});
        });
    }

    // 跳过指定数量的消息
    async skipMessages(
        tenant: string,
        namespace: string,
        topic: string,
        subscription: string,
        numMessages: number,
        persistent: boolean = true,
    ): Promise<void> {
        return this.enqueue(async () => {
            const path = subscriptionPath(tenant, namespace, shortTopicName(topic), subscription, persistent);
            await this.http.post(`${path}/skip/${numMessages}`);
        });
    }

    // 重置订阅游标到指定时间戳
    async resetCursor(
        tenant: string,
        namespace: string,
        topic: string,
        subscription: string,
        timestamp: number,
        persistent: boolean = true,
    ): Promise<void> {
        return this.enqueue(async () => {
            const path = subscriptionPath(tenant, namespace, shortTopicName(topic), subscription, persistent);
            await this.http.post(`${path}/resetcursor/${timestamp}`);
        });
    }

    // 重置订阅游标到最早位置：POST 不带时间戳即回到最早
    async resetCursorToEarliest(
        tenant: string,
        namespace: string,
        topic: string,
        subscription: string,
        persistent: boolean = true,
    ): Promise<void> {
        return this.enqueue(async () => {
            const path = subscriptionPath(tenant, namespace, shortTopicName(topic), subscription, persistent);
            await this.http.post(`${path}/resetcursor`);
        });
    }

    // 重置订阅游标到最新位置。
    // 实测本 broker 没有 seekLatest 路由（404），能表达"跳到最新"的是 skip_all。
    async resetCursorToLatest(
        tenant: string,
        namespace: string,
        topic: string,
        subscription: string,
        persistent: boolean = true,
    ): Promise<void> {
        return this.enqueue(async () => {
            const path = subscriptionPath(tenant, namespace, shortTopicName(topic), subscription, persistent);
            await this.http.post(`${path}/skip_all`);
        });
    }

    // ========== 消息操作 ==========
    //
    // 发送与读取走原生 pulsar-client（见 services/pulsar-native-client）：
    // admin REST 上的 producers/.../send 与 subscription/.../peek 路由实测都是 404。

    // 获取订阅积压。实测没有 `.../subscription/{sub}/backlog` 路由，
    // 数据在 topic stats 的 subscriptions[sub] 里，一次请求即可取到。
    async getBacklog(
        tenant: string,
        namespace: string,
        topic: string,
        subscription: string,
        persistent: boolean = true,
    ): Promise<{messageCount: number; sizeInBytes: number}> {
        const stats = await this.getTopicStats(tenant, namespace, topic, persistent);
        const sub = stats.subscriptions?.[subscription];
        return {
            messageCount: sub?.msgBacklog ?? 0,
            sizeInBytes: sub?.backlogSize ?? 0,
        };
    }

    // ========== 连接测试 ==========

    // 健康检查 - 尝试多种可能的端点
    async healthCheck(): Promise<boolean> {
        const endpoints = [
            API_ENDPOINTS.CLUSTERS,
            API_ENDPOINTS.TENANTS,
            API_ENDPOINTS.HEALTH,
            API_ENDPOINTS.HEALTH_ALT,
        ];

        for (const endpoint of endpoints) {
            try {
                const response = await this.enqueue(() => this.http.get(endpoint, {timeout: 3000}));
                // 检查状态码是否在成功范围内 (200-399)
                if (response.status >= 200 && response.status < 400) {
                    return true;
                }
                // 如果状态码不在成功范围，继续尝试下一个端点
            } catch {
                // 继续尝试下一个端点
            }
        }
        return false;
    }

    // broker 版本，走 /metrics 的 pulsar_version_info 标签。/clusters/{name} 的 version
    // 字段在不少部署里根本不出现（实测 3.3.9 standalone 的详情 JSON 就没有这个键），
    // 而 /metrics 是 broker 自带的 Prometheus 端点。超时单独收紧：全局 adminApiTimeout
    // 可能配到几十秒，指标页大时一次全量读取会把整轮探活拖住。
    async getVersion(): Promise<string | undefined> {
        const text = await this.enqueue(async () => {
            const response = await this.http.get<string>('/metrics', {
                responseType: 'text',
                timeout: 5000,
                transformResponse: [(data: unknown) => data],
            });
            return String(response.data ?? '');
        });
        // 指标行可能排在几百 KB 之后，扫全文；匹配到的 version 标签本身不含引号
        return /pulsar_version_info\{[^}]*version="([^"]+)"/.exec(text)?.[1];
    }
}
