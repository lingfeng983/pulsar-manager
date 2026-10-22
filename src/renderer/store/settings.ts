import {create} from 'zustand';
import type {AppSettings, FontSizeLevel} from '../types';

// 默认值与主进程 app-config 里的 APP_CONFIG_DEFAULTS 必须一致：
// 这里只是 IPC 失败时的兜底显示，真正生效的取值始终由主进程读库给出。
export const DEFAULT_SETTINGS: AppSettings = {
    truncateLength: 50,
    logDirectory: '',
    autoRefresh: true,
    refreshIntervalSeconds: 30,
    fontSize: 'large',
    statusRefreshSeconds: 60,
    // 与 pm-pulsar 的 DEFAULT_ADMIN_CONCURRENCY 保持一致（主进程默认表也取自它）
    adminConcurrencyLimit: 8,
    sendHistoryFullBody: false,
    metricsSnapshotEnabled: false,
    metricsRetentionDays: 7,
    alertEnabled: false,
    alertCheckSeconds: 60,
    alertRetentionDays: 30,
    // 更新：空串代理 = 直连；自动检查只标点、不弹窗
    updateProxy: '',
    updateAutoCheck: true,
};

// 字号档位写成 <html data-font-size>，index.css 里三档 --font-size-* 随之切换。
// 和主题一样：zustand 在 set() 内同步通知订阅者，且订阅早于组件挂载，
// 所以页面 render 阶段读 CSS 变量时拿到的已经是新档位的值。
function applyFontSize(level: FontSizeLevel): void {
    document.documentElement.setAttribute('data-font-size', level);
}

interface SettingsState {
    settings: AppSettings;
    ready: boolean;
    load: () => Promise<void>;
    /** 成功返回落库后的完整配置，失败返回原因——界面不猜，也不留下与库里不一致的显示值。 */
    update: (patch: Partial<AppSettings>) => Promise<{ok: true; settings: AppSettings} | {ok: false; error: string}>;
    reset: () => Promise<{ok: true; settings: AppSettings} | {ok: false; error: string}>;
}

export const useSettingsStore = create<SettingsState>(set => ({
    settings: DEFAULT_SETTINGS,
    ready: false,

    load: async () => {
        try {
            const response = await window.electronAPI.config.getAll();
            if (response.success && response.data) {
                set({settings: response.data, ready: true});
                return;
            }
        } catch {
            // 落到下面的 ready:true，界面按默认值显示
        }
        set({ready: true});
    },

    update: async patch => {
        try {
            const response = await window.electronAPI.config.update(patch);
            if (response.success && response.data) {
                set({settings: response.data});
                return {ok: true as const, settings: response.data};
            }
            return {ok: false as const, error: response.error || '保存失败'};
        } catch (error) {
            return {ok: false as const, error: (error as Error).message};
        }
    },

    reset: async () => {
        try {
            const response = await window.electronAPI.config.reset();
            if (response.success && response.data) {
                set({settings: response.data});
                return {ok: true as const, settings: response.data};
            }
            return {ok: false as const, error: response.error || '恢复默认失败'};
        } catch (error) {
            return {ok: false as const, error: (error as Error).message};
        }
    },
}));

applyFontSize(useSettingsStore.getState().settings.fontSize);
useSettingsStore.subscribe(state => applyFontSize(state.settings.fontSize));

export function loadAppSettings(): void {
    void useSettingsStore.getState().load();
}
