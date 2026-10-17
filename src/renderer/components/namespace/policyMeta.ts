import type {NamespacePolicyField, NamespacePolicyView} from '../../types';

// 命名空间策略的展示与编辑口径。字段表在主进程（namespace-policy-api.ts），
// 这里只负责「人怎么看、怎么填」：单位、区间、候选值都写在这一份里，
// 面板与编辑弹窗共用，避免同一个字段在两个组件里各写一遍单位。

export const NOT_SET = '未设置（沿用 broker 默认）';

// broker 用 -1 表示「无限/不限制」，0 表示「一条都不留/立刻过期」，
// null 才是「没设过」。三者含义不同，塌缩成任意一个都会误导下一步操作。
export const UNLIMITED_HINT = '-1 = 不限';

export type EditorKind =
    | 'seconds'
    | 'minutes'
    | 'count'
    | 'boolean'
    | 'retention'
    | 'quota'
    | 'rate'
    | 'publishRate'
    | 'strategy'
    | 'clusters';

export interface PolicyEditor {
    kind: EditorKind;
    min?: number;
    max?: number;
    // 布尔与枚举的候选；数字编辑器用 unit 标注单位
    unit?: string;
    options?: {label: string; value: string}[];
    // 需要点名单条的字段（积压配额）在清除时要带上
    needsQuotaType?: boolean;
}

export interface PolicyRow {
    key: string;
    label: string;
    // 没有 field 的行只读：broker 侧没有对应的写入口，或我们没接
    field?: NamespacePolicyField;
    editor?: PolicyEditor;
    hint?: string;
    render: (view: NamespacePolicyView) => string;
}

const intText = (value: number | null, unit: string): string =>
    value === null ? NOT_SET : `${value.toLocaleString('en-US')}${unit}`;

const boolText = (value: boolean | null): string => (value === null ? NOT_SET : value ? '已启用' : '已停用');

const listText = (values: string[]): string => (values.length > 0 ? values.join('、') : '无');

