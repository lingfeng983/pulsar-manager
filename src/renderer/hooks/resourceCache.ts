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

/** 加载租户列表（带缓存）。失败时抛出 Error。 */
export async function loadTenants(clusterId: string): Promise<Tenant[]> {
    const key = `tenants:${clusterId}`;
    const cached = tenantsCache.get(key);
    if (cached) {
        return cached;
    }
    const data = unwrap(await window.electronAPI.resources.getTenants(clusterId), 'tenants');
    tenantsCache.set(key, data);
    return data;
}

/** 加载命名空间列表（带缓存）。返回的是原始值，可能含 "tenant/ns" 前缀。 */
export async function loadNamespaces(clusterId: string, tenant: string): Promise<string[]> {
    const key = `namespaces:${clusterId}:${tenant}`;
    const cached = namespacesCache.get(key);
    if (cached) {
        return cached;
    }
    const data = unwrap(await window.electronAPI.resources.getNamespaces(clusterId, tenant), 'namespaces');
    namespacesCache.set(key, data);
    return data;
}

/** 加载 Topic 列表（带缓存）。 */
export async function loadTopics(clusterId: string, tenant: string, namespace: string): Promise<Topic[]> {
    const key = `topics:${clusterId}:${tenant}:${namespace}`;
    const cached = topicsCache.get(key);
    if (cached) {
        return cached;
    }
    const data = unwrap(await window.electronAPI.resources.getTopics(clusterId, tenant, namespace), 'topics');
    topicsCache.set(key, data);
    return data;
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
    const cached = topicStatsCache.get(key);
    if (cached) {
        return cached;
    }
    const data = unwrap(
        await window.electronAPI.resources.getTopicStats(clusterId, tenant, namespace, topic, persistent),
        'topic stats',
    );
    topicStatsCache.set(key, data);
    return data;
}

/** 清空全部资源缓存（例如切换集群或强制刷新时）。 */
export function invalidateResourceCache(): void {
    tenantsCache.clear();
    namespacesCache.clear();
    topicsCache.clear();
    topicStatsCache.clear();
}
