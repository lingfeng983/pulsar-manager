import React, {useState, useEffect, useCallback, useRef, useMemo} from 'react';
import {
    Card,
    Row,
    Col,
    Select,
    Button,
    Space,
    Spin,
    Alert,
    Statistic,
    Progress,
    Tag,
    DatePicker,
    Empty,
    Typography,
} from 'antd';
import {ReloadOutlined, FullscreenOutlined} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import type {EChartsOption} from 'echarts';
import dayjs from 'dayjs';
import {useClusterStore} from '../store/cluster';
import {formatThroughput, toKilobytesPerSecond} from '../utils/format';
import {useFullscreen} from '../hooks/useFullscreen';
import {useCommand} from '../hooks/useKeybindings';

const {RangePicker} = DatePicker;
const {Text} = Typography;

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

// 时序折线图配置
const createTimeSeriesOption = (
    title: string,
    data: MetricsData[],
    color: string,
    unit: string = '',
): EChartsOption => ({
    title: {
        text: title,
        left: 'center',
        textStyle: {fontSize: 14, fontWeight: 500},
    },
    tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
            const point = params[0];
            return `${dayjs(point.value[0]).format('HH:mm:ss')}<br/>${point.value[1].toFixed(2)} ${unit}`;
        },
    },
    grid: {left: '3%', right: '4%', bottom: '3%', top: '40px', containLabel: true},
    xAxis: {
        type: 'time',
        axisLabel: {formatter: (value: number) => dayjs(value).format('HH:mm:ss')},
    },
    yAxis: {type: 'value', name: unit},
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
const createThroughputBarOption = (data: {time: string; in: number; out: number}[]): EChartsOption => ({
    tooltip: {trigger: 'axis'},
    legend: {data: ['输入', '输出'], top: 0},
    grid: {left: '3%', right: '4%', bottom: '3%', top: '40px', containLabel: true},
    xAxis: {type: 'category', data: data.map(d => d.time)},
    yAxis: {type: 'value', name: 'KB/s'},
    series: [
        {
            name: '输入',
            type: 'bar',
            data: data.map(d => d.in),
            itemStyle: {color: '#1677FF'},
        },
        {
            name: '输出',
            type: 'bar',
            data: data.map(d => d.out),
            itemStyle: {color: '#00B42A'},
        },
    ],
});

// 资源分布饼图配置
const createPieOption = (data: {name: string; value: number}[], title: string): EChartsOption => ({
    title: {
        text: title,
        left: 'center',
        textStyle: {fontSize: 14, fontWeight: 500},
    },
    tooltip: {
        trigger: 'item',
        formatter: '{a} <br/>{b}: {c} ({d}%)',
    },
    legend: {
        orient: 'vertical',
        left: 'left',
    },
    series: [
        {
            name: title,
            type: 'pie',
            radius: ['40%', '70%'],
            avoidLabelOverlap: false,
            itemStyle: {
                borderRadius: 10,
                borderColor: '#fff',
                borderWidth: 2,
            },
            label: {
                show: true,
                formatter: '{b}: {c}',
            },
            data,
        },
    ],
});

