import axios, {AxiosInstance, AxiosError, InternalAxiosRequestConfig} from 'axios';
import https from 'node:https';
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

/**
 * Resolve the Admin API base URL. An explicit webServiceUrl always wins;
 * otherwise the binary protocol URL is mapped onto its HTTP equivalent.
 */
export function resolveBaseUrl(config: PulsarAdminConfig): string {
    if (config.webServiceUrl) {
        return config.webServiceUrl;
    }
    const mapped = config.serviceUrl.replace(/^pulsar\+ssl:\/\//, 'https://').replace(/^pulsar:\/\//, 'http://');
    if (config.tls?.enabled && !mapped.startsWith('https://')) {
        throw new Error(
            `TLS is enabled but the resolved Admin API URL is not HTTPS ("${mapped}"). ` +
                'Set webServiceUrl to an https:// address or use a pulsar+ssl:// service URL.',
        );
    }
    return mapped;
}

function createHttpsAgent(tls: TLSConfig | undefined): https.Agent | undefined {
    if (!tls?.enabled) {
        return undefined;
    }
    return new https.Agent({
        // Certificate verification stays on; a custom CA is supplied instead of
        // disabling the check.
        rejectUnauthorized: true,
        ca: readPem(tls.trustCerts),
        cert: readPem(tls.clientCert),
        key: readPem(tls.clientKey),
    });
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
        httpsAgent: createHttpsAgent(config.tls),
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

export function getErrorMessage(error: AxiosError): string {
    if (error.response) {
        const {status, data} = error.response;
        const message = (data as any)?.reason || (data as any)?.message || `HTTP ${status}`;
        return `${message} (${status})`;
    }
    return error.message;
}

export function normalizeError(error: AxiosError): Error {
    if (error.response) {
        return new Error(`Pulsar API Error: ${getErrorMessage(error)}`);
    } else if (error.request) {
        return new Error('Network Error: Unable to connect to Pulsar cluster');
    }
    return new Error(error.message);
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
