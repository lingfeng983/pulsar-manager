import React, {useState, useCallback, useEffect, useRef} from 'react';
import {Button, Dropdown, Space, message, Modal, AutoComplete, Tag, Tooltip, Badge} from 'antd';
import {
    SearchOutlined,
    ThunderboltOutlined,
    ExportOutlined,
    SettingOutlined,
    MoonOutlined,
    SunOutlined,
    EyeOutlined,
    DatabaseOutlined,
    FolderOutlined,
    FileTextOutlined,
    BarChartOutlined,
    ApartmentOutlined,
    FunctionOutlined,
    AlertOutlined,
    SafetyCertificateOutlined,
    MenuFoldOutlined,
    MenuUnfoldOutlined,
} from '@ant-design/icons';
import {useThemeStore} from '../../store/theme';
import UpdateModal from '../UpdateModal';
import BenchmarkModal from '../BenchmarkModal';
import IconButton from '../common/IconButton';
import {useTabStore} from '../../store/tabs';
import {useClusterStore} from '../../store/cluster';
import {useAlertStore} from '../../store/alerts';
import {useLayoutStore} from '../../store/layout';
import {loadTenants, loadNamespaces, loadTopics} from '../../hooks/resourceCache';
import {shortName} from '../../utils/format';
import {
    topicTab,
    tenantTab,
    namespaceTab,
    topologyTab,
    metricsTab,
    alertTab,
    workerTab,
    inspectionTab,
} from '../../utils/tabIds';
import {matchesFilter} from '../../utils/textFilter';
import {downloadBlob} from '../../utils/download';
import {useCommand} from '../../hooks/useKeybindings';
import {useShortcutStore, resolveBinding} from '../../store/shortcuts';
import {formatBinding} from '../../utils/keybinding';

interface SearchResult {
    key: string;
    label: string;
    type: 'cluster' | 'tenant' | 'namespace' | 'topic';
    data?: {
        clusterId?: string;
        tenant?: string;
        namespace?: string;
        topic?: string;
        persistent?: boolean;
    };
}

// 搜索结果达到这个数量就停止继续扇出请求：全集群深度遍历的代价
// 只在需要更多结果时才付
const SEARCH_RESULT_LIMIT = 20;

