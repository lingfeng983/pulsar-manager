import {
    ipcMain,
    uuidv4,
    getAllSSHTunnels,
    insertSSHTunnel,
    updateSSHTunnel,
    getSetting,
    setSetting,
    encrypt,
    SSHConfigSchema,
    ensureDbInitialized,
    formatError,
} from './_shared';
import {createLogger} from '../utils/logger';

const log = createLogger('IPC');

export function registerSystemHandlers() {
    // ========== SSH 隧道 ==========

    ipcMain.handle('ssh:list', async () => {
        try {
            ensureDbInitialized();
            const tunnels = getAllSSHTunnels();
            return {
                success: true,
                data: tunnels.map(t => ({
                    id: t.id,
                    host: t.host,
                    port: t.port,
                    username: t.username,
                    authType: t.auth_type,
                    status: t.status,
                    localAdminPort: t.local_admin_port,
                    localBrokerPort: t.local_broker_port,
                    remoteHost: t.remote_host,
                    remoteAdminPort: t.remote_admin_port,
                    remoteBrokerPort: t.remote_broker_port,
                })),
            };
        } catch (error) {
            log.error('ssh:list failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    ipcMain.handle('ssh:connect', async (_, config) => {
        try {
            ensureDbInitialized();
            const validated = SSHConfigSchema.parse(config);

            // 端口转发尚未实现。此前这里会随机编造一个本地端口并以
            // status='connected' 落库，让上层误以为隧道可用。现在改为：
            // 保存配置（端口留 0 表示未分配、状态为未连接），并明确返回失败。
            const tunnelId = uuidv4();
            insertSSHTunnel({
                id: tunnelId,
                host: validated.host,
                port: validated.port || 22,
                username: validated.username,
                auth_type: validated.authType,
                password: validated.password ? encrypt(validated.password) : undefined,
                private_key: validated.privateKey ? encrypt(validated.privateKey) : undefined,
                passphrase: validated.passphrase ? encrypt(validated.passphrase) : undefined,
                local_admin_port: 0,
                local_broker_port: 0,
                remote_host: validated.remoteHost,
                remote_admin_port: validated.remoteAdminPort || 8080,
                remote_broker_port: validated.remoteBrokerPort || 6650,
                status: 'disconnected',
            });

            return {
                success: false,
                error: 'SSH 隧道转发尚未实现，配置已保存但隧道未建立',
                data: {tunnelId},
            };
        } catch (error) {
            log.error('ssh:connect failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    ipcMain.handle('ssh:disconnect', async (_, tunnelId) => {
        try {
            ensureDbInitialized();
            updateSSHTunnel(tunnelId, {status: 'disconnected'});
            return {success: true};
        } catch (error) {
            log.error('ssh:disconnect failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    // ========== 主题 ==========

    ipcMain.handle('theme:set', async (_, theme) => {
        try {
            ensureDbInitialized();
            setSetting('theme', theme);
            return {success: true};
        } catch (error) {
            log.error('theme:set failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    ipcMain.handle('theme:get', async () => {
        try {
            ensureDbInitialized();
            const theme = getSetting('theme') || 'light';
            return {success: true, data: theme};
        } catch (error) {
            log.error('theme:get failed, falling back to light', formatError(error));
            return {success: true, data: 'light'};
        }
    });

    // ========== 设置 ==========

    ipcMain.handle('settings:get', async (_, key) => {
        try {
            ensureDbInitialized();
            const value = getSetting(key);
            return {success: true, data: value};
        } catch (error) {
            log.error('settings:get failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    ipcMain.handle('settings:set', async (_, key, value) => {
        try {
            ensureDbInitialized();
            setSetting(key, value);
            return {success: true};
        } catch (error) {
            log.error('settings:set failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    // ========== 操作日志 ==========

    ipcMain.handle('logs:getRecent', async (_, limit) => {
        try {
            ensureDbInitialized();
            const {getRecentOperationLogs} = await import('../database/sqlite.js');
            const logs = getRecentOperationLogs(limit || 50);
            return {success: true, data: logs};
        } catch (error) {
            log.error('logs:getRecent failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    // ========== 系统操作 ==========

    ipcMain.handle('system:checkUpdate', async () => {
        try {
            const currentVersion = process.env.npm_package_version || '1.0.0';

            return {
                success: true,
                data: {
                    currentVersion,
                    latestVersion: currentVersion,
                    hasUpdate: false,
                },
            };
        } catch (error) {
            log.error('system:checkUpdate failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });
}
