import {app, ipcMain} from 'electron';
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
    getSSHTunnelById,
    insertSSHTunnel,
    updateSSHTunnel,
    deleteSSHTunnel,
    getSetting,
    setSetting,
    insertOperationLog,
    runInTransaction,
    type SSHTunnelRecord,
} from '../database/sqlite';
import {encrypt, decrypt} from '../services/encryption';
import {PulsarAdminClient, clientManager} from '../services/pulsar-admin';
import {condenseErrorText} from '../services/http-client';
import {sshTunnelManager, type TunnelEndpoints, type TunnelTargets} from '../services/ssh-tunnel';
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
    getSSHTunnelById,
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
    sshTunnelManager,
};

export type {SSHTunnelRecord, TunnelTargets};

// Zod schemas for validation
export const ClusterIdSchema = z.string().min(1).uuid();

export const SshInlineSchema = z.object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().min(1).max(128),
    authType: z.enum(['password', 'privateKey']).default('password'),
    // 凭据不回传渲染进程，所以编辑时留空表示"沿用已保存的值"（见 cluster:update）
    password: z.string().max(4096).optional().nullable(),
    privateKey: z
        .string()
        .max(64 * 1024)
        .optional()
        .nullable(),
    passphrase: z.string().max(4096).optional().nullable(),
    // 远端 Pulsar 主机与端口：留空时按集群自身的服务地址解析
    remoteHost: z.string().max(253).optional().nullable(),
    remoteAdminPort: z.number().int().min(1).max(65535).optional().nullable(),
    remoteBrokerPort: z.number().int().min(1).max(65535).optional().nullable(),
});

export const SSHConfigSchema = SshInlineSchema.extend({
    id: ClusterIdSchema.optional(),
});

export const ClusterConfigSchema = z
    .object({
        name: z.string().min(1),
        serviceUrl: z.string().min(1),
        webServiceUrl: z.string().optional().nullable(),
        authPlugin: z.string().optional().nullable(),
        authParams: z.string().optional().nullable(),
        tlsEnabled: z.boolean().optional().nullable(),
        tlsTrustCerts: z.string().optional().nullable(),
        useSshTunnel: z.boolean().optional().nullable(),
        sshConfigId: z.string().optional().nullable(),
        ssh: SshInlineSchema.optional().nullable(),
        adminApiTimeout: z.number().optional().nullable(),
    })
    // 勾选了隧道就必须有可用的隧道配置：要么这次填了新参数，要么已经有落库的
    // sshConfigId。缺了它会在连接阶段才报"隧道配置不存在"，用户看不到原因。
    .refine(config => !config.useSshTunnel || !!config.ssh?.host || !!config.sshConfigId, {
        message: 'SSH 隧道需要主机与用户名',
    });

// 测试连接与真实请求走同一套地址解析：勾选隧道时先建隧道再打本地端口，
// 否则"测试通过但保存后连不上"的情况永远对不上号。
export const ClusterTestSchema = z.object({
    serviceUrl: z.string().min(1),
    webServiceUrl: z.string().optional().nullable(),
    authPlugin: z.string().optional().nullable(),
    authParams: z.string().optional().nullable(),
    adminApiTimeout: z.number().optional().nullable(),
    tlsEnabled: z.boolean().optional().nullable(),
    tlsTrustCerts: z.string().optional().nullable(),
    useSshTunnel: z.boolean().optional().nullable(),
    sshConfigId: z.string().optional().nullable(),
    ssh: SshInlineSchema.optional().nullable(),
});

// 通用验证 schema
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
// 三项都是可选的：编辑配置弹窗的语义是"留空表示不修改"，渲染层每次只提交
// 用户真正填过的字段，若这里要求全量必填，只改一项的合法请求会被拒成
// "Invalid input parameters"，现象是保存配置永远失败。
export const TopicConfigPatchSchema = z
    .object({
        // -1 是 broker 表示"该维度不限制"的合法值（0 只用于两项同时为 0 关闭保留），
        // 下限放到 -1，否则用户按 broker 语义填 -1 会被参数校验拦下。
        retentionTimeInMinutes: z
            .number()
            .int()
            .min(-1)
            .max(365 * 24 * 60)
            .optional(),
        retentionSizeInMB: z
            .number()
            .int()
            .min(-1)
            .max(1024 * 1024)
            .optional(),
        numPartitions: z.number().int().min(0).max(1000).optional(),
    })
    .strict()
    .refine(patch => Object.values(patch).some(value => value !== undefined), {
        message: 'At least one config field must be provided',
    });

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

