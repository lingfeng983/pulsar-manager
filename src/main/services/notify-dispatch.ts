/**
 * 通知派发：一条事件进来，按每个渠道的订阅、级别与限流决定发或不发，并把结论逐条落库。
 *
 * 这一层不 import ipc（那一层反过来 import 这里的读写入口），也不碰 broker。
 * 地址与密钥只在解析出「这一条要发」之后才解密，且只活在这一次调用里。
 *
 * 每一次决定都留一行投递记录，包括「没发」那几种：用户问「为什么没收到」时，
 * 答案要么在这张表里，要么就只能靠猜。
 */
import {
    insertNotifyDelivery,
    listNotifyDeliveries,
    listNotifyChannels,
    markNotifyChannelResult,
    pruneNotifyDeliveries,
    type NotifyChannelRecord,
    type NotifyDeliveryRecord,
} from '../database/sqlite';
import {decrypt, encrypt} from './encryption';
import {buildNotifyRequest} from './notify-payload';
import {sendNotifyRequest} from './notify-send';
import {
    NOTIFY_RATE_WINDOW_MS,
    decideNotifyDelivery,
    isKnownNotifyEventKind,
    maskNotifyUrl,
    validateNotifyUrl,
} from '../../shared/notify-channels';
import type {
    NotifyChannel,
    NotifyChannelDraft,
    NotifyChannelKind,
    NotifyDelivery,
    NotifyDispatchResult,
    NotifyEvent,
    NotifyEventKind,
    NotifyLevel,
} from '../../shared/types';
import {createLogger} from '../utils/logger';

const log = createLogger('Notify');

/** 投递记录留这么多条：再多没人看，而这张表是唯一随告警频率一直长的。 */
export const NOTIFY_DELIVERY_KEEP = 500;

/**
 * 每个渠道最近发出去的时间戳（限流窗口）。
 *
 * 放进程内存而不是库里：限流要挡的是「这一分钟连打 40 条出去」，
 * 而重启之后再累计是不合理的担忧——重启本身就把人拦下来了。
 */
const recentSends = new Map<string, number[]>();

function pushRecentSend(channelId: string, atMs: number): void {
    const floor = atMs - NOTIFY_RATE_WINDOW_MS;
    const kept = (recentSends.get(channelId) ?? []).filter(at => at > floor);
    kept.push(atMs);
    recentSends.set(channelId, kept);
}

