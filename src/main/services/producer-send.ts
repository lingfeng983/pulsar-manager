import type {ProducerMessage} from 'pulsar-client';
import type {MessageTemplateBody, ProducerMessageOptions, ProducerOptions} from '../../shared/types';
import {resolveTemplate} from '../../shared/template-engine';
import {formatSchemaIssues, parseSchemaJson, validateJsonSchema} from '../../shared/json-schema-lite';

// 报文模板 → 待发条目的解析发生在主进程，与真正的 producer.send 同一个地方：
// 预览走的是同一份 shared/template-engine，但路由键与事件时间要从**解析后**的
// 报文里取，这一步放在渲染层就等于拿预览文本猜 broker 实际收到什么。

/** 一条待发报文：解析完的正文加这条消息自己的原生参数。 */
export interface OutboundMessage {
    /** 本次 count 里的序号（从 0 起）：解析失败与发送失败要说的是同一条消息 */
    sourceIndex: number;
    /** 交给 producer.send 的正文，UTF-8 */
    body: string;
    /** 正文的 UTF-8 字节数（引擎已经算过，不再重复遍历） */
    bytes: number;
    properties?: Record<string, string>;
    partitionKey?: string;
    eventTimeMs?: number;
    deliverAfterMs?: number;
    deliverAtMs?: number;
}

export interface ResolvedBatch {
    items: OutboundMessage[];
    /** index 是本次 count 里的序号（从 0 起），界面按它把失败条目对上第几条 */
    failures: {index: number; error: string}[];
    /** 本次实际处理掉的条数（含解析失败的）；小于请求的 count 说明还有剩余 */
    consumed: number;
    /** 本批已解析条目的字节总和，调用方用它做载荷预算 */
    bytes: number;
}

// 单批在主进程里最多物化多少条、多少字节待发正文。count 上限是 1000，
// 而模板正文 1MB、解析后单条上限 5MB，一次点下去最坏就是 5GB 字符串同时
// 活着；解析与发送因此必须分批交替，攒够一批预算就交出去、发完再解下一批。
const CHUNK_MAX_MESSAGES = 200;
const CHUNK_MAX_BYTES = 16 * 1024 * 1024;

const DEFAULT_MESSAGE_OPTIONS: ProducerMessageOptions = {};

// 支持点号路径（order.userId），不支持数组下标：报文里的下标本来就是 $each 的事，
// 到了取字段这一步再解一遍下标语法只会让两处对"同一条路径"的理解不一致。
function readField(parsed: unknown, path: string): unknown {
    let current = parsed;
    for (const key of path.split('.')) {
        if (typeof current !== 'object' || current === null || !(key in (current as object))) {
            return undefined;
        }
        current = (current as Record<string, unknown>)[key];
    }
    return current;
}

/**
 * 把报文级参数落到这条消息上。取字段失败要抛错：勾了"事件时间取字段"却静默不发
 * eventTime，界面显示成功、broker 里那条消息的事件时间是空的，事后根本查不出来。
 */
export function applyOptions(item: OutboundMessage, options: ProducerMessageOptions): void {
    const needsParse = options.usePartitionKeyFromField || options.eventTimeMode === 'fromField';
    const parsed = needsParse ? (JSON.parse(item.body) as unknown) : undefined;

    if (options.partitionKey !== undefined && options.partitionKey !== '') {
        item.partitionKey = options.partitionKey;
    } else if (options.usePartitionKeyFromField && options.partitionKeyField) {
        const value = readField(parsed, options.partitionKeyField);
        if (value === undefined || value === null || typeof value === 'object') {
            throw new Error(`路由键字段 ${options.partitionKeyField} 在报文里不是标量值`);
        }
        item.partitionKey = String(value);
    }

    if (options.eventTimeMode === 'now') {
        item.eventTimeMs = Date.now();
    } else if (options.eventTimeMode === 'fixed') {
        item.eventTimeMs = options.eventTimeFixed;
    } else if (options.eventTimeMode === 'fromField' && options.eventTimeField) {
        const value = readField(parsed, options.eventTimeField);
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new Error(`事件时间字段 ${options.eventTimeField} 不是数值毫秒时间戳`);
        }
        item.eventTimeMs = Math.round(value);
    }

    if (options.delayMode === 'deliverAfter') {
        item.deliverAfterMs = options.deliverAfterMs;
    } else if (options.delayMode === 'deliverAt') {
        item.deliverAtMs = options.deliverAt;
    }
}

/**
 * 建会话时的参数与本次发送的参数合并：报文级那几项以本次为准，本次没给才回落。
 * 之所以在解析前合一次而不是让 applyOptions 去猜：回落规则散在两个地方，
 * "界面显示的是勾了 now、实际没带事件时间"这类不一致就没法一眼看穿。
 */
export function messageOptions(
    base: ProducerOptions,
    override: ProducerMessageOptions = DEFAULT_MESSAGE_OPTIONS,
): ProducerMessageOptions {
    return {
        partitionKey: override.partitionKey ?? base.partitionKey,
        usePartitionKeyFromField: override.usePartitionKeyFromField ?? base.usePartitionKeyFromField,
        partitionKeyField: override.partitionKeyField ?? base.partitionKeyField,
        eventTimeMode: override.eventTimeMode ?? base.eventTimeMode,
        eventTimeField: override.eventTimeField ?? base.eventTimeField,
        eventTimeFixed: override.eventTimeFixed ?? base.eventTimeFixed,
        delayMode: override.delayMode ?? base.delayMode,
        deliverAfterMs: override.deliverAfterMs ?? base.deliverAfterMs,
        deliverAt: override.deliverAt ?? base.deliverAt,
        seed: override.seed ?? base.seed,
    };
}

