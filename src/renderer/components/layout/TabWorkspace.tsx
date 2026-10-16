import React, {
    useState,
    useRef,
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent as ReactMouseEvent,
} from 'react';
import {Tabs} from 'antd';
import {useTabStore} from '../../store/tabs';
import HomePage from '../../pages/Home';
import TopicDetail from '../../pages/TopicDetail';
import TenantDetail from '../../pages/TenantDetail';
import NamespaceDetail from '../../pages/NamespaceDetail';
import MetricsDashboard from '../../pages/MetricsDashboard';
import AlertCenter from '../../pages/AlertCenter';
import WorkerCenter from '../../pages/WorkerCenter';
import ProducerWorkspace from '../../pages/ProducerWorkspace';
import ConsumerWorkspace from '../../pages/ConsumerWorkspace';
import ShortcutConfig from '../../pages/ShortcutConfig';
import ConfigCenter from '../../pages/ConfigCenter';
import PluginMarket from '../../pages/PluginMarket';
import ClusterTopology from '../metrics/ClusterTopology';
import {useCommand, PaneActiveContext} from '../../hooks/useKeybindings';
import ContextMenu, {clampMenuPosition, type ContextMenuItem} from '../common/ContextMenu';

// 页签右键菜单固定 4 项，定位时按这个数量估算高度即可（见 clampMenuPosition）。
const TAB_MENU_ITEMS = 4;

interface TabMenuState {
    x: number;
    y: number;
    tabKey: string;
}

