import {ipcMain} from 'electron';
import type {IpcMainInvokeEvent} from 'electron';
import {z} from 'zod';
import {v4 as uuidv4} from 'uuid';
import {
    initDatabase,
    closeDatabase,
    getAllClusters,
    getClusterById,
    insertCluster,
    updateCluster,
    deleteCluster,
    getAllSSHTunnels,
    insertSSHTunnel,
    updateSSHTunnel,
    deleteSSHTunnel,
    getSetting,
    setSetting,
    insertOperationLog,
    runInTransaction,
} from '../database/sqlite';
import {encrypt, decrypt} from '../services/encryption';
import {PulsarAdminClient, clientManager} from '../services/pulsar-admin';
import {createLogger} from '../utils/logger';

const log = createLogger('IPC');

// Re-export everything that domain handlers may need
export {
    ipcMain,
    z,
    uuidv4,
    initDatabase,
    closeDatabase,
    getAllClusters,
    getClusterById,
    insertCluster,
    updateCluster,
    deleteCluster,
    getAllSSHTunnels,
    insertSSHTunnel,
    updateSSHTunnel,
    deleteSSHTunnel,
    getSetting,
    setSetting,
    insertOperationLog,
    runInTransaction,
    encrypt,
    decrypt,
    PulsarAdminClient,
    clientManager,
};

// Zod schemas for validation
export const ClusterConfigSchema = z.object({
    name: z.string().min(1),
    serviceUrl: z.string().min(1),
    webServiceUrl: z.string().optional().nullable(),
    authPlugin: z.string().optional().nullable(),
    authParams: z.string().optional().nullable(),
    tlsEnabled: z.boolean().optional().nullable(),
    tlsTrustCerts: z.string().optional().nullable(),
    useSshTunnel: z.boolean().optional().nullable(),
    sshConfigId: z.string().optional().nullable(),
    adminApiTimeout: z.number().optional().nullable(),
});

export const ClusterTestSchema = z.object({
    serviceUrl: z.string().min(1),
    webServiceUrl: z.string().optional().nullable(),
    authPlugin: z.string().optional().nullable(),
    authParams: z.string().optional().nullable(),
    adminApiTimeout: z.number().optional().nullable(),
});

export const SSHConfigSchema = z.object({
    host: z.string().min(1),
    port: z.number().min(1).max(65535).optional(),
    username: z.string().min(1),
    authType: z.enum(['password', 'privateKey']),
    password: z.string().optional(),
    privateKey: z.string().optional(),
    passphrase: z.string().optional(),
    remoteHost: z.string().optional(),
    remoteAdminPort: z.number().optional(),
    remoteBrokerPort: z.number().optional(),
});

// 通用验证 schema
export const ClusterIdSchema = z.string().min(1).uuid();

export const TenantSchema = z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/);

export const NamespaceSchema = z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9._-]+$/);

// Topic / Subscription 名称必须限制字符集：这些值会被拼进 Admin API 路径，
// 允许 "/" 或 ".." 会导致请求落到非预期资源上。
export const TopicSchema = z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9._-]+$/);

export const SubscriptionSchema = z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9._-]+$/);

// 持久 / 非持久在 Admin API 里是两段不同的路径前缀。缺省沿用历史行为（持久），
// 这样尚未传该参数的旧调用不会突然 404。
export const PersistentSchema = z.boolean().default(true);

export const TopicPathSchema = z.object({
    clusterId: ClusterIdSchema,
    tenant: TenantSchema,
    namespace: NamespaceSchema,
    topic: TopicSchema,
    persistent: PersistentSchema,
});

export const SubscriptionPathSchema = TopicPathSchema.extend({
    subscription: SubscriptionSchema,
});

export const SkipMessagesSchema = SubscriptionPathSchema.extend({
    count: z.number().int().positive().max(100000),
});

export const ResetCursorSchema = SubscriptionPathSchema.extend({
    position: z.enum(['earliest', 'latest', 'timestamp']),
    timestamp: z.number().int().positive().optional().nullable(),
});

// 订阅类型由第一个连上来的 consumer 决定，Admin 侧没有写入口；
// 创建订阅时唯一能指定的是起始读取位置。大小写按 broker 的枚举字面量归一化。
const INITIAL_POSITIONS = ['Latest', 'Earliest'] as const;

export const InitialPositionSchema = z
    .string()
    .transform(value => value.trim().toLowerCase())
    .refine(value => INITIAL_POSITIONS.some(position => position.toLowerCase() === value), {
        message: 'Unsupported initial position',
    })
    .transform(value => INITIAL_POSITIONS.find(position => position.toLowerCase() === value)!);

