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
    setTabs: (tabs: TabItem[]) => void;
    addTab: (tab: TabItem) => void;
    removeTab: (id: string) => void;
    setActiveTab: (id: string) => void;
}

export const useTabStore = create<TabState>(set => ({
    tabs: [{id: 'home', title: '首页', type: 'home'}],
    activeTabId: 'home',
    setTabs: tabs => set({tabs}),
    addTab: tab =>
        set(state => {
            // 检查是否已存在相同标签
            const exists = state.tabs.find(t => t.id === tab.id);
            if (exists) {
                return {tabs: state.tabs, activeTabId: tab.id};
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
    setActiveTab: id => set({activeTabId: id}),
}));
