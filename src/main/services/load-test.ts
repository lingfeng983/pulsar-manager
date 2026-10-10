import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import type {Client, Consumer, Producer, ProducerConfig} from 'pulsar-client';
import {nativeClientManager, topicFullName, type NativeConnectionConfig} from './pulsar-native-client';
import {createLogger} from '../utils/logger';
import {isTimeoutError, sleep, withHardTimeout} from '../utils/promise';
import type {LoadTestLatency, LoadTestParams, LoadTestPhase, LoadTestProgress} from '../../shared/types';

const log = createLogger('LoadTest');

// 进度推送节流：压测一秒能发几万条，逐条通知会把 IPC 通道打成瓶颈，
// 反过来把被测链路的吞吐压下去，测出来的数字就不准了。
const PROGRESS_INTERVAL_MS = 500;
// 消费模式下发送结束后再给这些时间让在途消息落地，之后无论收到多少都收尾。
// 缺这道保险时，订阅落后于生产会让运行永远结束不了。
const CONSUME_DRAIN_MS = 10_000;
// 单次 receive 的等待上限：超时是正常空轮询，用来周期性回到循环头检查停止标志
// （与消息会话同一套纪律，见 pulsar-native-client）。
const RECEIVE_TIMEOUT_MS = 2000;
const CLOSE_TIMEOUT_MS = 5000;
// 发送阶段整体硬上限：broker 半死时 send() 可能永不返回，没有它运行就再也停不掉
// （停止要能推进到关闭分支，而关闭发生在循环退出之后）。
const SEND_DEADLINE_MS = 10 * 60_000;
const SEND_TIMEOUT_MS = 30_000;
// 延迟样本上限：逐条留存的话 100 万条要占 8MB，且每次上报前排序会把主进程 CPU
// 吃在统计本身之上（数字因此失真）。蓄水池抽样固定这么多条，分位数相对误差约 1%，
// 每条消息多出的代价只有一次 Math.random。
const LATENCY_SAMPLE_MAX = 20_000;
// 一轮压测同时在途（已发出但未被 broker 确认）的总字节上限。原生发送队列会把
// 这些载荷全留在内存里：32 生产者 × 2000 并发 × 1MB 就是 64GB，不拦的话应用会被
// 自己压测的待确认队列撑爆，而现场表现为原生层崩溃而不是友好提示。
const MAX_IN_FLIGHT_BYTES = 256 * 1024 * 1024;