/** 解密这件事不能抛穿出去：keyring 不可用的机器上，一个坏渠道不该让整页渠道列表打不开。 */
function tryDecrypt(ciphertext: string | null): string | null {
    if (!ciphertext) {
        return null;
    }
    try {
        return decrypt(ciphertext);
    } catch (error) {
        log.warn(`notify secret decrypt failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

function parseEvents(raw: string): NotifyEventKind[] {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        // 认不出的事件类型一律丢掉：留着它不会让任何一条发出去，只会在界面上显示成空白一格
        return parsed.filter(
            (item): item is NotifyEventKind => typeof item === 'string' && isKnownNotifyEventKind(item),
        );
    } catch {
        // 读不出来的 events 当「什么都没订阅」而不是「全订阅」：一个坏 JSON 不该变成往所有群发
        log.warn('notify channel has unparseable events_json, treated as no subscriptions');
        return [];
    }
}

/**
 * 落库行 → 渠道。
 *
 * `url` 给的是打码后的地址（查询串里的 token 换成 ***），因此这一份可以直接进渲染层；
 * 明文地址只在 resolveTarget 里按需解出来一次。
 */
export function toNotifyChannel(record: NotifyChannelRecord): NotifyChannel {
    const plainUrl = tryDecrypt(record.url_enc);
    return {
        id: record.id,
        name: record.name,
        kind: record.kind as NotifyChannelKind,
        url: plainUrl ? maskNotifyUrl(plainUrl) : '',
        hasSecret: !!record.secret_enc,
        enabled: record.enabled === 1,
        events: parseEvents(record.events_json),
        minLevel: record.min_level as NotifyLevel,
        timeoutMs: record.timeout_ms,
        ratePerMinute: record.rate_per_minute,
        lastSentAt: record.last_sent_at,
        lastError: record.last_error,
        failCount: record.fail_count,
        createdAt: record.created_at,
        updatedAt: record.updated_at,
    };
}

/** 有 reason 就是这一条发不出去；url 为空同样发不出去，但那种情况 reason 里已经写了原因。 */
interface Resolved {
    url: string;
    secret: string | null;
    reason: string | null;
}

const BLOCKED = (reason: string): Resolved => ({url: '', secret: null, reason});

/**
 * 这一条渠道现在到底发得出去吗：地址、开关与合法性一起判，判不过就带回一句原因。
 *
 * 这里只回答「地址能不能用」，不管该不该发——「该不该」整条都在
 * shared/notify-channels.ts 的 decideNotifyDelivery 里判，好让那套规则能在没有数据库、
 * 没有网络的机器上被自测逐条证伪。
 */
function resolveTarget(record: NotifyChannelRecord): Resolved {
    const url = tryDecrypt(record.url_enc);
    if (!url) {
        return BLOCKED('地址读不出来：本机密钥库可能不可用，重新填一次地址即可恢复');
    }
    const invalid = validateNotifyUrl(url);
    if (invalid) {
        return BLOCKED(`地址不合法：${invalid}`);
    }
    return {url, secret: tryDecrypt(record.secret_enc), reason: null};
}

function writeDelivery(args: {
    channelId: string;
    channelName: string;
    event: NotifyEvent;
    ok: boolean;
    skipped: boolean;
    message: string;
    atMs: number;
}): void {
    insertNotifyDelivery({
        channel_id: args.channelId,
        channel_name: args.channelName,
        event_kind: args.event.kind,
        level: args.event.level,
        ok: args.ok ? 1 : 0,
        skipped: args.skipped ? 1 : 0,
        message: args.message.slice(0, 500),
        created_at: new Date(args.atMs).toISOString(),
    });
}

/**
 * 把一条事件推给所有该收它的渠道。
 *
 * 判到哪一种结果全在 shared/notify-channels.ts 的 decideNotifyDelivery 里，这一层只做三件
 * 它独有的事：把库里的行变成判定要的那几格、真的发出去、把结论落库。
 * 「没订阅/低于级别线/渠道关着」是不归它管（ignore，不留一行），
 * 「这一分钟用完了」与「测试时地址不行」是本来该发却没发，必须留下来说清是谁挡的。
 */
export async function dispatchNotifyEvent(
    event: NotifyEvent,
    nowMs: number = Date.now(),
    /** 只发这一条渠道（「发送测试」用）；不给就是全发 */
    onlyChannelId?: string,
): Promise<NotifyDispatchResult> {
    const deliveries: NotifyDispatchResult['deliveries'] = [];

    for (const item of listNotifyChannels()) {
        if (onlyChannelId && item.id !== onlyChannelId) {
            continue;
        }
        const channelName = item.name;
        const target = resolveTarget(item);
        const decision = decideNotifyDelivery(
            {
                enabled: item.enabled === 1,
                urlProblem: target.reason,
                events: parseEvents(item.events_json),
                minLevel: item.min_level as NotifyLevel,
                ratePerMinute: item.rate_per_minute,
                recentSendAtMs: recentSends.get(item.id) ?? [],
            },
            event,
            nowMs,
        );
        if (decision.action === 'ignore') {
            continue;
        }
        if (decision.action === 'skip') {
            writeDelivery({
                channelId: item.id,
                channelName,
                event,
                ok: false,
                skipped: true,
                message: decision.reason,
                atMs: nowMs,
            });
            deliveries.push({channelId: item.id, channelName, ok: false, skipped: true, message: decision.reason});
            continue;
        }

        const request = buildNotifyRequest({
            kind: item.kind as NotifyChannelKind,
            url: target.url,
            secret: target.secret,
            event,
            nowMs,
        });
        const outcome = await sendNotifyRequest(request, item.timeout_ms);
        pushRecentSend(item.id, nowMs);
        markNotifyChannelResult(item.id, {ok: outcome.ok, message: outcome.message, at: new Date(nowMs).toISOString()});
        writeDelivery({
            channelId: item.id,
            channelName,
            event,
            ok: outcome.ok,
            skipped: false,
            message: outcome.message,
            atMs: nowMs,
        });
        deliveries.push({channelId: item.id, channelName, ok: outcome.ok, skipped: false, message: outcome.message});
    }

    pruneNotifyDeliveries(NOTIFY_DELIVERY_KEEP);
    return {event: {kind: event.kind, title: event.title}, deliveries};
}

function toDelivery(row: NotifyDeliveryRecord): NotifyDelivery {
    return {
        id: row.id,
        channelId: row.channel_id,
        channelName: row.channel_name,
        eventKind: row.event_kind as NotifyEventKind,
        level: row.level as NotifyLevel,
        ok: row.ok === 1,
        skipped: row.skipped === 1,
        message: row.message,
        createdAt: row.created_at,
    };
}

/**
 * 后台把一条事件发出去：调用方不等它、也不因为它的失败得到任何异常。
 *
 * 告警落库与巡检落库是主线，通知是旁路。旁路把主线顶掉是最糟的失败方式——
 * 那样一次值班群 502 会让这条告警压根没进数据库，人既没在群里看到、也没在应用里看到。
 */
export function dispatchQuietly(event: NotifyEvent): void {
    dispatchNotifyEvent(event).catch(error => {
        log.warn(`notify dispatch failed for ${event.kind}: ${error instanceof Error ? error.message : String(error)}`);
    });
}

/**
 * 「发送测试」那条事件。
 *
 * 单独构造而不是拿一条真告警的壳：测试要回答的是「这条地址现在通不通、这个机器人收不收」，
 * 它没有集群、没有级别线可判，也不该在投递记录里冒充一次真事件。
 */
export function buildTestEvent(nowMs: number = Date.now()): NotifyEvent {
    return {
        kind: 'test',
        level: 'info',
        title: 'pulsar-manager 测试通知',
        text: '这是一条测试消息。收到它就说明这个地址现在通、这个机器人愿意收。',
        clusterId: '',
        clusterName: '',
        atMs: nowMs,
        test: true,
    };
}

/** 界面上「最近投递」那一段。 */
export function listRecentDeliveries(limit: number): NotifyDelivery[] {
    return listNotifyDeliveries(limit).map(toDelivery);
}

/**
 * draft + 现值 → 落库行。
 *
 * 地址与密钥都是「留空表示不改」：渲染层拿到的地址是打码的、密钥从来不回填，
 * 如果空串被当成新值写进去，一次只改名字的保存就会把地址清掉。
 * 加密失败直接往外抛（不降级成明文）：这个文件里落的是往值班群发任意消息的凭据。
 */
export function buildChannelRecord(
    draft: NotifyChannelDraft,
    existing: NotifyChannelRecord | null,
    id: string,
    at: string,
): NotifyChannelRecord {
    const url = draft.url.trim();
    const secret = draft.secret?.trim() ?? '';
    return {
        id,
        name: draft.name.trim(),
        kind: draft.kind,
        url_enc: url ? encrypt(url) : (existing?.url_enc ?? ''),
        secret_enc: secret ? encrypt(secret) : (existing?.secret_enc ?? null),
        enabled: (draft.enabled ?? existing?.enabled === 1) ? 1 : 0,
        events_json: JSON.stringify(draft.events ?? (existing ? parseEvents(existing.events_json) : [])),
        min_level: draft.minLevel ?? (existing ? (existing.min_level as NotifyLevel) : 'warn'),
        timeout_ms: draft.timeoutMs ?? existing?.timeout_ms ?? 5000,
        rate_per_minute: draft.ratePerMinute ?? existing?.rate_per_minute ?? 20,
        // 这四格是运行结果，配置保存不该动它们（与巡检调度的 upsert 同一口径）
        last_sent_at: existing?.last_sent_at ?? null,
        last_error: existing?.last_error ?? null,
        fail_count: existing?.fail_count ?? 0,
        created_at: existing?.created_at ?? at,
        updated_at: at,
    };
}
