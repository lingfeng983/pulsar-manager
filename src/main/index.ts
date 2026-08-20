import { app, BrowserWindow, shell, BrowserWindowInstance } from 'electron'
import path from 'path'
import { registerIPCHandlers, cleanupDatabase } from './ipc/handlers'

process.on('uncaughtException', (error) => {
  console.error('[Main] Uncaught Exception:', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled Rejection:', reason)
})

app.commandLine.appendSwitch('disable-features', 'AutofillServerCommunication')
app.commandLine.appendSwitch('autofill-server-url', '')

let mainWindow: BrowserWindowInstance | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      disableBlinkFeatures: 'AutofillEnabled',
    },
    titleBarStyle: 'default',
    frame: true,
    show: false,
  })

  // 开发环境加载 Vite 服务器
  if (process.env.NODE_ENV === 'development') {
    const vitePort = process.env.VITE_PORT || 5173
    mainWindow.loadURL(`http://localhost:${vitePort}`)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'))
  }

  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (message.includes('Autofill.enable') && message.includes("wasn't found")) {
      return
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.on('crashed', () => {
    const { dialog } = require('electron')
    dialog.showMessageBox({
      type: 'error',
      title: '页面崩溃',
      message: '应用页面发生崩溃，是否重新加载？',
      buttons: ['重新加载', '退出'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        mainWindow?.reload()
      } else {
        app.quit()
      }
    })
  })

  // 处理外部链接
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Only allow http and https URLs
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })
}

// 单实例锁定，防止多开
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance, focus our window instead
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  // 应用就绪
  app.whenReady().then(() => {
    // 注册 IPC handlers（包括数据库初始化）
    registerIPCHandlers()

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })
}

// 所有窗口关闭时退出应用（macOS 除外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 应用退出时清理资源
app.on('will-quit', () => {
  cleanupDatabase()
})

// IPC handlers 将在后续模块中注册
export function getMainWindow() {
  return mainWindow
}
