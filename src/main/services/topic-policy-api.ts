import {AxiosInstance} from 'axios';
import {NotFoundError, Semaphore, orNotFound, withRetry, withSemaphore} from './http-client';
import {shortTopicName, topicPath} from './resource-api';
import type {TopicPolicyField, TopicPolicyView} from '../../shared/types';

// ========== Topic 级策略（TopicPolicies）==========
//
// 命名空间策略是「读一份 Policies 大对象、按字段写」，topic 级完全是另一种形状：
// broker 不给 topic 返回整份策略，一个字段一条端点，GET 回来的就是那个值本身
// （retention 例外，它回一个两键对象）。所以这里的读取是 N 条 GET 拼一份视图，
// 而不是折叠一个大对象。
//
// 请求形状有三条互不通用的口径，全部来自 broker 端方法的参数声明：
// - messageTTL 用 `@QueryParam("messageTTL")`，请求体是空的 JSON 字符串；
// - deduplicationEnabled 与两个 maxUnacked 收裸标量请求体（`Boolean` / `Integer`）；
// - retention 收 RetentionPolicies 对象。
// 把裸标量当查询参数发、或把 TTL 当请求体发，broker 收到的都是缺省值——
// 现象是「204 成功但值没变」，比直接报错更难查。
//
// 字段表只收这三件套（GET/POST/DELETE）齐全且形状核对过的项。topic 级还有
// inactiveTopicPolicies、delayedDelivery、offloadPolicies、persistence 等端点，
// 它们的请求体没有逐字段验证过，臆造出来的结果是把 400 当成用户填错了。

const UNLIMITED_INT = 2147483647;

function requireInt(label: string, value: unknown, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        throw new Error(`${label}需要一个整数，收到 ${String(JSON.stringify(value))}`);
    }
    if (value < min || value > max) {
        throw new Error(`${label}需要在 ${min}..${max} 之间，收到 ${value}`);
    }
    return value;
}

