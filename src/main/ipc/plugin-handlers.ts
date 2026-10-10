import {shell} from 'electron';
import {z} from 'zod';
import {
    getPluginsDir,
    installOfficialPlugin,
    installPluginFromText,
    listPlugins,
    setPluginEnabled,
    uninstallPlugin,
} from '../services/plugin-service';
import {ensureDbInitialized, insertOperationLog, registerHandler} from './_shared';
import {createLogger} from '../utils/logger';

const log = createLogger('IPC');

const PluginIdSchema = z.object({id: z.string().min(1).max(80)});
const PluginToggleSchema = z.object({id: z.string().min(1).max(80), enabled: z.boolean()});
const PluginTextSchema = z.object({text: z.string().min(1).max(200000)});

function requireObject<T>(schema: z.ZodType<T>, params: unknown, what: string): T {
    const parsed = schema.safeParse(params);
    if (!parsed.success) {
        throw new Error(`Invalid ${what}`);
    }
    return parsed.data;
}

function logPluginAction(action: string, id: string, details: string) {
    insertOperationLog({
        cluster_id: null,
        action,
        resource_type: 'plugin',
        resource_id: id,
        resource_name: id,
        details,
        result: 'success',
    });
}

export function registerPluginHandlers() {
    registerHandler('plugin:list', async () => {
        ensureDbInitialized();
        return listPlugins();
    });

    registerHandler('plugin:installOfficial', async (params: unknown) => {
        ensureDbInitialized();
        const {id} = requireObject(PluginIdSchema, params, 'plugin id');
        const entry = installOfficialPlugin(id);
        logPluginAction('create', id, `安装插件 ${entry.name} v${entry.version}`);
        return entry;
    });

    // 渲染层把文件读成文本发过来，主进程只认内容——不碰文件路径，避免被指到任意文件
    registerHandler('plugin:import', async (params: unknown) => {
        ensureDbInitialized();
        const {text} = requireObject(PluginTextSchema, params, 'plugin text');
        const entry = installPluginFromText(text);
        logPluginAction('create', entry.id, `导入插件文件 ${entry.name} v${entry.version}`);
        return entry;
    });

    registerHandler('plugin:uninstall', async (params: unknown) => {
        ensureDbInitialized();
        const {id} = requireObject(PluginIdSchema, params, 'plugin id');
        uninstallPlugin(id);
        logPluginAction('delete', id, `卸载插件 ${id}`);
        return {id};
    });

    registerHandler('plugin:setEnabled', async (params: unknown) => {
        ensureDbInitialized();
        const input = requireObject(PluginToggleSchema, params, 'plugin toggle params');
        return setPluginEnabled(input.id, input.enabled);
    });

    registerHandler('plugin:revealDir', async () => {
        ensureDbInitialized();
        const dir = getPluginsDir();
        log.info(`opening plugins dir ${dir}`);
        // openPath 失败不抛异常，只回一句错误文本
        const failure = await shell.openPath(dir);
        return {dir, failure: failure || null};
    });
}
