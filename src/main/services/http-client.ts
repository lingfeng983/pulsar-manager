import axios, {AxiosError, AxiosInstance, InternalAxiosRequestConfig} from 'axios';
import https from 'node:https';
import {checkServerIdentity} from 'node:tls';
import fs from 'node:fs';
import {REQUEST_CONFIG} from '../config/constants';

// ========== Type Definitions ==========

// 跨进程共享的领域类型统一定义在 src/shared/types，这里转出以保持
// `import { TopicStats } from './http-client'` 这类既有引用可用。
export type {
    Tenant,
    Namespace,
    Topic,
    TopicStats,
    SubscriptionStats,
    ProducerStats,
    ConsumerStats,
    TopicConfig,
    TopicConfigPatch,
    Message,
} from '../../shared/types';

export interface ClusterInfo {
    name: string;
    serviceUrl: string;
    brokerServiceUrl?: string;
    version?: string;
}

export interface BrokerStats {
    brokerId: string;
    brokerName: string;
    connected: boolean;
    msgRateIn: number;
    msgRateOut: number;
    msgThroughputIn: number;
    msgThroughputOut: number;
    topicsCount: number;
    partitionsCount: number;
    cpuUsage: number;
    memoryUsage: number;
    directMemoryUsage: number;
    bandwidthIn: number;
    bandwidthOut: number;
    lastUpdateTimestamp: number;
    loadReport?: {
        cpuUsage: number;
        directMemoryUsage: number;
        bandwidthIn: number;
        bandwidthOut: number;
        memoryUsage: number;
        msgRateIn: number;
        msgRateOut: number;
        totalConnections: number;
        topicsCount: number;
        partitionsCount: number;
    };
}

// 认证配置
export interface AuthConfig {
    authPlugin?: string;
    authParams?: string;
}

// TLS 配置
export interface TLSConfig {
    enabled: boolean;
    trustCerts?: string;
    clientCert?: string;
    clientKey?: string;
}

// Pulsar Admin 客户端配置
export interface PulsarAdminConfig {
    serviceUrl: string;
    webServiceUrl?: string;
    timeout?: number;
    auth?: AuthConfig;
    tls?: TLSConfig;
    // 经 SSH 隧道时请求发往 127.0.0.1，但证书是按真实主机名签发的：
    // SNI 与主机名校验都要用这个原始名字，不能因为地址变成回环就跳过。
    tlsVerifyHost?: string;
}

// ========== HTTP Client Factory ==========

/**
 * Thrown when the Admin API answers 404. Callers that treat "absent" as a
 * normal outcome should wrap the call in orNotFound() instead of relying on a
 * null payload leaking through as a successful response.
 */
export class NotFoundError extends Error {
    constructor(public readonly url?: string) {
        super(`Resource not found${url ? `: ${url}` : ''}`);
        this.name = 'NotFoundError';
    }
}

/** Resolve to `fallback` when the wrapped call reports a missing resource. */
export async function orNotFound<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        if (error instanceof NotFoundError) {
            return fallback;
        }
        throw error;
    }
}

/** Read a PEM value that may be supplied either inline or as a file path. */
function readPem(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    if (value.includes('-----BEGIN')) {
        return value;
    }
    try {
        return fs.readFileSync(value, 'utf-8');
    } catch (error) {
        throw new Error(`Unable to read certificate file "${value}": ${(error as Error).message}`);
    }
}

// broker 的二进制口和 admin 的 HTTP 口本来就不是同一个：默认 6650/6651 对应 8080/8443。
// 集群表单里「Admin API URL」允许留空，留空时只能从 serviceUrl 推地址——把 6650 原样
// 照搬过去的话，所有 admin 请求都会打到一个不说 HTTP 的端口上，用户看到的现象是
// 「地址明明填对了，测试连接就是失败」，而且错误只有一个笼统的网络错误。
const DEFAULT_PORTS = {
    http: {broker: 6650, admin: 8080},
    https: {broker: 6651, admin: 8443},
};

/**
 * Resolve the Admin API base URL. An explicit webServiceUrl always wins;
 * otherwise the binary protocol URL is mapped onto its HTTP equivalent,
 * including the port (broker binary port -> admin HTTP port).
 */
