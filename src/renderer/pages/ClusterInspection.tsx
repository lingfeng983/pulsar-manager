import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Alert, Button, InputNumber, Modal, Select, Space, Switch, Table, Tag, Typography, message} from 'antd';
import type {ColumnsType} from 'antd/es/table';
import {
    ClockCircleOutlined,
    DeleteOutlined,
    DownloadOutlined,
    SafetyCertificateOutlined,
    SlidersOutlined,
} from '@ant-design/icons';
import PageShell from '../components/common/PageShell';
import StateBlock from '../components/common/StateBlock';
import {downloadBlob} from '../utils/download';
import {useClusterStore} from '../store/cluster';
import {themedModal} from '../components/common/dangerConfirm';
import {
    INSPECTION_DEFAULTS,
    INSPECTION_THRESHOLDS,
    THRESHOLD_FIELDS,
    THRESHOLD_LABELS,
    THRESHOLD_LIMITS,
    SAMPLING_LIMITS,
    thresholdDisplay,
    type ThresholdField,
} from '../../shared/inspection-caliber';
import {
    DEFAULT_INTERVAL_MINUTES,
    INSPECTION_HISTORY_KEEP,
    INTERVAL_LIMITS,
    formatIntervalMinutes,
    inspectionSourceLabel,
    nextInspectionRunAt,
} from '../../shared/inspection-schedule';
import type {
    InspectionChangeKind,
    InspectionCheck,
    InspectionDiff,
    InspectionDiffItem,
    InspectionHistoryRow,
    InspectionLevel,
    InspectionProfile,
    InspectionReport,
    InspectionSchedule,
    InspectionScope,
    InspectionThresholdChange,
    InspectionThresholds,
} from '../types';

interface Props {
    clusterId?: string;
}

/** 口径弹窗里的可编辑表单：六个判定线加两个采样上限，全是数字。 */
type CaliberDraft = Record<ThresholdField, number> & {maxNamespaces: number; maxTopics: number};

/** 调度弹窗里的表单。开关默认关：存间隔不该顺手把「应用自己会打 broker」这条路打开。 */
type ScheduleDraft = {enabled: boolean; intervalMinutes: number; notifyOnCrit: boolean};

const DEFAULT_SCHEDULE_DRAFT: ScheduleDraft = {
    enabled: false,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    notifyOnCrit: true,
};

function scheduleDraftFrom(schedule: InspectionSchedule | null): ScheduleDraft {
    if (!schedule) {
        return DEFAULT_SCHEDULE_DRAFT;
    }
    return {enabled: schedule.enabled, intervalMinutes: schedule.intervalMinutes, notifyOnCrit: schedule.notifyOnCrit};
}

function draftFrom(profile: InspectionProfile | null): CaliberDraft {
    const thresholds = profile?.thresholds ?? INSPECTION_THRESHOLDS;
    return {
        ...thresholds,
        maxNamespaces: profile?.maxNamespaces ?? INSPECTION_DEFAULTS.maxNamespaces,
        maxTopics: profile?.maxTopics ?? INSPECTION_DEFAULTS.maxTopics,
    };
}

/** 环比里那句「积压严重线 1000000 条 → 500000 条」的清单。 */
function thresholdChangesText(changes: InspectionThresholdChange[]): string {
    const parts = changes.map(item => {
        const from = thresholdDisplay(item.field, item.previous);
        const to = thresholdDisplay(item.field, item.current);
        return `${item.label} ${from} → ${to}`;
    });
    return parts.join('；');
}

