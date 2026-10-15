import {app, ipcMain} from 'electron';
import type {IpcMainInvokeEvent} from 'electron';
import {z} from 'zod';
import {defaultProducerOptions} from '../../shared/producer-defaults';
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
    insertSendHistory,
    runInTransaction,
    type SSHTunnelRecord,
} from '../database/sqlite';
import {encrypt, decrypt} from '../services/encryption';
import {SERVICE_URL_PATTERN, WEB_URL_PATTERN} from '../services/app-config';
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
    insertSendHistory,
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

// 隧道 id 一律限成 uuid：它是 ssh_tunnels 的主键。空串或垃圾 id 不查表的话会以
// "新建"的名义落进一堆重复隧道。
export const TunnelIdSchema = z.string().uuid().optional().nullable();

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
    id: TunnelIdSchema,
});

// 集群表单从打开起就带着 ssh 的半成品默认值（只有 port/authType）。没勾隧道时
// 拿完整 SSH 校验去卡它，"测试连接"就会抛一整段 zod JSON。未勾选直接丢掉这段。
function stripUnusedSsh<T extends z.ZodTypeAny>(schema: T) {
    return z.preprocess(value => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const record = value as Record<string, unknown>;
            if (!record.useSshTunnel && 'ssh' in record) {
                const rest = {...record};
                delete rest.ssh;
                return rest;
            }
        }
        return value;
    }, schema);
}

// webServiceUrl 允许留空（集群可能没有暴露 admin），空串按"没填"处理；
// 一旦填了就必须是 http/https，避免拿 file:// 之类的地址去做 admin 请求。
const optionalWebUrl = z
    .string()
    .optional()
    .nullable()
    .refine(value => !value || WEB_URL_PATTERN.test(value), {message: '需为 http:// 或 https:// 地址'});

// admin 超时（毫秒）。区间与配置中心导入校验（app-config）保持同一口径：
// 负值会让 axios 立刻抛错、超大值会把请求挂在那里没人管，两者都不该进库。
const adminApiTimeoutSchema = z.number().int().min(1000).max(120000).optional().nullable();

export const ClusterConfigSchema = stripUnusedSsh(
    z
        .object({
            name: z.string().min(1),
            serviceUrl: z.string().regex(SERVICE_URL_PATTERN, '需为 pulsar://、pulsar+ssl:// 或 ssl:// 地址'),
            webServiceUrl: optionalWebUrl,
            authPlugin: z.string().optional().nullable(),
            authParams: z.string().optional().nullable(),
            tlsEnabled: z.boolean().optional().nullable(),
            tlsTrustCerts: z.string().optional().nullable(),
            useSshTunnel: z.boolean().optional().nullable(),
            sshConfigId: TunnelIdSchema,
            ssh: SshInlineSchema.optional().nullable(),
            // 与导入校验（app-config 的 1000..120000）同一区间：这里只写 z.number()
            // 的话，负值会让 axios 立刻失败、超大值会把请求挂住，而 0 之外没人兜底。
            adminApiTimeout: adminApiTimeoutSchema,
        })
        // 勾选了隧道就必须有可用的隧道配置：要么这次填了新参数，要么已经有落库的
        // sshConfigId。缺了它会在连接阶段才报"隧道配置不存在"，用户看不到原因。
        .refine(config => !config.useSshTunnel || !!config.ssh?.host || !!config.sshConfigId, {
            message: 'SSH 隧道需要主机与用户名',
        }),
);

// 测试连接与真实请求走同一套地址解析：勾选隧道时先建隧道再打本地端口，
// 否则"测试通过但保存后连不上"的情况永远对不上号。
// id 是"这次测试代表哪台已保存集群"（编辑弹窗本来就带着它），只用于隧道归属校验。
export const ClusterTestSchema = stripUnusedSsh(
    z.object({
        id: ClusterIdSchema.optional().nullable(),
        serviceUrl: z.string().regex(SERVICE_URL_PATTERN, '需为 pulsar://、pulsar+ssl:// 或 ssl:// 地址'),
        webServiceUrl: optionalWebUrl,
        authPlugin: z.string().optional().nullable(),
        authParams: z.string().optional().nullable(),
        adminApiTimeout: adminApiTimeoutSchema,
        tlsEnabled: z.boolean().optional().nullable(),
        tlsTrustCerts: z.string().optional().nullable(),
        useSshTunnel: z.boolean().optional().nullable(),
        sshConfigId: TunnelIdSchema,
        ssh: SshInlineSchema.optional().nullable(),
    }),
);

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

