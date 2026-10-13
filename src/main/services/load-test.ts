import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import type {Client, Consumer, Producer} from 'pulsar-client';
import {nativeClientManager, topicFullName, type NativeConnectionConfig} from './pulsar-native-client';
import {
    SendWindow,
    buildProducerConfig,
    createLatencyStats,
    createRateLimiter,
    defaultProducerOptions,
    isCapacityError,
    round2,
    round4,
} from './native-flow-utils';
import {createLogger} from '../utils/logger';
import {isTimeoutError, withHardTimeout} from '../utils/promise';
import type {LoadTestParams, LoadTestPhase, LoadTestProgress, ProducerOptions} from '../../shared/types';

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

// 载荷固定不变：随机字节压不出压缩收益，也不便于用户在 Topic 详情页核对消息内容，
// 这里测的是链路吞吐而不是压缩算法。
function messagePayload(sizeBytes: number): Buffer {
    return Buffer.alloc(sizeBytes, 'x');
}

interface Run {
    id: string;
    key: string;
    clusterId: string;
    topic: string;
    params: LoadTestParams;
    // 终止原因决定界面显示"完成 / 已停止 / 失败"，所以三类必须分开记录：
    // stopReason 是"被叫停"（用户、配置变更、超时），failure 是"出错了"。
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
    // execute 是否已经跑起来。没跑起来时 settled 还是初始的空 Promise，
    // 作废握手不能等它，只能直接关已经建好的 producer/consumer。
    running: boolean;
    // settle() 已经跑过（资源表被它取走并关闭）。之后 createProducer/subscribe
    // 才落地的句柄必须自己关掉：再塞进 run.producers 就没人关了，
    // 而 nativeClientManager.clear() 会在这些活句柄下面直接关原生 Client。
    resourcesSettled: boolean;
}

// 同一目标（集群 + Topic + 订阅）只允许一条压测在跑：两条并发写同一个 Topic，
// 速率和延迟都失去意义，而界面上一切正常——比直接拒绝更难解释。
function runKey(params: LoadTestParams): string {
    const subscription = params.consumeBacklog ? params.subscription : '-';
    const path = `${params.tenant}/${params.namespace}/${params.topic}`;
    return `${params.clusterId}|${params.persistent ? 'p' : 'n'}|${path}|${subscription}`;
}

// 压测的发送参数走工作台同一套 buildProducerConfig，同一个 Topic 上两边的数字才能比。
// 批大小取原生默认（1000 条 / 10ms），与提取前的行为逐字一致。
function producerOptions(params: LoadTestParams, index: number): ProducerOptions {
    return {
        ...defaultProducerOptions(),
        producerName: `pm-bench-${index}`,
        sendTimeoutMs: SEND_TIMEOUT_MS,
        maxPendingMessages: params.maxInFlightPerProducer,
        batchingMaxMessages: 1000,
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
        mbPerSec: round4(run.bytesSent / 1024 / 1024 / (elapsedMs / 1000)),
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
            running: false,
            resourcesSettled: false,
        };
        this.runs.set(key, run);

        try {
            // 与缓存客户端的握手：集群被删或改配置时先作废这条压测，再关原生 Client。
            // 顺序反过来就是原生层的 use-after-free（实测段错误）。
            // stop 必须等整条循环自己收尾（execute 末尾会 settle+discard），
            // 不能在这里直接 settle——那会在还有在途 send/receive 时关掉 producer，
            // 正是用户点"停止"那条路径早就避开、只有作废路径漏掉的崩溃来源。
            const held = await nativeClientManager.retain(params.clusterId, config, {
                onInvalidate: () => this.halt(run, '本集群的连接配置已变更（改配置或删除集群），压测已中止'),
                stop: () => this.windDown(run),
            });
            if (!held) {
                throw new Error('该集群的连接正在重建，请稍后重新开始压测');
            }
            run.releaseClient = held.release;
            await this.createResources(run, held.client);
            if (run.stopped) {
                // 建资源期间被作废：此时 execute 还没开始，客户端可能已经关掉，
                // 不能再拿这批 producer 去发送。
                throw new Error(run.stopReason || '压测在启动过程中被中止');
            }
        } catch (error) {
            await this.settle(run);
            this.discard(run);
            throw new Error(`压测启动失败：${error instanceof Error ? error.message : String(error)}`);
        }

        run.running = true;
        run.settled = this.execute(run, emit);
        return {runId: run.id, topic: run.topic};
    }

    async stop(runId: string): Promise<boolean> {
        const run = [...this.runs.values()].find(item => item.id === runId);
        if (!run) {
            return false;
        }
        this.halt(run, '用户停止');
        await this.windDown(run);
        return true;
    }

    async closeAll(): Promise<void> {
        const runs = [...this.runs.values()];
        runs.forEach(run => this.halt(run, '应用退出'));
        await Promise.all(runs.map(run => this.windDown(run)));
    }

    // 等一条压测彻底收尾。循环已经跑起来就必须等它自己关资源——execute 的末尾
    // 会 settle + discard；还卡在启动途中的话 settled 只是初始空 Promise，
    // 等它等于什么都没等，这时直接关已经建好的 producer/consumer 才是安全的。
    private async windDown(run: Run): Promise<void> {
        if (run.running) {
            await withHardTimeout(run.settled, `run ${run.id} did not settle`, RECEIVE_TIMEOUT_MS + CLOSE_TIMEOUT_MS);
            return;
        }
        await this.settle(run);
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
            const consumer = await client.subscribe({
                topic: run.topic,
                subscription: params.subscription,
                subscriptionType: 'Shared',
                subscriptionInitialPosition: 'Latest',
                consumerName: 'pm-bench',
            });
            if (run.resourcesSettled) {
                // 建到一半已经被作废：settle() 关的是它 splice 走的那批，这批没人管
                await consumer.close().catch(() => undefined);
                return;
            }
            run.consumer = consumer;
        }
        for (let index = 0; index < params.producers; index += 1) {
            const producer = await client.createProducer(
                buildProducerConfig(run.topic, producerOptions(params, index)),
            );
            if (run.resourcesSettled) {
                await producer.close().catch(() => undefined);
                continue;
            }
            run.producers.push(producer);
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
        if (isCapacityError(detail)) {
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
            // "发完"看的是投出去的条数都已落地：issued 上界是总量，sent+failed 上界是
            // issued，两段合起来才等于"队列里没有在途消息"。
            const sendDone = run.issued >= run.params.totalMessages && run.sent + run.failed >= run.issued;
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
        run.resourcesSettled = true;
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
