import {app} from 'electron';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {AuthenticationBasic, AuthenticationToken, Client, LogLevel, MessageId} from 'pulsar-client';
import type {ClientConfig, Consumer, Message as NativeMessage, Producer, Reader, SubscriptionType} from 'pulsar-client';
import type {AuthenticationTls} from 'pulsar-client';
import {createLogger} from '../utils/logger';
import {isTimeoutError, settledWithin, sleep, withHardTimeout} from '../utils/promise';
import {
    buildConsumerConfig,
    buildProducerConfig,
    createLatencyStats,
    createRateLimiter,
    isCapacityError,
    round2,
    round4,
    SendWindow,
} from './native-flow-utils';
import {applyOptions, messageOptions, resolveBatch, toProducerMessage, type OutboundMessage} from './producer-send';
import type {
    ConsumeStartParams,
    ConsumerSessionInfo,
    Message,
    MessageBatch,
    MessageTemplateBody,
    PeekParams,
    PeekResult,
    ProducerFlowParams,
    ProducerMessageOptions,
    ProducerOptions,
    ProducerRunStats,
    ProducerSendResult,
    ProducerSessionInfo,
    ReadStartParams,
    SessionEndEvent,
} from '../../shared/types';

const log = createLogger('NativeClient');

// 与 admin 客户端共用同一份解密后的连接参数（凭据只在 _shared 里解一次密）。
export interface NativeConnectionConfig {
    serviceUrl: string;
    operationTimeoutSeconds?: number;
    authPlugin?: string | null;
    authParams?: string | null;
    tlsEnabled?: boolean;
    tlsTrustCerts?: string | null;
    // 地址是被本地转发改写出来的 127.0.0.1（SSH 隧道或 kubectl port-forward）
    viaLocalForward?: boolean;
}

// 原生客户端只接受证书文件路径，而集群里存的是 PEM 内容，只能落一次盘。
// 这里写的是公钥信任证书（不是私钥），权限收到 0600 并按内容哈希命名以便复用。
function writeTrustCert(pem: string): string {
    const dir = path.join(app.getPath('temp'), 'pulsar-manager-trust-certs');
    fs.mkdirSync(dir, {recursive: true});
    const name = `trust-${crypto.createHash('sha256').update(pem).digest('hex').slice(0, 16)}.pem`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, pem, {mode: 0o600});
    return file;
}

// auth_plugin 存的是 broker 侧的 Java 类名，只能按名字映射到原生认证实现。
// 认不出来就明确报错——静默按无认证连接会让用户以为凭据生效了。
function buildAuthentication(
    config: NativeConnectionConfig,
): AuthenticationTls | AuthenticationToken | AuthenticationBasic {
    const plugin = (config.authPlugin || '').toLowerCase();
    const params = config.authParams || '';
    if (!plugin) {
        throw new Error('集群未配置认证插件');
    }
    if (plugin.includes('token')) {
        // 兼容 "token:xxx" 与裸 token 两种存法
        return new AuthenticationToken({token: params.replace(/^token:/i, '')});
    }
    if (plugin.includes('basic')) {
        const parsed = JSON.parse(params) as {username?: string; password?: string};
        return new AuthenticationBasic({username: parsed.username || '', password: parsed.password || ''});
    }
    throw new Error(`原生客户端暂不支持认证插件 ${config.authPlugin}，请改用无认证或 token/basic 认证`);
}

function toClientConfig(config: NativeConnectionConfig): ClientConfig {
    const tlsScheme = /^(pulsar\+ssl|ssl):\/\//.test(config.serviceUrl);
    // 隧道把地址换成 127.0.0.1 后，Broker 证书的主机名校验必然失败，而 pulsar-client
    // 的 Node 绑定没有暴露 SNI/服务名覆盖项（只有 tlsValidateHostname 开关），
    // 关掉校验等于放弃 TLS，所以这一组合明确拒绝而不是静默降级。
    if (config.viaLocalForward && tlsScheme) {
        throw new Error(
            '「TLS + 本地转发（SSH 隧道 / K8s 端口转发）」的消息收发不可用：转发把 Broker 地址换成了 127.0.0.1，' +
                '证书主机名校验必然失败，而原生客户端没有可指定 SNI 的参数（管理 API、命名空间与监控走 HTTP，' +
                '不受此限制）。二选一：经转发访问时把 Broker 地址改为 pulsar://（流量已在转发通道内），' +
                '或关闭转发直连 pulsar+ssl://。',
        );
    }
    const clientConfig: ClientConfig = {
        serviceUrl: config.serviceUrl,
        operationTimeoutSeconds: config.operationTimeoutSeconds || 10,
        logLevel: LogLevel.WARN,
    };
    if (config.authPlugin) {
        clientConfig.authentication = buildAuthentication(config);
    }
    if (config.tlsEnabled) {
        if (config.tlsTrustCerts) {
            clientConfig.tlsTrustCertsFilePath = writeTrustCert(config.tlsTrustCerts);
        }
        clientConfig.tlsAllowInsecureConnection = false;
        clientConfig.tlsValidateHostname = true;
    }
    return clientConfig;
}

// 树节点与详情页传进来的 topic 可能已经是完整 URI，再拼一次前缀就会指向不存在的资源。
export function topicFullName(tenant: string, namespace: string, topic: string, persistent: boolean): string {
    const scheme = `${persistent ? 'persistent' : 'non-persistent'}://`;
    if (topic.startsWith(scheme)) {
        return topic;
    }
    if (topic.includes('/')) {
        const [t, n, name] = topic.split('/');
        return `${scheme}${t}/${n}/${name}`;
    }
    return `${scheme}${tenant}/${namespace}/${topic}`;
}

// UI 与 admin REST 用 Key_Shared，原生客户端的枚举拼写是 KeyShared。
const NATIVE_SUBSCRIPTION_TYPES: Record<ConsumeStartParams['subscriptionType'], SubscriptionType> = {
    Exclusive: 'Exclusive',
    Shared: 'Shared',
    Failover: 'Failover',
    Key_Shared: 'KeyShared',
};

// 原生实现的 getProperties() 返回"数组实例 + 具名展开属性"，
// JSON.stringify 得到 []，导出 JSON/CSV 时属性会整列丢失，必须拷成普通对象。
function toPlainProperties(raw: Record<string, string> | undefined): Record<string, string> {
    const plain: Record<string, string> = {};
    if (!raw) {
        return plain;
    }
    for (const key of Object.keys(raw)) {
        plain[key] = String(raw[key]);
    }
    return plain;
}

// 载荷必须是纯 JSON：sandbox 的 preload 收不了原生类实例。
function toRendererMessage(message: NativeMessage): Message {
    return {
        messageId: message.getMessageId().toString(),
        topicName: message.getTopicName(),
        producerName: message.getProducerName(),
        publishTime: message.getPublishTimestamp(),
        eventTime: message.getEventTimestamp(),
        properties: toPlainProperties(message.getProperties()),
        data: message.getData().toString('base64'),
        partitionKey: message.getPartitionKey() || undefined,
        redeliveryCount: message.getRedeliveryCount(),
    };
}

