import React, {useEffect, useRef, useState, useCallback} from 'react';
import {Card, Row, Col, Statistic, Table, Tag, Button, Space, Switch, Spin, Alert, Modal, message} from 'antd';
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

    const handleDeleteCluster = async (cluster: ClusterConfig) => {
        Modal.confirm({
            title: '确认删除',
            content: `确定要删除集群 "${cluster.name}" 吗？此操作将移除本地存储的集群配置。`,
            okText: '删除',
            okType: 'danger',
            cancelText: '取消',
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
                    <span style={{fontWeight: 500}}>{text}</span>
                </Space>
            ),
        },
        {
            title: 'Service URL',
            dataIndex: 'serviceUrl',
            key: 'serviceUrl',
            render: (url: string) => <span style={{fontSize: 12, color: 'var(--color-text-secondary)'}}>{url}</span>,
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
        <div
            style={{
                padding: 'var(--spacing-lg)',
                overflow: 'auto',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
            }}
        >
            {/* 页面标题和视图切换 */}
            <div
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 'var(--spacing-lg)',
                }}
            >
                <h2 style={{fontSize: '20px', fontWeight: 600}}>集群总览</h2>
                <Space>
                    <Button icon={<ReloadOutlined />} onClick={() => fetchClusters()} loading={loading}>
                        刷新
                    </Button>
                    <Switch
                        checkedChildren={<AppstoreOutlined />}
                        unCheckedChildren={<BarChartOutlined />}
                        checked={viewMode === 'topology'}
                        onChange={checked => setViewMode(checked ? 'topology' : 'list')}
                    />
                    <span>{viewMode === 'list' ? '列表视图' : '拓扑视图'}</span>
                    <Button type="primary" icon={<PlusOutlined />} onClick={handleAddCluster}>
                        添加集群
                    </Button>
                </Space>
            </div>

            {error && (
                <Alert
                    message="加载失败"
                    description={error}
                    type="error"
                    showIcon
                    closable
                    style={{marginBottom: 16}}
                />
            )}

            {viewMode === 'list' ? (
                <>
                    {/* 全局指标卡片 */}
                    <Row gutter={16} style={{marginBottom: 'var(--spacing-lg)'}}>
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
                                            <div
                                                style={{
                                                    marginTop: 8,
                                                    fontSize: 12,
                                                    color: 'var(--color-text-secondary)',
                                                }}
                                            >
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
                                    <div
                                        style={{
                                            textAlign: 'center',
                                            padding: '20px 0',
                                            color: 'var(--color-text-secondary)',
                                        }}
                                    >
                                        <MessageOutlined style={{fontSize: 24, marginBottom: 8}} />
                                        <p>暂无已连接的集群，请先添加并连接集群查看统计信息</p>
                                    </div>
                                </Card>
                            </Col>
                        )}
                    </Row>

                    {/* 集群列表 */}
                    <Card title="集群列表" variant="borderless">
                        <Spin spinning={loading}>
                            {clusters.length === 0 && !loading ? (
                                <div style={{textAlign: 'center', padding: '40px 0'}}>
                                    <ClusterOutlined style={{fontSize: 48, color: 'var(--color-text-secondary)'}} />
                                    <p style={{marginTop: 16, color: 'var(--color-text-secondary)'}}>暂无集群配置</p>
                                    <Button type="primary" onClick={handleAddCluster} style={{marginTop: 16}}>
                                        添加第一个集群
                                    </Button>
                                </div>
                            ) : (
                                <Table
                                    columns={columns}
                                    dataSource={clusters}
                                    rowKey="id"
                                    pagination={false}
                                    size="middle"
                                    scroll={{x: 'max-content'}}
                                />
                            )}
                        </Spin>
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
        </div>
    );
};

export default HomePage;
