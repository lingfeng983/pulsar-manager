// 从 src/preload.ts 生成 Tauri 侧的等价桥接层。
//
// 唯一真源是 preload.ts：那边加方法、改参数顺序，这里重新生成即可，不需要手抄第二份。
// 生成物只把 `ipcRenderer.invoke` 换成 `transport.invoke`，参数保持原样的位置形式。
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sourcePath = path.join(root, 'src/preload.ts');
const outPath = path.join(root, 'src/renderer/tauri-bridge.generated.ts');

const source = fs.readFileSync(sourcePath, 'utf8');

const marker = "contextBridge.exposeInMainWorld('electronAPI', ";
const at = source.indexOf(marker);
if (at < 0) {
    throw new Error('src/preload.ts 里找不到 exposeInMainWorld(\'electronAPI\', ...)，生成中止');
}

let header = source.slice(0, at);
let body = source.slice(at + marker.length);

// 对象体以 `{` 开头；结尾那行的 `});` 里 `}` 才是对象闭合，`)` 是调用收尾，
// 所以这里要把 `}` 补回去。再往后是 `declare global` 的纯类型声明，生成物不需要。
const tailAt = body.indexOf('\n});');
if (tailAt < 0) {
    throw new Error('找不到 electronAPI 对象体的结尾 `});`，生成中止');
}
body = `${body.slice(0, tailAt).trimEnd()}\n}`;

header = header
    .replace(/^import\s*\{[^}]*\}\s*from\s*'electron';\s*$/gm, '')
    .replace(/^import\s+type\s*\{[^}]*\}\s*from\s*'electron';\s*$/gm, '')
    .replace(/'\.\/shared\//g, "'../shared/");

// Electron 版的 subscribe 直接绑 ipcRenderer.on，这里整段换掉，其余常量保留。
// 源码是 CRLF，行尾必须写成 \r?\n，否则整段匹配不到、把 ipcRenderer 带进生成物。
header = header.replace(/function subscribe<T>\([\s\S]*?\r?\n\}\r?\n/, '');

body = body
    .replace(/ipcRenderer\.invoke/g, 'transport.invoke')
    .replace(/ipcRenderer\.removeListener/g, 'transport.off')
    .replace(/ipcRenderer\.on/g, 'transport.on')
    // 事件对象只用于占位，Electron 的类型不能出现在这里
    .replace(/\bIpcRendererEvent\b/g, 'unknown');

const leftover = /\bipcRenderer\b/.test(header) || /\bipcRenderer\b/.test(body);
if (leftover) {
    throw new Error('生成结果里仍有 ipcRenderer 引用，请检查 preload.ts 结构是否变化');
}

// preload 里的类型 import 是给它的签名用的；生成物只换了调用目标，签名里的类型名不参与，
// 整套照搬会让 `noUnusedLocals` 报一屏 TS6196。这里按「代码里还出现过的名字」逐个筛。
function pruneUnusedTypeImports(headerText, bodyText) {
    const statements = [];
    const rest = headerText.replace(
        /^import type \{([\s\S]*?)\} from '([^']+)';\r?\n/gm,
        (_, names, from) => {
            statements.push({
                names: names
                    .split(',')
                    .map(name => name.trim())
                    .filter(Boolean),
                from,
            });
            return '';
        },
    );
    // 「用没用过」要看整个生成物：签名里的类型名出现在 body，不在 header。
    // 注释要先剥掉，否则一行「// Topic 管理」就会把 Topic 这个类型名误判成用过。
    const usage = `${rest}\n${bodyText}`
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
    const kept = statements
        .map(({names, from}) => {
            const used = names.filter(name => new RegExp(`\\b${name}\\b`).test(usage));
            return used.length > 0 ? `import type {${used.join(', ')}} from '${from}';` : '';
        })
        .filter(Boolean)
        .join('\n');
    return kept ? `${kept}\n${rest}` : rest;
}

const output = `// 由 scripts/gen-tauri-bridge.mjs 生成，请勿手改。
// 唯一真源：src/preload.ts —— 改完 preload 后重新运行 \`node scripts/gen-tauri-bridge.mjs\`。
${pruneUnusedTypeImports(header, body)}
export interface BridgeTransport {
    /** 与 ipcRenderer.invoke 同形：通道名 + 位置参数，返回已解包的 payload。 */
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    /** 部分订阅是手写的 on/removeListener 配对，签名保留 Electron 的 (event, payload)。 */
    on: (channel: string, listener: (...args: any[]) => void) => void;
    off: (channel: string, listener: (...args: any[]) => void) => void;
    /** 主进程 → 渲染进程下行订阅，返回反订阅闭包。 */
    subscribe: <T>(channel: string, callback: (payload: T) => void) => () => void;
}

export function createBridge(transport: BridgeTransport) {
    const subscribe = <T>(channel: string, callback: (payload: T) => void): (() => void) =>
        transport.subscribe<T>(channel, callback);

    return ${body};
}
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, output, 'utf8');

const lines = output.split('\n').length;
console.log(`生成 ${path.relative(root, outPath)}（${lines} 行）`);
