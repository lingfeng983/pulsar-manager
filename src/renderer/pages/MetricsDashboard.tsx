import React, {useState, useEffect, useCallback, useRef, useMemo, useContext} from 'react';
import {Card, Row, Col, Select, Button, Statistic, Progress, DatePicker, message} from 'antd';
import {ReloadOutlined} from '@ant-design/icons';
import type {EChartsOption} from 'echarts';
import dayjs from 'dayjs';
import {useClusterStore} from '../store/cluster';
import {useSettingsStore} from '../store/settings';
import {formatThroughput, toKilobytesPerSecond} from '../utils/format';
import {filterByLabel} from '../utils/textFilter';
import {useTopologyPalette, type TopologyPalette} from '../utils/topologyColors';
import {useFontFactor} from '../utils/fontScale';
import {useCommand, PaneActiveContext} from '../hooks/useKeybindings';
import PageShell from '../components/common/PageShell';
import StateBlock from '../components/common/StateBlock';
import ErrorBanner from '../components/common/ErrorBanner';
import ChartCard from '../components/metrics/ChartCard';
import type {ClusterTopology, MetricsSnapshot} from '../types';

const {RangePicker} = DatePicker;

interface MetricsData {
    timestamp: number;
    value: number;
}

interface MultiMetricsHistory {
    msgRateIn: MetricsData[];
    msgRateOut: MetricsData[];
    throughputIn: MetricsData[];
    throughputOut: MetricsData[];
    backlog: MetricsData[];
}

interface AggregatedStats {
    totalTopics: number;
    totalPartitions: number;
    totalSubscriptions: number;
    totalProducers: number;
    totalConsumers: number;
    totalMsgRateIn: number;
    totalMsgRateOut: number;
    totalThroughputIn: number;
    totalThroughputOut: number;
    totalBacklog: number;
}

const EMPTY_HISTORY: MultiMetricsHistory = {
    msgRateIn: [],
    msgRateOut: [],
    throughputIn: [],
    throughputOut: [],
    backlog: [],
};

// 内存曲线窗口。以前是 60 个点（一次会话的量），留存上线后种子历史会远多于它，
// 所以窗口放宽：按默认 30s 刷新算约 16 小时，再早的点交给日期区间过滤器。
const HISTORY_WINDOW = 2000;

// 库里的快照行摊回五条序列：形状与内存点完全一致，图上分不出来源。
const toHistory = (rows: MetricsSnapshot[]): MultiMetricsHistory => ({
    msgRateIn: rows.map(row => ({timestamp: row.capturedAt, value: row.msgRateIn})),
    msgRateOut: rows.map(row => ({timestamp: row.capturedAt, value: row.msgRateOut})),
    throughputIn: rows.map(row => ({timestamp: row.capturedAt, value: row.throughputIn})),
    throughputOut: rows.map(row => ({timestamp: row.capturedAt, value: row.throughputOut})),
    backlog: rows.map(row => ({timestamp: row.capturedAt, value: row.backlog})),
});

// 按时间戳去重合并：同一毫秒只留后写入的那个值，再升序排回来直接当 x 轴用。
const mergeSeries = (seeded: MetricsData[], live: MetricsData[]): MetricsData[] => {
    const byTimestamp = new Map<number, number>();
    [...seeded, ...live].forEach(point => byTimestamp.set(point.timestamp, point.value));
    return [...byTimestamp.entries()]
        .sort((a, b) => a[0] - b[0])
        .slice(-HISTORY_WINDOW)
        .map(([timestamp, value]) => ({timestamp, value}));
};

const mergeHistory = (seeded: MultiMetricsHistory, live: MultiMetricsHistory): MultiMetricsHistory => ({
    msgRateIn: mergeSeries(seeded.msgRateIn, live.msgRateIn),
    msgRateOut: mergeSeries(seeded.msgRateOut, live.msgRateOut),
    throughputIn: mergeSeries(seeded.throughputIn, live.throughputIn),
    throughputOut: mergeSeries(seeded.throughputOut, live.throughputOut),
    backlog: mergeSeries(seeded.backlog, live.backlog),
});

// 三套主题共用的 ECharts 基色：文字/坐标轴/分割线/tooltip 全部从 CSS 变量读，
// 否则暗色主题下轴标签是默认深灰，整张图糊成一片。
// scale 是全局字号档位相对默认档的比例：canvas 文字读不到 CSS 变量，只能乘进来。
const seriesAxes = (p: TopologyPalette, scale: number) => ({
    axisLabel: {color: p.label, fontSize: Math.round(12 * scale)},
    axisLine: {lineStyle: {color: p.border}},
    splitLine: {lineStyle: {color: p.border}},
});