// 快速压测：全部字段都有默认值，渲染层只提交用户改动过的项。
// 跨字段的资源上限（在途总量、清理订阅的前提）放在压测服务里检查——
// schema 校验失败只会回"Invalid input parameters"，用户看不到到底哪超了。
export const LoadTestStartSchema = TopicPathSchema.extend({
    producers: z.number().int().min(1).max(32).default(4),
    totalMessages: z.number().int().min(1).max(1_000_000).default(10_000),
    // 上限对齐 broker 默认单条消息大小（1MB 级），更大的载荷属于另一种测试场景
    messageSizeBytes: z
        .number()
        .int()
        .min(1)
        .max(1024 * 1024)
        .default(1024),
    // 0 表示不限速；限速按全局速率在所有生产者之间均分时间片
    ratePerSecond: z.number().int().min(0).max(200_000).default(0),
    maxInFlightPerProducer: z.number().int().min(1).max(2000).default(500),
    batchingEnabled: z.boolean().default(true),
    compression: z.enum(['None', 'Zlib', 'LZ4', 'ZSTD', 'SNAPPY']).default('None'),
    consumeBacklog: z.boolean().default(false),
    subscription: SubscriptionSchema.default('benchmark'),
    unsubscribeAfterRun: z.boolean().default(false),
});