export const CreateSubscriptionSchema = SubscriptionPathSchema.extend({
    initialPosition: InitialPositionSchema.optional().default('Latest'),
});

// 只有这三项存在 topic 级写入口；.strict() 让表单里那些改不动的策略
// 在参数校验阶段就报错，而不是"提交成功但值没变"。
export const TopicConfigPatchSchema = z
    .object({
        retentionTimeInMinutes: z
            .number()
            .int()
            .min(0)
            .max(365 * 24 * 60),
        retentionSizeInMB: z
            .number()
            .int()
            .min(0)
            .max(1024 * 1024),
        numPartitions: z.number().int().min(0).max(1000),
    })
    .strict();

export const NamespacePathSchema = z.object({
    clusterId: ClusterIdSchema,
    tenant: TenantSchema,
    namespace: NamespaceSchema,
});

export const TenantPathSchema = z.object({
    clusterId: ClusterIdSchema,
    tenant: TenantSchema,
});

// ========== 资源增删改（Tenant / Namespace / Topic）==========
// 删除类通道复用上面的 TenantPathSchema / NamespacePathSchema / TopicPathSchema。

// allowedClusters 为空时 broker 会拒绝创建（租户在任何集群上都不被允许），
// 因此在参数校验阶段就要求至少一个集群，而不是等请求失败再报错。
export const CreateTenantSchema = z.object({
    clusterId: ClusterIdSchema,
    name: TenantSchema,
    adminRoles: z.array(z.string().min(1).max(255)).max(50).default([]),
    allowedClusters: z.array(z.string().min(1).max(255)).min(1).max(50),
});

export const UpdateTenantSchema = z.object({
    clusterId: ClusterIdSchema,
    tenant: TenantSchema,
    adminRoles: z.array(z.string().min(1).max(255)).max(50),
    allowedClusters: z.array(z.string().min(1).max(255)).min(1).max(50),
});

export const CreateNamespaceSchema = z.object({
    clusterId: ClusterIdSchema,
    tenant: TenantSchema,
    name: NamespaceSchema,
});

// partitions = 0 表示非分区 topic：这两条路径在 Admin API 里是不同的端点，
// 不能像旧代码那样一律走 /partitions。
export const CreateTopicSchema = z.object({
    clusterId: ClusterIdSchema,
    tenant: TenantSchema,
    namespace: NamespaceSchema,
    name: TopicSchema,
    persistent: PersistentSchema,
    partitions: z.number().int().min(0).max(1000).default(0),
});

export const MessageSendSchema = TopicPathSchema.extend({
    // 5MB 是 broker 默认的单条消息上限，超过直接被拒；在参数校验阶段就拦住
    message: z
        .string()
        .min(1)
        .max(5 * 1024 * 1024),
    properties: z.record(z.string().max(1024), z.string().max(1024)).optional(),
});

// maxMessages = 0 表示一直收到手动停止为止；默认给一个上限，
// 避免对大积压订阅点一下"开始消费"就把主进程内存打满。
export const ConsumeStartSchema = SubscriptionPathSchema.extend({
    subscriptionType: z.enum(['Exclusive', 'Shared', 'Failover', 'Key_Shared']).default('Shared'),
    initialPosition: InitialPositionSchema.default('Earliest'),
    autoAck: z.boolean().default(true),
    maxMessages: z.number().int().min(0).max(10000).default(500),
});

export const ReadStartSchema = TopicPathSchema.extend({
    from: z.enum(['earliest', 'latest', 'timestamp']).default('earliest'),
    timestamp: z.number().int().positive().optional(),
    maxMessages: z.number().int().min(0).max(10000).default(500),
});

export const SessionIdSchema = z.object({
    sessionId: z
        .string()
        .min(1)
        .max(64)
        .regex(/^s\d+$/),
});

// 初始化数据库
let dbInitialized = false;

export function ensureDbInitialized() {
    if (!dbInitialized) {
        initDatabase();
        dbInitialized = true;
    }
}

// 加密敏感字段
export function encryptSensitiveFields(config: z.infer<typeof ClusterConfigSchema>) {
    const encrypted = {...config};
    if (config.authParams) {
        encrypted.authParams = encrypt(config.authParams);
    }
    if (config.tlsTrustCerts) {
        encrypted.tlsTrustCerts = encrypt(config.tlsTrustCerts);
    }
    return encrypted;
}

