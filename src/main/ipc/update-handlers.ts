import {
    ensureDbInitialized,
    formatError,
    registerRawHandler,
    getSetting,
    setSetting,
    encrypt,
    decrypt,
} from './_shared';
import {checkForUpdate, downloadUpdate, installLastDownload} from '../services/update-service';
import {createLogger} from '../utils/logger';

const log = createLogger('IPC');

const TOKEN_KEY = 'update_token';

function readToken(): string | undefined {
    const stored = getSetting(TOKEN_KEY);
    if (!stored) {
        return undefined;
    }
    try {
        return decrypt(stored);
    } catch {
        log.warn('update token exists but failed to decrypt; ignoring it');
        return undefined;
    }
}

export function registerUpdateHandlers() {
    registerRawHandler('update:tokenStatus', async () => {
        try {
            ensureDbInitialized();
            return {success: true, data: {configured: !!getSetting(TOKEN_KEY)}};
        } catch (error) {
            log.error('update:tokenStatus failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    registerRawHandler('update:setToken', async token => {
        try {
            ensureDbInitialized();
            if (typeof token !== 'string' || token.length > 255) {
                return {success: false, error: '令牌无效（最长 255 字符）'};
            }
            if (token === '') {
                setSetting(TOKEN_KEY, '');
            } else {
                setSetting(TOKEN_KEY, encrypt(token));
            }
            return {success: true};
        } catch (error) {
            log.error('update:setToken failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    registerRawHandler('update:check', async () => {
        try {
            ensureDbInitialized();
            const result = await checkForUpdate(readToken());
            return {success: true, data: result};
        } catch (error) {
            const status = (error as {response?: {status?: number}})?.response?.status;
            // 更新源是公开分发仓，正常不需要令牌；Gitee 对"仓库不存在/没有发行版"
            // 一律回 404，所以这里不能再把它说成"令牌缺失"。
            if (status === 401 || status === 403 || status === 404) {
                return {
                    success: false,
                    error:
                        '更新源不可读：公开分发仓库 pulsar-manager-dist 还没有发行版，或它已被改为私有/删除。' +
                        '需要私有源时可在高级里配置 access_token',
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