// 攒够一批或攒够时间才推送，避免每条消息一次 IPC
const BATCH_SIZE = 50;
const BATCH_FLUSH_MS = 300;
// 单次 receive 的等待上限：超时是正常空轮询，用来周期性回到循环头检查停止标志
const RECEIVE_TIMEOUT_MS = 2000;
const CLOSE_TIMEOUT_MS = 5000;
// 连续发送被停后要等在途落地，最坏是 sendTimeout（默认 30s）+ 排空与关闭本身。
// 这个预算只给 producer 会话：它等短了，就是在还有 send 在飞时去关原生对象。
const PRODUCER_SETTLE_TIMEOUT_MS = 40_000;
// 集群被删/改配置时等待压测收尾的预算。压测自己等的是 receive(2s)+close(5s)=7s，
// 这里必须留出余量：预算短于它就会在压测还有 in-flight receive 时关原生 Client，
// 那正是注释里记录过的段错误路径。15s 只用于「等它自己结束」，不是正常耗时。
const HOLD_STOP_TIMEOUT_MS = 15_000;
// 单批消息的字节上限。条数上限管不住大报文：50 条 × 几 MB 的 base64 会在一次
// IPC 里序列化出几百 MB，主进程与渲染进程都可能被拖死。
const BATCH_MAX_BYTES = 8 * 1024 * 1024;
// Reader 的空轮询间隔：pulsar-client 1.18 的 readNext(timeout) 在超时真的到期时会段错误
// （实测 readerIdle 两次必崩），所以 Reader 只能先 hasNext() 判断有货、再不带超时地读。
const READER_POLL_MS = 250;
// 「最近 N 条」的回溯扫描：没有尾部锚点，只能从 earliest 逐条读过去、把最后 N 条
// 留在环形缓冲里。扫描量与时长都必须封顶，否则对着存了几百万条的 topic 点一次
// "最近 20 条"就是整 Topic 回放，界面还停在"运行中"看不出在忙什么。
const RECENT_SCAN_MAX_MESSAGES = 20000;
const RECENT_SCAN_MS = 15000;
// 留住的正文按 base64 长度合计封顶：N 条本身有上限，但单条可以是几 MB 的批处理报文，
// 只按条数收会把主进程内存顶穿（推送给界面后还要在渲染进程再存一份）。
const RECENT_SCAN_MAX_BYTES = 8 * 1024 * 1024;
// 连续这么多轮 hasNext() 为假才算追平到尾部：单轮为假可能只是下一块 ledger 还没到，
// 立刻收尾会把最后那几条漏掉。
const RECENT_SCAN_IDLE_ROUNDS = 2;
// 偷看的整体预算：一次 receive 的空轮询是 2 秒，正常路径（有积压）远到不了这里，
// 到得了的都是 broker 半死——那时必须有个数把临时 consumer 收掉，而不是吊死在 IPC 上。
const PEEK_DEADLINE_MS = 15000;
// 停止时要等的是"在途读取落地 + 资源关闭"的整体，而不是只等 close：
// 预算必须覆盖最长的一次空轮询，否则正常等待也会被误判成卡死并提前返回。
const SETTLE_TIMEOUT_MS = RECEIVE_TIMEOUT_MS + CLOSE_TIMEOUT_MS;
// 常驻生产者会话没有读取循环，靠这个驻留循环回到循环头看停止标志，
// 收尾（flush → close → 摘登记 → 上报）因此与消费路径走同一套 runSession。
const SESSION_DWELL_MS = 200;
// 会话总数护栏：每个会话都挂着一个原生 producer/consumer 与 broker 侧的连接，
// 界面上多开几个页签、每个页签再开几个会话就能把主进程的连接数吃穿。
// 32 足够日常用（一屏也摆不下这么多），超了直接拒绝而不是让原生层去扛。
const MAX_SESSIONS = 32;
// 连续发送每轮解析多少条报文。限速是按条等待的，这个值只影响"解析模板"这一步
// 的摊销粒度：太小会让 resolveTemplate 的开销顶到速率前面。
const FLOW_CHUNK = 50;
// 统计推送的最小间隔。逐条过 IPC 会把主进程和渲染进程一起打死在数字上，
// 500ms 一帧足够界面读出速率，也与压测的进度推送同频。
const FLOW_STATS_MS = 500;

// 返回 null 表示"这一轮没有消息"，循环继续；返回消息则计入本批。
type Poll = () => Promise<NativeMessage | null>;

type SessionKind = 'consumer' | 'reader' | 'producer';

// 连续发送一轮的运行时状态。挂在 producer 句柄上而不是单开一张 Map：
// 会话被停、集群被删、退出清理这三条路径都只认 session.close，
// 另立一张表就会出现"会话已经没了、灌报文的循环还在往关闭后的 producer 上 send"。
interface FlowState {
    sessionId: string;
    stopped: boolean;
    // 改速率会换掉这个函数（限速器把下一次放行的时刻记在自己闭包里）
    limiter: () => Promise<void>;
    ratePerSecond: number;
    // 0 = 不限速 / 不限总量
    totalMessages: number;
    maxInFlight: number;
    stopOnError: boolean;
    window: SendWindow;
    latency: ReturnType<typeof createLatencyStats>;
    // 已投出条数按"交给原生 send 的条数"计，broker 确认回来的才进 sent，
    // 两者差的就是还在途的那部分
    issued: number;
    sent: number;
    failed: number;
    bytesSent: number;
    startedAt: number;
    lastStatsAt: number;
    lastStatsSent: number;
    lastStatsBytes: number;
    lastError?: string;
    // 循环整体（含在途排空）；停止与关闭都要等它
    done: Promise<void>;
}

// 常驻 producer 的会话侧状态。flowRunning 是给连续发送（startFlow）留的那一格，
// 单发路径永远读到 false——界面据此把"发送中"的转圈只在真在灌的时候显示。
interface ProducerHandle {
    producer: Producer;
    clusterId: string;
    topicUri: string;
    producerName: string;
    // 建会话时的参数：报文级的路由键/事件时间/延时在每次发送时可被覆盖，
    // 没覆盖就回落到这里，所以这份必须跟着会话留着。
    options: ProducerOptions;
    flowRunning: boolean;
    flow?: FlowState;
    // 点了停止但那一轮还在排空在途发送（broker 半死时每条要等 sendTimeout 才落地）。
    // 这一格为真期间禁止再起新一轮、也禁止关 producer：在途 send 打在关闭中的
    // 原生对象上就是段错误。排空完成后由 runFlow 的 finally 摘掉。
    draining?: boolean;
    // 最近一次统计的快照：停止与断开会话时要把它作为终态推给界面
    lastStats?: ProducerRunStats;
    // flush/close 只能做一次：会话收尾与 runFlow 的 finally 都可能走到这里，
    // 第二次 close 同样是打在已销毁对象上。
    finalized?: boolean;
    // 发起会话的界面实例标识：列表与关闭按它区分同 topic 的多个页签
    ownerId?: string;
}

// 常驻 consumer 的会话侧状态。received 在这里而不是只留在界面：切页签、
// 重开工作台都要能问出"这条订阅的会话收过多少条"，界面自己那份数在卸载时就没了。
// 手动确认会话里未确认消息的登记表上限。原生 Message 对象不能在界面与主进程之间
// 传递（sandbox 只收纯 JSON），确认时只能拿它在主进程的原身，所以按序号登记在这里；
// 批消息里多条的 messageId 字符串可能相同，不能拿它当键。超出上限的新消息不再登记
// （界面标成不可确认），由 broker 的 ackTimeout 重投兜底，而不是偷偷淘汰旧的——
// 淘汰会让"界面显示可确认、主进程说没这条"的谎话出现在最老的几条上。
const MAX_UNACKED_WINDOW = 2000;

interface ConsumerHandle {
    consumer: Consumer;
    clusterId: string;
    topicUri: string;
    subscription: string;
    consumerName?: string;
    subscriptionType: ConsumeStartParams['subscriptionType'];
    autoAck: boolean;
    received: number;
    // seq → 原生 Message；确认/重投成功后从这里摘掉，pendingAcks 就是它的大小
    unacked: Map<number, NativeMessage>;
    nextAckSeq: number;
    // 发起会话的界面实例标识：见 ProducerHandle.ownerId
    ownerId?: string;
}

interface Session {
    id: string;
    clusterId: string;
    key: string;
    kind: SessionKind;
    stopped: boolean;
    close: () => Promise<void>;
    // 循环退出 + 资源关闭 + 上报完成的整体 Promise；停止时等它，
    // 而不是自己去关 consumer——在途读取还没落地就关是崩溃温床。
    settled: Promise<void>;
    // 只有 producer 会话有：摘登记时跟着会话一起消失，不再单开一张 Map
    // （两张表各自清理迟早出现"会话没了、producer 还挂着"的半截状态）。
    producer?: ProducerHandle;
    consumer?: ConsumerHandle;
}

