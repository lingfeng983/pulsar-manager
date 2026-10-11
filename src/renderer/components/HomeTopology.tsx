import React, {useEffect, useRef, useState, useCallback, useMemo} from 'react';
import {Card, Space, Spin, Alert, Statistic, Row, Col, Tag} from 'antd';
import {
    ReloadOutlined,
    ZoomInOutlined,
    ZoomOutOutlined,
    FullscreenOutlined,
    CompressOutlined,
    ClusterOutlined,
    DatabaseOutlined,
    MessageOutlined,
} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import {useClusterStore} from '../store/cluster';
import {useTabStore} from '../store/tabs';
import {useFullscreen} from '../hooks/useFullscreen';
import {useEchartsResize, zoomGraph} from '../hooks/useEcharts';
import {useElementSize} from '../hooks/useElementSize';
import {shortName} from '../utils/format';
import {topicTab, topologyTab} from '../utils/tabIds';
import {useTopologyPalette} from '../utils/topologyColors';
import StateBlock from './common/StateBlock';
import IconButton from './common/IconButton';
import {
    buildTopologyOption,
    type TopologyGraphEdge,
    type TopologyGraphNode,
    type TopologyLayout,
} from './topology/graphOption';

interface ClusterTopologyData {
    clusterId: string;
    clusterName: string;
    clusterStatus: string;
    brokers: string[];
    topics: {
        name: string;
        tenant: string;
        namespace: string;
        persistent: boolean;
        msgRateIn: number;
        ownerBrokers: string[];
    }[];
}

// 首页概览只展示少量节点，把规模上限下推给主进程，避免为了几个节点遍历整个集群。
// 这里的值是"概览用多少"，主进程 AGGREGATION_LIMITS 是"最多允许多少"，两层各自独立。
const HOME_TOPOLOGY_LIMITS = {
    maxTenants: 3,
    maxNamespacesPerTenant: 2,
    maxTopicsPerNamespace: 3,
    maxTopics: 8,
};

const lastSegment = (path: string): string => path.split('/').pop() || path;

// 获取单个集群的拓扑数据：直接复用主进程的聚合实现，不在渲染层重复多轮 IPC
async function fetchClusterTopology(
    clusterId: string,
    clusterName: string,
    clusterStatus: string,
): Promise<ClusterTopologyData> {
    const response = await window.electronAPI.topology.getClusterTopology(clusterId, HOME_TOPOLOGY_LIMITS);
    if (!response.success || !response.data) {
        throw new Error(response.error || '获取拓扑数据失败');
    }

    return {
        clusterId,
        clusterName,
        clusterStatus,
        brokers: (response.data.brokers || []).map(broker => broker.name),
        topics: (response.data.topics || []).map(topic => ({
            name: topic.name,
            tenant: topic.tenant,
            namespace: topic.namespace,
            persistent: topic.persistent,
            msgRateIn: topic.msgRateIn || 0,
            ownerBrokers: topic.ownerBrokers || [],
        })),
    };
}

// 构建拓扑节点和边
function buildTopologyFromData(clusterData: ClusterTopologyData[]): {
    nodes: TopologyGraphNode[];
    edges: TopologyGraphEdge[];
} {
    const nodes: TopologyGraphNode[] = [];
    const edges: TopologyGraphEdge[] = [];

    for (const cluster of clusterData) {
        const clusterTopics = cluster.topics || [];

        // 添加集群节点
        nodes.push({
            id: cluster.clusterId,
            name: cluster.clusterName,
            type: 'cluster',
            clusterId: cluster.clusterId,
            clusterName: cluster.clusterName,
            status: cluster.clusterStatus,
            count: clusterTopics.length,
        });

        // 添加 Broker 节点
        const brokerIdByName = new Map<string, string>();
        (cluster.brokers || []).forEach((broker, idx) => {
            const brokerId = `${cluster.clusterId}-broker-${idx}`;
            brokerIdByName.set(broker, brokerId);
            nodes.push({
                id: brokerId,
                name: broker,
                type: 'broker',
                clusterId: cluster.clusterId,
                clusterName: cluster.clusterName,
                count: clusterTopics.filter(topic => topic.ownerBrokers.includes(broker)).length,
            });
            edges.push({source: cluster.clusterId, target: brokerId, value: 10});
        });

        // 添加 Topic 节点：只按真实归属连线，归属未知就不连，不按序号轮转分配
        clusterTopics.forEach((topic, idx) => {
            const topicId = `${cluster.clusterId}-topic-${idx}`;
            // 速率保留两位小数：Math.floor 会把 0.4 msg/s 显示成 0，
            // 慢速 topic 在提示里看着像"没有流量"。
            const rate = Math.round(topic.msgRateIn * 100) / 100;

            nodes.push({
                id: topicId,
                name: shortName(topic.name),
                type: 'topic',
                clusterId: cluster.clusterId,
                clusterName: cluster.clusterName,
                tenant: topic.tenant,
                namespace: topic.namespace,
                topicPath: topic.name,
                persistent: topic.persistent,
                count: rate,
            });
            topic.ownerBrokers.forEach(owner => {
                const brokerId = brokerIdByName.get(owner);
                if (!brokerId) {
                    return;
                }
                edges.push({
                    source: brokerId,
                    target: topicId,
                    value: rate + 10,
                });
            });
        });
    }

    return {nodes, edges};
}

