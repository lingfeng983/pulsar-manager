import React, {useEffect, useRef, useState, useCallback} from 'react';
import {Card, Row, Col, Statistic, Table, Tag, Button, Space, Switch, Spin, message} from 'antd';
import {
    ClusterOutlined,
    DatabaseOutlined,
    MessageOutlined,
    PlusOutlined,
    BarChartOutlined,
    AppstoreOutlined,
    ReloadOutlined,
    CloudDownloadOutlined,
    CloudUploadOutlined,
} from '@ant-design/icons';
import {useClusterStore} from '../store/cluster';
import ClusterConfigModal from './ClusterConfig';
import HomeTopology from '../components/HomeTopology';
import PageShell from '../components/common/PageShell';
import StateBlock from '../components/common/StateBlock';
import ErrorBanner from '../components/common/ErrorBanner';
import {useConfirmDanger} from '../components/common/dangerConfirm';
import type {ClusterConfig} from '../types';
import {useCommand} from '../hooks/useKeybindings';

interface GlobalStats {
    totalBrokers: number;
    totalTopics: number;
    totalPartitions: number;
    totalSubscriptions: number;
    totalProducers: number;
    totalConsumers: number;
    totalMsgRateIn: number;
    totalMsgRateOut: number;
    totalBacklog: number;
}