// 一次性 producer 的收尾：flush 把批量队列里剩下的最后一段推出去，再 close。
// withHardTimeout 只保证不卡死、不回报原因，而这里的失败必须能让用户看见——
// 静默吞掉就成了"界面说发完了、broker 里少几条"。所以自己收一次错误文本。
async function closeProducer(producer: Producer): Promise<string | undefined> {
    const work = producer
        .flush()
        .then(() => producer.close())
        .then(() => undefined);
    const outcome = await Promise.race([
        work.then(
            () => null,
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
        sleep(SETTLE_TIMEOUT_MS).then(() => `producer 收尾超时（约 ${Math.round(SETTLE_TIMEOUT_MS / 1000)} 秒）`),
    ]);
    return outcome === null ? undefined : outcome;
}

// 原生客户端的连接参数指纹：隧道重连后本地端口变化，旧 Client 指向已经没人
// 监听的端口，必须重建（admin 侧同理，见 PulsarAdminClientManager）。
function nativeConfigFingerprint(config: NativeConnectionConfig): string {
    return crypto
        .createHash('sha1')
        .update(
            JSON.stringify({
                serviceUrl: config.serviceUrl,
                operationTimeoutSeconds: config.operationTimeoutSeconds,
                authPlugin: config.authPlugin,
                authParams: config.authParams || '',
                tlsEnabled: config.tlsEnabled,
                tlsTrustCerts: config.tlsTrustCerts || '',
                viaLocalForward: config.viaLocalForward,
            }),
        )
        .digest('hex');
}

interface CachedClient {
    client: Client;
    fingerprint: string;
    holds: Set<ClientHold>;
}

// 长任务（压测）与缓存 Client 之间的握手：
// onInvalidate 同步把任务标记为作废，让它的循环立刻退出；
// stop 是真正的收尾（关 producer/consumer），removeCluster 会等它再关客户端。
// stop 必须幂等——用户点停止和配置变更可能同时到达。
export interface ClientHold {
    onInvalidate: () => void;
    stop: () => Promise<void>;
}

export class NativeClientManager {
    private clients = new Map<string, CachedClient>();
    private sessions = new Map<string, Session>();
    // 发消息这类一次性操作只借用缓存 Client 几分钟甚至几毫秒，不值得为它建会话，
    // 但它创建的 producer 同样怕 client.close()——所以登记在这里，让 removeCluster
    // 在关原生 Client 之前先等在途的那几条落地。
    private shortLived = new Map<string, Set<Promise<void>>>();

    private trackShortLived(clusterId: string, op: Promise<unknown>): void {
        let bucket = this.shortLived.get(clusterId);
        if (!bucket) {
            bucket = new Set();
            this.shortLived.set(clusterId, bucket);
        }
        const registry = bucket;
        const tracked = op.then(
            () => registry.delete(tracked),
            () => registry.delete(tracked),
        );
        registry.add(tracked);
    }

    // 等待该集群上全部在途一次性操作。必须带硬超时：发送卡住时不能把
    // 「删除集群」也一起吊死。返回值告诉调用方这些操作是否真的落地——
    // 超时后继续 client.close() 就是 use-after-free，宁可暂时漏掉一个 Client
    // 也不能让原生层崩掉整个主进程。
    private async drainShortLived(clusterId: string): Promise<boolean> {
        const registry = this.shortLived.get(clusterId);
        if (!registry || registry.size === 0) {
            this.shortLived.delete(clusterId);
            return true;
        }
        const settled = await settledWithin(
            Promise.all([...registry]).then(() => undefined),
            SETTLE_TIMEOUT_MS,
        );
        // 只在桶还是同一个、且确实排空时摘掉：集群 id 是 uuid，删除的集群留着空桶
        // 就是永不回收的条目。排水期间新起的发送会落回同一个桶，那种情况不能删。
        if (this.shortLived.get(clusterId) === registry && registry.size === 0) {
            this.shortLived.delete(clusterId);
        }
        return settled;
    }

    // 集群配置变更后必须重建客户端，否则会一直用旧的 serviceUrl / 凭据。
    // 配置变化时先停掉该集群的全部会话再关旧客户端：在还活着的 consumer 下面
    // 关闭原生 Client 是段错误来源。
    async getClient(clusterId: string, config: NativeConnectionConfig): Promise<Client> {
        const fingerprint = nativeConfigFingerprint(config);
        const cached = this.clients.get(clusterId);
        if (cached && cached.fingerprint === fingerprint) {
            return cached.client;
        }
        if (cached) {
            // 指纹变化说明这份 Client 已作废（地址/凭据/隧道端口换过）。此刻还在
            // 它上面跑的压测必须整体重来：继续往即将关闭的 Client 发送只会拿到原生层
            // 的半途错误，测出来的吞吐也不再对应新配置。
            for (const hold of cached.holds) {
                hold.onInvalidate();
            }
            await this.removeCluster(clusterId);
        }
        const client = new Client(toClientConfig(config));
        this.clients.set(clusterId, {client, fingerprint, holds: new Set()});
        return client;
    }

    /**
     * 取原生 Client，并声明"有长任务正跑在它上面"（压测用）。
     *
     * 需要这个握手的原因是：删集群或改配置会走到 removeCluster → client.close()，
     * 而此时压测的 producer/consumer 还活着，原生层就是 use-after-free（实测段错误）。
     * 登记的 hold 让 removeCluster 先作废并停掉这些任务，再关客户端。
     *
     * 返回 null 表示拿到的 Client 在这一瞬间已经被换掉，调用方应当报错重试，
     * 不能继续用返回的旧对象。释放函数必须在任务收尾时调用。
     */
    async retain(
        clusterId: string,
        config: NativeConnectionConfig,
        hold: ClientHold,
    ): Promise<{client: Client; release: () => void} | null> {
        const client = await this.getClient(clusterId, config);
        const cached = this.clients.get(clusterId);
        if (!cached || cached.client !== client) {
            return null;
        }
        cached.holds.add(hold);
        let released = false;
        return {
            client,
            release: () => {
                if (released) {
                    return;
                }
                released = true;
                this.clients.get(clusterId)?.holds.delete(hold);
            },
        };
    }

    private async stopSession(session: Session): Promise<void> {
        session.stopped = true;
        this.sessions.delete(session.id);
        // 让循环自己收尾（它会等这次读取落地后再关资源）。直接 close 会把在途的
        // receive/readNext 打在已销毁的原生对象上——Reader 那条路径实测是段错误。
        // producer 会话的预算要另给：它的收尾包含连续发送在途 send 的排空，
        // 最坏要等满 sendTimeout，用消费侧那 7 秒会把排空中途截断。
        const settleBudget = session.kind === 'producer' ? PRODUCER_SETTLE_TIMEOUT_MS : SETTLE_TIMEOUT_MS;
        await withHardTimeout(session.settled, `session ${session.id} did not settle`, settleBudget);
    }

    // 关闭该集群上的全部会话并释放客户端（集群被删除或改配置时调用）。
    // 缓存的移除发生在第一个 await 之前，所以调用方可以不等它完成，
    // 后续请求也不会拿到旧客户端。
    async removeCluster(clusterId: string): Promise<void> {
        const cached = this.clients.get(clusterId);
        this.clients.delete(clusterId);
        const targets = [...this.sessions.values()].filter(session => session.clusterId === clusterId);
        const holds = cached ? [...cached.holds] : [];
        // 压测之类挂在客户端上的长任务先作废、再等它自己关资源，最后才关原生 Client
        holds.forEach(hold => hold.onInvalidate());
        await Promise.all(targets.map(session => this.stopSession(session)));
        // stop 可能超时，必须知道它到底有没有落地；超时后关 Client 就是段错误。
        const [holdSettled, shortLivedSettled] = await Promise.all([
            Promise.all(holds.map(hold => settledWithin(hold.stop(), HOLD_STOP_TIMEOUT_MS))),
            this.drainShortLived(clusterId),
        ]);
        if (cached) {
            if (!shortLivedSettled || !holdSettled.every(Boolean)) {
                // 这里刻意不 close：底层 native 对象可能还在被 in-flight 调用使用。
                // 泄漏一个已经摘出缓存的 Client，比让整个主进程段错误可接受。
                log.error(`client ${clusterId} not closed: in-flight native work did not settle in time`);
            } else {
                await withHardTimeout(
                    cached.client.close().then(() => undefined),
                    `client ${clusterId} close failed`,
                );
            }
        }
    }

    async clear(): Promise<void> {
        const clusterIds = [...this.clients.keys()];
        await Promise.all(clusterIds.map(clusterId => this.removeCluster(clusterId)));
    }

    async send(
        clusterId: string,
        config: NativeConnectionConfig,
        params: {
            tenant: string;
            namespace: string;
            topic: string;
            persistent: boolean;
            message: string;
            properties?: Record<string, string>;
            options?: ProducerMessageOptions;
        },
    ): Promise<{messageId: string}> {
        const topic = topicFullName(params.tenant, params.namespace, params.topic, params.persistent);
        const client = await this.getClient(clusterId, config);
        const work = (async (): Promise<{messageId: string}> => {
            const producer: Producer = await client.createProducer({topic});
            try {
                // applyOptions 会解析 from 字段里的 JSON，解析失败是用户输入错误，
                // 但它发生在 producer 已经创建之后：必须在 try 内，否则 finally
                // 不会执行，原生 producer 会一直挂着。
                const item: OutboundMessage = {
                    sourceIndex: 0,
                    body: params.message,
                    bytes: Buffer.byteLength(params.message, 'utf8'),
                    properties: params.properties,
                };
                applyOptions(item, params.options ?? {});
                const messageId = await producer.send(toProducerMessage(item));
                return {messageId: messageId.toString()};
            } finally {
                await withHardTimeout(
                    producer.close().then(() => undefined),
                    'producer close failed',
                );
            }
        })();
        // 登记必须在 await 之前：从 createProducer 到 close 之间如果集群被删或改配置，
        // removeCluster 会直接 client.close()，而原生层在还挂着的 producer 下面关
        // Client 就是段错误——和压测那条路径完全同一类，只是窗口更短更难复现。
        this.trackShortLived(clusterId, work);
        return work;
    }

    // 会话占用登记。两种模式的区别是真实的原生语义，不是偏好：
    // - exclusive：同一个订阅只允许一个消费者。两个 Exclusive 订阅的连接会互相踢下线，
    //   Shared 下则会各自分到一半消息，两边都表现为"消息时隐时现"，比直接拒绝更难排查。
    // - parallel：reader 与 producer 之间不存在抢占（reader 不落订阅，producer 各投各的），
    //   键追加会话 id 保证互不相同，同一 topic 开多个生产者因此是允许的。
    private reserveSession(clusterId: string, key: string, kind: SessionKind, mode: 'exclusive' | 'parallel'): Session {
        if (this.sessions.size >= MAX_SESSIONS) {
            throw new Error(`同时最多 ${MAX_SESSIONS} 个收发会话，请先停止一些再开`);
        }
        // uuid 而不是自计数：自计数会重复出现在"渲染层还握着上一个进程的 s1"
        // 这类场景里，停错会话比停不到更难排查
        const id = crypto.randomUUID();
        const sessionKey = mode === 'parallel' ? `${key}#${id}` : key;
        if (mode === 'exclusive' && [...this.sessions.values()].some(session => session.key === sessionKey)) {
            throw new Error('该订阅已有正在运行的会话，请先停止');
        }
        const session: Session = {
            id,
            clusterId,
            key: sessionKey,
            kind,
            stopped: false,
            close: async () => undefined,
            settled: Promise.resolve(),
        };
        this.sessions.set(session.id, session);
        return session;
    }

    // 常驻会话的驻留循环：生产者会话不读消息，只需要一个能周期检查停止标志的循环，
    // 好让停止时 runSession 的收尾与消费路径完全同一条（否则 producer 的关闭时机
    // 就得由每个调用方自己保证，而漏掉一处就是在还活着的 producer 下面关 Client）。
    private async dwell(session: Session): Promise<void> {
        while (!session.stopped) {
            await sleep(SESSION_DWELL_MS);
        }
    }

    // 会话 id → 常驻 producer。取不到就明确报错而不是静默新建：静默重建会让
    // 用户以为消息发进了同一个 producer（连接、producerName 都变），实际不是。
    private producerHandle(sessionId: string): ProducerHandle {
        const session = this.sessions.get(sessionId);
        if (!session || session.kind !== 'producer' || session.stopped) {
            throw new Error('生产者会话不存在或已停止，请重新建立连接');
        }
        const handle = session.producer;
        if (!handle) {
            throw new Error('生产者会话状态不完整，请停止后重建');
        }
        return handle;
    }

    // 会话的建立参数。IPC 层在解析报文前拿它做回落，所以真相只有一份：
    // 会话上的 producer 就是按这份参数建出来的。
    producerDefaults(sessionId: string): ProducerOptions {
        return this.producerHandle(sessionId).options;
    }

    // 顺序轮询，不用原生 listener：listener 回调无法背压，
    // 也无法在停止时确定"最后一个回调已经跑完"。
    private async pump(
        session: Session,
        poll: Poll,
        afterMessage: ((message: NativeMessage) => Promise<void>) | undefined,
        maxMessages: number,
        emit: (batch: MessageBatch) => void,
        decorate?: (message: NativeMessage, rendered: Message) => void,
    ): Promise<void> {
        let buffer: Message[] = [];
        let bufferBytes = 0;
        let delivered = 0;
        let lastFlush = Date.now();

        const flush = () => {
            if (buffer.length === 0) {
                return;
            }
            emit({sessionId: session.id, messages: buffer});
            buffer = [];
            bufferBytes = 0;
            lastFlush = Date.now();
        };

        try {
            while (!session.stopped && (maxMessages === 0 || delivered < maxMessages)) {
                const message = await poll();
                if (!message) {
                    // 空轮询：poll 内部已经等过时间，这里只把攒着的批次推出去
                    flush();
                    continue;
                }
                if (afterMessage) {
                    await afterMessage(message);
                }
                const rendered = toRendererMessage(message);
                if (decorate) {
                    decorate(message, rendered);
                }
                buffer.push(rendered);
                bufferBytes += Buffer.byteLength(rendered.data ?? '', 'utf8');
                delivered += 1;
                if (
                    buffer.length >= BATCH_SIZE ||
                    bufferBytes >= BATCH_MAX_BYTES ||
                    Date.now() - lastFlush >= BATCH_FLUSH_MS
                ) {
                    flush();
                }
            }
        } catch (error) {
            if (session.stopped) {
                // 停止过程中资源已不可用，读取抛错属预期终止，不是故障
                return;
            }
            log.error(`session ${session.id} failed`, error instanceof Error ? error.message : error);
            throw error;
        } finally {
            flush();
        }
    }

    // 循环结束后统一收尾：关资源、摘登记、把终止原因推给调用方，
    // 并把整个过程作为 session.settled 暴露出去，停止时等的是它而不是一个裸 close。
    // outcome 给一次性会话（「最近 N 条」的扫描）留的口子：循环里往里写一句人话，
    // 收尾时带进会话结束事件，界面才说得清"是扫完了、还是撞到护栏停了"。
    private runSession(
        session: Session,
        loop: Promise<void>,
        onEnd: (event: SessionEndEvent) => void,
        outcome: {detail?: string} = {},
    ): void {
        const settle = (error?: unknown) =>
            withHardTimeout(session.close(), `session ${session.id} close failed`).then(() => {
                this.sessions.delete(session.id);
                onEnd(
                    error
                        ? {
                              sessionId: session.id,
                              reason: 'error',
                              detail: error instanceof Error ? error.message : String(error),
                          }
                        : {
                              sessionId: session.id,
                              reason: session.stopped ? 'stopped' : 'completed',
                              detail: outcome.detail,
                          },
                );
            });
        // 两个分支都消费掉结果，循环里的异常因此不会变成未处理拒绝
        session.settled = loop.then(settle, settle);
    }

    async startConsume(
        clusterId: string,
        config: NativeConnectionConfig,
        params: ConsumeStartParams,
        emit: (batch: MessageBatch) => void,
        onEnd: (event: SessionEndEvent) => void,
    ): Promise<{sessionId: string}> {
        const topic = topicFullName(params.tenant, params.namespace, params.topic, params.persistent);
        // Exclusive 的抢占是真的：两个 Exclusive 消费者会互相踢下线，界面上表现为
        // 消息时隐时现，所以这种类型继续按订阅排他。其余三种原生就允许多消费者
        // 同订阅（Shared 分摊、Failover 主备、Key_Shared 按 key 分片），工作台
        // 因此可以对着同一个订阅再开一条会话做对比，不再被"已有会话"挡在外面。
        const mode = params.subscriptionType === 'Exclusive' ? 'exclusive' : 'parallel';
        const session = this.reserveSession(
            clusterId,
            `${clusterId}|${topic}|${params.subscription}`,
            'consumer',
            mode,
        );
        let client: Client;
        try {
            client = await this.getClient(clusterId, config);
        } catch (error) {
            // 会话槽先于连接建立登记：连接失败不摘掉的话，32 个槽位会被
            // 一串连不上的重试永久占满，用户只能重启应用。
            this.sessions.delete(session.id);
            throw error;
        }

        let consumer: Consumer;
        try {
            consumer = await client.subscribe(
                buildConsumerConfig(topic, {
                    subscription: params.subscription,
                    subscriptionType: NATIVE_SUBSCRIPTION_TYPES[params.subscriptionType],
                    initialPosition: params.initialPosition,
                    receiverQueueSize: params.receiverQueueSize,
                    ackTimeoutMs: params.ackTimeoutMs,
                    nAckRedeliverTimeoutMs: params.nAckRedeliverTimeoutMs,
                    consumerName: params.consumerName,
                    deadLetter: params.deadLetter,
                }),
            );
        } catch (error) {
            this.sessions.delete(session.id);
            throw error;
        }
        const handle: ConsumerHandle = {
            consumer,
            clusterId,
            topicUri: topic,
            subscription: params.subscription,
            subscriptionType: params.subscriptionType,
            autoAck: params.autoAck,
            received: 0,
            unacked: new Map(),
            nextAckSeq: 1,
        };
        if (params.consumerName) {
            handle.consumerName = params.consumerName;
        }
        if (params.ownerId) {
            handle.ownerId = params.ownerId;
        }
        session.consumer = handle;
        session.close = async () => {
            await consumer.close();
        };

        this.runSession(
            session,
            this.pump(
                session,
                async () => {
                    try {
                        return await consumer.receive(RECEIVE_TIMEOUT_MS);
                    } catch (error) {
                        // 原生客户端把"这段时间没有消息"作为 Timeout 异常抛出，属正常空轮询
                        if (isTimeoutError(error)) {
                            return null;
                        }
                        throw error;
                    }
                },
                async (message: NativeMessage) => {
                    handle.received += 1;
                    if (params.autoAck) {
                        await consumer.acknowledge(message);
                    }
                },
                params.maxMessages ?? 0,
                emit,
                // 手动确认：每条都在登记表里占一个序号，界面按这个序号发确认/重投。
                // 登记与序号分配都发生在推送之前，界面拿到批次时登记表必然已经就位。
                params.autoAck
                    ? undefined
                    : (message: NativeMessage, rendered: Message) => {
                          const seq = handle.nextAckSeq;
                          handle.nextAckSeq += 1;
                          rendered.ackSeq = seq;
                          if (handle.unacked.size < MAX_UNACKED_WINDOW) {
                              handle.unacked.set(seq, message);
                              rendered.ackable = true;
                              rendered.messageIdBytes = message.getMessageId().serialize().toString('base64');
                          } else {
                              rendered.ackable = false;
                          }
                      },
            ),
            onEnd,
        );

        return {sessionId: session.id};
    }

    async startRead(
        clusterId: string,
        config: NativeConnectionConfig,
        params: ReadStartParams,
        emit: (batch: MessageBatch) => void,
        onEnd: (event: SessionEndEvent) => void,
    ): Promise<{sessionId: string}> {
        const topic = topicFullName(params.tenant, params.namespace, params.topic, params.persistent);
        // seek 参数缺失必须在创建 Reader 之前拒绝：否则 seek 不执行，会话会
        // 从 earliest 一路回放，且 catch 里已分配的 Reader 不会被关。
        if (params.from === 'timestamp' && !params.timestamp) {
            throw new Error('按时间读取需要指定 timestamp');
        }
        if (params.from === 'messageId' && !params.messageId) {
            throw new Error('按 Message ID 定位需要指定 messageId');
        }
        const seekTimestamp = params.from === 'timestamp' ? params.timestamp : undefined;
        const session = this.reserveSession(
            clusterId,
            `${clusterId}|${topic}|reader|${params.from}`,
            'reader',
            'parallel',
        );
        let client: Client;
        try {
            client = await this.getClient(clusterId, config);
        } catch (error) {
            this.sessions.delete(session.id);
            throw error;
        }

        let reader: Reader | undefined;
        try {
            reader = await client.createReader({
                topic,
                // recent 走 earliest：尾部锚点不存在，回溯扫描必须从头扫
                startMessageId: params.from === 'latest' ? MessageId.latest() : MessageId.earliest(),
            });
            if (seekTimestamp) {
                await reader.seekTimestamp(seekTimestamp);
            }
        } catch (error) {
            // reader 已经创建后再失败（典型是 seek 时网络断了）也必须关掉，
            // 否则原生对象留在缓存 Client 上，重连后仍占资源。
            if (reader) {
                await withHardTimeout(
                    reader.close().then(() => undefined),
                    'reader close after failed start',
                );
            }
            this.sessions.delete(session.id);
            throw error;
        }
        session.close = async () => {
            await reader.close();
        };

        if (params.from === 'recent') {
            const outcome: {detail?: string} = {};
            this.runSession(
                session,
                this.scanRecent(session, reader, params.recentCount ?? 20, emit, outcome),
                onEnd,
                outcome,
            );
            return {sessionId: session.id};
        }

        // 按 Message ID 定位：原生没有 MessageId.fromString、broker 没有按 id 取消息的
        // REST 路由（Admin API 的 Examine 只到游标不到内容），唯一的办法是从 earliest
        // 逐条比对 id 字符串。扫到过的那条就发一批并结束，扫完没到就靠 outcome 说明。
        if (params.from === 'messageId') {
            const outcome: {detail?: string} = {};
            this.runSession(
                session,
                this.scanLocate(session, reader, params.messageId as string, emit, outcome),
                onEnd,
                outcome,
            );
            return {sessionId: session.id};
        }

        this.runSession(
            session,
            this.pump(
                session,
                async () => {
                    // readNext(timeout) 超时到期会段错误，只能先 hasNext() 判断有货再裸读
                    if (!reader.hasNext()) {
                        await sleep(READER_POLL_MS);
                        return null;
                    }
                    return reader.readNext();
                },
                undefined,
                params.maxMessages ?? 0,
                emit,
            ),
            onEnd,
        );

        return {sessionId: session.id};
    }

    /**
     * 从 earliest 扫到尾部，只留最后 count 条，一次性推给界面后结束会话。
     *
     * 为什么不"倒着读"：pulsar-client 1.18 的 Reader 只有正向游标，broker 侧也没有
     * lastMessageId 的 REST 路由（这台的 admin 连 send/peek 都没有），所以拿"最近 N 条"
     * 只能靠扫描。护栏撞到哪个都在 outcome 里写清楚，不然界面只显 N 条，人会以为
     * Topic 就这么多消息。
     */
    private async scanRecent(
        session: Session,
        reader: Reader,
        count: number,
        emit: (batch: MessageBatch) => void,
        outcome: {detail?: string},
    ): Promise<void> {
        const kept: Message[] = [];
        let keptBytes = 0;
        let scanned = 0;
        let idleRounds = 0;
        const deadline = Date.now() + RECENT_SCAN_MS;
        let stoppedByGuard = '';

        try {
            while (!session.stopped) {
                if (reader.hasNext()) {
                    const message = await reader.readNext();
                    scanned += 1;
                    idleRounds = 0;
                    const rendered = toRendererMessage(message);
                    kept.push(rendered);
                    keptBytes += rendered.data.length;
                    while (kept.length > count || (keptBytes > RECENT_SCAN_MAX_BYTES && kept.length > 1)) {
                        const dropped = kept.shift();
                        keptBytes -= dropped ? dropped.data.length : 0;
                    }
                    if (scanned >= RECENT_SCAN_MAX_MESSAGES) {
                        stoppedByGuard = `已扫描 ${scanned} 条到达上限，留下的可能不是真正的尾部`;
                        break;
                    }
                    if (Date.now() >= deadline) {
                        stoppedByGuard = `扫描超过 ${Math.round(RECENT_SCAN_MS / 1000)} 秒已停止，留下的可能不是真正的尾部`;
                        break;
                    }
                    continue;
                }
                idleRounds += 1;
                if (idleRounds >= RECENT_SCAN_IDLE_ROUNDS) {
                    break;
                }
                await sleep(READER_POLL_MS);
            }
        } catch (error) {
            if (!session.stopped) {
                throw error;
            }
            return;
        }

        if (session.stopped) {
            return;
        }
        if (kept.length > 0) {
            emit({sessionId: session.id, messages: kept});
        }
        outcome.detail = stoppedByGuard
            ? `回溯扫描结束：扫过 ${scanned} 条，取最近 ${kept.length} 条。${stoppedByGuard}`
            : kept.length > 0
              ? `回溯扫描结束：扫过 ${scanned} 条，取最近 ${kept.length} 条`
              : '回溯扫描结束：这个 topic 上没有消息';
    }

    /**
     * 从 earliest 逐条比对 Message ID，扫到目标即推一条并结束会话。
     * 护栏与回溯扫描同一套：撞护栏不是错误，是"这个 id 在这段扫描范围里没出现"，
     * 结论必须写进 outcome 让界面说得出"扫过多少、为什么停"，否则读起来和"没找到=没有这条"没法区分。
     */
    private async scanLocate(
        session: Session,
        reader: Reader,
        targetId: string,
        emit: (batch: MessageBatch) => void,
        outcome: {detail?: string},
    ): Promise<void> {
        let scanned = 0;
        let idleRounds = 0;
        const deadline = Date.now() + RECENT_SCAN_MS;
        let found: Message | undefined;
        let stoppedByGuard = '';

        try {
            while (!session.stopped) {
                if (reader.hasNext()) {
                    const message = await reader.readNext();
                    scanned += 1;
                    idleRounds = 0;
                    const rendered = toRendererMessage(message);
                    if (rendered.messageId === targetId) {
                        found = rendered;
                        break;
                    }
                    if (scanned >= RECENT_SCAN_MAX_MESSAGES) {
                        stoppedByGuard = `已扫描 ${scanned} 条到达上限`;
                        break;
                    }
                    if (Date.now() >= deadline) {
                        stoppedByGuard = `扫描超过 ${Math.round(RECENT_SCAN_MS / 1000)} 秒已停止`;
                        break;
                    }
                    continue;
                }
                idleRounds += 1;
                if (idleRounds >= RECENT_SCAN_IDLE_ROUNDS) {
                    break;
                }
                await sleep(READER_POLL_MS);
            }
        } catch (error) {
            if (!session.stopped) {
                throw error;
            }
            return;
        }

        if (session.stopped) {
            return;
        }
        if (found) {
            emit({sessionId: session.id, messages: [found]});
            outcome.detail = `定位成功：扫过 ${scanned} 条找到该 Message ID`;
        } else {
            outcome.detail = stoppedByGuard
                ? `未找到该 Message ID。${stoppedByGuard}，目标可能在更靠后的位置`
                : `扫描 ${scanned} 条未找到该 Message ID：它可能已被回溯删除，或不属于这个 topic`;
        }
    }

    /**
     * 建立常驻生产者会话。
     *
     * 之所以要常驻而不是每条现开现关：单发路径的耗时几乎全在 createProducer 的
     * 元数据握手与 close 的收尾上，报文本身几十字节反而不是大头。工作台"发一条
     * 试试"和连续发送都要复用同一条 producer，界面上看到的速率才有意义。
     */
    async startProducer(
        clusterId: string,
        config: NativeConnectionConfig,
        params: {
            tenant: string;
            namespace: string;
            topic: string;
            persistent: boolean;
            options: ProducerOptions;
            // 发起会话的界面实例标识：列表与关闭按它区分同 topic 的多个页签
            ownerId?: string;
        },
        onEnd: (event: SessionEndEvent) => void,
    ): Promise<ProducerSessionInfo> {
        const topic = topicFullName(params.tenant, params.namespace, params.topic, params.persistent);
        const session = this.reserveSession(clusterId, `${clusterId}|${topic}|producer`, 'producer', 'parallel');
        let client: Client;
        try {
            client = await this.getClient(clusterId, config);
        } catch (error) {
            this.sessions.delete(session.id);
            throw error;
        }

        let producer: Producer;
        try {
            producer = await client.createProducer(buildProducerConfig(topic, params.options));
        } catch (error) {
            this.sessions.delete(session.id);
            throw error;
        }
        // 用原生返回的名字而不是只认用户填的：没填时 broker 侧那条 producer 仍然有名字，
        // 界面显示的是 broker 上真实存在的标识，而不是我们起的另一个。
        const producerName = producer.getProducerName() || params.options.producerName || `producer-${session.id}`;
        const handle: ProducerHandle = {
            producer,
            clusterId,
            topicUri: topic,
            producerName,
            options: params.options,
            flowRunning: false,
        };
        if (params.ownerId) {
            handle.ownerId = params.ownerId;
        }
        session.producer = handle;
        // 顺序不能反两处：一是连续发送还在灌的时候先 close，等于把 send 打在已销毁的
        // 原生对象上（实测段错误），所以先停循环并排空在途；二是批量模式下最后一段
        // 还压在原生队列里，先 close 就是把它丢掉，因此 flush 在 close 之前。
        session.close = async () => {
            // 顺序不能反两处：一是连续发送还在灌的时候先 close，等于把 send 打在已销毁的
            // 原生对象上（实测段错误），所以先停循环并排空在途；二是批量模式下最后一段
            // 还压在原生队列里，先 close 就是把它丢掉，因此 flush 在 close 之前。
            // 排空没在预算内落地时把 producer 暂时留着，由 runFlow 的 finally 在消息
            // 真落地后补关——抢时机 close 就是那条已知的段错误路径。
            const drained = await this.endFlow(handle);
            if (!drained && handle.draining) {
                return;
            }
            await this.finalizeProducer(handle);
        };

        this.runSession(session, this.dwell(session), onEnd);

        return this.producerInfo(session.id, handle);
    }

    // 逐条发送、逐条记账。整批中断是最没用的行为：一批里往往是某一条超过单条上限
    // 或取不到字段，剩下的照发，界面把失败的那几条单列出来。
    // aborted 由调用方决定"这条 producer 还算不算数"：常驻会话被停掉时剩下的每条
    // 都会抛同一个原生错误，一次性发送则没有这种中途作废。
    private async sendWith(
        producer: Producer,
        items: OutboundMessage[],
        aborted: () => boolean,
    ): Promise<ProducerSendResult> {
        const result: ProducerSendResult = {messageIds: [], bytes: 0, failures: []};
        for (let index = 0; index < items.length; index += 1) {
            const item = items[index];
            try {
                const messageId = await producer.send(toProducerMessage(item));
                result.messageIds.push(messageId.toString());
                result.bytes += item.bytes;
            } catch (error) {
                // 报的是这条消息在批次里的原始序号（不是 items 的下标）：解析阶段
                // 就失败的那几条不在 items 里，两边共用一套序号才对得上。
                if (aborted()) {
                    for (let rest = index; rest < items.length; rest += 1) {
                        result.failures.push({index: items[rest].sourceIndex, error: '会话已停止，本条未发送'});
                    }
                    break;
                }
                const detail = error instanceof Error ? error.message : String(error);
                result.failures.push({index: item.sourceIndex, error: detail});
            }
        }
        return result;
    }

    async sendThroughSession(
        sessionId: string,
        expected: {clusterId: string; topicUri: string},
        template: MessageTemplateBody,
        count: number,
        options: ProducerMessageOptions,
    ): Promise<ProducerSendResult> {
        const handle = this.producerHandle(sessionId);
        // 会话的 producer 是在建会话时按 cluster/topic 建好的；请求里再带一份坐标
        // 只会制造"消息发到 A、审计/历史记到 B"的错位。对不上就拒绝，不猜。
        if (handle.clusterId !== expected.clusterId || handle.topicUri !== expected.topicUri) {
            throw new Error(
                `会话 ${sessionId} 属于 ${handle.topicUri}（集群 ${handle.clusterId}），` +
                    `与本次请求的 ${expected.topicUri}（集群 ${expected.clusterId}）不一致，请重新建立会话`,
            );
        }
        return this.sendChunks(handle.producer, {template, count, options}, () => !this.sessions.has(sessionId));
    }

    // 解析一批发一批。一次性把 count 条全解出来，最坏就是 1000 × 5MB 的正文同时
    // 在主进程里活着；逐批"解析→发送→释放"后同时只有一批（预算见 producer-send）。
    // 序号跨批连续传递，所以 seq() 与界面说的"第几条"都不受影响。
    private async sendChunks(
        producer: Producer,
        plan: {template: MessageTemplateBody; count: number; options: ProducerMessageOptions},
        aborted: () => boolean,
    ): Promise<ProducerSendResult> {
        const result: ProducerSendResult = {messageIds: [], bytes: 0, failures: []};
        for (let issued = 0; issued < plan.count;) {
            const batch = resolveBatch(plan.template, plan.count - issued, plan.options, issued);
            issued += batch.consumed;
            result.failures.push(...batch.failures);
            if (batch.items.length === 0) {
                continue;
            }
            const sent = await this.sendWith(producer, batch.items, aborted);
            result.messageIds.push(...sent.messageIds);
            result.failures.push(...sent.failures);
            result.bytes += sent.bytes;
            if (aborted()) {
                // 会话中途没了：还没解析的那些条同样没发出去，一并如实记账
                for (let index = issued; index < plan.count; index += 1) {
                    result.failures.push({index, error: '会话已停止，本条未发送'});
                }
                break;
            }
        }
        result.failures.sort((a, b) => a.index - b.index);
        return result;
    }

    // 批量模式下把还压在队列里的最后一段立刻走完。发送返回的 messageIds 本身已经
    // 代表 broker 收下了，这里给的是"我现在就要去对面核对"的手动一步。
    async flushSession(sessionId: string): Promise<void> {
        await this.producerHandle(sessionId).producer.flush();
    }

    // ========== 连续发送（flow） ==========

    // 会话快照。producerName 取原生返回的那个，界面显示的必须与 broker 侧一致。
    private producerInfo(sessionId: string, handle: ProducerHandle): ProducerSessionInfo {
        const info: ProducerSessionInfo = {
            sessionId,
            clusterId: handle.clusterId,
            topicUri: handle.topicUri,
            producerName: handle.producerName,
            connected: handle.producer.isConnected(),
            flowRunning: handle.flowRunning,
        };
        if (handle.ownerId) {
            info.ownerId = handle.ownerId;
        }
        return info;
    }

    // 速率按"上一次推送到现在"这段窗口算，不用整轮平均：用户中途改速率、
    // broker 开始限流，都会被整轮平均抹成一条看不出变化的直线。
    private flowStats(handle: ProducerHandle, flow: FlowState, running: boolean, error?: string): ProducerRunStats {
        const now = Date.now();
        const sinceMs = Math.max(1, now - flow.lastStatsAt);
        const stats: ProducerRunStats = {
            sessionId: flow.sessionId,
            sent: flow.sent,
            failed: flow.failed,
            bytesSent: flow.bytesSent,
            elapsedMs: now - flow.startedAt,
            msgPerSec: round2(((flow.sent - flow.lastStatsSent) / sinceMs) * 1000),
            mbPerSec: round4(((flow.bytesSent - flow.lastStatsBytes) * 1000) / sinceMs / (1024 * 1024)),
            latency: flow.latency.summarize(),
            flowRunning: running,
        };
        if (flow.lastError) {
            stats.lastError = flow.lastError;
        }
        if (error) {
            stats.error = error;
        }
        handle.lastStats = stats;
        return stats;
    }

    private pushFlowStats(
        handle: ProducerHandle,
        flow: FlowState,
        emit: (stats: ProducerRunStats) => void,
        force = false,
    ): void {
        if (!force && Date.now() - flow.lastStatsAt < FLOW_STATS_MS) {
            return;
        }
        const stats = this.flowStats(handle, flow, true);
        flow.lastStatsAt = Date.now();
        flow.lastStatsSent = flow.sent;
        flow.lastStatsBytes = flow.bytesSent;
        emit(stats);
    }

    // 停掉这一轮的连续发送并等在途落地。会话收尾（close 前）与界面点停止都走这里。
    // 返回 false 表示"停止请求已发出但还没排空"——调用方绝不能在此之后去 close
    // producer（在途 send 打在关闭中的原生对象上就是段错误），排空完成后
    // runFlow 的 finally 会自己把 producer 收掉。
    private async endFlow(handle: ProducerHandle): Promise<boolean> {
        const flow = handle.flow;
        if (!flow) {
            // 上一轮已经由 runFlow 的 finally 摘掉；这里顺手清掉可能残留的排空标记，
            // 否则一次超时会把这个会话永久锁在「上一轮还在排空」上。
            handle.draining = false;
            return true;
        }
        flow.stopped = true;
        if (handle.draining) {
            // 已有一次排空在等：不重复计时，直接告诉调用方"还没落地"
            return false;
        }
        handle.draining = true;
        const settled = await settledWithin(
            flow.done.then(
                () => true,
                () => false,
            ),
            CLOSE_TIMEOUT_MS,
        );
        if (!settled) {
            return false;
        }
        handle.flowRunning = false;
        handle.draining = false;
        return true;
    }

    // flush → close，且整个会话周期里只生效一次。
    private async finalizeProducer(handle: ProducerHandle): Promise<void> {
        if (handle.finalized) {
            return;
        }
        handle.finalized = true;
        // 批量模式下最后一段还压在原生队列里，先 close 就是把它丢掉，因此 flush 在前。
        // flush 失败（连接已断/正在停）时 close 照做，否则留着一个关不掉的 producer；
        // 但失败必须留下日志——否则「界面显示已发送、broker 没收到」没有任何线索。
        await handle.producer.flush().catch(error => {
            const detail = error instanceof Error ? error.message : String(error);
            log.warn(`producer ${handle.producerName} flush failed before close`, detail);
        });
        await handle.producer.close().catch(error => {
            log.warn(`producer ${handle.producerName} close failed`, error instanceof Error ? error.message : error);
        });
    }

    async startFlow(
        sessionId: string,
        params: ProducerFlowParams,
        emit: (stats: ProducerRunStats) => void,
    ): Promise<ProducerSessionInfo> {
        const session = this.sessions.get(sessionId);
        const handle = session?.producer;
        if (!session || !handle || session.stopped) {
            throw new Error('生产者会话不存在或已停止，请重新建立连接');
        }
        if (handle.flowRunning) {
            throw new Error('这条会话已经有一轮连续发送在跑，先停掉它');
        }
        if (handle.draining || handle.flow) {
            // 上一轮点了停止但在途还没落地：此时再起一轮，两拨 send 会同时打在
            // 同一个原生 producer 上，停止与统计也再也对不上号。
            throw new Error('上一轮连续发送还在排空在途消息，请等它落地后再启动');
        }
        const options = messageOptions(handle.options, params.options);
        const flow: FlowState = {
            sessionId,
            stopped: false,
            limiter: createRateLimiter(params.ratePerSecond),
            ratePerSecond: params.ratePerSecond,
            totalMessages: params.totalMessages,
            maxInFlight: params.maxInFlight,
            stopOnError: params.stopOnError,
            window: new SendWindow(params.maxInFlight),
            latency: createLatencyStats(),
            issued: 0,
            sent: 0,
            failed: 0,
            bytesSent: 0,
            startedAt: Date.now(),
            lastStatsAt: Date.now(),
            lastStatsSent: 0,
            lastStatsBytes: 0,
            done: Promise.resolve(),
        };
        handle.flow = flow;
        handle.flowRunning = true;
        handle.lastStats = undefined;
        flow.done = this.runFlow(session, handle, flow, params.template, options, emit);
        // 循环内部的异常都在这条链上收掉，否则停止时没人 await 就成未处理拒绝
        flow.done.catch(() => undefined);
        return this.producerInfo(sessionId, handle);
    }

    private async runFlow(
        session: Session,
        handle: ProducerHandle,
        flow: FlowState,
        template: ProducerFlowParams['template'],
        options: ReturnType<typeof messageOptions>,
        emit: (stats: ProducerRunStats) => void,
    ): Promise<void> {
        let endError: string | undefined;
        try {
            while (
                !flow.stopped &&
                !session.stopped &&
                (flow.totalMessages === 0 || flow.issued < flow.totalMessages)
            ) {
                const want =
                    flow.totalMessages === 0 ? FLOW_CHUNK : Math.min(FLOW_CHUNK, flow.totalMessages - flow.issued);
                const batch = resolveBatch(template, want, options, flow.issued);
                // 只推进真正解析过的那几条（字节预算可能让这一批提前收口），
                // 按 want 推进会把没解的序号直接跳过，seq() 就断号了。
                flow.issued += batch.consumed;
                flow.failed += batch.failures.length;
                if (batch.items.length === 0) {
                    // 整批都解析不出来：继续只是把失败数往上刷，模板本身不会自己修好
                    endError = batch.failures[0]?.error ?? '模板解析失败';
                    flow.lastError = endError;
                    break;
                }
                for (const item of batch.items) {
                    await flow.limiter();
                    if (flow.stopped || session.stopped) {
                        break;
                    }
                    await flow.window.waitForSlot();
                    const startedAt = performance.now();
                    flow.window.track(
                        handle.producer.send(toProducerMessage(item)).then(
                            () => {
                                flow.sent += 1;
                                flow.bytesSent += item.bytes;
                                flow.latency.add(performance.now() - startedAt);
                            },
                            (error: unknown) => {
                                const detail = error instanceof Error ? error.message : String(error);
                                flow.failed += 1;
                                flow.lastError = detail;
                                // broker 明确说容量不够时继续灌只会刷满日志；stopOnError 同理
                                if (flow.stopOnError || isCapacityError(detail)) {
                                    flow.stopped = true;
                                }
                            },
                        ),
                    );
                    this.pushFlowStats(handle, flow, emit);
                }
                this.pushFlowStats(handle, flow, emit);
            }
        } catch (error) {
            // 走到这里的是循环自身的异常（解析之外的原生调用抛错、限速器意外）
            endError = error instanceof Error ? error.message : String(error);
            flow.lastError = endError;
        } finally {
            // 在途的发送必须落地之后再报终态：否则界面看到"已停止"而 broker 那边
            // 还在陆续收消息，数字对不上。drain 只等已交给原生的那些条。
            await flow.window.drain();
            // 只清自己这一轮：超时停止后用户重开的新一轮已经挂在 handle 上，
            // 旧一轮的 finally 晚落地时把人家抹掉，就变成"新一轮停不下来、改不了速率"。
            if (handle.flow === flow) {
                handle.flow = undefined;
                handle.flowRunning = false;
                // 这一轮的 in-flight 已在上面 drain 完成；清掉排空标记，会话才能
                // 再启动下一轮。endFlow 超时先返回时也会走到这里，它是唯一的收尾者。
                handle.draining = false;
                emit(this.flowStats(handle, flow, false, endError));
            }
            // 会话收尾因为没排空而把 close 押后时，由这里在落地之后补上。
            if (session.stopped) {
                await this.finalizeProducer(handle);
            }
        }
    }

    async stopFlow(sessionId: string): Promise<ProducerRunStats | null> {
        const handle = this.producerHandle(sessionId);
        await this.endFlow(handle);
        return handle.lastStats || null;
    }

    // 改速率只换限速器，不换 producer：连续发送中途提速是常态
    //（先看 100/s 通不通，再往上加），为此断开重连会把已建立的订阅与
    // broker 侧的 producer 计数都搅乱。
    setFlowRate(sessionId: string, ratePerSecond: number): ProducerSessionInfo {
        const handle = this.producerHandle(sessionId);
        const flow = handle.flow;
        if (!flow || !handle.flowRunning) {
            throw new Error('这条会话没有正在跑的连续发送');
        }
        flow.ratePerSecond = ratePerSecond;
        flow.limiter = createRateLimiter(ratePerSecond);
        return this.producerInfo(sessionId, handle);
    }

    listProducerSessions(clusterId?: string): ProducerSessionInfo[] {
        const infos: ProducerSessionInfo[] = [];
        for (const session of this.sessions.values()) {
            if (session.kind !== 'producer' || session.stopped || !session.producer) {
                continue;
            }
            if (clusterId && session.clusterId !== clusterId) {
                continue;
            }
            const handle = session.producer;
            infos.push(this.producerInfo(session.id, handle));
        }
        return infos;
    }

    // 消费者工作台区分"这条会话还活着"和"界面刚才被卸载过"：切页签不会停会话，
    // 重开工作台时靠这份列表把卡片接回来，否则会多出一条看不见却占着同一订阅的会话。
    listConsumerSessions(clusterId?: string): ConsumerSessionInfo[] {
        const infos: ConsumerSessionInfo[] = [];
        for (const session of this.sessions.values()) {
            if (session.kind !== 'consumer' || session.stopped || !session.consumer) {
                continue;
            }
            if (clusterId && session.clusterId !== clusterId) {
                continue;
            }
            infos.push(this.consumerInfo(session.id, session.consumer));
        }
        return infos;
    }

    private consumerInfo(sessionId: string, handle: ConsumerHandle): ConsumerSessionInfo {
        const info: ConsumerSessionInfo = {
            sessionId,
            clusterId: handle.clusterId,
            topicUri: handle.topicUri,
            subscription: handle.subscription,
            subscriptionType: handle.subscriptionType,
            autoAck: handle.autoAck,
            received: handle.received,
            // 手动确认会话的登记表大小；自动确认会话永远是空的 Map，报 0 是真话。
            pendingAcks: handle.unacked.size,
        };
        if (handle.consumerName) {
            info.consumerName = handle.consumerName;
        }
        if (handle.ownerId) {
            info.ownerId = handle.ownerId;
        }
        return info;
    }

    // 会话 id → 常驻 consumer。和 producerHandle 同一口径：取不到就明确报错，
    // 绝不静默重建一条 consumer——那会让界面上那条卡片的计数与实际连接对不上。
    private consumerHandle(sessionId: string): {session: Session; handle: ConsumerHandle} {
        const session = this.sessions.get(sessionId);
        if (!session || session.kind !== 'consumer' || session.stopped) {
            throw new Error('消费者会话不存在或已停止，请重新建立连接');
        }
        const handle = session.consumer;
        if (!handle) {
            throw new Error('消费者会话状态不完整，请停止后重建');
        }
        return {session, handle};
    }

    consumerSession(sessionId: string): ConsumerSessionInfo {
        const {session, handle} = this.consumerHandle(sessionId);
        return this.consumerInfo(session.id, handle);
    }

    /**
     * 按登记表序号确认消息。cumulative 用 seq 最大的那条做累计确认——
     * broker 侧的累计是按游标位置，把 ≤ 它的已登记条目全部摘掉与之一致。
     * Shared 订阅上 broker 会拒绝累计确认，那句原生错误原样抛给界面，不粉饰。
     */
    async ackMessages(sessionId: string, seqs: number[], cumulative: boolean): Promise<ConsumerSessionInfo> {
        const {session, handle} = this.consumerHandle(sessionId);
        if (handle.autoAck) {
            throw new Error('该会话开启了自动确认，没有待确认的消息');
        }
        const targets = seqs.length > 0 ? seqs : [...handle.unacked.keys()];
        if (cumulative) {
            let maxSeq = 0;
            let newest: NativeMessage | undefined;
            for (const seq of targets) {
                const message = handle.unacked.get(seq);
                if (message && seq > maxSeq) {
                    maxSeq = seq;
                    newest = message;
                }
            }
            if (!newest) {
                throw new Error('这些消息已不在未确认窗口内（超出上限或被别的会话确认过）');
            }
            await handle.consumer.acknowledgeCumulative(newest);
            for (const seq of [...handle.unacked.keys()]) {
                if (seq <= maxSeq) {
                    handle.unacked.delete(seq);
                }
            }
            return this.consumerInfo(session.id, handle);
        }
        let acked = 0;
        for (const seq of targets) {
            const message = handle.unacked.get(seq);
            if (!message) {
                continue;
            }
            await handle.consumer.acknowledge(message);
            handle.unacked.delete(seq);
            acked += 1;
        }
        if (acked === 0) {
            throw new Error('这些消息已不在未确认窗口内（超出上限或被别的会话确认过）');
        }
        return this.consumerInfo(session.id, handle);
    }

    // 重投（negativeAck）：原生层把消息交回重投计时器，登记表立刻摘掉这条——
    // 它马上会以新序号重投回来，继续留着会出现"两条界面行认领同一个原生对象"。
    // 没有 ackTimeout 的消费者上原生可能直接报错，那句错误同样原样送界面。
    nackMessages(sessionId: string, seqs: number[]): ConsumerSessionInfo {
        const {session, handle} = this.consumerHandle(sessionId);
        if (handle.autoAck) {
            throw new Error('该会话开启了自动确认，消息已确认，无需重投');
        }
        const targets = seqs.length > 0 ? seqs : [...handle.unacked.keys()];
        let nacked = 0;
        for (const seq of targets) {
            const message = handle.unacked.get(seq);
            if (!message) {
                continue;
            }
            handle.consumer.negativeAcknowledge(message);
            handle.unacked.delete(seq);
            nacked += 1;
        }
        if (nacked === 0) {
            throw new Error('这些消息已不在未确认窗口内（超出上限或已被处理）');
        }
        return this.consumerInfo(session.id, handle);
    }

    /**
     * 偷看：给目标订阅临时挂一条 Shared 消费者，取 N 条就关——一条都不确认，
     * 关闭时这些消息回到积压（Shared 游标只随确认推进），原订阅读数不变。
     * 代价是目标订阅类型必须容忍第二消费者：Exclusive 会被 broker 直接拒绝，
     * Failover 上这条只会被摆成备不投消息——两种情况界面都要能看懂（错误原样抛，
     * 空结果带 note 说明），不做任何粉饰。
     */
    async peekMessages(clusterId: string, config: NativeConnectionConfig, params: PeekParams): Promise<PeekResult> {
        const topic = topicFullName(params.tenant, params.namespace, params.topic, params.persistent);
        const wanted = params.maxMessages ?? 20;
        const client = await this.getClient(clusterId, config);
        const work = (async (): Promise<PeekResult> => {
            const consumer = await client.subscribe(
                buildConsumerConfig(topic, {
                    subscription: params.subscription,
                    subscriptionType: 'Shared',
                    initialPosition: 'Earliest',
                    // 接收队列只开需要的量：默认 1000 会让 broker 一口气推一大截积压，
                    // 偷看 20 条却"占用"了 1000 条的投递额度。
                    receiverQueueSize: wanted,
                }),
            );
            const messages: Message[] = [];
            let note: string | undefined;
            const deadline = Date.now() + PEEK_DEADLINE_MS;
            try {
                while (messages.length < wanted) {
                    if (Date.now() >= deadline) {
                        note = `偷看用时超过 ${Math.round(PEEK_DEADLINE_MS / 1000)} 秒，已取 ${messages.length} 条`;
                        break;
                    }
                    try {
                        const message = await consumer.receive(RECEIVE_TIMEOUT_MS);
                        messages.push(toRendererMessage(message));
                    } catch (error) {
                        if (isTimeoutError(error)) {
                            // 一轮空轮询就是"没有再投得动的消息"：积压为空，
                            // 或目标订阅正被独占/备着，多等也不会有下文
                            break;
                        }
                        throw error;
                    }
                }
                if (messages.length === 0 && !note) {
                    note = '没有取到消息：积压为空，或该订阅类型（Exclusive/Failover）已有消费者占着投递';
                }
            } finally {
                // 只 close 不 unsubscribe：退订会把这个订阅整个删掉，
                // 那才是真正把用户的积压清没了
                await withHardTimeout(consumer.close(), 'peek consumer close timed out').catch((error: unknown) => {
                    log.warn(
                        `peek on ${topic}/${params.subscription} close failed`,
                        error instanceof Error ? error.message : error,
                    );
                });
            }
            return {messages, note};
        })();
        // 登记与 sendOnce 同一口径：临时 consumer 活在缓存 Client 上，
        // 集群被删/改配置时必须先等它收尾再关原生 Client。
        this.trackShortLived(clusterId, work);
        return work;
    }

    /**
     * 一次性发送：现开一条 producer、发完就关，不建会话。
     * 给 TopicDetail 的轻量发送和"发一条试试"用——那些场景留着常驻连接只会让
     * 用户分不清哪条 topic 还挂着连接，而握手开销本来也不是它们在意的事。
     * 模板与条数交给这里逐批解析（见 sendChunks）：一次性物化整批正文会让
     * 主进程在发一条"试试"的路上先多出几百 MB。
     */
    async sendOnce(
        clusterId: string,
        config: NativeConnectionConfig,
        params: {
            tenant: string;
            namespace: string;
            topic: string;
            persistent: boolean;
            options: ProducerOptions;
        },
        plan: {template: MessageTemplateBody; count: number; options: ProducerMessageOptions},
    ): Promise<ProducerSendResult> {
        const topic = topicFullName(params.tenant, params.namespace, params.topic, params.persistent);
        const client = await this.getClient(clusterId, config);
        const work = (async (): Promise<ProducerSendResult> => {
            const producer: Producer = await client.createProducer(buildProducerConfig(topic, params.options));
            // sendWith 逐条吞掉发送异常、自身不 reject，所以这里没有 try/finally：
            // 关掉这条一次性 producer 是唯一必经的收尾。
            const result = await this.sendChunks(producer, plan, () => false);
            result.closeError = await closeProducer(producer);
            return result;
        })();
        // 登记必须在 await 之前，理由与 send() 相同：createProducer 到 close 之间
        // 集群被删或改配置的话，removeCluster 会直接关原生 Client，而下面还挂着 producer。
        this.trackShortLived(clusterId, work);
        return work;
    }

    async stopSessionById(sessionId: string): Promise<boolean> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return false;
        }
        await this.stopSession(session);
        return true;
    }
}

export const nativeClientManager = new NativeClientManager();
