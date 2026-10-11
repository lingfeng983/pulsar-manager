import {create} from 'zustand';

export type ThemeType = 'light' | 'dark' | 'eyeCare';

const THEME_STORAGE_KEY = 'pulsar-manager.theme';

const isThemeType = (value: unknown): value is ThemeType =>
    value === 'light' || value === 'dark' || value === 'eyeCare';

// 主进程里的主题是权威值，但取它要走一次异步 IPC，首帧必然晚于 React 渲染。
// 这里在 localStorage 留一份同步副本，让首帧就能带上正确的 data-theme——否则暗色
// 用户每次启动都会先白屏闪一下（zIndex 最高的 body 背景仍是亮色）。
export function readPersistedTheme(): ThemeType | null {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeType(stored) ? stored : null;
}

interface ThemeState {
    theme: ThemeType;
    setTheme: (theme: ThemeType) => void;
}

export function applyTheme(theme: ThemeType): void {
    document.documentElement.setAttribute('data-theme', theme);
}

export const useThemeStore = create<ThemeState>(set => ({
    theme: readPersistedTheme() ?? 'light',
    setTheme: theme => {
        set({theme});
        localStorage.setItem(THEME_STORAGE_KEY, theme);
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
                if (isThemeType(persisted)) {
                    useThemeStore.setState({theme: persisted});
                }
            }
        })
        .catch(() => {});
}
