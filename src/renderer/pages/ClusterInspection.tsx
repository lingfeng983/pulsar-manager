import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Alert, Button, InputNumber, Select, Space, Table, Tag, Typography} from 'antd';
import type {ColumnsType} from 'antd/es/table';
import {DeleteOutlined, DownloadOutlined, SafetyCertificateOutlined} from '@ant-design/icons';
import PageShell from '../components/common/PageShell';
import StateBlock from '../components/common/StateBlock';
import {downloadBlob} from '../utils/download';
import {useClusterStore} from '../store/cluster';
import {themedModal} from '../components/common/dangerConfirm';
import type {
    InspectionChangeKind,
    InspectionCheck,
    InspectionDiff,
    InspectionDiffItem,
    InspectionHistoryRow,
    InspectionLevel,
    InspectionReport,
    InspectionScope,
} from '../types';

interface Props {
    clusterId?: string;
}

const LEVEL_META: Record<InspectionLevel, {color: string; text: string}> = {
    crit: {color: 'red', text: '严重'},
    warn: {color: 'orange', text: '关注'},
    ok: {color: 'green', text: '正常'},
    // 「未覆盖」而不是「跳过」：老 broker 没有这个端点时，用户要知道的是这里没看成，
    // 而不是系统略过了一个无关项
    skip: {color: 'default', text: '未覆盖'},
};

// 排序按级别而不是表内顺序：一屏看不完的时候，需要人处理的那几条必须在最上面。
const LEVEL_ORDER: Record<InspectionLevel, number> = {crit: 0, warn: 1, skip: 2, ok: 3};

const KIND_META: Record<InspectionChangeKind, {color: string; text: string}> = {
    worsened: {color: 'red', text: '恶化'},
    new: {color: 'volcano', text: '新增'},
    resolved: {color: 'gold', text: '本次未出现'},
    improved: {color: 'green', text: '好转'},
    unchanged: {color: 'default', text: '不变'},
};

// 「本次未出现」不等于「已恢复」：这一项这次根本没被读到（端点变化或采样范围不同），
// 说成恢复会让人以为问题自己好了。文案与颜色都刻意区别于好转。
function levelShift(item: InspectionDiffItem): string {
    const from = item.previousLevel ? LEVEL_META[item.previousLevel].text : '—';
    const to = item.level ? LEVEL_META[item.level].text : '未出现';
    return `${from} → ${to}`;
}

function diffHeading(diff: InspectionDiff, changedCount: number): string {
    const previous = diff.previousGeneratedAt.slice(0, 19).replace('T', ' ');
    return `与上次巡检（${previous}）相比移动了 ${changedCount} 项`;
}

function reportFileName(report: InspectionReport): string {
    const stamp = report.generatedAt.slice(0, 19).replace(/[:T]/g, '-');
    const safeName = report.clusterName.replace(/[^\w\u4e00-\u9fa5-]+/g, '_') || 'cluster';
    return `pulsar巡检-${safeName}-${stamp}.md`;
}

function reportVersion(report: InspectionReport): string {
    return report.version ? `broker 版本 ${report.version}` : '版本未取到';
}

// 截断要说清是哪一侧到了上限：只写「结果不完整」的话，用户不知道该调 topic 上限还是命名空间上限。
function truncationNote(scope: InspectionScope): string {
    const parts = [];
    if (scope.namespacesSeen >= scope.maxNamespaces) {
        parts.push(`命名空间 ${scope.maxNamespaces}`);
    }
    if (scope.topicsSampled >= scope.maxTopics) {
        parts.push(`topic ${scope.maxTopics}`);
    }
    return `采样在 ${parts.join(' / ') || '上限'}处截断`;
}

