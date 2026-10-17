import {AxiosInstance} from 'axios';
import {Semaphore, orNotFound, seg, withRetry, withSemaphore} from './http-client';
import type {
    NamespaceBacklogQuota,
    NamespaceBacklogQuotaValue,
    NamespacePolicyField,
    NamespacePolicyView,
    NamespaceRateLimit,
    NamespaceRateValue,
    NamespaceRetentionValue,
} from '../../shared/types';

// ========== 取值口径 ==========

// 命名空间策略的 REST 端点全在 /admin/v2/namespaces/{tenant}/{namespace} 下，
// 与 v3 的 functions、topic 的 persistent 前缀都不同一段，这里统一收口。
function namespaceBase(tenant: string, namespace: string): string {
    return `/admin/v2/namespaces/${seg(tenant)}/${seg(namespace)}`;
}

const RETENTION_POLICIES = ['producer_request_hold', 'producer_exception', 'consumer_backlog_eviction'];
export const QUOTA_TYPES = ['destination_storage', 'message_age'];
export {RETENTION_POLICIES};

// broker 的 Policies 对象在键名上是混的：message_ttl_in_seconds 用下划线，
// deduplicationEnabled 与 autoTopicCreationOverride 用驼峰，同一个对象里两种都有。
// 折叠按实际发出的键名取，两种写法都试（驼峰在前，兼容 broker 未来改名）。
function pick(source: Record<string, unknown> | null | undefined, ...keys: string[]): unknown {
    if (!source) {
        return undefined;
    }
    for (const key of keys) {
        const value = source[key];
        if (value !== undefined && value !== null) {
            return value;
        }
    }
    return undefined;
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
}

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map(item => String(item)).filter(Boolean);
}

// 限速三兄弟的键名互不相同（dispatch 用 ...InMsg/...InByte + ratePeriodInSecond，
// subscribe 用 subscribeThrottlingRatePerConsumer，publish 根本没有周期字段），
// 折叠成统一形状、原始体留在 raw 里，写回时再由字段表还原各自形状。
// broker 用 -1 表示「不限制」而不是省略字段，所以这里照抄数值、由界面写文案。
function foldRate(data: unknown): NamespaceRateLimit | null {
    if (!data || typeof data !== 'object') {
        return null;
    }
    const source = data as Record<string, unknown>;
    return {
        msgPerPeriod:
            asNumber(
                pick(
                    source,
                    'dispatchThrottlingRateInMsg',
                    'publishThrottlingRateInMsg',
                    'subscribeThrottlingRatePerConsumer',
                ),
            ) ?? -1,
        bytePerPeriod: asNumber(pick(source, 'dispatchThrottlingRateInByte', 'publishThrottlingRateInByte')) ?? -1,
        periodInSeconds: asNumber(pick(source, 'ratePeriodInSecond')),
        raw: source,
    };
}

