import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath, URL} from 'node:url';

// 生产构建的页面通过 file:// 加载，onHeadersReceived 下发的 CSP 响应头
// 在这种协议下不生效，所以把等价的策略写进 index.html 的 meta。
// 只在 build 时注入：dev 走 http 且 Vite HMR 需要 inline/eval，
// 由主进程按 dev 规则下发响应头即可。
const PROD_CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    // ipc: http://ipc.localhost 是 Tauri 在 Windows 上的 IPC 端点。
    // Electron 用 file:// 加载页面时这一条不会命中，留着不影响安全边界。
    "connect-src 'self' ipc: http://ipc.localhost",
].join('; ');

function injectProdCsp() {
    return {
        name: 'inject-prod-csp',
        apply: 'build' as const,
        transformIndexHtml(html: string) {
            // 插在 charset 之后：charset 声明必须尽量靠前。
            // 这里必须断言：静默没替换成功就等于把生产环境唯一的 CSP 丢掉，
            // 而 file:// 下响应头不生效，页面将完全没有内容安全策略。
            const marker = '<meta charset="UTF-8" />';
            if (!html.includes(marker)) {
                throw new Error('index.html 里找不到 CSP 注入锚点 <meta charset="UTF-8" />，构建中止');
            }
            return html.replace(marker, `${marker}\n    <meta http-equiv="Content-Security-Policy" content="${PROD_CSP}" />`);
        },
    };
}

export default defineConfig({
    plugins: [react(), injectProdCsp()],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
    base: './',
    build: {
        outDir: 'dist/renderer',
        emptyOutDir: true,
        chunkSizeWarningLimit: 2000,
        rollupOptions: {
            output: {
                manualChunks: {
                    vendor: ['react', 'react-dom', 'antd'],
                    echarts: ['echarts', 'echarts-for-react'],
                    dayjs: ['dayjs'],
                },
            },
        },
    },
    server: {
        port: 5173,
        // 主进程按固定端口 loadURL，端口被占用时 Vite 默认悄悄换到 5174，
        // 现象就是开发窗口白屏且看不出原因
        strictPort: true,
    },
});