// ========== 生产者 / 消费者工作台的公共构件 ==========
// 这几份要放在 MessageSendSchema 之前：属性与变量两侧（单发与模板）共用同一份
// 上限，各写一遍迟早漂移成两条不同的校验规则。

// 模板与会话配置的作用域地址：形如 persistent://public/default/orders。
// 空串是「通用」——模板与会话配置可以不绑定某个具体 topic 复用。
// 这里只查形状不做 admin 校验：工作台允许为还没建出来的 topic 预先存模板。
export const TopicUriSchema = z
    .string()
    .max(500)
    .refine(
        value =>
            value === '' ||
            /^(?:non-)?persistent:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.|:|-]+$/.test(value),
        {message: 'topicUri 需为空串或 persistent://租户/命名空间/topic 形式'},
    );

export const TemplateVariableSchema = z.object({
    name: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {message: '变量名只能用字母、数字、下划线，且不以数字开头'}),
    expr: z.string().min(1).max(2000),
});

export const TemplateVariablesSchema = z.array(TemplateVariableSchema).max(50);

export const MessagePropertiesSchema = z
    .record(z.string().max(1024), z.string().max(1024))
    .refine(props => Object.keys(props).length <= 100, {message: '属性条目最多 100 个'});

// 模板正文限 1MB；解析后的单条消息另有 5MB 上限，在服务层拦——
// $each 配大 count 能把 1MB 的模板撑到几十 MB。
export const TemplateBodySchema = z.object({
    body: z
        .string()
        .min(1)
        .max(1024 * 1024),
    variables: TemplateVariablesSchema.default([]),
    properties: MessagePropertiesSchema.optional(),
});

// 报文级参数：原生 producer 建好之后配置改不了（绑定没有修改入口），一次发送
// 能逐条决定的只有路由键、事件时间与延时这几项，见 pulsar-client 的 ProducerMessage。
// eventTimeMode / delayMode 不给默认值——"没填"在这里是有意义的（沿用会话参数），
// 填了默认值就等于把它覆盖成"不带事件时间"，回落永远不生效。
// 放在 MessageSendSchema 之前：消息浏览器那张发送面板与工作台的模板共用这一份，
// 单开一份就会出现"面板能过、工作台被拒"。
export const ProducerMessageOptionsSchema = z
    .object({
        partitionKey: z.string().max(1024).optional(),
        usePartitionKeyFromField: z.boolean().optional(),
        partitionKeyField: z.string().min(1).max(100).optional(),
        eventTimeMode: z.enum(['none', 'now', 'fromField', 'fixed']).optional(),
        eventTimeField: z.string().min(1).max(100).optional(),
        eventTimeFixed: z.number().int().nonnegative().optional(),
        delayMode: z.enum(['none', 'deliverAfter', 'deliverAt']).optional(),
        deliverAfterMs: z
            .number()
            .int()
            .min(1)
            .max(7 * 24 * 3600 * 1000)
            .optional(),
        deliverAt: z.number().int().positive().optional(),
        seed: z.number().int().optional(),
    })
    .refine(options => !options.usePartitionKeyFromField || !!options.partitionKeyField, {
        message: '按字段取路由键需要 partitionKeyField',
    })
    .refine(options => !(options.partitionKey && options.usePartitionKeyFromField), {
        message: '固定路由键与按字段取路由键只能选一个',
    })
    .refine(options => (options.eventTimeMode === 'fromField' ? !!options.eventTimeField : true), {
        message: '事件时间取字段需要 eventTimeField',
    })
    .refine(options => (options.eventTimeMode === 'fixed' ? options.eventTimeFixed !== undefined : true), {
        message: '固定事件时间需要 eventTimeFixed',
    })
    .refine(options => (options.delayMode === 'deliverAfter' ? !!options.deliverAfterMs : true), {
        message: '延时投递需要 deliverAfterMs',
    })
    .refine(options => (options.delayMode === 'deliverAt' ? !!options.deliverAt : true), {
        message: '定时投递需要 deliverAt',
    });

