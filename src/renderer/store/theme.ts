import {create} from 'zustand';

/** 实际生效的三套主题。data-theme 只认这三个值。 */
export type ThemeType = 'light' | 'dark' | 'eyeCare';

/** 用户的偏好：三套主题之一，或跟随系统。 */
export type ThemePreference = ThemeType | 'system';

const THEME_STORAGE_KEY = 'pulsar-manager.theme';

const isThemeType = (value: unknown): value is ThemeType =>
    value === 'light' || value === 'dark' || value === 'eyeCare';

const isThemePreference = (value: unknown): value is ThemePreference => isThemeType(value) || value === 'system';

/** 系统当前是不是暗色。WebView2 里 matchMedia 直接反映 Windows 的应用模式设置。 */
function systemPrefersDark(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return false;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * 偏好 → 生效主题。
 * 「跟随系统」只在深浅两套之间选：护眼是应用自己的配色，系统层面没有对应信号。
 */
export function resolveTheme(preference: ThemePreference): ThemeType {
    if (preference !== 'system') {
        return preference;
    }
    return systemPrefersDark() ? 'dark' : 'light';
}

// 主进程里的主题是权威值，但取它要走一次异步 IPC，首帧必然晚于 React 渲染。
// 这里在 localStorage 留一份同步副本，让首帧就能带上正确的 data-theme——否则暗色
// 用户每次启动都会先白屏闪一下（zIndex 最高的 body 背景仍是亮色）。
// 跟随系统时 resolveTheme 在模块求值阶段就同步算好，首帧同样是正确的深色，不会闪。
export function readPersistedTheme(): ThemePreference | null {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : null;
}

interface ThemeState {
    /** 生效值：组件与 CSS 只认它（'light' | 'dark' | 'eyeCare'） */
    theme: ThemeType;
    /** 用户选的值，可能为 'system'；设置界面与菜单用它回显 */
    preference: ThemePreference;
    setTheme: (preference: ThemePreference) => void;
}

export function applyTheme(theme: ThemeType): void {
    document.documentElement.setAttribute('data-theme', theme);
}

const initialPreference: ThemePreference = readPersistedTheme() ?? 'light';

export const useThemeStore = create<ThemeState>(set => ({
    theme: resolveTheme(initialPreference),
    preference: initialPreference,
    setTheme: preference => {
        set({preference, theme: resolveTheme(preference)});
        localStorage.setItem(THEME_STORAGE_KEY, preference);
        // 主进程落库失败不该打断界面切换，这里只留一次静默回写。
        window.electronAPI?.theme.set(preference).catch(() => {});
    },
}));

// zustand 在 set() 内同步通知订阅者，且订阅早于组件挂载，
// 所以这里写属性一定先于任何一次 re-render —— 子组件 render 时读到的就是新主题的变量。
useThemeStore.subscribe(state => applyTheme(state.theme));

// 系统主题变化：只在偏好是「跟随系统」时才跟着换。监听器常驻、但读的是最新 state，
// 不会因为用户在设置里切走而失效。
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        const {preference} = useThemeStore.getState();
        if (preference === 'system') {
            useThemeStore.setState({theme: resolveTheme('system')});
        }
    });
}

export function loadPersistedTheme(): void {
    window.electronAPI?.theme
        .get()
        .then(response => {
            if (response.success && response.data) {
                const persisted = response.data;
                if (isThemePreference(persisted)) {
                    useThemeStore.setState({preference: persisted, theme: resolveTheme(persisted)});
                }
            }
        })
        .catch(() => {});
}
