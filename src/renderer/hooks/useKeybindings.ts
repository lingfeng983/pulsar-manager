import {createContext, useContext, useEffect, useRef} from 'react';
import {COMMAND_CATALOG, runCommand, registerCommand, type CommandId} from '../store/commands';
import {useShortcutStore, resolveBinding} from '../store/shortcuts';
import {matchesBinding} from '../utils/keybinding';

// 工作区页签的"当前是否可见"。antd Tabs 只销毁被关掉的页签，切走的页签仍然挂着
// （display:none），于是每个打开过的 Topic 页都会注册一份 sendMessage/refreshMessages。
// 不给 inactive 页签的处理器注册，按键就只落到用户正在看的那个页签上。
// 页面之外的组件（TopNav / 资源树 / Layout）不在此 Provider 内，取默认值 true。
export const PaneActiveContext = createContext(true);

function isEditableTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || typeof el.tagName !== 'string') {
        return false;
    }
    if (el.isContentEditable) {
        return true;
    }
    const tag = el.tagName.toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// 全局快捷键派发器，整个应用只挂载一次（见 Layout）。
// 冲突时按目录顺序取第一个"已注册处理器"的命令，保证行为可预测；
// 未注册处理器的绑定被跳过，因此不会吞掉按键导致输入框失联。
export function useKeybindings(): void {
    const config = useShortcutStore(state => state.config);
    const platform = useShortcutStore(state => state.platform);
    const ready = useShortcutStore(state => state.ready);
    const paneActive = useContext(PaneActiveContext);

    useEffect(() => {
        if (!ready || !config.enabled || !paneActive) {
            return;
        }
        const handleKeyDown = (event: KeyboardEvent) => {
            const typing = isEditableTarget(event.target);
            for (const meta of COMMAND_CATALOG) {
                const binding = resolveBinding(config, platform, meta.id);
                if (!binding || !matchesBinding(event, binding)) {
                    continue;
                }
                if (typing && !meta.allowInEditable) {
                    continue;
                }
                if (runCommand(meta.id)) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [config, platform, ready, paneActive]);
}

// 组件注册自己的命令处理器，卸载时自动解绑，避免切换 Tab 后旧实例继续响应。
// active 为 false（例如所在页签不是当前页签）时不注册，按键只作用于可见页签。
export function useCommand(id: CommandId, handler: () => void, active = true): void {
    const handlerRef = useRef(handler);
    handlerRef.current = handler;
    const paneActive = useContext(PaneActiveContext);
    const enabled = active && paneActive;

    useEffect(() => {
        if (!enabled) {
            return;
        }
        return registerCommand(id, () => handlerRef.current());
    }, [id, enabled]);
}
