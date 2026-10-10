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

let lastCheckedDownloadUrl: string | undefined;

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
            lastCheckedDownloadUrl = result.downloadUrl;
            return {success: true, data: result};
        } catch (error) {
            const status = (error as {response?: {status?: number}})?.response?.status;
            // 私有仓库无令牌时 Gitee 返回 404（防探测），带错误令牌返回 401/403
            if (status === 401 || status === 403 || status === 404) {
                return {
                    success: false,
                    error: 'Gitee 访问令牌缺失或无效：本仓库是私有仓库，检查更新需要在下方配置 access_token',
                };
            }
            log.error('update:check failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    registerRawHandler('update:download', async (url, fileName) => {
        if (typeof url !== 'string' || typeof fileName !== 'string') {
            return {success: false, error: '参数无效'};
        }
        try {
            const file = await downloadUpdate(url, fileName, lastCheckedDownloadUrl);
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
