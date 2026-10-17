import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {Client} from 'ssh2';
import type {ConnectConfig} from 'ssh2';
import {decrypt} from './encryption';
import {updateSSHTunnel, type SSHTunnelRecord} from '../database/sqlite';
import {createLogger} from '../utils/logger';

const log = createLogger('SshTunnel');

const LOCAL_HOST = '127.0.0.1';
const DEFAULT_SSH_PORT = 22;
const SSH_READY_TIMEOUT_MS = 15000;
const SSH_KEEPALIVE_INTERVAL_MS = 15000;
const SSH_KEEPALIVE_COUNT_MAX = 3;

// 一条隧道要转发的远端目标：admin HTTP 端口与 broker 二进制端口各一个本地监听。
export interface TunnelTargets {
    remoteHost: string;
    adminPort: number;
    brokerPort: number;
}

export interface TunnelEndpoints {
    tunnelId: string;
    localAdminPort: number;
    localBrokerPort: number;
}

interface ActiveTunnel {
    ssh: Client;
    listeners: net.Server[];
    endpoints: TunnelEndpoints;
    targets: TunnelTargets;
}

function sameTargets(a: TunnelTargets, b: TunnelTargets): boolean {
    return a.remoteHost === b.remoteHost && a.adminPort === b.adminPort && a.brokerPort === b.brokerPort;
}

function hostKeyFingerprint(key: Buffer): string {
    return `SHA256:${crypto.createHash('sha256').update(key).digest('base64')}`;
}

// 隧道记录里的凭据是 AES 密文，只有这里解密，且只用于建立 SSH 连接。
function toConnectConfig(record: SSHTunnelRecord): ConnectConfig {
    const config: ConnectConfig = {
        host: record.host,
        port: record.port || DEFAULT_SSH_PORT,
        username: record.username,
        readyTimeout: SSH_READY_TIMEOUT_MS,
        keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
    };
    if (record.auth_type === 'privateKey') {
        if (!record.private_key) {
            throw new Error('SSH 私钥未配置，请填写私钥内容或文件路径');
        }
        config.privateKey = readSecret(record.private_key, true);
        if (record.passphrase) {
            config.passphrase = decrypt(record.passphrase);
        }
        return config;
    }
    if (!record.password) {
        throw new Error('SSH 密码未配置');
    }
    config.password = decrypt(record.password);
    return config;
}

// 私钥既可以按内容粘贴，也可以只填文件路径（与 TLS 证书的处理保持一致）。
function readSecret(stored: string, allowPath: boolean): string {
    const value = decrypt(stored);
    if (!allowPath || value.includes('-----BEGIN')) {
        return value;
    }
    const expanded = value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;
    try {
        return fs.readFileSync(expanded, 'utf-8');
    } catch (error) {
        // 不回显 value：这里的字符串可能是整篇私钥（只是没带 BEGIN 头的那种），
        // 而这条消息会进日志与界面错误条
        throw new Error(
            `无法读取 SSH 私钥：文件不存在或没有读取权限（${error instanceof Error ? error.message : String(error)}）`,
        );
    }
}

function forwardThrough(ssh: Client, remoteHost: string, remotePort: number, socket: net.Socket): void {
    ssh.forwardOut(
        socket.remoteAddress || LOCAL_HOST,
        socket.remotePort || 0,
        remoteHost,
        remotePort,
        (error, stream) => {
            if (error) {
                log.warn(`forward to ${remoteHost}:${remotePort} failed`, error.message);
                socket.destroy();
                return;
            }
            socket.on('error', () => stream.destroy());
            stream.on('error', () => socket.destroy());
            socket.on('close', () => stream.destroy());
            stream.on('close', () => socket.destroy());
            socket.pipe(stream);
            stream.pipe(socket);
        },
    );
}

// 本地监听绑 127.0.0.1:0 由系统分配端口：固定端口会与用户本机服务相撞，
// 而且多个集群各自一条隧道时根本没有可复用的端口号。
function listenLocal(onConnection: (socket: net.Socket) => void): Promise<net.Server> {
    return new Promise((resolve, reject) => {
        const server = net.createServer(socket => {
            try {
                onConnection(socket);
            } catch (error) {
                log.warn('local forward listener failed', error instanceof Error ? error.message : error);
                socket.destroy();
            }
        });
        server.once('error', reject);
        server.once('listening', () => {
            server.removeListener('error', reject);
            resolve(server);
        });
        server.listen(0, LOCAL_HOST);
    });
}

export class SshTunnelManager {
    private active = new Map<string, ActiveTunnel>();
    private pending = new Map<string, Promise<TunnelEndpoints>>();
    // 每次 invalidate/disconnect 递增。建立中的隧道完成时世代已变，说明它用的
    // 是改之前的参数：交出去等于让请求打到按旧主机建起来的本地端口。
    private generation = new Map<string, number>();