function requireBoolean(label: string, value: unknown): boolean {
    if (typeof value !== 'boolean') {
        throw new Error(`${label}需要 true 或 false，收到 ${String(JSON.stringify(value))}`);
    }
    return value;
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

interface TopicFieldSpec {
    // 挂在 topic 资源路径下的端点后缀
    path: string;
    // 错误信息与日志里用的中文名；界面文案在渲染层的字段表里，两处不共用一份，
    // 因为这里的名字要出现在「写入被 broker 拒绝」这类主进程错误里。
    label: string;
    // 发送形状：query = 值进查询参数、请求体留空；body = 值原样进请求体（裸标量或对象）
    send: {mode: 'query'; key: string} | {mode: 'body'};
    encode: (value: unknown) => number | boolean | Record<string, unknown>;
}

const RETENTION_LABEL = '保留策略';

const FIELD_SPECS: Record<TopicPolicyField, TopicFieldSpec> = {
    retention: {
        path: 'retention',
        label: RETENTION_LABEL,
        send: {mode: 'body'},
        encode: value => {
            if (!value || typeof value !== 'object') {
                throw new Error(
                    `${RETENTION_LABEL}需要 {timeInMinutes, sizeInMB} 形状，收到 ${String(JSON.stringify(value))}`,
                );
            }
            const input = value as Record<string, unknown>;
            // POST /retention 是整体替换：两个维度必须一起发，缺的那个不能猜 0
            //（0 在 broker 那里是「这条不留 / 立刻过期」，与「按上层走」差一个方向）。
            return {
                retentionTimeInMinutes: requireInt(
                    `${RETENTION_LABEL}的时长（分钟）`,
                    input.timeInMinutes,
                    -1,
                    UNLIMITED_INT,
                ),
                retentionSizeInMB: requireInt(
                    `${RETENTION_LABEL}的容量（MB）`,
                    input.sizeInMB,
                    -1,
                    Number.MAX_SAFE_INTEGER,
                ),
            };
        },
    },
    messageTtlSeconds: {
        path: 'messageTTL',
        label: '消息 TTL',
        send: {mode: 'query', key: 'messageTTL'},
        // broker 明确拒绝负数 TTL（412），0 是合法值（立刻过期）
        encode: value => requireInt('消息 TTL（秒）', value, 0, UNLIMITED_INT),
    },
    deduplicationEnabled: {
        path: 'deduplicationEnabled',
        label: '服务端去重',
        send: {mode: 'body'},
        encode: value => requireBoolean('服务端去重', value),
    },
    maxUnackedMessagesPerConsumer: {
        path: 'maxUnackedMessagesOnConsumer',
        label: '每消费者未确认上限',
        send: {mode: 'body'},
        encode: value => requireInt('每消费者未确认上限', value, 0, UNLIMITED_INT),
    },
    maxUnackedMessagesPerSubscription: {
        path: 'maxUnackedMessagesOnSubscription',
        label: '每订阅未确认上限',
        send: {mode: 'body'},
        encode: value => requireInt('每订阅未确认上限', value, 0, UNLIMITED_INT),
    },
};

export const TOPIC_POLICY_FIELDS = Object.keys(FIELD_SPECS) as TopicPolicyField[];
// 五个端点都有 DELETE（撤销 topic 级覆盖、退回命名空间），所以全部可清除。
export const CLEARABLE_TOPIC_POLICY_FIELDS = TOPIC_POLICY_FIELDS;

export function isClearableTopicPolicyField(field: TopicPolicyField): boolean {
    return TOPIC_POLICY_FIELDS.includes(field);
}

/**
 * 折叠视图还原成「这个字段再次写入时的入参形状」。
 * 读取形状与写入形状不同（retention 读回来摊成两个键、写回去是一个对象），
 * 比对必须比写回去的值，否则读—比—写每一步都要重新换算一遍。
 */
export function topicPolicyValueOf(view: TopicPolicyView, field: TopicPolicyField): unknown {
    switch (field) {
        case 'retention':
            // 两个维度要么一起有、一起没有；只读出一半时不能写回——
            // POST 是整对象替换，缺的那个数字补 0 会把「无限保留」变成「一条不留」。
            if (view.retentionTimeInMinutes === null || view.retentionSizeInMB === null) {
                return null;
            }
            return {timeInMinutes: view.retentionTimeInMinutes, sizeInMB: view.retentionSizeInMB};
        case 'messageTtlSeconds':
            return view.messageTtlSeconds;
        case 'deduplicationEnabled':
            return view.deduplicationEnabled;
        case 'maxUnackedMessagesPerConsumer':
            return view.maxUnackedMessagesPerConsumer;
        case 'maxUnackedMessagesPerSubscription':
            return view.maxUnackedMessagesPerSubscription;
        default:
            return undefined;
    }
}

// 单字段 GET 的结果：值 + 读不出来的原因（互斥）。
interface PolicyRead {
    value?: unknown;
    unavailable?: string;
}

// topic 级策略在这台 broker 上是整片开关的：405 就是 topicLevelPoliciesEnabled=false。
// 这句话必须原样送到界面上——它和「这个 topic 没配」是两种完全不同的现场，
// 前者改 broker 配置就能恢复，后者本来就应该是空的。
function describeReadFailure(error: unknown): string | null {
    if (error instanceof NotFoundError) {
        return '该 broker 上没有这个 topic 级端点（Pulsar 版本过旧）';
    }
    const message = String((error as Error)?.message ?? error ?? '');
    if (/\((405|501)\)$/.test(message) || /topic level policy is disabled/i.test(message)) {
        return '该 broker 未开启 topic 级策略（broker.conf 的 topicLevelPoliciesEnabled=true 才能设置）';
    }
    return null;
}

function blankView(topicName: string, persistent: boolean): TopicPolicyView {
    return {
        topicName,
        persistent,
        retentionTimeInMinutes: null,
        retentionSizeInMB: null,
        messageTtlSeconds: null,
        deduplicationEnabled: null,
        maxUnackedMessagesPerConsumer: null,
        maxUnackedMessagesPerSubscription: null,
        clearableFields: CLEARABLE_TOPIC_POLICY_FIELDS,
        unavailable: [],
        raw: {},
    };
}

// ========== 客户端 ==========

export class TopicPolicyAPI {
    private http: AxiosInstance;
    private semaphore: Semaphore;

    constructor(http: AxiosInstance, semaphore: Semaphore) {
        this.http = http;
        this.semaphore = semaphore;
    }

    private base(tenant: string, namespace: string, topic: string, persistent: boolean): string {
        return topicPath(tenant, namespace, shortTopicName(topic), persistent);
    }

    /**
     * 逐端点拼出一份 topic 级策略视图。
     *
     * 先探一次 topic 本体：topic 不存在与「这台 broker 没有这个 topic 级端点」
     * 都是 404，少了这一步，五个端点会各报一句「没有 topic 级端点」，
     * 而真正的原因可能是 topic 名字打错了。permissions 不是 topic 级策略，
     * 每个版本都有、也不受 topicLevelPoliciesEnabled 开关影响，适合当探针。
     */
    async getPolicies(tenant: string, namespace: string, topic: string, persistent = true): Promise<TopicPolicyView> {
        return this.enqueue(async () => {
            const base = this.base(tenant, namespace, topic, persistent);
            const probe = await orNotFound(
                async () => (await withRetry(() => this.http.get(`${base}/permissions`))).data,
                null,
            );
            if (probe === null || probe === undefined) {
                throw new Error(
                    `读不到 topic ${tenant}/${namespace}/${shortTopicName(topic)}：topic 或所属命名空间不存在`,
                );
            }

            const view = blankView(`${tenant}/${namespace}/${shortTopicName(topic)}`, persistent);
            const reads = await Promise.all(
                TOPIC_POLICY_FIELDS.map(async field => [field, await this.readField(base, field)] as const),
            );

            for (const [field, read] of reads) {
                if (read.unavailable) {
                    view.unavailable.push({field, reason: read.unavailable});
                    continue;
                }
                view.raw[field] = read.value ?? null;
                this.foldOne(view, field, read.value);
            }
            return view;
        });
    }

    private async readField(base: string, field: TopicPolicyField): Promise<PolicyRead> {
        const spec = FIELD_SPECS[field];
        try {
            const response = await withRetry(() => this.http.get(`${base}/${spec.path}`));
            return {value: response.data};
        } catch (error) {
            const reason = describeReadFailure(error);
            if (reason) {
                return {unavailable: reason};
            }
            throw error;
        }
    }

    // 每个端点回来的形状不一样：retention 是对象、TTL 与两个上限是裸数字、去重是裸布尔。
    // 认不出的形状一律按「未设置」处理，而不是硬凑一个 0 冒充配过。
    private foldOne(view: TopicPolicyView, field: TopicPolicyField, data: unknown): void {
        switch (field) {
            case 'retention': {
                if (!data || typeof data !== 'object') {
                    // 实测未显式设置过 topic 级保留时 broker 回空 body（204 / 空串）
                    return;
                }
                const source = data as Record<string, unknown>;
                view.retentionTimeInMinutes = asNumber(source.retentionTimeInMinutes);
                view.retentionSizeInMB = asNumber(source.retentionSizeInMB);
                return;
            }
            case 'messageTtlSeconds':
                view.messageTtlSeconds = asNumber(data);
                return;
            case 'deduplicationEnabled':
                view.deduplicationEnabled = asBoolean(data);
                return;
            case 'maxUnackedMessagesPerConsumer':
                view.maxUnackedMessagesPerConsumer = asNumber(data);
                return;
            case 'maxUnackedMessagesPerSubscription':
                view.maxUnackedMessagesPerSubscription = asNumber(data);
                return;
            default:
                return;
        }
    }

    async setPolicy(
        tenant: string,
        namespace: string,
        topic: string,
        field: TopicPolicyField,
        value: unknown,
        persistent = true,
    ): Promise<void> {
        return this.enqueue(async () => {
            const spec = specOf(field);
            const encoded = spec.encode(value);
            const url = `${this.base(tenant, namespace, topic, persistent)}/${spec.path}`;
            if (spec.send.mode === 'query') {
                // 空请求体是 broker 客户端自己的做法：值全在查询参数里，
                // 但 POST 没有实体会被 REST 层当成缺参数。
                await this.http.post(url, '', {params: {[spec.send.key]: String(encoded)}});
                return;
            }
            await this.http.post(url, encoded);
        });
    }

    /** 撤销 topic 级覆盖：DELETE 之后这一项退回命名空间/broker 的值，不是「关闭」。 */
    async clearPolicy(
        tenant: string,
        namespace: string,
        topic: string,
        field: TopicPolicyField,
        persistent = true,
    ): Promise<void> {
        return this.enqueue(async () => {
            const spec = specOf(field);
            await this.http.delete(`${this.base(tenant, namespace, topic, persistent)}/${spec.path}`);
        });
    }

    private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
        return withSemaphore(this.semaphore, fn);
    }
}

function specOf(field: TopicPolicyField): TopicFieldSpec {
    const spec = FIELD_SPECS[field];
    if (!spec) {
        throw new Error(`不支持在 topic 级设置的字段：${field}`);
    }
    return spec;
}
