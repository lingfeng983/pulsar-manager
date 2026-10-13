import {app, BrowserWindow, shell, session, dialog, Menu, Tray, nativeImage} from 'electron';
import path from 'path';
import {registerIPCHandlers, cleanupDatabase} from './ipc/handlers';
import {nativeClientManager} from './services/pulsar-native-client';
import {loadTestManager} from './services/load-test';
import {sshTunnelManager} from './services/ssh-tunnel';
import {createLogger, setLogFileForMainProcess} from './utils/logger';

// 日志文件路径要在任何 logger 调用之前定下来
setLogFileForMainProcess(path.join(app.getPath('userData'), 'logs', 'main.log'));

const log = createLogger('Main');

// 主进程带着原生 pulsar-client / SSH 隧道句柄进入未定义状态继续跑，比直接退出更危险
// （已知的段错误路径都在"资源还在被用却已半死"这一类）。这里不自动重启——用户可能
// 正在灌一批报文，静默重启会把它整个丢掉——而是明确告知"已进入不确定状态，请退出重启"，
// 由用户决定，同时保证只提示一次。
let fatalNoticeShown = false;

function reportFatalException(detail: string): void {
    log.error('Uncaught Exception', detail);
    if (fatalNoticeShown || !mainWindow || mainWindow.isDestroyed()) {
        return;
    }
    fatalNoticeShown = true;
    void dialog
        .showMessageBox(mainWindow, {
            type: 'error',
            title: '主进程出现未捕获异常',
            message: '应用已进入不确定状态',
            detail:
                `${detail.slice(0, 400)}\n\n` +
                '正在运行的收发会话可能已经失效但仍在占用连接。建议保存需要的内容后退出并重新启动应用。',
            buttons: ['知道了', '立即退出'],
        })
        .then(result => {
            if (result.response === 1) {
                isQuitting = true;
                app.quit();
            }
        })
        .catch(() => undefined);
}

process.on('uncaughtException', error => {
    reportFatalException(error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error));
});

process.on('unhandledRejection', reason => {
    log.error('Unhandled Rejection', reason instanceof Error ? reason.message : String(reason));
});

app.commandLine.appendSwitch('disable-features', 'AutofillServerCommunication');
app.commandLine.appendSwitch('autofill-server-url', '');

// 内容安全策略：仅允许本地资源与本地 Vite dev server，禁止加载远程脚本。
// dev 环境走 http，Vite HMR 需要 inline/eval；生产是打包后的静态资源，
// 不含内联脚本也不用 eval，因此收紧到仅 'self'。
// 只看"是否已打包"，不看 NODE_ENV：环境变量在别人的机器上不可控，一旦有人
// 全局导出 NODE_ENV=development，装好的应用会去 load 一个不存在的 5173 端口。
const isDev = !app.isPackaged;
const CSP_DIRECTIVES = [
    "default-src 'self'",
    isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    isDev ? "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*" : "connect-src 'self'",
].join('; ');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// 窗口只有在 IPC handlers 注册完之后才允许创建。渲染层一挂载就会打 cluster:list
// （Home 页首屏），只要窗口抢在 registerIPCHandlers() 之前出现，这个 invoke 就会以
// "No handler registered for 'cluster:list'" 抛在渲染层——主进程一行日志都没有，
// 因为请求根本没走到 ipcMain。second-instance / activate 这两条路径都能在
// app.whenReady() 兑现之前进来（连点两次图标、macOS 点 Dock 图标），所以这里用
// 一个 readyPromise 把它们统一挡在注册之后。
let resolveIpcReady: () => void = () => {};
const ipcReady = new Promise<void>(resolve => {
    resolveIpcReady = resolve;
});

// 托盘图标：16x16 紫色闪电（内联 PNG，避免打包资源路径问题）
const TRAY_ICON_DATA_URL =
    'data:image/png;base64,' +
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAALklEQVR4nGNgGPTA3+3pf4o0k20A' +
    'VTSTZQCyZmyYdpqp7hWGAY0FqhkwMJrpDgASllaMwe0smAAAAABJRU5ErkJggg==';

function showMainWindow() {
    if (!mainWindow) {
        // 等 handlers 注册完再建窗；此时若已有别处建好的窗口就直接用它，别重复创建
        void ipcReady.then(() => {
            if (!mainWindow) {
                createWindow();
            }
        });
        return;
    }
    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }
    if (!mainWindow.isVisible()) {
        mainWindow.show();
    }
    mainWindow.focus();
}

