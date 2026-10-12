import {create} from 'zustand';
import type {ClusterConfig} from '../types';
import {useTabStore} from './tabs';
import {invalidateResourceCache} from '../hooks/resourceCache';

interface ClusterState {
    clusters: ClusterConfig[];
    activeClusterId: string | null;
    expandedClusterId: string | null;
    loading: boolean;
    error: string | null;
    // 探活进行中。与 loading 分开：列表读的是本地库，一直很快；探活要打 broker，
    // 慢的时候不能把整页压成加载态把人挡在外面。
    checking: boolean;

    // Actions
    setClusters: (clusters: ClusterConfig[]) => void;
    setActiveCluster: (id: string | null) => void;
    setExpandedCluster: (id: string | null) => void;
    addCluster: (cluster: ClusterConfig) => void;
    updateCluster: (id: string, cluster: Partial<ClusterConfig>) => void;
    deleteCluster: (id: string) => void;
    setLoading: (loading: boolean) => void;
    setError: (error: string | null) => void;

    // Async actions
    fetchClusters: () => Promise<void>;
    refreshClusterStatus: () => Promise<boolean>;
    addClusterAsync: (config: Omit<ClusterConfig, 'id'>) => Promise<ClusterConfig | null>;
    updateClusterAsync: (id: string, config: Partial<ClusterConfig>) => Promise<boolean>;
    deleteClusterAsync: (id: string) => Promise<boolean>;
    testConnection: (config: ClusterConfig) => Promise<{connected: boolean; version?: string} | null>;
}

export const useClusterStore = create<ClusterState>((set, get) => ({
    clusters: [],
    activeClusterId: null,
    expandedClusterId: null,
    loading: false,
    checking: false,
    error: null,

    setClusters: clusters => set({clusters}),
    setActiveCluster: id => set({activeClusterId: id}),
    setExpandedCluster: id => set({expandedClusterId: id}),
    addCluster: cluster => set(state => ({clusters: [...state.clusters, cluster]})),
    updateCluster: (id, updates) =>
        set(state => ({
            clusters: state.clusters.map(c => (c.id === id ? {...c, ...updates} : c)),
        })),
    deleteCluster: id => {
        set(state => ({
            clusters: state.clusters.filter(c => c.id !== id),
            activeClusterId: state.activeClusterId === id ? null : state.activeClusterId,
            expandedClusterId: state.expandedClusterId === id ? null : state.expandedClusterId,
        }));
        // 集群没了，指向它的详情页/监控/拓扑标签全部会变成死链接，一并关掉。
        useTabStore.getState().removeClusterTabs(id);
        // 树里缓存着这个集群的租户/命名空间/Topic，不整体失效的话重建同名集群会直接
        // 显示上一个集群的内容（TTL 最长五分钟）。
        invalidateResourceCache();
    },
    setLoading: loading => set({loading}),
    setError: error => set({error}),

    fetchClusters: async () => {
        set({loading: true, error: null});
        try {
            const response = await window.electronAPI.cluster.list();
            if (response.success && response.data) {
                set({clusters: response.data as ClusterConfig[], loading: false});
            } else {
                set({error: response.error || 'Failed to fetch clusters', loading: false});
            }
        } catch (error) {
            set({error: String(error), loading: false});
        }
    },

    // 逐集群探活并回整份列表。已经在探的时候直接复用这一轮：首屏挂载与用户点刷新
    // 挨得极近，起两轮就是双倍打 broker。
    refreshClusterStatus: async () => {
        if (get().checking) {
            return true;
        }
        set({checking: true});
        try {
            const response = await window.electronAPI.cluster.checkStatus();
            if (response.success && response.data) {
                set({clusters: response.data as ClusterConfig[]});
                return true;
            }
            // 不写 error：列表已经在页面上显示着，探活这一轮失败不该把它换成整页错误块，
            // 由调用方弹一条 toast 就够了。
            return false;
        } catch {
            return false;
        } finally {
            set({checking: false});
        }
    },

    addClusterAsync: async config => {
        set({loading: true, error: null});
        try {
            const response = await window.electronAPI.cluster.add(config);
            if (response.success && response.data) {
                const newCluster: ClusterConfig = {
                    ...config,
                    id: response.data.id,
                    status: 'disconnected',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                };
                get().addCluster(newCluster);
                set({loading: false});
                return newCluster;
            } else {
                set({error: response.error || 'Failed to add cluster', loading: false});
                return null;
            }
        } catch (error) {
            set({error: String(error), loading: false});
            return null;
        }
    },

    updateClusterAsync: async (id, config) => {
        set({loading: true, error: null});
        try {
            const response = await window.electronAPI.cluster.update(id, config as ClusterConfig);
            if (response.success) {
                get().updateCluster(id, config);
                set({loading: false});
                return true;
            } else {
                set({error: response.error || 'Failed to update cluster', loading: false});
                return false;
            }
        } catch (error) {
            set({error: String(error), loading: false});
            return false;
        }
    },

    deleteClusterAsync: async id => {
        set({loading: true, error: null});
        try {
            const response = await window.electronAPI.cluster.delete(id);
            if (response.success) {
                get().deleteCluster(id);
                set({loading: false});
                return true;
            } else {
                set({error: response.error || 'Failed to delete cluster', loading: false});
                return false;
            }
        } catch (error) {
            set({error: String(error), loading: false});
            return false;
        }
    },

    testConnection: async config => {
        try {
            const response = await window.electronAPI.cluster.testConnection(config);
            if (response.success && response.data) {
                return response.data;
            }
            return null;
        } catch {
            return null;
        }
    },
}));