// 内联 schema 校验在每条报文解析之后、参数回落之前：校验的对象必须是"最终要发出去的
// 正文"，而 applyOptions 只读它不改它，顺序反过来也只是白费一次解析。
// 返回 null 表示模板没有配校验；'broker' 模式没有可执行的入口，直接抛错而不是静默放行——
// 用户以为有校验在拦、实际一条都没拦，比明确失败坏得多。
function buildSchemaGate(template: MessageTemplateBody): ((text: string) => string | null) | null {
    if (template.schemaMode === 'broker') {
        throw new Error(
            '「Broker Schema」校验暂未接通：原生客户端与 Admin REST 都没有"给一条报文做 schema 校验"的入口，' +
                '请把模板改为「内联 JSON Schema」校验，或关闭校验',
        );
    }
    if (template.schemaMode !== 'inline') {
        return null;
    }
    const raw = (template.schemaJson || '').trim();
    if (!raw) {
        throw new Error('模板勾选了「内联 Schema」校验，但没有保存任何 schema 内容');
    }
    const parsed = parseSchemaJson(raw);
    // 主工程没开 strictNullChecks，布尔可辨识联合不做收窄，显式转一次
    if (!parsed.ok) {
        throw new Error(`模板 schema 不合法：${(parsed as {error: string}).error}`);
    }
    const schema = parsed.schema;
    return (text: string): string | null => {
        let payload: unknown;
        try {
            payload = JSON.parse(text) as unknown;
        } catch {
            return 'schema 校验不通过：解析后的正文不是合法 JSON，无法对照 schema';
        }
        const result = validateJsonSchema(payload, schema);
        return result.issues.length > 0 ? formatSchemaIssues(result) : null;
    };
}

/**
 * 解析报文，一次最多一批（见上面的预算）。每一条重新走一遍占位符（随机值因此
 * 条与条不同），seq() 靠 messageIndex 递进，同一 seed 下整批内容与顺序都可复现。
 *
 * consumed 小于 count 表示"这批到此为止，剩下的还没解"，调用方带着推进过的
 * startIndex 再叫一次即可；一次点 1000 条大报文不会在主进程里同时存在。
 *
 * startIndex 给连续发送用：那一轮是分成许多小批解析的，序号必须整轮连续，
 * 否则同一 seed 下"第 60 条"在单发路径和连续路径上会解析成不同内容。
 */
export function resolveBatch(
    template: MessageTemplateBody,
    count: number,
    options: ProducerMessageOptions = DEFAULT_MESSAGE_OPTIONS,
    startIndex = 0,
): ResolvedBatch {
    const schemaGate = buildSchemaGate(template);
    const items: OutboundMessage[] = [];
    const failures: {index: number; error: string}[] = [];
    let consumed = 0;
    let bytes = 0;
    for (let offset = 0; offset < count; offset += 1) {
        if (consumed >= CHUNK_MAX_MESSAGES || (items.length > 0 && bytes >= CHUNK_MAX_BYTES)) {
            break;
        }
        const index = startIndex + offset;
        const resolved = resolveTemplate(template.body, template.variables, {
            seed: options.seed,
            messageIndex: index,
        });
        if (!resolved.ok) {
            // 主进程侧 tsconfig 是 strict:false，判别联合在 !resolved.ok 下不收窄
            // （窄化要 strictNullChecks），所以这里显式读 error 字段而不是指望类型缩好。
            failures.push({index, error: (resolved as {error?: string}).error ?? '模板解析失败'});
            consumed += 1;
            continue;
        }
        if (schemaGate) {
            const error = schemaGate(resolved.text);
            if (error) {
                failures.push({index, error});
                consumed += 1;
                continue;
            }
        }
        const item: OutboundMessage = {
            sourceIndex: index,
            body: resolved.text,
            bytes: resolved.bytes,
            properties: template.properties,
        };
        try {
            applyOptions(item, options);
        } catch (error) {
            failures.push({index, error: error instanceof Error ? error.message : String(error)});
            consumed += 1;
            continue;
        }
        consumed += 1;
        bytes += item.bytes;
        items.push(item);
    }
    return {items, failures, consumed, bytes};
}

/** 转成原生 ProducerMessage。绑定里逐条的字段只有这几个。 */
export function toProducerMessage(item: OutboundMessage): ProducerMessage {
    const message: ProducerMessage = {data: Buffer.from(item.body, 'utf8')};
    if (item.properties && Object.keys(item.properties).length > 0) {
        message.properties = item.properties;
    }
    if (item.partitionKey !== undefined) {
        message.partitionKey = item.partitionKey;
    }
    if (item.eventTimeMs !== undefined) {
        message.eventTimestamp = item.eventTimeMs;
    }
    // deliverAfter 与 deliverAt 互斥：同时给的话 C++ 层按它自己的顺序取一个，
    // 界面就无法说明这条到底几点到，所以这里也只可能有一个被设置。
    if (item.deliverAfterMs !== undefined) {
        message.deliverAfter = item.deliverAfterMs;
    }
    if (item.deliverAtMs !== undefined) {
        message.deliverAt = item.deliverAtMs;
    }
    return message;
}
