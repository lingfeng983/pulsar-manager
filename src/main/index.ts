import {app, BrowserWindow, shell, session, dialog} from 'electron';
import path from 'path';
import {registerIPCHandlers, cleanupDatabase} from './ipc/handlers';
import {nativeClientManager} from './services/pulsar-native-client';

process.on('uncaughtException', error => {
    console.error('[Main] Uncaught Exception:', error);
});

process.on('unhandledRejection', reason => {
    console.error('[Main] Unhandled Rejection:', reason);
});

app.commandLine.appendSwitch('disable-features', 'AutofillServerCommunication');
app.commandLine.appendSwitch('autofill-server-url', '');

// 内容安全策略：仅允许本地资源与本地 Vite dev server，禁止加载远程脚本。
// dev 环境走 http，Vite HMR 需要 inline/eval；生产是打包后的静态资源，
// 不含内联脚本也不用 eval，因此收紧到仅 'self'。
const isDev = process.env.NODE_ENV === 'development';
const CSP_DIRECTIVES = [
    "default-src 'self'",
    isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    isDev ? "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*" : "connect-src 'self'",
].join('; ');

let mainWindow: BrowserWindow | null = null;

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
    });

    // 开发环境加载 Vite 服务器
    if (isDev) {
        const vitePort = process.env.VITE_PORT || 5173;
        mainWindow.loadURL(`http://localhost:${vitePort}`);
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));
    }

    mainWindow.webContents.on('console-message', (_event, level, message) => {
        if (message.includes('Autofill.enable') && message.includes("wasn't found")) {
            return;
        }
    });

    mainWindow.once('ready-to-show', () => {
        mainWindow?.show();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // 渲染进程崩溃（'crashed' 在 Electron 29 已移除，改用 render-process-gone）
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        console.error('[Main] Renderer process gone:', details.reason);
        dialog
            .showMessageBox({
                type: 'error',
                title: '页面崩溃',
                message: '应用页面发生崩溃，是否重新加载？',
                buttons: ['重新加载', '退出'],
                defaultId: 0,
            })
            .then(({response}) => {
                if (response === 0) {
                    mainWindow?.reload();
                } else {
                    app.quit();
                }
            });
    });

    // 处理外部链接
    mainWindow.webContents.setWindowOpenHandler(({url}) => {
        // Only allow http and https URLs
        if (url.startsWith('http://') || url.startsWith('https://')) {
            shell.openExternal(url);
        }
        return {action: 'deny'};
    });
}

// 单实例锁定，防止多开
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        // Someone tried to run a second instance, focus our window instead
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    // 应用就绪
    app.whenReady().then(() => {
        // 下发 CSP，避免渲染层被注入的脚本直接调用 IPC
        session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
            callback({
                responseHeaders: {
                    ...details.responseHeaders,
                    'Content-Security-Policy': [CSP_DIRECTIVES],
                },
            });
        });

        // 注册 IPC handlers（包括数据库初始化）
        registerIPCHandlers();

        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    });
}

// 所有窗口关闭时退出应用（macOS 除外）
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// 应用退出时清理资源
app.on('will-quit', () => {
    // 原生客户端的会话要主动关，否则 broker 侧会留下未关闭的消费者/生产者
    // （订阅看起来"卡住"往往就是这个原因）。will-quit 无法等待异步关闭，只能尽力而为。
    void nativeClientManager.clear();
    cleanupDatabase();
});

// IPC handlers 将在后续模块中注册
export function getMainWindow() {
    return mainWindow;
}
