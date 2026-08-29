import {useEffect, useRef} from 'react';
import {COMMAND_CATALOG, runCommand, registerCommand, type CommandId} from '../store/commands';
import {useShortcutStore, resolveBinding} from '../store/shortcuts';
import {matchesBinding} from '../utils/keybinding';

// 全局快捷键派发器，整个应用只挂载一次（见 Layout）。
// 冲突时按目录顺序取第一个"已注册处理器"的命令，保证行为可预测；
// 未注册处理器的绑定被跳过，因此不会吞掉按键导致输入框失联。
export function useKeybindings(): void {
    const config = useShortcutStore(state => state.config);
    const platform = useShortcutStore(state => state.platform);
    const ready = useShortcutStore(state => state.ready);

    useEffect(() => {
        if (!ready || !config.enabled) {
            return;
        }
        const handleKeyDown = (event: KeyboardEvent) => {
            for (const meta of COMMAND_CATALOG) {
                const binding = resolveBinding(config, platform, meta.id);
                if (!binding || !matchesBinding(event, binding)) {
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
    }, [config, platform, ready]);
}

// 组件注册自己的命令处理器，卸载时自动解绑，避免切换 Tab 后旧实例继续响应。
export function useCommand(id: CommandId, handler: () => void, active = true): void {
    const handlerRef = useRef(handler);
    handlerRef.current = handler;

    useEffect(() => {
        if (!active) {
            return;
        }
        return registerCommand(id, () => handlerRef.current());
    }, [id, active]);
}
