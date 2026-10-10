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
