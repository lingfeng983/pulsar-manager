/**
 * 插件系统：本地声明式扩展，只贡献数据（压测预设、Topic 模板），不加载也不执行
 * 插件携带的任何代码——所以一个坏插件最多让某条预设消失，不可能把应用带崩。
 *
 * 加载路径统一为 userData/plugins 下的 JSON 文件（`plugins/x.json` 或
 * `plugins/<目录>/plugin.json`），官方目录里的条目点"安装"后走的是同一条路。
 */
import fs from 'fs';
import path from 'path';
import {app} from 'electron';
import {z} from 'zod';
import {getSetting, setSetting} from '../database/sqlite';
import {createLogger} from '../utils/logger';
import {OFFICIAL_PLUGINS} from './official-plugins';
import type {PluginEntry, PluginListResult, PluginLoadError, PluginManifest} from '../../shared/types';

const log = createLogger('Plugins');

const DISABLED_KEY = 'disabledPlugins';

const PluginManifestSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/, 'id 需为 2~64 位小写字母、数字、点、下划线或连字符'),
    name: z.string().min(1).max(60),
    version: z.string().regex(/^\d+\.\d+(\.\d+)?$/, 'version 需形如 1.0 或 1.0.0'),
    description: z.string().max(200).optional(),
    author: z.string().max(60).optional(),
    contributions: z
        .object({
            benchmarkPresets: z
                .array(
                    z.object({
                        name: z.string().min(1).max(40),
                        description: z.string().max(120).optional(),
                        params: z.object({
                            producers: z.number().int().min(1).max(64),
                            totalMessages: z.number().int().min(1).max(10000000),
                            messageSizeBytes: z.number().int().min(1).max(10485760),
                            ratePerSecond: z.number().int().min(0).max(1000000),
                            maxInFlightPerProducer: z.number().int().min(1).max(10000),
                            batchingEnabled: z.boolean(),
                            compression: z.enum(['None', 'LZ4', 'Zlib', 'SNAPPY', 'ZSTD']),
                            consumeBacklog: z.boolean(),
                        }),
                    }),
                )
                .max(20)
                .optional(),
            topicTemplates: z
                .array(
                    z.object({
                        name: z.string().min(1).max(40),
                        description: z.string().max(120).optional(),
                        persistent: z.boolean(),
                        partitions: z.number().int().min(0).max(128),
                        namePrefix: z
                            .string()
                            .regex(/^[a-zA-Z0-9._-]{0,40}$/, 'namePrefix 只允许字母、数字、点、下划线和连字符')
                            .optional(),
                    }),
                )
                .max(20)
                .optional(),
        })
        .refine(value => (value.benchmarkPresets?.length ?? 0) + (value.topicTemplates?.length ?? 0) > 0, {
            message: '插件至少要贡献一条压测预设或 Topic 模板',
        }),
});

export function getPluginsDir(): string {
    return path.join(app.getPath('userData'), 'plugins');
}

function ensurePluginsDir(): string {
    const dir = getPluginsDir();
    fs.mkdirSync(dir, {recursive: true});
    return dir;
}

// 把外部传入的相对路径钉在插件目录里：越界的一律返回 null，由调用方按"没装"处理。
// 校验放在服务层而不是只放 IPC，是因为卸载走的是递归删除。
function insidePluginsDir(dir: string, relative: string): string | null {
    const target = path.resolve(dir, relative);
    const root = path.resolve(dir) + path.sep;
    return target.startsWith(root) ? target : null;
}

/** 解析并校验一份插件 JSON；返回 manifest 或人话形式的失败原因。 */
export function parsePluginManifest(raw: string): {manifest: PluginManifest} | {error: string} {
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch (error) {
        return {error: `不是合法的 JSON：${(error as Error).message}`};
    }
    const parsed = PluginManifestSchema.safeParse(json);
    if (!parsed.success) {
        const first = parsed.error.issues[0];
        return {error: `${first.path.join('.') || '插件'}: ${first.message}`};
    }
    // tsconfig.node.json 关掉了 strict，z.infer 会把所有字段推成可选；
    // 上面已经整体校验过，这里只是把形状交还给 shared 类型。
    return {manifest: parsed.data as PluginManifest};
}

interface DiscoveredFile {
    id: string;
    file: string;
    manifest: PluginManifest;
}

