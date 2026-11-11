import {create} from 'zustand';
import {message} from 'antd';
import type {APIResponse, BenchmarkPreset, PluginEntry, PluginLoadError, TopicTemplate} from '../types';

// 启动期 load 可能被多处触发，同一个插件读取故障只弹一次，避免刷屏。
// 模块级状态，整个应用生命周期内去重；成功路径不碰它。
let loadFailureNotified = false;
function notifyLoadFailure(): void {
    if (loadFailureNotified) {
        return;
    }
    loadFailureNotified = true;
    message.error('读取插件列表失败，界面将按「无插件」显示');
}

export interface PresetOption {
    pluginId: string;
    pluginName: string;
    preset: BenchmarkPreset;
}

export interface TemplateOption {
    pluginId: string;
    pluginName: string;
    template: TopicTemplate;
}

interface PluginsState {
    entries: PluginEntry[];
    errors: PluginLoadError[];
    pluginsDir: string;
    ready: boolean;
    /** 启用插件贡献的压测预设，BenchmarkModal 的下拉直接吃这个 */
    presets: PresetOption[];
    /** 启用插件贡献的 Topic 模板，TopicFormModal 用 */
    templates: TemplateOption[];
    load: () => Promise<void>;
    /** 所有改动型操作统一回 {ok, error?}，界面不猜成功与否 */
    run: (action: () => Promise<APIResponse>) => Promise<{ok: boolean; error?: string}>;
}

function deriveActive(entries: PluginEntry[]): {presets: PresetOption[]; templates: TemplateOption[]} {
    const presets: PresetOption[] = [];
    const templates: TemplateOption[] = [];
    for (const entry of entries) {
        if (!entry.enabled) {
            continue;
        }
        for (const preset of entry.contributions.benchmarkPresets ?? []) {
            presets.push({pluginId: entry.id, pluginName: entry.name, preset});
        }
        for (const template of entry.contributions.topicTemplates ?? []) {
            templates.push({pluginId: entry.id, pluginName: entry.name, template});
        }
    }
    return {presets, templates};
}

export const usePluginStore = create<PluginsState>((set, get) => ({
    entries: [],
    errors: [],
    pluginsDir: '',
    ready: false,
    presets: [],
    templates: [],

    load: async () => {
        try {
            const response = await window.electronAPI.plugin.list();
            if (response.success && response.data) {
                const {entries, errors, pluginsDir} = response.data;
                set({entries, errors, pluginsDir, ...deriveActive(entries), ready: true});
                return;
            }
        } catch {
            // 落到 ready:true：插件读不到只影响预设，不该把界面卡住
        }
        // success:false 或 transport 异常都按失败处理：提示用户，再按空插件显示。
        notifyLoadFailure();
        set({ready: true});
    },

    run: async action => {
        try {
            const response = await action();
            if (!response.success) {
                return {ok: false, error: response.error || '操作失败'};
            }
            await get().load();
            return {ok: true};
        } catch (error) {
            return {ok: false, error: (error as Error).message};
        }
    },
}));

export function loadPlugins(): void {
    void usePluginStore.getState().load();
}
