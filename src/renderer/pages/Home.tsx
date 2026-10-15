import React, {useEffect, useMemo, useState} from 'react';
import {Card, Table, Tag, Button, Input, Select, Space, message} from 'antd';
import {ClusterOutlined, PlusOutlined, BarChartOutlined, ReloadOutlined} from '@ant-design/icons';
import {useClusterStore} from '../store/cluster';
import {useTabStore} from '../store/tabs';
import ClusterConfigModal from './ClusterConfig';
import PageShell from '../components/common/PageShell';
import IconButton from '../components/common/IconButton';
import StateBlock from '../components/common/StateBlock';
import ErrorBanner from '../components/common/ErrorBanner';
import {useConfirmDanger} from '../components/common/dangerConfirm';
import type {ClusterConfig} from '../types';
import {useCommand} from '../hooks/useKeybindings';
import {topologyTab} from '../utils/tabIds';
import {matchesFilter} from '../utils/textFilter';

type StatusFilter = 'all' | 'connected' | 'warning' | 'disconnected';

const STATUS_OPTIONS: {label: string; value: StatusFilter}[] = [
    {label: '全部状态', value: 'all'},
    {label: '在线', value: 'connected'},
    {label: '警告', value: 'warning'},
    {label: '离线', value: 'disconnected'},
];

const HomePage: React.FC = () => {
    const confirmDanger = useConfirmDanger();
    const [query, setQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [modalOpen, setModalOpen] = useState(false);
    const [editingCluster, setEditingCluster] = useState<ClusterConfig | null>(null);

    const {addTab} = useTabStore();

    // 打开全局拓扑页签：原首页的"拓扑视图"与集群拓扑页同源同图，
    // 合并后首页只留这个入口，图本体在 ClusterTopology（不带 clusterId 的形态）。
    const handleOpenTopology = () => {
        addTab(topologyTab());
    };

    const {
        clusters,
        loading,
        checking,
        error,
        fetchClusters,
        refreshClusterStatus,
        deleteClusterAsync,
        setActiveCluster,
        setExpandedCluster,
    } = useClusterStore();

    useEffect(() => {
        void fetchClusters();
        // 状态探活（首屏一次 + 按配置中心间隔轮询）在 Layout 层统一跑，
        // 这里只负责把本地库里的列表取出来。
    }, [fetchClusters]);

    const handleRefreshStatus = async () => {
        const ok = await refreshClusterStatus();
        if (ok) {
            message.success('集群状态已刷新');
        } else {
            message.error('刷新集群状态失败');
        }
    };

    // 筛选在渲染层做：集群数量本来就小，为了过滤再发一轮 IPC 没有意义。
    const filteredClusters = useMemo(() => {
        return clusters.filter(cluster => {
            if (statusFilter !== 'all' && (cluster.status ?? 'disconnected') !== statusFilter) {
                return false;
            }
            return matchesFilter([cluster.name, cluster.serviceUrl], query);
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
                    <IconButton
                        icon={<ReloadOutlined />}
                        label="刷新集群状态"
                        loading={loading || checking}
                        onClick={() => void handleRefreshStatus()}
                    />
                    <span className="page-actions-right">
                        <IconButton icon={<BarChartOutlined />} label="打开集群拓扑" onClick={handleOpenTopology} />
                        <Button type="primary" icon={<PlusOutlined />} onClick={handleAddCluster}>
                            添加集群
                        </Button>
                    </span>
                </>
            }
        >
            <ErrorBanner error={error} />

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