export const MessageSendSchema = TopicPathSchema.extend({
    // 5MB 是 broker 默认的单条消息上限，超过直接被拒；在参数校验阶段就拦住
    message: z
        .string()
        .min(1)
        .max(5 * 1024 * 1024),
    // 键与值的长度都限了，条数不限的话同样能绕过 5MB：一万个属性就是几百 MB，
    // 而且这些键值会原样进原生 producer.send 并在 broker 侧长期存储。
    properties: MessagePropertiesSchema.optional(),
    options: ProducerMessageOptionsSchema.optional(),
});

// maxMessages = 0 表示一直收到手动停止为止；默认给一个上限，
// 避免对大积压订阅点一下"开始消费"就把主进程内存打满。
export const ConsumeStartSchema = SubscriptionPathSchema.extend({
    subscriptionType: z.enum(['Exclusive', 'Shared', 'Failover', 'Key_Shared']).default('Shared'),
    initialPosition: InitialPositionSchema.default('Earliest'),
    autoAck: z.boolean().default(true),
    maxMessages: z.number().int().min(0).max(10000).default(500),
});

// 消费者工作台的建会话参数：在旧的三态面板那几项之外，再放开原生确实支持的
// 一组（接收队列、ack 超时、nack 重投超时、消费者名、死信）。这些都有默认值，
// 界面不填就等于不传，原生层用绑定自己的默认，而不是我们猜一个。
const DeadLetterSchema = z.object({
    // 死信主题必须是全路径：原生层拿到什么就投什么，缺前缀 broker 会静默丢掉死信
    topicName: z
        .string()
        .min(1)
        .max(300)
        .regex(/^(persistent|non-persistent):\/\/[A-Za-z0-9._\-/]+$/, {
            message: '死信主题需要完整路径，例如 persistent://public/default/t1-DLQ',
        }),
    maxRedeliverCount: z.number().int().min(1).max(100),
    initialSubscriptionName: SubscriptionSchema.optional(),
});

export const ConsumerStartSchema = ConsumeStartSchema.extend({
    receiverQueueSize: z.number().int().min(1).max(10000).optional(),
    ackTimeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(24 * 60 * 60 * 1000)
        .optional(),
    nAckRedeliverTimeoutMs: z
        .number()
        .int()
        .min(100)
        .max(60 * 60 * 1000)
        .optional(),
    consumerName: z
        .string()
        .min(1)
        .max(255)
        .regex(/^[a-zA-Z0-9._-]+$/)
        .optional(),
    deadLetter: DeadLetterSchema.optional(),
});

export const ReadStartSchema = TopicPathSchema.extend({
    from: z.enum(['earliest', 'latest', 'timestamp', 'recent']).default('earliest'),
    timestamp: z.number().int().positive().optional(),
    maxMessages: z.number().int().min(0).max(10000).default(500),
    // 「最近 N 条」的 N：上限对齐界面保留条数（500），否则主进程认真扫完 1000 条
    // 推过来，渲染层按保留上限只留 500 条，用户看到"扫过 X 条，取最近 1000 条"
    // 而列表只有一半，等于静默丢数。
    recentCount: z.number().int().min(1).max(500).default(20),
})
    // 起点与时间戳必须二选一：两个都给的话服务层会拿 timestamp 去 seek，
    // 用户选"最新位置"却看到从旧时间开始回放，而且界面报成功。
    .refine(params => (params.from === 'timestamp' ? !!params.timestamp : !params.timestamp), {
        message: '按时间读取需要 timestamp，其他起点不能带 timestamp',
    });