// backlog_quota_map 是 {配额类型: 配额对象} 的字典。limitSize 在老 broker 里叫 limit
// （deprecated 但仍在发），只读 limitSize 会把旧集群的配额显示成 0。
function foldBacklogQuotas(source: Record<string, unknown> | null | undefined): NamespaceBacklogQuota[] {
    const map = pick(source, 'backlog_quota_map', 'backlogQuotaMap') as Record<string, unknown> | undefined;
    if (!map || typeof map !== 'object') {
        return [];
    }
    const quotas: NamespaceBacklogQuota[] = [];
    for (const [key, raw] of Object.entries(map)) {
        if (!raw || typeof raw !== 'object') {
            continue;
        }
        const quota = raw as Record<string, unknown>;
        quotas.push({
            // 类型与策略按原文返回：broker 以后加新枚举时界面显示陌生值，
            // 比把它塞进我们认识的三个值里更接近事实
            type: key,
            limitSizeBytes: asNumber(pick(quota, 'limitSize', 'limit')) ?? 0,
            limitTimeSeconds: asNumber(pick(quota, 'limitTime')) ?? 0,
            policy: asString(pick(quota, 'policy')) ?? 'producer_request_hold',
        });
    }
    // 未知类型排在已知类型之后，界面顺序稳定。
    // indexOf 找不到返回 -1，直接相减会让未来的新枚举抢到最前面。
    const rank = (type: string) => {
        const index = QUOTA_TYPES.indexOf(type);
        return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    return quotas.sort((a, b) => rank(a.type) - rank(b.type));
}

function foldPolicies(raw: unknown): NamespacePolicyView {
    const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const retention = pick(source, 'retention_policies', 'retentionPolicies') as Record<string, unknown> | undefined;

    return {
        messageTtlSeconds: asNumber(pick(source, 'messageTtlInSeconds', 'message_ttl_in_seconds')),
        // 这个端点与字段都是分钟，而 messageTTL 是秒：两个相邻字段单位不同，
        // 是 broker 的历史包袱，界面上的单位必须由字段表说了算
        subscriptionExpirationTimeMinutes: asNumber(
            pick(source, 'subscriptionExpirationTimeMinutes', 'subscription_expiration_time_minutes'),
        ),
        retentionTimeInMinutes: asNumber(retention?.retentionTimeInMinutes),
        retentionSizeInMB: asNumber(retention?.retentionSizeInMB),
        deduplicationEnabled: asBoolean(pick(source, 'deduplicationEnabled', 'deduplication_enabled')),
        deduplicationSnapshotIntervalSeconds: asNumber(pick(source, 'deduplicationSnapshotIntervalSeconds')),
        backlogQuotas: foldBacklogQuotas(source),
        maxProducersPerTopic: asNumber(pick(source, 'maxProducersPerTopic', 'max_producers_per_topic')),
        maxConsumersPerTopic: asNumber(pick(source, 'maxConsumersPerTopic', 'max_consumers_per_topic')),
        maxConsumersPerSubscription: asNumber(
            pick(source, 'maxConsumersPerSubscription', 'max_consumers_per_subscription'),
        ),
        maxUnackedMessagesPerConsumer: asNumber(
            pick(source, 'maxUnackedMessagesPerConsumer', 'max_unacked_messages_per_consumer'),
        ),
        maxUnackedMessagesPerSubscription: asNumber(
            pick(source, 'maxUnackedMessagesPerSubscription', 'max_unacked_messages_per_subscription'),
        ),
        maxSubscriptionsPerTopic: asNumber(pick(source, 'maxSubscriptionsPerTopic', 'max_subscriptions_per_topic')),
        maxTopicsPerNamespace: asNumber(pick(source, 'maxTopicsPerNamespace', 'max_topics_per_namespace')),
        compactionThreshold: asNumber(pick(source, 'compactionThreshold', 'compaction_threshold')),
        schemaValidationEnforced: asBoolean(pick(source, 'schemaValidationEnforced', 'schema_validation_enforced')),
        schemaCompatibilityStrategy: asString(
            pick(source, 'schemaCompatibilityStrategy', 'schema_compatibility_strategy'),
        ),
        schemaAutoUpdateStrategy: asString(
            pick(source, 'schemaAutoUpdateCompatibilityStrategy', 'schema_auto_update_compatibility_strategy'),
        ),
        allowAutoUpdateSchema: asBoolean(pick(source, 'isAllowAutoUpdateSchema', 'is_allow_auto_update_schema')),
        // encryption_required 是原生 boolean，缺省 false 而不是「未设置」
        encryptionRequired: asBoolean(pick(source, 'encryptionRequired', 'encryption_required')),
        subscriptionTypesEnabled: asStringArray(pick(source, 'subscriptionTypesEnabled', 'subscription_types_enabled')),
        subscriptionAuthMode: asString(pick(source, 'subscriptionAuthMode', 'subscription_auth_mode')),
        replicationClusters: asStringArray(pick(source, 'replicationClusters', 'replication_clusters')),
        allowedClusters: asStringArray(pick(source, 'allowedClusters', 'allowed_clusters')),
        resourceGroupName: asString(pick(source, 'resourceGroupName', 'resource_group_name')),
        dispatchRate: null,
        subscriptionDispatchRate: null,
        subscribeRate: null,
        publishRate: null,
        replicatorDispatchRate: null,
        clearableFields: [],
        raw: source,
    };
}

// ========== 字段表：写入端点、动词、能否清除、请求体形状 ==========

interface PolicyRequest {
    path: string;
    verb: 'post' | 'put';
    body: unknown;
    params?: Record<string, string>;
}

const UNLIMITED_INT = 2147483647;

function fail(field: string, expected: string, value: unknown): never {
    throw new Error(`${field}${expected}，收到 ${JSON.stringify(value) ?? String(value)}`);
}

function requireInt(field: string, expected: string, value: unknown, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        fail(field, expected, value);
    }
    const num = value as number;
    if (num < min || num > max) {
        fail(field, `需要在 ${min}..${max} 之间`, num);
    }
    return num;
}