const TabWorkspace: React.FC = () => {
    const {tabs, activeTabId, setActiveTab, removeTab} = useTabStore();
    const containerRef = useRef<HTMLDivElement>(null);

    const [tabContextMenu, setTabContextMenu] = useState<TabMenuState | null>(null);

    // 处理 Tab 切换
    const handleChange = (key: string) => {
        setActiveTab(key);
    };

    // 处理 Tab 关闭 - 保护 home tab 不可关闭
    const handleEdit = (targetKey: any, action: 'add' | 'remove') => {
        if (action === 'remove') {
            // 不允许关闭首页 tab
            if (targetKey === 'home') return;
            removeTab(targetKey);
        }
    };

    const openMenuAt = (x: number, y: number, tabKey: string) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const clamped = clampMenuPosition(x, y, rect ? {width: rect.width, height: rect.height} : null, TAB_MENU_ITEMS);
        setTabContextMenu({x: clamped.x, y: clamped.y, tabKey});
    };

    // 右键点击 tab 处理：坐标换算成相对容器，交给 .context-menu 的绝对定位
    const handleTabContextMenu = (e: ReactMouseEvent, tabKey: string) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = containerRef.current?.getBoundingClientRect();
        openMenuAt(e.clientX - (rect?.left ?? 0), e.clientY - (rect?.top ?? 0), tabKey);
    };

    // 在整个工作区容器上兜住 contextmenu：右键命中页签任意位置（含 padding/关闭钮）都能弹菜单，
    // 通过 data-node-key 反查是否为主工作区自己的页签（详情页内嵌的 Tabs 不算）。
    const handleContainerContextMenu = (e: ReactMouseEvent) => {
        const tabEl = (e.target as HTMLElement).closest?.('.ant-tabs-tab');
        if (!tabEl) return;
        const ownRoot = tabEl.closest('.ant-tabs');
        if (!ownRoot?.classList.contains('main-workspace-tabs')) return;
        const key = tabEl.getAttribute('data-node-key');
        if (!key || !tabs.some(t => t.id === key)) return;
        handleTabContextMenu(e, key);
    };

    // 右键菜单的键盘等价入口：ContextMenu 键或 Shift+F10 在当前页签下方展开同一份菜单，
    // 否则纯键盘用户永远打不开它（菜单项本身的方向键/Enter/Esc 由 ContextMenu 提供）。
    const handleContainerKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) {
            return;
        }
        const targetId = tabs.some(t => t.id === activeTabId) ? activeTabId : tabs[0]?.id;
        if (!targetId) {
            return;
        }
        e.preventDefault();
        const containerRect = containerRef.current?.getBoundingClientRect();
        const tabEl = containerRef.current?.querySelector<HTMLElement>(
            `.main-workspace-tabs .ant-tabs-tab[data-node-key="${CSS.escape(targetId)}"]`,
        );
        const tabRect = tabEl?.getBoundingClientRect();
        if (tabRect && containerRect) {
            openMenuAt(tabRect.left - containerRect.left, tabRect.bottom - containerRect.top + 4, targetId);
        } else {
            openMenuAt(8, 40, targetId);
        }
    };

    // 关闭除 targetKey 之外的全部标签页（首页始终保留）
    const closeOtherTabsThan = (targetKey: string) => {
        const tabsToClose = tabs.filter(t => t.id !== targetKey && t.id !== 'home');
        tabsToClose.forEach(t => removeTab(t.id));
    };

    // 循环切换到相邻标签页
    const activateAdjacentTab = (offset: number) => {
        if (tabs.length < 2) {
            return;
        }
        const index = tabs.findIndex(t => t.id === activeTabId);
        const next = (index + offset + tabs.length) % tabs.length;
        setActiveTab(tabs[next].id);
    };

    useCommand('closeTab', () => {
        if (activeTabId !== 'home') {
            removeTab(activeTabId);
        }
    });

    useCommand('nextTab', () => activateAdjacentTab(1));

    useCommand('prevTab', () => activateAdjacentTab(-1));

    useCommand('closeOtherTabs', () => closeOtherTabsThan(activeTabId));

    // 按 tab.type 渲染内容。
    // 不能用 tab.id 判断（`metrics` 是全局监控页，而 `metrics-<clusterId>` 是某个集群的
    // 监控页签），否则从资源树右键"查看监控"打开的页签会落到兜底的 TODO 分支上。
    const renderTabContent = (tab: (typeof tabs)[0]) => {
        switch (tab.type) {
            case 'home':
                return <HomePage />;
            case 'metrics':
                return <MetricsDashboard clusterId={tab.data?.clusterId} />;
            case 'alerts':
                return <AlertCenter />;
            case 'worker':
                return (
                    <WorkerCenter
                        clusterId={tab.data?.clusterId}
                        tenant={tab.data?.tenant}
                        namespace={tab.data?.namespace}
                    />
                );
            case 'topology':
                return <ClusterTopology clusterId={tab.data?.clusterId} />;
            case 'topic': {
                const {clusterId, tenant, namespace, topic, persistent} = tab.data || {};
                return (
                    <TopicDetail
                        clusterId={clusterId}
                        tenant={tenant}
                        namespace={namespace}
                        topic={topic}
                        persistent={persistent}
                    />
                );
            }
            case 'producer': {
                const {clusterId, tenant, namespace, topic, persistent} = tab.data || {};
                return (
                    <ProducerWorkspace
                        clusterId={clusterId}
                        tenant={tenant}
                        namespace={namespace}
                        topic={topic}
                        persistent={persistent}
                    />
                );
            }
            case 'consumer': {
                const {clusterId, tenant, namespace, topic, persistent} = tab.data || {};
                return (
                    <ConsumerWorkspace
                        clusterId={clusterId}
                        tenant={tenant}
                        namespace={namespace}
                        topic={topic}
                        persistent={persistent}
                    />
                );
            }
            case 'tenant': {
                const {clusterId, tenant} = tab.data || {};
                return <TenantDetail clusterId={clusterId} tenant={tenant} />;
            }
            case 'namespace': {
                const {clusterId, tenant, namespace} = tab.data || {};
                return <NamespaceDetail clusterId={clusterId} tenant={tenant} namespace={namespace} />;
            }
            case 'shortcuts':
                return <ShortcutConfig />;
            case 'config-center':
                return <ConfigCenter />;
            case 'plugins':
                return <PluginMarket />;
            default:
                return <div>TODO: {tab.title}</div>;
        }
    };

    const menuItems = (menu: TabMenuState): ContextMenuItem[] => {
        const targetKey = menu.tabKey;
        const targetIndex = tabs.findIndex(t => t.id === targetKey);
        const closableTabs = tabs.filter(t => t.id !== 'home');
        const othersCount = tabs.filter(t => t.id !== targetKey && t.id !== 'home').length;
        const rightCount = targetIndex < 0 ? 0 : tabs.slice(targetIndex + 1).filter(t => t.id !== 'home').length;
        return [
            {
                key: 'close-this',
                label: '关闭当前',
                danger: true,
                disabled: targetKey === 'home',
                onSelect: () => removeTab(targetKey),
            },
            {
                key: 'close-others',
                label: '关闭其他',
                disabled: othersCount === 0,
                onSelect: () => closeOtherTabsThan(targetKey),
            },
            {
                key: 'close-right',
                label: '关闭右侧',
                disabled: rightCount === 0,
                onSelect: () => {
                    tabs.slice(targetIndex + 1)
                        .filter(t => t.id !== 'home')
                        .forEach(t => removeTab(t.id));
                },
            },
            {
                key: 'close-all',
                label: '全部关闭',
                danger: true,
                disabled: closableTabs.length === 0,
                onSelect: () => closableTabs.forEach(t => removeTab(t.id)),
            },
        ];
    };

    return (
        <div
            ref={containerRef}
            onContextMenu={handleContainerContextMenu}
            onKeyDown={handleContainerKeyDown}
            style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                backgroundColor: 'var(--color-bg-base)',
                overflow: 'hidden',
                position: 'relative',
            }}
        >
            <Tabs
                rootClassName="main-workspace-tabs"
                type="editable-card"
                hideAdd
                activeKey={activeTabId}
                onChange={handleChange}
                onEdit={(targetKey, action) => handleEdit(targetKey, action)}
                items={tabs.map(tab => ({
                    key: tab.id,
                    label: <span>{tab.title}</span>,
                    closable: tab.id !== 'home',
                    // 非当前页签的处理器不注册快捷键，见 useKeybindings 的 PaneActiveContext。
                    children: (
                        <PaneActiveContext.Provider value={tab.id === activeTabId}>
                            {renderTabContent(tab)}
                        </PaneActiveContext.Provider>
                    ),
                }))}
                style={{
                    flex: 1,
                    // flex 项默认 min-height:auto，会被内容撑大；图表容器的高度又来自量出来的像素，
                    // 两者互相喂养就会棘轮式变大且收不回去。这里必须显式归零。
                    minHeight: 0,
                    margin: 0,
                    padding: 0,
                }}
                tabBarStyle={{
                    marginBottom: 0,
                    paddingLeft: 'var(--spacing-sm)',
                    height: 'var(--tab-height)',
                }}
            />

            {/* 右键上下文菜单 */}
            {tabContextMenu ? (
                <ContextMenu
                    x={tabContextMenu.x}
                    y={tabContextMenu.y}
                    items={menuItems(tabContextMenu)}
                    ariaLabel="页签操作菜单"
                    onClose={() => setTabContextMenu(null)}
                />
            ) : null}
        </div>
    );
};

export default TabWorkspace;
