import {create} from 'zustand';
import {z} from 'zod';
import {message} from 'antd';
import {COMMAND_CATALOG, COMMAND_BY_ID, type CommandId} from './commands';
import {detectPlatform, type Platform} from '../utils/keybinding';

// 存储格式：两套独立的覆盖表（Windows/Linux 与 macOS）。
// 区分"没有覆盖"（键不存在，沿用出厂默认）与"用户显式解绑"（值为 null）。
const BindingMapSchema = z.record(z.string().min(1), z.string().min(1).nullable());

const ShortcutConfigSchema = z.object({
    version: z.literal(1),
    enabled: z.boolean(),
    windows: BindingMapSchema,
    mac: BindingMapSchema,
});

export type ShortcutConfig = z.infer<typeof ShortcutConfigSchema>;

const SETTINGS_KEY = 'shortcuts';

const CONFIG_VERSION = 1;

function emptyConfig(): ShortcutConfig {
    return {version: CONFIG_VERSION, enabled: true, windows: {}, mac: {}};
}

// 任何一处不合法都整体回退到默认配置：快捷键是全局交互基础件，
// 部分损坏的配置比回退默认更容易造成"按键错乱"且难以自恢复。
function parseConfig(raw: string | null | undefined): ShortcutConfig | null {
    if (!raw) {
        return null;
    }
    try {
        const parsed = ShortcutConfigSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) {
            return null;
        }
        const known = new Set(COMMAND_CATALOG.map(meta => meta.id as string));
        const prune = (map: Record<string, string | null>) => {
            const next: Record<string, string | null> = {};
            Object.entries(map).forEach(([key, value]) => {
                if (known.has(key)) {
                    next[key] = value;
                }
            });
            return next;
        };
        return {
            version: CONFIG_VERSION,
            enabled: parsed.data.enabled,
            windows: prune(parsed.data.windows),
            mac: prune(parsed.data.mac),
        };
    } catch {
        return null;
    }
}

interface ShortcutState {
    platform: Platform;
    config: ShortcutConfig;
    ready: boolean;
    load: () => Promise<void>;
    /** 返回是否真正落库：界面据此决定要不要报「已保存」这类成功提示。 */
    setBinding: (id: CommandId, binding: string | null) => Promise<boolean>;
    resetOne: (id: CommandId) => Promise<boolean>;
    resetAll: () => Promise<boolean>;
    setEnabled: (enabled: boolean) => Promise<boolean>;
    exportConfig: () => string;
    /** async：解析与落库都可能失败，返回真实结果，不再无条件 success:true。 */
    importConfig: (raw: string) => Promise<{success: boolean; error?: string}>;
}

// rpc 永不 reject：写库失败只体现在 response.success === false，
// 所以必须判 success，不能只靠 catch（那样 catch 永远不会触发）。
// 返回是否真的落库；showError=false 用于 importConfig——那一路由调用点统一弹提示，避免重复。
async function persist(config: ShortcutConfig, showError = true): Promise<boolean> {
    try {
        const response = await window.electronAPI.settings.set(SETTINGS_KEY, JSON.stringify(config));
        if (response.success) {
            return true;
        }
        console.error('[shortcut] persist failed', response.error);
        if (showError) {
            message.error(`快捷键保存失败：${response.error || '写入配置失败'}，本次改动仅在当前会话生效`);
        }
        return false;
    } catch (error) {
        // transport 层真的抛异常时也要反馈，而不是静默吞掉。
        console.error('[shortcut] persist failed', error);
        if (showError) {
            message.error(`快捷键保存失败：${error instanceof Error ? error.message : String(error)}`);
        }
        return false;
    }
}

export const useShortcutStore = create<ShortcutState>((set, get) => ({
    platform: detectPlatform(),
    config: emptyConfig(),
    ready: false,

    load: async () => {
        try {
            const response = await window.electronAPI.settings.get(SETTINGS_KEY);
            const parsed = response.success ? parseConfig(response.data) : null;
            set({config: parsed ?? emptyConfig(), ready: true});
        } catch (error) {
            console.error('[shortcut] load failed, using defaults', error);
            set({config: emptyConfig(), ready: true});
        }
    },

    setBinding: async (id, binding) => {
        const current = get();
        const config: ShortcutConfig = {
            ...current.config,
            [current.platform]: {...current.config[current.platform], [id]: binding},
        };
        set({config});
        return persist(config);
    },

    resetOne: async id => {
        const current = get();
        const next = {...current.config[current.platform]};
        delete next[id];
        const config: ShortcutConfig = {...current.config, [current.platform]: next};
        set({config});
        return persist(config);
    },

    resetAll: async () => {
        const config = emptyConfig();
        set({config});
        return persist(config);
    },

    setEnabled: async enabled => {
        const config = {...get().config, enabled};
        set({config});
        return persist(config);
    },

    exportConfig: () => JSON.stringify(get().config, null, 2),

    importConfig: async raw => {
        const parsed = parseConfig(raw);
        if (!parsed) {
            return {success: false, error: '配置文件格式无效或版本不受支持'};
        }
        set({config: parsed});
        // 等落库结果再回报：写库失败就是导入失败，不能无条件 success:true。
        // 不在这里弹 toast，交给调用点按 result 统一提示，避免重复。
        const ok = await persist(parsed, false);
        return ok ? {success: true} : {success: false, error: '配置写入失败，改动仅在当前会话生效'};
    },
}));

/** 当前平台下某命令实际生效的绑定：覆盖值优先，其次出厂默认。 */
export function resolveBinding(config: ShortcutConfig, platform: Platform, id: CommandId): string | null {
    const overrides = config[platform];
    if (Object.prototype.hasOwnProperty.call(overrides, id)) {
        return overrides[id] ?? null;
    }
    return COMMAND_BY_ID[id].defaults[platform];
}

export function isDefaultBinding(config: ShortcutConfig, platform: Platform, id: CommandId): boolean {
    return !Object.prototype.hasOwnProperty.call(config[platform], id);
}

/**
 * 冲突表：commandId -> 与之重复的其它 commandId 列表。
 * 只统计当前平台，且忽略已解绑（null）的条目。
 */
export function findConflicts(config: ShortcutConfig, platform: Platform): Partial<Record<CommandId, CommandId[]>> {
    const byBinding = new Map<string, CommandId[]>();
    COMMAND_CATALOG.forEach(meta => {
        const binding = resolveBinding(config, platform, meta.id);
        if (!binding) {
            return;
        }
        const list = byBinding.get(binding) ?? [];
        list.push(meta.id);
        byBinding.set(binding, list);
    });
    const conflicts: Partial<Record<CommandId, CommandId[]>> = {};
    byBinding.forEach(ids => {
        if (ids.length > 1) {
            ids.forEach(id => {
                conflicts[id] = ids.filter(other => other !== id);
            });
        }
    });
    return conflicts;
}
