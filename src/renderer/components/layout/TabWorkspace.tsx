import React, {useState, useEffect, useRef} from 'react';
import {Tabs, Tooltip} from 'antd';
import {useTabStore} from '../../store/tabs';
import HomePage from '../../pages/Home';
import TopicDetail from '../../pages/TopicDetail';
import TenantDetail from '../../pages/TenantDetail';
import NamespaceDetail from '../../pages/NamespaceDetail';
import MetricsDashboard from '../../pages/MetricsDashboard';
import ShortcutConfig from '../../pages/ShortcutConfig';
import ClusterTopology from '../../components/metrics/ClusterTopology';
import {useCommand} from '../../hooks/useKeybindings';

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
        setTabContextMenu({
            visible: true,
            x: e.clientX - offsetX,
            y: e.clientY - offsetY,
            tabKey,
        });
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

    // 关闭右侧标签页
    const handleCloseTabsToRight = () => {
        const tabIndex = tabs.findIndex(t => t.id === tabContextMenu.tabKey);
        const tabsToClose = tabs.slice(tabIndex + 1).filter(t => t.id !== 'home');
        tabsToClose.forEach(t => removeTab(t.id));
        setTabContextMenu({...tabContextMenu, visible: false});
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

    // 根据 tab 类型渲染内容
    const renderTabContent = (tab: (typeof tabs)[0]) => {
        if (tab.id === 'home') {
            return <HomePage />;
        }
        if (tab.id === 'metrics') {
            return <MetricsDashboard />;
        }
        if (tab.type === 'topology') {
            return <ClusterTopology clusterId={tab.data?.clusterId} />;
        }
        if (tab.type === 'topic') {
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
        if (tab.type === 'tenant') {
            const {clusterId, tenant} = tab.data || {};
            return <TenantDetail clusterId={clusterId} tenant={tenant} />;
        }
        if (tab.type === 'namespace') {
            const {clusterId, tenant, namespace} = tab.data || {};
            return <NamespaceDetail clusterId={clusterId} tenant={tenant} namespace={namespace} />;
        }
        if (tab.type === 'shortcuts') {
            return <ShortcutConfig />;
        }
        return <div>TODO: {tab.title}</div>;
    };

    return (
        <div
            ref={containerRef}
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
                type="editable-card"
                hideAdd
                activeKey={activeTabId}
                onChange={handleChange}
                onEdit={(targetKey, action) => handleEdit(targetKey, action)}
                items={tabs.map(tab => ({
                    key: tab.id,
                    label: tab.id === 'home' ? <Tooltip title="首页">{tab.title}</Tooltip> : tab.title,
                    closable: tab.id !== 'home',
                    children: renderTabContent(tab),
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
                onTabClick={(key, e) => {
                    // 拦截右键事件以显示上下文菜单
                    if (e.nativeEvent instanceof MouseEvent && e.nativeEvent.button === 2) {
                        handleTabContextMenu(e as unknown as React.MouseEvent, key);
                    }
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
                    <div
                        style={{
                            padding: '5px 12px',
                            cursor: 'pointer',
                            fontSize: 14,
                            lineHeight: '22px',
                            transition: 'background 0.2s',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-fill-secondary, #f5f5f5)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        onClick={handleCloseOtherTabs}
                    >
                        关闭其他标签页
                    </div>
                    <div
                        style={{
                            padding: '5px 12px',
                            cursor: 'pointer',
                            fontSize: 14,
                            lineHeight: '22px',
                            transition: 'background 0.2s',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-fill-secondary, #f5f5f5)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        onClick={handleCloseTabsToRight}
                    >
                        关闭右侧标签页
                    </div>
                </div>
            )}
        </div>
    );
};

export default TabWorkspace;