function createTray() {
    tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
    tray.setToolTip('Pulsar Manager');
    tray.setContextMenu(
        Menu.buildFromTemplate([
            {label: '显示主窗口', click: () => showMainWindow()},
            {type: 'separator'},
            {label: '退出', click: () => app.quit()},
        ]),
    );
    tray.on('double-click', () => showMainWindow());
}

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
        // npm run dev 里 main 与 renderer 是同时拉起的，Vite 常常慢几百毫秒才监听，
        // 首帧拿到 ERR_CONNECTION_REFUSED 后 Chromium 不会自己重试，窗口就一直空白。
        let devRetries = 0;
        mainWindow.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
            if (!isMainFrame || errorCode !== -102 || devRetries >= 20) {
                return;
            }
            devRetries += 1;
            setTimeout(() => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.loadURL(`http://localhost:${vitePort}`);
                }
            }, 500);
        });
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));
    }

    mainWindow.webContents.on('console-message', (_event, level, message) => {
        if (message.includes('Autofill.enable') && message.includes("wasn't found")) {
            return;
        }
        // 渲染层的 error 级日志此前只是被这个空函数过了一遍，主进程日志里什么都查不到
        if (level >= 3) {
            log.error(`renderer console: ${message}`);
        }
    });

    mainWindow.once('ready-to-show', () => {
        mainWindow?.show();
    });

    // 点击右上角关闭不再退出，而是最小化到托盘；真正退出走托盘菜单的"退出"
    mainWindow.on('close', event => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow?.hide();
        }
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

    // 禁止页面导航离开应用自身的内容：一旦跳到远程页面，渲染层就带着
    // window.electronAPI 暴露的 IPC 面暴露在对方脚本之下。
    mainWindow.webContents.on('will-navigate', (event, url) => {
        const devOriginAllowed = isDev && (url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:'));
        if (!devOriginAllowed) {
            event.preventDefault();
        }
    });
}

// 单实例锁定，防止多开
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        showMainWindow();
    });

    // 应用就绪
    app.whenReady().then(() => {
        // 隐藏顶部 File/Edit/View 原生菜单栏（桌面工具用不到，白白占一行）
        Menu.setApplicationMenu(null);

        // 下发 CSP，避免渲染层被注入的脚本直接调用 IPC
        session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
            callback({
                responseHeaders: {
                    ...details.responseHeaders,
                    'Content-Security-Policy': [CSP_DIRECTIVES],
                },
            });
        });

        try {
            // 注册 IPC handlers（包括数据库初始化）
            registerIPCHandlers();
            // 注册一完成就放行建窗：排在它前面的任何 createWindow() 都必须等这一刻
            resolveIpcReady();
            createWindow();
            createTray();
        } catch (error) {
            // 数据库打不开（文件损坏、旧版本程序把 user_version 写得比本机更高）时
            // 绝不能只往控制台打一行就退出：安装版没有控制台，用户的现象是
            // 「双击图标没反应」，而且单实例锁已经拿到，再双击也不会重试。
            // 这里刻意不 resolveIpcReady——注册失败时不该再有任何窗口被建出来。
            const detail = error instanceof Error ? error.message : String(error);
            console.error('[Main] Startup failed:', detail);
            dialog.showErrorBox('Pulsar Manager 启动失败', `本地数据库初始化失败：\n${detail}`);
            app.quit();
            return;
        }

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                showMainWindow();
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
app.on('before-quit', () => {
    // 放行窗口 close 事件，否则 preventDefault 会让退出卡死
    isQuitting = true;
});

let resourcesReleased = false;

app.on('will-quit', event => {
    // 这三项收尾都是异步的，而它们绝不能跑到 client.close() 后面去：压测的
    // producer/consumer 还挂在原生 Client 上就关客户端是实测过的段错误，消费者
    // 不先退订 broker 侧会留下"卡住"的订阅，隧道的本地监听端口也会残留。
    // 原来这里是三个 void 加一句立即执行的 cleanupDatabase，等于全程尽力而为。
    if (resourcesReleased) {
        return;
    }
    event.preventDefault();
    const release = async (step: string, task: () => Promise<void>) => {
        try {
            await task();
        } catch (error) {
            log.error(`${step} failed on shutdown`, error instanceof Error ? error.message : String(error));
        }
    };
    (async () => {
        // 顺序不能并起来：clear() 会关掉压测正挂在上面的原生 Client
        await release('load test shutdown', () => loadTestManager.closeAll());
        await release('native client shutdown', () => nativeClientManager.clear());
        await release('ssh tunnel shutdown', () => sshTunnelManager.closeAll());
    })().finally(() => {
        resourcesReleased = true;
        cleanupDatabase();
        app.quit();
    });
});

// IPC handlers 将在后续模块中注册
export function getMainWindow() {
    return mainWindow;
}
