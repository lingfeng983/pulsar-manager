import {createLogger} from './logger';

// 主进程侧通用的异步小工具。原生消息会话与压测都要用同一套"绝不无限等"的收尾
// 保险：broker 失联时 consumer.close() / producer.send() 可能永不返回，
// 没有这道保险就再也停不掉会话，卡住的分支之后 reject 还会变成未处理拒绝。

const log = createLogger('PromiseUtil');

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function isTimeoutError(error: unknown): boolean {
    const text = error instanceof Error ? error.message : String(error);
    return /timeout/i.test(text);
}

export function withHardTimeout(work: Promise<unknown>, failureLabel: string, timeoutMs = 5000): Promise<void> {
    // 先挂 catch 再竞速：竞速落败的那条分支若之后 reject，就是未处理拒绝
    const settled = work.catch(error => log.warn(failureLabel, error instanceof Error ? error.message : error));
    return new Promise<void>(resolve => {
        const timer = setTimeout(resolve, timeoutMs);
        void settled.then(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}

// 与 withHardTimeout 同一个"绝不无限等"的保险，但要把"到底落地了没有"告诉调用方：
// 原生 producer 的收尾必须据此决定能不能去 close（没排空就 close 是段错误路径）。
export function settledWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    // 落败分支之后 reject 也要有人接，否则是未处理拒绝
    void work.catch(error =>
        log.warn('in-flight work failed after timeout', error instanceof Error ? error.message : error),
    );
    return new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        void work.then(
            () => {
                clearTimeout(timer);
                resolve(true);
            },
            () => {
                clearTimeout(timer);
                resolve(true);
            },
        );
    });
}
