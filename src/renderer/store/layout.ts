import {create} from 'zustand';

const COLLAPSED_KEY = 'pulsar-manager.sidebar-collapsed';

// 侧边栏折叠放在渲染进程本地而不是 SQLite：它和侧边栏宽度一样属于窗口摆放，
// 不该进配置中心的可重置项，也不需要在多设备间同步。
function readCollapsed(): boolean {
    try {
        return localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
        return false;
    }
}

interface LayoutState {
    sidebarCollapsed: boolean;
    setSidebarCollapsed: (collapsed: boolean) => void;
    toggleSidebar: () => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
    sidebarCollapsed: readCollapsed(),
    setSidebarCollapsed: collapsed => {
        try {
            localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
        } catch {
            // 存储被禁用时只丢持久化，当前会话的折叠状态照常生效
        }
        set({sidebarCollapsed: collapsed});
    },
    toggleSidebar: () => get().setSidebarCollapsed(!get().sidebarCollapsed),
}));