function requireBoolean(field: string, expected: string, value: unknown): boolean {
    if (typeof value !== 'boolean') {
        fail(field, expected, value);
    }
    return value as boolean;
}

function requireEnum(field: string, value: unknown, allowed: string[]): string {
    const text = asString(value);
    if (!text || !allowed.includes(text)) {
        fail(field, `必须是 ${allowed.join(' / ')} 之一`, value);
    }
    return text;
}

function requireRate(field: string, value: unknown, withPeriod: boolean): NamespaceRateValue {
    if (!value || typeof value !== 'object') {
        fail(field, '需要 {msgPerPeriod, bytePerPeriod} 形状', value);
    }
    const input = value as Record<string, unknown>;
    const msgPerPeriod = requireInt(field, '的条数限速', input.msgPerPeriod, -1, UNLIMITED_INT);
    const bytePerPeriod = requireInt(field, '的字节限速', input.bytePerPeriod, -1, Number.MAX_SAFE_INTEGER);
    if (!withPeriod) {
        return {msgPerPeriod, bytePerPeriod};
    }
    const period = requireInt(field, '的周期（秒）', input.periodInSeconds, 1, 3600);
    return {msgPerPeriod, bytePerPeriod, periodInSeconds: period};
}

function requireRetention(value: unknown): NamespaceRetentionValue {
    if (!value || typeof value !== 'object') {
        throw new Error(`保留策略需要 {timeInMinutes, sizeInMB} 形状，收到 ${String(JSON.stringify(value))}`);
    }
    const input = value as Record<string, unknown>;
    return {
        // -1 = 无限保留，0 = 不保留：三个特殊值都有意义，不能互相塌缩
        timeInMinutes: requireInt('保留时长', '需要 -1 及以上的整数分钟', input.timeInMinutes, -1, UNLIMITED_INT),
        sizeInMB: requireInt('保留容量', '需要 -1 及以上的整数 MB', input.sizeInMB, -1, Number.MAX_SAFE_INTEGER),
    };
}

function requireQuota(value: unknown): NamespaceBacklogQuotaValue {
    if (!value || typeof value !== 'object') {
        throw new Error(
            `积压配额需要 {type, limitSizeBytes, limitTimeSeconds, policy} 形状，收到 ${String(JSON.stringify(value))}`,
        );
    }
    const input = value as Record<string, unknown>;
    return {
        type: requireEnum('配额类型', input.type, QUOTA_TYPES) as NamespaceBacklogQuotaValue['type'],
        policy: requireEnum('超限处理策略', input.policy, RETENTION_POLICIES) as NamespaceBacklogQuotaValue['policy'],
        limitSizeBytes: requireInt(
            '配额大小',
            '需要 0 及以上的字节数',
            input.limitSizeBytes,
            0,
            Number.MAX_SAFE_INTEGER,
        ),
        limitTimeSeconds: requireInt('配额时长', '需要 0 及以上的整数秒', input.limitTimeSeconds, 0, UNLIMITED_INT),
    };
}

function requireClusterList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        throw new Error(`复制集群需要一个字符串数组，收到 ${String(JSON.stringify(value))}`);
    }
    const list = value.map(item => String(item).trim()).filter(Boolean);
    if (new Set(list).size !== list.length) {
        throw new Error('复制集群列表里有重复项');
    }
    return list;
}

// schema 策略的取值直接抄 broker 的枚举：写成小写或翻译成中文都会得到 400，
// 而 broker 的 400 响应体里只有一句 "Invalid schema compatibility strategy"。
const SCHEMA_COMPATIBILITY_STRATEGIES = [
    'UNDEFINED',
    'ALWAYS_COMPATIBLE',
    'ALWAYS_INCOMPATIBLE',
    'BACKWARD',
    'BACKWARD_TRANSITIVE',
    'FORWARD',
    'FORWARD_TRANSITIVE',
    'FULL',
    'FULL_TRANSITIVE',
];

