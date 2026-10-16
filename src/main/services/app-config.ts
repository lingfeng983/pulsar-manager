/**
 * 应用级配置的唯一出处：哪些设置键真实存在、取值范围、默认值、导出与导入的形状。
 *
 * 配置中心页、导出文件、导入校验都从这里拿 schema，避免"界面上能改的键"
 * 与"落库的键"两处各写一套而对不上号。
 */
import {randomUUID} from 'crypto';
import path from 'path';
import {app} from 'electron';
import {z} from 'zod';
import {
    getAllClusters,
    getAllSSHTunnels,
    getDatabase,
    getSetting,
    insertCluster,
    insertSSHTunnel,
    runInTransaction,
    setSetting,
} from '../database/sqlite';
import {createLogger} from '../utils/logger';
import type {AppSettings, ConfigBundle, ConfigImportResult, ExportedClusterConfig} from '../../shared/types';

const log = createLogger('AppConfig');

export const APP_CONFIG_DEFAULTS: AppSettings = {
    truncateLength: 50,
    autoRefresh: true,
    refreshIntervalSeconds: 30,
    fontSize: 'large',
    statusRefreshSeconds: 60,
    sendHistoryFullBody: false,
    metricsSnapshotEnabled: false,
    metricsRetentionDays: 7,
    alertEnabled: false,
    alertCheckSeconds: 60,
    alertRetentionDays: 30,
};

export const AppSettingsSchema = z.object({
    // 消息列表里正文的截断长度，MessageBrowser 真实使用
    truncateLength: z.number().int().min(20).max(500),
    // 监控页是否自动刷新；关掉等价于把间隔视为 0（手动）
    autoRefresh: z.boolean(),
    // 0 表示手动刷新，上限 10 分钟
    refreshIntervalSeconds: z.number().int().min(0).max(600),
    // 全局字号档位
    fontSize: z.enum(['small', 'medium', 'large', 'xlarge']),
    // 首页/侧边栏集群状态轮询间隔，0 表示只启动时探一次
    statusRefreshSeconds: z.number().int().min(0).max(3600),
    // 发送历史连带正文全文落库（写入方在 producer-handlers 的 recordSendHistory）
    sendHistoryFullBody: z.boolean(),
    // 监控曲线落库（写入方在 metrics-handlers 的 recordSnapshot）：默认关，
    // 开着它才会按刷新节奏往 SQLite 写点
    metricsSnapshotEnabled: z.boolean(),
    // 快照保留天数，写入与读取两侧都按它清
    metricsRetentionDays: z.number().int().min(1).max(90),
    // 告警引擎总开关：关掉时不挂定时器，规则与历史都照常保留
    alertEnabled: z.boolean(),
    // 评估间隔。下限 10 秒：命名空间与集群口径一次要发几十到上千个请求，
    // 再密就成 DDoS 了自己的 broker；上限 1 小时。
    alertCheckSeconds: z.number().int().min(10).max(3600),
    // 已恢复事件的保留天数（未恢复的事件不受它约束）
    alertRetentionDays: z.number().int().min(1).max(365),
});

type AppSettingsField = keyof AppSettings;

const FIELDS = Object.keys(APP_CONFIG_DEFAULTS) as AppSettingsField[];

// 库里存的是字符串：按字段类型解回来，解不出来就用默认值，
// 绝不让一个脏行把整份配置带崩。
function decodeField(field: AppSettingsField, raw: string | undefined): unknown {
    if (raw === undefined) {
        return undefined;
    }
    // 布尔项按字符串 true/false 解；以后再加布尔设置不用在这里补特例
    if (typeof APP_CONFIG_DEFAULTS[field] === 'boolean') {
        if (raw === 'true') return true;
        if (raw === 'false') return false;
        return undefined;
    }
    if (field === 'fontSize') {
        return raw;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? Math.trunc(value) : undefined;
}

export function readAppSettings(): AppSettings {
    const settings = {...APP_CONFIG_DEFAULTS} as AppSettings;
    for (const field of FIELDS) {
        const parsed = AppSettingsSchema.shape[field].safeParse(decodeField(field, getSetting(field)));
        if (parsed.success) {
            // 各字段各自的类型由 AppSettingsSchema 保证，这里只做同构赋值
            (settings as unknown as Record<string, unknown>)[field] = parsed.data;
        }
    }
    return settings;
}

/** 只写入参里出现的键（partial update），返回落库后的完整配置。 */
export function writeAppSettings(patch: Partial<AppSettings>): AppSettings {
    const parsed = AppSettingsSchema.partial().strict().parse(patch);
    for (const [key, value] of Object.entries(parsed)) {
        setSetting(key, String(value));
    }
    return readAppSettings();
}

export function resetAppSettings(): AppSettings {
    return writeAppSettings({...APP_CONFIG_DEFAULTS});
}

// ========== 导出 / 导入 ==========

export const EXPORT_FORMAT = 'pulsar-manager-config';
export const EXPORT_VERSION = 1;

// 集群地址的协议白名单。导入文件与 IPC 边界共用同一份：界面上有同样的校验，
// 但渲染层不可信，只靠表单校验挡不住直接调 IPC 的请求。
export const SERVICE_URL_PATTERN = /^(pulsar|pulsar\+ssl|ssl):\/\/[^\s]+$/;
export const WEB_URL_PATTERN = /^https?:\/\/[^\s]+$/;

// 导出的集群**刻意不含任何凭据**：auth_params / 私钥 / 密码在库里是加密存的，
// 导出文件却是要拷来拷去的明文，所以这里只留"是否配置过"的信息，
// 导入后由用户在集群表单里补一次凭据。
const ExportedSshSchema = z.object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1).max(128),
    authType: z.enum(['password', 'privateKey']),
    remoteHost: z.string().max(253).nullable().optional(),
    remoteAdminPort: z.number().int().min(1).max(65535).nullable().optional(),
    remoteBrokerPort: z.number().int().min(1).max(65535).nullable().optional(),
});