const HomePage: React.FC = () => {
    const confirmDanger = useConfirmDanger();
    const [viewMode, setViewMode] = useState<'list' | 'topology'>('list');
    const [modalOpen, setModalOpen] = useState(false);
    const [editingCluster, setEditingCluster] = useState<ClusterConfig | null>(null);
    const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null);
    const [statsLoading, setStatsLoading] = useState(false);
    // 集群集合一变就会重跑聚合，旧一轮的晚到响应不能覆盖新一轮的结果
    const statsRequestRef = useRef(0);

    const {clusters, loading, error, fetchClusters, deleteClusterAsync, setActiveCluster, setExpandedCluster} =
        useClusterStore();

    // 加载全局统计
    const loadGlobalStats = useCallback(async () => {
        if (clusters.length === 0) return;

        // 只对已连接的集群加载统计
        const connectedClusters = clusters.filter(c => c.status === 'connected');
        if (connectedClusters.length === 0) {
            setGlobalStats(null);
            return;
        }

        const requestId = ++statsRequestRef.current;
        setStatsLoading(true);
        try {
            // 获取所有已连接集群的统计并聚合
            const statsPromises = connectedClusters.map(async cluster => {
                try {
                    const response = await window.electronAPI.metrics.getAggregatedStats(cluster.id);
                    if (response.success && response.data) {
                        return response.data;
                    }
                    return null;
                } catch {
                    return null;
                }
            });

            const results = await Promise.all(statsPromises);

            // 聚合所有集群的统计
            const aggregated: GlobalStats = {
                totalBrokers: 0,
                totalTopics: 0,
                totalPartitions: 0,
                totalSubscriptions: 0,
                totalProducers: 0,
                totalConsumers: 0,
                totalMsgRateIn: 0,
                totalMsgRateOut: 0,
                totalBacklog: 0,
            };

            // 获取 Broker 数量
            const brokerPromises = connectedClusters.map(async cluster => {
                try {
                    const response = await window.electronAPI.metrics.getBrokers(cluster.id);
                    if (response.success && response.data) {
                        return response.data.activeBrokers?.length || 0;
                    }
                    return 0;
                } catch {
                    return 0;
                }
            });

            const brokerCounts = await Promise.all(brokerPromises);
            if (requestId !== statsRequestRef.current) {
                return;
            }
            aggregated.totalBrokers = brokerCounts.reduce((sum, count) => sum + count, 0);

            // 聚合其他统计
            results.forEach(stats => {
                if (stats) {
                    aggregated.totalTopics += stats.totalTopics || 0;
                    aggregated.totalPartitions += stats.totalPartitions || 0;
                    aggregated.totalSubscriptions += stats.totalSubscriptions || 0;
                    aggregated.totalProducers += stats.totalProducers || 0;
                    aggregated.totalConsumers += stats.totalConsumers || 0;
                    aggregated.totalMsgRateIn += stats.totalMsgRateIn || 0;
                    aggregated.totalMsgRateOut += stats.totalMsgRateOut || 0;
                    aggregated.totalBacklog += stats.totalBacklog || 0;
                }
            });

            setGlobalStats(aggregated);
        } catch (error) {
            console.error('Failed to load global stats:', error);
        } finally {
            if (requestId === statsRequestRef.current) {
                setStatsLoading(false);
            }
        }
    }, [clusters]);

    useEffect(() => {
        fetchClusters();
    }, [fetchClusters]);

    // 当集群列表变化时加载统计
    useEffect(() => {
        if (clusters.length > 0) {
            loadGlobalStats();
        }
    }, [clusters, loadGlobalStats]);

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
                <Space>
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
            title="集群总览"
            actions={
                <>
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
                    <span>{viewMode === 'list' ? '列表视图' : '拓扑视图'}</span>
                    <Button type="primary" icon={<PlusOutlined />} onClick={handleAddCluster}>
                        添加集群
                    </Button>
                </>
            }
        >
            <ErrorBanner error={error} />

            {viewMode === 'list' ? (
                <>
                    {/* 全局指标卡片 */}
                    <Row gutter={[16, 16]}>
                        <Col span={8}>
                            <Card>
                                <Statistic
                                    title="集群总数"
                                    value={clusters.length}
                                    prefix={<ClusterOutlined />}
                                    valueStyle={{color: 'var(--color-primary)'}}
                                />
                            </Card>
                        </Col>
                        {clusters.some(c => c.status === 'connected') ? (
                            <>
                                <Col span={8}>
                                    <Card>
                                        <Spin spinning={statsLoading}>
                                            <Statistic
                                                title="在线 Brokers"
                                                value={globalStats?.totalBrokers || 0}
                                                prefix={<DatabaseOutlined />}
                                                valueStyle={{color: 'var(--color-success)'}}
                                            />
                                        </Spin>
                                    </Card>
                                </Col>
                                <Col span={8}>
                                    <Card>
                                        <Spin spinning={statsLoading}>
                                            <Statistic
                                                title="活跃 Topics"
                                                value={globalStats?.totalTopics || 0}
                                                prefix={<DatabaseOutlined />}
                                                valueStyle={{color: 'var(--color-text-primary)'}}
                                            />
                                            <div className="stat-subline">
                                                分区: {globalStats?.totalPartitions || 0}｜订阅:{' '}
                                                {globalStats?.totalSubscriptions || 0}
                                            </div>
                                        </Spin>
                                    </Card>
                                </Col>
                                <Col span={8}>
                                    <Card>
                                        <Spin spinning={statsLoading}>
                                            <Statistic
                                                title="消息输入速率"
                                                value={globalStats?.totalMsgRateIn || 0}
                                                prefix={<CloudDownloadOutlined />}
                                                valueStyle={{color: 'var(--color-primary)'}}
                                                precision={2}
                                                suffix="msg/s"
                                            />
                                        </Spin>
                                    </Card>
                                </Col>
                                <Col span={8}>
                                    <Card>
                                        <Spin spinning={statsLoading}>
                                            <Statistic
                                                title="消息输出速率"
                                                value={globalStats?.totalMsgRateOut || 0}
                                                prefix={<CloudUploadOutlined />}
                                                valueStyle={{color: 'var(--color-warning)'}}
                                                precision={2}
                                                suffix="msg/s"
                                            />
                                        </Spin>
                                    </Card>
                                </Col>
                                <Col span={8}>
                                    <Card>
                                        <Spin spinning={statsLoading}>
                                            <Statistic
                                                title="积压消息"
                                                value={globalStats?.totalBacklog || 0}
                                                prefix={<MessageOutlined />}
                                                valueStyle={{color: 'var(--color-text-primary)'}}
                                            />
                                        </Spin>
                                    </Card>
                                </Col>
                            </>
                        ) : (
                            <Col span={16}>
                                <Card>
                                    <StateBlock empty emptyText="暂无已连接的集群，请先添加并连接集群查看统计信息" />
                                </Card>
                            </Col>
                        )}
                    </Row>

                    {/* 集群列表 */}
                    <Card title="集群列表" variant="borderless">
                        <StateBlock
                            loading={loading && clusters.length === 0}
                            empty={clusters.length === 0}
                            emptyText="暂无集群配置"
                            onRetry={fetchClusters}
                            action={
                                <Button type="primary" onClick={handleAddCluster}>
                                    添加第一个集群
                                </Button>
                            }
                        >
                            <Table
                                columns={columns}
                                dataSource={clusters}
                                rowKey="id"
                                pagination={false}
                                size="middle"
                                scroll={{x: 'max-content'}}
                            />
                        </StateBlock>
                    </Card>
                </>
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
