import type {ProducerOptions} from './types';

/**
 * 生产者参数的唯一一份出厂默认。
 *
 * 主进程建 producer、IPC 边界的 zod 默认值、界面表单的初值都取自这里：原先这三处
 * 各写一遍字面量，同一个 Topic 上就可能出现"界面显示 30 秒超时、实际按 10 秒发送"
 * 这种谁都没错却对不上的数字。
 *
 * chunkingEnabled 出厂为 false，因为原生绑定（pulsar-client 1.18 C++ 层）在
 * batchingEnabled 与 chunkingEnabled 同时为 true 时直接 abort 整个进程——实测没有
 * JS 异常、没有 crashpad 转储、主进程凭空消失。分块只在关掉批量时才可用，
 * 界面与 IPC 校验都按这条约束拦。
 */
export function defaultProducerOptions(): ProducerOptions {
    return {
        sendTimeoutMs: 30_000,
        maxPendingMessages: 1000,
        blockIfQueueFull: true,
        batchingEnabled: true,
        batchingMaxMessages: 500,
        batchingMaxPublishDelayMs: 10,
        compressionType: 'None',
        chunkingEnabled: false,
        eventTimeMode: 'none',
        delayMode: 'none',
    };
}