// 跨字段的资源上限在这里检查而不是写在 schema 里：zod 校验失败只会回
// "Invalid input parameters"，用户看不出到底是哪一项配大了。
function validateLimits(params: LoadTestParams): void {
    const inFlightBytes = params.producers * params.maxInFlightPerProducer * params.messageSizeBytes;
    if (inFlightBytes > MAX_IN_FLIGHT_BYTES) {
        throw new Error(
            `在途消息总量约 ${Math.round(inFlightBytes / 1024 / 1024)}MB，超过 ${
                MAX_IN_FLIGHT_BYTES / 1024 / 1024
            }MB 上限，请减少生产者数、单生产者并发或消息大小`,
        );
    }
    // 退订只对本轮压测建的订阅有意义，而只有消费模式才会建订阅；勾了清理却没开
    // 消费，运行结束会静默什么都不做。
    if (params.unsubscribeAfterRun && !params.consumeBacklog) {
        throw new Error('清理订阅需要先开启同时消费');
    }
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

// 终止原因决定界面显示"完成 / 已停止 / 失败"，所以三类必须分开记录：
// stopReason 是"被叫停"（用户、配置变更、超时），failure 是"出错了"。
function createLatencyStats() {
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

// performance.now() 而不是 Date.now()：后者只有毫秒粒度，快链路下中位数会整片显示
// 0，而延迟恰恰是压测里最需要看准的一项。
function createRateLimiter(ratePerSecond: number) {
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

// 载荷固定不变：随机字节压不出压缩收益，也不便于用户在 Topic 详情页核对消息内容，
// 这里测的是链路吞吐而不是压缩算法。
function messagePayload(sizeBytes: number): Buffer {
    return Buffer.alloc(sizeBytes, 'x');
}

// 每个生产者维持一个在途发送窗口。逐条 `await send()` 会把每条消息的完整往返
// 延迟串进总耗时，吞吐上限就退化成"生产者数 ÷ 单条延迟"，批量化也形同关闭；
// 窗口大小同时用作原生队列上限（maxPendingMessages），多出来的发送由
// blockIfQueueFull 在原生侧排队，因此并发度始终由参数控制而不是失控增长。
// 记账的 Promise 一律不 reject（发送异常在源头就吞掉并计入失败），否则
// Promise.race 会把失败当停止信号。
class SendWindow {
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

interface Run {
    id: string;
    key: string;
    clusterId: string;
    topic: string;
    params: LoadTestParams;
    stopped: boolean;
    stopReason: string | null;
    failure: string | null;
    lastError: string | null;
    startedAt: number;
    // 已投出去的条数（含在途）：循环上限必须按它算，否则窗口里那条生产者会在
    // "已确认数"还没涨到总量时继续投递，实际写入超出用户设定的总量。
    issued: number;
    sent: number;
    failed: number;
    bytesSent: number;
    consumed: number;
    latency: ReturnType<typeof createLatencyStats>;
    producers: Producer[];
    consumer: Consumer | null;
    releaseClient: (() => void) | null;
    // 循环退出 + 资源关闭 + 终态上报的整体 Promise：停止时等它，
    // 而不是自己去关原生对象（在途发送/接收还没落地就关是崩溃温床）。
    settled: Promise<void>;
}

// 同一目标（集群 + Topic + 订阅）只允许一条压测在跑：两条并发写同一个 Topic，
// 速率和延迟都失去意义，而界面上一切正常——比直接拒绝更难解释。
function runKey(params: LoadTestParams): string {
    const subscription = params.consumeBacklog ? params.subscription : '-';
    const path = `${params.tenant}/${params.namespace}/${params.topic}`;
    return `${params.clusterId}|${params.persistent ? 'p' : 'n'}|${path}|${subscription}`;
}

function producerConfig(params: LoadTestParams, topic: string, index: number): ProducerConfig {
    return {
        topic,
        producerName: `pm-bench-${index}`,
        sendTimeoutMs: SEND_TIMEOUT_MS,
        // 队列上限即这条生产者允许的在途消息数：满了之后 blockIfQueueFull 让 send()
        // 排队等待而不是丢消息，并发窗口因此由参数控制，不靠原生默认值。
        maxPendingMessages: params.maxInFlightPerProducer,
        blockIfQueueFull: true,
        batchingEnabled: params.batchingEnabled,
        compressionType: params.compression,
    };
}

function progressOf(run: Run, phase: LoadTestPhase): LoadTestProgress {
    const elapsedMs = Math.max(1, Date.now() - run.startedAt);
    return {
        runId: run.id,
        phase,
        sent: run.sent,
        failed: run.failed,
        consumed: run.consumed,
        totalMessages: run.params.totalMessages,
        messageSizeBytes: run.params.messageSizeBytes,
        producerCount: run.params.producers,
        bytesSent: run.bytesSent,
        elapsedMs,
        msgPerSec: round2((run.sent * 1000) / elapsedMs),
        mbPerSec: round2(run.bytesSent / 1024 / 1024 / (elapsedMs / 1000)),
        latency: run.latency.summarize(),
        error: run.failure ?? run.stopReason ?? undefined,
        lastError: run.lastError ?? undefined,
    };
}

class LoadTestManager {
    private runs = new Map<string, Run>();

    /**
     * 启动一轮压测。建好消费者与生产者之后立刻返回 runId，实际发送在后台跑、
     * 通过 emit 推进度——调用方（IPC handler）若在运行结束时才返回，界面就再也
     * 拿不到 runId，用户想中途停止都没有句柄。
     */
    async start(
        params: LoadTestParams,
        config: NativeConnectionConfig,
        emit: (progress: LoadTestProgress) => void,
    ): Promise<{runId: string; topic: string}> {
        validateLimits(params);

        const key = runKey(params);
        if (this.runs.has(key)) {
            throw new Error('该 Topic 已有压测在运行，请先停止');
        }

        const run: Run = {
            id: randomUUID(),
            key,
            clusterId: params.clusterId,
            topic: topicFullName(params.tenant, params.namespace, params.topic, params.persistent),
            params,
            stopped: false,
            stopReason: null,
            failure: null,
            lastError: null,
            startedAt: Date.now(),
            issued: 0,
            sent: 0,
            failed: 0,
            bytesSent: 0,
            consumed: 0,
            latency: createLatencyStats(),
            producers: [],
            consumer: null,
            releaseClient: null,
            settled: Promise.resolve(),
        };
        this.runs.set(key, run);

        try {
            // 与缓存客户端的握手：集群被删或改配置时先作废这条压测，再关原生 Client。
            // 顺序反过来就是原生层的 use-after-free（实测段错误）。
            const held = await nativeClientManager.retain(params.clusterId, config, {
                onInvalidate: () => this.halt(run, '本集群的连接配置已变更（改配置或删除集群），压测已中止'),
                stop: () => this.settle(run),
            });
            if (!held) {
                throw new Error('该集群的连接正在重建，请稍后重新开始压测');
            }
            run.releaseClient = held.release;
            await this.createResources(run, held.client);
        } catch (error) {
            await this.settle(run);
            this.discard(run);
            throw new Error(`压测启动失败：${error instanceof Error ? error.message : String(error)}`);
        }

        run.settled = this.execute(run, emit);
        return {runId: run.id, topic: run.topic};
    }

    async stop(runId: string): Promise<boolean> {
        const run = [...this.runs.values()].find(item => item.id === runId);
        if (!run) {
            return false;
        }
        this.halt(run, '用户停止');
        await withHardTimeout(run.settled, `run ${runId} did not settle`, RECEIVE_TIMEOUT_MS + CLOSE_TIMEOUT_MS);
        return true;
    }

    async closeAll(): Promise<void> {
        const runs = [...this.runs.values()];
        runs.forEach(run => this.halt(run, '应用退出'));
        await Promise.all(
            runs.map(run => withHardTimeout(run.settled, `run ${run.id} did not settle`, CLOSE_TIMEOUT_MS)),
        );
    }

    // reason 为 null 表示"因故障中止"：终态由 failure 决定，不能把异常伪装成用户停止。
    private halt(run: Run, reason: string | null): void {
        if (run.stopped) {
            return;
        }
        run.stopped = true;
        if (reason) {
            run.stopReason = reason;
        }
    }

    private discard(run: Run): void {
        this.runs.delete(run.key);
        run.releaseClient?.();
        run.releaseClient = null;
    }

    private async createResources(run: Run, client: Client): Promise<void> {
        const {params} = run;
        // 消费者必须先于生产者建好：订阅起始位置是 Latest，晚建会漏掉最前面的消息，
        // "发 1000 条只收到 800 条"会被当成集群丢消息。
        if (params.consumeBacklog) {
            run.consumer = await client.subscribe({
                topic: run.topic,
                subscription: params.subscription,
                subscriptionType: 'Shared',
                subscriptionInitialPosition: 'Latest',
                consumerName: 'pm-bench',
            });
        }
        for (let index = 0; index < params.producers; index += 1) {
            run.producers.push(await client.createProducer(producerConfig(params, run.topic, index)));
        }
    }

    private async execute(run: Run, emit: (progress: LoadTestProgress) => void): Promise<void> {
        // 生产与消费并发跑：先建好消费者再发送，边发边收才是链路吞吐；
        // 若等发送全部完成才开始收，测到的只是积压回灌速度。
        // allSettled 是必须的：任一分支异常时另一分支也要等它退出，否则会在
        // 还有在途 receive 的情况下关掉 consumer（原生层 use-after-free）。
        const branches = [this.produceAll(run, emit)];
        if (run.consumer) {
            branches.push(this.consumeAll(run, emit));
        }
        const results = await Promise.allSettled(branches);
        for (const result of results) {
            if (result.status === 'rejected') {
                const detail = result.reason instanceof Error ? result.reason.message : String(result.reason);
                run.failure = run.failure || detail;
                log.error(`run ${run.id} failed`, detail);
            }
        }
        await this.settle(run);
        this.discard(run);
        emit(progressOf(run, this.phaseOf(run)));
    }

    private phaseOf(run: Run): LoadTestPhase {
        if (run.failure) {
            return 'error';
        }
        if (run.stopped && run.stopReason) {
            return 'stopped';
        }
        return 'completed';
    }

    private async produceAll(run: Run, emit: (progress: LoadTestProgress) => void): Promise<void> {
        const payload = messagePayload(run.params.messageSizeBytes);
        const acquire = createRateLimiter(run.params.ratePerSecond);
        const deadlineAt = Date.now() + SEND_DEADLINE_MS;
        let lastEmitAt = 0;

        const emitProgress = () => {
            const now = Date.now();
            if (now - lastEmitAt < PROGRESS_INTERVAL_MS) {
                return;
            }
            lastEmitAt = now;
            emit(progressOf(run, 'running'));
        };

        // 各生产者共用一条消息流（谁空闲谁取下一条），比按生产者平分总量更均衡：
        // 分区之间快慢不一时，平分的那份会被最慢的生产者拖住。
        const worker = async (producer: Producer) => {
            // 每条生产者维持 maxInFlightPerProducer 个在途发送：逐条 await 的话
            // 并发度就只有生产者数量，批量化形同关闭，测出来的吞吐会低一个量级。
            const window = new SendWindow(run.params.maxInFlightPerProducer);
            const send = async () => {
                const startedAt = performance.now();
                try {
                    await producer.send({data: payload});
                    run.latency.add(performance.now() - startedAt);
                    run.sent += 1;
                    run.bytesSent += payload.length;
                } catch (error) {
                    this.recordSendFailure(run, error);
                }
            };
            while (!run.stopped && run.issued < run.params.totalMessages) {
                if (Date.now() >= deadlineAt) {
                    this.halt(
                        run,
                        `发送阶段超过 ${Math.round(SEND_DEADLINE_MS / 60_000)} 分钟未结束，已按实际完成量收尾`,
                    );
                    break;
                }
                await window.waitForSlot();
                await acquire();
                // 上面两个 await 期间别的生产者可能已经把总量投完，这里必须重新检查
                if (run.stopped || run.issued >= run.params.totalMessages) {
                    break;
                }
                run.issued += 1;
                window.track(send());
                emitProgress();
            }
            // 停止或跑完都要等在途发送落地：它们已经进了原生队列，broker 一定会收到，
            // 提前返回会让统计的发送数小于实际写入数，消费端与 Topic 统计都对不上；
            // 更严重的是 settle 会在还有在途 send 的情况下关掉 producer。
            await window.drain();
            emitProgress();
        };

        await Promise.all(run.producers.map(worker));
        // 批量化开启时最后一段消息还堆在原生队列里：不 flush 就会"发出 N 条、
        // broker 只收到 N-k 条"，消费端与 Topic 统计都对不上。
        if (run.params.batchingEnabled) {
            await Promise.all(
                run.producers.map(producer =>
                    withHardTimeout(
                        producer.flush().then(() => undefined),
                        `run ${run.id} flush failed`,
                        CLOSE_TIMEOUT_MS,
                    ),
                ),
            );
        }
    }

    // 单条失败不中断整轮：压测的目的之一就是看链路在压力下掉多少条。
    // 但 broker 明确拒绝的容量类错误继续灌只会刷满日志，就此收手。
    // 这里不碰 run.failure——几条失败不该把整轮报成"错误"，界面按失败条数显示。
    private recordSendFailure(run: Run, error: unknown): void {
        run.failed += 1;
        const detail = error instanceof Error ? error.message : String(error);
        run.lastError = detail;
        if (/backlog quota|publishing is terminated|is not allowed|too large|write-operation/i.test(detail)) {
            run.failure = `集群拒绝了写入：${detail}`;
            this.halt(run, null);
        }
    }

    private async consumeAll(run: Run, emit: (progress: LoadTestProgress) => void): Promise<void> {
        const consumer = run.consumer;
        if (!consumer) {
            return;
        }
        let lastEmitAt = 0;
        let sendFinishedAt = 0;
        while (!run.stopped) {
            const sendDone = run.sent + run.failed >= run.params.totalMessages;
            if (sendDone && !sendFinishedAt) {
                sendFinishedAt = Date.now();
            }
            // 发送已完成：收到的一样多就结束；否则最多再等 CONSUME_DRAIN_MS
            if (sendFinishedAt && (run.consumed >= run.sent || Date.now() - sendFinishedAt >= CONSUME_DRAIN_MS)) {
                return;
            }
            try {
                const message = await consumer.receive(RECEIVE_TIMEOUT_MS);
                run.consumed += 1;
                await consumer.acknowledge(message);
            } catch (error) {
                if (!isTimeoutError(error)) {
                    throw error;
                }
                continue;
            }
            if (Date.now() - lastEmitAt >= PROGRESS_INTERVAL_MS) {
                lastEmitAt = Date.now();
                emit(progressOf(run, 'running'));
            }
        }
    }

    // 关闭顺序：循环已经退出（不再有在途发送/接收）→ 关 producer/consumer →
    // 释放客户端引用。中间任何一步超时都不能卡住后面的收尾。
    private async settle(run: Run): Promise<void> {
        run.stopped = true;
        const producers = run.producers.splice(0);
        const consumer = run.consumer;
        run.consumer = null;

        // 退订必须赶在关闭之前：close 之后原生 consumer 的句柄状态不再受控（实测这条
        // 路径就是原生层崩溃的来源），而 unsubscribe 本身就是"断开本消费者并删除订阅"
        // 的正规入口。失败只记日志——消息已经压完了，不该因为清理订阅失败把整轮报成错误。
        if (consumer && run.params.unsubscribeAfterRun) {
            await withHardTimeout(
                consumer
                    .unsubscribe()
                    .catch(error =>
                        log.warn(
                            `run ${run.id} unsubscribe failed`,
                            error instanceof Error ? error.message : String(error),
                        ),
                    ),
                `run ${run.id} unsubscribe failed`,
                CLOSE_TIMEOUT_MS,
            );
        }

        const closing = [...producers, ...(consumer ? [consumer] : [])].map(resource =>
            withHardTimeout(
                resource
                    .close()
                    .catch(error =>
                        log.warn(
                            `run ${run.id} resource close failed`,
                            error instanceof Error ? error.message : String(error),
                        ),
                    ),
                `run ${run.id} resource close timed out`,
                CLOSE_TIMEOUT_MS,
            ),
        );
        await Promise.all(closing);
    }
}

export const loadTestManager = new LoadTestManager();
