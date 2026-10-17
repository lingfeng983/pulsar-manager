/**
 * 外部通知渠道的纯逻辑：校验、筛选、限流判定、文本拼装与失败分类。
 *
 * 这一层不算签名也不发网络请求（那两件事在 services/notify-payload.ts 与
 * services/notify-send.ts），所以它既能被主进程用，也能在没有集群、没有网络的机器上
 * 被 scripts/notify-selftest.cjs 逐条证伪。
 *
 * 「通知到底发出去了没有」是这类功能最容易变成玄学的地方：渠道配错、对端限流、关键字没命中，
 * 用户看到的都是「什么都没收到」。所以这里把每一次决定都留成一句话——发、不发、为什么不发。
 */
import type {NotifyChannel, NotifyChannelKind, NotifyEvent, NotifyEventKind, NotifyLevel} from './types';

/** 一条消息里正文的字节上限（各对端都更宽，这里是把长文本压成一条读得完的消息）。 */
export const NOTIFY_TEXT_MAX_BYTES = 4096;

/** 限流窗口：一分钟。企微/钉钉机器人都是 20 条/分钟量级，窗口取一分钟才对得上。 */
export const NOTIFY_RATE_WINDOW_MS = 60_000;

export const NOTIFY_DEFAULT_TIMEOUT_MS = 5000;
export const NOTIFY_DEFAULT_RATE = 20;

export const NOTIFY_EVENT_LABEL: Record<NotifyEventKind, string> = {
    alertFired: '告警触发',
    alertRecovered: '告警恢复',
    inspectionCrit: '巡检严重项',
    inspectionRecovered: '巡检严重项恢复',
    inspectionFailed: '巡检跑不起来',
    test: '测试消息',
};

/**
 * 界面上可以勾选订阅的事件：test 不在其中（它不是一个会发生的事，是一次人为的尝试）。
 *
 * 写成 as const 而不是标成 NotifyEventKind[]：IPC 要拿这一份直接当 zod 的枚举取值表，
 * 数组类型在那里过不了——「能订阅什么」这一件事因此只有这一个出处。
 */
export const NOTIFIABLE_EVENT_KINDS = [
    'alertFired',
    'alertRecovered',
    'inspectionCrit',
    'inspectionRecovered',
    'inspectionFailed',
] as const satisfies readonly NotifyEventKind[];

export const NOTIFY_LEVEL_RANK: Record<NotifyLevel, number> = {
    info: 0,
    warn: 1,
    crit: 2,
};

export const NOTIFY_LEVEL_LABEL: Record<NotifyLevel, string> = {
    info: '提示',
    warn: '关注',
    crit: '严重',
};

/**
 * 地址校验只在这里做一次，界面与 IPC 都调它。
 *
 * 只放 http/https：这类地址将来是被 axios 直接发出去的，`file://` 之类的协议一旦进来，
 * 读的是本机文件、用户看到的却是一句「发送失败」。带 `@` 的地址也挡——`http://evil/?a=x@`
 * 与 `http://user:pass@host` 在人眼里长得一样，而后者会被当成凭据发出去。
 */