// 解密敏感字段

// 标准化集群数据。
// 注意：authParams / tlsTrustCerts 属于凭据，只在主进程内解密使用，
// 绝不随集群列表下发到渲染进程；这里只暴露"是否已配置"的布尔标记。
export function normalizeCluster(cluster: any) {
    return {
        id: cluster.id,
        name: cluster.name,
        serviceUrl: cluster.service_url,
        webServiceUrl: cluster.web_service_url,
        authPlugin: cluster.auth_plugin,
        hasAuthParams: !!cluster.auth_params,
        tlsEnabled: !!cluster.tls_enabled,
        hasTlsTrustCerts: !!cluster.tls_trust_certs,
        useSshTunnel: !!cluster.use_ssh_tunnel,
        sshConfigId: cluster.ssh_config_id,
        adminApiTimeout: cluster.admin_api_timeout || 5000,
        status: cluster.status || 'disconnected',
        version: cluster.version,
        createdAt: cluster.created_at,
        updatedAt: cluster.updated_at,
    };
}

// 格式化错误信息（只返回错误消息，不包含堆栈，避免泄露敏感信息）
export function formatError(error: unknown): string {
    if (error instanceof Error) {
        // 生产环境只返回错误消息
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    return JSON.stringify(error);
}

// 集群连接参数（含解密后的凭据）。admin HTTP 与原生客户端共用这一份，
// 保证解密只发生在一处，也不会出现两条链路读到不同的配置。
// 注意：返回值只在主进程内使用，绝不随 IPC 下发到渲染进程。
export interface ClusterConnectionConfig {
    serviceUrl: string;
    webServiceUrl?: string | null;
    adminApiTimeoutMs: number;
    // 原生客户端的超时单位是秒；由集群配置的 admin_api_timeout（毫秒）换算，
    // 否则两条链路会读同一个集群却用两套超时。
    operationTimeoutSeconds: number;
    authPlugin?: string | null;
    authParams?: string | null;
    tlsEnabled: boolean;
    tlsTrustCerts?: string | null;
}

export function buildConnectionConfig(clusterId: string): ClusterConnectionConfig | null {
    const cluster = getClusterById(clusterId);
    if (!cluster) {
        return null;
    }
    // SSH 隧道端口转发尚未实现：勾选了隧道的集群若静默直连 serviceUrl，
    // 用户会以为凭据/网络生效了，必须在这里显式拒绝而不是假装能连。
    if (cluster.use_ssh_tunnel) {
        throw new Error('SSH 隧道尚未实现，请在集群设置中关闭隧道后直连');
    }
    const adminApiTimeoutMs = cluster.admin_api_timeout || 5000;
    return {
        serviceUrl: cluster.service_url,
        webServiceUrl: cluster.web_service_url,
        adminApiTimeoutMs,
        operationTimeoutSeconds: Math.max(1, Math.round(adminApiTimeoutMs / 1000)),
        authPlugin: cluster.auth_plugin,
        authParams: cluster.auth_params ? decrypt(cluster.auth_params) : null,
        tlsEnabled: !!cluster.tls_enabled,
        tlsTrustCerts: cluster.tls_trust_certs ? decrypt(cluster.tls_trust_certs) : null,
    };
}

// 获取 Pulsar Admin Client（公共方法）
export function getAdminClient(clusterId: string): PulsarAdminClient | null {
    const config = buildConnectionConfig(clusterId);
    if (!config) {
        return null;
    }

    return clientManager.getClient(clusterId, {
        serviceUrl: config.serviceUrl,
        webServiceUrl: config.webServiceUrl,
        timeout: config.adminApiTimeoutMs,
        auth: config.authPlugin ? {authPlugin: config.authPlugin, authParams: config.authParams} : undefined,
        tls: config.tlsEnabled
            ? {
                  enabled: true,
                  trustCerts: config.tlsTrustCerts || undefined,
              }
            : undefined,
    });
}

// 关闭数据库
export function cleanupDatabase() {
    closeDatabase();
    dbInitialized = false;
}

// 集群状态只在真正变化时落库：资源树轮询每次都会走到这里，无条件写会让
// SQLite 持续吃无效更新，updated_at 也会被轮询时间戳一直顶掉。
export function markClusterStatus(clusterId: string, status: 'connected' | 'disconnected'): void {
    const cluster = getClusterById(clusterId);
    if (!cluster) {
        return;
    }
    if ((cluster.status || 'disconnected') !== status) {
        updateCluster(clusterId, {status});
    }
}

// ========== IPC 请求来源校验 ==========

// 只有应用自身的页面可以调用 IPC。开发环境走 Vite dev server，
// 生产环境是本地 file:// 页面；其他来源（被注入的 iframe、远程内容）一律拒绝。
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
    const url = event.senderFrame?.url;
    if (!url) {
        return false;
    }
    if (url.startsWith('file://')) {
        return true;
    }
    if (process.env.NODE_ENV === 'development') {
        return url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:');
    }
    return false;
}

