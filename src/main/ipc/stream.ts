import {getMainWindow} from '../index';
import {createLogger} from '../utils/logger';

const log = createLogger('IPCStream');

/**
 * 主进程 → 渲染进程推送。全仓唯一的下行通道入口：窗口可能已销毁
 * （消费循环跑在后台，用户随时可能关窗），这里统一兜住，调用方不必各自判空。
 */
export function sendToRenderer(channel: string, payload: unknown): boolean {
    // 延迟到调用时才读 getMainWindow：index → handlers → message-handlers → 本模块
    // 构成循环 require，模块加载期拿到的是尚未导出的空对象。
    const window = getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
        log.warn(`${channel}: no live window, dropped`);
        return false;
    }
    window.webContents.send(channel, payload);
    return true;
}