export const LoadTestStopSchema = z.object({
    runId: z.string().uuid(),
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

// SSH 隧道凭据单独加密：字段名与 ssh_tunnels 表一致，直接落库。
export function encryptSshSecrets(ssh: z.infer<typeof SshInlineSchema>): Partial<SSHTunnelRecord> {
    const record: Partial<SSHTunnelRecord> = {
        host: ssh.host,
        port: ssh.port || 22,
        username: ssh.username,
        auth_type: ssh.authType,
    };
    if (ssh.password) {
        record.password = encrypt(ssh.password);
    }
    if (ssh.privateKey) {
        record.private_key = encrypt(ssh.privateKey);
    }
    if (ssh.passphrase) {
        record.passphrase = encrypt(ssh.passphrase);
    }
    if (ssh.remoteHost) {
        record.remote_host = ssh.remoteHost;
    }
    if (ssh.remoteAdminPort) {
        record.remote_admin_port = ssh.remoteAdminPort;
    }
    if (ssh.remoteBrokerPort) {
        record.remote_broker_port = ssh.remoteBrokerPort;
    }
    return record;
}

// 解密敏感字段

// 标准化集群数据。
// 注意：authParams / tlsTrustCerts / SSH 凭据属于凭据，只在主进程内解密使用，
// 绝不随集群列表下发到渲染进程；这里只暴露"是否已配置"的布尔标记。
// tunnel 是关联的 ssh_tunnels 行（cluster:list 一次查全部再按 id 匹配，避免 N+1）。
export function normalizeCluster(cluster: any, tunnel?: SSHTunnelRecord) {
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
        ssh: tunnel
            ? {
                  host: tunnel.host,
                  port: tunnel.port,
                  username: tunnel.username,
                  authType: tunnel.auth_type === 'privateKey' ? 'privateKey' : 'password',
                  hasPassword: !!tunnel.password,
                  hasPrivateKey: !!tunnel.private_key,
                  remoteHost: tunnel.remote_host,
                  remoteAdminPort: tunnel.remote_admin_port,
                  remoteBrokerPort: tunnel.remote_broker_port,
                  // 只报"当前是否有活的本地转发"，端口不下发（渲染层用不到）
                  tunnelActive: sshTunnelManager.endpoints(tunnel.id) !== undefined,
              }
            : undefined,
        adminApiTimeout: cluster.admin_api_timeout || 5000,
        status: cluster.status || 'disconnected',
        version: cluster.version,
        createdAt: cluster.created_at,
        updatedAt: cluster.updated_at,
    };
}

// 格式化错误信息（只返回错误消息，不包含堆栈，避免泄露敏感信息）
export function formatError(error: unknown): string {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
    // 渲染层把这段文本直接塞进 toast，broker 的 500 响应带完整 Java 堆栈时会撑爆提示。
    return condenseErrorText(message) || message;
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
    // 走隧道时地址被改写成 127.0.0.1，证书校验仍要用原始主机名，
    // 否则等于把主机名校验关掉了。
    tlsVerifyHost?: string | null;
    viaSshTunnel: boolean;
}

const LOCAL_TUNNEL_HOST = '127.0.0.1';

function parseUrl(value: string | null | undefined): {host?: string; port?: number} {
    if (!value) {
        return {};
    }
    try {
        const url = new URL(value);
        const host = url.hostname.replace(/^\[|\]$/g, '');
        return {host: host || undefined, port: url.port ? Number(url.port) : undefined};
    } catch {
        // 地址非法交给后续请求报错，这里不要抛异常——那会让"保存集群"因为
        // 一个拼错的 URL 直接失败，而错误信息完全对不上真正的原因。
        return {};
    }
}

// 隧道转发的远端目标：优先用集群自身的服务地址（用户填的就是它想连的东西），
// ssh_tunnels 里的端口只是历史/手工连接记录的兜底。
function resolveTunnelTargets(cluster: any, record: SSHTunnelRecord): TunnelTargets {
    const admin = parseUrl(cluster.web_service_url);
    const broker = parseUrl(cluster.service_url);
    const remoteHost = record.remote_host || admin.host || broker.host || record.host;
    return {
        remoteHost,
        adminPort: admin.port || record.remote_admin_port || 8080,
        brokerPort: broker.port || record.remote_broker_port || 6650,
    };
}

export function rewriteUrl(original: string, port: number): string {
    const fallbackScheme = original.startsWith('pulsar+ssl') || original.startsWith('ssl') ? 'pulsar+ssl' : 'pulsar';
    try {
        const url = new URL(original);
        url.hostname = LOCAL_TUNNEL_HOST;
        url.port = String(port);
        return url.toString();
    } catch {
        return `${fallbackScheme}://${LOCAL_TUNNEL_HOST}:${port}`;
    }
}

export interface TunnelResolution {
    tunnelId: string;
    endpoints: TunnelEndpoints;
    targets: TunnelTargets;
}

// 证书校验用的主机名取用户填写的服务地址主机：隧道只是把连接"搬到"127.0.0.1，
// 签发对象仍然是用户本意想连的那台机器（remoteHost 可能只是为了可达而填的 IP）。
export function tunnelVerifyHost(
    source: {service_url: string; web_service_url?: string | null},
    targets: TunnelTargets,
) {
    return parseUrl(source.web_service_url).host || parseUrl(source.service_url).host || targets.remoteHost;
}

/**
 * 把表单里的隧道参数落库：有 sshConfigId 就覆盖那一行，否则新建。
 * 凭据留空表示沿用已保存的值（凭据从不下发到渲染进程）。返回落库后的行 id。
 */
export function persistSshConfig(ssh: z.infer<typeof SshInlineSchema>, sshConfigId?: string | null): string {
    const existing = sshConfigId ? getSSHTunnelById(sshConfigId) : undefined;
    if (sshConfigId && !existing) {
        throw new Error('未找到对应的 SSH 隧道配置，请在集群设置里重新填写');
    }
    if (!existing) {
        const id = uuidv4();
        insertSSHTunnel({
            id,
            host: ssh.host,
            port: ssh.port || 22,
            username: ssh.username,
            auth_type: ssh.authType,
            password: ssh.password ? encrypt(ssh.password) : undefined,
            private_key: ssh.privateKey ? encrypt(ssh.privateKey) : undefined,
            passphrase: ssh.passphrase ? encrypt(ssh.passphrase) : undefined,
            remote_host: ssh.remoteHost || undefined,
            remote_admin_port: ssh.remoteAdminPort || 8080,
            remote_broker_port: ssh.remoteBrokerPort || 6650,
            local_admin_port: 0,
            local_broker_port: 0,
            status: 'disconnected',
        });
        return id;
    }

    const updates: Record<string, string | number | null> = {
        host: ssh.host,
        port: ssh.port || 22,
        username: ssh.username,
        auth_type: ssh.authType,
        password: ssh.password ? encrypt(ssh.password) : (existing.password ?? null),
        private_key: ssh.privateKey ? encrypt(ssh.privateKey) : (existing.private_key ?? null),
        passphrase: ssh.passphrase ? encrypt(ssh.passphrase) : (existing.passphrase ?? null),
        remote_host: ssh.remoteHost || existing.remote_host || null,
        remote_admin_port: ssh.remoteAdminPort || existing.remote_admin_port || 8080,
        remote_broker_port: ssh.remoteBrokerPort || existing.remote_broker_port || 6650,
    };
    // 认证方式换了，另一种凭据必须清掉：否则建隧道时会拿旧私钥去配新密码
    if (ssh.authType === 'password') {
        updates.private_key = null;
        updates.passphrase = null;
    } else {
        updates.password = null;
    }
    updateSSHTunnel(existing.id, updates);
    return existing.id;
}

/**
 * 按（可能尚未落库的）隧道参数建立本地端口转发。
 *
 * - 传了 ssh（表单里的隧道参数）：先落库并作废旧的转发——换了 SSH 主机或凭据后
 *   继续复用会让请求打到错误的对端。
 * - 只传 sshConfigId：复用已保存的配置。
 */
export async function establishTunnel(
    clusterLike: {service_url: string; web_service_url?: string | null},
    options: {sshConfigId?: string | null; ssh?: z.infer<typeof SshInlineSchema> | null},
): Promise<TunnelResolution> {
    let tunnelId: string;
    if (options.ssh) {
        tunnelId = persistSshConfig(options.ssh, options.sshConfigId);
        await sshTunnelManager.invalidate(tunnelId);
    } else {
        if (!options.sshConfigId) {
            throw new Error('启用 SSH 隧道需要填写 SSH 主机与用户名');
        }
        tunnelId = options.sshConfigId;
    }
    const record = getSSHTunnelById(tunnelId);
    if (!record) {
        throw new Error('未找到对应的 SSH 隧道配置，请在集群设置里重新填写');
    }
    const targets = resolveTunnelTargets(clusterLike, record);
    const endpoints = await sshTunnelManager.ensure(record, targets);
    return {tunnelId: record.id, endpoints, targets};
}

// 已勾选隧道的集群：建立（或复用）本地端口转发，并把两条链路的地址都换成
// 127.0.0.1 的隧道端点。原始主机名保留在 tlsVerifyHost 里供证书校验使用。
async function applySshTunnel(cluster: any, config: ClusterConnectionConfig): Promise<ClusterConnectionConfig> {
    const resolved = await establishTunnel(cluster, {sshConfigId: cluster.ssh_config_id});
    return {
        ...config,
        serviceUrl: rewriteUrl(cluster.service_url, resolved.endpoints.localBrokerPort),
        // serviceUrl 只有一个端口，映射不出 admin 地址，所以经隧道时 admin 必须显式落库
        webServiceUrl: config.webServiceUrl
            ? rewriteUrl(config.webServiceUrl, resolved.endpoints.localAdminPort)
            : `${config.tlsEnabled ? 'https' : 'http'}://${LOCAL_TUNNEL_HOST}:${resolved.endpoints.localAdminPort}`,
        tlsVerifyHost: tunnelVerifyHost(cluster, resolved.targets),
        viaSshTunnel: true,
    };
}

export async function buildConnectionConfig(clusterId: string): Promise<ClusterConnectionConfig | null> {
    const cluster = getClusterById(clusterId);
    if (!cluster) {
        return null;
    }
    const adminApiTimeoutMs = cluster.admin_api_timeout || 5000;
    const config: ClusterConnectionConfig = {
        serviceUrl: cluster.service_url,
        webServiceUrl: cluster.web_service_url,
        adminApiTimeoutMs,
        operationTimeoutSeconds: Math.max(1, Math.round(adminApiTimeoutMs / 1000)),
        authPlugin: cluster.auth_plugin,
        authParams: cluster.auth_params ? decrypt(cluster.auth_params) : null,
        tlsEnabled: !!cluster.tls_enabled,
        tlsTrustCerts: cluster.tls_trust_certs ? decrypt(cluster.tls_trust_certs) : null,
        tlsVerifyHost: null,
        viaSshTunnel: false,
    };
    if (!cluster.use_ssh_tunnel) {
        return config;
    }
    return applySshTunnel(cluster, config);
}

// 获取 Pulsar Admin Client（公共方法）
export async function getAdminClient(clusterId: string): Promise<PulsarAdminClient | null> {
    const config = await buildConnectionConfig(clusterId);
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
        tlsVerifyHost: config.tlsVerifyHost || undefined,
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
// 生产环境是本地 file:// 页面；其他来源一律拒绝。
// 两条规则缺一不可：
// - 只认主框架：否则页面里塞一个 <iframe src="file://..."> 就能拿到全部通道；
// - 用"是否已打包"而不是 NODE_ENV 判断 dev：环境变量在别人的机器上不可控，
//   没设上又会把 dev 页面当成外部来源，表现就是所有请求都回 Request rejected。
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame) {
        return false;
    }
    const url = frame.url;
    if (!url) {
        return false;
    }
    if (url.startsWith('file://')) {
        return true;
    }
    if (!app.isPackaged) {
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
    resolve: (input: z.infer<S>) => R | null | Promise<R | null>,
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
            // resolve 可能是异步的（走隧道的集群要先建立本地转发才能拿到客户端）
            const resolved = await resolve(input);
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
