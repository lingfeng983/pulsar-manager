import React, {useState, useEffect, useCallback, useRef, useMemo, useContext} from 'react';
import {Card, Row, Col, Select, Button, Statistic, Progress, Tag, DatePicker, message} from 'antd';
import {ReloadOutlined} from '@ant-design/icons';
import type {EChartsOption} from 'echarts';
import dayjs from 'dayjs';
import {useClusterStore} from '../store/cluster';
import {useSettingsStore} from '../store/settings';
import {formatThroughput, toKilobytesPerSecond} from '../utils/format';
import {useTopologyPalette, type TopologyPalette} from '../utils/topologyColors';
import {useCommand, PaneActiveContext} from '../hooks/useKeybindings';
import PageShell from '../components/common/PageShell';
import StateBlock from '../components/common/StateBlock';
import ErrorBanner from '../components/common/ErrorBanner';
import ChartCard from '../components/metrics/ChartCard';

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

// 三套主题共用的 ECharts 基色：文字/坐标轴/分割线/tooltip 全部从 CSS 变量读，
// 否则暗色主题下轴标签是默认深灰，整张图糊成一片。
const seriesAxes = (p: TopologyPalette) => ({
    axisLabel: {color: p.label},
    axisLine: {lineStyle: {color: p.border}},
    splitLine: {lineStyle: {color: p.border}},
});

const seriesTooltip = (p: TopologyPalette) => ({
    backgroundColor: p.surface,
    borderColor: p.border,
    textStyle: {color: p.text},
});

const seriesTitle = (p: TopologyPalette, text: string) => ({
    text,
    left: 'center' as const,
    textStyle: {fontSize: 14, fontWeight: 500 as const, color: p.text},
});

// 时序折线图配置
const createTimeSeriesOption = (
    title: string,
    data: MetricsData[],
    color: string,
    palette: TopologyPalette,
    unit: string = '',
): EChartsOption => ({
    title: seriesTitle(palette, title),
    tooltip: {
        trigger: 'axis',
        ...seriesTooltip(palette),
        formatter: (params: any) => {
            const point = params[0];
            return `${dayjs(point.value[0]).format('HH:mm:ss')}<br/>${point.value[1].toFixed(2)} ${unit}`;
        },
    },
    grid: {left: '3%', right: '4%', bottom: '3%', top: '40px', containLabel: true},
    xAxis: {
        type: 'time',
        ...seriesAxes(palette),
        axisLabel: {
            ...seriesAxes(palette).axisLabel,
            formatter: (value: number) => dayjs(value).format('HH:mm:ss'),
        },
    },
    yAxis: {type: 'value', name: unit, nameTextStyle: {color: palette.label}, ...seriesAxes(palette)},
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
});

// 吞吐量柱状图配置
const createThroughputBarOption = (
    data: {time: string; in: number; out: number}[],
    palette: TopologyPalette,
): EChartsOption => ({
    tooltip: {trigger: 'axis', ...seriesTooltip(palette)},
    legend: {data: ['输入', '输出'], top: 0, textStyle: {color: palette.label}},
    grid: {left: '3%', right: '4%', bottom: '3%', top: '40px', containLabel: true},
    xAxis: {type: 'category', data: data.map(d => d.time), ...seriesAxes(palette)},
    yAxis: {type: 'value', name: 'KB/s', nameTextStyle: {color: palette.label}, ...seriesAxes(palette)},
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
): EChartsOption => ({
    title: seriesTitle(palette, title),
    tooltip: {
        trigger: 'item',
        formatter: '{a} <br/>{b}: {c} ({d}%)',
        ...seriesTooltip(palette),
    },
    legend: {
        orient: 'vertical',
        left: 'left',
        textStyle: {color: palette.label},
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
            },
            data,
        },
    ],
});

