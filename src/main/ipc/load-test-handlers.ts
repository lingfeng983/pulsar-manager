import {
    LoadTestStartSchema,
    LoadTestStopSchema,
    formatError,
    insertOperationLog,
    registerHandler,
    registerNativeHandler,
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
    registerNativeHandler(
        'benchmark:start',
        LoadTestStartSchema,
        ([params]) => params,
        async (config, input: LoadTestParams) => {
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