// 限速按「条/秒 与 字节/秒」读：broker 存的其实是「每周期」，
// 周期本身也在值里（ratePeriodInSecond），这里换算成每秒，
// 否则同一份配置换个周期显示出来的数字差几十倍。
function rateText(rate: NamespacePolicyView['dispatchRate']): string {
    if (!rate) {
        return NOT_SET;
    }
    const period = rate.periodInSeconds && rate.periodInSeconds > 0 ? rate.periodInSeconds : 1;
    const parts: string[] = [];
    parts.push(rate.msgPerPeriod < 0 ? '条数不限' : `${round(rate.msgPerPeriod / period)} 条/秒`);
    parts.push(rate.bytePerPeriod < 0 ? '大小不限' : `${round(rate.bytePerPeriod / period / 1024)} KB/秒`);
    return parts.join('，');
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

function quotaText(view: NamespacePolicyView): string {
    if (view.backlogQuotas.length === 0) {
        return NOT_SET;
    }
    return view.backlogQuotas
        .map(
            quota =>
                `${quotaTypeName(quota.type)} ${mb(quota.limitSizeBytes)}，超限 ${policyName(quota.policy)}${
                    quota.limitTimeSeconds > 0 ? `，时限 ${quota.limitTimeSeconds}s` : ''
                }`,
        )
        .join('；');
}

function mb(bytes: number): string {
    return `${round(bytes / (1024 * 1024))}MB`;
}

export const QUOTA_TYPE_OPTIONS = [
    {label: 'destination_storage（按存储容量）', value: 'destination_storage'},
    {label: 'message_age（按消息年龄）', value: 'message_age'},
];

export const QUOTA_POLICY_OPTIONS = [
    {label: 'producer_request_hold（挂起生产者）', value: 'producer_request_hold'},
    {label: 'producer_exception（报错拒绝）', value: 'producer_exception'},
    {label: 'consumer_backlog_eviction（丢最老消息）', value: 'consumer_backlog_eviction'},
];

const quotaTypeName = (type: string): string => QUOTA_TYPE_OPTIONS.find(option => option.value === type)?.label ?? type;

const policyName = (policy: string): string =>
    QUOTA_POLICY_OPTIONS.find(option => option.value === policy)?.label ?? policy;

export const SCHEMA_COMPATIBILITY_OPTIONS = [
    'UNDEFINED',
    'ALWAYS_COMPATIBLE',
    'ALWAYS_INCOMPATIBLE',
    'BACKWARD',
    'BACKWARD_TRANSITIVE',
    'FORWARD',
    'FORWARD_TRANSITIVE',
    'FULL',
    'FULL_TRANSITIVE',
].map(value => ({label: value, value}));

// 自动更新策略的枚举写法与兼容策略不同（首字母大写的驼峰），
// 这是 broker 侧两个不同枚举类，抄错大小写会得到一句没有字段提示的 400。
export const SCHEMA_AUTO_UPDATE_OPTIONS = [
    'AutoUpdateDisabled',
    'Backward',
    'Forward',
    'Full',
    'AlwaysCompatible',
    'BackwardTransitive',
    'ForwardTransitive',
].map(value => ({label: value, value}));

const BOOL_OPTIONS = [
    {label: '启用', value: 'true'},
    {label: '停用', value: 'false'},
];

function booleanEditor(): PolicyEditor {
    return {kind: 'boolean', options: BOOL_OPTIONS};
}

function numberEditor(kind: EditorKind, min: number, max: number, unit: string): PolicyEditor {
    return {kind, min, max, unit};
}

const INT_MAX = 2147483647;

export const POLICY_GROUPS: {title: string; rows: PolicyRow[]}[] = [
    {
        title: '保留与过期',
        rows: [
            {
                key: 'retention',
                label: '保留策略',
                field: 'retention',
                editor: {kind: 'retention'},
                hint: `时长与容量都是 -1 表示无限；0 表示不保留。${UNLIMITED_HINT}`,
                render: view => {
                    if (view.retentionTimeInMinutes === null && view.retentionSizeInMB === null) {
                        return NOT_SET;
                    }
                    const time = view.retentionTimeInMinutes;
                    const size = view.retentionSizeInMB;
                    return [
                        time === null ? '时长按 broker 默认' : time < 0 ? '时长无限' : `时长 ${time} 分钟`,
                        size === null ? '容量按 broker 默认' : size < 0 ? '容量无限' : `容量 ${size}MB`,
                    ].join('，');
                },
            },
            {
                key: 'messageTtlSeconds',
                label: '消息 TTL',
                field: 'messageTtlSeconds',
                editor: numberEditor('seconds', 0, INT_MAX, '秒'),
                // 与保留策略相互独立：TTL 到期的消息即使在保留期内也会被删，
                // 这个先后顺序 broker 不会在界面上告诉你。
                hint: '秒。0 = 立刻过期；与保留策略取更严的一侧生效。',
                render: view => intText(view.messageTtlSeconds, ' 秒'),
            },
            {
                key: 'subscriptionExpirationTimeMinutes',
                label: '订阅过期时间',
                field: 'subscriptionExpirationTimeMinutes',
                editor: numberEditor('minutes', 0, INT_MAX, '分钟'),
                hint: '分钟。订阅空闲超过这个时长会被删掉（含积压）。',
                render: view => intText(view.subscriptionExpirationTimeMinutes, ' 分钟'),
            },
        ],
    },
    {
        title: '积压配额',
        rows: [
            {
                key: 'backlogQuota',
                label: '配额与超限策略',
                field: 'backlogQuota',
                editor: {kind: 'quota', needsQuotaType: true},
                hint: '按存储或按消息年龄分别设置；超限后可以挂起生产者、直接报错、或丢最老的消息。',
                render: quotaText,
            },
        ],
    },
    {
        title: '数量上限',
        rows: [
            {
                key: 'maxProducersPerTopic',
                label: '每 Topic 生产者上限',
                field: 'maxProducersPerTopic',
                editor: numberEditor('count', 0, INT_MAX, '个'),
                hint: '0 = 不限。',
                render: view => intText(view.maxProducersPerTopic, ' 个'),
            },
            {
                key: 'maxConsumersPerTopic',
                label: '每 Topic 消费者上限',
                field: 'maxConsumersPerTopic',
                editor: numberEditor('count', 0, INT_MAX, '个'),
                hint: '0 = 不限。',
                render: view => intText(view.maxConsumersPerTopic, ' 个'),
            },
            {
                key: 'maxConsumersPerSubscription',
                label: '每订阅消费者上限',
                field: 'maxConsumersPerSubscription',
                editor: numberEditor('count', 0, INT_MAX, '个'),
                hint: '0 = 不限。',
                render: view => intText(view.maxConsumersPerSubscription, ' 个'),
            },
            {
                key: 'maxUnackedMessagesPerConsumer',
                label: '每消费者未确认上限',
                field: 'maxUnackedMessagesPerConsumer',
                editor: numberEditor('count', 0, INT_MAX, '条'),
                hint: '0 = 不限。超过后该消费者会暂停收到新消息。',
                render: view => intText(view.maxUnackedMessagesPerConsumer, ' 条'),
            },
            {
                key: 'maxUnackedMessagesPerSubscription',
                label: '每订阅未确认上限',
                field: 'maxUnackedMessagesPerSubscription',
                editor: numberEditor('count', 0, INT_MAX, '条'),
                hint: '0 = 不限。',
                render: view => intText(view.maxUnackedMessagesPerSubscription, ' 条'),
            },
            {
                key: 'maxSubscriptionsPerTopic',
                label: '每 Topic 订阅上限',
                field: 'maxSubscriptionsPerTopic',
                editor: numberEditor('count', 0, INT_MAX, '个'),
                hint: '0 = 不限。',
                render: view => intText(view.maxSubscriptionsPerTopic, ' 个'),
            },
            {
                key: 'maxTopicsPerNamespace',
                label: '命名空间 Topic 上限',
                field: 'maxTopicsPerNamespace',
                editor: numberEditor('count', 0, INT_MAX, '个'),
                hint: '0 = 不限。到达上限后建 topic 会失败。',
                render: view => intText(view.maxTopicsPerNamespace, ' 个'),
            },
            {
                key: 'compactionThreshold',
                label: '压缩触发条数',
                field: 'compactionThreshold',
                editor: numberEditor('count', 0, Number.MAX_SAFE_INTEGER, '条'),
                hint: '0 = 关闭压缩。',
                render: view => intText(view.compactionThreshold, ' 条'),
            },
        ],
    },
    {
        title: '流量限速',
        rows: [
            {
                key: 'dispatchRate',
                label: 'Topic 分发限速',
                field: 'dispatchRate',
                editor: {kind: 'rate'},
                hint: '-1 = 不限。按每秒条数与每秒字节数各判一侧，命中即限。',
                render: view => rateText(view.dispatchRate),
            },
            {
                key: 'subscriptionDispatchRate',
                label: '订阅分发限速',
                field: 'subscriptionDispatchRate',
                editor: {kind: 'rate'},
                hint: '-1 = 不限。',
                render: view => rateText(view.subscriptionDispatchRate),
            },
            {
                key: 'replicatorDispatchRate',
                label: '复制分发限速',
                field: 'replicatorDispatchRate',
                editor: {kind: 'rate'},
                hint: '-1 = 不限。只影响跨集群复制链路。',
                render: view => rateText(view.replicatorDispatchRate),
            },
            {
                key: 'subscribeRate',
                label: '订阅建立限速',
                field: 'subscribeRate',
                editor: {kind: 'rate'},
                hint: '每个消费者每秒可发起的订阅次数；条数字段承载次数，字节字段对本项无效。',
                render: view => rateText(view.subscribeRate),
            },
            {
                key: 'publishRate',
                label: '发布限速',
                field: 'publishRate',
                editor: {kind: 'publishRate'},
                hint: '-1 = 不限。这一项 broker 侧没有周期概念，按秒生效。',
                render: view => rateText(view.publishRate),
            },
        ],
    },
    {
        title: '去重与加密',
        rows: [
            {
                key: 'deduplicationEnabled',
                label: '服务端去重',
                field: 'deduplicationEnabled',
                editor: booleanEditor(),
                hint: '开启后按 producer 序列号去重，代价是每条消息都要写一份状态。',
                render: view => boolText(view.deduplicationEnabled),
            },
            {
                key: 'deduplicationSnapshotIntervalSeconds',
                label: '去重快照间隔',
                field: 'deduplicationSnapshotIntervalSeconds',
                editor: numberEditor('seconds', 1, INT_MAX, '秒'),
                // 没有 DELETE 端点：这一项只能改值，回不到「未设置」
                hint: '秒。broker 侧没有清除端点，改过之后只能再改成别的值。',
                render: view => intText(view.deduplicationSnapshotIntervalSeconds, ' 秒'),
            },
            {
                key: 'encryptionRequired',
                label: '强制消息加密',
                field: 'encryptionRequired',
                editor: booleanEditor(),
                hint: '开启后未加密的生产者会被拒绝；broker 侧没有清除端点。',
                render: view => boolText(view.encryptionRequired),
            },
        ],
    },
    {
        title: 'Schema',
        rows: [
            {
                key: 'schemaValidationEnforced',
                label: '强制校验 Schema',
                field: 'schemaValidationEnforced',
                editor: booleanEditor(),
                hint: '开启后无 schema 的生产者会连接失败；非 Java 客户端大多不支持 schema，慎开。',
                render: view => boolText(view.schemaValidationEnforced),
            },
            {
                key: 'allowAutoUpdateSchema',
                label: '允许自动更新 Schema',
                field: 'allowAutoUpdateSchema',
                editor: booleanEditor(),
                hint: '与下面的兼容策略共同决定能否自动更新。',
                render: view => boolText(view.allowAutoUpdateSchema),
            },
            {
                key: 'schemaCompatibilityStrategy',
                label: 'Schema 兼容策略',
                field: 'schemaCompatibilityStrategy',
                editor: {kind: 'strategy', options: SCHEMA_COMPATIBILITY_OPTIONS},
                render: view => view.schemaCompatibilityStrategy ?? NOT_SET,
            },
            {
                key: 'schemaAutoUpdateStrategy',
                label: '自动更新兼容策略',
                field: 'schemaAutoUpdateStrategy',
                editor: {kind: 'strategy', options: SCHEMA_AUTO_UPDATE_OPTIONS},
                hint: '这是另一个枚举类（首字母大写驼峰），与上面的全大写不通用。',
                render: view => view.schemaAutoUpdateStrategy ?? NOT_SET,
            },
        ],
    },
    {
        title: '复制与集群',
        rows: [
            {
                key: 'replicationClusters',
                label: '复制目标集群',
                field: 'replicationClusters',
                editor: {kind: 'clusters'},
                hint: '整表覆盖。移除一个集群会停止向其复制；共用元数据存储的部署里，被移除集群的数据会被删。',
                render: view => (view.replicationClusters.length > 0 ? listText(view.replicationClusters) : '不复制'),
            },
            {
                key: 'allowedClusters',
                label: '允许的集群',
                render: view => listText(view.allowedClusters),
            },
        ],
    },
    {
        title: '其他（只读）',
        rows: [
            {
                key: 'subscriptionTypesEnabled',
                label: '允许的订阅类型',
                render: view =>
                    view.subscriptionTypesEnabled.length > 0 ? listText(view.subscriptionTypesEnabled) : '全部',
            },
            {
                key: 'subscriptionAuthMode',
                label: '订阅鉴权模式',
                render: view => view.subscriptionAuthMode ?? NOT_SET,
            },
            {
                key: 'resourceGroupName',
                label: '资源组',
                render: view => view.resourceGroupName ?? NOT_SET,
            },
        ],
    },
];

export function isClearable(view: NamespacePolicyView, field: NamespacePolicyField): boolean {
    return view.clearableFields.includes(field);
}
