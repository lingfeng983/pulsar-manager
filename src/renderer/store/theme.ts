import {create} from 'zustand';

export type ThemeType = 'light' | 'dark' | 'eyeCare';

interface ThemeState {
    theme: ThemeType;
    setTheme: (theme: ThemeType) => void;
}

export function applyTheme(theme: ThemeType): void {
    document.documentElement.setAttribute('data-theme', theme);
}

export const useThemeStore = create<ThemeState>(set => ({
    theme: 'light',
    setTheme: theme => {
        set({theme});
        // 主进程落库失败不该打断界面切换，这里只留一次静默回写。
        window.electronAPI?.theme.set(theme).catch(() => {});
    },
}));

// zustand 在 set() 内同步通知订阅者，且订阅早于组件挂载，
// 所以这里写属性一定先于任何一次 re-render —— 子组件 render 时读到的就是新主题的变量。
useThemeStore.subscribe(state => applyTheme(state.theme));

export function loadPersistedTheme(): void {
    window.electronAPI?.theme
        .get()
        .then(response => {
            if (response.success && response.data) {
                const persisted = response.data as ThemeType;
                if (persisted === 'light' || persisted === 'dark' || persisted === 'eyeCare') {
                    useThemeStore.setState({theme: persisted});
                }
            }
        })
        .catch(() => {});
}
