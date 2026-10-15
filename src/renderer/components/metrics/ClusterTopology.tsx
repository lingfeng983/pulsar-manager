import React, {useContext, useEffect, useRef, useState, useCallback, useMemo} from 'react';
import {Card, Button, Space, Select, Spin, message, Input, Switch, Alert, Tooltip} from 'antd';
import {ReloadOutlined, ZoomInOutlined, ZoomOutOutlined, FullscreenOutlined, CompressOutlined} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import type {EChartsOption} from 'echarts';
import {useClusterStore} from '../../store/cluster';
import {useSettingsStore} from '../../store/settings';
import {useTabStore} from '../../store/tabs';
import type {ClusterConfig, ClusterTopology as ClusterTopologyPayload} from '../../types';
import {shortName} from '../../utils/format';
import {topicTab, topologyTab} from '../../utils/tabIds';
import {useFullscreen} from '../../hooks/useFullscreen';
import {useEchartsResize, zoomGraph, resetGraphView} from '../../hooks/useEcharts';
import {useElementSize} from '../../hooks/useElementSize';
import {PaneActiveContext, useCommand} from '../../hooks/useKeybindings';
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

// 全局视图要把多个集群同屏，把规模上限下推给主进程，避免为了几个节点遍历整个集群。
// 这里的值是"同屏概览画多少"，主进程 AGGREGATION_LIMITS 是"最多允许多少"，两层各自独立；
// 单集群视图不传 limits，整簇全展开。
const GLOBAL_TOPOLOGY_LIMITS = {
    maxTenants: 3,
    maxNamespacesPerTenant: 2,
    maxTopicsPerNamespace: 3,
    maxTopics: 8,
};

// 全局视图抽样时画得出的类型：订阅与分区根本不进图，
// 列进类型选择框或图例就是取不到数据、点了没反应的死项。
const GLOBAL_NODE_TYPES: TopologyNodeType[] = ['cluster', 'broker', 'topic'];

const lastSegment = (path: string): string => path.split('/').pop() || path;

/**
 * 全局视图里一个集群的子图：cluster + 抽样出来的 broker/topic。
 * id 一律带集群前缀——同一个 public/default/t1 可以同时存在于两个集群，
 * 不带前缀两张图的 topic 节点会撞在同一个 id 上，筛选和点击都会认错人。
 * broker→topic 连线按 payload 走：主进程已用 stats 里的 ownerBroker 反向聚合过，
 * 归属不可用时 brokers[].topics 就是空数组，宁可不连也不画假的全连接。
 */
function appendGlobalCluster(
    cluster: ClusterConfig,
    data: ClusterTopologyPayload,
    nodes: TopologyGraphNode[],
    edges: TopologyGraphEdge[],
): void {
    nodes.push({
        id: cluster.id,
        name: cluster.name,
        type: 'cluster',
        clusterId: cluster.id,
        clusterName: cluster.name,
        status: cluster.status ?? 'disconnected',
        count: data.topics?.length ?? 0,
    });

    const topicIdByName = new Map<string, string>();
    data.topics?.forEach((topic, idx) => {
        const topicId = `${cluster.id}-topic-${idx}`;
        topicIdByName.set(topic.name, topicId);
        nodes.push({
            id: topicId,
            name: shortName(topic.name),
            type: 'topic',
            clusterId: cluster.id,
            clusterName: cluster.name,
            tenant: topic.tenant,
            namespace: topic.namespace,
            topicPath: topic.name,
            persistent: topic.persistent,
            // 速率保留两位小数：Math.floor 会把 0.4 msg/s 显示成 0，
            // 慢速 topic 在提示里看着像"没有流量"。
            count: Math.round((topic.msgRateIn || 0) * 100) / 100,
        });
    });

    data.brokers?.forEach((broker, idx) => {
        const brokerId = `${cluster.id}-broker-${idx}`;
        nodes.push({
            id: brokerId,
            name: broker.name,
            type: 'broker',
            clusterId: cluster.id,
            clusterName: cluster.name,
            count: broker.topics?.length ?? 0,
        });
        edges.push({source: cluster.id, target: brokerId, value: 10});
        broker.topics?.forEach(topicName => {
            const topicId = topicIdByName.get(topicName);
            if (topicId) {
                edges.push({source: brokerId, target: topicId, value: 100});
            }
        });
    });
}