const SCHEMA_AUTO_UPDATE_STRATEGIES = [
    'AutoUpdateDisabled',
    'Backward',
    'Forward',
    'Full',
    'AlwaysCompatible',
    'BackwardTransitive',
    'ForwardTransitive',
];

type Encoder = (value: unknown) => unknown;

function intField(min: number, max: number, unit: string): Encoder {
    return value => requireInt('该配置', `需要 ${min}..${max} 的整数${unit}`, value, min, max);
}

function boolField(): Encoder {
    return value => requireBoolean('该配置', '需要布尔值', value);
}

// 限速请求体由字段表按各自键名还原：3.x 起三种限速都是 msg/byte/period 形状，
// 2.x 的 kiloBitPerSec 形状不再支持（该版本已 EOL）。
// 少发一个键 broker 会按 0 处理（等于全禁），所以限速必须整对象发出。
interface PolicyFieldSpec {
    // 相对命名空间路径的端点后缀
    path: string;
    // 设置动词：多数是 POST，compactionThreshold 与两个 schema 策略是 PUT。
    // 用错动词会得到 405，而 405 的响应体不带任何提示。
    verb: 'post' | 'put';
    // 有没有 DELETE 端点。没有的字段只能改成别的值，做不到「清除回 broker 默认」，
    // 界面据此隐藏清除按钮——而不是让清除变成一次 405。
    clearable: boolean;
    encode: Encoder;
}

