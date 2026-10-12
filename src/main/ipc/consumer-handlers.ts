import {
    ConsumerStartSchema,
    ProducerSessionsSchema,
    SessionIdSchema,
    registerHandler,
    registerNativeHandler,
} from './_shared';
import {nativeClientManager} from '../services/pulsar-native-client';
import {sendToRenderer} from './stream';
import {MESSAGE_STREAM_CHANNELS} from '../../shared/types';
import type {ConsumeStartParams, MessageBatch, SessionEndEvent} from '../../shared/types';
import {createLogger} from '../utils/logger';

const log = createLogger('IPCConsumer');

// 消费者工作台的会话通道。与 messages:startConsume 的区别只在返回什么：
// 那条给三态面板用，回一个 sessionId 就够；工作台要按会话显示订阅名、类型、
// 已收条数，所以建会话时直接把整份 ConsumerSessionInfo 带回去，省一次往返，
// 也省掉"建完立刻去查、查到的却是上一条同名会话"的窗口。

export function registerConsumerHandlers() {
    registerNativeHandler(
        'consumer:start',
        ConsumerStartSchema,
        ([params]) => params,
        async (config, input: ConsumeStartParams) => {
            const {sessionId} = await nativeClientManager.startConsume(
                input.clusterId,
                config,
                input,
                (batch: MessageBatch) => sendToRenderer(MESSAGE_STREAM_CHANNELS.consumeBatch, batch),
                (event: SessionEndEvent) => sendToRenderer(MESSAGE_STREAM_CHANNELS.sessionEnd, event),
            );
            return nativeClientManager.consumerSession(sessionId);
        },
    );

    registerHandler('consumer:list', async (params: unknown) => {
        const parsed = ProducerSessionsSchema.safeParse(params);
        if (!parsed.success) {
            log.warn('consumer:list: invalid params');
            return nativeClientManager.listConsumerSessions();
        }
        return nativeClientManager.listConsumerSessions(parsed.data.clusterId);
    });

    // 停止只需要会话 id；会话可能已经因收满上限或出错自行结束，所以回 stopped 而不是报错。
    registerHandler('consumer:stop', async (params: unknown) => {
        const parsed = SessionIdSchema.safeParse(params);
        if (!parsed.success) {
            throw new Error('Invalid session id');
        }
        return {stopped: await nativeClientManager.stopSessionById(parsed.data.sessionId)};
    });
}