const TopNav: React.FC = () => {
    const {theme, setTheme} = useThemeStore();
    const {addTab} = useTabStore();
    const {clusters} = useClusterStore();
    const sidebarCollapsed = useLayoutStore(state => state.sidebarCollapsed);
    const toggleSidebar = useLayoutStore(state => state.toggleSidebar);
    // 集群列表收进 ref：扇出搜索读最新值，但不把它放进 searchResources 依赖。否则任何
    // 一次集群探活写回都会换掉 clusters 数组，把防抖 effect 重新触发一遍、重发跨集群 IPC。
    const clustersRef = useRef(clusters);
    clustersRef.current = clusters;
    const [searchValue, setSearchValue] = useState('');
    const [aboutModalOpen, setAboutModalOpen] = useState(false);
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [searchLoading, setSearchLoading] = useState(false);
    const searchRef = useRef<any>(null);
    const searchRequestRef = useRef(0);
    // 初值不写死版本号：写死的那份会一直挂在弹窗上，IPC 失败时用户看到的就是个假版本
    const [appVersion, setAppVersion] = useState('');
    const platform = useShortcutStore(state => state.platform);
    const shortcutConfig = useShortcutStore(state => state.config);
    const shortcutBinding = resolveBinding(shortcutConfig, platform, 'openShortcutConfig');

    // 聚焦搜索由可绑定的 focusSearch 命令提供，绑定取自用户配置。
    useCommand('focusSearch', () => {
        searchRef.current?.focus();
    });

    // Escape 清空搜索属于弹层收起约定，不作为用户可配置快捷键。
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setSearchValue('');
                setSearchResults([]);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    // 动态获取应用版本号
    useEffect(() => {
        window.electronAPI.update
            .getVersion()
            .then(res => {
                if (res.success && res.data) setAppVersion(res.data);
            })
            .catch(() => {});
    }, []);

    // 搜索资源
    const searchResources = useCallback(
        async (keyword: string) => {
            // 单调递增的请求代次：逐键触发搜索时，旧请求晚到不能覆盖新结果
            const requestId = ++searchRequestRef.current;
            const isStale = () => requestId !== searchRequestRef.current;

            if (!keyword.trim()) {
                setSearchResults([]);
                return;
            }

            setSearchLoading(true);
            try {
                const results: SearchResult[] = [];
                const full = () => results.length >= SEARCH_RESULT_LIMIT || isStale();

                // 搜索集群
                clustersRef.current.forEach(cluster => {
                    if (results.length >= SEARCH_RESULT_LIMIT) {
                        return;
                    }
                    if (matchesFilter([cluster.name, cluster.serviceUrl], keyword)) {
                        results.push({
                            key: `cluster-${cluster.id}`,
                            label: `${cluster.name}`,
                            type: 'cluster',
                            data: {clusterId: cluster.id},
                        });
                    }
                });

                // 搜索租户、命名空间、Topic（走共享缓存，避免每次输入都重新打全量请求）
                for (const cluster of clustersRef.current) {
                    if (full()) {
                        break;
                    }
                    if (cluster.status !== 'connected') {
                        continue;
                    }

                    try {
                        const tenants = await loadTenants(cluster.id);
                        if (isStale()) {
                            return;
                        }
                        for (const tenant of tenants) {
                            if (full()) {
                                break;
                            }
                            if (matchesFilter([tenant.name], keyword)) {
                                results.push({
                                    key: `tenant-${cluster.id}-${tenant.name}`,
                                    label: `${cluster.name} / ${tenant.name}`,
                                    type: 'tenant',
                                    data: {clusterId: cluster.id, tenant: tenant.name},
                                });
                            }

                            // 搜索命名空间
                            try {
                                const namespaces = await loadNamespaces(cluster.id, tenant.name);
                                if (isStale()) {
                                    return;
                                }
                                for (const namespace of namespaces) {
                                    if (full()) {
                                        break;
                                    }
                                    // 主进程已把 "tenant/ns" 剥成裸命名空间名，这里不能再 shortName，
                                    // 否则多层命名空间（a/b）会被截成 b，取 Topic 时与资源树对不上。
                                    if (matchesFilter([namespace], keyword)) {
                                        results.push({
                                            key: `namespace-${cluster.id}-${tenant.name}-${namespace}`,
                                            label: `${cluster.name} / ${tenant.name} / ${namespace}`,
                                            type: 'namespace',
                                            data: {clusterId: cluster.id, tenant: tenant.name, namespace},
                                        });
                                    }

                                    // 搜索 Topic
                                    try {
                                        const topics = await loadTopics(cluster.id, tenant.name, namespace);
                                        if (isStale()) {
                                            return;
                                        }
                                        for (const topic of topics) {
                                            if (full()) {
                                                break;
                                            }
                                            const topicName = shortName(topic.name);
                                            if (matchesFilter([topicName], keyword)) {
                                                results.push({
                                                    key: `topic-${cluster.id}-${tenant.name}-${namespace}-${
                                                        topic.persistent ? 'p' : 'n'
                                                    }-${topicName}`,
                                                    label: [cluster.name, tenant.name, namespace, topicName].join(
                                                        ' / ',
                                                    ),
                                                    type: 'topic',
                                                    data: {
                                                        clusterId: cluster.id,
                                                        tenant: tenant.name,
                                                        namespace,
                                                        topic: topicName,
                                                        persistent: topic.persistent,
                                                    },
                                                });
                                            }
                                        }
                                    } catch {
                                        // 单个命名空间取 Topic 失败不影响其余结果
                                    }
                                }
                            } catch {
                                // 单个租户取命名空间失败不影响其余结果
                            }
                        }
                    } catch {
                        // 单个集群搜索失败不影响其余集群
                    }
                }

                if (isStale()) {
                    return;
                }
                setSearchResults(results.slice(0, SEARCH_RESULT_LIMIT));
            } catch (error) {
                console.error('Search error:', error);
            } finally {
                if (!isStale()) {
                    setSearchLoading(false);
                }
            }
        },
        // 只读 ref、setter 与模块函数，全部稳定：身份不变，防抖 effect 才不会被集群
        // 探活写回带着重跑。
        [],
    );

    // 处理搜索变化
    useEffect(() => {
        if (searchValue.trim()) {
            const timer = setTimeout(() => searchResources(searchValue), 300);
            return () => clearTimeout(timer);
        }
        // 清空输入也要作废在途请求（含 Escape 与选中结果后的清空），否则晚到的响应当
        // 前一代次仍被视为"最新"，会把已经清空的下拉重新填回结果。
        searchRequestRef.current += 1;
        setSearchLoading(false);
        setSearchResults([]);
    }, [searchValue, searchResources]);

    // 处理搜索结果点击
    const handleSearchSelect = (value: string) => {
        const result = searchResults.find(r => r.key === value);
        if (!result) return;

        switch (result.type) {
            case 'cluster': {
                const clusterId = result.data?.clusterId ?? '';
                addTab(topologyTab(clusterId, clusters.find(c => c.id === clusterId)?.name));
                break;
            }
            case 'tenant':
                addTab(tenantTab(result.data?.clusterId ?? '', result.data?.tenant ?? ''));
                break;
            case 'namespace':
                addTab(
                    namespaceTab(result.data?.clusterId ?? '', result.data?.tenant ?? '', result.data?.namespace ?? ''),
                );
                break;
            case 'topic': {
                const {clusterId, tenant, namespace, topic, persistent} = result.data || {};
                if (clusterId && tenant && namespace && topic) {
                    addTab(topicTab({clusterId, tenant, namespace, topic, persistent}));
                }
                break;
            }
        }
        setSearchValue('');
        setSearchResults([]);
    };

    // 获取搜索结果图标
    const getSearchIcon = (type: SearchResult['type']) => {
        switch (type) {
            case 'cluster':
                return <DatabaseOutlined style={{color: 'var(--color-primary)', marginRight: 8}} />;
            case 'tenant':
                return <FolderOutlined style={{color: 'var(--color-success)', marginRight: 8}} />;
            case 'namespace':
                return <FolderOutlined style={{color: 'var(--color-warning)', marginRight: 8}} />;
            case 'topic':
                // Intentionally using Ant Design purple (#722ed1) - no CSS variable needed
                return <FileTextOutlined style={{color: '#722ed1', marginRight: 8}} />;
        }
    };

    // 快速压测：参数与实时进度都在弹窗里，压测本体跑在主进程，关闭弹窗不中断
    const [benchmarkOpen, setBenchmarkOpen] = useState(false);

    // 监控仪表盘（全局页签：跨集群自动选一个已连接集群）
    const handleOpenMetrics = useCallback(() => {
        addTab(metricsTab());
    }, [addTab]);

    // 集群拓扑（全局页签：多集群同屏，页签 id 统一由 topologyTab 拼装）
    const handleOpenTopology = useCallback(() => {
        addTab(topologyTab());
    }, [addTab]);

    // 函数与连接器：不带集群打开时页面自己落到第一个集群，
    // 顶栏这个入口是「想看 worker」而不是「想看某个集群的 worker」。
    const handleOpenWorker = useCallback(() => {
        addTab(workerTab());
    }, [addTab]);

    // 集群巡检：不带集群打开时页面自己落到第一个集群，和 worker 入口同一个口径。
    const handleOpenInspection = useCallback(() => {
        addTab(inspectionTab());
    }, [addTab]);

    // 告警中心：徽标是"未恢复事件数"，点开页面并不清空它——
    // 事件要在告警中心里逐条确认或等它自动恢复，徽标跟着界面走才会误导。
    const openAlertCount = useAlertStore(state => state.openCount);
    const handleOpenAlerts = useCallback(() => {
        addTab(alertTab());
    }, [addTab]);

    // 导出日志
    const handleExportLogs = async () => {
        try {
            const response = await window.electronAPI.logs.getRecent(100);
            if (response.success && response.data) {
                downloadBlob(
                    JSON.stringify(response.data, null, 2),
                    `logs_${new Date().toISOString().slice(0, 10)}.json`,
                );
                message.success('日志导出成功');
            } else {
                message.error(response.error || '导出失败');
            }
        } catch {
            message.error('导出失败');
        }
    };

    // 检查更新：真实流程收敛到 UpdateModal（检查/下载/安装）
    const [updateModalOpen, setUpdateModalOpen] = useState(false);

    // 设置菜单点击处理
    const handleSettingClick = ({key}: {key: string}) => {
        switch (key) {
            case 'config':
                addTab({id: 'config-center', title: '配置中心', type: 'config-center'});
                break;
            case 'shortcuts':
                addTab({id: 'shortcuts', title: '快捷键配置', type: 'shortcuts'});
                break;
            case 'plugins':
                addTab({id: 'plugins', title: '插件市场', type: 'plugins'});
                break;
            case 'about':
                setAboutModalOpen(true);
                break;
            case 'checkUpdate':
                setUpdateModalOpen(true);
                break;
        }
    };

    // 主题切换菜单
    const themeMenu = {
        items: [
            {
                key: 'light',
                label: '亮色主题',
                icon: <SunOutlined />,
                onClick: () => setTheme('light'),
            },
            {
                key: 'dark',
                label: '暗色主题',
                icon: <MoonOutlined />,
                onClick: () => setTheme('dark'),
            },
            {
                key: 'eyeCare',
                label: '护眼主题',
                icon: <EyeOutlined />,
                onClick: () => setTheme('eyeCare'),
            },
        ],
    };

    // 设置菜单
    const settingMenu = {
        items: [
            {
                key: 'config',
                label: <span>配置中心</span>,
            },
            {
                key: 'shortcuts',
                label: (
                    <span>
                        快捷键设置{' '}
                        <Tag style={{fontSize: 'calc(var(--font-size-xs) - 2px)'}}>
                            {formatBinding(shortcutBinding, platform)}
                        </Tag>
                    </span>
                ),
            },
            {
                key: 'plugins',
                label: <span>插件市场</span>,
            },
            {type: 'divider' as const},
            {key: 'about', label: '关于'},
            {key: 'checkUpdate', label: '检查更新'},
        ],
        onClick: handleSettingClick,
    };

    return (
        <div
            style={{
                height: 'var(--header-height)',
                backgroundColor: 'var(--color-bg-elevated)',
                borderBottom: '1px solid var(--color-border)',
                display: 'flex',
                alignItems: 'center',
                padding: '0 var(--spacing-lg)',
                gap: 'var(--spacing-md)',
                boxShadow: 'var(--shadow-light)',
                zIndex: 1000,
            }}
        >
            {/* 左侧操作区：原来压在侧边栏顶部的 监控/拓扑/折叠 三个按钮。
                与右侧工具区同为 flex:1 1 0，两半等宽才能把搜索框顶在正中；
                折叠态这里只剩一个展开按钮，不再跟着 40px 窄栏走宽度。 */}
            <div
                style={{
                    flex: '1 1 0',
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--spacing-xs)',
                }}
            >
                {sidebarCollapsed ? (
                    <IconButton size="small" icon={<MenuUnfoldOutlined />} label="展开资源树" onClick={toggleSidebar} />
                ) : (
                    <>
                        <Button size="small" icon={<BarChartOutlined />} title="监控仪表盘" onClick={handleOpenMetrics}>
                            监控
                        </Button>
                        <Button size="small" icon={<ApartmentOutlined />} title="集群拓扑" onClick={handleOpenTopology}>
                            拓扑
                        </Button>
                        <Button
                            size="small"
                            icon={<FunctionOutlined />}
                            title="函数与连接器"
                            onClick={handleOpenWorker}
                        >
                            函数
                        </Button>
                        <Button
                            size="small"
                            icon={<SafetyCertificateOutlined />}
                            title="集群巡检"
                            onClick={handleOpenInspection}
                        >
                            巡检
                        </Button>
                        <Button
                            size="small"
                            icon={
                                <Badge count={openAlertCount} size="small" offset={[2, -2]}>
                                    <AlertOutlined />
                                </Badge>
                            }
                            title="告警中心"
                            onClick={handleOpenAlerts}
                        >
                            告警
                        </Button>
                        <IconButton
                            size="small"
                            icon={<MenuFoldOutlined />}
                            label="折叠侧边栏"
                            onClick={toggleSidebar}
                        />
                    </>
                )}
            </div>

            {/* 全局搜索框：宽度按窗口比例走，窗口拉大它就跟着变宽，不再固定 280px */}
            <AutoComplete
                ref={searchRef}
                prefix={<SearchOutlined />}
                placeholder="搜索集群、租户、Topic... (Ctrl/Cmd+K)"
                value={searchValue}
                onChange={value => setSearchValue(value)}
                onSelect={handleSearchSelect}
                notFoundContent={searchLoading ? '搜索中...' : '未找到匹配结果'}
                style={{
                    // 26% 的上限是按最小窗口 1000px 算的：两侧工具区各自约 330px，
                    // 搜索框再宽就要把右边的按钮挤出去。
                    width: 'clamp(200px, 26%, 520px)',
                    borderRadius: 'var(--radius-md)',
                }}
                options={searchResults.map(result => ({
                    value: result.key,
                    label: (
                        <div style={{display: 'flex', alignItems: 'center'}}>
                            {getSearchIcon(result.type)}
                            <span>{result.label}</span>
                        </div>
                    ),
                }))}
            />

            {/* 右侧工具区：与左侧同宽（flex 1 1 0），内容靠右排 */}
            <div style={{flex: '1 1 0', minWidth: 0, display: 'flex', justifyContent: 'flex-end'}}>
                <Space size={4}>
                    {/* 快速压测 */}
                    <Tooltip title="向指定 Topic 并发写入，实时看吞吐与发送确认延迟">
                        <Button icon={<ThunderboltOutlined />} size="small" onClick={() => setBenchmarkOpen(true)}>
                            快速压测
                        </Button>
                    </Tooltip>

                    {/* 日志导出 */}
                    <Button icon={<ExportOutlined />} size="small" onClick={handleExportLogs}>
                        导出日志
                    </Button>

                    {/* 主题切换 */}
                    <Dropdown menu={themeMenu} trigger={['click']} placement="bottomRight">
                        <Button size="small" icon={theme === 'dark' ? <MoonOutlined /> : <SunOutlined />}>
                            主题
                        </Button>
                    </Dropdown>

                    {/* 设置菜单 */}
                    <Dropdown menu={settingMenu} trigger={['click']} placement="bottomRight">
                        <Button icon={<SettingOutlined />} size="small">
                            设置
                        </Button>
                    </Dropdown>
                </Space>
            </div>

            {/* 关于弹窗 */}
            <Modal
                title="关于 Pulsar Manager"
                open={aboutModalOpen}
                onCancel={() => setAboutModalOpen(false)}
                footer={[
                    <Button key="ok" type="primary" onClick={() => setAboutModalOpen(false)}>
                        确定
                    </Button>,
                ]}
            >
                <div style={{textAlign: 'center'}}>
                    <div style={{fontSize: 32, marginBottom: 'var(--spacing-sm)'}}>⚡</div>
                    <h3 style={{marginBottom: 'var(--spacing-sm)'}}>Pulsar Manager</h3>
                    <p className="hint-text">版本 {appVersion || '读取中'}</p>
                    <div style={{marginTop: 'var(--spacing-xl)', textAlign: 'left'}}>
                        <p>一个功能强大的 Apache Pulsar 桌面管理工具。</p>
                        <p style={{marginTop: 'var(--spacing-sm)'}}>
                            支持集群管理、资源浏览、消息查看、监控分析等功能。
                        </p>
                    </div>
                </div>
            </Modal>

            {/* 软件更新弹窗 */}
            <UpdateModal open={updateModalOpen} onClose={() => setUpdateModalOpen(false)} />
            <BenchmarkModal open={benchmarkOpen} onClose={() => setBenchmarkOpen(false)} />
        </div>
    );
};

export default TopNav;