const ExportedClusterSchema = z.object({
    name: z.string().min(1).max(64),
    serviceUrl: z.string().regex(SERVICE_URL_PATTERN),
    webServiceUrl: z.string().regex(WEB_URL_PATTERN).nullable().optional(),
    authPlugin: z.string().max(256).nullable().optional(),
    tlsEnabled: z.boolean(),
    adminApiTimeout: z.number().int().min(1000).max(120000),
    ssh: ExportedSshSchema.nullable().optional(),
});

// 快捷键覆盖表沿用渲染层的形状（version/enabled/windows/mac），
// 这里只校验到"是个可解析的对象"，具体命令名由渲染层裁剪。
const ExportedShortcutsSchema = z.object({
    version: z.literal(1),
    enabled: z.boolean(),
    windows: z.record(z.string().min(1), z.string().min(1).nullable()),
    mac: z.record(z.string().min(1), z.string().min(1).nullable()),
});

// 校验用的 schema 与共享类型（src/shared/types.ts）在这里各写一份是有意为之：
// schema 管运行时接受什么，共享类型管渲染层看到什么。主进程 tsconfig 是 strict:false，
// zod 的类型推导会退化成"全字段可选"，所以校验通过后一律显式断言回共享类型——
// 运行时已经保证字段齐了，推导器只是看不见。
export const ConfigImportSchema = z.object({
    format: z.literal(EXPORT_FORMAT),
    version: z.literal(EXPORT_VERSION),
    // fontSize 是后加的一档：之前导出的文件里没有这个键，缺省时保持当前档位而不是整包报错
    // statusRefreshSeconds / sendHistoryFullBody / metricsSnapshot* 同理——老导出文件里没有它们，
    // 缺省用当前值而不是拒收整包
    settings: AppSettingsSchema.extend({
        fontSize: AppSettingsSchema.shape.fontSize.optional(),
        statusRefreshSeconds: AppSettingsSchema.shape.statusRefreshSeconds.optional(),
        sendHistoryFullBody: AppSettingsSchema.shape.sendHistoryFullBody.optional(),
        metricsSnapshotEnabled: AppSettingsSchema.shape.metricsSnapshotEnabled.optional(),
        metricsRetentionDays: AppSettingsSchema.shape.metricsRetentionDays.optional(),
        // 告警三项同理：老导出文件里没有它们，缺省时保持当前值而不是拒收整包
        alertEnabled: AppSettingsSchema.shape.alertEnabled.optional(),
        alertCheckSeconds: AppSettingsSchema.shape.alertCheckSeconds.optional(),
        alertRetentionDays: AppSettingsSchema.shape.alertRetentionDays.optional(),
    }),
    clusters: z.array(ExportedClusterSchema).max(200),
    shortcuts: ExportedShortcutsSchema.nullable().optional(),
});

export function parseConfigBundle(raw: unknown): {bundle: ConfigBundle} | {error: z.ZodError} {
    const parsed = ConfigImportSchema.safeParse(raw);
    return parsed.success ? {bundle: parsed.data as ConfigBundle} : {error: parsed.error};
}

