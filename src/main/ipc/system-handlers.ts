import {dialog} from 'electron';
import {basename} from 'node:path';
import {statSync} from 'node:fs';
import {
    getAllSSHTunnels,
    getSSHTunnelById,
    getSetting,
    setSetting,
    SSHConfigSchema,
    ClusterIdSchema,
    z,
    ensureDbInitialized,
    formatError,
    registerRawHandler,
    establishTunnel,
    sshTunnelManager,
} from './_shared';
import {createLogger} from '../utils/logger';

const log = createLogger('IPC');

// 单次上传的包上限。这个数字不是 worker 侧的配置（那边可以调大也可以调小），
// 而是本工具自己的兜底：整个文件要经主进程读一遍再流出去，
// 没有上限的话选错一个几 GB 的镜像 tar 就会把应用按在那里。
const ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;

// settings 通道是通用键值口，放开任意 key 会让渲染层（一旦被注入脚本控制）
// 读写 user_settings 里任何内容，包括主题等内部键。只放行界面上真实用到的。
const SETTINGS_KEYS = new Set(['shortcuts']);

function isAllowedSettingsKey(key: unknown): key is string {
    return typeof key === 'string' && SETTINGS_KEYS.has(key);
}

function tunnelStatus(id: string): 'connected' | 'disconnected' {
    return sshTunnelManager.endpoints(id) ? 'connected' : 'disconnected';
}

const ThemeSchema = z.enum(['light', 'dark', 'eyeCare']);

// 一次最多取 1000 条：日志表没有上限地把整张表读进内存再序列化给渲染进程，
// 是把自己主进程卡死的最快方式
const LOG_LIMIT_MAX = 1000;

function normalizeLogLimit(limit: unknown): number {
    return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? Math.min(limit, LOG_LIMIT_MAX) : 50;
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

    // 主题只有这三种：写进 user_settings 的 theme 会在启动时决定 data-theme，
    // 放开任意字符串等于让渲染层把一个不存在的主题名写进库（界面从此没有配色表）。
    registerRawHandler('theme:set', async theme => {
        try {
            ensureDbInitialized();
            const parsed = ThemeSchema.safeParse(theme);
            if (!parsed.success) {
                return {success: false, error: 'Invalid theme'};
            }
            setSetting('theme', parsed.data);
            return {success: true};
        } catch (error) {
            log.error('theme:set failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    registerRawHandler('theme:get', async () => {
        try {
            ensureDbInitialized();
            const stored = getSetting('theme');
            // 库里的值不认（老版本写过的别名、被外部改坏）就回 light，
            // 但仍然报成功——读不到自己的设置不是用户的错，不该弹错误条
            const parsed = ThemeSchema.safeParse(stored);
            return {success: true, data: parsed.success ? parsed.data : 'light'};
        } catch (error) {
            // 回 success:true 会把"数据库读挂了"伪装成"用户用的是浅色主题"
            log.error('theme:get failed', formatError(error));
            return {success: false, error: formatError(error)};
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
            const logs = getRecentOperationLogs(normalizeLogLimit(limit));
            return {success: true, data: logs};
        } catch (error) {
            log.error('logs:getRecent failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });

    // ========== 本地包选择 ==========

    // 路径由系统对话框产生，渲染进程只能拿到"用户刚选过的那个文件"，
    // 这比开一个"按路径读文件"的通道安全得多——后者等于把整台机器交给页面。
    // 过滤器只是帮用户少翻两级目录，不是校验：Go 的包是编译出来的裸二进制，
    // 没有可靠后缀，所以「所有文件」这一档必须留着，真正的门槛只有下面的大小。
    registerRawHandler('file:pickArchive', async () => {
        try {
            const result = await dialog.showOpenDialog({
                title: '选择函数 / 连接器的包',
                properties: ['openFile'],
                filters: [
                    {name: '常见的包（jar / nar / zip / py）', extensions: ['jar', 'nar', 'zip', 'py']},
                    {name: '所有文件', extensions: ['*']},
                ],
            });
            if (result.canceled || result.filePaths.length === 0) {
                // 取消不是错误：界面据此保持原状，不该弹一条红字
                return {success: true, data: null};
            }
            const picked = result.filePaths[0];
            const stat = statSync(picked);
            if (!stat.isFile()) {
                return {success: false, error: '选中的不是文件'};
            }
            if (stat.size === 0) {
                return {success: false, error: '这个文件是空的，worker 取过去也加载不了'};
            }
            if (stat.size > ARCHIVE_MAX_BYTES) {
                return {
                    success: false,
                    error:
                        `包太大（${Math.round(stat.size / 1024 / 1024)}MB），本工具单次上传上限 ` +
                        `${Math.round(ARCHIVE_MAX_BYTES / 1024 / 1024)}MB：更大的包请先放到 worker 取到的地址`,
                };
            }
            return {success: true, data: {path: picked, name: basename(picked), size: stat.size}};
        } catch (error) {
            log.error('file:pickArchive failed', formatError(error));
            return {success: false, error: formatError(error)};
        }
    });
}
