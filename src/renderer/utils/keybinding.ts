// 快捷键字符串的解析、匹配与展示。
// 统一采用 "Ctrl+Shift+K" / "Cmd+K" 这样的规范形式（modifier 顺序固定为
// Ctrl, Alt, Shift, Cmd，主键小写），存储与比较都基于这个形式，展示时再按
// 平台转换成 ⌘ / Ctrl 等符号。

export type Platform = 'mac' | 'windows';

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Cmd'] as const;
type CanonicalModifier = (typeof MODIFIER_ORDER)[number];

export interface ParsedBinding {
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    meta: boolean;
    key: string;
}

export function detectPlatform(): Platform {
    const ua = typeof navigator === 'undefined' ? '' : `${navigator.userAgent} ${navigator.platform}`;
    return /Mac|iPhone|iPad|iPod/i.test(ua) ? 'mac' : 'windows';
}

// 主键归一化：把符号键映射回不带 Shift 的基字符，这样 "Ctrl+Shift+=" 与
// "Ctrl+Shift++" 会被视为同一个绑定，避免用户录到的形式与匹配形式对不上。
const KEY_ALIASES: Record<string, string> = {
    '+': '=',
    _: '-',
    ')': '0',
    '!': '1',
    '@': '2',
    '#': '3',
    $: '4',
    '%': '5',
    '^': '6',
    '&': '7',
    '*': '8',
    '(': '9',
    '{': '[',
    '}': ']',
    ':': ';',
    '"': "'",
    '<': ',',
    '>': '.',
    '|': '\\',
    '~': '`',
    '?': '/',
};

export function normalizeKey(rawKey: string): string {
    if (!rawKey) {
        return '';
    }
    const aliased = KEY_ALIASES[rawKey] ?? rawKey;
    return aliased.length === 1 ? aliased.toLowerCase() : aliased;
}

// 单独按下修饰键时返回 null，调用方据此忽略这次按键。
const BARE_MODIFIERS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'OS']);

export function bindingFromEvent(event: KeyboardEvent): string | null {
    if (BARE_MODIFIERS.has(event.key)) {
        return null;
    }
    const key = normalizeKey(event.key);
    if (!key) {
        return null;
    }
    const modifiers: CanonicalModifier[] = [];
    if (event.ctrlKey) {
        modifiers.push('Ctrl');
    }
    if (event.altKey) {
        modifiers.push('Alt');
    }
    if (event.shiftKey) {
        modifiers.push('Shift');
    }
    if (event.metaKey) {
        modifiers.push('Cmd');
    }
    // macOS 上 ⌘ 是主修饰键，单独的 Cmd+字母才有效；Windows 上不允许只按 Win 键。
    if (modifiers.length === 0) {
        // 允许 F1-F12 与方向键这类无需修饰键的功能键。
        if (!/^F\d{1,2}$/.test(key) && !key.startsWith('Arrow')) {
            return null;
        }
        return key;
    }
    modifiers.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
    return `${modifiers.join('+')}+${key}`;
}

export function parseBinding(binding: string | null | undefined): ParsedBinding | null {
    if (!binding) {
        return null;
    }
    const parts = binding.split('+');
    const key = parts.pop() ?? '';
    if (!key) {
        return null;
    }
    const modifiers = new Set(parts);
    return {
        ctrl: modifiers.has('Ctrl'),
        alt: modifiers.has('Alt'),
        shift: modifiers.has('Shift'),
        meta: modifiers.has('Cmd'),
        key: normalizeKey(key),
    };
}

export function matchesBinding(event: KeyboardEvent, binding: string | null | undefined): boolean {
    const parsed = parseBinding(binding);
    if (!parsed) {
        return false;
    }
    return (
        normalizeKey(event.key) === parsed.key &&
        event.ctrlKey === parsed.ctrl &&
        event.altKey === parsed.alt &&
        event.shiftKey === parsed.shift &&
        event.metaKey === parsed.meta
    );
}

const MAC_SYMBOLS: Record<CanonicalModifier | string, string> = {
    Ctrl: '⌃',
    Alt: '⌥',
    Shift: '⇧',
    Cmd: '⌘',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Enter: '↵',
    Escape: 'Esc',
    Backspace: '⌫',
    ' ': 'Space',
};

const WINDOWS_LABELS: Record<CanonicalModifier | string, string> = {
    Ctrl: 'Ctrl',
    Alt: 'Alt',
    Shift: 'Shift',
    Cmd: 'Win',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Enter: 'Enter',
    Escape: 'Esc',
    Backspace: 'Backspace',
    ' ': 'Space',
};

// 展示用：按当前平台渲染成用户熟悉的符号或文字。
export function formatBinding(binding: string | null | undefined, platform: Platform): string {
    if (!binding) {
        return '未设置';
    }
    const table = platform === 'mac' ? MAC_SYMBOLS : WINDOWS_LABELS;
    const parts = binding.split('+');
    const key = parts.pop() ?? '';
    const label = key.length === 1 ? key.toUpperCase() : (table[key] ?? key);
    const modifiers = parts.map(part => table[part] ?? part);
    // macOS 的书写习惯是修饰键紧邻主键，无需分隔符。
    return platform === 'mac' ? [...modifiers, label].join('') : [...modifiers, label].join('+');
}