export function buildConfigBundle(): ConfigBundle {
    const tunnels = new Map(getAllSSHTunnels().map(tunnel => [tunnel.id, tunnel]));
    const clusters: ExportedClusterConfig[] = [];
    for (const cluster of getAllClusters()) {
        const tunnel = cluster.ssh_config_id ? tunnels.get(cluster.ssh_config_id) : undefined;
        const candidate = {
            name: cluster.name,
            serviceUrl: cluster.service_url,
            webServiceUrl: cluster.web_service_url ?? null,
            authPlugin: cluster.auth_plugin ?? null,
            tlsEnabled: !!cluster.tls_enabled,
            adminApiTimeout: cluster.admin_api_timeout || 5000,
            ssh: tunnel
                ? {
                      host: tunnel.host,
                      port: tunnel.port,
                      username: tunnel.username,
                      authType: tunnel.auth_type === 'privateKey' ? ('privateKey' as const) : ('password' as const),
                      remoteHost: tunnel.remote_host ?? null,
                      remoteAdminPort: tunnel.remote_admin_port ?? null,
                      remoteBrokerPort: tunnel.remote_broker_port ?? null,
                  }
                : null,
        };
        // 库里可能留着老版本或手工写坏的地址：不过校验的一律不导出，
        // 否则整个文件在导入时被拒，一个坏行拖垮全部。
        const checked = ExportedClusterSchema.safeParse(candidate);
        if (checked.success) {
            clusters.push(checked.data as ExportedClusterConfig);
        } else {
            log.warn(`cluster ${cluster.name} is not exportable: ${checked.error.message}`);
        }
    }
    let shortcuts: ConfigBundle['shortcuts'] = null;
    const rawShortcuts = getSetting('shortcuts');
    if (rawShortcuts) {
        try {
            const parsed = ExportedShortcutsSchema.safeParse(JSON.parse(rawShortcuts));
            if (parsed.success) {
                shortcuts = parsed.data as ConfigBundle['shortcuts'];
            }
        } catch {
            // 快捷键行损坏时导出照常进行，只是不带这一项
            log.warn('shortcuts setting is not parseable, exporting without it');
        }
    }
    return {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        settings: readAppSettings(),
        clusters,
        shortcuts,
    };
}

/**
 * 导入只做"新增"：同名集群跳过而不是覆盖。
 * 覆盖会连带把已有集群的凭据清掉（导出不带凭据），用户点一下确认就可能丢配置。
 */
export function applyConfigBundle(bundle: ConfigBundle): ConfigImportResult {
    const result: ConfigImportResult = {
        settingsApplied: false,
        clustersImported: 0,
        clustersSkipped: [],
        tunnelsImported: 0,
        shortcutsApplied: false,
    };
    runInTransaction(() => {
        writeAppSettings(bundle.settings);
        result.settingsApplied = true;

        const existingNames = new Set(getAllClusters().map(cluster => cluster.name));
        for (const cluster of bundle.clusters) {
            if (existingNames.has(cluster.name)) {
                result.clustersSkipped.push(cluster.name);
                continue;
            }
            let sshConfigId: string | null = null;
            if (cluster.ssh) {
                sshConfigId = randomUUID();
                insertSSHTunnel({
                    id: sshConfigId,
                    host: cluster.ssh.host,
                    port: cluster.ssh.port,
                    username: cluster.ssh.username,
                    auth_type: cluster.ssh.authType,
                    // 凭据不随导出文件走，导入后为空，需在集群表单里补
                    password: null,
                    private_key: null,
                    passphrase: null,
                    local_admin_port: 0,
                    local_broker_port: 0,
                    remote_host: cluster.ssh.remoteHost ?? null,
                    remote_admin_port: cluster.ssh.remoteAdminPort ?? 8080,
                    remote_broker_port: cluster.ssh.remoteBrokerPort ?? 6650,
                    status: 'disconnected',
                });
                result.tunnelsImported += 1;
            }
            insertCluster({
                id: randomUUID(),
                name: cluster.name,
                service_url: cluster.serviceUrl,
                web_service_url: cluster.webServiceUrl ?? null,
                auth_plugin: cluster.authPlugin ?? null,
                auth_params: null,
                tls_enabled: cluster.tlsEnabled ? 1 : 0,
                tls_trust_certs: null,
                use_ssh_tunnel: sshConfigId ? 1 : 0,
                ssh_config_id: sshConfigId,
                admin_api_timeout: cluster.adminApiTimeout,
                status: 'disconnected',
            });
            existingNames.add(cluster.name);
            result.clustersImported += 1;
        }

        if (bundle.shortcuts) {
            setSetting('shortcuts', JSON.stringify(bundle.shortcuts));
            result.shortcutsApplied = true;
        }
    });
    return result;
}

// ========== 操作日志 ==========

export function clearOperationLogs(): number {
    return getDatabase().prepare('DELETE FROM operation_logs').run().changes;
}

export function getDatabaseFilePath(): string {
    return path.join(app.getPath('userData'), 'pulsar-manager.db');
}
