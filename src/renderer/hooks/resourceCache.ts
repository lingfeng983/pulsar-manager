import type {Tenant, Topic, TopicStats} from '../types';

/**
 * 模块级 LRU 缓存 + 资源加载器。
 *
 * 此前 useResources 把 LRUCache 建在 hook 内部，导致每个组件各持一份缓存、
 * 互不共享，且 hook 只能保存单一 namespaces/topics 结果，无法支撑 ResourceTree /
 * TopNav / HomeTopology 这类需要按集群、租户循环取多份的场景。
 *
 * 这里把缓存提升为模块级单例，并暴露「返回值」形式的加载器，任何组件都能复用
 * 同一份缓存；useResources 只是它之上的一层响应式封装。
 */

class LRUCache<T> {
    private cache: Map<string, {data: T; timestamp: number}> = new Map();

    constructor(
        private maxSize: number,
        private ttl: number,
    ) {}

    get(key: string): T | null {
        const item = this.cache.get(key);
        if (!item) {
            return null;
        }
        if (Date.now() - item.timestamp > this.ttl) {
            this.cache.delete(key);
            return null;
        }
        // 命中后移到末尾表示最近使用
        this.cache.delete(key);
        this.cache.set(key, item);
        return item.data;
    }

    set(key: string, data: T): void {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        if (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey) {
                this.cache.delete(oldestKey);
            }
        }
        this.cache.set(key, {data, timestamp: Date.now()});
    }

    clear(): void {
        this.cache.clear();
    }

    delete(key: string): void {
        this.cache.delete(key);
    }
}

const tenantsCache = new LRUCache<Tenant[]>(100, 5 * 60 * 1000);
const namespacesCache = new LRUCache<string[]>(200, 5 * 60 * 1000);
const topicsCache = new LRUCache<Topic[]>(300, 1 * 60 * 1000);
const topicStatsCache = new LRUCache<TopicStats>(500, 30 * 1000);

function unwrap<T>(response: {success: boolean; data?: T; error?: string}, what: string): T {
    if (response.success && response.data !== undefined) {
        return response.data;
    }
    throw new Error(response.error || `Failed to fetch ${what}`);
}

// 同一个 key 正在飞行中的请求。资源树、TopNav 搜索、首页拓扑经常在同一帧
// 请求同一份数据，若只看缓存，冷启动时会并发打出 N 个完全相同的 IPC。
// 这里让后来者复用同一个 Promise，成功后一起拿结果，失败后一起报错。
const inFlight = new Map<string, Promise<unknown>>();

// 单调递增的写入代次：任何失效动作都会 +1。失效之前发出的在途请求，其结果
// 已经不代表"最新"，必须禁止它回写缓存——否则删掉 topic 后一次慢刷新
// 落地，旧列表原样回填，界面看起来像 topic 又活了。
let writeEpoch = 0;

async function cachedLoad<T>(cache: LRUCache<T>, key: string, fetcher: () => Promise<T>): Promise<T> {
    const cached = cache.get(key);
    if (cached) {
        return cached;
    }

    const pending = inFlight.get(key) as Promise<T> | undefined;
    if (pending) {
        return pending;
    }

    const epochAtStart = writeEpoch;
    const request = fetcher()
        .then(data => {
            if (epochAtStart === writeEpoch) {
                cache.set(key, data);
            }
            return data;
        })
        .finally(() => {
            inFlight.delete(key);
        });

    inFlight.set(key, request);
    return request;
}

/** 加载租户列表（带缓存）。失败时抛出 Error。 */
export async function loadTenants(clusterId: string): Promise<Tenant[]> {
    return cachedLoad(tenantsCache, `tenants:${clusterId}`, async () =>
        unwrap(await window.electronAPI.resources.getTenants(clusterId), 'tenants'),
    );
}

/** 加载命名空间列表（带缓存）。返回的是原始值，可能含 "tenant/ns" 前缀。 */
export async function loadNamespaces(clusterId: string, tenant: string): Promise<string[]> {
    return cachedLoad(namespacesCache, `namespaces:${clusterId}:${tenant}`, async () =>
        unwrap(await window.electronAPI.resources.getNamespaces(clusterId, tenant), 'namespaces'),
    );
}

/** 加载 Topic 列表（带缓存）。 */
export async function loadTopics(clusterId: string, tenant: string, namespace: string): Promise<Topic[]> {
    return cachedLoad(topicsCache, `topics:${clusterId}:${tenant}:${namespace}`, async () =>
        unwrap(await window.electronAPI.resources.getTopics(clusterId, tenant, namespace), 'topics'),
    );
}

/** 加载 Topic 统计（带缓存）。 */
export async function loadTopicStats(
    clusterId: string,
    tenant: string,
    namespace: string,
    topic: string,
    persistent = true,
): Promise<TopicStats> {
    const key = `topicStats:${clusterId}:${tenant}:${namespace}:${topic}:${persistent}`;
    return cachedLoad(topicStatsCache, key, async () =>
        unwrap(
            await window.electronAPI.resources.getTopicStats(clusterId, tenant, namespace, topic, persistent),
            'topic stats',
        ),
    );
}

/** 清空全部资源缓存（例如切换集群或强制刷新时）。 */
export function invalidateResourceCache(): void {
    writeEpoch += 1;
    tenantsCache.clear();
    namespacesCache.clear();
    topicsCache.clear();
    topicStatsCache.clear();
}

// ========== 写操作后的定点失效 ==========
//
// 这些缓存最长 5 分钟才过期，如果写操作（建/删 Topic、重置游标等）之后不主动
// 失效，界面会继续显示旧列表/旧积压，用户只能等 TTL 或手动刷新。写入方在拿到
// 成功响应后调用对应的 invalidate，避免整体 clear 把无关数据也一起打掉。

/** 租户列表变更后调用。 */
export function invalidateTenants(clusterId: string): void {
    writeEpoch += 1;
    tenantsCache.delete(`tenants:${clusterId}`);
}

/** 命名空间增删后调用。 */
export function invalidateNamespaces(clusterId: string, tenant: string): void {
    writeEpoch += 1;
    namespacesCache.delete(`namespaces:${clusterId}:${tenant}`);
}

/** Topic 增删后调用。 */
export function invalidateTopics(clusterId: string, tenant: string, namespace: string): void {
    writeEpoch += 1;
    topicsCache.delete(`topics:${clusterId}:${tenant}:${namespace}`);
}

/** 订阅增删、游标重置、跳过消息等会改变统计的操作后调用。 */
export function invalidateTopicStats(clusterId: string, tenant: string, namespace: string, topic: string): void {
    const prefix = `topicStats:${clusterId}:${tenant}:${namespace}:${topic}:`;
    // persistent 是 key 的一部分，两种取值都要清掉
    topicStatsCache.delete(`${prefix}true`);
    topicStatsCache.delete(`${prefix}false`);
}
