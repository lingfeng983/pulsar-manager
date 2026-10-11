import React, {useEffect, useRef, useState, useCallback, useMemo} from 'react';
import {Card, Button, Space, Select, Spin, message, Input, Switch, Alert, Tooltip} from 'antd';
import {ReloadOutlined, ZoomInOutlined, ZoomOutOutlined, FullscreenOutlined, CompressOutlined} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import type {EChartsOption} from 'echarts';
import {useClusterStore} from '../../store/cluster';
import {useTabStore} from '../../store/tabs';
import type {ClusterConfig, ClusterTopology as ClusterTopologyPayload} from '../../types';
import {shortName} from '../../utils/format';
import {topicTab} from '../../utils/tabIds';
import {useFullscreen} from '../../hooks/useFullscreen';
import {useEchartsResize, zoomGraph, resetGraphView} from '../../hooks/useEcharts';
import {useElementSize} from '../../hooks/useElementSize';
import {useCommand} from '../../hooks/useKeybindings';
import {useTopologyPalette} from '../../utils/topologyColors';
import {useFontFactor} from '../../utils/fontScale';
import PageShell from '../common/PageShell';
import StateBlock from '../common/StateBlock';
import IconButton from '../common/IconButton';
import {
    ALL_NODE_TYPES,
    NODE_TYPE_LABELS,
    buildTopologyOption,
    filterTopologyGraph,
    type TopologyGraphEdge,
    type TopologyGraphNode,
    type TopologyLayout,
    type TopologyNodeType,
} from '../topology/graphOption';

interface ClusterTopologyProps {
    clusterId?: string;
}

const LAYOUT_OPTIONS: {label: string; value: TopologyLayout}[] = [
    {label: '力导向', value: 'force'},
    {label: '环形', value: 'circular'},
];

// 分区节点数量可以远超 topic 数量，不设上限时浏览器会直接卡死。
const MAX_PARTITION_NODES = 200;

const lastSegment = (path: string): string => path.split('/').pop() || path;

