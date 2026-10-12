import type {ConsumerConfig, ProducerConfig} from 'pulsar-client';
import type {LoadTestLatency, ProducerOptions} from '../../shared/types';
import {sleep} from '../utils/promise';

// 压测与生产者工作台共用的一套流控原语。放在这里而不是各自留一份：
// 两边的限速、在途窗口、延迟统计必须同一实现，否则同一个 Topic 上
// "压测说 8k msg/s、工作台说 5k msg/s"这种对不上的数字无法解释。

// 延迟样本上限：逐条留存的话 100 万条要占 8MB，且每次上报前排序会把主进程 CPU
// 吃在统计本身之上（数字因此失真）。蓄水池抽样固定这么多条，分位数相对误差约 1%，
// 每条消息多出的代价只有一次 Math.random。
const LATENCY_SAMPLE_MAX = 20_000;

export function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

// 吞吐量单独一档：慢流（十几条小报文）折算到 MB/s 只有 0.0007，round2 直接归零，
// 界面就读成"没在投"。四次只除一次 10000，而不是先 /100 再 /100——后者会让
// 0.0007 在二进制里显示成 0.0007000000000000001。
export function round4(value: number): number {
    return Math.round(value * 10000) / 10000;
}

// performance.now() 而不是 Date.now()：后者只有毫秒粒度，快链路下中位数会整片显示
// 0，而延迟恰恰是最需要看准的一项。
export function createLatencyStats(): {add: (elapsedMs: number) => void; summarize: () => LoadTestLatency | null} {
    const samples: number[] = [];
    let seen = 0;
    return {
        add(elapsedMs: number) {
            seen += 1;
            if (samples.length < LATENCY_SAMPLE_MAX) {
                samples.push(Math.max(0, elapsedMs));
                return;
            }
            // 第 n 条以 LATENCY_SAMPLE_MAX/n 的概率替换某个槽位，抽样因此与到达次序无关
            const index = Math.floor(Math.random() * seen);
            if (index < LATENCY_SAMPLE_MAX) {
                samples[index] = Math.max(0, elapsedMs);
            }
        },
        summarize(): LoadTestLatency | null {
            if (seen === 0) {
                return null;
            }
            const sorted = [...samples].sort((a, b) => a - b);
            // 分位取"不小于该分位的第一个样本"，读数偏保守而不是偏乐观
            const at = (percent: number) =>
                sorted[Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1)];
            const total = sorted.reduce((sum, value) => sum + value, 0);
            return {
                count: seen,
                avgMs: round2(total / sorted.length),
                minMs: round2(sorted[0]),
                p50Ms: round2(at(50)),
                p95Ms: round2(at(95)),
                p99Ms: round2(at(99)),
                maxMs: round2(sorted[sorted.length - 1]),
            };
        },
    };
}

export function createRateLimiter(ratePerSecond: number): () => Promise<void> {
    if (ratePerSecond <= 0) {
        return async () => undefined;
    }
    const stepMs = 1000 / ratePerSecond;
    let nextSlotAt = Date.now();
    return async () => {
        const waitMs = nextSlotAt - Date.now();
        nextSlotAt += stepMs;
        if (waitMs > 0) {
            await sleep(waitMs);
        }
    };
}

// 每条生产者维持一个在途发送窗口。逐条 `await send()` 会把每条消息的完整往返
// 延迟串进总耗时，吞吐上限就退化成"生产者数 ÷ 单条延迟"，批量化也形同关闭；
// 窗口大小同时用作原生队列上限（maxPendingMessages），多出来的发送由
// blockIfQueueFull 在原生侧排队，因此并发度始终由参数控制而不是失控增长。
// 记账的 Promise 一律不 reject（发送异常在源头就吞掉并计入失败），否则
// Promise.race 会把失败当停止信号。
export class SendWindow {
    private pending = new Set<Promise<void>>();

    constructor(private readonly size: number) {}

    async waitForSlot(): Promise<void> {
        while (this.pending.size >= this.size) {
            await Promise.race([...this.pending]);
        }
    }

    track(send: Promise<void>): void {
        const task = send.then(() => {
            this.pending.delete(task);
        });
        this.pending.add(task);
    }

    async drain(): Promise<void> {
        while (this.pending.size > 0) {
            await Promise.race([...this.pending]);
        }
    }
}

// broker 明确拒绝的容量类错误：继续灌只会刷满日志，调用方应当就此收手。
export function isCapacityError(detail: string): boolean {
    return /backlog quota|publishing is terminated|is not allowed|too large|write-operation/i.test(detail);
}