const FIELD_SPECS: Record<NamespacePolicyField, PolicyFieldSpec> = {
    messageTtlSeconds: {path: 'messageTTL', verb: 'post', clearable: true, encode: intField(0, UNLIMITED_INT, '秒')},
    subscriptionExpirationTimeMinutes: {
        path: 'subscriptionExpirationTime',
        verb: 'post',
        clearable: true,
        encode: intField(0, UNLIMITED_INT, '分钟'),
    },
    retention: {
        path: 'retention',
        verb: 'post',
        clearable: true,
        encode: value => requireRetention(value),
    },
    deduplicationEnabled: {path: 'deduplication', verb: 'post', clearable: true, encode: boolField()},
    deduplicationSnapshotIntervalSeconds: {
        path: 'deduplicationSnapshotInterval',
        verb: 'post',
        clearable: false,
        encode: intField(1, UNLIMITED_INT, '秒'),
    },
    backlogQuota: {
        path: 'backlogQuota',
        verb: 'post',
        clearable: true,
        encode: value => requireQuota(value),
    },
    maxProducersPerTopic: {
        path: 'maxProducersPerTopic',
        verb: 'post',
        clearable: true,
        encode: intField(0, UNLIMITED_INT, ''),
    },
    maxConsumersPerTopic: {
        path: 'maxConsumersPerTopic',
        verb: 'post',
        clearable: true,
        encode: intField(0, UNLIMITED_INT, ''),
    },
    maxConsumersPerSubscription: {
        path: 'maxConsumersPerSubscription',
        verb: 'post',
        clearable: true,
        encode: intField(0, UNLIMITED_INT, ''),
    },
    maxUnackedMessagesPerConsumer: {
        path: 'maxUnackedMessagesPerConsumer',
        verb: 'post',
        clearable: true,
        encode: intField(0, UNLIMITED_INT, ''),
    },
    maxUnackedMessagesPerSubscription: {
        path: 'maxUnackedMessagesPerSubscription',
        verb: 'post',
        clearable: true,
        encode: intField(0, UNLIMITED_INT, ''),
    },
    maxSubscriptionsPerTopic: {
        path: 'maxSubscriptionsPerTopic',
        verb: 'post',
        clearable: true,
        encode: intField(0, UNLIMITED_INT, ''),
    },
    maxTopicsPerNamespace: {
        path: 'maxTopicsPerNamespace',
        verb: 'post',
        clearable: true,
        encode: intField(0, UNLIMITED_INT, ''),
    },
    compactionThreshold: {
        path: 'compactionThreshold',
        verb: 'put',
        clearable: true,
        encode: intField(0, Number.MAX_SAFE_INTEGER, '条'),
    },
    schemaValidationEnforced: {
        path: 'schemaValidationEnforced',
        verb: 'post',
        clearable: false,
        encode: boolField(),
    },
    schemaCompatibilityStrategy: {
        path: 'schemaCompatibilityStrategy',
        verb: 'put',
        clearable: false,
        encode: value => requireEnum('Schema 兼容策略', value, SCHEMA_COMPATIBILITY_STRATEGIES),
    },
    schemaAutoUpdateStrategy: {
        path: 'schemaAutoUpdateCompatibilityStrategy',
        verb: 'put',
        clearable: false,
        encode: value => requireEnum('Schema 自动更新策略', value, SCHEMA_AUTO_UPDATE_STRATEGIES),
    },
    allowAutoUpdateSchema: {
        path: 'isAllowAutoUpdateSchema',
        verb: 'post',
        clearable: false,
        encode: boolField(),
    },
    encryptionRequired: {path: 'encryptionRequired', verb: 'post', clearable: false, encode: boolField()},
    dispatchRate: {
        path: 'dispatchRate',
        verb: 'post',
        clearable: true,
        encode: value => {
            const rate = requireRate('分发限速', value, true);
            return {
                dispatchThrottlingRateInMsg: rate.msgPerPeriod,
                dispatchThrottlingRateInByte: rate.bytePerPeriod,
                ratePeriodInSecond: rate.periodInSeconds,
            };
        },
    },
    subscriptionDispatchRate: {
        path: 'subscriptionDispatchRate',
        verb: 'post',
        clearable: true,
        encode: value => {
            const rate = requireRate('订阅分发限速', value, true);
            return {
                dispatchThrottlingRateInMsg: rate.msgPerPeriod,
                dispatchThrottlingRateInByte: rate.bytePerPeriod,
                ratePeriodInSecond: rate.periodInSeconds,
            };
        },
    },
    replicatorDispatchRate: {
        path: 'replicatorDispatchRate',
        verb: 'post',
        clearable: true,
        encode: value => {
            const rate = requireRate('复制分发限速', value, true);
            return {
                dispatchThrottlingRateInMsg: rate.msgPerPeriod,
                dispatchThrottlingRateInByte: rate.bytePerPeriod,
                ratePeriodInSecond: rate.periodInSeconds,
            };
        },
    },
    subscribeRate: {
        path: 'subscribeRate',
        verb: 'post',
        clearable: true,
        encode: value => {
            const rate = requireRate('订阅限速', value, true);
            return {
                subscribeThrottlingRatePerConsumer: rate.msgPerPeriod,
                ratePeriodInSecond: rate.periodInSeconds,
            };
        },
    },
    publishRate: {
        path: 'publishRate',
        verb: 'post',
        clearable: true,
        encode: value => {
            const rate = requireRate('发布限速', value, false);
            return {
                publishThrottlingRateInMsg: rate.msgPerPeriod,
                publishThrottlingRateInByte: rate.bytePerPeriod,
            };
        },
    },
    replicationClusters: {
        path: 'replication',
        verb: 'post',
        clearable: false,
        encode: value => requireClusterList(value),
    },
};

// 限速字段按 raw 里的键还原形状：3.x 起就是 msg/byte/period 三个键，
// 2.x 的 kiloBitPerSec 形状不再支持（那个版本已 EOL）。
export const POLICY_FIELDS = Object.keys(FIELD_SPECS) as NamespacePolicyField[];
export const CLEARABLE_POLICY_FIELDS = POLICY_FIELDS.filter(field => FIELD_SPECS[field].clearable);

export function isClearablePolicyField(field: NamespacePolicyField): boolean {
    return FIELD_SPECS[field]?.clearable === true;
}

function rateValueOf(rate: NamespaceRateLimit | null, withPeriod: boolean): NamespaceRateValue | null {
    if (!rate) {
        return null;
    }
    // 限速必须整对象写回：少发一个键 broker 按 0 处理，等于把那个维度全禁。
    // 老 broker 不返回 ratePeriodInSecond 时补 1——那正是它自己的默认周期。
    const value: NamespaceRateValue = {msgPerPeriod: rate.msgPerPeriod, bytePerPeriod: rate.bytePerPeriod};
    if (withPeriod) {
        value.periodInSeconds = rate.periodInSeconds && rate.periodInSeconds > 0 ? rate.periodInSeconds : 1;
    }
    return value;
}