const MetricsDashboard: React.FC = () => {
    const [loading, setLoading] = useState(false);
    const [selectedCluster, setSelectedCluster] = useState<string>('');
    const [stats, setStats] = useState<AggregatedStats | null>(null);
    const [brokers, setBrokers] = useState<string[]>([]);
    const [refreshInterval, setRefreshInterval] = useState<number>(30);
    const [dateRange, setDateRange] = useState<[dayjs.Dayjs, dayjs.Dayjs] | null>(null);
    const [metricsHistory, setMetricsHistory] = useState<MultiMetricsHistory>({
        msgRateIn: [],
        msgRateOut: [],
        throughputIn: [],
        throughputOut: [],
        backlog: [],
    });
    const [error, setError] = useState<string | null>(null);
    const [peakMsgRate, setPeakMsgRate] = useState(0);
    const chartRef = useRef<ReactECharts>(null);
    const intervalRef = useRef<NodeJS.Timeout | null>(null);
    const lastFetchRef = useRef<number>(0);

    const {ref: chartContainerRef, toggle: toggleFullscreen} = useFullscreen<HTMLDivElement>();

    const {clusters, fetchClusters} = useClusterStore();

    // 初始化
    useEffect(() => {
        fetchClusters();
    }, [fetchClusters]);

    // 设置默认集群（优先选择已连接的集群）
    useEffect(() => {
        if (clusters.length > 0 && !selectedCluster) {
            // 优先选择已连接的集群
            const connectedCluster = clusters.find(c => c.status === 'connected');
            setSelectedCluster(connectedCluster?.id || clusters[0].id);
        }
    }, [clusters, selectedCluster]);

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
                return timestamp.isAfter(start) && timestamp.isBefore(end);
            });
        },
        [],
    );

    // 加载聚合统计
    const loadAggregatedStats = useCallback(
        async (force: boolean = false) => {
            if (!selectedCluster) return;

            // 防抖：距离上次请求小于 2 秒则忽略（除非强制刷新）
            const now = Date.now();
            if (!force && now - lastFetchRef.current < 2000) {
                return;
            }
            lastFetchRef.current = now;

            setLoading(true);
            setError(null);
            try {
                // 获取聚合统计
                const statsResponse = await window.electronAPI.metrics.getAggregatedStats(selectedCluster);
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
                if (brokersResponse.success && brokersResponse.data) {
                    setBrokers(brokersResponse.data.activeBrokers || []);
                } else if (!brokersResponse.success) {
                    console.warn('获取 Broker 信息失败:', brokersResponse.error);
                }
            } catch (error) {
                console.error('Failed to load aggregated stats:', error);
                setError('网络错误，请检查连接');
            } finally {
                setLoading(false);
            }
        },
        [selectedCluster],
    );

    useCommand('refreshMetrics', () => {
        void loadAggregatedStats(true);
    });

    // 初始加载和定时刷新
    useEffect(() => {
        // 检查是否有已连接的集群
        const hasConnectedCluster = clusters.some(c => c.status === 'connected');

        // 只有有已连接集群时才加载和刷新
        if (selectedCluster && hasConnectedCluster) {
            loadAggregatedStats(true);
        }

        // 设置定时刷新（只有有已连接集群时才设置）
        if (refreshInterval > 0 && hasConnectedCluster) {
            intervalRef.current = setInterval(() => loadAggregatedStats(true), refreshInterval * 1000);
        }

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
            }
        };
    }, [selectedCluster, loadAggregatedStats, refreshInterval, clusters]);

    // 使用 useMemo 缓存图表配置
    const msgRateInChartOption = useMemo(() => {
        const filteredData = filterMetricsByDateRange(metricsHistory.msgRateIn, dateRange);
        return createTimeSeriesOption('', filteredData, '#1677FF', 'msg/s');
    }, [metricsHistory.msgRateIn, dateRange, filterMetricsByDateRange]);

    const msgRateOutChartOption = useMemo(() => {
        const filteredData = filterMetricsByDateRange(metricsHistory.msgRateOut, dateRange);
        return createTimeSeriesOption('', filteredData, '#00B42A', 'msg/s');
    }, [metricsHistory.msgRateOut, dateRange, filterMetricsByDateRange]);

    // 生成吞吐量柱状图数据（使用真实历史数据 + 日期过滤）
    const throughputData = useMemo(() => {
        const filteredIn = filterMetricsByDateRange(metricsHistory.throughputIn, dateRange);
        const filteredOut = filterMetricsByDateRange(metricsHistory.throughputOut, dateRange);

        if (filteredIn.length === 0) return [];

        return filteredIn.map((d, i) => ({
            time: dayjs(d.timestamp).format('HH:mm'),
            // 源数据单位是字节/秒，图表轴标注的是 KB/s，这里必须换算
            in: toKilobytesPerSecond(d.value),
            out: toKilobytesPerSecond(filteredOut[i]?.value || 0),
        }));
    }, [metricsHistory.throughputIn, metricsHistory.throughputOut, dateRange, filterMetricsByDateRange]);

    // 吞吐量柱状图配置
    const throughputChartOption = useMemo(() => createThroughputBarOption(throughputData), [throughputData]);

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
    const resourceChartOption = useMemo(() => createPieOption(resourceData, '集群资源'), [resourceData]);

    return (
        <div ref={chartContainerRef} style={{padding: 'var(--spacing-lg)', height: '100%', overflow: 'auto'}}>
            {/* 页面标题和工具栏 */}
            <div
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 'var(--spacing-lg)',
                    flexWrap: 'wrap',
                    gap: 'var(--spacing-sm)',
                }}
            >
                <h2 style={{fontSize: 20, fontWeight: 600}}>监控仪表盘</h2>
                <Space wrap size="small">
                    <Select
                        value={selectedCluster}
                        onChange={setSelectedCluster}
                        style={{width: 200}}
                        placeholder="选择集群"
                        options={clusters.map(c => ({label: c.name, value: c.id}))}
                    />
                    <RangePicker
                        value={dateRange}
                        onChange={dates => setDateRange(dates as [dayjs.Dayjs, dayjs.Dayjs] | null)}
                        showTime
                        format="YYYY-MM-DD HH:mm"
                        style={{width: 280}}
                        placeholder={['开始时间', '结束时间']}
                    />
                    <Select
                        value={refreshInterval}
                        onChange={setRefreshInterval}
                        style={{width: 120}}
                        options={[
                            {label: '实时 5s', value: 5},
                            {label: '10秒', value: 10},
                            {label: '30秒', value: 30},
                            {label: '1分钟', value: 60},
                            {label: '手动', value: 0},
                        ]}
                    />
                    <Button icon={<ReloadOutlined />} onClick={() => loadAggregatedStats(true)} loading={loading}>
                        刷新
                    </Button>
                </Space>
            </div>

            {clusters.length === 0 && (
                <Alert
                    message="暂无集群"
                    description="请先添加集群配置"
                    type="warning"
                    showIcon
                    style={{marginBottom: 16}}
                />
            )}

            {error && (
                <Alert
                    message="加载失败"
                    description={error}
                    type="error"
                    showIcon
                    closable
                    onClose={() => setError(null)}
                    style={{marginBottom: 16}}
                />
            )}

            <Spin spinning={loading && !stats}>
                <Spin spinning={loading && !!stats} size="small">
                    {/* 集群统计卡片 */}
                    <Row gutter={16} style={{marginBottom: 'var(--spacing-lg)'}}>
                        <Col span={6}>
                            <Card>
                                <Statistic
                                    title="总 Topics"
                                    value={stats?.totalTopics || 0}
                                    suffix="个"
                                    valueStyle={{color: 'var(--color-primary)'}}
                                />
                                <div style={{marginTop: 8}}>
                                    <Text type="secondary">分区: {stats?.totalPartitions || 0}</Text>
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
                                <div style={{marginTop: 8}}>
                                    <Text type="secondary">吞吐量: {formatThroughput(stats?.totalThroughputIn)}</Text>
                                </div>
                            </Card>
                        </Col>
                    </Row>

                    {/* Broker 和连接统计 */}
                    <Row gutter={16} style={{marginBottom: 'var(--spacing-lg)'}}>
                        <Col span={8}>
                            <Card>
                                <Statistic
                                    title="活跃 Brokers"
                                    value={brokers.length}
                                    suffix="个"
                                    valueStyle={{color: 'var(--color-primary)'}}
                                />
                                <div style={{marginTop: 8}}>
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
                    <Row gutter={16} style={{marginBottom: 'var(--spacing-lg)'}}>
                        <Col span={12}>
                            <Card
                                title="消息输入速率趋势"
                                extra={<Button type="text" icon={<FullscreenOutlined />} onClick={toggleFullscreen} />}
                            >
                                {metricsHistory.msgRateIn.length === 0 ? (
                                    <Empty
                                        description="暂无监控数据，请等待数据采集"
                                        style={{
                                            height: 300,
                                            display: 'flex',
                                            flexDirection: 'column',
                                            justifyContent: 'center',
                                        }}
                                    />
                                ) : (
                                    <ReactECharts ref={chartRef} option={msgRateInChartOption} style={{height: 300}} />
                                )}
                            </Card>
                        </Col>
                        <Col span={12}>
                            <Card
                                title="消息输出速率趋势"
                                extra={<Button type="text" icon={<FullscreenOutlined />} onClick={toggleFullscreen} />}
                            >
                                {metricsHistory.msgRateOut.length === 0 ? (
                                    <Empty
                                        description="暂无监控数据，请等待数据采集"
                                        style={{
                                            height: 300,
                                            display: 'flex',
                                            flexDirection: 'column',
                                            justifyContent: 'center',
                                        }}
                                    />
                                ) : (
                                    <ReactECharts option={msgRateOutChartOption} style={{height: 300}} />
                                )}
                            </Card>
                        </Col>
                    </Row>

                    {/* 吞吐量和资源分布 */}
                    <Row gutter={16}>
                        <Col span={12}>
                            <Card title="吞吐量对比">
                                {metricsHistory.throughputIn.length === 0 ? (
                                    <Empty
                                        description="暂无监控数据，请等待数据采集"
                                        style={{
                                            height: 300,
                                            display: 'flex',
                                            flexDirection: 'column',
                                            justifyContent: 'center',
                                        }}
                                    />
                                ) : (
                                    <ReactECharts option={throughputChartOption} style={{height: 300}} />
                                )}
                            </Card>
                        </Col>
                        <Col span={12}>
                            <Card title="资源分布">
                                {!stats ? (
                                    <Empty
                                        description="暂无监控数据，请等待数据采集"
                                        style={{
                                            height: 300,
                                            display: 'flex',
                                            flexDirection: 'column',
                                            justifyContent: 'center',
                                        }}
                                    />
                                ) : (
                                    <ReactECharts option={resourceChartOption} style={{height: 300}} />
                                )}
                            </Card>
                        </Col>
                    </Row>
                </Spin>
            </Spin>
        </div>
    );
};

export default MetricsDashboard;
