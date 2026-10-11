// 快捷键命令注册表。
//
// COMMAND_CATALOG 是用户可绑定的全量命令（配置页展示这些行），runtime registry
// 是当前挂载页面上实际注册的处理器；派发时未注册的命令直接跳过，因此不会出现
// "按了没反应还把按键吞掉"的假绑定。

export type ShortcutGroup = '全局通用' | 'Tab操作' | '集群操作' | '消息调试' | '拓扑画布' | '监控';

export type CommandId =
    | 'focusSearch'
    | 'toggleTheme'
    | 'openShortcutConfig'
    | 'closeTab'
    | 'nextTab'
    | 'prevTab'
    | 'closeOtherTabs'
    | 'refreshResources'
    | 'addCluster'
    | 'browseMessages'
    | 'refreshMessages'
    | 'sendMessage'
    | 'topologyZoomIn'
    | 'topologyZoomOut'
    | 'topologyReset'
    | 'refreshMetrics';

export interface CommandMeta {
    id: CommandId;
    name: string;
    group: ShortcutGroup;
    /** 出厂默认绑定，null 表示该平台上默认不占用按键。 */
    defaults: {windows: string | null; mac: string | null};
    /**
     * 焦点在输入框/文本域里时是否仍然生效。默认 false —— 否则在消息正文里打字
     * 按 Ctrl+W 会直接关掉页签、Ctrl+K 会把焦点抢到搜索框。
     * 只有"在编辑器里按下去本身就是这层意思"的命令才配 true。
     */
    allowInEditable?: boolean;
}

export const GROUP_ORDER: ShortcutGroup[] = ['全局通用', 'Tab操作', '集群操作', '消息调试', '拓扑画布', '监控'];

export const COMMAND_CATALOG: CommandMeta[] = [
    {
        id: 'focusSearch',
        name: '聚焦全局搜索',
        group: '全局通用',
        defaults: {windows: 'Ctrl+k', mac: 'Cmd+k'},
    },
    {
        id: 'toggleTheme',
        name: '切换亮/暗/护眼主题',
        group: '全局通用',
        defaults: {windows: 'Ctrl+Shift+t', mac: 'Cmd+Shift+t'},
    },
    {
        id: 'openShortcutConfig',
        name: '打开快捷键配置',
        group: '全局通用',
        defaults: {windows: 'Ctrl+Shift+k', mac: 'Cmd+Shift+k'},
    },
    {
        id: 'closeTab',
        name: '关闭当前标签页',
        group: 'Tab操作',
        defaults: {windows: 'Ctrl+w', mac: 'Cmd+w'},
    },
    {
        id: 'nextTab',
        name: '切换到下一个标签页',
        group: 'Tab操作',
        defaults: {windows: 'Ctrl+PageDown', mac: 'Cmd+PageDown'},
    },
    {
        id: 'prevTab',
        name: '切换到上一个标签页',
        group: 'Tab操作',
        defaults: {windows: 'Ctrl+PageUp', mac: 'Cmd+PageUp'},
    },
    {
        id: 'closeOtherTabs',
        name: '关闭其他标签页',
        group: 'Tab操作',
        defaults: {windows: 'Ctrl+Shift+w', mac: 'Cmd+Shift+w'},
    },
    {
        id: 'refreshResources',
        name: '刷新资源树',
        group: '集群操作',
        defaults: {windows: 'F5', mac: 'Cmd+r'},
    },
    {
        id: 'addCluster',
        name: '新增集群',
        group: '集群操作',
        defaults: {windows: 'Ctrl+Shift+n', mac: 'Cmd+Shift+n'},
    },
    {
        id: 'browseMessages',
        name: '打开消息浏览器',
        group: '消息调试',
        defaults: {windows: 'Ctrl+m', mac: 'Cmd+m'},
    },
    {
        id: 'refreshMessages',
        name: '刷新消息列表',
        group: '消息调试',
        defaults: {windows: 'Ctrl+Shift+r', mac: 'Cmd+Shift+r'},
        allowInEditable: true,
    },
    {
        id: 'sendMessage',
        name: '发送消息',
        group: '消息调试',
        defaults: {windows: 'Ctrl+Enter', mac: 'Cmd+Enter'},
        allowInEditable: true,
    },
    {
        id: 'topologyZoomIn',
        name: '拓扑画布放大',
        group: '拓扑画布',
        defaults: {windows: 'Ctrl+=', mac: 'Cmd+='},
    },
    {
        id: 'topologyZoomOut',
        name: '拓扑画布缩小',
        group: '拓扑画布',
        defaults: {windows: 'Ctrl+-', mac: 'Cmd+-'},
    },
    {
        id: 'topologyReset',
        name: '拓扑画布复位',
        group: '拓扑画布',
        defaults: {windows: 'Ctrl+0', mac: 'Cmd+0'},
    },
    {
        id: 'refreshMetrics',
        name: '刷新监控面板',
        group: '监控',
        defaults: {windows: 'Ctrl+Shift+g', mac: 'Cmd+Shift+g'},
    },
];

export const COMMAND_BY_ID: Record<CommandId, CommandMeta> = COMMAND_CATALOG.reduce(
    (acc, meta) => {
        acc[meta.id] = meta;
        return acc;
    },
    {} as Record<CommandId, CommandMeta>,
);

type CommandHandler = () => void;

const handlers = new Map<CommandId, Set<CommandHandler>>();

// 同一命令允许多个监听者（例如多个拓扑 Tab 各注册一次缩放），返回的注销函数
// 必须在组件卸载时调用，否则切换 Tab 后旧实例仍会收到按键。
export function registerCommand(id: CommandId, handler: CommandHandler): () => void {
    let set = handlers.get(id);
    if (!set) {
        set = new Set();
        handlers.set(id, set);
    }
    set.add(handler);
    return () => {
        const current = handlers.get(id);
        if (!current) {
            return;
        }
        current.delete(handler);
        if (current.size === 0) {
            handlers.delete(id);
        }
    };
}

export function runCommand(id: CommandId): boolean {
    const set = handlers.get(id);
    if (!set || set.size === 0) {
        return false;
    }
    set.forEach(handler => {
        try {
            handler();
        } catch (error) {
            console.error(`[shortcut] command "${id}" threw:`, error);
        }
    });
    return true;
}
