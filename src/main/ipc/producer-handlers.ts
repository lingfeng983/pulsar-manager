import {
    ProducerFlushSchema,
    ProducerFlowSchema,
    ProducerSendOnceSchema,
    ProducerSendSchema,
    ProducerSessionsSchema,
    ProducerSetRateSchema,
    ProducerStartSchema,
    SessionIdSchema,
    insertOperationLog,
    insertSendHistory,
    registerHandler,
    registerNativeHandler,
} from './_shared';
import {nativeClientManager, topicFullName} from '../services/pulsar-native-client';
import {messageOptions} from '../services/producer-send';
import {readAppSettings} from '../services/app-config';
import {sendToRenderer} from './stream';
import {MESSAGE_STREAM_CHANNELS} from '../../shared/types';
import type {
    MessageTemplateBody,
    ProducerMessageOptions,
    ProducerOptions,
    ProducerRunStats,
    ProducerSendResult,
    ProducerSessionInfo,
    SessionEndEvent,
} from '../../shared/types';
import {createLogger} from '../utils/logger';

const log = createLogger('IPCProducer');

// zod 3.25 的 z.infer 会把带 .default() 的字段标成可选（运行时 parse 必然补齐），
// 而 shared/types.ts 里它们是必填的。校验通过之后在这里收一次口，
// 免得每个字段前都挂一个「?? 默认值」——那等于把默认值写了两遍，两处迟早对不上。
function needOptions(options: unknown): ProducerOptions {
    if (!options) {
        throw new Error('缺少生产者参数');
    }
    return options as ProducerOptions;
}

// 历史只存正文前缀，不存整篇载荷（单条上限 5MB，落库就是几十 GB）。
const HISTORY_PREVIEW_CHARS = 400;

// 全文留存（配置中心开关）的单行上限：超过就只留前缀——一次 1000 条的
// 连续发送每轮都记一行，不设上限的话库会被大载荷顶爆，而 512KB 已经远超过
// "重发上次那条报文"真正需要的体积。
const HISTORY_FULL_MAX_CHARS = 512 * 1024;

function preview(body: string): string {
    return body.length > HISTORY_PREVIEW_CHARS ? `${body.slice(0, HISTORY_PREVIEW_CHARS)}…` : body;
}