const ClusterTopology: React.FC<ClusterTopologyProps> = ({clusterId: initialClusterId}) => {
    const [loading, setLoading] = useState(false);
    const [rawNodes, setRawNodes] = useState<TopologyGraphNode[]>([]);
    const [rawEdges, setRawEdges] = useState<TopologyGraphEdge[]>([]);
    const [ownershipSource, setOwnershipSource] = useState<ClusterTopologyPayload['ownershipSource'] | null>(null);
    const [truncatedPartitions, setTruncatedPartitions] = useState(false);
    const [selectedClusterId, setSelectedClusterId] = useState<string | undefined>(initialClusterId);
    const [layout, setLayout] = useState<TopologyLayout>('force');
    const [visibleTypes, setVisibleTypes] = useState<TopologyNodeType[]>(
        // 单集群拓扑里没有集群节点，可选项里也没有它：带上 cluster 只会在选择框里
        // 多出一个取不到标签、只能显示原始值的 "cluster" 标签。
        ALL_NODE_TYPES.filter(type => type !== 'cluster'),
    );
    const [query, setQuery] = useState('');
    const [showPartitions, setShowPartitions] = useState(false);
    const [stats, setStats] = useState({brokers: 0, topics: 0, subscriptions: 0, partitions: 0});
    const chartRef = useRef<ReactECharts>(null);
    const getChart = useCallback(() => chartRef.current?.getEchartsInstance(), []);
    // 拓扑请求代次：切换集群后旧请求的晚到响应必须作废
    const topologyRequestRef = useRef(0);
    const palette = useTopologyPalette();
    const fontScale = useFontFactor();
    const {addTab} = useTabStore();
    // zrender 会把量到的高度写成行内像素并钉住容器，所以尺寸由外层容器量出来反喂给图表。
    const {ref: chartAreaRef, width: chartWidth, height: chartHeight} = useElementSize<HTMLDivElement>();

    // 进出全屏后容器尺寸变化，需要等浏览器完成布局再 resize
    const handleFullscreenChange = useCallback(() => {
        setTimeout(() => getChart()?.resize(), 100);
    }, [getChart]);

    const {
        ref: chartContainerRef,
        isFullscreen,
        toggle: toggleFullscreen,
    } = useFullscreen<HTMLDivElement>(handleFullscreenChange);
    useEchartsResize(chartContainerRef, getChart);

    const {clusters, fetchClusters} = useClusterStore();

    // 如果传入了特定集群，则使用该集群，否则支持选择
    const selectedCluster = selectedClusterId || clusters.find(c => c.status === 'connected')?.id || clusters[0]?.id;

    useEffect(() => {
        fetchClusters();
    }, [fetchClusters]);

    // 图表实例初始化后的处理
    const onChartInit = useCallback((chart: any) => {
        if (chart) {
            setTimeout(() => chart.resize(), 100);
        }
    }, []);

    /**
     * 转换拓扑数据。broker→topic 的连线完全按 payload 走：主进程已用 stats 里的
     * ownerBroker 反向聚合过，这里不再自行分配，否则又变回假的全连接图。
     */
    const transformTopologyData = useCallback(
        (
            data: ClusterTopologyPayload,
            withPartitions: boolean,
        ): {nodes: TopologyGraphNode[]; edges: TopologyGraphEdge[]} => {
            const nodes: TopologyGraphNode[] = [];
            const edges: TopologyGraphEdge[] = [];

            data.brokers?.forEach(broker => {
                nodes.push({id: broker.name, name: broker.name, type: 'broker', clusterId: selectedCluster});
                broker.topics?.forEach(topicName => {
                    edges.push({source: broker.name, target: topicName, value: 100});
                });
            });

            let partitionCount = 0;
            data.topics?.forEach(topic => {
                const topicId = topic.name;
                nodes.push({
                    id: topicId,
                    name: shortName(topic.name),
                    type: 'topic',
                    clusterId: selectedCluster,
                    tenant: topic.tenant,
                    namespace: topic.namespace,
                    topicPath: topic.name,
                    persistent: topic.persistent,
                    count: topic.msgRateIn || 0,
                });

                topic.subscriptions?.forEach(sub => {
                    nodes.push({
                        id: `${topicId}/${sub}`,
                        name: sub,
                        type: 'subscription',
                        clusterId: selectedCluster,
                        tenant: topic.tenant,
                        namespace: topic.namespace,
                        topicPath: topic.name,
                        persistent: topic.persistent,
                    });
                    edges.push({source: topicId, target: `${topicId}/${sub}`, value: topic.msgRateIn || 0});
                });

                if (!withPartitions || topic.partitionNames.length === 0) {
                    return;
                }
                for (const partitionUri of topic.partitionNames) {
                    if (partitionCount >= MAX_PARTITION_NODES) {
                        setTruncatedPartitions(true);
                        break;
                    }
                    partitionCount += 1;
                    nodes.push({
                        id: partitionUri,
                        name: shortName(partitionUri),
                        type: 'partition',
                        clusterId: selectedCluster,
                        tenant: topic.tenant,
                        namespace: topic.namespace,
                        topicPath: topic.name,
                        persistent: topic.persistent,
                        parentTopic: topic.name,
                    });
                    edges.push({source: topicId, target: partitionUri, value: 50});
                }
            });

            return {nodes, edges};
        },
        [selectedCluster],
    );

    // 加载拓扑数据
    const loadTopology = useCallback(async () => {
        if (!selectedCluster) return;

        const requestId = ++topologyRequestRef.current;
        setLoading(true);
        try {
            const response = await window.electronAPI.topology.getClusterTopology(selectedCluster);
            // 切换集群后旧集群的晚到响应不能覆盖当前图
            if (requestId !== topologyRequestRef.current) {
                return;
            }

            if (response.success && response.data) {
                const {nodes, edges} = transformTopologyData(response.data, showPartitions);
                setRawNodes(nodes);
                setRawEdges(edges);
                setOwnershipSource(response.data.ownershipSource);
                setTruncatedPartitions(false);
                setStats({
                    brokers: nodes.filter(n => n.type === 'broker').length,
                    topics: nodes.filter(n => n.type === 'topic').length,
                    subscriptions: nodes.filter(n => n.type === 'subscription').length,
                    partitions: nodes.filter(n => n.type === 'partition').length,
                });

                // 图表加载后重新调整大小
                setTimeout(() => {
                    chartRef.current?.getEchartsInstance()?.resize();
                }, 100);
            } else {
                message.warning(response.error || '获取拓扑数据失败');
                setRawNodes([]);
                setRawEdges([]);
                setOwnershipSource(null);
                setStats({brokers: 0, topics: 0, subscriptions: 0, partitions: 0});
            }
        } catch (error) {
            if (requestId !== topologyRequestRef.current) {
                return;
            }
            console.error('Failed to load topology:', error);
            message.error('加载拓扑数据失败');
            setStats({brokers: 0, topics: 0, subscriptions: 0, partitions: 0});
        } finally {
            if (requestId === topologyRequestRef.current) {
                setLoading(false);
            }
        }
    }, [selectedCluster, showPartitions, transformTopologyData]);

    // 初始加载
    useEffect(() => {
        if (selectedCluster) {
            loadTopology();
        }
    }, [selectedCluster, loadTopology]);

    // 筛选在渲染层做：节点已经在内存里，重新拉一次 IPC 只会更慢。
    const {nodes: visibleNodes, edges: visibleEdges} = useMemo(
        () => filterTopologyGraph(rawNodes, rawEdges, {types: new Set(visibleTypes), query: query.trim()}),
        [rawNodes, rawEdges, visibleTypes, query],
    );

    // 规模计数：画在图内左上角那一行，不再单独占图外一行
    const summaryText = useMemo(() => {
        const parts = [
            `Brokers ${stats.brokers}`,
            `Topics ${stats.topics}`,
            `Subscriptions ${stats.subscriptions}`,
            `分区 ${stats.partitions}`,
        ];
        if (rawNodes.length > 0) {
            parts.push(`节点 ${visibleNodes.length}/${rawNodes.length}`, `连接 ${visibleEdges.length}`);
        }
        return parts.join('   ');
    }, [stats, rawNodes.length, visibleNodes.length, visibleEdges.length]);

    const chartOption: EChartsOption = useMemo(
        () =>
            buildTopologyOption({
                nodes: visibleNodes,
                edges: visibleEdges,
                palette,
                layout,
                fontScale,
                canvasSize: {width: chartWidth, height: chartHeight},
                summary: summaryText,
            }),
        [visibleNodes, visibleEdges, palette, layout, fontScale, chartWidth, chartHeight, summaryText],
    );

    // 节点点击：topic / partition 直接开详情页，之前只 console.log 等于没有交互。
    const handleChartClick = useCallback(
        (params: any) => {
            if (params.dataType !== 'node' || !params.data?.id) {
                return;
            }
            const node = rawNodes.find(candidate => candidate.id === params.data.id);
            if (!node || (node.type !== 'topic' && node.type !== 'partition')) {
                return;
            }
            const topicFullName = node.parentTopic || node.topicPath;
            if (!topicFullName || !node.clusterId) {
                return;
            }
            const topic = lastSegment(topicFullName);
            addTab(
                topicTab({
                    clusterId: node.clusterId,
                    tenant: node.tenant ?? '',
                    namespace: node.namespace ?? '',
                    topic,
                    persistent: node.persistent ?? true,
                }),
            );
        },
        [addTab, rawNodes],
    );

    // 图表操作 - 放大
    const handleZoomIn = useCallback(() => {
        zoomGraph(getChart(), 1.2);
    }, [getChart]);

    // 图表操作 - 缩小
    const handleZoomOut = useCallback(() => {
        zoomGraph(getChart(), 0.8);
    }, [getChart]);

    // 重置视图
    const handleResetView = useCallback(() => {
        const chart = getChart();
        if (!chart) {
            return;
        }

        resetGraphView(chart);

        message.success('视图已重置');
    }, [getChart]);

    // 刷新与重置视图是同一个动作：重拉一次拓扑本来就要重新看图，
    // 拆成两个按钮只是多占一格、还让人犹豫该点哪个。
    const handleReload = useCallback(() => {
        resetGraphView(getChart());
        void loadTopology();
    }, [getChart, loadTopology]);

    useCommand('topologyZoomIn', handleZoomIn);
    useCommand('topologyZoomOut', handleZoomOut);
    useCommand('topologyReset', handleResetView);

    const ownershipAlert =
        ownershipSource === 'singleBroker'
            ? '集群只有一个 Broker，所有 Topic 都连到它。这是单点事实，不代表真实的归属分布。'
            : ownershipSource === 'none'
              ? '本 broker 未提供 topic 归属信息（stats 里没有 ownerBroker），因此不画 Broker→Topic 连线，避免出现假的"全连接"关系。'
              : undefined;

    return (
        <PageShell
            rootRef={chartContainerRef}
            style={{
                overflow: 'hidden',
                backgroundColor: isFullscreen ? palette.surface : undefined,
            }}
            actions={
                <>
                    {/* 如果没有传入特定集群，显示集群选择器 */}
                    {!initialClusterId && clusters.length > 0 && (
                        <Select
                            aria-label="监控目标集群"
                            value={selectedCluster}
                            onChange={value => {
                                setSelectedClusterId(value);
                            }}
                            style={{width: 150}}
                            placeholder="选择集群"
                            options={clusters.map((c: ClusterConfig) => ({
                                // 色点就是状态，"(在线)/(离线)" 与它说的是同一件事，
                                // 还会把名字挤到截断
                                label: (
                                    <Space size={4}>
                                        <span
                                            className={`tree-status tree-status-${c.status ?? 'disconnected'}`}
                                            aria-hidden
                                        >
                                            <span className="tree-status-dot" />
                                        </span>
                                        <span>{c.name}</span>
                                    </Space>
                                ),
                                value: c.id,
                            }))}
                        />
                    )}
                    <Select
                        aria-label="显示的节点类型"
                        mode="multiple"
                        value={visibleTypes}
                        onChange={value => setVisibleTypes(value)}
                        style={{minWidth: 180, maxWidth: 240}}
                        placeholder="节点类型"
                        maxTagCount="responsive"
                        options={ALL_NODE_TYPES.filter(type => type !== 'cluster').map(type => ({
                            label: NODE_TYPE_LABELS[type],
                            value: type,
                        }))}
                    />
                    <Input.Search
                        allowClear
                        aria-label="按名称或租户筛选节点"
                        placeholder="按名称/租户筛选"
                        style={{width: 160}}
                        onSearch={value => setQuery(value)}
                        onChange={event => {
                            if (!event.target.value) {
                                setQuery('');
                            }
                        }}
                    />
                    <Select<TopologyLayout>
                        aria-label="拓扑布局"
                        value={layout}
                        onChange={value => setLayout(value)}
                        style={{width: 100}}
                        options={LAYOUT_OPTIONS}
                    />
                    <Tooltip title={`分区节点上限 ${MAX_PARTITION_NODES}`}>
                        <Space size={4}>
                            <Switch
                                size="small"
                                aria-label="显示分区节点"
                                checked={showPartitions}
                                onChange={setShowPartitions}
                            />
                            <span className="hint-text">显示分区</span>
                        </Space>
                    </Tooltip>
                    <IconButton icon={<ZoomInOutlined />} label="放大视图" onClick={handleZoomIn} />
                    <IconButton icon={<ZoomOutOutlined />} label="缩小视图" onClick={handleZoomOut} />
                    <IconButton
                        icon={isFullscreen ? <CompressOutlined /> : <FullscreenOutlined />}
                        label={isFullscreen ? '退出全屏' : '全屏'}
                        onClick={toggleFullscreen}
                    />
                    <IconButton
                        icon={<ReloadOutlined />}
                        label="刷新并重置视图"
                        loading={loading}
                        onClick={handleReload}
                    />
                </>
            }
        >
            {ownershipAlert && (
                <Alert type="warning" showIcon closable message={`Topic 归属信息受限：${ownershipAlert}`} />
            )}
            {truncatedPartitions && (
                <Alert
                    type="info"
                    showIcon
                    closable
                    message={`分区节点过多，仅展示前 ${MAX_PARTITION_NODES} 个。可用筛选缩小范围。`}
                />
            )}

            {/* 拓扑图 */}
            <Card
                styles={{
                    body: {padding: 0, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column'},
                }}
                style={{
                    flex: 1,
                    minHeight: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    height: isFullscreen ? '100vh' : undefined,
                    margin: isFullscreen ? 0 : undefined,
                }}
            >
                <Spin
                    spinning={loading && rawNodes.length === 0}
                    tip="正在加载拓扑数据..."
                    wrapperClassName="chart-spin"
                >
                    <div
                        ref={chartAreaRef}
                        style={{
                            flex: 1,
                            minHeight: 320,
                            position: 'relative',
                            // 图表容器被 zrender 写成行内像素，窗口缩小时这个像素值就是内容的最小宽度；
                            // flex 项的 min-width 默认 auto，不显式清零的话整条链回不去，图只能溢出而不是跟着缩。
                            minWidth: 0,
                            overflow: 'hidden',
                        }}
                    >
                        {rawNodes.length === 0 ? (
                            <StateBlock
                                empty
                                height="100%"
                                emptyText="暂无拓扑数据"
                                action={
                                    <Button type="primary" onClick={loadTopology}>
                                        加载拓扑
                                    </Button>
                                }
                            />
                        ) : visibleNodes.length === 0 ? (
                            <StateBlock empty height="100%" emptyText="当前筛选条件下没有节点" />
                        ) : (
                            <ReactECharts
                                ref={chartRef}
                                option={chartOption}
                                notMerge={false}
                                style={{
                                    width: chartWidth || '100%',
                                    height: chartHeight || 320,
                                }}
                                onChartReady={onChartInit}
                                opts={{
                                    renderer: 'canvas',
                                }}
                                onEvents={{click: handleChartClick}}
                            />
                        )}
                    </div>
                </Spin>
            </Card>
        </PageShell>
    );
};

export default ClusterTopology;