    endpoints(tunnelId: string): TunnelEndpoints | undefined {
        return this.active.get(tunnelId)?.endpoints;
    }

    private currentGeneration(tunnelId: string): number {
        return this.generation.get(tunnelId) ?? 0;
    }

    /** 已有隧道且目标一致就直接复用，否则建立一条新的（并发调用共享同一次建立）。 */
    ensure(record: SSHTunnelRecord, targets: TunnelTargets): Promise<TunnelEndpoints> {
        const existing = this.active.get(record.id);
        if (existing && sameTargets(existing.targets, targets)) {
            return Promise.resolve(existing.endpoints);
        }
        const inflight = this.pending.get(record.id);
        if (inflight && !existing) {
            return inflight;
        }
        // 世代在排队这一刻取，而不是 open() 里：作废发生在两者之间时，
        // 排在后面的这次建立同样已经过期，必须知道自己过期。
        const generation = this.currentGeneration(record.id);
        // 目标变了（或上一次建立用的是旧目标）：先等它收尾再按新目标重建，
        // 否则两次建立会互相覆盖，留下没人关闭的本地监听和 SSH 连接。
        const work = (
            inflight
                ? inflight.then(
                      () => undefined,
                      () => undefined,
                  )
                : Promise.resolve()
        )
            .then(() => this.open(record, targets, generation))
            .finally(() => {
                if (this.pending.get(record.id) === work) {
                    this.pending.delete(record.id);
                }
            });
        this.pending.set(record.id, work);
        return work;
    }

    private async open(record: SSHTunnelRecord, targets: TunnelTargets, generation: number): Promise<TunnelEndpoints> {
        const stale = () => this.currentGeneration(record.id) !== generation;
        if (stale()) {
            // 排队期间被作废：这里连旧的都不要关，关掉会把新那条一起掐了
            throw new Error('SSH 隧道参数在建立期间已变更，请重试');
        }
        // 旧隧道（哪怕目标不同）先干净关掉，否则本地监听端口会一直泄漏
        await this.teardown(record.id, 'disconnected');

        const ssh = new Client();
        const listeners: net.Server[] = [];
        // 握手回调里记下、握手成功后落库，所以声明必须在 Promise 之外
        let observedFingerprint: string | null = null;
        try {
            await new Promise<void>((resolve, reject) => {
                const fail = (error: unknown) => {
                    ssh.removeListener('ready', onReady);
                    ssh.removeListener('error', onError);
                    ssh.removeListener('close', onClose);
                    reject(error instanceof Error ? error : new Error(String(error)));
                };
                const onReady = () => {
                    ssh.removeListener('error', onError);
                    ssh.removeListener('close', onClose);
                    resolve();
                };
                const onError = (error: Error) => fail(error);
                const onClose = () =>
                    fail(new Error(`SSH 连接在建立过程中被关闭（${record.host}:${record.port || DEFAULT_SSH_PORT}）`));
                ssh.once('ready', onReady);
                ssh.once('error', onError);
                ssh.once('close', onClose);
                const connectConfig = toConnectConfig(record);
                // 首次连接采用 TOFU：记下主机公钥指纹，之后只接受同一把钥匙。
                // 不校验的话，任何能劫持 host:port 的一方都能接管 SSH 握手并拿到
                // 密码/私钥，再把隧道里的 Admin 流量全部解密。
                connectConfig.hostVerifier = (key: Buffer) => {
                    observedFingerprint = hostKeyFingerprint(key);
                    if (!record.host_fingerprint) {
                        return true;
                    }
                    if (record.host_fingerprint !== observedFingerprint) {
                        log.error(
                            `tunnel ${record.id} host key mismatch for ${record.host}: ` +
                                `expected ${record.host_fingerprint}, got ${observedFingerprint}`,
                        );
                        return false;
                    }
                    return true;
                };
                ssh.connect(connectConfig);
            });

            if (!record.host_fingerprint && observedFingerprint) {
                // 握手成功才落库：失败的连接不应该把一把没验证过的钥匙变成信任锚。
                // 连接用的 record 是调用方传进来的快照，下一次 ensure 会读到新值。
                writeTunnel(record.id, {host_fingerprint: observedFingerprint});
                log.info(`tunnel ${record.id} first trust for ${record.host}: ${observedFingerprint}`);
            }

            const adminListener = await listenLocal(socket =>
                forwardThrough(ssh, targets.remoteHost, targets.adminPort, socket),
            );
            listeners.push(adminListener);
            const brokerListener = await listenLocal(socket =>
                forwardThrough(ssh, targets.remoteHost, targets.brokerPort, socket),
            );
            listeners.push(brokerListener);

            const adminAddress = adminListener.address();
            const brokerAddress = brokerListener.address();
            if (
                typeof adminAddress !== 'object' ||
                !adminAddress ||
                typeof brokerAddress !== 'object' ||
                !brokerAddress
            ) {
                throw new Error('本地转发端口分配失败');
            }
            const tunnel: ActiveTunnel = {
                ssh,
                listeners,
                targets,
                endpoints: {
                    tunnelId: record.id,
                    localAdminPort: adminAddress.port,
                    localBrokerPort: brokerAddress.port,
                },
            };
            if (stale()) {
                // 握手期间配置被改过：这条隧道连的是旧对端，登记了就会一直用错
                listeners.forEach(listener => listener.close());
                ssh.destroy();
                throw new Error('SSH 隧道参数在建立期间已变更，请重试');
            }
            this.active.set(record.id, tunnel);

            // 握手期间的 once 监听已摘掉，这里换成常驻监听：隧道中途断掉必须
            // 立刻摘除登记，下一次请求才会重新建立，而不是对着死 socket 一直超时。
            ssh.on('error', (error: Error) => log.warn(`tunnel ${record.id} error`, error.message));
            ssh.on('close', () => {
                if (this.active.get(record.id) === tunnel) {
                    log.warn(`tunnel ${record.id} closed by remote side`);
                    void this.teardown(record.id, 'disconnected');
                }
            });

            // 只落状态与实际分配的本地端口。远端主机/端口不写回：那两列是用户在
            // 表单里填的覆盖值，把按集群 URL 推导出来的目标写进去，会让下一次
            // 解析把推导值当成用户覆盖（只测隧道连通性时尤其明显，会连到 127.0.0.1）。
            writeTunnel(record.id, {
                status: 'connected',
                local_admin_port: tunnel.endpoints.localAdminPort,
                local_broker_port: tunnel.endpoints.localBrokerPort,
            });
            log.info(
                `tunnel ${record.id} via ${record.host}:${record.port || DEFAULT_SSH_PORT} -> ${targets.remoteHost}`,
                {
                    localAdminPort: tunnel.endpoints.localAdminPort,
                    localBrokerPort: tunnel.endpoints.localBrokerPort,
                },
            );
            return tunnel.endpoints;
        } catch (error) {
            listeners.forEach(listener => listener.close());
            ssh.destroy();
            writeTunnel(record.id, {status: 'error', local_admin_port: 0, local_broker_port: 0});
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(message.startsWith('SSH ') ? message : `SSH 隧道建立失败：${message}`);
        }
    }