/**
 * 把折叠视图还原成「这个字段再次写入时要传的值」，也就是 setPolicy 的入参形状；
 * null 表示这一项在该命名空间上确实没设过。
 *
 * 读回来的形状与写进去的形状并不相同（限速读回来带 raw、写回去只要三个数字；
 * 配额读回来是一个列表、写回去一次只写一条），所以比对必须比"写回去的值"，
 * 否则读—比—写每一步都会重新发明一遍换算。
 */
export function policyValueOf(view: NamespacePolicyView, field: NamespacePolicyField): unknown {
    switch (field) {
        case 'messageTtlSeconds':
            return view.messageTtlSeconds;
        case 'subscriptionExpirationTimeMinutes':
            return view.subscriptionExpirationTimeMinutes;
        case 'deduplicationSnapshotIntervalSeconds':
            return view.deduplicationSnapshotIntervalSeconds;
        case 'retention':
            // 只读出一半的保留策略不能写：POST /retention 是整体替换，
            // 缺的那个数字补 0 会把「无限保留」变成「一条不留」。
            if (view.retentionTimeInMinutes === null || view.retentionSizeInMB === null) {
                return null;
            }
            return {timeInMinutes: view.retentionTimeInMinutes, sizeInMB: view.retentionSizeInMB};
        case 'backlogQuota':
            // 逐条比对由批量同步按 type 展开，这里整表返回
            return view.backlogQuotas;
        case 'deduplicationEnabled':
            return view.deduplicationEnabled;
        case 'maxProducersPerTopic':
            return view.maxProducersPerTopic;
        case 'maxConsumersPerTopic':
            return view.maxConsumersPerTopic;
        case 'maxConsumersPerSubscription':
            return view.maxConsumersPerSubscription;
        case 'maxUnackedMessagesPerConsumer':
            return view.maxUnackedMessagesPerConsumer;
        case 'maxUnackedMessagesPerSubscription':
            return view.maxUnackedMessagesPerSubscription;
        case 'maxSubscriptionsPerTopic':
            return view.maxSubscriptionsPerTopic;
        case 'maxTopicsPerNamespace':
            return view.maxTopicsPerNamespace;
        case 'compactionThreshold':
            return view.compactionThreshold;
        case 'schemaValidationEnforced':
            return view.schemaValidationEnforced;
        case 'allowAutoUpdateSchema':
            return view.allowAutoUpdateSchema;
        case 'encryptionRequired':
            return view.encryptionRequired;
        case 'schemaCompatibilityStrategy':
            return view.schemaCompatibilityStrategy;
        case 'schemaAutoUpdateStrategy':
            return view.schemaAutoUpdateStrategy;
        case 'dispatchRate':
            return rateValueOf(view.dispatchRate, true);
        case 'subscriptionDispatchRate':
            return rateValueOf(view.subscriptionDispatchRate, true);
        case 'replicatorDispatchRate':
            return rateValueOf(view.replicatorDispatchRate, true);
        case 'subscribeRate':
            return rateValueOf(view.subscribeRate, true);
        case 'publishRate':
            return rateValueOf(view.publishRate, false);
        case 'replicationClusters':
            return view.replicationClusters;
        default:
            return undefined;
    }
}

function buildRequest(field: NamespacePolicyField, value: unknown): PolicyRequest {
    const spec = FIELD_SPECS[field];
    if (!spec) {
        throw new Error(`不支持修改的命名空间字段：${field}`);
    }
    let body = spec.encode(value);
    let params: Record<string, string> | undefined;
    // backlogQuota 的配额类型走查询参数，不在请求体里；
    // 请求体里多出来的 type 键 broker 不认识，会被 Jackson 拒成 400。
    if (field === 'backlogQuota') {
        const quota = body as NamespaceBacklogQuotaValue;
        params = {backlogQuotaType: quota.type};
        body = {
            limitSize: quota.limitSizeBytes,
            limitTime: quota.limitTimeSeconds,
            policy: quota.policy,
        };
    }
    // 复制集群端点收的是裸 JSON 字符串数组请求体。3.3.9 实测：把集群名放进
    // clusters 查询参数会返回 412 ClusterIds should not be null or empty，
    // 请求体 {clusterIds:[...]} 则被 Jackson 拒成 400。
    if (field === 'replicationClusters') {
        return {path: spec.path, verb: spec.verb, body};
    }
    return {path: spec.path, verb: spec.verb, body, params};
}

