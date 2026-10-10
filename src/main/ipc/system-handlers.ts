import {
    getAllSSHTunnels,
    getSSHTunnelById,
    getSetting,
    setSetting,
    SSHConfigSchema,
    ClusterIdSchema,
    ensureDbInitialized,
    formatError,
    registerRawHandler,
    establishTunnel,
    sshTunnelManager,
} from './_shared';
import {createLogger} from '../utils/logger';

const log = createLogger('IPC');

// settings 通道是通用键值口，放开任意 key 会让渲染层（一旦被注入脚本控制）
// 读写 user_settings 里任何内容，包括主题等内部键。只放行界面上真实用到的。
const SETTINGS_KEYS = new Set(['shortcuts']);

function isAllowedSettingsKey(key: unknown): key is string {
    return typeof key === 'string' && SETTINGS_KEYS.has(key);
}

function tunnelStatus(id: string): 'connected' | 'disconnected' {
    return sshTunnelManager.endpoints(id) ? 'connected' : 'disconnected';
}

export function registerSystemHandlers() {
    // ========== SSH 隧道 ==========

    registerRawHandler('ssh:list', async () => {
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
                    // 库里的 status 可能停在异常值，以当前是否有活的本地转发为准
                    status: tunnelStatus(t.id),
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

    registerRawHandler('ssh:connect', async config => {
        try {
            ensureDbInitialized();
            const validated = SSHConfigSchema.parse(config);

            // 独立建立隧道（没有集群上下文）：远端目标取显式填写的 remoteHost，
            // 缺省就转发到 SSH 主机自身的 8080/6650。
            const remoteHost = validated.remoteHost || validated.host;
            const resolved = await establishTunnel(
                {
                    service_url: `pulsar://${remoteHost}:${validated.remoteBrokerPort || 6650}`,
                    web_service_url: `http://${remoteHost}:${validated.remoteAdminPort || 8080}`,
                },
                {sshConfigId: validated.id, ssh: validated},
            );

            return {
                success: true,
                data: {
                    tunnelId: resolved.tunnelId,
                    localPort: resolved.endpoints.localAdminPort,
                    localBrokerPort: resolved.endpoints.localBrokerPort,
                },
            };
        } catch (error) {
            log.error('ssh:connect failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    registerRawHandler('ssh:disconnect', async tunnelId => {
        try {
            ensureDbInitialized();
            const parsedId = ClusterIdSchema.safeParse(tunnelId);
            if (!parsedId.success) {
                return {success: false, error: 'Invalid tunnel id'};
            }
            if (!getSSHTunnelById(parsedId.data)) {
                return {success: false, error: 'Tunnel not found'};
            }
            await sshTunnelManager.disconnect(parsedId.data);
            return {success: true};
        } catch (error) {
            log.error('ssh:disconnect failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    // ========== 主题 ==========

    registerRawHandler('theme:set', async theme => {
        try {
            ensureDbInitialized();
            if (typeof theme !== 'string') {
                return {success: false, error: 'Invalid theme'};
            }
            setSetting('theme', theme);
            return {success: true};
        } catch (error) {
            log.error('theme:set failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    registerRawHandler('theme:get', async () => {
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

    registerRawHandler('settings:get', async key => {
        try {
            ensureDbInitialized();
            if (!isAllowedSettingsKey(key)) {
                return {success: false, error: 'Invalid settings key'};
            }
            const value = getSetting(key);
            return {success: true, data: value};
        } catch (error) {
            log.error('settings:get failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    registerRawHandler('settings:set', async (key, value) => {
        try {
            ensureDbInitialized();
            if (!isAllowedSettingsKey(key)) {
                return {success: false, error: 'Invalid settings key'};
            }
            if (typeof value !== 'string' || value.length > 64 * 1024) {
                return {success: false, error: 'Invalid settings value'};
            }
            setSetting(key, value);
            return {success: true};
        } catch (error) {
            log.error('settings:set failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    // ========== 操作日志 ==========

    registerRawHandler('logs:getRecent', async limit => {
        try {
            ensureDbInitialized();
            const {getRecentOperationLogs} = await import('../database/sqlite.js');
            const safeLimit = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 50;
            const logs = getRecentOperationLogs(safeLimit);
            return {success: true, data: logs};
        } catch (error) {
            log.error('logs:getRecent failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });
}
