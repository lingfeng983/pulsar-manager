import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Alert, Button, InputNumber, Progress, Space, Table, Tag, Typography, message} from 'antd';
import {DownloadOutlined, ReloadOutlined, SafetyCertificateOutlined} from '@ant-design/icons';
import PageShell from '../components/common/PageShell';
import StateBlock from '../components/common/StateBlock';
import {downloadBlob} from '../utils/download';
import {useTabStore} from '../store/tabs';
import {inspectionTab} from '../utils/tabIds';
import {
    FLEET_FRESHNESS_LABEL,
    FLEET_RUN_MAX_CLUSTERS,
    FLEET_SECTION_LABEL,
    fleetSamplingNote,
    fleetSectionOf,
    renderFleetMarkdown,
} from '../../shared/inspection-summary';
import {formatIntervalMinutes} from '../../shared/inspection-schedule';
import type {
    InspectionFleetCluster,
    InspectionFleetGroup,
    InspectionFleetProgress,
    InspectionFleetSummary,
    InspectionFleetTotals,
} from '../types';

interface Props {
    /** 汇总与集群无关，这个 prop 只是页签体系留下的口子，页面不用它 */
    clusterId?: string;
}

/** 点开一行才看细节：一屏几十台集群时把每条结论都摊开，需要处理的那几行反而找不到。 */
function detailOf(cluster: InspectionFleetCluster): string[] {
    if (!cluster.latest) {
        return ['这台集群还没有任何报告：汇总对它唯一知道的事就是「没人看过」。'];
    }
    const lines = cluster.checks.map(
        check =>
            `${check.level.toUpperCase()}｜${check.title}｜${check.summary}` +
            (check.suggestion ? `（${check.suggestion}）` : ''),
    );
    if (cluster.latest.scope.truncated) {
        lines.push(`这份报告只在采到的那 ${cluster.latest.scope.topicsSampled} 个 topic 里判过。`);
    }
    return lines;
}

function freshnessColor(freshness: InspectionFleetCluster['freshness']): string {
    if (freshness === 'stale') {
        return 'volcano';
    }
    if (freshness === 'aging') {
        return 'gold';
    }
    if (freshness === 'never') {
        return 'default';
    }
    return 'green';
}

function sectionColor(cluster: InspectionFleetCluster): string {
    switch (fleetSectionOf(cluster)) {
        case 'crit':
            return 'error';
        case 'warn':
            return 'warning';
        case 'never':
            return 'default';
        default:
            return 'success';
    }
}

function summaryFileName(totals: InspectionFleetTotals): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `pulsar巡检汇总-${totals.clusters}台-${stamp}.md`;
}