const HomeTopology: React.FC = () => {
    const [loading, setLoading] = useState(false);
    const [nodes, setNodes] = useState<TopologyGraphNode[]>([]);
    const [edges, setEdges] = useState<TopologyGraphEdge[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [stats, setStats] = useState({
        clusters: 0,
        brokers: 0,
        topics: 0,
    });
    const layout: TopologyLayout = 'force';
    const chartInstance = useRef<any>(null);
    const getChart = useCallback(() => chartInstance.current, []);
    // 拓扑加载代次：集群列表变化后，旧一轮的晚到响应必须作废
    const homeTopologyRequestRef = useRef(0);
    const palette = useTopologyPalette();
    const {addTab} = useTabStore();

    const {ref: chartRef, isFullscreen, toggle: toggleFullscreen} = useFullscreen<HTMLDivElement>();
    useEchartsResize(chartRef, getChart);
    // zrender 会把量到的高度写成行内像素并钉住容器，所以尺寸由外层容器量出来反喂给图表。
    const {ref: measureChartArea, width: chartWidth, height: chartHeight} = useElementSize<HTMLDivElement>();

    const {clusters} = useClusterStore();

    // 缓存 ECharts 配置
    const chartOption = useMemo(
        () => buildTopologyOption({nodes, edges, palette, layout, showLegend: false}),
        [nodes, edges, palette, layout],
    );

    // 清理图表实例
    useEffect(() => {
        return () => {
            if (chartInstance.current) {
                chartInstance.current.dispose();
                chartInstance.current = null;
            }
        };
    }, []);

    // 加载集群拓扑数据
    const loadTopology = useCallback(async () => {
        const requestId = ++homeTopologyRequestRef.current;
        const isStale = () => requestId !== homeTopologyRequestRef.current;

        if (clusters.length === 0) {
            setNodes([]);
            setEdges([]);
            setStats({clusters: 0, brokers: 0, topics: 0});
            return;
        }

        // 只对已连接的集群加载拓扑数据
        const connectedClusters = clusters.filter(c => c.status === 'connected');
        if (connectedClusters.length === 0) {
            setNodes(
                clusters.map(c => ({
                    id: c.id,
                    name: c.name,
                    type: 'cluster' as const,
                    clusterId: c.id,
                    clusterName: c.name,
                    status: 'disconnected',
                })),
            );
            setEdges([]);
            setStats({clusters: clusters.length, brokers: 0, topics: 0});
            return;
        }

        setLoading(true);
        setError(null);

        try {
            // 并发获取所有已连接集群的拓扑数据
            const results = await Promise.allSettled(
                connectedClusters.map(cluster =>
                    fetchClusterTopology(cluster.id, cluster.name, cluster.status || 'disconnected'),
                ),
            );
            // 集群列表在加载期间又变了：这一轮的响应整体作废，等下一轮
            if (isStale()) {
                return;
            }

            const successfulData: ClusterTopologyData[] = [];
            const errors: string[] = [];

            results.forEach((result, index) => {
                const cluster = connectedClusters[index];
                if (result.status === 'fulfilled') {
                    successfulData.push(result.value);
                    return;
                }
                // 单个集群拉取失败不应让它整条从图上消失：仍然放一个只有集群节点的
                // 降级条目，用户能看到"这个集群在，但明细取不到"。
                successfulData.push({
                    clusterId: cluster.id,
                    clusterName: cluster.name,
                    clusterStatus: cluster.status || 'disconnected',
                    brokers: [],
                    topics: [],
                });
                // 直接插值 Error 会带上 "Error: " 前缀，这里只取 message
                const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
                errors.push(`${cluster.name}: ${reason}`);
            });

            // 显示部分错误
            if (errors.length > 0) {
                setError(`部分集群数据加载失败: ${errors.slice(0, 2).join(', ')}${errors.length > 2 ? '...' : ''}`);
            }

            // 构建拓扑图数据
            const {nodes: newNodes, edges: newEdges} = buildTopologyFromData(successfulData);
            setNodes(newNodes);
            setEdges(newEdges);

            // 更新统计
            setStats({
                clusters: successfulData.length,
                brokers: successfulData.reduce((sum, d) => sum + d.brokers.length, 0),
                topics: successfulData.reduce((sum, d) => sum + d.topics.length, 0),
            });
        } catch (err) {
            console.error('Failed to load topology:', err);
            setError('加载拓扑数据失败，请稍后重试');
        } finally {
            if (!isStale()) {
                setLoading(false);
            }
        }
    }, [clusters]);

    useEffect(() => {
        loadTopology();
    }, [loadTopology]);

    // 放大
    const handleZoomIn = useCallback(() => {
        zoomGraph(chartInstance.current, 1.2);
    }, []);

    // 缩小
    const handleZoomOut = useCallback(() => {
        zoomGraph(chartInstance.current, 0.8);
    }, []);

    // Topic 节点点击打开详情页；集群节点点击打开对应的集群配置页
    const handleChartClick = useCallback(
        (params: any) => {
            if (params.dataType !== 'node' || !params.data?.id) {
                return;
            }
            const node = nodes.find(candidate => candidate.id === params.data.id);
            if (!node || !node.clusterId) {
                return;
            }
            if (node.type === 'topic' && node.topicPath) {
                const topic = lastSegment(node.topicPath);
                addTab(
                    topicTab({
                        clusterId: node.clusterId,
                        tenant: node.tenant ?? '',
                        namespace: node.namespace ?? '',
                        topic,
                        persistent: node.persistent ?? true,
                    }),
                );
                return;
            }
            if (node.type === 'cluster') {
                addTab(topologyTab(node.clusterId, node.clusterName));
            }
        },
        [addTab, nodes],
    );

    // 空状态
    if (clusters.length === 0) {
        return (
            <Card>
                <StateBlock empty height={500} emptyText="暂无集群配置，请先添加集群以查看拓扑图" />
            </Card>
        );
    }

    return (
        <Card
            extra={
                <Space>
                    <IconButton size="small" icon={<ZoomOutOutlined />} label="缩小拓扑图" onClick={handleZoomOut} />
                    <IconButton size="small" icon={<ZoomInOutlined />} label="放大拓扑图" onClick={handleZoomIn} />
                    <IconButton
                        size="small"
                        icon={<ReloadOutlined />}
                        label="刷新拓扑图"
                        loading={loading}
                        onClick={loadTopology}
                    />
                    <IconButton
                        size="small"
                        icon={isFullscreen ? <CompressOutlined /> : <FullscreenOutlined />}
                        label={isFullscreen ? '退出全屏' : '全屏'}
                        onClick={toggleFullscreen}
                    />
                </Space>
            }
            style={{flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column'}}
            styles={{body: {flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden'}}}
        >
            <Spin spinning={loading} tip="正在加载拓扑数据..." wrapperClassName="chart-spin">
                {/* 统计信息 */}
                <Row gutter={[16, 16]} style={{marginBottom: 'var(--spacing-lg)'}}>
                    <Col span={8}>
                        <Statistic
                            title="集群数"
                            value={stats.clusters}
                            prefix={<ClusterOutlined />}
                            valueStyle={{color: palette.primary}}
                        />
                    </Col>
                    <Col span={8}>
                        <Statistic
                            title="Brokers"
                            value={stats.brokers}
                            prefix={<DatabaseOutlined />}
                            valueStyle={{color: palette.success}}
                        />
                    </Col>
                    <Col span={8}>
                        <Statistic
                            title="Topics"
                            value={stats.topics}
                            prefix={<MessageOutlined />}
                            valueStyle={{color: palette.warning}}
                        />
                    </Col>
                </Row>

                {/* 错误提示 */}
                {error && (
                    <Alert
                        message={error}
                        type="warning"
                        showIcon
                        closable
                        onClose={() => setError(null)}
                        style={{marginBottom: 'var(--spacing-lg)'}}
                    />
                )}

                {/* 拓扑图 */}
                <div ref={chartRef} style={{flex: 1, minHeight: 300, display: 'flex', flexDirection: 'column'}}>
                    <div ref={measureChartArea} style={{flex: 1, minHeight: 0}}>
                        {nodes.length > 0 && (
                            <ReactECharts
                                ref={e => {
                                    chartInstance.current = e?.getEchartsInstance() as typeof chartInstance.current;
                                }}
                                option={chartOption}
                                notMerge={false}
                                style={{width: chartWidth || '100%', height: chartHeight || 300}}
                                opts={{renderer: 'canvas'}}
                                onEvents={{click: handleChartClick}}
                            />
                        )}
                    </div>
                </div>

                {/* 图例说明 */}
                <div
                    style={{
                        marginTop: 'var(--spacing-lg)',
                        paddingTop: 'var(--spacing-lg)',
                        borderTop: '1px solid var(--color-border)',
                    }}
                >
                    <div style={{display: 'flex', gap: 'var(--spacing-xl)', flexWrap: 'wrap', alignItems: 'center'}}>
                        <Space size={16}>
                            <Tag color={palette.primary}>集群</Tag>
                            <Tag color={palette.success}>Broker</Tag>
                            <Tag color={palette.warning}>Topic</Tag>
                        </Space>
                        <Space size={8}>
                            <span
                                style={{
                                    display: 'inline-block',
                                    width: 12,
                                    height: 12,
                                    borderRadius: '50%',
                                    backgroundColor: palette.primary,
                                }}
                            />
                            <span style={{fontSize: 12, color: palette.label}}>在线</span>
                            <span
                                style={{
                                    display: 'inline-block',
                                    width: 12,
                                    height: 12,
                                    borderRadius: '50%',
                                    backgroundColor: palette.danger,
                                }}
                            />
                            <span style={{fontSize: 12, color: palette.label}}>离线</span>
                        </Space>
                    </div>
                </div>
            </Spin>
        </Card>
    );
};

export default HomeTopology;