function scanInstalled(): {found: DiscoveredFile[]; errors: PluginLoadError[]} {
    const dir = getPluginsDir();
    const found: DiscoveredFile[] = [];
    const errors: PluginLoadError[] = [];
    if (!fs.existsSync(dir)) {
        return {found, errors};
    }
    const candidates: string[] = [];
    for (const item of fs.readdirSync(dir, {withFileTypes: true})) {
        if (item.isFile() && item.name.toLowerCase().endsWith('.json')) {
            candidates.push(path.join(dir, item.name));
        } else if (item.isDirectory()) {
            const nested = path.join(dir, item.name, 'plugin.json');
            if (fs.existsSync(nested)) {
                candidates.push(nested);
            } else {
                errors.push({file: item.name + '/plugin.json', reason: '目录里没有 plugin.json'});
            }
        }
    }
    for (const file of candidates) {
        let raw: string;
        try {
            raw = fs.readFileSync(file, 'utf8');
        } catch (error) {
            errors.push({file: path.basename(file), reason: `读取失败：${(error as Error).message}`});
            continue;
        }
        const result = parsePluginManifest(raw);
        if ('error' in result) {
            errors.push({file: path.basename(file), reason: result.error});
            continue;
        }
        found.push({id: result.manifest.id, file, manifest: result.manifest});
    }
    return {found, errors};
}

function readDisabledIds(): string[] {
    const raw = getSetting(DISABLED_KEY);
    if (!raw) {
        return [];
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
        return [];
    }
}

function writeDisabledIds(ids: string[]): void {
    setSetting(DISABLED_KEY, JSON.stringify(ids));
}

export function listPlugins(): PluginListResult {
    const {found, errors} = scanInstalled();
    const disabled = new Set(readDisabledIds());
    const installedById = new Map(found.map(item => [item.id, item]));
    const entries: PluginEntry[] = [];

    for (const official of OFFICIAL_PLUGINS) {
        const local = installedById.get(official.id);
        // 本地装了同 id 的插件就以本地文件为准（可覆盖官方默认值），
        // 但来源仍标官方——否则用户点完"安装"后卡片会突然变成另一个插件。
        const manifest = local ? local.manifest : official;
        entries.push({
            ...manifest,
            source: 'official',
            installed: !!local,
            enabled: !!local && !disabled.has(manifest.id),
        });
        if (local) {
            installedById.delete(official.id);
        }
    }
    for (const item of installedById.values()) {
        entries.push({
            ...item.manifest,
            source: 'local',
            installed: true,
            enabled: !disabled.has(item.manifest.id),
        });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return {entries, errors, pluginsDir: getPluginsDir()};
}

function writePluginFile(manifest: PluginManifest): void {
    const dir = ensurePluginsDir();
    fs.writeFileSync(path.join(dir, `${manifest.id}.json`), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export function installOfficialPlugin(id: string): PluginEntry {
    const official = OFFICIAL_PLUGINS.find(item => item.id === id);
    if (!official) {
        throw new Error(`官方目录里没有插件 ${id}`);
    }
    writePluginFile(official);
    const entry = listPlugins().entries.find(item => item.id === id);
    if (!entry) {
        throw new Error('安装后未能加载该插件');
    }
    log.info(`installed official plugin ${id} v${official.version}`);
    return entry;
}

export function installPluginFromText(raw: string): PluginEntry {
    const result = parsePluginManifest(raw);
    if ('error' in result) {
        throw new Error(`插件文件无效：${result.error}`);
    }
    writePluginFile(result.manifest);
    const entry = listPlugins().entries.find(item => item.id === result.manifest.id);
    if (!entry) {
        throw new Error('安装后未能加载该插件');
    }
    log.info(`imported plugin ${result.manifest.id} v${result.manifest.version}`);
    return entry;
}

export function uninstallPlugin(id: string): void {
    const dir = getPluginsDir();
    const flat = insidePluginsDir(dir, `${id}.json`);
    const nested = insidePluginsDir(dir, id);
    let removed = false;
    if (flat && fs.existsSync(flat)) {
        fs.rmSync(flat);
        removed = true;
    }
    if (nested && fs.existsSync(nested)) {
        fs.rmSync(nested, {recursive: true, force: true});
        removed = true;
    }
    if (!removed) {
        throw new Error(`${id} 没有安装在本机，无需卸载`);
    }
    writeDisabledIds(readDisabledIds().filter(item => item !== id));
    log.info(`uninstalled plugin ${id}`);
}

export function setPluginEnabled(id: string, enabled: boolean): PluginEntry {
    const entry = listPlugins().entries.find(item => item.id === id);
    if (!entry) {
        throw new Error(`插件 ${id} 不存在`);
    }
    if (!entry.installed) {
        throw new Error('先安装后才能启用');
    }
    const disabled = new Set(readDisabledIds());
    if (enabled) {
        disabled.delete(id);
    } else {
        disabled.add(id);
    }
    writeDisabledIds([...disabled]);
    const next = listPlugins().entries.find(item => item.id === id);
    if (!next) {
        throw new Error('状态更新后未能加载该插件');
    }
    return next;
}
