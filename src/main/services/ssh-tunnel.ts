import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
        throw new Error(`无法读取 SSH 私钥文件 "${value}": ${(error as Error).message}`);
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

    endpoints(tunnelId: string): TunnelEndpoints | undefined {
        return this.active.get(tunnelId)?.endpoints;
    }

    isConnecting(tunnelId: string): boolean {
        return this.pending.has(tunnelId);
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
            .then(() => this.open(record, targets))
            .finally(() => {
                if (this.pending.get(record.id) === work) {
                    this.pending.delete(record.id);
                }
            });
        this.pending.set(record.id, work);
        return work;
    }

    private async open(record: SSHTunnelRecord, targets: TunnelTargets): Promise<TunnelEndpoints> {
        // 旧隧道（哪怕目标不同）先干净关掉，否则本地监听端口会一直泄漏
        await this.teardown(record.id, 'disconnected');

        const ssh = new Client();
        const listeners: net.Server[] = [];
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
                ssh.connect(toConnectConfig(record));
            });

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
        await this.teardown(tunnelId, 'disconnected');
    }

    /** 配置变更后作废缓存隧道（记录保留），下一次请求按新参数重建。 */
    async invalidate(tunnelId: string): Promise<void> {
        await this.teardown(tunnelId, 'disconnected');
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