// ========== IPC Handler 包装器 ==========

export type IpcResult<T> = {success: true; data?: T} | {success: false; error: string};

/**
 * 注册一个 IPC handler 的公共骨架：来源校验 → 入参 zod 校验 → 数据库初始化 →
 * 解析依赖（resolve）→ 执行业务逻辑 → 错误捕获与脱敏。
 * resolve 返回 null 表示依赖不可用（如集群已被删除）。
 */
function registerResolvedHandler<S extends z.ZodTypeAny, R, T>(
    channel: string,
    schema: S,
    mapArgs: (args: unknown[]) => unknown,
    resolve: (input: z.infer<S>) => R | null,
    resolveFailure: string,
    run: (resolved: R, input: z.infer<S>) => Promise<T>,
): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<IpcResult<T>> => {
        try {
            if (!isTrustedSender(event)) {
                log.warn(`${channel}: rejected untrusted sender`);
                return {success: false, error: 'Request rejected'};
            }

            const parsed = schema.safeParse(mapArgs(args));
            if (!parsed.success) {
                const fields = parsed.error.issues.map(issue => issue.path.join('.')).join(', ');
                log.warn(`${channel}: invalid input parameters`, fields);
                return {success: false, error: 'Invalid input parameters'};
            }

            ensureDbInitialized();
            const input = parsed.data as z.infer<S>;
            const resolved = resolve(input);
            if (!resolved) {
                return {success: false, error: resolveFailure};
            }

            const data = await run(resolved, input);
            return {success: true, data};
        } catch (error) {
            log.error(`${channel} failed`, formatError(error));
            return {success: false, error: formatError(error)};
        }
    });
}

/**
 * 注册一个需要 Pulsar Admin 客户端的 IPC handler。
 */
export function registerClientHandler<S extends z.ZodTypeAny, T>(
    channel: string,
    schema: S,
    mapArgs: (args: unknown[]) => unknown,
    run: (client: PulsarAdminClient, input: z.infer<S>) => Promise<T>,
): void {
    registerResolvedHandler(
        channel,
        schema,
        mapArgs,
        input => getAdminClient((input as {clusterId: string}).clusterId),
        'Cluster not found',
        run,
    );
}

/** 注册一个走原生 pulsar-client 的 IPC handler（收发不经过 admin REST）。 */
export function registerNativeHandler<S extends z.ZodTypeAny, T>(
    channel: string,
    schema: S,
    mapArgs: (args: unknown[]) => unknown,
    run: (config: ClusterConnectionConfig, input: z.infer<S>) => Promise<T>,
): void {
    registerResolvedHandler(
        channel,
        schema,
        mapArgs,
        input => buildConnectionConfig((input as {clusterId: string}).clusterId),
        'Cluster not found',
        run,
    );
}

/** 注册一个不需要 Admin 客户端的 IPC handler（仍做来源校验与错误兜底）。 */
export function registerHandler<T>(channel: string, run: (...args: any[]) => Promise<T>): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<IpcResult<T>> => {
        try {
            if (!isTrustedSender(event)) {
                log.warn(`${channel}: rejected untrusted sender`);
                return {success: false, error: 'Request rejected'};
            }
            const data = await run(...args);
            return {success: true, data};
        } catch (error) {
            log.error(`${channel} failed`, formatError(error));
            return {success: false, error: formatError(error)};
        }
    });
}

/**
 * 注册一个原始 IPC handler：只在入口做来源校验，其余（入参解析、事务、
 * 自定义返回结构）完全交给业务代码。用于返回结构不统一、无法套用
 * registerHandler 的场景（如 testConnection 失败也要回传结构化结果）。
 */
export function registerRawHandler(channel: string, handler: (...args: unknown[]) => Promise<unknown>): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        if (!isTrustedSender(event)) {
            log.warn(`${channel}: rejected untrusted sender`);
            return {success: false, error: 'Request rejected'};
        }
        return handler(...args);
    });
}