export const SessionIdSchema = z.object({
    // 会话 id 由主进程用 uuid 生成；限成 uuid 可以避免拿着上一个进程的 id
    // 去停这一进程里恰好同名的会话
    sessionId: z.string().uuid(),
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

// ========== 生产者 / 消费者工作台 ==========

// 字段一一对上 pulsar-client 1.18 的 ProducerConfig / ProducerMessage。
// 绑定里没有事务、没有 getStats、没有分区定向 API，所以也不提供这些开关。
// 默认值全部取自 shared/producer-defaults：界面表单初值与原生建 producer 的参数
// 与这里必须是同一组数，否则同一个 Topic 上两边的数字对不上。
const PRODUCER_DEFAULTS = defaultProducerOptions();

export const ProducerOptionsSchema = z
    .object({
        producerName: z.string().min(1).max(255).optional(),
        sendTimeoutMs: z.number().int().min(1000).max(600_000).default(PRODUCER_DEFAULTS.sendTimeoutMs),
        maxPendingMessages: z.number().int().min(1).max(50_000).default(PRODUCER_DEFAULTS.maxPendingMessages),
        blockIfQueueFull: z.boolean().default(PRODUCER_DEFAULTS.blockIfQueueFull),
        batchingEnabled: z.boolean().default(PRODUCER_DEFAULTS.batchingEnabled),
        batchingMaxMessages: z.number().int().min(1).max(100_000).default(PRODUCER_DEFAULTS.batchingMaxMessages),
        batchingMaxPublishDelayMs: z
            .number()
            .int()
            .min(1)
            .max(10_000)
            .default(PRODUCER_DEFAULTS.batchingMaxPublishDelayMs),
        batchingMaxAllowedSizeInBytes: z
            .number()
            .int()
            .min(1024)
            .max(10 * 1024 * 1024)
            .optional(),
        compressionType: z.enum(['None', 'Zlib', 'LZ4', 'ZSTD', 'SNAPPY']).default(PRODUCER_DEFAULTS.compressionType),
        chunkingEnabled: z.boolean().default(PRODUCER_DEFAULTS.chunkingEnabled),
        messageRoutingMode: z.enum(['UseSinglePartition', 'RoundRobinDistribution', 'CustomPartition']).optional(),
        hashingScheme: z.enum(['Murmur3_32Hash', 'BoostHash', 'JavaStringHash']).optional(),
        accessMode: z.enum(['Shared', 'Exclusive', 'WaitForExclusive', 'ExclusiveWithFencing']).optional(),
        partitionKey: z.string().max(1024).optional(),
        // 路由键从报文某字段取（而不是固定一个），分区主题的热点因此可控
        usePartitionKeyFromField: z.boolean().optional(),
        partitionKeyField: z.string().min(1).max(100).optional(),
        eventTimeMode: z.enum(['none', 'now', 'fromField', 'fixed']).default(PRODUCER_DEFAULTS.eventTimeMode),
        eventTimeField: z.string().min(1).max(100).optional(),
        eventTimeFixed: z.number().int().nonnegative().optional(),
        delayMode: z.enum(['none', 'deliverAfter', 'deliverAt']).default(PRODUCER_DEFAULTS.delayMode),
        deliverAfterMs: z
            .number()
            .int()
            .min(1)
            .max(7 * 24 * 3600 * 1000)
            .optional(),
        deliverAt: z.number().int().positive().optional(),
        seed: z.number().int().optional(),
    })
    // 跨字段依赖全部在这里钉住：这些组合在服务层没有兜底分支，漏过去就是
    // 「界面选了 fromField 但实际 eventTime 为空」。
    .refine(options => !options.usePartitionKeyFromField || !!options.partitionKeyField, {
        message: '按字段取路由键需要 partitionKeyField',
    })
    .refine(options => !(options.partitionKey && options.usePartitionKeyFromField), {
        message: '固定路由键与按字段取路由键只能选一个',
    })
    .refine(options => (options.eventTimeMode === 'fromField' ? !!options.eventTimeField : true), {
        message: '事件时间取字段需要 eventTimeField',
    })
    .refine(options => (options.eventTimeMode === 'fixed' ? options.eventTimeFixed !== undefined : true), {
        message: '固定事件时间需要 eventTimeFixed',
    })
    .refine(options => (options.delayMode === 'deliverAfter' ? !!options.deliverAfterMs : true), {
        message: '延时投递需要 deliverAfterMs',
    })
    .refine(options => (options.delayMode === 'deliverAt' ? !!options.deliverAt : true), {
        message: '定时投递需要 deliverAt',
    })
    // 原生绑定（pulsar-client 1.18 的 C++ 层）在批量与分块同开时直接 abort 掉整个主进程：
    // 实测没有 JS 异常、没有转储，进程凭空消失，所以这条组合必须在进原生层之前拒掉。
    .refine(options => !(options.batchingEnabled && options.chunkingEnabled), {
        message: '批量发送与分块不能同时开启，请先关闭其中一项',
        path: ['chunkingEnabled'],
    });

export const MessageTemplateBodySchema = TemplateBodySchema.extend({
    id: z.string().uuid().optional(),
    clusterId: ClusterIdSchema,
    topicUri: TopicUriSchema,
    name: z.string().min(1).max(100),
    producerOptions: ProducerOptionsSchema.optional(),
    schemaMode: z.enum(['none', 'inline', 'broker']).default('none'),
});

export const TemplateScopeSchema = z.object({
    clusterId: ClusterIdSchema,
    // 不传 = 该集群全部模板；传了 = 该 topic 可用的（含通用模板）
    topicUri: TopicUriSchema.optional(),
});

export const TemplateIdSchema = z.object({id: z.string().uuid()});

export const TemplateCopySchema = z.object({
    id: z.string().uuid(),
    // 留空时由服务层按「原名 副本」生成，同作用域重名会直接拒绝
    name: z.string().min(1).max(100).optional(),
    topicUri: TopicUriSchema.optional(),
});

export const ConsumerConfigDraftSchema = z.object({
    subscriptionType: z.enum(['Exclusive', 'Shared', 'Failover', 'Key_Shared']).default('Shared'),
    initialPosition: InitialPositionSchema.default('Earliest'),
    autoAck: z.boolean().default(true),
    maxMessages: z.number().int().min(0).max(10_000).default(500),
    receiverQueueSize: z.number().int().min(1).max(10_000).optional(),
    ackTimeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
    nAckRedeliverTimeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
    consumerName: z.string().min(1).max(255).optional(),
    // 与建会话那一处共用同一份死信校验：草稿能存下自由文本、起会话时才被全路径正则
    // 拒掉，等于把同一份配置分成"存得进去、用不出来"两种状态。
    deadLetter: DeadLetterSchema.optional(),
});

export const ConsumerConfigUpsertSchema = ConsumerConfigDraftSchema.extend({
    id: z.string().uuid().optional(),
    clusterId: ClusterIdSchema,
    topicUri: TopicUriSchema,
    subscription: SubscriptionSchema,
    name: z.string().min(1).max(100),
});

export const ConsumerConfigCopySchema = TemplateCopySchema.extend({
    subscription: SubscriptionSchema.optional(),
});

export const SendHistoryListSchema = z.object({
    clusterId: ClusterIdSchema,
    topicUri: TopicUriSchema,
    limit: z.number().int().min(1).max(1000).default(200),
});

export const ProducerStartSchema = TopicPathSchema.extend({
    options: ProducerOptionsSchema.default({}),
});

// 模板正文只取 body/variables/properties 三项：发送方传的是"这次要发的报文"，
// 不是数据库里的那一行，名称与作用域跟这次发送无关。
// templateName/templateId 是这次发送的"叫什么名字"，只用于写发送历史。
export const ProducerSendSchema = TopicPathSchema.extend({
    sessionId: z.string().uuid(),
    template: TemplateBodySchema,
    // 一次点"发送"投几条。上限 1000：每条最坏 5MB，再大就该走连续发送而不是这里。
    count: z.number().int().min(1).max(1000).default(1),
    options: ProducerMessageOptionsSchema.optional(),
    templateName: z.string().min(1).max(100).optional(),
    templateId: z.string().uuid().optional(),
});

export const ProducerSendOnceSchema = TopicPathSchema.extend({
    template: TemplateBodySchema,
    count: z.number().int().min(1).max(1000).default(1),
    options: ProducerOptionsSchema.default({}),
    templateName: z.string().min(1).max(100).optional(),
    templateId: z.string().uuid().optional(),
});

export const ProducerFlushSchema = z.object({sessionId: z.string().uuid()});

// 连续发送：模板在主进程逐条解析（页签可能已经切走，主进程必须自足），
// 所以这里带的是模板正文而不是已解析的报文。
export const ProducerFlowSchema = z.object({
    sessionId: z.string().uuid(),
    template: TemplateBodySchema,
    // 0 = 不限速全速投；上限对齐压测的速率上限
    ratePerSecond: z.number().int().min(0).max(200_000).default(0),
    // 0 = 一直投到手动停止
    totalMessages: z.number().int().min(0).max(10_000_000).default(0),
    // 在途窗口：与 producer 自己的 maxPendingMessages 同量级才有意义，
    // 调得比它大只会让原生队列先满，然后由 blockIfQueueFull 排队
    maxInFlight: z.number().int().min(1).max(2000).default(500),
    stopOnError: z.boolean().default(true),
    options: ProducerMessageOptionsSchema.optional(),
    templateName: z.string().min(1).max(100).optional(),
    templateId: z.string().uuid().optional(),
});

export const ProducerSetRateSchema = z.object({
    sessionId: z.string().uuid(),
    ratePerSecond: z.number().int().min(0).max(200_000),
});

export const ProducerSessionsSchema = z.object({clusterId: ClusterIdSchema.optional()});

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
    let message: string;
    if (error instanceof z.ZodError) {
        // zod 的 issue 列表是一整段 JSON，渲染层直接进 toast 完全读不懂；
        // 取第一条的字段路径 + 期望，够说清楚是哪里不合法。
        const issue = error.issues[0];
        message = issue ? `字段 ${issue.path.join('.') || '未知字段'} 不合法：${issue.message}` : '输入校验失败';
    } else if (error instanceof Error) {
        message = error.message;
    } else if (typeof error === 'string') {
        message = error;
    } else {
        message = JSON.stringify(error);
    }
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

// 隧道行是集群表单内联录入的私有配置：拿着别的集群的 id 过来，会把那台集群的
// SSH 主机与凭据整行换掉。ownerClusterId 表示"这次操作代表哪个集群"，只有它自己
// 名下的行才允许改写。
function requireOwnedTunnel(sshConfigId: string, ownerClusterId?: string | null): SSHTunnelRecord {
    const existing = getSSHTunnelById(sshConfigId);
    if (!existing) {
        throw new Error('未找到对应的 SSH 隧道配置，请在集群设置里重新填写');
    }
    const owner = getAllClusters().find(
        cluster => cluster.ssh_config_id === existing.id && cluster.id !== ownerClusterId,
    );
    if (owner) {
        throw new Error(`该 SSH 隧道配置已被集群「${owner.name}」使用，请重新填写一份隧道参数`);
    }
    return existing;
}

/**
 * 勾选了隧道但这次没有重填参数：沿用已落库的那一行（校验存在与归属），不写任何数据。
 */
export function reuseSshConfig(sshConfigId: string, ownerClusterId?: string | null): string {
    return requireOwnedTunnel(sshConfigId, ownerClusterId).id;
}

/**
 * 把表单里的隧道参数落库：有 sshConfigId 就覆盖那一行，否则新建。
 * 凭据留空表示沿用已保存的值（凭据从不下发到渲染进程）。返回落库后的行 id。
 */
export function persistSshConfig(
    ssh: z.infer<typeof SshInlineSchema>,
    sshConfigId?: string | null,
    ownerClusterId?: string | null,
): string {
    const existing = sshConfigId ? requireOwnedTunnel(sshConfigId, ownerClusterId) : undefined;
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
    options: {
        sshConfigId?: string | null;
        ssh?: z.infer<typeof SshInlineSchema> | null;
        ownerClusterId?: string | null;
    },
): Promise<TunnelResolution> {
    let tunnelId: string;
    if (options.ssh) {
        tunnelId = persistSshConfig(options.ssh, options.sshConfigId, options.ownerClusterId);
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

// 版本与状态同理只在变化时落库：轮询每次都写会把 updated_at 一直顶掉。
export function markClusterVersion(clusterId: string, version: string): void {
    const cluster = getClusterById(clusterId);
    if (!cluster || cluster.version === version) {
        return;
    }
    updateCluster(clusterId, {version});
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
                // 只回一句 "Invalid input parameters" 等于让用户自己猜哪项错了：跨字段约束
                // （批量与分块互斥、事件时间取字段要字段名）的说明全写在 refine 的 message 里，
                // 丢掉它就等于把校验的价值抵消了。formatError 已经会截断长文本。
                return {success: false, error: formatError(parsed.error)};
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