const seriesTooltip = (p: TopologyPalette, scale: number) => ({
    backgroundColor: p.surface,
    borderColor: p.border,
    textStyle: {color: p.text, fontSize: Math.round(14 * scale)},
});

const seriesTitle = (p: TopologyPalette, text: string, scale: number) => ({
    text,
    left: 'center' as const,
    textStyle: {fontSize: Math.round(14 * scale), fontWeight: 500 as const, color: p.text},
});

// 轴类图表通用的缩放交互：滚轮贴着鼠标位置横向缩放、按住拖拽平移、右上角框选任意区域放大
// （框选同时缩放横纵两轴）、选错了点"区域还原"、全乱了点"重置"。饼图没有坐标轴，用不上
// 这套，所以只给折线与柱状用。
const zoomControls = (p: TopologyPalette) => ({
    dataZoom: [
        {
            type: 'inside' as const,
            xAxisIndex: 0,
            zoomOnMouseWheel: true,
            moveOnMouseMove: true,
            moveOnMouseWheel: false,
        },
    ],
    toolbox: {
        right: 8,
        top: 4,
        itemGap: 8,
        iconStyle: {borderColor: p.label},
        emphasis: {iconStyle: {borderColor: p.primary}},
        feature: {
            dataZoom: {
                title: {zoom: '框选区域放大', back: '区域还原'},
                yAxisIndex: 0,
            },
            restore: {title: '重置'},
        },
    },
});

// 留存上线后一条曲线可能横跨几天，只写时分的话周一 10:00 和周二 10:00
// 会是同一个标签；跨度超过一天就带上日期。
const spanAwareTimeFormat = (timestamps: number[]): string => {
    if (timestamps.length < 2) {
        return 'HH:mm:ss';
    }
    const span = Math.max(...timestamps) - Math.min(...timestamps);
    return span > 24 * 3600 * 1000 ? 'MM-DD HH:mm' : 'HH:mm:ss';
};

// 时序折线图配置
const createTimeSeriesOption = (
    title: string,
    data: MetricsData[],
    color: string,
    palette: TopologyPalette,
    unit: string,
    scale: number,
): EChartsOption => {
    const axes = seriesAxes(palette, scale);
    const labelFormat = spanAwareTimeFormat(data.map(d => d.timestamp));
    return {
        title: seriesTitle(palette, title, scale),
        ...zoomControls(palette),
        tooltip: {
            trigger: 'axis',
            ...seriesTooltip(palette, scale),
            formatter: (params: any) => {
                const point = params[0];
                return `${dayjs(point.value[0]).format(labelFormat)}<br/>${point.value[1].toFixed(2)} ${unit}`;
            },
        },
        grid: {left: '3%', right: '4%', bottom: '3%', top: '40px', containLabel: true},
        xAxis: {
            type: 'time',
            ...axes,
            axisLabel: {
                ...axes.axisLabel,
                formatter: (value: number) => dayjs(value).format(labelFormat),
            },
        },
        yAxis: {
            type: 'value',
            name: unit,
            nameTextStyle: {color: palette.label, fontSize: Math.round(12 * scale)},
            ...axes,
        },
        series: [
            {
                type: 'line',
                smooth: true,
                symbol: 'none',
                lineStyle: {width: 2, color},
                areaStyle: {color: `${color}20`},
                data: data.map(d => [d.timestamp, d.value]),
            },
        ],
    };
};

// 吞吐量柱状图配置
const createThroughputBarOption = (
    data: {time: string; in: number; out: number}[],
    palette: TopologyPalette,
    scale: number,
): EChartsOption => ({
    ...zoomControls(palette),
    tooltip: {trigger: 'axis', ...seriesTooltip(palette, scale)},
    legend: {data: ['输入', '输出'], top: 0, textStyle: {color: palette.label, fontSize: Math.round(12 * scale)}},
    grid: {left: '3%', right: '4%', bottom: '3%', top: '40px', containLabel: true},
    xAxis: {type: 'category', data: data.map(d => d.time), ...seriesAxes(palette, scale)},
    yAxis: {
        type: 'value',
        name: 'KB/s',
        nameTextStyle: {color: palette.label, fontSize: Math.round(12 * scale)},
        ...seriesAxes(palette, scale),
    },
    series: [
        {
            name: '输入',
            type: 'bar',
            data: data.map(d => d.in),
            itemStyle: {color: palette.primary},
        },
        {
            name: '输出',
            type: 'bar',
            data: data.map(d => d.out),
            itemStyle: {color: palette.success},
        },
    ],
});

