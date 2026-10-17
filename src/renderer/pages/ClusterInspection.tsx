import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Alert, Button, InputNumber, Select, Space, Table, Tag, Typography} from 'antd';
import type {ColumnsType} from 'antd/es/table';
import {DownloadOutlined, SafetyCertificateOutlined} from '@ant-design/icons';
import PageShell from '../components/common/PageShell';
import StateBlock from '../components/common/StateBlock';
import {downloadBlob} from '../utils/download';
import {useClusterStore} from '../store/cluster';
import type {InspectionCheck, InspectionLevel, InspectionReport, InspectionScope} from '../types';

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
            } else {
                // 失败时清掉上一份：留着旧报告会让用户把「这次没跑成」看成「这次没问题」
                setReport(null);
                setMarkdown('');
                setError(response.error || '巡检失败');
            }
        } catch (error) {
            setReport(null);
            setMarkdown('');
            setError(error instanceof Error ? error.message : '巡检失败');
        } finally {
            setLoading(false);
        }
    }, [clusterId, maxTopics]);

    const handleExport = useCallback(() => {
        if (!report || !markdown) {
            return;
        }
        downloadBlob(markdown, reportFileName(report), 'text/markdown;charset=utf-8');
    }, [report, markdown]);

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
                </Space>
            }
        >
            <StateBlock
                loading={loading}
                error={error}
                empty={!report && !loading}
                emptyText="选好集群与采样上限，点「开始巡检」"
                height={240}
            >
                {report ? (
                    <Space direction="vertical" size={12} style={{width: '100%'}}>
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
                    </Space>
                ) : null}
            </StateBlock>
        </PageShell>
    );
};

export default ClusterInspection;
