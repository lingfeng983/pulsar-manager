/**
 * 把一条事件包成各家机器人要的请求体。
 *
 * 单独一个文件而不是写进发送那层：签名要用 node:crypto，而发送要用 axios——
 * 分成两块之后，这一块的形状可以在没有网络的机器上被自测逐条比着官方文档的口型证伪，
 * 不必为了验证「钉钉的 sign 到底拼在哪」而真发一条到值班群里。
 */
import crypto from 'node:crypto';
import {renderNotifyText} from '../../shared/notify-channels';
import type {NotifyChannelKind, NotifyEvent} from '../../shared/types';

export interface NotifyRequest {
    url: string;
    headers: Record<string, string>;
    body: unknown;
}

/** 签名用的时间戳：钉钉与飞书都把它算进签名里，所以必须由调用方给而不是内部取 Date.now()。 */
export interface NotifyPayloadArgs {
    kind: NotifyChannelKind;
    /** 未签名的完整地址（密文已在落库层解出来） */
    url: string;
    /** 签名密钥；没有就不签 */
    secret: string | null;
    event: NotifyEvent;
    nowMs: number;
}

/** 钉钉加签：`base64(HMAC_SHA256(secret, `${timestamp}\n${secret}`))`，再 urlencode 拼回地址。 */
function dingTalkSign(secret: string, timestamp: number): string {
    const digest = crypto.createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64');
    return encodeURIComponent(digest);
}

/** 飞书加签：密钥是 `${timestamp}\n${secret}` 本身，签名对象是空串，结果 base64 放进 body。 */
function feishuSign(secret: string, timestamp: number): string {
    return crypto.createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

function appendQuery(url: string, params: Record<string, string>): string {
    const query = Object.entries(params)
        .map(([key, value]) => `${key}=${value}`)
        .join('&');
    return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

export function buildNotifyRequest(args: NotifyPayloadArgs): NotifyRequest {
    const text = renderNotifyText(args.event);
    const title = args.event.title.trim() || 'Pulsar 通知';
    const headers = {'content-type': 'application/json'};

    switch (args.kind) {
        case 'dingtalk': {
            const body: Record<string, unknown> = {msgtype: 'markdown', markdown: {title, text}};
            // 钉钉的加签走查询串而不是 body：timestamp 与 sign 都得在地址上，
            // 而这两个值必须是同一个时刻取的——签名算的是一行、地址里写的是另一行的话必然校验失败
            const url = args.secret
                ? appendQuery(args.url, {
                      timestamp: String(args.nowMs),
                      sign: dingTalkSign(args.secret, args.nowMs),
                  })
                : args.url;
            return {url, headers, body};
        }
        case 'wecom': {
            // 企微的 markdown 正文按字节计上限，长文本已经在 renderNotifyText 里按字节截过
            return {url: args.url, headers, body: {msgtype: 'markdown', markdown: {content: text}}};
        }
        case 'feishu': {
            const body: Record<string, unknown> = {msg_type: 'text', content: {text}};
            if (args.secret) {
                const timestamp = Math.floor(args.nowMs / 1000);
                body.timestamp = String(timestamp);
                body.sign = feishuSign(args.secret, timestamp);
            }
            return {url: args.url, headers, body};
        }
        case 'slack': {
            return {url: args.url, headers, body: {text}};
        }
        case 'generic':
        default: {
            // 通用 JSON：留全字段，接自建服务的人自己挑；text 已经排好版，只想要一句话的取 text 就够
            return {
                url: args.url,
                headers,
                body: {
                    source: 'pulsar-manager',
                    kind: args.event.kind,
                    level: args.event.level,
                    clusterId: args.event.clusterId,
                    clusterName: args.event.clusterName,
                    title,
                    text,
                    at: new Date(args.event.atMs).toISOString(),
                },
            };
        }
    }
}
