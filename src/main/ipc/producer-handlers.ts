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
    registerHandler,
    registerNativeHandler,
} from './_shared';
import {nativeClientManager, topicFullName} from '../services/pulsar-native-client';
import {messageOptions, resolveBatch} from '../services/producer-send';
import {sendToRenderer} from './stream';
import {MESSAGE_STREAM_CHANNELS} from '../../shared/types';
import type {
    MessageTemplateBody,
    ProducerMessageOptions,
    ProducerOptions,
    ProducerRunStats,
    ProducerSendResult,
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

// 解析失败与发送失败说的是同一条消息（序号都取本次 count 里的位置），
// 接在一起按序号排好，界面才能把"第 3 条没发出去"读成第 3 条。
function joinFailures(
    resolved: {index: number; error: string}[],
    sent: {index: number; error: string}[],
): {index: number; error: string}[] {
    return [...resolved, ...sent].sort((a, b) => a.index - b.index);
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
        const options = messageOptions(
            nativeClientManager.producerDefaults(sessionId),
            input.options as ProducerMessageOptions | undefined,
        );
        const batch = resolveBatch(input.template as MessageTemplateBody, input.count, options);
        if (batch.items.length === 0) {
            // 一条都没解析出来就不碰 broker：把解析错误原样交回去，
            // 界面显示"0 条已发 / N 条失败"，而不是一句笼统的发送失败。
            log.warn(`session ${sessionId}: 本次 ${input.count} 条全部解析失败`);
            return {messageIds: [], bytes: 0, failures: batch.failures};
        }
        const result = await nativeClientManager.sendThroughSession(sessionId, batch.items);
        result.failures = joinFailures(batch.failures, result.failures);
        report(
            input.clusterId,
            topicFullName(input.tenant, input.namespace, input.topic, input.persistent),
            `经会话发送 ${result.messageIds.length} 条，失败 ${result.failures.length} 条`,
            result.messageIds.length > 0,
        );
        return result;
    });

    // 连续限速发送。句柄都在 manager 的会话表里，连接参数在建会话时已经交过去了，
    // 所以这里用 registerHandler 而不是 registerNativeHandler——再去解一次集群只会
    // 多出"改了配置却还在往旧连接里灌"的错觉。
    registerHandler('producer:startFlow', async (params: unknown) => {
        const input = ProducerFlowSchema.parse(params);
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
            (stats: ProducerRunStats) => sendToRenderer(MESSAGE_STREAM_CHANNELS.producerStats, stats),
        );
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
            const batch = resolveBatch(input.template as MessageTemplateBody, input.count, messageOptions(options));
            if (batch.items.length === 0) {
                report(input.clusterId, topic, `模板解析失败，未发送 ${input.count} 条`, false);
                return {messageIds: [], bytes: 0, failures: batch.failures};
            }
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
                batch.items,
            );
            result.failures = joinFailures(batch.failures, result.failures);
            report(
                input.clusterId,
                topic,
                `发送 ${result.messageIds.length} 条到 ${topic}${
                    result.failures.length ? `，失败 ${result.failures.length} 条` : ''
                }`,
                result.messageIds.length > 0,
            );
            return result;
        },
    );
}