export function validateNotifyUrl(raw: string | undefined | null): string | null {
    const url = (raw ?? '').trim();
    if (!url) {
        return '通知地址不能为空';
    }
    if (url.length > 2048) {
        return '通知地址过长（上限 2048 字符）';
    }
    if (/\s/.test(url)) {
        return '通知地址里不能有空格或换行';
    }
    if (!/^https:\/\/\S+$/i.test(url) && !/^http:\/\/\S+$/i.test(url)) {
        return '通知地址必须是 http:// 或 https:// 开头';
    }
    const withoutScheme = url.replace(/^https?:\/\//i, '');
    const authority = withoutScheme.split(/[/?#]/)[0];
    if (authority.includes('@')) {
        return '通知地址里不要写用户名密码，凭据请放进「签名密钥」或路径里';
    }
    // 端口不能算进主机名里：本机测试就是 localhost:18080，按整段 authority 判会把它拒了。
    // IPv6 字面量带方括号、内部全是冒号，能写成这种形式的人是在有意写它，不再挑格式。
    if (authority.startsWith('[')) {
        return null;
    }
    const host = authority.split(':')[0];
    if (!host.includes('.') && host.toLowerCase() !== 'localhost') {
        // 没有点的一定不是合法主机名（本机测试用 localhost 除外，它也不含点，所以显式放行）
        return '通知地址里的主机名看着不完整';
    }
    return null;
}

/** 超时与每分钟条数：只接受区间内的整数，越界是拒绝而不是夹住（与巡检采样上限同一口径）。 */
export function resolveNotifyTimeoutMs(input: number | undefined | null): number {
    if (input === undefined || input === null) {
        return NOTIFY_DEFAULT_TIMEOUT_MS;
    }
    if (!Number.isInteger(input) || input < 1000 || input > 30_000) {
        throw new Error('超时时间必须是 1000～30000 之间的整数毫秒');
    }
    return input;
}

export function resolveNotifyRate(input: number | undefined | null): number {
    if (input === undefined || input === null) {
        return NOTIFY_DEFAULT_RATE;
    }
    if (!Number.isInteger(input) || input < 1 || input > 60) {
        throw new Error('每分钟条数必须是 1～60 之间的整数');
    }
    return input;
}

/** 界面与事件里出现的事件类型都必须是已知的，未知的一律不发（拼错键不该变成「悄悄没通知」）。 */
export function isKnownNotifyEventKind(input: string): input is NotifyEventKind {
    return Object.prototype.hasOwnProperty.call(NOTIFY_EVENT_LABEL, input);
}

/** 这一条事件该不该走这个渠道：先看订阅了什么，再看级别到没到线。 */
export function channelWantsEvent(channel: Pick<NotifyChannel, 'events' | 'minLevel'>, event: NotifyEvent): boolean {
    if (!channel.events.includes(event.kind)) {
        return false;
    }
    return NOTIFY_LEVEL_RANK[event.level] >= NOTIFY_LEVEL_RANK[channel.minLevel];
}

/**
 * 限流判定：窗口内已经发出去几条。
 *
 * 返回要挡的那一条而不是「排队等会儿再发」：这是桌面应用，队列在进程退出时全丢，
 * 一个「稍后会补发」的承诺兑现不了，不如当场说明白「这条被限流挡下了」。
 */
export function isRateLimited(sentAtMs: number[], nowMs: number, perMinute: number): boolean {
    const floor = nowMs - NOTIFY_RATE_WINDOW_MS;
    let sent = 0;
    for (const at of sentAtMs) {
        if (at > floor && at <= nowMs) {
            sent += 1;
        }
    }
    return sent >= perMinute;
}

/**
 * 一条渠道此刻的全部可判事实：地址已经解出来并校验过（校验结果在 urlProblem 里），
 * 限流窗口也已经在调用方读好。派发那层只负责把库里的行变成这几格，判定全部在这里。
 */
export interface NotifyChannelFacts {
    enabled: boolean;
    /** null 表示地址能用；否则就是「这一条现在发不出去」的原因。 */
    urlProblem: string | null;
    events: NotifyEventKind[];
    minLevel: NotifyLevel;
    ratePerMinute: number;
    /** 这一分钟内已经发出去的时间戳（进程内存里的窗口，不落库）。 */
    recentSendAtMs: number[];
}

export type NotifyDecision =
    | {action: 'send'}
    /**
     * 这条事件不归这个渠道（没订阅、低于级别线、渠道关着、地址读不出来）。
     *
     * 不记投递记录是刻意的：一次告警 × N 条渠道里大多数本来就不该收它，
     * 每一格都记一行，那张表就再也看不出「哪一条真出问题了」。
     */
    | {action: 'ignore'}
    /** 该发却没发成：这一条必须留一行，并把是谁挡的写清楚。 */
    | {action: 'skip'; reason: string};

/**
 * 派发判定：发、不发、还是「本该发却被挡」。
 *
 * 手动测试（event.test）只看地址能不能用——点它要问的是「现在通不通」，
 * 拿订阅、级别线、限流去拦一次测试，得到的会是「测试没发出去」这种没有信息量的结论。
 * 测试也不看渠道开关：「先把这条测通再打开」是最顺的手序，把人拦在开关前面只会让他
 * 先打开、发一条真事件出去试。地址不行仍要落成一条记录，否则「点了测试什么也没发生」
 * 又没有下文，等于把这一层最该有的答案弄丢了。
 */
export function decideNotifyDelivery(facts: NotifyChannelFacts, event: NotifyEvent, nowMs: number): NotifyDecision {
    if (event.test) {
        return facts.urlProblem ? {action: 'skip', reason: facts.urlProblem} : {action: 'send'};
    }
    if (!facts.enabled) {
        return {action: 'ignore'};
    }
    if (facts.urlProblem) {
        return {action: 'ignore'};
    }
    if (!channelWantsEvent({events: facts.events, minLevel: facts.minLevel}, event)) {
        return {action: 'ignore'};
    }
    if (isRateLimited(facts.recentSendAtMs, nowMs, facts.ratePerMinute)) {
        return {
            action: 'skip',
            reason: `这一分钟的上限 ${facts.ratePerMinute} 条已经用完，这条被限流挡下（没有排队补发）`,
        };
    }
    return {action: 'send'};
}

/** 时间戳写成 `YYYY-MM-DD HH:mm:ssZ`：收信的人不一定在这台机器所在时区，标了 Z 才有唯一解释。 */
export function formatNotifyTime(atMs: number): string {
    const date = new Date(atMs);
    if (Number.isNaN(date.getTime())) {
        return '时间未知';
    }
    return `${date.toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

/**
 * 一个码点的 UTF-8 字节数。不用 Buffer：这一层要能被渲染进程 import，
 * 而渲染层没有 Buffer。
 */
function utf8ByteLength(char: string): number {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) {
        return 1;
    }
    if (code < 0x800) {
        return 2;
    }
    if (code > 0xffff) {
        return 4;
    }
    return 3;
}

function byteLength(text: string): number {
    let total = 0;
    for (const char of text) {
        total += utf8ByteLength(char);
    }
    return total;
}

/**
 * 按 UTF-8 字节截断。企微的 markdown 正文上限是按字节的，中文一个字算 3 字节，
 * 按字符数截会超；同时不能在多字节序列中间切断，所以逐码点累加。
 */
export function truncateToBytes(text: string, maxBytes: number): string {
    if (maxBytes <= 0) {
        return '';
    }
    if (byteLength(text) <= maxBytes) {
        return text;
    }
    const suffix = '\n…（正文过长，已截断）';
    const budget = maxBytes - byteLength(suffix);
    // 连省略提示都放不下时只能硬截，此时宁可少一个字也不能超字节
    const limit = budget > 0 ? budget : maxBytes;
    let used = 0;
    let out = '';
    for (const char of text) {
        const size = utf8ByteLength(char);
        if (used + size > limit) {
            break;
        }
        used += size;
        out += char;
    }
    return budget > 0 ? `${out}${suffix}` : out;
}

/** 一条通知的最终文本：标题、正文、来源与时间。渠道自己的格式在 payload 那层再包一次。 */
export function renderNotifyText(event: NotifyEvent): string {
    const head = event.title.trim() || NOTIFY_EVENT_LABEL[event.kind] || '通知';
    const body = event.text.trim();
    const lines = [head];
    if (body && body !== head) {
        lines.push(body);
    }
    // 测试消息没有集群，硬写一行「集群：」会让人以为这是哪台集群发出来的
    const scope = event.clusterName ? `｜集群：${event.clusterName}` : '';
    lines.push(`${NOTIFY_EVENT_LABEL[event.kind]}｜${NOTIFY_LEVEL_LABEL[event.level]}${scope}`);
    lines.push(`时间：${formatNotifyTime(event.atMs)}`);
    return truncateToBytes(lines.join('\n\n'), NOTIFY_TEXT_MAX_BYTES);
}

/** 成功判定：2xx 才算成功。3xx 不算——见 services/notify-send.ts 里为什么不跟重定向。 */
export function isNotifySuccessStatus(status: number): boolean {
    return status >= 200 && status < 300;
}

export interface NotifyFailureInfo {
    /** 落库与界面显示的原因，写给运维看的那一句 */
    message: string;
    /** 分类标签，界面上据此提示「这类问题该改哪里」 */
    category: 'timeout' | 'dns' | 'refused' | 'tls' | 'status' | 'redirect' | 'network' | 'unknown';
}

/**
 * 把一次网络失败写成照得做的句子。
 *
 * 「发送失败」这四个字没法让人动：是地址写错了、对端挂了、证书不认，还是被限流了，
 * 改法完全不同。所以按错误签名分类，未命中才退回原文。
 */
export function classifyNotifyFailure(error: unknown, status?: number, location?: string): NotifyFailureInfo {
    if (typeof status === 'number') {
        if (status >= 300 && status < 400) {
            return {
                category: 'redirect',
                message: `对端返回了重定向（${status}），为了不把你的地址与请求体顺路交给另一个主机，这里没有跟过去`,
            };
        }
        return {
            category: 'status',
            message: `对端返回 ${status}${location ? `（${location}）` : ''}`,
        };
    }
    const raw = error instanceof Error ? error.message : String(error ?? '');
    const text = `${raw} ${String(error ?? '')}`.toLowerCase();
    if (
        text.includes('econnaborted') ||
        text.includes('etimedout') ||
        text.includes('timeout') ||
        text.includes('timed out')
    ) {
        return {category: 'timeout', message: `请求超时：对端在时限内没有回应${raw ? `（${raw}）` : ''}`};
    }
    if (text.includes('enotfound') || text.includes('eai_again') || text.includes('getaddrinfo')) {
        return {category: 'dns', message: `域名解析不了：检查通知地址里的主机名是否写错（${raw}）`};
    }
    if (text.includes('econnrefused')) {
        return {category: 'refused', message: `连接被拒绝：这个地址上的服务没在监听（${raw}）`};
    }
    if (
        text.includes('cert') ||
        text.includes('self signed') ||
        text.includes('unable to verify') ||
        text.includes('x509')
    ) {
        return {category: 'tls', message: `证书校验没过：内网自签证书需要把 CA 配上（${raw}）`};
    }
    if (raw) {
        return {category: 'network', message: raw};
    }
    return {category: 'unknown', message: '未知错误，没有可用的失败信息'};
}

/** 列表页显示用的地址：查询串里的 token 打码，其余留着——人得认得出这是哪一条。 */
export function maskNotifyUrl(url: string): string {
    const [head, query] = url.split('?');
    if (query === undefined) {
        return url;
    }
    const masked = query
        .split('&')
        .filter(part => part.length > 0)
        .map(part => {
            const [key] = part.split('=');
            // access_token / token / key 这类才是凭据，其余参数留着方便核对
            return /token|key|secret|sig|password/i.test(key) ? `${key}=***` : part;
        })
        .join('&');
    return masked ? `${head}?${masked}` : head;
}

/** 落库/读回时渠道上必须有的字段，缺一个就没法拼请求（老行或导入的配置可能缺）。 */
export function isUsableNotifyChannel(channel: NotifyChannel | null | undefined): channel is NotifyChannel {
    if (!channel) {
        return false;
    }
    return !!channel.enabled && !!channel.url && validateNotifyUrl(channel.url) === null;
}

/** 从对端响应体里取出来的那一句话（各家的字段名不同，取到哪个算哪个）。 */
function pickProviderMessage(data: Record<string, unknown>): string | null {
    for (const key of ['errmsg', 'msg', 'error', 'message']) {
        const value = data[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim().slice(0, 200);
        }
    }
    return null;
}

function parseMaybeJson(body: unknown): Record<string, unknown> | null {
    if (body && typeof body === 'object') {
        return body as Record<string, unknown>;
    }
    if (typeof body === 'string' && body.trim().startsWith('{')) {
        try {
            const parsed: unknown = JSON.parse(body);
            return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
        } catch {
            return null;
        }
    }
    return null;
}

export interface NotifyResponseInfo {
    ok: boolean;
    /** 写给界面与投递记录看的那一句结论 */
    message: string;
}

/**
 * 判断一次 HTTP 回应算不算「送出去了」。
 *
 * 200 不等于成功：钉钉与企微的机器人失败就是 200 + errcode≠0，飞书是 200 + code≠0，
 * Slack 是 200 + ok:false。只看状态码的话，「机器人关键字没命中」「token 过期」
 * 这些最常见的配错会全部显示成成功，而用户什么都没收到。
 */
export function classifyNotifyResponse(status: number, body: unknown): NotifyResponseInfo {
    if (!isNotifySuccessStatus(status)) {
        const failure = classifyNotifyFailure(new Error(`HTTP ${status}`), status);
        return {ok: false, message: failure.message};
    }
    const data = parseMaybeJson(body);
    if (data) {
        const providerMessage = pickProviderMessage(data);
        // 钉钉 / 企微：errcode（企微也有 errcode=0 表示 ok）
        if (typeof data.errcode === 'number' && data.errcode !== 0) {
            return {
                ok: false,
                message: `对端拒绝（errcode ${data.errcode}）：${providerMessage ?? '响应体里没有说明原因'}`,
            };
        }
        // 飞书：code / msg
        if (typeof data.code === 'number' && data.code !== 0) {
            return {ok: false, message: `对端拒绝（code ${data.code}）：${providerMessage ?? '响应体里没有说明原因'}`};
        }
        // Slack：ok:false + error
        if (data.ok === false) {
            return {ok: false, message: `对端拒绝：${providerMessage ?? '响应体里没有说明原因'}`};
        }
    }
    return {ok: true, message: `已送达（HTTP ${status}）`};
}

/** 渠道类型显示名（界面上的下拉与表格里那一格）。 */
export const NOTIFY_KIND_LABEL: Record<NotifyChannelKind, string> = {
    generic: '通用 JSON',
    dingtalk: '钉钉机器人',
    feishu: '飞书机器人',
    wecom: '企业微信机器人',
    slack: 'Slack Incoming Webhook',
};

/**
 * 哪些渠道有「签名密钥」这一格可填：钉钉与飞书的机器人可以开加签，其余三家没有这个概念。
 *
 * 界面上按它决定要不要显示密钥输入框——把密钥填给企微或 Slack 不会报错，
 * 只会静静躺在库里没人用，而用户以为自己的地址已经被保护了。
 * 顺带说一句钉钉的另一件事：它的机器人还可以配「自定义关键词」，正文没命中就是
 * errcode 310000，这一种失败在 classifyNotifyResponse 里会原样带出 errmsg。
 */
export function notifyKindSupportsSecret(kind: NotifyChannelKind): boolean {
    return kind === 'dingtalk' || kind === 'feishu';
}
