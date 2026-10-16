import {
    ConsumeStartSchema,
    MessageSendSchema,
    PeekSchema,
    ReadStartSchema,
    SessionIdSchema,
    SubscriptionPathSchema,
    insertOperationLog,
    registerClientHandler,
    registerHandler,
    registerNativeHandler,
} from './_shared';
import {nativeClientManager} from '../services/pulsar-native-client';
import {sendToRenderer} from './stream';
import {MESSAGE_STREAM_CHANNELS} from '../../shared/types';
import type {ConsumeStartParams, MessageBatch, PeekParams, ReadStartParams, SessionEndEvent} from '../../shared/types';

export function registerMessageHandlers() {
    registerNativeHandler(
        'messages:send',
        MessageSendSchema,
        ([params]) => params,
        async (config, {clusterId, tenant, namespace, topic, persistent, message, properties, options}) => {
            const result = await nativeClientManager.send(clusterId, config, {
                tenant,
                namespace,
                topic,
                persistent,
                message,
                properties,
                options,
            });

            insertOperationLog({
                cluster_id: clusterId,
                action: 'send',
                resource_type: 'message',
                resource_id: `${tenant}/${namespace}/${topic}`,
                resource_name: topic,
                details: `Sent message to ${tenant}/${namespace}/${topic}`,
                result: 'success',
            });

            return result;
        },
    );

    registerNativeHandler(
        'messages:startConsume',
        ConsumeStartSchema,
        ([params]) => params,
        (config, input: ConsumeStartParams) =>
            nativeClientManager.startConsume(
                input.clusterId,
                config,
                input,
                (batch: MessageBatch) => sendToRenderer(MESSAGE_STREAM_CHANNELS.consumeBatch, batch),
                (event: SessionEndEvent) => sendToRenderer(MESSAGE_STREAM_CHANNELS.sessionEnd, event),
            ),
    );

    registerNativeHandler(
        'messages:startRead',
        ReadStartSchema,
        ([params]) => params,
        (config, input: ReadStartParams) =>
            nativeClientManager.startRead(
                input.clusterId,
                config,
                input,
                (batch: MessageBatch) => sendToRenderer(MESSAGE_STREAM_CHANNELS.readBatch, batch),
                (event: SessionEndEvent) => sendToRenderer(MESSAGE_STREAM_CHANNELS.sessionEnd, event),
            ),
    );

    // 偷看：一次性返回几条内容，不建会话、不确认、原订阅游标纹丝不动。
    registerNativeHandler(
        'messages:peek',
        PeekSchema,
        ([params]) => params,
        (config, input: PeekParams) => nativeClientManager.peekMessages(input.clusterId, config, input),
    );

    // 停止只需要会话 id，不需要集群连接；会话可能早已因出错自行结束，所以回 stopped 而不是报错。
    const registerStop = (channel: string) =>
        registerHandler(channel, async (params: unknown) => {
            const parsed = SessionIdSchema.safeParse(params);
            if (!parsed.success) {
                throw new Error('Invalid session id');
            }
            return {stopped: await nativeClientManager.stopSessionById(parsed.data.sessionId)};
        });

    registerStop('messages:stopConsume');
    registerStop('messages:stopRead');

    registerClientHandler(
        'messages:getBacklog',
        SubscriptionPathSchema,
        ([params]) => params,
        (client, {tenant, namespace, topic, subscription, persistent}) =>
            client.getBacklog(tenant, namespace, topic, subscription, persistent),
    );
}
