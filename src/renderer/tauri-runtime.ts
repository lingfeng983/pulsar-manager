// Tauri 外壳下的桥接注入。
//
// 页面代码一律通过 `window.electronAPI.xxx()` 访问后端（名字是历史包袱，见 api-contract.ts 顶部）。
// 这里提供 BridgeTransport 并把契约工厂的返回值挂到 window 上，页面因此一行都不用改。
import {createBridge, type BridgeTransport} from './api-contract';

interface TauriEvent<T> {
    payload: T;
}

interface TauriGlobal {
    core?: {invoke?: (command: string, args?: unknown) => Promise<unknown>};
    event?: {
        listen?: <T>(name: string, handler: (event: TauriEvent<T>) => void) => Promise<() => void>;
    };
}

function tauriGlobal(): TauriGlobal | undefined {
    return (window as unknown as {__TAURI__?: TauriGlobal}).__TAURI__;
}

/** 是否运行在 Tauri 外壳里（仅用于诊断，不改变页面行为）。 */
export function isTauriRuntime(): boolean {
    return Boolean(tauriGlobal()?.core?.invoke);
}

/**
 * 装上 `window.electronAPI`（由 api-contract.ts 的契约工厂产生）。
 * 返回值表示这次调用是否真的接管了桥接；已挂过就直接返回 false，保证幂等。
 */
export function installTauriBridge(): boolean {
    const existing = (window as unknown as {electronAPI?: unknown}).electronAPI;
    if (existing) {
        return false;
    }

    const tauri = tauriGlobal();
    const invoke = tauri?.core?.invoke;
    const listen = tauri?.event?.listen;
    if (!invoke || !listen) {
        // 两个外壳都不是：页面照常渲染，只是所有数据请求会报"未连接"。
        return false;
    }

    // 手写 on/off 配对的那几处订阅需要按 listener 找回反订阅闭包。
    const offRegistry = new WeakMap<(...args: unknown[]) => void, () => void>();

    const transport: BridgeTransport = {
        invoke: (channel, ...args) => invoke('rpc', {method: channel, args}),

        on: (channel, listener) => {
            const pending = listen(channel, event => listener(undefined, event.payload));
            offRegistry.set(listener, () => {
                void pending.then(unlisten => unlisten());
            });
        },

        off: (_channel, listener) => {
            offRegistry.get(listener)?.();
            offRegistry.delete(listener);
        },

        subscribe: <T>(channel: string, callback: (payload: T) => void) => {
            // listen 是异步的：反订阅可能在它返回之前就被调用（组件挂载后立刻卸载），
            // 所以先记下发过取消，等拿到 unlisten 再补一刀，避免监听泄漏。
            let disposed = false;
            let unlisten: (() => void) | null = null;

            // listen 的泛型推不出载荷类型（这里只有一个回调），显式标一次比让它退化成 unknown 好
            void listen<T>(channel, event => callback(event.payload as T)).then(fn => {
                if (disposed) {
                    fn();
                } else {
                    unlisten = fn;
                }
            });

            return () => {
                disposed = true;
                unlisten?.();
            };
        },
    };

    window.electronAPI = createBridge(transport) as DeclaredApi;
    return true;
}

// ---------- 编译期形状对齐 ----------
//
// createBridge 的每个 invoke 都返回 Promise<unknown>（运行时就是未校验的 JSON），
// 而 Window.electronAPI 是 api-contract.ts 末尾那份手维护的强类型契约，两者没法直接
// 赋值兼容，所以落地时必然要断言一次。断言的价值取决于它是否还连着契约：过去这里写成
// `(window as unknown as {electronAPI: unknown})`，把类型信息整个丢掉，契约改了名、
// 实现没跟上也照样编译通过。现在断言目标是 Window['electronAPI']，再用下面这段
// 只比「方法名」的检查把两边钉死——少一个通道、拼错一个方法、多出契约里没有的组，
// 都在编译期就报错，而不是等页面点到那个按钮才收到「未知方法」。

type BridgeApi = ReturnType<typeof createBridge>;
type DeclaredApi = Window['electronAPI'];

type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false;
type GroupsAligned = SameKeys<BridgeApi, DeclaredApi>;
type MethodsAligned = {
    [K in keyof DeclaredApi & keyof BridgeApi]: SameKeys<BridgeApi[K], DeclaredApi[K]>;
}[keyof DeclaredApi & keyof BridgeApi];

// 这一行不是运行时逻辑，是给类型检查器看的：值恒为 true，类型对不上就赋不过去。
const bridgeShapeAligned: GroupsAligned extends true ? (MethodsAligned extends true ? true : false) : false = true;
void bridgeShapeAligned;

// 关键：必须在模块求值时就接管，而不是等入口文件调用。
// ESM 会先把所有 import 求值完才执行入口模块体，而有些 store 在自身顶层就调用
// window.electronAPI.alert.onEvent(...)，晚一步就是 "Cannot read properties of
// undefined (reading 'alert')" 并且整个 bundle 中断、页面白屏。
// 幂等：已有 electronAPI（重复调用）时直接返回，不会把订阅重挂一遍。
installTauriBridge();