const FleetInspection: React.FC<Props> = () => {
    const addTab = useTabStore(state => state.addTab);

    const [summary, setSummary] = useState<InspectionFleetSummary | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [running, setRunning] = useState(false);
    const [limit, setLimit] = useState(FLEET_RUN_MAX_CLUSTERS);
    const [progress, setProgress] = useState<InspectionFleetProgress[]>([]);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const response = await window.electronAPI.inspection.summary.get();
            if (response.success && response.data) {
                setSummary(response.data);
            } else {
                // 读不到就把屏幕清空而不是留着上一屏：这一页说的每一行都必须是「此刻库里的样子」
                setSummary(null);
                setError(response.error || '汇总读取失败');
            }
        } catch (cause) {
            setSummary(null);
            setError(cause instanceof Error ? cause.message : '汇总读取失败');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    // 逐台跑的时候每完成一台推一条；界面靠它把「跑到第几台」显示出来，
    // 而不是让一屏集群挂着同一个加载中让人猜
    useEffect(() => {
        return window.electronAPI.inspection.onFleetProgress(next => {
            setProgress(prev => [...prev, next]);
            if (next.status === 'failed') {
                message.error(next.message);
            }
        });
    }, []);

    const handleRun = useCallback(async () => {
        setRunning(true);
        setError(null);
        setProgress([]);
        try {
            const response = await window.electronAPI.inspection.summary.run({limit});
            if (response.success && response.data) {
                setSummary(response.data.summary);
                const {ran, failed} = response.data;
                if (failed) {
                    message.warning(`跑完 ${ran} 台，${failed} 台没跑成（下面列了原因）`);
                } else {
                    message.success(`已巡检 ${ran} 台集群`);
                }
            } else {
                setError(response.error || '逐台巡检失败');
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : '逐台巡检失败');
        } finally {
            setRunning(false);
        }
    }, [limit]);

    const handleExport = useCallback(() => {
        if (!summary) {
            return;
        }
        downloadBlob(renderFleetMarkdown(summary), summaryFileName(summary.totals), 'text/markdown;charset=utf-8');
    }, [summary]);

    const totals = summary?.totals;
    const lastProgress = progress.length ? progress[progress.length - 1] : null;
    const progressTotal = lastProgress?.total ?? 0;
    // 已经出结果的那几台（跑完或跑坏都算）：进度条要说的是「还剩几台」，不是「第几台正在跑」
    const progressDone = progress.filter(item => item.status !== 'started').length;
    const progressPercent = progressTotal ? Math.round((progressDone / progressTotal) * 100) : running ? 0 : 100;

    const columns = useMemo(
        () => [
            {
                title: '集群',
                dataIndex: 'clusterName',
                width: 180,
                render: (_: unknown, cluster: InspectionFleetCluster) => (
                    <Space direction="vertical" size={0}>
                        <Typography.Text strong>{cluster.clusterName}</Typography.Text>
                        <Tag color={sectionColor(cluster)}>{FLEET_SECTION_LABEL[fleetSectionOf(cluster)]}</Tag>
                    </Space>
                ),
            },
            {
                title: '最近一次',
                dataIndex: ['latest', 'generatedAt'],
                width: 170,
                render: (_: unknown, cluster: InspectionFleetCluster) =>
                    cluster.latest ? (
                        <Space direction="vertical" size={0}>
                            <Typography.Text>
                                {cluster.latest.generatedAt.slice(0, 19).replace('T', ' ')}
                            </Typography.Text>
                            <Typography.Text type="secondary">
                                {cluster.latest.source === 'scheduled' ? '自动' : '手动'}
                            </Typography.Text>
                        </Space>
                    ) : (
                        <Typography.Text type="secondary">没有报告</Typography.Text>
                    ),
            },
            {
                title: '严重',
                dataIndex: ['latest', 'totals', 'crit'],
                width: 70,
                render: (_: unknown, cluster: InspectionFleetCluster) => countCell(cluster, 'crit'),
            },
            {
                title: '关注',
                dataIndex: ['latest', 'totals', 'warn'],
                width: 70,
                render: (_: unknown, cluster: InspectionFleetCluster) => countCell(cluster, 'warn'),
            },
            {
                title: '未覆盖',
                dataIndex: ['latest', 'totals', 'skip'],
                width: 80,
                render: (_: unknown, cluster: InspectionFleetCluster) => countCell(cluster, 'skip'),
            },
            {
                title: '新鲜度',
                dataIndex: 'freshness',
                width: 100,
                render: (freshness: InspectionFleetCluster['freshness']) => (
                    <Tag color={freshnessColor(freshness)}>{FLEET_FRESHNESS_LABEL[freshness]}</Tag>
                ),
            },
            {
                title: '采样',
                dataIndex: ['latest', 'scope'],
                width: 190,
                render: (_: unknown, cluster: InspectionFleetCluster) =>
                    cluster.latest ? (
                        <Typography.Text type={cluster.latest.scope.truncated ? 'warning' : 'secondary'}>
                            {fleetSamplingNote(cluster.latest.scope)}
                        </Typography.Text>
                    ) : (
                        <Typography.Text type="secondary">—</Typography.Text>
                    ),
            },
            {
                title: '定时',
                dataIndex: 'schedule',
                width: 120,
                render: (schedule: InspectionFleetCluster['schedule']) =>
                    schedule?.enabled ? (
                        <Typography.Text>每 {formatIntervalMinutes(schedule.intervalMinutes)}</Typography.Text>
                    ) : (
                        <Typography.Text type="secondary">没开</Typography.Text>
                    ),
            },
            {
                title: '',
                dataIndex: 'actions',
                width: 90,
                render: (_: unknown, cluster: InspectionFleetCluster) => (
                    <Button
                        size="small"
                        type="link"
                        onClick={() => addTab(inspectionTab(cluster.clusterId, cluster.clusterName))}
                    >
                        看单台
                    </Button>
                ),
            },
        ],
        [addTab],
    );

    return (
        <PageShell
            actions={
                <Space>
                    <InputNumber
                        min={1}
                        max={FLEET_RUN_MAX_CLUSTERS}
                        step={1}
                        value={limit}
                        onChange={value => setLimit(value ?? FLEET_RUN_MAX_CLUSTERS)}
                        style={{width: 120}}
                        addonAfter="台"
                    />
                    <Button icon={<ReloadOutlined />} onClick={() => void load()} disabled={running}>
                        刷新
                    </Button>
                    <Button icon={<DownloadOutlined />} disabled={!summary} onClick={handleExport}>
                        导出 Markdown
                    </Button>
                    <Button
                        type="primary"
                        icon={<SafetyCertificateOutlined />}
                        loading={running}
                        onClick={() => void handleRun()}
                    >
                        逐台巡检
                    </Button>
                </Space>
            }
        >
            <StateBlock
                loading={loading}
                error={error}
                empty={!summary && !loading}
                emptyText="还没有可读的汇总"
                height={240}
            >
                <Space direction="vertical" size={12} style={{width: '100%'}}>
                    <Alert
                        type="info"
                        showIcon
                        message="每一行是那台集群自己最近的一份报告，不是同一时刻的快照"
                        description={
                            totals
                                ? `${totals.clusters} 台里有报告 ${totals.inspected} 台、从没巡检过 ${totals.never} 台；` +
                                  `合计严重 ${totals.crit} 项、关注 ${totals.warn} 项；报告已偏旧或过期 ${totals.stale} 台；` +
                                  `开着定时的 ${totals.scheduled} 台。`
                                : undefined
                        }
                    />
                    {running || progress.length ? (
                        <Space direction="vertical" size={4} style={{width: '100%'}}>
                            <Progress percent={progressPercent} status={running ? 'active' : 'normal'} />
                            <Typography.Text type="secondary">
                                {lastProgress ? lastProgress.message : '本轮已经跑完，正在按新的库重算汇总'}
                            </Typography.Text>
                        </Space>
                    ) : null}
                    {summary?.failures.length ? (
                        <Alert
                            type="error"
                            showIcon
                            message={`${summary.failures.length} 台这一轮没跑成`}
                            description={
                                // 旧报告仍然留在行里：把失败的那台从表里抹掉，会让人以为这台集群不存在
                                <ul style={{margin: 0, paddingLeft: 18}}>
                                    {summary.failures.map(failure => (
                                        <li key={failure.clusterId}>
                                            {failure.clusterName}：{failure.message}
                                        </li>
                                    ))}
                                </ul>
                            }
                        />
                    ) : null}
                    {summary?.skipped.length ? (
                        <Alert
                            type="warning"
                            showIcon
                            message={`本轮只跑了前 ${limit} 台`}
                            description={`没跑的 ${summary.skipped.length} 台：${summary.skipped
                                .map(item => item.clusterName)
                                .join('、')}。一次最多 ${FLEET_RUN_MAX_CLUSTERS} 台，再多分几轮。`}
                        />
                    ) : null}
                    {summary && summary.critGroups.length ? (
                        <Space direction="vertical" size={6} style={{width: '100%'}}>
                            <Typography.Text strong>跨集群的严重项</Typography.Text>
                            <Table<InspectionFleetGroup>
                                rowKey="key"
                                size="small"
                                pagination={false}
                                dataSource={summary.critGroups}
                                columns={[
                                    {
                                        title: '检查项',
                                        dataIndex: 'title',
                                        width: 180,
                                        render: (title: string, group) => `${title}（${group.items.length} 台）`,
                                    },
                                    {
                                        title: '哪些集群、什么结论',
                                        dataIndex: 'items',
                                        render: (_: unknown, group) => (
                                            <ul style={{margin: 0, paddingLeft: 18}}>
                                                {group.items.map(item => (
                                                    <li key={`${group.key}-${item.clusterId}`}>
                                                        <Typography.Text strong>{item.clusterName}</Typography.Text>：
                                                        {item.summary}
                                                        {item.suggestion ? (
                                                            <Typography.Text type="secondary">
                                                                （{item.suggestion}）
                                                            </Typography.Text>
                                                        ) : null}
                                                    </li>
                                                ))}
                                            </ul>
                                        ),
                                    },
                                ]}
                            />
                        </Space>
                    ) : null}
                    {summary && !summary.critGroups.length ? (
                        <Typography.Text type="secondary">
                            这些最近一份报告里没有严重项。「没有」只对这些报告成立，不等于此刻没问题。
                        </Typography.Text>
                    ) : null}
                    <Table<InspectionFleetCluster>
                        rowKey="clusterId"
                        size="small"
                        columns={columns}
                        dataSource={summary?.clusters ?? []}
                        pagination={false}
                        scroll={{x: 1100}}
                        expandable={{
                            expandedRowRender: record =>
                                detailOf(record).length ? (
                                    <ul style={{margin: 0, paddingLeft: 20}}>
                                        {detailOf(record).map((line, index) => (
                                            <li key={index}>{line}</li>
                                        ))}
                                    </ul>
                                ) : (
                                    <Typography.Text type="secondary">这一项没有逐条证据</Typography.Text>
                                ),
                            rowExpandable: record => detailOf(record).length > 0,
                        }}
                    />
                    <Typography.Text type="secondary">
                        排序是「有严重项 → 需要关注 → 还没巡检过 → 没看出问题」，同级里越久没人看的越靠前。
                        每台集群的判定线可能各调过，跨集群直接比数值大小没有意义。
                    </Typography.Text>
                </Space>
            </StateBlock>
        </PageShell>
    );
};

const COUNT_TONE: Record<'crit' | 'warn' | 'skip', 'danger' | 'warning' | 'secondary'> = {
    crit: 'danger',
    warn: 'warning',
    skip: 'secondary',
};

function countCell(cluster: InspectionFleetCluster, field: 'crit' | 'warn' | 'skip'): React.ReactNode {
    if (!cluster.latest) {
        return <Typography.Text type="secondary">—</Typography.Text>;
    }
    const value = cluster.latest.totals[field];
    if (!value) {
        return <Typography.Text type="secondary">0</Typography.Text>;
    }
    return (
        <Typography.Text type={COUNT_TONE[field]} strong={field === 'crit'}>
            {value}
        </Typography.Text>
    );
}

export default FleetInspection;