// clusterId 由工作区页签传入（`metrics-<clusterId>`）；不带则是资源树工具栏的
// 全局监控页签，此时回落到自动选一个已连接集群。
const MetricsDashboard: React.FC<{clusterId?: string}> = ({clusterId}) => {
    const palette = useTopologyPalette();
    const [loading, setLoading] = useState(false);
    const [selectedCluster, setSelectedCluster] = useState<string>(clusterId ?? '');
    const [stats, setStats] = useState<AggregatedStats | null>(null);
    const [brokers, setBrokers] = useState<string[]>([]);
    // 刷新节奏是应用级设置（配置中心可改），页面上的选择器直接读写它：
    // 关掉自动刷新等价于选择"手动"，两处状态不会各说各话。
    const autoRefresh = useSettingsStore(state => state.settings.autoRefresh);
    const refreshIntervalSeconds = useSettingsStore(state => state.settings.refreshIntervalSeconds);
    const updateSettings = useSettingsStore(state => state.update);
    const refreshInterval = autoRefresh ? refreshIntervalSeconds : 0;
    const [dateRange, setDateRange] = useState<[dayjs.Dayjs, dayjs.Dayjs] | null>(null);
    const [metricsHistory, setMetricsHistory] = useState<MultiMetricsHistory>(EMPTY_HISTORY);
    const [error, setError] = useState<string | null>(null);
    const [peakMsgRate, setPeakMsgRate] = useState(0);
    const intervalRef = useRef<NodeJS.Timeout | null>(null);
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

    // 加载聚合统计
    const loadAggregatedStats = useCallback(async () => {
        if (!selectedCluster) return;

        const requestId = ++loadRequestRef.current;
        const isStale = () => requestId !== loadRequestRef.current;

        setLoading(true);
        setError(null);
        try {
            // 获取聚合统计
            const statsResponse = await window.electronAPI.metrics.getAggregatedStats(selectedCluster);
            if (isStale()) {
                return;
            }
            if (statsResponse.success && statsResponse.data) {
                setStats(statsResponse.data);

                // 添加到历史记录（多维度数据）
                const now = Date.now();
                setMetricsHistory(prev => {
                    const maxPoints = 60;
                    return {
                        msgRateIn: [
                            ...prev.msgRateIn,
                            {timestamp: now, value: statsResponse.data!.totalMsgRateIn},
                        ].slice(-maxPoints),
                        msgRateOut: [
                            ...prev.msgRateOut,
                            {timestamp: now, value: statsResponse.data!.totalMsgRateOut},
                        ].slice(-maxPoints),
                        throughputIn: [
                            ...prev.throughputIn,
                            {timestamp: now, value: statsResponse.data!.totalThroughputIn},
                        ].slice(-maxPoints),
                        throughputOut: [
                            ...prev.throughputOut,
                            {timestamp: now, value: statsResponse.data!.totalThroughputOut},
                        ].slice(-maxPoints),
                        backlog: [...prev.backlog, {timestamp: now, value: statsResponse.data!.totalBacklog}].slice(
                            -maxPoints,
                        ),
                    };
                });
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
    }, [selectedCluster]);

    // 切换集群：作废在途请求并清空上一个集群的统计、历史与峰值
    useEffect(() => {
        loadRequestRef.current += 1;
        setStats(null);
        setBrokers([]);
        setMetricsHistory(EMPTY_HISTORY);
        setPeakMsgRate(0);
        setError(null);
        setLoading(false);
    }, [selectedCluster]);

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
    const msgRateInChartOption = useMemo(() => {
        const filteredData = filterMetricsByDateRange(metricsHistory.msgRateIn, dateRange);
        return createTimeSeriesOption('', filteredData, palette.primary, palette, 'msg/s');
    }, [metricsHistory.msgRateIn, dateRange, filterMetricsByDateRange, palette]);

    const msgRateOutChartOption = useMemo(() => {
        const filteredData = filterMetricsByDateRange(metricsHistory.msgRateOut, dateRange);
        return createTimeSeriesOption('', filteredData, palette.success, palette, 'msg/s');
    }, [metricsHistory.msgRateOut, dateRange, filterMetricsByDateRange, palette]);

    // 生成吞吐量柱状图数据（使用真实历史数据 + 日期过滤）
    const throughputData = useMemo(() => {
        const filteredIn = filterMetricsByDateRange(metricsHistory.throughputIn, dateRange);
        const filteredOut = filterMetricsByDateRange(metricsHistory.throughputOut, dateRange);

        if (filteredIn.length === 0) return [];

        // 按时间戳配对，而不是按下标：两条序列各由过滤得到，一旦点位不齐
        // 下标对齐就会把某个时刻的入向配到另一时刻的出向，柱子高矮全错。
        const outByTimestamp = new Map(filteredOut.map(d => [d.timestamp, d.value]));

        return filteredIn.map(d => ({
            time: dayjs(d.timestamp).format('HH:mm'),
            // 源数据单位是字节/秒，图表轴标注的是 KB/s，这里必须换算
            in: toKilobytesPerSecond(d.value),
            out: toKilobytesPerSecond(outByTimestamp.get(d.timestamp) ?? 0),
        }));
    }, [metricsHistory.throughputIn, metricsHistory.throughputOut, dateRange, filterMetricsByDateRange]);

    // 吞吐量柱状图配置
    const throughputChartOption = useMemo(
        () => createThroughputBarOption(throughputData, palette),
        [throughputData, palette],
    );

    // 资源分布数据
    const resourceData = useMemo(() => {
        if (!stats) return [];
        return [
            {name: 'Topics', value: stats.totalTopics},
            {name: 'Subscriptions', value: stats.totalSubscriptions},
            {name: 'Producers', value: stats.totalProducers},
            {name: 'Consumers', value: stats.totalConsumers},
        ];
    }, [stats]);

    // 资源分布饼图配置
    const resourceChartOption = useMemo(
        () => createPieOption(resourceData, '集群资源', palette),
        [resourceData, palette],
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
            title="监控仪表盘"
            actions={
                <>
                    <Select
                        aria-label="监控目标集群"
                        value={selectedCluster}
                        onChange={setSelectedCluster}
                        style={{width: 200}}
                        placeholder="选择集群"
                        disabled={!!clusterId}
                        options={clusters.map(c => ({label: c.name, value: c.id}))}
                    />
                    <RangePicker
                        value={dateRange}
                        onChange={dates => setDateRange(dates as [dayjs.Dayjs, dayjs.Dayjs] | null)}
                        showTime
                        format="YYYY-MM-DD HH:mm"
                        style={{width: 280}}
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
                        style={{width: 120}}
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
                <Row gutter={[16, 16]}>
                    <Col span={6}>
                        <Card>
                            <Statistic
                                title="总 Topics"
                                value={stats?.totalTopics || 0}
                                suffix="个"
                                valueStyle={{color: 'var(--color-primary)'}}
                            />
                            <div className="stat-subline">分区: {stats?.totalPartitions || 0}</div>
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

                {/* Broker 和连接统计 */}
                <Row gutter={[16, 16]}>
                    <Col span={8}>
                        <Card>
                            <Statistic
                                title="活跃 Brokers"
                                value={brokers.length}
                                suffix="个"
                                valueStyle={{color: 'var(--color-primary)'}}
                            />
                            <div style={{marginTop: 'var(--spacing-sm)'}}>
                                {brokers.map((broker, idx) => (
                                    <Tag key={idx} color="blue">
                                        {broker}
                                    </Tag>
                                ))}
                            </div>
                        </Card>
                    </Col>
                    <Col span={8}>
                        <Card>
                            <Statistic
                                title="生产者"
                                value={stats?.totalProducers || 0}
                                suffix="个"
                                valueStyle={{color: 'var(--color-success)'}}
                            />
                        </Card>
                    </Col>
                    <Col span={8}>
                        <Card>
                            <Statistic
                                title="消费者"
                                value={stats?.totalConsumers || 0}
                                suffix="个"
                                valueStyle={{color: 'var(--color-warning)'}}
                            />
                        </Card>
                    </Col>
                </Row>

                {/* 消息速率趋势 */}
                <Row gutter={[16, 16]}>
                    <Col span={12}>
                        <ChartCard
                            title="消息输入速率趋势"
                            option={msgRateInChartOption}
                            isEmpty={metricsHistory.msgRateIn.length === 0}
                            emptyText="暂无监控数据，请等待数据采集"
                        />
                    </Col>
                    <Col span={12}>
                        <ChartCard
                            title="消息输出速率趋势"
                            option={msgRateOutChartOption}
                            isEmpty={metricsHistory.msgRateOut.length === 0}
                            emptyText="暂无监控数据，请等待数据采集"
                        />
                    </Col>
                </Row>

                {/* 吞吐量和资源分布 */}
                <Row gutter={[16, 16]}>
                    <Col span={12}>
                        <ChartCard
                            title="吞吐量对比"
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
