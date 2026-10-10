import React, {useState, useCallback, useEffect, useRef} from 'react';
import {Button, Dropdown, Space, message, Modal, AutoComplete, Tag, Tooltip} from 'antd';
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
} from '@ant-design/icons';
import {useThemeStore} from '../../store/theme';
import UpdateModal from '../UpdateModal';
import BenchmarkModal from '../BenchmarkModal';
import {useTabStore} from '../../store/tabs';
import {useClusterStore} from '../../store/cluster';
import {loadTenants, loadNamespaces, loadTopics} from '../../hooks/resourceCache';
import {shortName} from '../../utils/format';
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
    const [searchValue, setSearchValue] = useState('');
    const [aboutModalOpen, setAboutModalOpen] = useState(false);
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [searchLoading, setSearchLoading] = useState(false);
    const searchRef = useRef<any>(null);
    const searchRequestRef = useRef(0);
    const [appVersion, setAppVersion] = useState('1.0.0');
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
                const lower = keyword.toLowerCase();
                const full = () => results.length >= SEARCH_RESULT_LIMIT || isStale();

                // 搜索集群
                clusters.forEach(cluster => {
                    if (results.length >= SEARCH_RESULT_LIMIT) {
                        return;
                    }
                    if (cluster.name.toLowerCase().includes(lower)) {
                        results.push({
                            key: `cluster-${cluster.id}`,
                            label: `${cluster.name}`,
                            type: 'cluster',
                            data: {clusterId: cluster.id},
                        });
                    }
                });

                // 搜索租户、命名空间、Topic（走共享缓存，避免每次输入都重新打全量请求）
                for (const cluster of clusters) {
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
                            if (tenant.name.toLowerCase().includes(lower)) {
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
                                    const nsName = shortName(namespace);
                                    if (nsName.toLowerCase().includes(lower)) {
                                        results.push({
                                            key: `namespace-${cluster.id}-${tenant.name}-${nsName}`,
                                            label: `${cluster.name} / ${tenant.name} / ${nsName}`,
                                            type: 'namespace',
                                            data: {clusterId: cluster.id, tenant: tenant.name, namespace: nsName},
                                        });
                                    }

                                    // 搜索 Topic
                                    try {
                                        const topics = await loadTopics(cluster.id, tenant.name, nsName);
                                        if (isStale()) {
                                            return;
                                        }
                                        for (const topic of topics) {
                                            if (full()) {
                                                break;
                                            }
                                            const topicName = shortName(topic.name);
                                            if (topicName.toLowerCase().includes(lower)) {
                                                results.push({
                                                    key: `topic-${cluster.id}-${tenant.name}-${nsName}-${topicName}`,
                                                    label: [cluster.name, tenant.name, nsName, topicName].join(' / '),
                                                    type: 'topic',
                                                    data: {
                                                        clusterId: cluster.id,
                                                        tenant: tenant.name,
                                                        namespace: nsName,
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
        [clusters],
    );

    // 处理搜索变化
    useEffect(() => {
        if (searchValue.trim()) {
            const timer = setTimeout(() => searchResources(searchValue), 300);
            return () => clearTimeout(timer);
        } else {
            setSearchResults([]);
        }
    }, [searchValue, searchResources]);

    // 处理搜索结果点击
    const handleSearchSelect = (value: string) => {
        const result = searchResults.find(r => r.key === value);
        if (!result) return;

        switch (result.type) {
            case 'cluster':
                addTab({
                    id: `topology-${result.data?.clusterId}`,
                    title: `${result.data?.clusterId} - 拓扑`,
                    type: 'topology',
                    data: {clusterId: result.data?.clusterId},
                });
                break;
            case 'tenant':
                addTab({
                    id: `tenant-${result.data?.clusterId}-${result.data?.tenant}`,
                    title: `${result.data?.tenant}`,
                    type: 'tenant',
                    data: {clusterId: result.data?.clusterId, tenant: result.data?.tenant},
                });
                break;
            case 'namespace':
                addTab({
                    id: `namespace-${result.data?.clusterId}-${result.data?.tenant}-${result.data?.namespace}`,
                    title: `${result.data?.namespace}`,
                    type: 'namespace',
                    data: {
                        clusterId: result.data?.clusterId,
                        tenant: result.data?.tenant,
                        namespace: result.data?.namespace,
                    },
                });
                break;
            case 'topic': {
                const {clusterId, tenant, namespace, topic, persistent} = result.data || {};
                if (clusterId && tenant && namespace && topic) {
                    addTab({
                        id: `topic-${clusterId}-${tenant}-${namespace}-${topic}`,
                        title: topic,
                        type: 'topic',
                        data: {clusterId, tenant, namespace, topic, persistent},
                    });
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

    // 检查更新：真实流程收敛到 UpdateModal（检查/令牌/下载/安装）
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
                message.info('功能即将推出，敬请期待');
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
                        快捷键设置 <Tag style={{fontSize: 10}}>{formatBinding(shortcutBinding, platform)}</Tag>
                    </span>
                ),
            },
            {
                key: 'plugins',
                label: (
                    <span>
                        插件市场{' '}
                        <Tag color="default" style={{fontSize: 10}}>
                            Coming Soon
                        </Tag>
                    </span>
                ),
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
            {/* Logo 区域 */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--spacing-sm)',
                    fontWeight: 600,
                    fontSize: '16px',
                    color: 'var(--color-primary)',
                    minWidth: '200px',
                }}
            >
                <span style={{fontSize: '20px'}}>⚡</span>
                <span>Pulsar Manager</span>
            </div>

            {/* 全局搜索框 */}
            <AutoComplete
                ref={searchRef}
                prefix={<SearchOutlined />}
                placeholder="搜索集群、租户、Topic... (Ctrl/Cmd+K)"
                value={searchValue}
                onChange={value => setSearchValue(value)}
                onSelect={handleSearchSelect}
                notFoundContent={searchLoading ? '搜索中...' : '未找到匹配结果'}
                style={{
                    width: '320px',
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

            {/* 右侧工具区 */}
            <div style={{flex: 1}} />

            <Space size="small">
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
                    <div style={{fontSize: 48, marginBottom: 16}}>⚡</div>
                    <h3 style={{marginBottom: 8}}>Pulsar Manager</h3>
                    <p style={{color: 'var(--color-text-secondary)', fontSize: 13}}>版本 {appVersion}</p>
                    <div style={{marginTop: 20, textAlign: 'left', color: 'var(--color-text-primary)', fontSize: 13}}>
                        <p>一个功能强大的 Apache Pulsar 桌面管理工具。</p>
                        <p style={{marginTop: 8}}>支持集群管理、资源浏览、消息查看、监控分析等功能。</p>
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