// 资源分布饼图配置
const createPieOption = (
    data: {name: string; value: number}[],
    title: string,
    palette: TopologyPalette,
    scale: number,
): EChartsOption => ({
    title: seriesTitle(palette, title, scale),
    tooltip: {
        trigger: 'item',
        formatter: '{a} <br/>{b}: {c} ({d}%)',
        ...seriesTooltip(palette, scale),
    },
    legend: {
        orient: 'vertical',
        left: 'left',
        textStyle: {color: palette.label, fontSize: Math.round(12 * scale)},
    },
    series: [
        {
            name: title,
            type: 'pie',
            radius: ['40%', '70%'],
            avoidLabelOverlap: false,
            itemStyle: {
                borderRadius: 10,
                borderColor: palette.surface,
                borderWidth: 2,
            },
            label: {
                show: true,
                formatter: '{b}: {c}',
                color: palette.label,
                fontSize: Math.round(12 * scale),
            },
            data,
        },
    ],
});

// clusterId 由工作区页签传入（`metrics-<clusterId>`）；不带则是资源树工具栏的
// 全局监控页签，此时回落到自动选一个已连接集群。
type TopologyTopic = ClusterTopology['topics'][number];

// 同名 topic 可以出现在不同 namespace / 不同持久性下，选项值必须是全路径而不是名字。
const topicKey = (t: TopologyTopic) =>
    `${t.persistent ? 'persistent' : 'non-persistent'}/${t.tenant}/${t.namespace}/${t.name}`;

// 拓扑结果里的 topic.name 已经是 tenant/ns/topic 全路径，而 resources:getTopicStats
// 的入参校验只收短名（正则不含斜杠），所以取最后一段。
const shortTopicName = (fullName: string) => fullName.split('/').pop() ?? fullName;

// 采样口径的落库键：集群总体用空串，单个 topic 用完整 URI。
// URI 取 `persistent://tenant/ns/短名`，与发送历史、页签 id 用的是同一写法。
const scopeUriOf = (topic?: TopologyTopic): string =>
    topic
        ? `${topic.persistent ? 'persistent' : 'non-persistent'}://${topic.tenant}/${topic.namespace}/${shortTopicName(topic.name)}`
        : '';

