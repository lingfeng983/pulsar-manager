import {app} from 'electron';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {AuthenticationBasic, AuthenticationToken, Client, LogLevel, MessageId} from 'pulsar-client';
import type {ClientConfig, Consumer, Message as NativeMessage, Producer, Reader, SubscriptionType} from 'pulsar-client';
import type {AuthenticationTls} from 'pulsar-client';
import {createLogger} from '../utils/logger';
import {isTimeoutError, sleep, withHardTimeout} from '../utils/promise';
import type {ConsumeStartParams, Message, MessageBatch, ReadStartParams, SessionEndEvent} from '../../shared/types';

const log = createLogger('NativeClient');

// 与 admin 客户端共用同一份解密后的连接参数（凭据只在 _shared 里解一次密）。
export interface NativeConnectionConfig {
    serviceUrl: string;
    operationTimeoutSeconds?: number;
    authPlugin?: string | null;
    authParams?: string | null;
    tlsEnabled?: boolean;
    tlsTrustCerts?: string | null;
    // 地址是被 SSH 隧道改写出来的 127.0.0.1
    viaSshTunnel?: boolean;
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
    if (config.viaSshTunnel && tlsScheme) {
        throw new Error(
            '消息收发暂不支持「TLS + SSH 隧道」组合（原生客户端无法指定 SNI 主机名），请改用 pulsar:// 明文地址经隧道，或关闭隧道直连',
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
// Reader 的空轮询间隔：pulsar-client 1.18 的 readNext(timeout) 在超时真的到期时会段错误
// （实测 readerIdle 两次必崩），所以 Reader 只能先 hasNext() 判断有货、再不带超时地读。
const READER_POLL_MS = 250;
// 停止时要等的是"在途读取落地 + 资源关闭"的整体，而不是只等 close：
// 预算必须覆盖最长的一次空轮询，否则正常等待也会被误判成卡死并提前返回。
const SETTLE_TIMEOUT_MS = RECEIVE_TIMEOUT_MS + CLOSE_TIMEOUT_MS;

// 返回 null 表示"这一轮没有消息"，循环继续；返回消息则计入本批。
type Poll = () => Promise<NativeMessage | null>;

interface Session {
    id: string;
    clusterId: string;
    key: string;
    stopped: boolean;
    close: () => Promise<void>;
    // 循环退出 + 资源关闭 + 上报完成的整体 Promise；停止时等它，
    // 而不是自己去关 consumer——在途读取还没落地就关是崩溃温床。
    settled: Promise<void>;
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
                viaSshTunnel: config.viaSshTunnel,
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
    private sessionCounter = 0;

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
        await withHardTimeout(session.settled, `session ${session.id} did not settle`, SETTLE_TIMEOUT_MS);
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
        await Promise.all([
            ...targets.map(session => this.stopSession(session)),
            ...holds.map(hold => withHardTimeout(hold.stop(), 'held run did not settle')),
        ]);
        if (cached) {
            await withHardTimeout(
                cached.client.close().then(() => undefined),
                `client ${clusterId} close failed`,
            );
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
        },
    ): Promise<{messageId: string}> {
        const topic = topicFullName(params.tenant, params.namespace, params.topic, params.persistent);
        const client = await this.getClient(clusterId, config);
        const producer: Producer = await client.createProducer({topic});
        try {
            const messageId = await producer.send({
                data: Buffer.from(params.message, 'utf8'),
                properties: params.properties,
            });
            return {messageId: messageId.toString()};
        } finally {
            await withHardTimeout(
                producer.close().then(() => undefined),
                'producer close failed',
            );
        }
    }

    // 同一个订阅只允许一个会话：两个消费者抢 Exclusive 订阅会互相踢下线，
    // 表现为"消息时隐时现"，比直接拒绝更难排查。
    private reserveSession(clusterId: string, key: string): Session {
        const existing = [...this.sessions.values()].find(session => session.key === key);
        if (existing) {
            throw new Error('该订阅已有正在运行的会话，请先停止');
        }
        const session: Session = {
            id: `s${++this.sessionCounter}`,
            clusterId,
            key,
            stopped: false,
            close: async () => undefined,
            settled: Promise.resolve(),
        };
        this.sessions.set(session.id, session);
        return session;
    }

    // 顺序轮询，不用原生 listener：listener 回调无法背压，
    // 也无法在停止时确定"最后一个回调已经跑完"。
    private async pump(
        session: Session,
        poll: Poll,
        afterMessage: ((message: NativeMessage) => Promise<void>) | undefined,
        maxMessages: number,
        emit: (batch: MessageBatch) => void,
    ): Promise<void> {
        let buffer: Message[] = [];
        let delivered = 0;
        let lastFlush = Date.now();

        const flush = () => {
            if (buffer.length === 0) {
                return;
            }
            emit({sessionId: session.id, messages: buffer});
            buffer = [];
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
                buffer.push(toRendererMessage(message));
                delivered += 1;
                if (buffer.length >= BATCH_SIZE || Date.now() - lastFlush >= BATCH_FLUSH_MS) {
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
    private runSession(session: Session, loop: Promise<void>, onEnd: (event: SessionEndEvent) => void): void {
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
                        : {sessionId: session.id, reason: session.stopped ? 'stopped' : 'completed'},
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
        const session = this.reserveSession(clusterId, `${clusterId}|${topic}|${params.subscription}`);
        const client = await this.getClient(clusterId, config);

        let consumer: Consumer;
        try {
            consumer = await client.subscribe({
                topic,
                subscription: params.subscription,
                subscriptionType: NATIVE_SUBSCRIPTION_TYPES[params.subscriptionType],
                subscriptionInitialPosition: params.initialPosition,
            });
        } catch (error) {
            this.sessions.delete(session.id);
            throw error;
        }
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
                params.autoAck ? message => consumer.acknowledge(message) : undefined,
                params.maxMessages ?? 0,
                emit,
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
        const seekTimestamp = params.timestamp;
        const session = this.reserveSession(clusterId, `${clusterId}|${topic}|reader|${params.from}`);
        const client = await this.getClient(clusterId, config);

        let reader: Reader;
        try {
            reader = await client.createReader({
                topic,
                startMessageId: params.from === 'latest' ? MessageId.latest() : MessageId.earliest(),
            });
            if (seekTimestamp) {
                await reader.seekTimestamp(seekTimestamp);
            }
        } catch (error) {
            this.sessions.delete(session.id);
            throw error;
        }
        session.close = async () => {
            await reader.close();
        };

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