    /** 主动断开：本地监听与 SSH 连接全部释放，端口留 0、状态置未连接。 */
    async disconnect(tunnelId: string): Promise<void> {
        this.forget(tunnelId);
        await this.teardown(tunnelId, 'disconnected');
    }

    /** 配置变更后作废缓存隧道（记录保留），下一次请求按新参数重建。 */
    async invalidate(tunnelId: string): Promise<void> {
        this.forget(tunnelId);
        await this.teardown(tunnelId, 'disconnected');
    }

    // 递增世代并丢掉排队中的那次建立：正在连接的那条落地后会发现世代已变，
    // 自己把监听与 SSH 连接拆掉，而不是把一个按旧参数建成的端点交给调用方。
    private forget(tunnelId: string): void {
        this.generation.set(tunnelId, this.currentGeneration(tunnelId) + 1);
        this.pending.delete(tunnelId);
    }

    async closeAll(): Promise<void> {
        await Promise.all([...this.active.keys()].map(id => this.teardown(id, 'disconnected')));
    }

    private async teardown(tunnelId: string, status: 'disconnected' | 'error'): Promise<void> {
        const tunnel = this.active.get(tunnelId);
        if (!tunnel) {
            return;
        }
        this.active.delete(tunnelId);
        tunnel.listeners.forEach(listener => listener.close());
        await new Promise<void>(resolve => {
            // end() 会走正常的 SSH 断开流程；对端已不可达时可能永远不回 close，
            // 所以既兜底超时也要兜底 destroy。
            const timer = setTimeout(() => {
                tunnel.ssh.destroy();
                resolve();
            }, 2000);
            tunnel.ssh.once('close', () => {
                clearTimeout(timer);
                resolve();
            });
            try {
                tunnel.ssh.end();
            } catch (error) {
                log.warn(`tunnel ${tunnelId} disconnect failed`, error instanceof Error ? error.message : error);
                clearTimeout(timer);
                tunnel.ssh.destroy();
                resolve();
            }
        });
        writeTunnel(tunnelId, {status, local_admin_port: 0, local_broker_port: 0});
    }
}

function writeTunnel(tunnelId: string, updates: Partial<SSHTunnelRecord>): void {
    try {
        updateSSHTunnel(tunnelId, updates);
    } catch (error) {
        log.warn(`failed to persist tunnel ${tunnelId} status`, error instanceof Error ? error.message : error);
    }
}

export const sshTunnelManager = new SshTunnelManager();
