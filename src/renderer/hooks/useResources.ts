import {useState, useCallback, useEffect, useRef} from 'react';
import type {Tenant, Topic, TopicStats} from '../types';
import {loadTenants, loadNamespaces, loadTopics, loadTopicStats, invalidateResourceCache} from './resourceCache';

interface UseResourcesResult {
    // 租户
    tenants: Tenant[];
    tenantsLoading: boolean;
    tenantsError: string | null;
    fetchTenants: (clusterId: string) => Promise<void>;

    // 命名空间
    namespaces: string[];
    namespacesLoading: boolean;
    namespacesError: string | null;
    fetchNamespaces: (clusterId: string, tenant: string) => Promise<void>;

    // Topics
    topics: Topic[];
    topicsLoading: boolean;
    topicsError: string | null;
    fetchTopics: (clusterId: string, tenant: string, namespace: string) => Promise<void>;

    // Topic 统计
    topicStats: TopicStats | null;
    topicStatsLoading: boolean;
    topicStatsError: string | null;
    fetchTopicStats: (
        clusterId: string,
        tenant: string,
        namespace: string,
        topic: string,
        persistent?: boolean,
    ) => Promise<void>;

    // 缓存管理
    clearCache: () => void;
}

/**
 * 资源列表的响应式封装，缓存来自模块级的 resourceCache（跨组件共享）。
 *
 * 每类资源各自维护一个自增请求号：只有最后一次发起的请求才允许写回 state，
 * 快速切换集群/租户时先发后到的响应不会覆盖新数据，组件卸载后也不再 setState。
 */
export function useResources(): UseResourcesResult {
    const mountedRef = useRef(true);
    const tenantsRequestRef = useRef(0);
    const namespacesRequestRef = useRef(0);
    const topicsRequestRef = useRef(0);
    const topicStatsRequestRef = useRef(0);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const [tenants, setTenants] = useState<Tenant[]>([]);
    const [tenantsLoading, setTenantsLoading] = useState(false);
    const [tenantsError, setTenantsError] = useState<string | null>(null);

    const [namespaces, setNamespaces] = useState<string[]>([]);
    const [namespacesLoading, setNamespacesLoading] = useState(false);
    const [namespacesError, setNamespacesError] = useState<string | null>(null);

    const [topics, setTopics] = useState<Topic[]>([]);
    const [topicsLoading, setTopicsLoading] = useState(false);
    const [topicsError, setTopicsError] = useState<string | null>(null);

    const [topicStats, setTopicStats] = useState<TopicStats | null>(null);
    const [topicStatsLoading, setTopicStatsLoading] = useState(false);
    const [topicStatsError, setTopicStatsError] = useState<string | null>(null);

    const fetchTenants = useCallback(async (clusterId: string) => {
        const requestId = ++tenantsRequestRef.current;
        const isCurrent = () => mountedRef.current && tenantsRequestRef.current === requestId;

        setTenantsLoading(true);
        setTenantsError(null);
        try {
            const data = await loadTenants(clusterId);
            if (isCurrent()) {
                setTenants(data);
            }
        } catch (error) {
            if (isCurrent()) {
                setTenantsError((error as Error).message);
            }
        } finally {
            if (isCurrent()) {
                setTenantsLoading(false);
            }
        }
    }, []);

    const fetchNamespaces = useCallback(async (clusterId: string, tenant: string) => {
        const requestId = ++namespacesRequestRef.current;
        const isCurrent = () => mountedRef.current && namespacesRequestRef.current === requestId;

        setNamespacesLoading(true);
        setNamespacesError(null);
        try {
            const data = await loadNamespaces(clusterId, tenant);
            if (isCurrent()) {
                setNamespaces(data);
            }
        } catch (error) {
            if (isCurrent()) {
                setNamespacesError((error as Error).message);
            }
        } finally {
            if (isCurrent()) {
                setNamespacesLoading(false);
            }
        }
    }, []);

    const fetchTopics = useCallback(async (clusterId: string, tenant: string, namespace: string) => {
        const requestId = ++topicsRequestRef.current;
        const isCurrent = () => mountedRef.current && topicsRequestRef.current === requestId;

        setTopicsLoading(true);
        setTopicsError(null);
        try {
            const data = await loadTopics(clusterId, tenant, namespace);
            if (isCurrent()) {
                setTopics(data);
            }
        } catch (error) {
            if (isCurrent()) {
                setTopicsError((error as Error).message);
            }
        } finally {
            if (isCurrent()) {
                setTopicsLoading(false);
            }
        }
    }, []);

    const fetchTopicStats = useCallback(
        async (clusterId: string, tenant: string, namespace: string, topic: string, persistent = true) => {
            const requestId = ++topicStatsRequestRef.current;
            const isCurrent = () => mountedRef.current && topicStatsRequestRef.current === requestId;

            setTopicStatsLoading(true);
            setTopicStatsError(null);
            try {
                const data = await loadTopicStats(clusterId, tenant, namespace, topic, persistent);
                if (isCurrent()) {
                    setTopicStats(data);
                }
            } catch (error) {
                if (isCurrent()) {
                    setTopicStatsError((error as Error).message);
                }
            } finally {
                if (isCurrent()) {
                    setTopicStatsLoading(false);
                }
            }
        },
        [],
    );

    const clearCache = useCallback(() => {
        invalidateResourceCache();
    }, []);

    return {
        tenants,
        tenantsLoading,
        tenantsError,
        fetchTenants,
        namespaces,
        namespacesLoading,
        namespacesError,
        fetchNamespaces,
        topics,
        topicsLoading,
        topicsError,
        fetchTopics,
        topicStats,
        topicStatsLoading,
        topicStatsError,
        fetchTopicStats,
        clearCache,
    };
}
