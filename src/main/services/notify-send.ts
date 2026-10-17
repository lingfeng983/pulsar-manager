/**
 * 往一条通知渠道发一次请求。
 *
 * 只发一次、不重试：这是桌面应用，进程退出时队列里的东西全丢，一个「稍后会自动补发」的承诺
 * 兑现不了；把失败如实写进投递记录、让人现在就能看见并点「发送测试」，比攒一个没人信的队列有用。
 *
 * 这一层不 import ipc，也不读 SQLite——渠道与记录都由 dispatch 那层给进来。
 */
import axios from 'axios';
import {classifyNotifyFailure, classifyNotifyResponse, maskNotifyUrl} from '../../shared/notify-channels';
import {createLogger} from '../utils/logger';
import type {NotifyRequest} from './notify-payload';

const log = createLogger('NotifySend');

/**
 * 允许读回来的响应体上限。
 *
 * 这个数不能抠：axios 在超出时抛的是网络层错误，于是「服务端返回 200 + 一整页 HTML 帮助文档」
 * 这种明明已经送达的响应会被判成发送失败、连败计数 +1——一条健康渠道显示成故障，
 * 比读回大正文贵一百倍的是那个错误的结论。取 1MB；真正落库的只有从 JSON 里取出的那一句
 * 对端原文（shared 里限到 200 字符），大正文既不落库也不显示。
 */
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;

export interface NotifySendOutcome {
    ok: boolean;
    message: string;
}

export async function sendNotifyRequest(request: NotifyRequest, timeoutMs: number): Promise<NotifySendOutcome> {
    try {
        const response = await axios.post(request.url, request.body, {
            headers: request.headers,
            timeout: timeoutMs,
            // 不跟重定向：这条地址里带着 token，签名也按这个地址算的。
            // 跟过去等于把凭据与请求体顺路交给另一个主机，而用户以为发到自己配的那台了。
            maxRedirects: 0,
            // 状态码一律交回这里判定：200 里的 errcode≠0 与 3xx 都要走到同一套结论上
            validateStatus: () => true,
            maxContentLength: MAX_RESPONSE_BODY_BYTES,
        });
        const location = typeof response.headers?.location === 'string' ? response.headers.location : undefined;
        // 3xx 与 4xx/5xx 走同一个分类入口：状态码到结论的规则只有一处（shared 里那份），
        // 在这里再写一遍 3xx 分支的话，改那一份的时候很容易漏掉这一处
        const info = classifyNotifyResponse(response.status, response.data, location);
        return {ok: info.ok, message: info.message};
    } catch (error) {
        // axios 在非 2xx 且 validateStatus 放行之外仍会抛（网络层错误、超时、体过大）
        const response = axios.isAxiosError(error) ? error.response : undefined;
        if (response) {
            const info = classifyNotifyResponse(response.status, response.data);
            return {ok: false, message: info.message};
        }
        const info = classifyNotifyFailure(error);
        log.warn(`notify send failed for ${maskNotifyUrl(request.url)}: ${info.message}`);
        return {ok: false, message: info.message};
    }
}
