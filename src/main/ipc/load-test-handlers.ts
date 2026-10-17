import {
    LoadTestStartSchema,
    LoadTestStopSchema,
    buildConnectionConfig,
    formatError,
    insertOperationLog,
    registerClientHandler,
    registerHandler,
} from './_shared';
import {loadTestManager} from '../services/load-test';
import {sendToRenderer} from './stream';
import {LOAD_TEST_CHANNEL} from '../../shared/types';
import type {LoadTestParams, LoadTestProgress} from '../../shared/types';
import {createLogger} from '../utils/logger';

const log = createLogger('IPC');

// 压测参数的中文摘要，同时用于操作日志和界面提示
function describeRun(params: LoadTestParams): string {
    const rate = params.ratePerSecond ? `限速 ${params.ratePerSecond} msg/s` : '不限速';
    const consume = params.consumeBacklog ? `，同时消费（订阅 ${params.subscription}）` : '，仅生产';
    return `${params.producers} 个生产者共 ${params.totalMessages} 条 × ${params.messageSizeBytes} 字节，${rate}${consume}`;
}

export function registerLoadTestHandlers() {
    // 用 client handler 而不是 native handler：退订会把订阅连同它的积压一起删掉，
    // 所以开跑前必须先问 admin「这个订阅是不是本来就存在」。
    registerClientHandler(
        'benchmark:start',
        LoadTestStartSchema,
        ([params]) => params,
        async (client, input: LoadTestParams) => {
            if (input.consumeBacklog && input.unsubscribeAfterRun) {
                const subscriptions = await client.getSubscriptions(
                    input.tenant,
                    input.namespace,
                    input.topic,
                    input.persistent,
                );
                // 订阅名是用户填的，撞上已有订阅完全可能。此时 unsubscribe 删掉的
                // 不只是本轮，而是别人正在用的订阅和它积压的历史消息——压测不该
                // 变成一次不可撤销的数据删除。
                if (subscriptions.includes(input.subscription)) {
                    throw new Error(
                        `订阅 ${input.subscription} 在本轮开始前已存在；` +
                            '「结束后清理订阅」会连同它已有的积压一起删除，请换一个订阅名或取消清理',
                    );
                }
            }
            const config = await buildConnectionConfig(input.clusterId);
            if (!config) {
                throw new Error('Cluster not found');
            }
            // 进度用流式通道推送：start 建好生产者就立刻返回 runId，用户才能中途停止
            const result = await loadTestManager.start(input, config, (progress: LoadTestProgress) =>
                sendToRenderer(LOAD_TEST_CHANNEL, progress),
            );
            insertOperationLog({
                cluster_id: input.clusterId,
                action: 'benchmark',
                resource_type: 'topic',
                resource_id: `${input.tenant}/${input.namespace}/${input.topic}`,
                resource_name: input.topic,
                details: `快速压测启动：${describeRun(input)}`,
                result: 'success',
            });
            return result;
        },
    );

    // 停止只需要 runId，不需要集群连接；运行也可能早已自行结束（跑完、出错、或所在
    // 集群被删），所以回 stopped:false 而不是报错。
    registerHandler('benchmark:stop', async (params: unknown) => {
        const parsed = LoadTestStopSchema.safeParse(params);
        if (!parsed.success) {
            log.warn('benchmark:stop: invalid input parameters', formatError(parsed.error));
            throw new Error('Invalid run id');
        }
        return {stopped: await loadTestManager.stop(parsed.data.runId)};
    });
}
