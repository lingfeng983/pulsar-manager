import React, {useState, useEffect, useRef} from 'react';
import {Tabs} from 'antd';
import {useTabStore} from '../../store/tabs';
import HomePage from '../../pages/Home';
import TopicDetail from '../../pages/TopicDetail';
import TenantDetail from '../../pages/TenantDetail';
import NamespaceDetail from '../../pages/NamespaceDetail';
import MetricsDashboard from '../../pages/MetricsDashboard';
import ShortcutConfig from '../../pages/ShortcutConfig';
import ConfigCenter from '../../pages/ConfigCenter';
import PluginMarket from '../../pages/PluginMarket';
import ClusterTopology from '../../components/metrics/ClusterTopology';
import {useCommand, PaneActiveContext} from '../../hooks/useKeybindings';

const TabWorkspace: React.FC = () => {
    const {tabs, activeTabId, setActiveTab, removeTab} = useTabStore();
    const containerRef = useRef<HTMLDivElement>(null);

    // 右键菜单状态
    const [tabContextMenu, setTabContextMenu] = useState<{visible: boolean; x: number; y: number; tabKey: string}>({
        visible: false,
        x: 0,
        y: 0,
        tabKey: '',
    });

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

    // 右键点击 tab 处理
    const handleTabContextMenu = (e: React.MouseEvent, tabKey: string) => {
        e.preventDefault();
        e.stopPropagation();
        const containerRect = containerRef.current?.getBoundingClientRect();
        const offsetX = containerRect ? containerRect.left : 0;
        const offsetY = containerRect ? containerRect.top : 0;
        // 菜单最宽约 160px、4 项约 116px，靠近容器右/下边缘时向内收，避免溢出被裁剪。
        const MENU_WIDTH = 160;
        const MENU_HEIGHT = 116;
        const maxX = (containerRect?.width ?? window.innerWidth) - MENU_WIDTH - 4;
        const maxY = (containerRect?.height ?? window.innerHeight) - MENU_HEIGHT - 4;
        setTabContextMenu({
            visible: true,
            x: Math.max(4, Math.min(e.clientX - offsetX, maxX)),
            y: Math.max(4, Math.min(e.clientY - offsetY, maxY)),
            tabKey,
        });
    };

    // 在整个工作区容器上兜住 contextmenu：右键命中页签任意位置（含 padding/关闭钮）都能弹菜单，
    // 通过 data-node-key 反查是否为主工作区自己的页签（详情页内嵌的 Tabs 不算）。
    const handleContainerContextMenu = (e: React.MouseEvent) => {
        const tabEl = (e.target as HTMLElement).closest?.('.ant-tabs-tab');
        if (!tabEl) return;
        const ownRoot = tabEl.closest('.ant-tabs');
        if (!ownRoot?.classList.contains('main-workspace-tabs')) return;
        const key = tabEl.getAttribute('data-node-key');
        if (!key || !tabs.some(t => t.id === key)) return;
        handleTabContextMenu(e, key);
    };

    // 关闭除 targetKey 之外的全部标签页（首页始终保留）
    const closeOtherTabsThan = (targetKey: string) => {
        const tabsToClose = tabs.filter(t => t.id !== targetKey && t.id !== 'home');
        tabsToClose.forEach(t => removeTab(t.id));
    };

    // 关闭其他标签页
    const handleCloseOtherTabs = () => {
        closeOtherTabsThan(tabContextMenu.tabKey);
        setTabContextMenu({...tabContextMenu, visible: false});
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

    // 关闭右侧标签页（右键命中的页签可能已经被别处关掉，找不到下标就别动）
    const handleCloseTabsToRight = () => {
        const tabIndex = tabs.findIndex(t => t.id === tabContextMenu.tabKey);
        if (tabIndex < 0) {
            setTabContextMenu(prev => ({...prev, visible: false}));
            return;
        }
        const tabsToClose = tabs.slice(tabIndex + 1).filter(t => t.id !== 'home');
        tabsToClose.forEach(t => removeTab(t.id));
        setTabContextMenu(prev => ({...prev, visible: false}));
    };

    // 关闭当前右键命中的标签页（首页不可关闭）
    const handleCloseThisTab = () => {
        const targetKey = tabContextMenu.tabKey;
        if (targetKey !== 'home' && tabs.some(t => t.id === targetKey)) {
            removeTab(targetKey);
        }
        setTabContextMenu(prev => ({...prev, visible: false}));
    };

    // 关闭全部标签页（保留首页）
    const handleCloseAllTabs = () => {
        tabs.filter(t => t.id !== 'home').forEach(t => removeTab(t.id));
        setTabContextMenu(prev => ({...prev, visible: false}));
    };

    // 点击外部区域关闭右键菜单
    useEffect(() => {
        const handleClickOutside = () => {
            if (tabContextMenu.visible) {
                setTabContextMenu(prev => ({...prev, visible: false}));
            }
        };
        document.addEventListener('click', handleClickOutside);
        return () => document.removeEventListener('click', handleClickOutside);
    }, [tabContextMenu.visible]);

    // Esc 收起右键菜单
    useEffect(() => {
        if (!tabContextMenu.visible) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setTabContextMenu(prev => ({...prev, visible: false}));
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [tabContextMenu.visible]);

    // 按 tab.type 渲染内容。
    // 不能用 tab.id 判断（`metrics` 是全局监控页签，而 `metrics-<clusterId>` 是某个集群的
    // 监控页签），否则从资源树右键"查看监控"打开的页签会落到兜底的 TODO 分支上。
    const renderTabContent = (tab: (typeof tabs)[0]) => {
        switch (tab.type) {
            case 'home':
                return <HomePage />;
            case 'metrics':
                return <MetricsDashboard clusterId={tab.data?.clusterId} />;
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

    return (
        <div
            ref={containerRef}
            onContextMenu={handleContainerContextMenu}
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
            {tabContextMenu.visible && (
                <div
                    style={{
                        position: 'absolute',
                        left: tabContextMenu.x,
                        top: tabContextMenu.y,
                        zIndex: 1050,
                        background: 'var(--color-bg-container, #fff)',
                        border: '1px solid var(--color-border, #d9d9d9)',
                        borderRadius: 6,
                        boxShadow: '0 6px 16px 0 rgba(0, 0, 0, 0.08), 0 3px 6px -4px rgba(0, 0, 0, 0.12)',
                        padding: '4px 0',
                        minWidth: 160,
                    }}
                    onClick={e => e.stopPropagation()}
                >
                    {(() => {
                        const targetKey = tabContextMenu.tabKey;
                        const targetIndex = tabs.findIndex(t => t.id === targetKey);
                        const closableTabs = tabs.filter(t => t.id !== 'home');
                        const othersCount = tabs.filter(t => t.id !== targetKey && t.id !== 'home').length;
                        const rightCount = tabs.slice(targetIndex + 1).filter(t => t.id !== 'home').length;

                        const itemStyle = (enabled: boolean): React.CSSProperties => ({
                            padding: '5px 12px',
                            cursor: enabled ? 'pointer' : 'not-allowed',
                            fontSize: 14,
                            lineHeight: '22px',
                            transition: 'background 0.2s',
                            color: enabled ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                            opacity: enabled ? 1 : 0.5,
                        });

                        const renderItem = (label: string, enabled: boolean, onClick: () => void, danger = false) => {
                            const style: React.CSSProperties = {...itemStyle(enabled)};
                            if (danger && enabled) {
                                style.color = 'var(--color-error, #ff4d4f)';
                            }
                            return (
                                <div
                                    key={label}
                                    style={style}
                                    onMouseEnter={e => {
                                        if (enabled) {
                                            e.currentTarget.style.background = 'var(--color-fill-secondary, #f5f5f5)';
                                        }
                                    }}
                                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                                    onClick={() => {
                                        if (enabled) {
                                            onClick();
                                        }
                                    }}
                                >
                                    {label}
                                </div>
                            );
                        };

                        return (
                            <>
                                {renderItem('关闭当前', targetKey !== 'home', handleCloseThisTab, true)}
                                {renderItem('关闭其他', othersCount > 0, handleCloseOtherTabs)}
                                {renderItem('关闭右侧', rightCount > 0, handleCloseTabsToRight)}
                                {renderItem('全部关闭', closableTabs.length > 0, handleCloseAllTabs, true)}
                            </>
                        );
                    })()}
                </div>
            )}
        </div>
    );
};

export default TabWorkspace;