const ClusterInspection: React.FC<Props> = ({clusterId: propClusterId}) => {
    const clusters = useClusterStore(state => state.clusters);
    const loadClusters = useClusterStore(state => state.fetchClusters);

    const [clusterId, setClusterId] = useState(propClusterId || '');
    const [maxTopics, setMaxTopics] = useState(60);
    const [report, setReport] = useState<InspectionReport | null>(null);
    const [markdown, setMarkdown] = useState('');
    const [diff, setDiff] = useState<InspectionDiff | null>(null);
    const [history, setHistory] = useState<InspectionHistoryRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!clusters.length) {
            void loadClusters();
        }
    }, [clusters.length, loadClusters]);

    useEffect(() => {
        if (!clusterId && clusters.length) {
            setClusterId(clusters[0].id);
        }
    }, [clusterId, clusters]);

    // 页签已开着时从资源树点别的集群，props 变了而 state 不会：跟着 props 走一次。
    useEffect(() => {
        if (propClusterId) {
            setClusterId(propClusterId);
        }
    }, [propClusterId]);

    const loadHistory = useCallback(async (targetClusterId: string) => {
        if (!targetClusterId) {
            setHistory([]);
            return;
        }
        const response = await window.electronAPI.inspection.history({clusterId: targetClusterId});
        setHistory(response.success && response.data ? response.data : []);
    }, []);

    // 换集群就把历史重新拉一遍，同时清掉上一台集群的报告与环比：
    // 报告是"某个集群某一时刻"的快照，挂着别的集群的结果比空着更危险。
    useEffect(() => {
        void loadHistory(clusterId);
        setReport(null);
        setMarkdown('');
        setDiff(null);
    }, [clusterId, loadHistory]);

    const clusterOptions = useMemo(() => clusters.map(item => ({value: item.id, label: item.name})), [clusters]);

    const handleRun = useCallback(async () => {
        if (!clusterId) {
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const response = await window.electronAPI.inspection.run({clusterId, maxTopics});
            if (response.success && response.data) {
                setReport(response.data.report);
                setMarkdown(response.data.markdown);
                setDiff(response.data.diff);
                void loadHistory(clusterId);
            } else {
                // 失败时清掉上一份：留着旧报告会让用户把「这次没跑成」看成「这次没问题」
                setReport(null);
                setMarkdown('');
                setDiff(null);
                setError(response.error || '巡检失败');
            }
        } catch (error) {
            setReport(null);
            setMarkdown('');
            setDiff(null);
            setError(error instanceof Error ? error.message : '巡检失败');
        } finally {
            setLoading(false);
        }
    }, [clusterId, maxTopics, loadHistory]);

    const handleExport = useCallback(() => {
        if (!report || !markdown) {
            return;
        }
        downloadBlob(markdown, reportFileName(report), 'text/markdown;charset=utf-8');
    }, [report, markdown]);

    // 从历史里点开某一份：报告、导出文本与那份报告自己的环比一起换掉，
    // 否则「导出的文件」和「屏幕上这份」会是两个时刻的东西。
    const handleOpenHistory = useCallback(async (id: string) => {
        setError(null);
        const response = await window.electronAPI.inspection.detail({id});
        if (response.success && response.data) {
            setReport(response.data.report);
            setMarkdown(response.data.markdown);
            setDiff(response.data.diff);
        } else {
            setError(response.error || '这份历史报告读不出来');
        }
    }, []);

    const handleClearHistory = useCallback(() => {
        const modal = themedModal();
        if (!modal || !clusterId) {
            return;
        }
        modal.confirm({
            title: '清空该集群的巡检历史',
            icon: null,
            content: '只删本机存的历史报告，不动集群上的任何东西；当前屏幕上这份报告可以继续导出。',
            okText: '清空',
            okButtonProps: {danger: true},
            onOk: async () => {
                await window.electronAPI.inspection.clear({clusterId});
                setHistory([]);
            },
        });
    }, [clusterId]);

    const columns = useMemo<ColumnsType<InspectionCheck>>(
        () => [
            {
                title: '级别',
                dataIndex: 'level',
                width: 90,
                render: (level: InspectionLevel) => <Tag color={LEVEL_META[level].color}>{LEVEL_META[level].text}</Tag>,
                sorter: (a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level],
                defaultSortOrder: 'ascend',
            },
            {title: '检查项', dataIndex: 'title', width: 180},
            {title: '结论', dataIndex: 'summary'},
            {
                title: '建议',
                dataIndex: 'suggestion',
                width: 260,
                render: (value?: string) => value || <Typography.Text type="secondary">—</Typography.Text>,
            },
        ],
        [],
    );

    const rows = useMemo(
        () => (report ? [...report.checks].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]) : []),
        [report],
    );

    // 环比只列移动过的那几项：一份「9 项全部不变」的清单读起来和没读一样，
    // 不变的数量放在小标题里说一次就够。
    const changedItems = useMemo(() => (diff ? diff.items.filter(item => item.kind !== 'unchanged') : []), [diff]);

    const historyColumns = useMemo<ColumnsType<InspectionHistoryRow>>(
        () => [
            {
                title: '时间',
                dataIndex: 'generatedAt',
                width: 200,
                // 屏幕上这份也在列表里，标出来免得用户以为历史里那条是别的集群的报告
                render: (value: string) =>
                    `${value.slice(0, 19).replace('T', ' ')}${value === report?.generatedAt ? '（本次）' : ''}`,
            },
            {title: '严重', dataIndex: ['totals', 'crit'], width: 70},
            {title: '关注', dataIndex: ['totals', 'warn'], width: 70},
            {title: '正常', dataIndex: ['totals', 'ok'], width: 70},
            {title: '未覆盖', dataIndex: ['totals', 'skip'], width: 80},
            {
                title: '采样',
                dataIndex: ['scope', 'topicsSampled'],
                width: 110,
                render: (_: unknown, record) => `${record.scope.topicsSampled}/${record.scope.topicsSeen}`,
            },
        ],
        [report?.generatedAt],
    );

    return (
        <PageShell
            title="集群巡检"
            subtitle={
                report
                    ? `采样 ${report.scope.topicsSampled}/${report.scope.topicsSeen} 个 topic · ${reportVersion(report)}`
                    : '一次只读采集，换一份可以发出去的体检报告'
            }
            actions={
                <Space wrap>
                    <Select
                        style={{width: 180}}
                        placeholder="选择集群"
                        value={clusterId || undefined}
                        options={clusterOptions}
                        onChange={setClusterId}
                    />
                    <InputNumber
                        min={1}
                        max={1000}
                        step={10}
                        value={maxTopics}
                        onChange={value => setMaxTopics(value || 60)}
                        addonBefore="topic 上限"
                        style={{width: 170}}
                    />
                    <Button type="primary" icon={<SafetyCertificateOutlined />} loading={loading} onClick={handleRun}>
                        开始巡检
                    </Button>
                    <Button icon={<DownloadOutlined />} disabled={!markdown} onClick={handleExport}>
                        导出 Markdown
                    </Button>
                    <Button icon={<DeleteOutlined />} disabled={!history.length} onClick={handleClearHistory}>
                        清空历史
                    </Button>
                    <Typography.Text type="secondary">已存 {history.length} 份历史报告</Typography.Text>
                </Space>
            }
        >
            <StateBlock
                loading={loading}
                error={error}
                empty={!report && !loading && !history.length}
                emptyText="选好集群与采样上限，点「开始巡检」"
                height={240}
            >
                <Space direction="vertical" size={12} style={{width: '100%'}}>
                    {report ? (
                        <>
                            {report.scope.truncated ? (
                                <Alert
                                    type="info"
                                    showIcon
                                    message={truncationNote(report.scope)}
                                    description="结论只覆盖采到的那部分；集群规模大时把上限调高，或按命名空间分别巡检。"
                                />
                            ) : null}
                            {report.totals.crit > 0 ? (
                                <Alert
                                    type="error"
                                    showIcon
                                    message={`${report.totals.crit} 项严重、${report.totals.warn} 项需要关注`}
                                    description="下表按级别排序，先看红字那几行。"
                                />
                            ) : null}
                            {diff && changedItems.length ? (
                                <Space direction="vertical" size={6} style={{width: '100%'}}>
                                    <Typography.Text strong>{diffHeading(diff, changedItems.length)}</Typography.Text>
                                    <Table<InspectionDiffItem>
                                        rowKey="key"
                                        size="small"
                                        pagination={false}
                                        dataSource={changedItems}
                                        columns={[
                                            {
                                                title: '变化',
                                                dataIndex: 'kind',
                                                width: 120,
                                                render: (kind: InspectionChangeKind) => (
                                                    <Tag color={KIND_META[kind].color}>{KIND_META[kind].text}</Tag>
                                                ),
                                            },
                                            {
                                                title: '级别',
                                                dataIndex: 'key',
                                                width: 130,
                                                render: (_: unknown, item) => levelShift(item),
                                            },
                                            {title: '检查项', dataIndex: 'title', width: 180},
                                            {title: '本次结论', dataIndex: 'summary'},
                                        ]}
                                    />
                                </Space>
                            ) : null}
                            {diff && !changedItems.length ? (
                                <Typography.Text type="secondary">
                                    与上一次巡检的结论一致，没有项目的级别发生变化。
                                </Typography.Text>
                            ) : null}
                            <Table<InspectionCheck>
                                rowKey="key"
                                size="small"
                                columns={columns}
                                dataSource={rows}
                                pagination={false}
                                expandable={{
                                    // 证据行只在展开后出现：默认一屏全是数字，没人会把它们和结论对上
                                    expandedRowRender: record =>
                                        record.detail?.length ? (
                                            <ul style={{margin: 0, paddingLeft: 20}}>
                                                {record.detail.map((line, index) => (
                                                    <li key={index}>{line}</li>
                                                ))}
                                            </ul>
                                        ) : (
                                            <Typography.Text type="secondary">这一项没有逐条证据</Typography.Text>
                                        ),
                                    rowExpandable: record => Boolean(record.detail?.length),
                                }}
                            />
                        </>
                    ) : null}
                    {history.length ? (
                        <Space direction="vertical" size={6} style={{width: '100%'}}>
                            <Typography.Text type="secondary">
                                历史报告（点一行看那一份当时的结论与它的环比；每台集群最多留 30 份）
                            </Typography.Text>
                            <Table<InspectionHistoryRow>
                                rowKey="id"
                                size="small"
                                columns={historyColumns}
                                dataSource={history}
                                pagination={false}
                                scroll={{x: 640}}
                                onRow={record => ({
                                    onClick: () => void handleOpenHistory(record.id),
                                    style: {cursor: 'pointer'},
                                })}
                            />
                        </Space>
                    ) : null}
                </Space>
            </StateBlock>
        </PageShell>
    );
};

export default ClusterInspection;