// 与原生 ProducerConfig 的字段一一对应（pulsar-client 1.18 绑定实测）。
// 注意绑定没有事务、没有 getStats、没有分区定向 API，所以这里也不提供。
export {defaultProducerOptions} from '../../shared/producer-defaults';

export function buildProducerConfig(topic: string, options: ProducerOptions): ProducerConfig {
    const config: ProducerConfig = {
        topic,
        sendTimeoutMs: options.sendTimeoutMs,
        // 队列上限即这条生产者允许的在途消息数：满了之后 blockIfQueueFull 让 send()
        // 排队等待而不是丢消息，并发窗口因此由参数控制，不靠原生默认值。
        maxPendingMessages: options.maxPendingMessages,
        blockIfQueueFull: options.blockIfQueueFull,
        batchingEnabled: options.batchingEnabled,
        compressionType: options.compressionType,
        // 批量与分块同开会让原生绑定直接 abort 掉整个主进程（实测无 JS 异常、无转储），
        // 而这里是从库里/导入文件拿到的参数进入原生层的最后一道，所以宁可少传一个开关：
        // 界面已经禁止这种组合，走到这一步的只可能是历史导入数据。
        chunkingEnabled: options.chunkingEnabled && !options.batchingEnabled,
    };
    if (options.producerName) {
        config.producerName = options.producerName;
    }
    if (options.batchingEnabled) {
        config.batchingMaxMessages = options.batchingMaxMessages;
        config.batchingMaxPublishDelayMs = options.batchingMaxPublishDelayMs;
        if (options.batchingMaxAllowedSizeInBytes) {
            config.batchingMaxAllowedSizeInBytes = options.batchingMaxAllowedSizeInBytes;
        }
    }
    if (options.messageRoutingMode) {
        config.messageRoutingMode = options.messageRoutingMode;
    }
    if (options.hashingScheme) {
        config.hashingScheme = options.hashingScheme;
    }
    if (options.accessMode) {
        config.accessMode = options.accessMode;
    }
    return config;
}

// 消费者侧同理：可选的原生开关集中在这里决定，缺省一律不传，让绑定用它自己的默认值。
// 旧的三态面板只给订阅类型/起始位置/自动 ack，那些之外的字段全是新增，
// 传 undefined 与不传在原生层不等价（部分字段会被 C++ 侧直接读成 0），所以逐个判。
// 订阅类型与起始位置用原生枚举而不是界面上的字符串：界面上的 Key_Shared 在
// 绑定里拼作 KeyShared，那层翻译留在调用方，这里只接受已经对上的值。
type NativeSubscriptionType = NonNullable<ConsumerConfig['subscriptionType']>;
type NativeInitialPosition = NonNullable<ConsumerConfig['subscriptionInitialPosition']>;

export interface ConsumerConfigInput {
    subscription: string;
    subscriptionType: NativeSubscriptionType;
    initialPosition: NativeInitialPosition;
    receiverQueueSize?: number;
    ackTimeoutMs?: number;
    nAckRedeliverTimeoutMs?: number;
    consumerName?: string;
    deadLetter?: {topicName: string; maxRedeliverCount: number; initialSubscriptionName?: string};
}

export function buildConsumerConfig(topic: string, params: ConsumerConfigInput): ConsumerConfig {
    const config: ConsumerConfig = {
        topic,
        subscription: params.subscription,
        subscriptionType: params.subscriptionType,
        subscriptionInitialPosition: params.initialPosition,
    };
    if (params.receiverQueueSize) {
        config.receiverQueueSize = params.receiverQueueSize;
    }
    if (params.ackTimeoutMs) {
        config.ackTimeoutMs = params.ackTimeoutMs;
    }
    if (params.nAckRedeliverTimeoutMs) {
        config.nAckRedeliverTimeoutMs = params.nAckRedeliverTimeoutMs;
    }
    if (params.consumerName) {
        config.consumerName = params.consumerName;
    }
    if (params.deadLetter) {
        config.deadLetterPolicy = {
            deadLetterTopic: params.deadLetter.topicName,
            maxRedeliverCount: params.deadLetter.maxRedeliverCount,
            ...(params.deadLetter.initialSubscriptionName
                ? {initialSubscriptionName: params.deadLetter.initialSubscriptionName}
                : {}),
        };
    }
    return config;
}
