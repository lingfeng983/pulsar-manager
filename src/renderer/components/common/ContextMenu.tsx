import React, {useEffect, useRef, type ReactNode} from 'react';

export interface ContextMenuItem {
    key: string;
    /** separator 为 true 时是一条分隔线，不需要 label 与 onSelect */
    label?: string;
    icon?: ReactNode;
    disabled?: boolean;
    danger?: boolean;
    separator?: boolean;
    onSelect?: () => void;
}

interface ContextMenuProps {
    /** 相对最近定位父容器的坐标；fixed 时为视口坐标 */
    x: number;
    y: number;
    items: ContextMenuItem[];
    /** 菜单用途，作为 aria-label 暴露给读屏 */
    ariaLabel: string;
    /** 锚定到视口（树节点在滚动容器里，用客户端坐标更稳） */
    fixed?: boolean;
    onClose: () => void;
}

const MENU_WIDTH = 160;
const ITEM_HEIGHT = 30;
const MENU_VERTICAL_PADDING = 8;

// 菜单定位在容器内时不能溢出右/下边缘，超出就向内收。
// 尺寸按项数估算（菜单是纯文字单行项，估算值足够准），避免测完再跳一次位置。
export function clampMenuPosition(
    x: number,
    y: number,
    container: {width: number; height: number} | null,
    itemCount: number,
) {
    const menuHeight = itemCount * ITEM_HEIGHT + MENU_VERTICAL_PADDING;
    const maxX = (container?.width ?? MENU_WIDTH) - MENU_WIDTH - 4;
    const maxY = (container?.height ?? menuHeight) - menuHeight - 4;
    return {
        x: Math.max(4, Math.min(x, maxX)),
        y: Math.max(4, Math.min(y, maxY)),
    };
}

// 共享右键菜单：页签栏与资源树共用同一份视觉与键盘行为。
// 只有 onContextMenu 等于纯键盘用户无法操作，所以这里补齐 role=menu 与方向键导航。
const ContextMenu: React.FC<ContextMenuProps> = ({x, y, items, ariaLabel, fixed, onClose}) => {
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleDocClick = (event: MouseEvent) => {
            if (!menuRef.current?.contains(event.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('click', handleDocClick);
        return () => document.removeEventListener('click', handleDocClick);
    }, [onClose]);

    useEffect(() => {
        const firstEnabled = menuRef.current?.querySelector<HTMLElement>(
            '[role="menuitem"]:not([aria-disabled="true"])',
        );
        firstEnabled?.focus();
    }, []);

    const focusSibling = (current: HTMLElement, direction: 1 | -1) => {
        const enabled = Array.from(
            menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [],
        );
        const index = enabled.indexOf(current);
        if (index < 0 || enabled.length === 0) {
            return;
        }
        const next = enabled[(index + direction + enabled.length) % enabled.length];
        next.focus();
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const item = (event.target as HTMLElement).closest<HTMLElement>('[role="menuitem"]');
        switch (event.key) {
            case 'Escape':
                event.preventDefault();
                // 不收住冒泡的话，Escape 会一路传到 window 上的全局 Escape 监听，
                // 关菜单顺带把顶部搜索框清空、作废在途搜索。
                event.stopPropagation();
                onClose();
                return;
            case 'ArrowDown':
                event.preventDefault();
                if (item) {
                    focusSibling(item, 1);
                }
                return;
            case 'ArrowUp':
                event.preventDefault();
                if (item) {
                    focusSibling(item, -1);
                }
                return;
            case 'Enter':
            case ' ':
                if (item?.getAttribute('aria-disabled') === 'true') {
                    return;
                }
                event.preventDefault();
                item?.click();
                return;
            default:
        }
    };

    const select = (item: ContextMenuItem) => {
        if (item.disabled || !item.onSelect) {
            return;
        }
        item.onSelect();
        onClose();
    };

    const menuItems = items.filter(item => !item.separator);

    return (
        <div
            ref={menuRef}
            className="context-menu"
            style={{left: x, top: y, position: fixed ? 'fixed' : undefined}}
            role="menu"
            aria-label={ariaLabel}
            onKeyDown={handleKeyDown}
            onClick={event => event.stopPropagation()}
        >
            {items.map(item =>
                item.separator ? (
                    <div key={item.key} role="separator" className="context-menu-separator" />
                ) : (
                    <div
                        key={item.key}
                        className={`context-menu-item${item.danger ? ' context-menu-item-danger' : ''}`}
                        style={item.disabled ? {cursor: 'not-allowed'} : undefined}
                        role="menuitem"
                        tabIndex={-1}
                        aria-disabled={item.disabled || undefined}
                        onClick={() => select(item)}
                    >
                        {item.icon ? <span className="context-menu-item-icon">{item.icon}</span> : null}
                        {item.label}
                    </div>
                ),
            )}
            {menuItems.length === 0 ? (
                <div className="context-menu-item" aria-disabled="true">
                    无可用操作
                </div>
            ) : null}
        </div>
    );
};

export default ContextMenu;