// 历史是旁路：写不进去（磁盘满、库被锁）不能让已经发出去的消息在界面上变成失败，所以吞异常只留日志。
function recordSendHistory(entry: {
    clusterId: string;
    topic: string;
    templateName?: string;
    templateId?: string;
    /** 模板正文（内联报文也走这里，历史记的就是这次投的报文长什么样） */
    body: string;
    sent: number;
    bytes: number;
    messageId?: string | null;
    /** 失败原因：整批一条没出去时必填，部分失败时给第一条 */
    failure?: string;
}): void {
    try {
        const keepFull = readAppSettings().sendHistoryFullBody && entry.body.length <= HISTORY_FULL_MAX_CHARS;
        insertSendHistory({
            cluster_id: entry.clusterId,
            topic_uri: entry.topic,
            template_id: entry.templateId ?? null,
            template_name: entry.templateName?.trim() || '内联报文',
            body_preview: preview(entry.body),
            // 只有开了留存且没超上限才有全文；界面据此决定「重发」能不能用
            body_full: keepFull ? entry.body : null,
            // 逐条正文此时已经在原生层释放（分批解析发送），这里记的是平均每条的体积
            body_bytes: entry.sent > 0 ? Math.round(entry.bytes / entry.sent) : 0,
            message_count: entry.sent,
            message_id: entry.messageId ?? null,
            status: entry.sent > 0 ? 'success' : 'failure',
            // 部分失败时留第一条的原因，全成功留空；一条都没出去时这句就是界面要显的那句话
            error_message: entry.failure ?? (entry.sent > 0 ? null : '未发出任何消息'),
        });
    } catch (error) {
        log.warn(`发送历史写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
}

function report(clusterId: string, topic: string, detail: string, ok: boolean): void {
    insertOperationLog({
        cluster_id: clusterId,
        action: 'send',
        resource_type: 'message',
        resource_id: topic,
        resource_name: topic.split('/').pop() || topic,
        details: detail,
        result: ok ? 'success' : 'failure',
    });
}

export function registerProducerHandlers() {
    // 建常驻生产者会话。会话结束事件复用 msg:session-end：渲染端已经有一个监听，
    // 生产与消费两条路径的"会话没了"本来就是同一件事。
    registerNativeHandler(
        'producer:startSession',
        ProducerStartSchema,
        ([params]) => params,
        (config, input) => {
            return nativeClientManager.startProducer(
                input.clusterId,
                config,
                {
                    tenant: input.tenant,
                    namespace: input.namespace,
                    topic: input.topic,
                    persistent: input.persistent,
                    options: needOptions(input.options),
                    // 页签归属随会话一起留在主进程：关掉一个页签只该断它自己那条
                    ownerId: input.ownerId,
                },
                (event: SessionEndEvent) => sendToRenderer(MESSAGE_STREAM_CHANNELS.sessionEnd, event),
            );
        },
    );
    // 会话级操作（发送/flush/停止/列举）都只认 sessionId：连接参数在建会话时
    // 就定死了，那时候的 config 也已经交给原生 Client 持有，这里再去解一次集群
    // 只会多出"改了配置却发进旧连接"的错觉。
    registerHandler('producer:send', async (params: unknown): Promise<ProducerSendResult> => {
        const input = ProducerSendSchema.parse(params);
        const sessionId = input.sessionId;
        const topic = topicFullName(input.tenant, input.namespace, input.topic, input.persistent);
        const options = messageOptions(
            nativeClientManager.producerDefaults(sessionId),
            input.options as ProducerMessageOptions | undefined,
        );
        // 解析与发送在原生层逐批交替（每条都重新过一遍占位符，序号跨批连续），
        // 一次点 1000 条大报文时界面拿到的仍然是完整的失败清单，而主进程同时
        // 只持有一批正文。全部解析失败时 items 为空，压根不碰 broker。
        const result = await nativeClientManager.sendThroughSession(
            sessionId,
            {clusterId: input.clusterId, topicUri: topic},
            input.template as MessageTemplateBody,
            input.count,
            options,
        );
        if (result.messageIds.length === 0) {
            log.warn(`session ${sessionId}: 本次 ${input.count} 条全部未发出`);
        }
        report(
            input.clusterId,
            topic,
            `经会话发送 ${result.messageIds.length} 条，失败 ${result.failures.length} 条`,
            result.messageIds.length > 0,
        );
        recordSendHistory({
            clusterId: input.clusterId,
            topic,
            templateName: input.templateName,
            templateId: input.templateId,
            body: (input.template as MessageTemplateBody).body,
            sent: result.messageIds.length,
            bytes: result.bytes,
            messageId: result.messageIds[0] ?? null,
            failure: result.failures[0]?.error,
        });
        return result;
    });

    // 连续限速发送。句柄都在 manager 的会话表里，连接参数在建会话时已经交过去了，
    // 所以这里用 registerHandler 而不是 registerNativeHandler——再去解一次集群只会
    // 多出"改了配置却还在往旧连接里灌"的错觉。
    registerHandler('producer:startFlow', async (params: unknown) => {
        const input = ProducerFlowSchema.parse(params);
        // 每一轮只落一条历史：终态那一帧（flowRunning=false）是唯一知道实际投了
        // 多少条的时刻，而它可能来自用户停止、投满总量或出错自行结束。
        let recorded = false;
        // 归属信息要等 startFlow 返回，而开局即失败的那一轮终态帧就在返回之前——
        // 先把它存下来，拿到 info 再补写，否则"秒失败的那一轮"永远没有历史。
        let pendingTerminal: ProducerRunStats | null = null;
        const infoRef: {current: ProducerSessionInfo | undefined} = {current: undefined};
        const record = (stats: ProducerRunStats, info: ProducerSessionInfo) => {
            recorded = true;
            recordSendHistory({
                clusterId: info.clusterId,
                topic: info.topicUri,
                templateId: input.templateId,
                templateName: input.templateName,
                body: (input.template as MessageTemplateBody).body,
                sent: stats.sent,
                bytes: stats.bytesSent,
                failure: stats.lastError ?? stats.error,
            });
        };
        const emit = (stats: ProducerRunStats) => {
            sendToRenderer(MESSAGE_STREAM_CHANNELS.producerStats, stats);
            if (stats.flowRunning || recorded) {
                return;
            }
            if (infoRef.current) {
                record(stats, infoRef.current);
            } else {
                pendingTerminal = stats;
            }
        };
        const info = await nativeClientManager.startFlow(
            input.sessionId,
            {
                sessionId: input.sessionId,
                template: input.template as MessageTemplateBody,
                ratePerSecond: input.ratePerSecond,
                totalMessages: input.totalMessages,
                maxInFlight: input.maxInFlight,
                stopOnError: input.stopOnError,
                options: input.options as ProducerMessageOptions | undefined,
            },
            emit,
        );
        infoRef.current = info;
        if (pendingTerminal && !recorded) {
            record(pendingTerminal, info);
        }
        insertOperationLog({
            cluster_id: info.clusterId,
            action: 'send',
            resource_type: 'message',
            resource_id: info.topicUri,
            resource_name: info.topicUri.split('/').pop() || info.topicUri,
            details: `${info.producerName} 开始连续发送：${
                input.ratePerSecond > 0 ? `${input.ratePerSecond} 条/秒` : '不限速'
            }，${input.totalMessages > 0 ? `${input.totalMessages} 条` : '直到手动停止'}，在途 ${input.maxInFlight}`,
            result: 'success',
        });
        return info;
    });

    registerHandler('producer:stopFlow', async (params: unknown): Promise<ProducerRunStats | null> => {
        const parsed = SessionIdSchema.safeParse(params);
        if (!parsed.success) {
            throw new Error('Invalid session id');
        }
        return nativeClientManager.stopFlow(parsed.data.sessionId);
    });

    registerHandler('producer:setRate', async (params: unknown) => {
        const input = ProducerSetRateSchema.parse(params);
        return nativeClientManager.setFlowRate(input.sessionId, input.ratePerSecond);
    });

    registerHandler('producer:flush', async (params: unknown): Promise<{flushed: boolean}> => {
        const parsed = ProducerFlushSchema.safeParse(params);
        if (!parsed.success) {
            throw new Error('Invalid session id');
        }
        await nativeClientManager.flushSession(parsed.data.sessionId);
        return {flushed: true};
    });

    // 停止只需要会话 id。会话可能已经因出错自行结束，所以回 stopped 而不是报错。
    registerHandler('producer:stop', async (params: unknown): Promise<{stopped: boolean}> => {
        const parsed = SessionIdSchema.safeParse(params);
        if (!parsed.success) {
            throw new Error('Invalid session id');
        }
        return {stopped: await nativeClientManager.stopSessionById(parsed.data.sessionId)};
    });

    registerHandler('producer:listSessions', async (params: unknown) => {
        const parsed = ProducerSessionsSchema.safeParse(params ?? {});
        return nativeClientManager.listProducerSessions(parsed.success ? parsed.data.clusterId : undefined);
    });

    // 一次性发送：现开现关，不留会话。TopicDetail 的轻量发送和新页面的
    // "发一条试试"都走这里——那些场景留一条常驻连接只会让用户说不清哪条 topic 还连着。
    registerNativeHandler(
        'producer:sendOnce',
        ProducerSendOnceSchema,
        ([params]) => params,
        async (config, input) => {
            const options = needOptions(input.options);
            const topic = topicFullName(input.tenant, input.namespace, input.topic, input.persistent);
            // 与会话发送同一套逐批解析：这条路径同样可能一次投 1000 条
            const result = await nativeClientManager.sendOnce(
                input.clusterId,
                config,
                {
                    tenant: input.tenant,
                    namespace: input.namespace,
                    topic: input.topic,
                    persistent: input.persistent,
                    options,
                },
                {
                    template: input.template as MessageTemplateBody,
                    count: input.count,
                    options: messageOptions(options),
                },
            );
            if (result.messageIds.length === 0) {
                report(input.clusterId, topic, `模板解析或发送全部失败，未发出 ${input.count} 条`, false);
            } else {
                report(
                    input.clusterId,
                    topic,
                    `发送 ${result.messageIds.length} 条到 ${topic}${
                        result.failures.length ? `，失败 ${result.failures.length} 条` : ''
                    }`,
                    true,
                );
            }
            recordSendHistory({
                clusterId: input.clusterId,
                topic,
                templateName: input.templateName,
                templateId: input.templateId,
                body: (input.template as MessageTemplateBody).body,
                sent: result.messageIds.length,
                bytes: result.bytes,
                messageId: result.messageIds[0] ?? null,
                failure: result.failures[0]?.error,
            });
            return result;
        },
    );
}
