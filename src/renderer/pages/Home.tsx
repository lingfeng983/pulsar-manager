import React, {useEffect, useMemo, useState} from 'react';
import {Card, Table, Tag, Button, Input, Select, Space, Switch, message} from 'antd';
import {ClusterOutlined, PlusOutlined, BarChartOutlined, AppstoreOutlined, ReloadOutlined} from '@ant-design/icons';
import {useClusterStore} from '../store/cluster';
import ClusterConfigModal from './ClusterConfig';
import HomeTopology from '../components/HomeTopology';
import PageShell from '../components/common/PageShell';
import StateBlock from '../components/common/StateBlock';
import ErrorBanner from '../components/common/ErrorBanner';
import {useConfirmDanger} from '../components/common/dangerConfirm';
import type {ClusterConfig} from '../types';
import {useCommand} from '../hooks/useKeybindings';

type StatusFilter = 'all' | 'connected' | 'warning' | 'disconnected';

const STATUS_OPTIONS: {label: string; value: StatusFilter}[] = [
    {label: '全部状态', value: 'all'},
    {label: '在线', value: 'connected'},
    {label: '警告', value: 'warning'},
    {label: '离线', value: 'disconnected'},
];

const HomePage: React.FC = () => {
    const confirmDanger = useConfirmDanger();
    const [viewMode, setViewMode] = useState<'list' | 'topology'>('list');
    const [query, setQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [modalOpen, setModalOpen] = useState(false);
    const [editingCluster, setEditingCluster] = useState<ClusterConfig | null>(null);

    const {clusters, loading, error, fetchClusters, deleteClusterAsync, setActiveCluster, setExpandedCluster} =
        useClusterStore();

    useEffect(() => {
        fetchClusters();
    }, [fetchClusters]);

    // 筛选在渲染层做：集群数量本来就小，为了过滤再发一轮 IPC 没有意义。
    const filteredClusters = useMemo(() => {
        const text = query.trim().toLowerCase();
        return clusters.filter(cluster => {
            if (statusFilter !== 'all' && (cluster.status ?? 'disconnected') !== statusFilter) {
                return false;
            }
            if (!text) {
                return true;
            }
            return `${cluster.name} ${cluster.serviceUrl}`.toLowerCase().includes(text);
        });
    }, [clusters, query, statusFilter]);

    const handleAddCluster = () => {
        setEditingCluster(null);
        setModalOpen(true);
    };

    useCommand('addCluster', handleAddCluster);

    const handleEditCluster = (cluster: ClusterConfig) => {
        setEditingCluster(cluster);
        setModalOpen(true);
    };

    const handleDeleteCluster = (cluster: ClusterConfig) => {
        confirmDanger({
            title: '确认删除集群',
            description: `确定要删除集群 "${cluster.name}" 吗？此操作将移除本地存储的集群配置。`,
            requireExactName: cluster.name,
            onOk: async () => {
                const ok = await deleteClusterAsync(cluster.id);
                if (!ok) {
                    // 抛错才能让 antd 保持弹窗打开；直接 resolve 会在删除失败时
                    // 静默关掉对话框，用户只看到集群还在列表里。
                    message.error('删除失败，详情见页面顶部提示');
                    throw new Error('delete cluster failed');
                }
            },
        });
    };

    const handleViewCluster = (cluster: ClusterConfig) => {
        setActiveCluster(cluster.id);
        setExpandedCluster(cluster.id);
    };

    // 集群表格列定义
    const columns = [
        {
            title: '集群名称',
            dataIndex: 'name',
            key: 'name',
            render: (text: string) => (
                <Space size={4}>
                    <ClusterOutlined style={{color: 'var(--color-primary)'}} />
                    <span className="field-label">{text}</span>
                </Space>
            ),
        },
        {
            title: 'Service URL',
            dataIndex: 'serviceUrl',
            key: 'serviceUrl',
            render: (url: string) => <span className="hint-text">{url}</span>,
        },
        {
            title: '状态',
            dataIndex: 'status',
            key: 'status',
            render: (status: string) => {
                const config = {
                    connected: {color: 'success', text: '在线'},
                    disconnected: {color: 'error', text: '离线'},
                    warning: {color: 'warning', text: '警告'},
                };
                const {color, text} = config[status as keyof typeof config] || {
                    color: 'default',
                    text: '未知',
                };
                // 表格里没有别的状态图标，这里保留文字；色块 Tag 只做强调
                return <Tag color={color}>{text}</Tag>;
            },
        },
        {
            title: '版本',
            dataIndex: 'version',
            key: 'version',
            render: (version: string) => version || '-',
        },
        {
            title: '操作',
            key: 'action',
            render: (_: any, record: ClusterConfig) => (
                <Space size="small">
                    <Button type="link" size="small" onClick={() => handleViewCluster(record)}>
                        查看
                    </Button>
                    <Button type="link" size="small" onClick={() => handleEditCluster(record)}>
                        编辑
                    </Button>
                    <Button type="link" size="small" danger onClick={() => handleDeleteCluster(record)}>
                        删除
                    </Button>
                </Space>
            ),
        },
    ];

    return (
        <PageShell
            actions={
                <>
                    {/* 列表视图才有的筛选：拓扑视图画的是全部集群，筛它没有对应对象 */}
                    {viewMode === 'list' && (
                        <>
                            <Input
                                allowClear
                                aria-label="按集群名称或地址筛选"
                                placeholder="筛选名称/地址"
                                value={query}
                                onChange={event => setQuery(event.target.value)}
                                style={{width: 180}}
                            />
                            <Select<StatusFilter>
                                aria-label="按状态筛选集群"
                                value={statusFilter}
                                onChange={value => setStatusFilter(value)}
                                options={STATUS_OPTIONS}
                                style={{width: 100}}
                            />
                        </>
                    )}
                    <Button icon={<ReloadOutlined />} onClick={() => fetchClusters()} loading={loading}>
                        刷新
                    </Button>
                    <Switch
                        aria-label="切换列表视图与拓扑视图"
                        checkedChildren={<AppstoreOutlined />}
                        unCheckedChildren={<BarChartOutlined />}
                        checked={viewMode === 'topology'}
                        onChange={checked => setViewMode(checked ? 'topology' : 'list')}
                    />
                    <span className="hint-text">{viewMode === 'list' ? '列表视图' : '拓扑视图'}</span>
                    <Button type="primary" icon={<PlusOutlined />} onClick={handleAddCluster}>
                        添加集群
                    </Button>
                </>
            }
        >
            <ErrorBanner error={error} />

            {viewMode === 'list' ? (
                <Card variant="borderless">
                    <StateBlock
                        loading={loading && clusters.length === 0}
                        empty={clusters.length === 0 || filteredClusters.length === 0}
                        emptyText={clusters.length === 0 ? '暂无集群配置' : '没有符合筛选条件的集群'}
                        onRetry={fetchClusters}
                        action={
                            clusters.length === 0 ? (
                                <Button type="primary" onClick={handleAddCluster}>
                                    添加第一个集群
                                </Button>
                            ) : undefined
                        }
                    >
                        <Table
                            columns={columns}
                            dataSource={filteredClusters}
                            rowKey="id"
                            pagination={false}
                            size="small"
                            scroll={{x: 'max-content'}}
                        />
                    </StateBlock>
                </Card>
            ) : (
                /* 拓扑视图 */
                <HomeTopology />
            )}

            {/* 集群配置弹窗 */}
            <ClusterConfigModal
                open={modalOpen}
                onCancel={() => setModalOpen(false)}
                onSuccess={() => {
                    setModalOpen(false);
                    fetchClusters();
                }}
                editingCluster={editingCluster}
            />
        </PageShell>
    );
};

export default HomePage;
