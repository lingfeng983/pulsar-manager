import {create} from 'zustand';

export interface TabItem {
    id: string;
    title: string;
    type: string;
    data?: any;
}

interface TabState {
    tabs: TabItem[];
    activeTabId: string;
    addTab: (tab: TabItem) => void;
    removeTab: (id: string) => void;
    removeClusterTabs: (clusterId: string) => void;
    setActiveTab: (id: string) => void;
}

export const useTabStore = create<TabState>(set => ({
    tabs: [{id: 'home', title: '首页', type: 'home'}],
    activeTabId: 'home',
    addTab: tab =>
        set(state => {
            // 命中已存在的页签：标题与 data 用最新一次调用覆盖（同一资源的入口不止一个，
            // 参数可能更完整），但绝不能把页签重新挂载成第二个实例。
            if (state.tabs.some(t => t.id === tab.id)) {
                return {
                    tabs: state.tabs.map(t => (t.id === tab.id ? {...t, ...tab, data: {...t.data, ...tab.data}} : t)),
                    activeTabId: tab.id,
                };
            }
            return {tabs: [...state.tabs, tab], activeTabId: tab.id};
        }),
    removeTab: id =>
        set(state => {
            if (id === 'home') return state; // 首页不可关闭
            const newTabs = state.tabs.filter(t => t.id !== id);
            const newActiveId =
                state.activeTabId === id ? newTabs[newTabs.length - 1]?.id || 'home' : state.activeTabId;
            return {tabs: newTabs, activeTabId: newActiveId};
        }),
    removeClusterTabs: clusterId =>
        set(state => {
            // 标签 id 形如 `topic-${clusterId}-...`、`topology-${clusterId}`，clusterId 是 uuid，
            // 直接做子串匹配即可锁定归属；顶层 `metrics`/`topology` 等无簇标签不会被误伤。
            const belongsToCluster = (t: TabItem) =>
                t.id !== 'home' && (t.data?.clusterId === clusterId || t.id.includes(clusterId));
            const newTabs = state.tabs.filter(t => !belongsToCluster(t));
            if (newTabs.length === state.tabs.length) return state;
            const newActiveId = newTabs.some(t => t.id === state.activeTabId)
                ? state.activeTabId
                : newTabs[newTabs.length - 1]?.id || 'home';
            return {tabs: newTabs, activeTabId: newActiveId};
        }),
    setActiveTab: id => set({activeTabId: id}),
}));