/** 报告里那行口径说明。三份话三种意思，不能混成一句「按配置判定」。 */
function caliberNote(thresholds?: InspectionThresholds): string {
    if (!thresholds) {
        return '这一份存于口径可配置之前，当时用的是哪条判定线没有记下来';
    }
    const overridden = THRESHOLD_FIELDS.filter(field => thresholds[field] !== INSPECTION_THRESHOLDS[field]);
    if (!overridden.length) {
        return '本次判定口径：默认阈值';
    }
    return `本次判定口径（已按本集群调整）：${overridden
        .map(field => `${THRESHOLD_LABELS[field]} ${thresholdDisplay(field, thresholds[field])}`)
        .join('，')}`;
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
    const [maxNamespaces, setMaxNamespaces] = useState(INSPECTION_DEFAULTS.maxNamespaces);
    const [maxTopics, setMaxTopics] = useState(INSPECTION_DEFAULTS.maxTopics);
    const [profile, setProfile] = useState<InspectionProfile | null>(null);
    const [caliberOpen, setCaliberOpen] = useState(false);
    const [draft, setDraft] = useState<CaliberDraft>(draftFrom(null));
    const [savingCaliber, setSavingCaliber] = useState(false);
    const [schedule, setSchedule] = useState<InspectionSchedule | null>(null);
    const [scheduleOpen, setScheduleOpen] = useState(false);
    const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(DEFAULT_SCHEDULE_DRAFT);
    const [savingSchedule, setSavingSchedule] = useState(false);
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

    const loadSchedule = useCallback(async (targetClusterId: string) => {
        if (!targetClusterId) {
            setSchedule(null);
            return;
        }
        const response = await window.electronAPI.inspection.schedule.get({clusterId: targetClusterId});
        setSchedule(response.success ? (response.data ?? null) : null);
    }, []);

    // 换集群就把历史与口径重新拉一遍，同时清掉上一台集群的报告与环比：
    // 报告是"某个集群某一时刻"的快照，挂着别的集群的结果比空着更危险。
    // 采样上限跟着这台集群存过的口径走，否则表单上显示的是默认值、实际用的却是另一套。
    useEffect(() => {
        void loadHistory(clusterId);
        void loadSchedule(clusterId);
        setReport(null);
        setMarkdown('');
        setDiff(null);
        setCaliberOpen(false);
        setScheduleOpen(false);
        if (!clusterId) {
            setProfile(null);
            return;
        }
        void window.electronAPI.inspection.profile.get({clusterId}).then(response => {
            const next = response.success ? (response.data ?? null) : null;
            setProfile(next);
            if (next) {
                setMaxNamespaces(next.maxNamespaces);
                setMaxTopics(next.maxTopics);
            }
        });
    }, [clusterId, loadHistory, loadSchedule]);

    // 定时那一轮跑完（或跑坏）之后要把历史与调度状态拉回来：屏幕上挂着上一份报告、
    // 库里却已经多了一份自动的，是最容易让人误读的组合。
    // 开着弹窗时不覆盖正在编辑的草稿——保存按钮那一份是用户手填的。
    useEffect(() => {
        if (!clusterId) {
            return;
        }
        return window.electronAPI.inspection.onScheduled(push => {
            if (push.clusterId !== clusterId) {
                return;
            }
            void loadHistory(clusterId);
            void loadSchedule(clusterId);
            if (push.kind === 'failed') {
                message.error(push.message);
                return;
            }
            if (push.totals && push.totals.crit > 0) {
                message.warning(push.message);
                return;
            }
            message.success(push.message);
        });
    }, [clusterId, loadHistory, loadSchedule]);

    const clusterOptions = useMemo(() => clusters.map(item => ({value: item.id, label: item.name})), [clusters]);

    const handleRun = useCallback(async () => {
        if (!clusterId) {
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const response = await window.electronAPI.inspection.run({clusterId, maxNamespaces, maxTopics});
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
    }, [clusterId, maxNamespaces, maxTopics, loadHistory]);

    // 打开弹窗时按「这台集群当前生效的口径」填表，而不是留着上次编辑到一半的数字：
    // 改一半没保存再开一次，屏幕上显示的就是没落库的那份，用户会以为已经生效了
    const handleOpenCaliber = useCallback(() => {
        setDraft(draftFrom(profile));
        setCaliberOpen(true);
    }, [profile]);

    const handleSaveCaliber = useCallback(async () => {
        if (!clusterId) {
            return;
        }
        setSavingCaliber(true);
        try {
            const response = await window.electronAPI.inspection.profile.save({
                clusterId,
                thresholds: {
                    backlogWarn: draft.backlogWarn,
                    backlogCrit: draft.backlogCrit,
                    unackedWarn: draft.unackedWarn,
                    rateRatio: draft.rateRatio,
                    rateMinIn: draft.rateMinIn,
                    detailTopN: draft.detailTopN,
                },
                maxNamespaces: draft.maxNamespaces,
                maxTopics: draft.maxTopics,
            });
            if (!response.success || !response.data) {
                // 主进程那句校验原样显示：它说的是「严重线不能低于关注线」这种
                // 只有判定规则才知道的矛盾，表单自己看不出问题
                message.error(response.error || '口径保存失败');
                return;
            }
            setProfile(response.data);
            setMaxNamespaces(response.data.maxNamespaces);
            setMaxTopics(response.data.maxTopics);
            setCaliberOpen(false);
            message.success('判定口径已保存，下一次巡检开始生效');
        } catch (error) {
            message.error(error instanceof Error ? error.message : '口径保存失败');
        } finally {
            setSavingCaliber(false);
        }
    }, [clusterId, draft]);

    // 与口径弹窗同一条规矩：按这台集群当前存着的调度填表，没存过就用默认，
    // 不留着上次编辑到一半的数字
    const handleOpenSchedule = useCallback(() => {
        setScheduleDraft(scheduleDraftFrom(schedule));
        setScheduleOpen(true);
    }, [schedule]);

    const handleSaveSchedule = useCallback(async () => {
        if (!clusterId) {
            return;
        }
        setSavingSchedule(true);
        try {
            const response = await window.electronAPI.inspection.schedule.save({
                clusterId,
                enabled: scheduleDraft.enabled,
                intervalMinutes: scheduleDraft.intervalMinutes,
                notifyOnCrit: scheduleDraft.notifyOnCrit,
            });
            if (!response.success || !response.data) {
                // 间隔越界是主进程拒的（「只能在 30～10080 分钟之间」），这里原样显示：
                // 夹到边界会让人以为存的是自己填的那个数字
                message.error(response.error || '调度保存失败');
                return;
            }
            setSchedule(response.data);
            setScheduleOpen(false);
            message.success(
                response.data.enabled
                    ? `已开启定时巡检，每 ${formatIntervalMinutes(response.data.intervalMinutes)} 一次`
                    : '调度已保存，定时巡检处于关闭状态',
            );
        } catch (error) {
            message.error(error instanceof Error ? error.message : '调度保存失败');
        } finally {
            setSavingSchedule(false);
        }
    }, [clusterId, scheduleDraft]);

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
                title: '来源',
                dataIndex: 'source',
                width: 80,
                // 自动那份没人核对过采样范围，回看时要能一眼分出来哪份是应用自己跑的
                render: (source: InspectionHistoryRow['source']) => (
                    <Tag color={source === 'scheduled' ? 'blue' : 'default'}>{inspectionSourceLabel(source)}</Tag>
                ),
            },
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
                        max={200}
                        step={5}
                        value={maxNamespaces}
                        onChange={value => setMaxNamespaces(value || INSPECTION_DEFAULTS.maxNamespaces)}
                        addonBefore="命名空间上限"
                        style={{width: 190}}
                    />
                    <InputNumber
                        min={1}
                        max={1000}
                        step={10}
                        value={maxTopics}
                        onChange={value => setMaxTopics(value || INSPECTION_DEFAULTS.maxTopics)}
                        addonBefore="topic 上限"
                        style={{width: 170}}
                    />
                    <Button icon={<SlidersOutlined />} disabled={!clusterId} onClick={handleOpenCaliber}>
                        巡检口径
                    </Button>
                    <Button icon={<ClockCircleOutlined />} disabled={!clusterId} onClick={handleOpenSchedule}>
                        定时巡检
                    </Button>
                    {schedule?.enabled ? (
                        <Tag color="processing" style={{marginInlineStart: 0}}>
                            每 {formatIntervalMinutes(schedule.intervalMinutes)} 自动跑一次
                        </Tag>
                    ) : null}
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
                            <Typography.Text type="secondary">{caliberNote(report.thresholds)}</Typography.Text>
                            {diff?.thresholdChanges.length ? (
                                <Alert
                                    type="warning"
                                    showIcon
                                    message="本次与上次的判定口径不同"
                                    description={
                                        `${thresholdChangesText(diff.thresholdChanges)}。` +
                                        '下面这些级别移动里有一部分是判定线动了，不是集群变了。'
                                    }
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
                                历史报告（点一行看那一份当时的结论与它的环比；每台集群最多留 {INSPECTION_HISTORY_KEEP}{' '}
                                份，自动与手动共用这一份额度）
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
            <Modal
                title="巡检口径（只影响这台集群）"
                open={caliberOpen}
                onCancel={() => setCaliberOpen(false)}
                onOk={handleSaveCaliber}
                okText="保存"
                confirmLoading={savingCaliber}
                width={560}
            >
                <Typography.Paragraph type="secondary">
                    判定线存在本机、按集群各一套；改完从下一次巡检开始生效，当次生效的口径会抄进报告与导出的文件里。
                </Typography.Paragraph>
                <Space direction="vertical" size={10} style={{width: '100%'}}>
                    {THRESHOLD_FIELDS.map(field => {
                        const limit = THRESHOLD_LIMITS[field];
                        return (
                            <Space key={field} style={{width: '100%', justifyContent: 'space-between'}}>
                                <Typography.Text>
                                    {THRESHOLD_LABELS[field]}
                                    <Typography.Text type="secondary" style={{marginLeft: 6}}>
                                        默认 {thresholdDisplay(field, INSPECTION_THRESHOLDS[field])}
                                    </Typography.Text>
                                </Typography.Text>
                                <InputNumber
                                    min={limit.min}
                                    max={limit.max}
                                    step={limit.integer ? 1 : 0.1}
                                    value={draft[field]}
                                    onChange={value =>
                                        setDraft(prev => ({...prev, [field]: value ?? INSPECTION_THRESHOLDS[field]}))
                                    }
                                    style={{width: 170}}
                                />
                            </Space>
                        );
                    })}
                    {(
                        [
                            {key: 'maxNamespaces', label: '命名空间采样上限', value: INSPECTION_DEFAULTS.maxNamespaces},
                            {key: 'maxTopics', label: 'topic 采样上限', value: INSPECTION_DEFAULTS.maxTopics},
                        ] as const
                    ).map(item => (
                        <Space key={item.key} style={{width: '100%', justifyContent: 'space-between'}}>
                            <Typography.Text>
                                {item.label}
                                <Typography.Text type="secondary" style={{marginLeft: 6}}>
                                    默认 {item.value}
                                </Typography.Text>
                            </Typography.Text>
                            <InputNumber
                                min={SAMPLING_LIMITS[item.key].min}
                                max={SAMPLING_LIMITS[item.key].max}
                                step={5}
                                value={draft[item.key]}
                                onChange={value => setDraft(prev => ({...prev, [item.key]: value ?? item.value}))}
                                style={{width: 170}}
                            />
                        </Space>
                    ))}
                </Space>
                <Typography.Paragraph type="secondary" style={{marginTop: 12, marginBottom: 0}}>
                    积压严重线不能低于关注线，否则积压只会报到「关注」就停住——这条在保存时校验。
                </Typography.Paragraph>
            </Modal>
            <Modal
                title="定时巡检（只影响这台集群）"
                open={scheduleOpen}
                onCancel={() => setScheduleOpen(false)}
                onOk={handleSaveSchedule}
                okText="保存"
                confirmLoading={savingSchedule}
                width={520}
            >
                <Typography.Paragraph type="secondary">
                    到点由应用自己跑一次只读巡检，结果与手点的那份走同一条路：进历史、带环比、抄上当次口径。
                    间隔改了立刻生效，不必重启应用。
                </Typography.Paragraph>
                <Space direction="vertical" size={12} style={{width: '100%'}}>
                    <Space style={{width: '100%', justifyContent: 'space-between'}}>
                        <Typography.Text>开启定时巡检</Typography.Text>
                        <Switch
                            checked={scheduleDraft.enabled}
                            onChange={checked => setScheduleDraft(prev => ({...prev, enabled: checked}))}
                        />
                    </Space>
                    <Space style={{width: '100%', justifyContent: 'space-between'}}>
                        <Typography.Text>
                            间隔（分钟）
                            <Typography.Text type="secondary" style={{marginLeft: 6}}>
                                {INTERVAL_LIMITS.min}～{INTERVAL_LIMITS.max}，默认{' '}
                                {formatIntervalMinutes(DEFAULT_INTERVAL_MINUTES)}
                            </Typography.Text>
                        </Typography.Text>
                        <InputNumber
                            min={INTERVAL_LIMITS.min}
                            max={INTERVAL_LIMITS.max}
                            step={30}
                            value={scheduleDraft.intervalMinutes}
                            onChange={value =>
                                setScheduleDraft(prev => ({
                                    ...prev,
                                    intervalMinutes: value ?? DEFAULT_INTERVAL_MINUTES,
                                }))
                            }
                            style={{width: 170}}
                            addonAfter={
                                Number.isInteger(scheduleDraft.intervalMinutes)
                                    ? formatIntervalMinutes(scheduleDraft.intervalMinutes)
                                    : ''
                            }
                        />
                    </Space>
                    <Space style={{width: '100%', justifyContent: 'space-between'}}>
                        <Typography.Text>判出严重项时发桌面通知</Typography.Text>
                        <Switch
                            checked={scheduleDraft.notifyOnCrit}
                            onChange={checked => setScheduleDraft(prev => ({...prev, notifyOnCrit: checked}))}
                        />
                    </Space>
                    {schedule ? (
                        <Typography.Text type="secondary">
                            上次自动运行：
                            {schedule.lastRunAt ? schedule.lastRunAt.slice(0, 19).replace('T', ' ') : '还没跑过'}
                            {' · '}下次大约：
                            {(() => {
                                const next = nextInspectionRunAt(schedule.lastRunAt, schedule.intervalMinutes);
                                return next ? new Date(next).toLocaleString() : '待首次';
                            })()}
                        </Typography.Text>
                    ) : null}
                    {schedule?.lastError ? (
                        <Alert
                            type="warning"
                            showIcon
                            message="最近一次自动巡检没有跑成"
                            description={`${schedule.lastError}（这一轮跳过了，到下一个间隔还会再试）`}
                        />
                    ) : null}
                </Space>
                <Typography.Paragraph type="secondary" style={{marginTop: 12, marginBottom: 0}}>
                    同一台集群同时只允许一次巡检在跑：手点的那一轮还没结束时，定时这一轮会跳过而不是叠加请求。
                    自动那份同样占「每台集群最多 {INSPECTION_HISTORY_KEEP} 份」的历史额度。
                </Typography.Paragraph>
            </Modal>
        </PageShell>
    );
};

export default ClusterInspection;
