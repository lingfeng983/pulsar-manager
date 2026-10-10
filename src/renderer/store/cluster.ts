import {create} from 'zustand';
import type {ClusterConfig} from '../types';
import {useTabStore} from './tabs';

interface ClusterState {
    clusters: ClusterConfig[];
    activeClusterId: string | null;
    expandedClusterId: string | null;
    loading: boolean;
    error: string | null;

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
        }));
        // 集群没了，指向它的详情页/监控/拓扑标签全部会变成死链接，一并关掉。
        useTabStore.getState().removeClusterTabs(id);
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