// 离线或明细取不到的集群不能整条从图上消失：留一个只有集群节点的降级气泡，
// 用户能看到"这个集群在，但取不到明细"，而不是以为它被删了。
function appendDegradedCluster(cluster: ClusterConfig, nodes: TopologyGraphNode[]): void {
    nodes.push({
        id: cluster.id,
        name: cluster.name,
        type: 'cluster',
        clusterId: cluster.id,
        clusterName: cluster.name,
        status: cluster.status ?? 'disconnected',
    });
}

const ClusterTopology: React.FC<ClusterTopologyProps> = ({clusterId}) => {
    // 不带 clusterId = 全局视图：多集群同屏、按集群抽样、点集群气泡下钻到单簇；
    // 带上 = 单集群视图：整簇全展开（订阅与可选分区）。
    // 原首页拓扑视图与本页同源同图（同一个聚合 IPC、同一份 graphOption），
    // 合并后只留这一个组件承载两种形态。
    const isGlobal = !clusterId;
    const [loading, setLoading] = useState(false);
    const [rawNodes, setRawNodes] = useState<TopologyGraphNode[]>([]);
    const [rawEdges, setRawEdges] = useState<TopologyGraphEdge[]>([]);
    const [ownershipSource, setOwnershipSource] = useState<ClusterTopologyPayload['ownershipSource'] | null>(null);
    const [truncatedPartitions, setTruncatedPartitions] = useState(false);
    const [partialError, setPartialError] = useState<string | null>(null);
    const [layout, setLayout] = useState<TopologyLayout>('force');
    const [query, setQuery] = useState('');
    const [showPartitions, setShowPartitions] = useState(false);
    const [stats, setStats] = useState({clusters: 0, brokers: 0, topics: 0, subscriptions: 0, partitions: 0});

    const selectableTypes = useMemo(
        () => (isGlobal ? GLOBAL_NODE_TYPES : ALL_NODE_TYPES.filter(type => type !== 'cluster')),
        [isGlobal],
    );
    const [visibleTypes, setVisibleTypes] = useState<TopologyNodeType[]>(selectableTypes);

    const chartRef = useRef<ReactECharts>(null);
    const getChart = useCallback(() => chartRef.current?.getEchartsInstance(), []);
    // 拓扑请求代次：重新加载后旧请求的晚到响应必须作废
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

    useEffect(() => {
        fetchClusters();
    }, [fetchClusters]);

    // 全局视图经 ref 读集群列表：cluster.ts 的探活会整份替换 clusters 数组，
    // 把数组引用放进 loadTopology 依赖会让每次探活都隐式重发一轮拓扑 IPC，
    // 还会把轮询定时器反复重启。这里只在发请求那一刻读一次当前值。
    const clustersRef = useRef(clusters);
    clustersRef.current = clusters;

    // 页签切走后组件仍挂载（display:none），拓扑 IPC 与力导向动画得跟着激活态停掉，
    // 门控方式同 MetricsDashboard 用 paneActive 停轮询。
    const paneActive = useContext(PaneActiveContext);

    // 图表实例初始化后的处理
    const onChartInit = useCallback((chart: any) => {
        if (chart) {
            setTimeout(() => chart.resize(), 100);
        }
    }, []);

    /**
     * 单集群转换。broker→topic 的连线完全按 payload 走：主进程已用 stats 里的
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
                nodes.push({id: broker.name, name: broker.name, type: 'broker', clusterId});
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
                    clusterId,
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
                        clusterId,
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
                        clusterId,
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
        [clusterId],
    );

    const loadTopology = useCallback(async () => {
        const requestId = ++topologyRequestRef.current;
        setLoading(true);
        try {
            if (isGlobal) {
                const current = clustersRef.current;
                const connected = current.filter(c => c.status === 'connected');
                const nodes: TopologyGraphNode[] = [];
                const edges: TopologyGraphEdge[] = [];
                const failures: string[] = [];
                // 离线集群连明细都没有，只落一个降级的红色集群气泡
                current.filter(c => c.status !== 'connected').forEach(c => appendDegradedCluster(c, nodes));

                const results = await Promise.allSettled(
                    connected.map(c => window.electronAPI.topology.getClusterTopology(c.id, GLOBAL_TOPOLOGY_LIMITS)),
                );
                if (requestId !== topologyRequestRef.current) {
                    return;
                }

                results.forEach((result, index) => {
                    const cluster = connected[index];
                    if (result.status === 'fulfilled' && result.value.success && result.value.data) {
                        appendGlobalCluster(cluster, result.value.data, nodes, edges);
                        return;
                    }
                    // 单个集群取失败不掩掉整屏：图上留降级气泡，横幅里记原因。
                    // 直接插值 Error 会带上 "Error: " 前缀，这里只取 message。
                    const reason =
                        result.status === 'rejected'
                            ? result.reason instanceof Error
                                ? result.reason.message
                                : String(result.reason)
                            : result.value?.error || '获取拓扑数据失败';
                    failures.push(`${cluster.name}: ${reason}`);
                    appendDegradedCluster(cluster, nodes);
                });

                setPartialError(
                    failures.length > 0
                        ? `部分集群数据加载失败: ${failures.slice(0, 2).join('，')}${failures.length > 2 ? ' 等' : ''}`
                        : null,
                );
                setRawNodes(nodes);
                setRawEdges(edges);
                setOwnershipSource(null);
                setTruncatedPartitions(false);
                setStats({
                    clusters: current.length,
                    brokers: nodes.filter(n => n.type === 'broker').length,
                    topics: nodes.filter(n => n.type === 'topic').length,
                    subscriptions: 0,
                    partitions: 0,
                });
                return;
            }

            if (!clusterId) {
                return;
            }
            const response = await window.electronAPI.topology.getClusterTopology(clusterId);
            // 上一轮（如切换显示分区）的晚到响应不能覆盖当前图
            if (requestId !== topologyRequestRef.current) {
                return;
            }

            if (response.success && response.data) {
                const {nodes, edges} = transformTopologyData(response.data, showPartitions);
                setRawNodes(nodes);
                setRawEdges(edges);
                setOwnershipSource(response.data.ownershipSource);
                setPartialError(null);
                setTruncatedPartitions(false);
                setStats({
                    clusters: 0,
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
                setStats({clusters: 0, brokers: 0, topics: 0, subscriptions: 0, partitions: 0});
            }
        } catch (error) {
            if (requestId !== topologyRequestRef.current) {
                return;
            }
            console.error('Failed to load topology:', error);
            message.error('加载拓扑数据失败');
        } finally {
            if (requestId === topologyRequestRef.current) {
                setLoading(false);
            }
        }
    }, [isGlobal, clusterId, showPartitions, transformTopologyData]);

    // 页签激活时才首拉：非活动页签不重发拓扑 IPC，也不在隐藏容器上跑加载与动画。
    useEffect(() => {
        if (!paneActive) {
            return;
        }
        void loadTopology();
    }, [paneActive, loadTopology]);

    const statusRefreshSeconds = useSettingsStore(state => state.settings.statusRefreshSeconds);

    // 轮询复用首页状态探活的同一个间隔：图上"在线/离线"染色和气泡内容跟着
    // 同一节奏刷新，不再养第二套间隔。代价是单集群模式每轮一次整簇拓扑 IPC，
    // 嫌重可以在配置中心把间隔调大或设成 0（只在打开页签时拉一次）。
    useEffect(() => {
        if (!paneActive || statusRefreshSeconds <= 0) {
            return;
        }
        const timer = setInterval(() => void loadTopology(), statusRefreshSeconds * 1000);
        return () => clearInterval(timer);
    }, [paneActive, statusRefreshSeconds, loadTopology]);

    // 筛选在渲染层做：节点已经在内存里，重新拉一次 IPC 只会更慢。
    const {nodes: visibleNodes, edges: visibleEdges} = useMemo(
        () => filterTopologyGraph(rawNodes, rawEdges, {types: new Set(visibleTypes), query: query.trim()}),
        [rawNodes, rawEdges, visibleTypes, query],
    );

    // 规模计数：画在图内左上角那一行，不再单独占图外一行
    const summaryText = useMemo(() => {
        const parts = isGlobal
            ? [`集群 ${stats.clusters}`, `Brokers ${stats.brokers}`, `Topics ${stats.topics}`]
            : [
                  `Brokers ${stats.brokers}`,
                  `Topics ${stats.topics}`,
                  `Subscriptions ${stats.subscriptions}`,
                  `分区 ${stats.partitions}`,
              ];
        if (rawNodes.length > 0) {
            parts.push(`节点 ${visibleNodes.length}/${rawNodes.length}`, `连接 ${visibleEdges.length}`);
        }
        return parts.join('   ');
    }, [isGlobal, stats, rawNodes.length, visibleNodes.length, visibleEdges.length]);

    const chartOption: EChartsOption = useMemo(
        () =>
            buildTopologyOption({
                nodes: visibleNodes,
                edges: visibleEdges,
                palette,
                layout,
                // 图例只列这种形态画得出来的类型，否则就是点了没反应的死项
                legendTypes: selectableTypes,
                fontScale,
                canvasSize: {width: chartWidth, height: chartHeight},
                summary: summaryText,
            }),
        [visibleNodes, visibleEdges, palette, layout, selectableTypes, fontScale, chartWidth, chartHeight, summaryText],
    );

    // 节点点击：topic / partition 直接开详情页；全局视图里点集群气泡下钻到该集群的单簇拓扑页签。
    const handleChartClick = useCallback(
        (params: any) => {
            if (params.dataType !== 'node' || !params.data?.id) {
                return;
            }
            const node = rawNodes.find(candidate => candidate.id === params.data.id);
            if (!node) {
                return;
            }
            if (isGlobal && node.type === 'cluster') {
                if (node.clusterId) {
                    addTab(topologyTab(node.clusterId, node.clusterName));
                }
                return;
            }
            if (node.type !== 'topic' && node.type !== 'partition') {
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
        [addTab, isGlobal, rawNodes],
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

    const ownershipAlert = !isGlobal
        ? ownershipSource === 'singleBroker'
            ? '集群只有一个 Broker，所有 Topic 都连到它。这是单点事实，不代表真实的归属分布。'
            : ownershipSource === 'none'
              ? '本 broker 未提供 topic 归属信息（stats 里没有 ownerBroker），因此不画 Broker→Topic 连线，避免出现假的"全连接"关系。'
              : undefined
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
                    {/* 全局视图没有"换看哪个集群"这回事——画的就是全部集群；
                        要看单簇就点集群气泡下钻，那是另一条页签。 */}
                    <Select
                        aria-label="显示的节点类型"
                        mode="multiple"
                        value={visibleTypes}
                        onChange={value => setVisibleTypes(value)}
                        style={{minWidth: 180, maxWidth: 240}}
                        placeholder="节点类型"
                        maxTagCount="responsive"
                        options={selectableTypes.map(type => ({
                            label: NODE_TYPE_LABELS[type],
                            value: type,
                        }))}
                    />
                    {/* 与首页/资源树/命名空间一致：边打字边筛，不要按回车才生效。
                        节点都在内存里，逐键重算的成本就是一次 filter。 */}
                    <Input
                        allowClear
                        aria-label="按名称或租户筛选节点"
                        placeholder="按名称/租户筛选"
                        style={{width: 180}}
                        value={query}
                        onChange={event => setQuery(event.target.value)}
                    />
                    <Select<TopologyLayout>
                        aria-label="拓扑布局"
                        value={layout}
                        onChange={value => setLayout(value)}
                        style={{width: 100}}
                        options={LAYOUT_OPTIONS}
                    />
                    {!isGlobal && (
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
                    )}
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
            {partialError && (
                <Alert type="warning" showIcon closable message={partialError} onClose={() => setPartialError(null)} />
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
                                emptyText={
                                    isGlobal && clusters.length === 0
                                        ? '暂无集群配置，请先添加集群以查看拓扑图'
                                        : '暂无拓扑数据'
                                }
                                action={
                                    <Button type="primary" onClick={handleReload}>
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
