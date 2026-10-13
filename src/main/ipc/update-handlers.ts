import {ensureDbInitialized, formatError, registerRawHandler} from './_shared';
import {checkForUpdate, downloadUpdate, installLastDownload} from '../services/update-service';
import {createLogger} from '../utils/logger';

const log = createLogger('IPC');

export function registerUpdateHandlers() {
    registerRawHandler('update:check', async () => {
        try {
            ensureDbInitialized();
            const result = await checkForUpdate();
            return {success: true, data: result};
        } catch (error) {
            const status = (error as {response?: {status?: number}})?.response?.status;
            // 更新源是公开分发仓，匿名就能读；Gitee 对"仓库不存在/没有发行版"
            // 一律回 404，所以这里要说清是源本身不可读，而不是用户少配了什么。
            if (status === 401 || status === 403 || status === 404) {
                return {
                    success: false,
                    error: '更新源不可读：公开分发仓库 pulsar-manager-dist 还没有发行版，或它已被改为私有/删除',
                };
            }
            log.error('update:check failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    registerRawHandler('update:download', async url => {
        if (typeof url !== 'string') {
            return {success: false, error: '参数无效'};
        }
        try {
            // 文件名与校验和都取主进程里最近一次检查的结果，渲染层只提供它看到的 URL
            const file = await downloadUpdate(url);
            return {success: true, data: {file}};
        } catch (error) {
            // 进度事件里已经推过错误，这里只回状态
            log.error('update:download failed', formatError(error));
            return {success: false, error: error instanceof Error ? error.message : String(error)};
        }
    });

    registerRawHandler('update:install', async () => {
        try {
            installLastDownload();
            return {success: true};
        } catch (error) {
            log.error('update:install failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });
}