// ========== 客户端 ==========

export class NamespacePolicyAPI {
    private http: AxiosInstance;
    private semaphore: Semaphore;

    constructor(http: AxiosInstance, semaphore: Semaphore) {
        this.http = http;
        this.semaphore = semaphore;
    }

    private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
        return withSemaphore(this.semaphore, fn);
    }

    /**
     * 读取命名空间策略。
     * 主对象一次 GET 就够（broker 把全部策略放在同一个 Policies 里），
     * 但五个限速字段在主对象里是按集群分组的字典，取值要按当前集群解析很麻烦，
     * 而 broker 为每个限速都提供了已经解析好的专用端点，所以另发五个 GET。
     * 专用端点在老 broker 上可能不存在，全部用 orNotFound 兜住：
     * 读不到就显示「未设置」，不能让一个限速端点 404 把整页策略搞成加载失败。
     */
    async getPolicies(tenant: string, namespace: string): Promise<NamespacePolicyView> {
        return this.enqueue(async () => {
            const base = namespaceBase(tenant, namespace);
            const response = await withRetry(() => this.http.get(base));
            const view = foldPolicies(response.data);

            const [dispatchRate, subscriptionDispatchRate, subscribeRate, publishRate, replicatorDispatchRate] =
                await Promise.all([
                    orNotFound(() => this.http.get(`${base}/dispatchRate`), null),
                    orNotFound(() => this.http.get(`${base}/subscriptionDispatchRate`), null),
                    orNotFound(() => this.http.get(`${base}/subscribeRate`), null),
                    orNotFound(() => this.http.get(`${base}/publishRate`), null),
                    orNotFound(() => this.http.get(`${base}/replicatorDispatchRate`), null),
                ]);

            view.dispatchRate = foldRate(dispatchRate?.data);
            view.subscriptionDispatchRate = foldRate(subscriptionDispatchRate?.data);
            view.subscribeRate = foldRate(subscribeRate?.data);
            view.publishRate = foldRate(publishRate?.data);
            view.replicatorDispatchRate = foldRate(replicatorDispatchRate?.data);
            view.clearableFields = CLEARABLE_POLICY_FIELDS;
            return view;
        });
    }

    async setPolicy(tenant: string, namespace: string, field: NamespacePolicyField, value: unknown): Promise<void> {
        return this.enqueue(async () => {
            const request = buildRequest(field, value);
            const url = `${namespaceBase(tenant, namespace)}/${request.path}`;
            if (request.verb === 'put') {
                await this.http.put(url, request.body, {params: request.params});
                return;
            }
            await this.http.post(url, request.body, {params: request.params});
        });
    }

    /**
     * 清除命名空间级覆盖，回退到 broker 默认。
     * 只有 broker 提供了 DELETE 端点的字段可清除；对没有 DELETE 的字段强行请求会得到 405，
     * 与其把 broker 的方法不匹配透传给用户，不如在这里就说清楚。
     */
    async clearPolicy(
        tenant: string,
        namespace: string,
        field: NamespacePolicyField,
        quotaType?: string,
    ): Promise<void> {
        return this.enqueue(async () => {
            const spec = FIELD_SPECS[field];
            if (!spec) {
                throw new Error(`不支持修改的命名空间字段：${field}`);
            }
            if (!spec.clearable) {
                throw new Error(`${field} 在 broker 侧没有删除端点，只能改成别的值，无法清除回默认`);
            }
            // backlogQuota 一个端点下挂着多条配额（按存储 / 按消息年龄），
            // DELETE 必须点名删哪一条，不带类型 broker 会当成参数缺失拒绝。
            let params: Record<string, string> | undefined;
            if (field === 'backlogQuota') {
                const type = requireEnum('配额类型', quotaType, QUOTA_TYPES);
                params = {backlogQuotaType: type};
            }
            await this.http.delete(`${namespaceBase(tenant, namespace)}/${spec.path}`, {params});
        });
    }
}
