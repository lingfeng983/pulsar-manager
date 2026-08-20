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
} from './_shared'

export function registerSystemHandlers() {
  // ========== SSH 隧道 ==========

  ipcMain.handle('ssh:list', async () => {
    try {
      ensureDbInitialized()
      const tunnels = getAllSSHTunnels()
      return {
        success: true,
        data: tunnels.map((t) => ({
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
      }
    } catch (error) {
      console.error('[IPC] ssh:list error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('ssh:connect', async (_, config) => {
    try {
      const validated = SSHConfigSchema.parse(config)

      // TODO: 实现实际的 SSH 隧道连接
      const tunnelId = uuidv4()
      const localPort = Math.floor(Math.random() * 10000) + 20000

      insertSSHTunnel({
        id: tunnelId,
        host: validated.host,
        port: validated.port || 22,
        username: validated.username,
        auth_type: validated.authType,
        password: validated.password ? encrypt(validated.password) : undefined,
        private_key: validated.privateKey ? encrypt(validated.privateKey) : undefined,
        passphrase: validated.passphrase ? encrypt(validated.passphrase) : undefined,
        local_admin_port: localPort,
        local_broker_port: localPort + 1,
        remote_host: validated.remoteHost,
        remote_admin_port: validated.remoteAdminPort || 8080,
        remote_broker_port: validated.remoteBrokerPort || 6650,
        status: 'connected',
      })

      return {
        success: true,
        data: { tunnelId, localPort, localBrokerPort: localPort + 1 },
      }
    } catch (error) {
      console.error('[IPC] ssh:connect error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('ssh:disconnect', async (_, tunnelId) => {
    try {
      ensureDbInitialized()
      updateSSHTunnel(tunnelId, { status: 'disconnected' })
      return { success: true }
    } catch (error) {
      console.error('[IPC] ssh:disconnect error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  // ========== 主题 ==========

  ipcMain.handle('theme:set', async (_, theme) => {
    try {
      ensureDbInitialized()
      setSetting('theme', theme)
      return { success: true }
    } catch (error) {
      console.error('[IPC] theme:set error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('theme:get', async () => {
    try {
      ensureDbInitialized()
      const theme = getSetting('theme') || 'light'
      return { success: true, data: theme }
    } catch (error) {
      console.error('[IPC] theme:get error:', error)
      return { success: true, data: 'light' }
    }
  })

  // ========== 设置 ==========

  ipcMain.handle('settings:get', async (_, key) => {
    try {
      ensureDbInitialized()
      const value = getSetting(key)
      return { success: true, data: value }
    } catch (error) {
      console.error('[IPC] settings:get error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  ipcMain.handle('settings:set', async (_, key, value) => {
    try {
      ensureDbInitialized()
      setSetting(key, value)
      return { success: true }
    } catch (error) {
      console.error('[IPC] settings:set error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  // ========== 操作日志 ==========

  ipcMain.handle('logs:getRecent', async (_, limit) => {
    try {
      ensureDbInitialized()
      const { getRecentOperationLogs } = await import('../database/sqlite.js')
      const logs = getRecentOperationLogs(limit || 50)
      return { success: true, data: logs }
    } catch (error) {
      console.error('[IPC] logs:getRecent error:', error)
      return { success: false, error: formatError(error) }
    }
  })

  // ========== 系统操作 ==========

  ipcMain.handle('system:checkUpdate', async () => {
    try {
      const currentVersion = process.env.npm_package_version || '1.0.0'

      return {
        success: true,
        data: {
          currentVersion,
          latestVersion: currentVersion,
          hasUpdate: false,
        },
      }
    } catch (error) {
      console.error('[IPC] system:checkUpdate error:', error)
      return { success: false, error: formatError(error) }
    }
  })
}