export function resolveBaseUrl(config: PulsarAdminConfig): string {
    if (config.webServiceUrl) {
        return config.webServiceUrl;
    }
    // ssl:// 是 SERVICE_URL_PATTERN 放行的第三种写法，同样要落到 https
    const mapped = config.serviceUrl
        .replace(/^pulsar\+ssl:\/\//, 'https://')
        .replace(/^ssl:\/\//, 'https://')
        .replace(/^pulsar:\/\//, 'http://');
    const isHttps = mapped.startsWith('https://');
    if (!isHttps && !mapped.startsWith('http://')) {
        // 不是 http(s) 地址，端口无从谈起，交给后续请求去报错
        return mapped;
    }
    if (config.tls?.enabled && !isHttps) {
        throw new Error(
            `TLS is enabled but the resolved Admin API URL is not HTTPS ("${mapped}"). ` +
                'Set webServiceUrl to an https:// address or use a pulsar+ssl:// service URL.',
        );
    }

    const defaults = isHttps ? DEFAULT_PORTS.https : DEFAULT_PORTS.http;
    try {
        const url = new URL(mapped);
        // 没写端口、或写的正好是 broker 二进制口，都换成同侧默认的 admin 口
        if (!url.port || Number(url.port) === defaults.broker) {
            url.port = String(defaults.admin);
        }
        return url.toString().replace(/\/+$/, '');
    } catch {
        // 地址本身不合法时原样返回，让后续请求报错，不要提前抛一个更难懂的异常
        return mapped;
    }
}

function createHttpsAgent(tls: TLSConfig | undefined, verifyHost?: string): https.Agent | undefined {
    if (!tls?.enabled) {
        return undefined;
    }
    const options: https.AgentOptions = {
        // Certificate verification stays on; a custom CA is supplied instead of
        // disabling the check.
        rejectUnauthorized: true,
        ca: readPem(tls.trustCerts),
        cert: readPem(tls.clientCert),
        key: readPem(tls.clientKey),
    };
    if (verifyHost) {
        options.servername = verifyHost;
        // 连接目标是 127.0.0.1（隧道端点），Node 默认按它对端主机名校验必然失败，
        // 所以这里显式改成按真实主机名校验——是替换校验对象，不是取消校验。
        options.checkServerIdentity = (_host, cert) => checkServerIdentity(verifyHost, cert);
    }
    return new https.Agent(options);
}

/**
 * Create an Axios instance with authentication interceptor and error handling.
 *
 * NOTE: The authParams in the config must already be decrypted before being
 * passed to this function. Decryption happens at client creation time (in
 * handlers.ts getAdminClient), NOT per-request in the interceptor.
 */
export function createAxiosClient(config: PulsarAdminConfig): AxiosInstance {
    const client = axios.create({
        baseURL: resolveBaseUrl(config),
        timeout: config.timeout || REQUEST_CONFIG.TIMEOUT,
        httpsAgent: createHttpsAgent(config.tls, config.tlsVerifyHost),
        headers: {
            'Content-Type': 'application/json',
        },
    });

    // Request interceptor - add authentication header.
    // authParams is already decrypted at client creation time, so we use it directly
    // without calling decrypt() again. This fixes the double-decryption bug where
    // authParams was decrypted both at client creation and on every HTTP request.
    client.interceptors.request.use((axiosConfig: InternalAxiosRequestConfig) => {
        if (config.auth?.authPlugin && config.auth?.authParams) {
            axiosConfig.headers.set('Authorization', `Bearer ${config.auth.authParams}`);
        }
        return axiosConfig;
    });

    // Response interceptor - error handling
    client.interceptors.response.use(
        response => response,
        (error: AxiosError) => {
            // 404 is surfaced as a typed error rather than a fake success payload, so
            // callers cannot accidentally dereference a null body.
            if (error.response?.status === 404) {
                throw new NotFoundError(error.config?.url);
            }
            if (error.response?.status === 401) {
                console.warn('[PulsarAdmin] Authentication failed');
            }
            if (error.response?.status === 403) {
                console.warn('[PulsarAdmin] Forbidden access');
            }
            console.error('[PulsarAdmin] API Error:', getErrorMessage(error));
            throw normalizeError(error);
        },
    );

    return client;
}

// ========== Path Utilities ==========

/**
 * Encode a single Admin API path segment so tenant/namespace/topic/subscription
 * names containing reserved characters ("/", "..", "#", spaces, ...) cannot
 * break out of or alter the intended path.
 */
export function seg(value: string): string {
    return encodeURIComponent(value);
}

// ========== Error Utilities ==========

// 界面上的错误提示只有一行位置，broker 的 500 错误体却带完整 Java 堆栈，
// 动辄几十 KB，原样透传既撑坏 toast 也没人看得懂。
const MAX_ERROR_MESSAGE = 300;

/** Keep the human-readable head of a broker error body and drop the Java stack. */
export function condenseErrorText(raw: string): string {
    const head = raw.split(/\n\s*Stacktrace:|^\s*at\s|\n\s*at\s/)[0] ?? '';
    const singleLine = head.replace(/\s+/g, ' ').trim();
    if (singleLine.length <= MAX_ERROR_MESSAGE) {
        return singleLine;
    }
    return `${singleLine.slice(0, MAX_ERROR_MESSAGE - 1)}…`;
}

export function getErrorMessage(error: AxiosError): string {
    if (error.response) {
        const {status, data} = error.response;
        const raw = typeof data === 'string' ? data : (data as any)?.reason || (data as any)?.message || '';
        const message = condenseErrorText(raw) || `HTTP ${status}`;
        return `${message} (${status})`;
    }
    return condenseErrorText(error.message) || error.message;
}

export function normalizeError(error: AxiosError): Error {
    if (error.response) {
        return new Error(`Pulsar API Error: ${getErrorMessage(error)}`);
    } else if (error.request) {
        return new Error('Network Error: Unable to connect to Pulsar cluster');
    }
    return new Error(condenseErrorText(error.message) || error.message);
}

// 授权端点要按 broker 版本换 HTTP 方法（POST 收 AuthPolicies / PUT 收动作数组），
// 换方法的时机只能靠错误判定。但错误到这里已经被 normalizeError 压成一句话，状态码
// 只剩结尾的「(405)」，所以只能按这句话认——同时把 404（NotFoundError）也算作
// 「这条方法不存在」，有些部署对不认识的方法直接回 404。
export function isHttpMethodRejected(error: unknown): boolean {
    if (error instanceof NotFoundError) {
        return true;
    }
    const message = String((error as Error)?.message ?? error ?? '');
    return /\((405|501)\)$/.test(message) || /method not allowed/i.test(message);
}

// ========== Concurrency Control ==========

// Semaphore 实现用于并发控制
export class Semaphore {
    private active = 0;
    private waiting: Array<{resolve: () => void; reject: (error: Error) => void; cancel: () => void}> = [];

    constructor(private maxConcurrent: number) {}

    /**
     * Acquire a permit. A timeout is enforced so that a permit-ordering mistake
     * degrades into a visible error instead of hanging the client forever.
     */
    async acquire(timeoutMs: number = REQUEST_CONFIG.ACQUIRE_TIMEOUT): Promise<void> {
        if (this.active < this.maxConcurrent) {
            this.active++;
            return;
        }
        return new Promise<void>((resolve, reject) => {
            const waiter = {
                resolve: () => {
                    clearTimeout(timer);
                    resolve();
                },
                reject: (error: Error) => {
                    clearTimeout(timer);
                    reject(error);
                },
                // reset() 用它清掉尚未触发的超时定时器，避免留下悬挂 timer
                cancel: () => clearTimeout(timer),
            };
            const timer = setTimeout(() => {
                const index = this.waiting.indexOf(waiter);
                if (index >= 0) {
                    this.waiting.splice(index, 1);
                }
                reject(new Error(`Timed out after ${timeoutMs}ms waiting for a request slot`));
            }, timeoutMs);
            this.waiting.push(waiter);
        });
    }

    release(): void {
        // 多余的 release 不能把计数压成负数，否则后续 acquire 会超发许可
        this.active = Math.max(0, this.active - 1);
        if (this.waiting.length > 0 && this.active < this.maxConcurrent) {
            const next = this.waiting.shift();
            if (next) {
                this.active++;
                next.resolve();
            }
        }
    }

    reset(): void {
        const pending = this.waiting;
        this.waiting = [];
        this.active = 0;
        pending.forEach(waiter => {
            waiter.cancel();
            waiter.reject(new Error('Pulsar admin client was destroyed'));
        });
    }
}

/**
 * 以固定并发度跑完 items，返回与输入同序的结果。
 *
 * 用于聚合操作内部的扇出：外层已经持有一个信号量许可，内部再去 acquire 会死锁，
 * 但直接 Promise.all(items.map(...)) 又会一次性打出 N 个请求，把 broker 压垮。
 * 这里用一个本地的并发窗口兜住扇出规模。
 */
export async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const limit = Math.max(1, Math.min(concurrency, items.length));

    const workers = Array.from({length: limit}, async () => {
        for (;;) {
            const index = cursor++;
            if (index >= items.length) {
                return;
            }
            results[index] = await fn(items[index], index);
        }
    });

    await Promise.all(workers);
    return results;
}

/**
 * Run `fn` while holding one permit of `semaphore`.
 *
 * IMPORTANT: only the innermost call that actually performs I/O may hold a
 * permit. Wrapping an aggregate operation that in turn calls other
 * semaphore-guarded methods would deadlock once all permits are held by outer
 * callers waiting on inner ones.
 */
export async function withSemaphore<T>(
    semaphore: Semaphore,
    fn: () => Promise<T>,
    acquireTimeoutMs?: number,
): Promise<T> {
    await semaphore.acquire(acquireTimeoutMs);
    try {
        return await fn();
    } finally {
        semaphore.release();
    }
}

// ========== Retry Utilities ==========

// 判断是否为可重试错误
export function isRetryableError(error: Error): boolean {
    return error.message.includes('503') || error.message.includes('Network');
}

// 重试装饰器
export function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
    return fn().catch(async error => {
        if (retries > 0 && isRetryableError(error)) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return withRetry(fn, retries - 1);
        }
        throw error;
    });
}