const MetricsDashboard: React.FC<{clusterId?: string}> = ({clusterId}) => {
    const palette = useTopologyPalette();
    const fontScale = useFontFactor();
    const [loading, setLoading] = useState(false);
    const [selectedCluster, setSelectedCluster] = useState<string>(clusterId ?? '');
    const [stats, setStats] = useState<AggregatedStats | null>(null);
    const [brokers, setBrokers] = useState<string[]>([]);
    // 这一行的 brokers 是"该 topic 的归属"还是"集群活跃列表"：两种口径不能共用一个标签
    const [brokersAreOwner, setBrokersAreOwner] = useState(false);
    // 监控维度：不选 topic 就是集群总体（走聚合统计），选了就是单个 topic
    // （走该 topic 的 /stats），四条曲线与四张卡跟着换口径。
    const [topics, setTopics] = useState<TopologyTopic[]>([]);
    const [topicsLoading, setTopicsLoading] = useState(false);
    const [selectedTopic, setSelectedTopic] = useState('');
    // 刷新节奏是应用级设置（配置中心可改），页面上的选择器直接读写它：
    // 关掉自动刷新等价于选择"手动"，两处状态不会各说各话。
    const autoRefresh = useSettingsStore(state => state.settings.autoRefresh);
    const refreshIntervalSeconds = useSettingsStore(state => state.settings.refreshIntervalSeconds);
    const metricsSnapshotEnabled = useSettingsStore(state => state.settings.metricsSnapshotEnabled);
    const metricsRetentionDays = useSettingsStore(state => state.settings.metricsRetentionDays);
    const updateSettings = useSettingsStore(state => state.update);
    const refreshInterval = autoRefresh ? refreshIntervalSeconds : 0;
    const [dateRange, setDateRange] = useState<[dayjs.Dayjs, dayjs.Dayjs] | null>(null);
    const [metricsHistory, setMetricsHistory] = useState<MultiMetricsHistory>(EMPTY_HISTORY);
    const [error, setError] = useState<string | null>(null);
    const [peakMsgRate, setPeakMsgRate] = useState(0);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    // 单调递增的请求代次：切换集群后，旧集群的晚到响应不能覆盖新集群的数据
    const loadRequestRef = useRef(0);
    // 外层页签切走后组件仍挂载（display:none），定时器得跟着激活态停掉
    const paneActive = useContext(PaneActiveContext);

    const {clusters, fetchClusters} = useClusterStore();

    // 初始化
    useEffect(() => {
        fetchClusters();
    }, [fetchClusters]);

    // 设置默认集群（优先选择已连接的集群）。页签指定了集群就不插手，否则用户从
    // 某集群的监控页签切一下集群，页面会自己跳回"第一个已连接集群"。
    useEffect(() => {
        if (clusterId || clusters.length === 0 || selectedCluster) {
            return;
        }
        // 优先选择已连接的集群
        const connectedCluster = clusters.find(c => c.status === 'connected');
        setSelectedCluster(connectedCluster?.id || clusters[0].id);
    }, [clusters, selectedCluster, clusterId]);

    // 跟踪峰值消息速率（用于进度条动态分母）
    useEffect(() => {
        if (stats) {
            setPeakMsgRate(prev => Math.max(prev, stats.totalMsgRateIn || 0));
        }
    }, [stats]);

    // 过滤指定时间范围内的数据
    const filterMetricsByDateRange = useCallback(
        (data: MetricsData[], range: [dayjs.Dayjs, dayjs.Dayjs] | null): MetricsData[] => {
            if (!range) return data;

            const [start, end] = range;
            return data.filter(d => {
                const timestamp = dayjs(d.timestamp);
                // 端点必须是闭区间：RangePicker 的结束时间默认就是"现在"，
                // 用 isBefore 会把刚采到的最新一点排除掉，图上永远少一根柱子。
                return !timestamp.isBefore(start) && !timestamp.isAfter(end);
            });
        },
        [],
    );

    // 一次采样写入五条序列：集群维度与 topic 维度只是数值来源不同，历史窗口
    // 和单位都一样，所以两边共用这一份写入逻辑。
    // 留存开关打开时同一个点再落一份到 SQLite——曲线窗口因此不再等于"本次会话"，
    // 切页签、重启进程都还接得上历史（以前重启即归零）。
    const pushSample = useCallback(
        (sample: AggregatedStats, scopeUri: string) => {
            const now = Date.now();
            const point = (value: number) => ({timestamp: now, value});
            setMetricsHistory(prev => ({
                msgRateIn: [...prev.msgRateIn, point(sample.totalMsgRateIn)].slice(-HISTORY_WINDOW),
                msgRateOut: [...prev.msgRateOut, point(sample.totalMsgRateOut)].slice(-HISTORY_WINDOW),
                throughputIn: [...prev.throughputIn, point(sample.totalThroughputIn)].slice(-HISTORY_WINDOW),
                throughputOut: [...prev.throughputOut, point(sample.totalThroughputOut)].slice(-HISTORY_WINDOW),
                backlog: [...prev.backlog, point(sample.totalBacklog)].slice(-HISTORY_WINDOW),
            }));
            if (!metricsSnapshotEnabled || !selectedCluster) {
                return;
            }
            // 落库不阻塞曲线：写失败（库被占、集群行已删）只是这一轮少个点，
            void window.electronAPI.metrics
                .recordSnapshot({
                    clusterId: selectedCluster,
                    topicUri: scopeUri,
                    msgRateIn: sample.totalMsgRateIn,
                    msgRateOut: sample.totalMsgRateOut,
                    throughputIn: sample.totalThroughputIn,
                    throughputOut: sample.totalThroughputOut,
                    backlog: sample.totalBacklog,
                    producers: sample.totalProducers,
                    consumers: sample.totalConsumers,
                })
                .catch(() => undefined);
        },
        [metricsSnapshotEnabled, selectedCluster],
    );

    // topic 维度候选：一次拓扑请求就够，拓扑结果里每个 topic 都带着
    // tenant/namespace/持久性，正好是取该 topic 统计所需的三元组，不必再逐层展开资源树。
    useEffect(() => {
        // 换集群时 topic 维度归零：上一个集群的 topic 名字在新集群里没有意义
        setSelectedTopic('');
        if (!selectedCluster) {
            setTopics([]);
            return;
        }
        let cancelled = false;
        setTopicsLoading(true);
        window.electronAPI.topology
            .getClusterTopology(selectedCluster)
            .then(response => {
                if (cancelled) {
                    return;
                }
                setTopicsLoading(false);
                setTopics(response.success && response.data ? response.data.topics : []);
            })
            .catch(() => {
                if (cancelled) {
                    return;
                }
                setTopicsLoading(false);
                setTopics([]);
            });
        return () => {
            cancelled = true;
        };
    }, [selectedCluster]);

    // 加载当前维度的统计：选了整个集群就走聚合统计 + broker 列表，选了单个 topic 就走它的 /stats
    const loadAggregatedStats = useCallback(async () => {
        if (!selectedCluster) return;

        const requestId = ++loadRequestRef.current;
        const isStale = () => requestId !== loadRequestRef.current;
        const topic = selectedTopic ? topics.find(t => topicKey(t) === selectedTopic) : undefined;
        if (selectedTopic && !topic) {
            // 刚切集群、topic 候选还没回来的那一帧：本轮跳过，别把上一个集群的同名 topic 采进来
            return;
        }

        setLoading(true);
        setError(null);
        try {
            if (topic) {
                const response = await window.electronAPI.resources.getTopicStats(
                    selectedCluster,
                    topic.tenant,
                    topic.namespace,
                    shortTopicName(topic.name),
                    topic.persistent,
                );
                if (isStale()) {
                    return;
                }
                if (response.success && response.data) {
                    const s = response.data;
                    const sample: AggregatedStats = {
                        totalTopics: 1,
                        totalPartitions: s.partitions.length,
                        totalSubscriptions: Object.keys(s.subscriptions).length,
                        totalProducers: s.producers.length,
                        totalConsumers: s.consumers.length,
                        totalMsgRateIn: s.msgRateIn,
                        totalMsgRateOut: s.msgRateOut,
                        totalThroughputIn: s.msgThroughputIn,
                        totalThroughputOut: s.msgThroughputOut,
                        totalBacklog: s.backlogSize,
                    };
                    setStats(sample);
                    pushSample(sample, scopeUriOf(topic));
                    // 归属拿得到就报归属；归属不可用时退回集群活跃列表并照实标注，
                    // 否则界面上一个"归属 Broker 0"会被读成这个 topic 没有 broker。
                    if (s.ownerBrokers?.length) {
                        setBrokers(s.ownerBrokers);
                        setBrokersAreOwner(true);
                    } else {
                        const brokerList = await window.electronAPI.metrics.getBrokers(selectedCluster);
                        if (isStale()) {
                            return;
                        }
                        setBrokers(brokerList.success && brokerList.data ? brokerList.data.activeBrokers || [] : []);
                        setBrokersAreOwner(false);
                    }
                } else {
                    setError(response.error || `获取 Topic ${topic.name} 统计失败`);
                }
                return;
            }

            // 获取聚合统计
            const statsResponse = await window.electronAPI.metrics.getAggregatedStats(selectedCluster);
            if (isStale()) {
                return;
            }
            if (statsResponse.success && statsResponse.data) {
                setStats(statsResponse.data);
                pushSample(statsResponse.data, '');
            } else {
                setError(statsResponse.error || '获取统计数据失败');
            }

            // 获取 Broker 信息
            const brokersResponse = await window.electronAPI.metrics.getBrokers(selectedCluster);
            if (isStale()) {
                return;
            }
            if (brokersResponse.success && brokersResponse.data) {
                setBrokers(brokersResponse.data.activeBrokers || []);
                setBrokersAreOwner(false);
            } else if (!brokersResponse.success) {
                // 只写 console 的话界面上的"活跃 Brokers 0 个"看起来像集群真的没有 broker
                setError(brokersResponse.error || '获取 Broker 信息失败');
            }
        } catch (error) {
            if (isStale()) {
                return;
            }
            console.error('Failed to load aggregated stats:', error);
            setError('网络错误，请检查连接');
        } finally {
            if (!isStale()) {
                setLoading(false);
            }
        }
    }, [selectedCluster, selectedTopic, topics, pushSample]);

    // 切换集群或 topic：作废在途请求并清空上一个维度的统计、历史与峰值
    useEffect(() => {
        loadRequestRef.current += 1;
        setStats(null);
        setBrokers([]);
        setBrokersAreOwner(false);
        setMetricsHistory(EMPTY_HISTORY);
        setPeakMsgRate(0);
        setError(null);
        setLoading(false);
    }, [selectedCluster, selectedTopic]);

    // 切换维度后把库里留过的点铺回曲线（清空在上一个 effect 里同步做完，这里异步落地）。
    // 种子与本轮新采的点可能撞在同一毫秒——切完维度立刻刷了一次——所以合并去重而不是整份覆盖。
    useEffect(() => {
        if (!selectedCluster || !metricsSnapshotEnabled) {
            return;
        }
        const topic = selectedTopic ? topics.find(t => topicKey(t) === selectedTopic) : undefined;
        if (selectedTopic && !topic) {
            // topic 候选还没回来的那一帧：这一轮跳过，否则会把集群口径的历史画到 topic 上
            return;
        }
        let cancelled = false;
        window.electronAPI.metrics
            .listSnapshots({
                clusterId: selectedCluster,
                topicUri: scopeUriOf(topic),
                hours: metricsRetentionDays * 24,
                limit: HISTORY_WINDOW,
            })
            .then(response => {
                if (cancelled || !response.success || !response.data?.length) {
                    return;
                }
                const seeded = toHistory(response.data);
                setMetricsHistory(prev => mergeHistory(seeded, prev));
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [selectedCluster, selectedTopic, topics, metricsSnapshotEnabled, metricsRetentionDays]);

    useCommand('refreshMetrics', () => {
        void loadAggregatedStats();
    });

    // 初始加载和定时刷新
    const hasConnectedCluster = clusters.some(c => c.status === 'connected');
    useEffect(() => {
        if (!paneActive) {
            return;
        }
        // 只有有已连接集群时才加载和刷新
        if (selectedCluster && hasConnectedCluster) {
            loadAggregatedStats();
        }

        if (refreshInterval > 0 && hasConnectedCluster) {
            intervalRef.current = setInterval(() => loadAggregatedStats(), refreshInterval * 1000);
        }

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
            }
        };
    }, [selectedCluster, loadAggregatedStats, refreshInterval, hasConnectedCluster, paneActive]);

    // 使用 useMemo 缓存图表配置
    const currentTopic = useMemo(() => topics.find(t => topicKey(t) === selectedTopic), [topics, selectedTopic]);
    // 图上标出当前口径，否则切到某个 topic 后四条曲线看着和集群总体一模一样
    const scopeSuffix = currentTopic ? ` · ${currentTopic.name}` : '';

    const msgRateInChartOption = useMemo(() => {
        const filteredData = filterMetricsByDateRange(metricsHistory.msgRateIn, dateRange);
        return createTimeSeriesOption('', filteredData, palette.primary, palette, 'msg/s', fontScale);
    }, [metricsHistory.msgRateIn, dateRange, filterMetricsByDateRange, palette, fontScale]);

    const msgRateOutChartOption = useMemo(() => {
        const filteredData = filterMetricsByDateRange(metricsHistory.msgRateOut, dateRange);
        return createTimeSeriesOption('', filteredData, palette.success, palette, 'msg/s', fontScale);
    }, [metricsHistory.msgRateOut, dateRange, filterMetricsByDateRange, palette, fontScale]);

    // 生成吞吐量柱状图数据（使用真实历史数据 + 日期过滤）
    const throughputData = useMemo(() => {
        const filteredIn = filterMetricsByDateRange(metricsHistory.throughputIn, dateRange);
        const filteredOut = filterMetricsByDateRange(metricsHistory.throughputOut, dateRange);

        if (filteredIn.length === 0) return [];

        const labelFormat = spanAwareTimeFormat(filteredIn.map(d => d.timestamp));

        // 按时间戳配对，而不是按下标：两条序列各由过滤得到，一旦点位不齐
        // 下标对齐就会把某个时刻的入向配到另一时刻的出向，柱子高矮全错。
        const outByTimestamp = new Map(filteredOut.map(d => [d.timestamp, d.value]));

        return filteredIn.map(d => ({
            time: dayjs(d.timestamp).format(labelFormat),
            // 源数据单位是字节/秒，图表轴标注的是 KB/s，这里必须换算
            in: toKilobytesPerSecond(d.value),
            out: toKilobytesPerSecond(outByTimestamp.get(d.timestamp) ?? 0),
        }));
    }, [metricsHistory.throughputIn, metricsHistory.throughputOut, dateRange, filterMetricsByDateRange]);

    // 吞吐量柱状图配置
    const throughputChartOption = useMemo(
        () => createThroughputBarOption(throughputData, palette, fontScale),
        [throughputData, palette, fontScale],
    );

    // 资源分布数据
    const resourceData = useMemo(() => {
        if (!stats) return [];
        // topic 维度下 "Topics=1" 混在饼里就是一块没有意义的 1，换成该 topic 自己的构成
        return selectedTopic
            ? [
                  {name: '分区', value: stats.totalPartitions},
                  {name: 'Subscriptions', value: stats.totalSubscriptions},
                  {name: 'Producers', value: stats.totalProducers},
                  {name: 'Consumers', value: stats.totalConsumers},
              ]
            : [
                  {name: 'Topics', value: stats.totalTopics},
                  {name: 'Subscriptions', value: stats.totalSubscriptions},
                  {name: 'Producers', value: stats.totalProducers},
                  {name: 'Consumers', value: stats.totalConsumers},
              ];
    }, [stats, selectedTopic]);

    // 资源分布饼图配置
    const resourceChartOption = useMemo(
        () => createPieOption(resourceData, selectedTopic ? 'Topic 资源' : '集群资源', palette, fontScale),
        [resourceData, selectedTopic, palette, fontScale],
    );

    // 保留窗口的起点：只存 60 个采样点，更早的时间在图上永远不会有数据。
    // 把 RangePicker 限制在这个窗口内，避免用户选到一段必然为空的区间。
    const retainedStart = useMemo(() => {
        const first = metricsHistory.msgRateIn[0]?.timestamp;
        if (first) {
            return dayjs(first);
        }
        const step = autoRefresh ? refreshIntervalSeconds : 5;
        return dayjs().subtract(60 * step, 'second');
    }, [metricsHistory.msgRateIn, autoRefresh, refreshIntervalSeconds]);

    return (
        <PageShell
            actions={
                <>
                    <Select
                        aria-label="监控目标集群"
                        value={selectedCluster}
                        onChange={setSelectedCluster}
                        style={{width: 160}}
                        placeholder="选择集群"
                        disabled={!!clusterId}
                        options={clusters.map(c => ({label: c.name, value: c.id}))}
                    />
                    <Select
                        aria-label="监控维度"
                        value={selectedTopic}
                        onChange={setSelectedTopic}
                        style={{width: 220}}
                        loading={topicsLoading}
                        showSearch
                        filterOption={filterByLabel}
                        placeholder="监控维度"
                        options={[
                            {value: '', label: '集群总体'},
                            ...topics.map(t => ({value: topicKey(t), label: `${t.name}（${t.namespace}）`})),
                        ]}
                    />
                    <RangePicker
                        value={dateRange}
                        onChange={dates => setDateRange(dates as [dayjs.Dayjs, dayjs.Dayjs] | null)}
                        showTime
                        format="YYYY-MM-DD HH:mm"
                        style={{width: 250}}
                        placeholder={['开始时间', '结束时间']}
                        disabledDate={current =>
                            current.isBefore(retainedStart, 'day') || current.isAfter(dayjs(), 'day')
                        }
                    />
                    <Select
                        aria-label="自动刷新间隔"
                        value={refreshInterval}
                        onChange={async (value: number) => {
                            const result = await updateSettings({
                                autoRefresh: value > 0,
                                refreshIntervalSeconds: value,
                            });
                            if (!result.ok) {
                                message.error(`刷新间隔保存失败：${result.error}`);
                            }
                        }}
                        style={{width: 100}}
                        options={[
                            {label: '实时 5s', value: 5},
                            {label: '10秒', value: 10},
                            {label: '30秒', value: 30},
                            {label: '1分钟', value: 60},
                            {label: '5分钟', value: 300},
                            {label: '手动', value: 0},
                        ]}
                    />
                    <Button icon={<ReloadOutlined />} onClick={() => void loadAggregatedStats()} loading={loading}>
                        刷新
                    </Button>
                </>
            }
        >
            <ErrorBanner error={error} onClose={() => setError(null)} />

            <StateBlock
                loading={loading && !stats}
                empty={clusters.length === 0}
                emptyText="暂无集群配置，请先在首页添加并连接集群"
            >
                {/* 集群统计卡片 */}
                <Row gutter={[12, 12]}>
                    <Col span={6}>
                        <Card>
                            <Statistic
                                title={selectedTopic ? '分区数' : '总 Topics'}
                                value={selectedTopic ? stats?.totalPartitions || 0 : stats?.totalTopics || 0}
                                suffix={selectedTopic ? '个' : '个'}
                                valueStyle={{color: 'var(--color-primary)'}}
                            />
                            <div className="stat-subline">
                                {selectedTopic
                                    ? `订阅: ${stats?.totalSubscriptions || 0}`
                                    : `分区: ${stats?.totalPartitions || 0}`}
                            </div>
                        </Card>
                    </Col>
                    <Col span={6}>
                        <Card>
                            <Statistic
                                title="消息输入速率"
                                value={stats?.totalMsgRateIn || 0}
                                suffix="msg/s"
                                valueStyle={{color: 'var(--color-success)'}}
                                precision={2}
                            />
                            <Progress
                                percent={Math.min(
                                    ((stats?.totalMsgRateIn || 0) / (peakMsgRate * 1.2 || 100)) * 100,
                                    100,
                                )}
                                showInfo={false}
                                strokeColor="var(--color-success)"
                                size="small"
                            />
                        </Card>
                    </Col>
                    <Col span={6}>
                        <Card>
                            <Statistic
                                title="消息输出速率"
                                value={stats?.totalMsgRateOut || 0}
                                suffix="msg/s"
                                valueStyle={{color: 'var(--color-warning)'}}
                                precision={2}
                            />
                            <Progress
                                percent={Math.min(
                                    ((stats?.totalMsgRateOut || 0) / (peakMsgRate * 1.2 || 100)) * 100,
                                    100,
                                )}
                                showInfo={false}
                                strokeColor="var(--color-warning)"
                                size="small"
                            />
                        </Card>
                    </Col>
                    <Col span={6}>
                        <Card>
                            <Statistic
                                title="积压消息"
                                value={stats?.totalBacklog || 0}
                                valueStyle={{
                                    color:
                                        stats?.totalBacklog && stats.totalBacklog > 5000
                                            ? 'var(--color-danger)'
                                            : 'var(--color-text-secondary)',
                                }}
                            />
                            <div className="stat-subline">吞吐量: {formatThroughput(stats?.totalThroughputIn)}</div>
                        </Card>
                    </Col>
                </Row>

                {/* Broker 与连接计数：三张统计卡说的就是三个数字，收进一行把高度留给趋势图 */}
                <div className="summary-line">
                    <span>
                        {brokersAreOwner ? '归属 Broker' : '活跃 Brokers'} <strong>{brokers.length}</strong>
                    </span>
                    {brokers.map((broker, idx) => (
                        <span key={idx} className="mono">
                            {broker}
                        </span>
                    ))}
                    <span>
                        生产者 <strong>{stats?.totalProducers || 0}</strong>
                    </span>
                    <span>
                        消费者 <strong>{stats?.totalConsumers || 0}</strong>
                    </span>
                </div>

                {/* 消息速率趋势 */}
                <Row gutter={[12, 12]}>
                    <Col span={12}>
                        <ChartCard
                            title={`消息输入速率趋势${scopeSuffix}`}
                            option={msgRateInChartOption}
                            isEmpty={metricsHistory.msgRateIn.length === 0}
                            emptyText="暂无监控数据，请等待数据采集"
                        />
                    </Col>
                    <Col span={12}>
                        <ChartCard
                            title={`消息输出速率趋势${scopeSuffix}`}
                            option={msgRateOutChartOption}
                            isEmpty={metricsHistory.msgRateOut.length === 0}
                            emptyText="暂无监控数据，请等待数据采集"
                        />
                    </Col>
                </Row>

                {/* 吞吐量和资源分布 */}
                <Row gutter={[12, 12]}>
                    <Col span={12}>
                        <ChartCard
                            title={`吞吐量对比${scopeSuffix}`}
                            option={throughputChartOption}
                            isEmpty={metricsHistory.throughputIn.length === 0}
                            emptyText="暂无监控数据，请等待数据采集"
                        />
                    </Col>
                    <Col span={12}>
                        <ChartCard
                            title="资源分布"
                            option={resourceChartOption}
                            isEmpty={!stats}
                            emptyText="暂无监控数据，请等待数据采集"
                        />
                    </Col>
                </Row>
            </StateBlock>
        </PageShell>
    );
};

export default MetricsDashboard;
