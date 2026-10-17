// 消息正文的读法。原生载荷可能是任意二进制，主进程一律按 base64 传过来，
// 界面直接显 base64 等于没显内容；但也不能无条件当文本——二进制里解出来的
// 乱码会比 base64 更难读，所以先解、再看有没有控制字符决定用哪一种。

export const asText = (base64: string): string | null => {
    let decoded: string;
    try {
        const binary = atob(base64);
        decoded = new TextDecoder().decode(Uint8Array.from(binary, ch => ch.charCodeAt(0)));
    } catch {
        return null;
    }
    for (let index = 0; index < decoded.length; index += 1) {
        const code = decoded.charCodeAt(index);
        const isControl = code < 32 && code !== 9 && code !== 10 && code !== 13;
        if (isControl || code === 0xfffd) {
            return null;
        }
    }
    return decoded;
};

export type PayloadKind = 'json' | 'xml' | 'text';

/**
 * XML 交给 DOMParser 实测能不能成树。只按首尾形状猜会把半截 XML、
 * 以及 "<b>粗体</b> 说明" 这类带标记的文本一并认成 XML。
 */
const parsesAsXml = (text: string): boolean => {
    if (!/^<[A-Za-z_!?]/.test(text)) {
        return false;
    }
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    return doc.documentElement.tagName !== 'parsererror' && !doc.getElementsByTagName('parsererror').length;
};

/** 只看解出来的文本判类型：结构能不能真解析出来为准，不按扩展名或"看起来像"。 */
export const detectPayloadKind = (text: string): PayloadKind => {
    const trimmed = text.trim();
    if (!trimmed) {
        return 'text';
    }
    if (/^[[{]/.test(trimmed)) {
        try {
            JSON.parse(trimmed);
            return 'json';
        } catch {
            return 'text';
        }
    }
    return parsesAsXml(trimmed) ? 'xml' : 'text';
};

/**
 * 简易 XML 缩进：先抹掉标签之间的空白，再按元素层级重新铺。
 * 不引第三方 formatter——这里要的只是"一坨单行 XML 变得能读"，
 * 而不是保留属性顺序与 CDATA 空白的规范输出。
 */
export const indentXml = (source: string): string => {
    const parts = source.replace(/>\s+</g, '><').match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g);
    if (!parts) {
        return source;
    }
    const lines: string[] = [];
    let depth = 0;
    // 上一行末尾贴了文本节点：紧跟的闭合标签属于同一个叶子元素，得留在同一行
    let appendedText = false;
    for (const part of parts) {
        if (!part.startsWith('<')) {
            // 文本节点贴在上一行；单独成行会把一个元素读成两个
            if (lines.length > 0) {
                lines[lines.length - 1] += part.trim();
            } else {
                lines.push(part.trim());
            }
            appendedText = true;
            continue;
        }
        const closing = /^<\//.test(part);
        const opening = /^<[^/!?]/.test(part) && !part.endsWith('/>') && !/^<\?/.test(part) && !/^<!--/.test(part);
        if (closing) {
            depth = Math.max(0, depth - 1);
            if (appendedText && lines.length > 0) {
                lines[lines.length - 1] += part;
                appendedText = false;
                continue;
            }
        }
        lines.push(`${'    '.repeat(depth)}${part}`);
        if (opening) {
            depth += 1;
        }
        appendedText = false;
    }
    return lines.join('\n');
};

/** 按类型格式化（JSON 缩进重排、XML 缩进、文本原样）。 */
export const formatPayload = (text: string, kind: PayloadKind): string => {
    if (kind === 'json') {
        try {
            return JSON.stringify(JSON.parse(text), null, 2);
        } catch {
            return text;
        }
    }
    if (kind === 'xml') {
        return indentXml(text);
    }
    return text;
};

export interface DecodedPayload {
    /** 解出来的原文；二进制解不出文本时就是 base64 本身 */
    text: string;
    kind: PayloadKind;
    /** 格式化后的展示文本 */
    formatted: string;
}

export const decodePayload = (data: string): DecodedPayload => {
    const text = asText(data) ?? data;
    const kind = detectPayloadKind(text);
    return {text, kind, formatted: formatPayload(text, kind)};
};

export const formatMessageData = (data: string): string => decodePayload(data).formatted;

export const truncateText = (content: string, maxLength: number): string =>
    content.length <= maxLength ? content : `${content.substring(0, maxLength)}...`;

// 一批消息里正文重复的概率很高（同一模板刷出来的尤其明显），解 base64 + JSON.parse
// 因此按原始 data 缓存。缓存必须是模块级的：列表每到达一批就要重渲染全部保留的
// 500 条，按调用新建的话每 300ms 把 500 条正文重新解码一遍，渲染线程直接被大正文拖死。
// 上限按条数收（FIFO 淘汰），正文本身可能几 MB，所以再按累计字符数兜一层。
const DECODE_CACHE_MAX_ENTRIES = 2000;
const DECODE_CACHE_MAX_CHARS = 24 * 1024 * 1024;

const decodeCache = new Map<string, DecodedPayload>();
let decodeCacheChars = 0;

const rememberDecoded = (data: string, payload: DecodedPayload): void => {
    decodeCache.set(data, payload);
    decodeCacheChars += data.length;
    while (decodeCache.size > DECODE_CACHE_MAX_ENTRIES || decodeCacheChars > DECODE_CACHE_MAX_CHARS) {
        const oldestKey = decodeCache.keys().next().value;
        if (oldestKey === undefined) {
            break;
        }
        const removed = decodeCache.get(oldestKey);
        decodeCache.delete(oldestKey);
        if (removed) {
            decodeCacheChars -= oldestKey.length;
        }
    }
};

export function decodeMessageBatch(dataList: string[]): Map<string, DecodedPayload> {
    const cache = new Map<string, DecodedPayload>();
    for (const data of dataList) {
        if (cache.has(data)) {
            continue;
        }
        let payload = decodeCache.get(data);
        if (!payload) {
            payload = decodePayload(data);
            rememberDecoded(data, payload);
        }
        cache.set(data, payload);
    }
    return cache;
}

/**
 * 实时列表的收纳：先按条数截，再按正文累计字节截。
 * 只限条数是不够的——主进程「最近 N 条」扫描有 8MB 封顶，实时推送路径却没有，
 * 500 条几 MB 的 base64 就是 GB 级字符串驻留在渲染进程里。
 * 至少留住最新的一条，否则超大单条会让列表看起来永远是空的。
 */
export const STREAM_MAX_BYTES = 32 * 1024 * 1024;

export function trimMessageList<T extends {data: string}>(merged: T[], maxCount: number, maxBytes: number): T[] {
    let bytes = 0;
    for (let index = 0; index < merged.length; index += 1) {
        const size = merged[index].data.length;
        if (index >= maxCount || (index > 0 && bytes + size > maxBytes)) {
            return merged.slice(0, index);
        }
        bytes += size;
    }
    return merged;
}
