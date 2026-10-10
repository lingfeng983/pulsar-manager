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
    "connect-src 'self'",
].join('; ');

function injectProdCsp() {
    return {
        name: 'inject-prod-csp',
        apply: 'build' as const,
        transformIndexHtml(html: string) {
            // 插在 charset 之后：charset 声明必须尽量靠前
            return html.replace(
                '<meta charset="UTF-8" />',
                `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${PROD_CSP}" />`,
            );
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
    },
});
