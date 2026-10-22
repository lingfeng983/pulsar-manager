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
    // 最近一轮探活里失败的集群 id → 失败原因。整轮重新下发，所以某集群恢复在线后
    // 它的旧原因会自动消失，不会留下一句过期的报错。
    statusErrors: Record<string, string>;

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
    refreshClusterStatus: (force?: boolean) => Promise<boolean>;
    addClusterAsync: (config: Omit<ClusterConfig, 'id'>) => Promise<ClusterConfig | null>;
    updateClusterAsync: (id: string, config: Partial<ClusterConfig>) => Promise<boolean>;
    deleteClusterAsync: (id: string) => Promise<boolean>;
    testConnection: (config: ClusterConfig) => Promise<{connected: boolean; version?: string} | null>;
}

// 在途的探活轮次。首屏挂载与用户点刷新挨得极近时复用同一轮；
// force=true 表示「等这一轮结束后再跑一轮」，用于保存后必须拿到新配置结果。
let statusRefresh: Promise<boolean> | null = null;

export const useClusterStore = create<ClusterState>((set, get) => ({
    clusters: [],
    activeClusterId: null,
    expandedClusterId: null,
    loading: false,
    checking: false,
    statusErrors: {},
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
    refreshClusterStatus: async (force = false) => {
        if (statusRefresh) {
            if (!force) {
                return statusRefresh;
            }
            // 等上一轮落地再重新探一次：保存后必须看到新配置的结果，
            // 不能把旧一轮的响应当成「刷新成功」。
            await statusRefresh;
        }
        const run = (async () => {
            set({checking: true});
            try {
                const response = await window.electronAPI.cluster.checkStatus();
                if (response.success && response.data) {
                    set({
                        clusters: response.data as ClusterConfig[],
                        // 逐集群的失败原因一并收下：调用方（Home 的刷新按钮、列表行）
                        // 就是靠它把「连不上」说清楚，不再只弹一句笼统的失败。
                        statusErrors: response.statusErrors ?? {},
                    });
                    return true;
                }
                // 不写 error：列表已经在页面上显示着，探活这一轮失败不该把它换成整页错误块，
                // 由调用方弹一条 toast 就够了。statusErrors 也不清：这一轮没拿到结论，
                // 页面上显示的仍是上一轮的结果，原因与状态就应当保持同一轮。
                return false;
            } catch {
                return false;
            } finally {
                set({checking: false});
            }
        })();
        statusRefresh = run;
        try {
            return await run;
        } finally {
            if (statusRefresh === run) {
                statusRefresh = null;
            }
        }
    },

    addClusterAsync: async config => {
        set({loading: true, error: null});
        try {
            const response = await window.electronAPI.cluster.add(config);
            if (response.success && response.data) {
                // 用主进程落库后的视图，别再写死 status='disconnected'：
                // 那会让刚测通、刚添加的集群立刻显示成离线。
                const newCluster: ClusterConfig = {...config, ...response.data};
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
            // 目标状态是"这个集群不在列表里"：后端已经不存在时也算删除成功。
            // 否则用户重试一次就会收到 NOT_FOUND，弹一堆"删除失败"。
            const alreadyGone = !response.success && response.code === 'NOT_FOUND';
            if (response.success || alreadyGone) {
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
