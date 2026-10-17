import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Button, Card, Select, Segmented, Space, Switch, Table, Tag, Typography, message} from 'antd';
import type {ColumnsType} from 'antd/es/table';
import {
    AlertOutlined,
    DeleteOutlined,
    EditOutlined,
    ExperimentOutlined,
    NotificationOutlined,
    PlusOutlined,
    ReloadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageShell from '../components/common/PageShell';
import StateBlock from '../components/common/StateBlock';
import IconButton from '../components/common/IconButton';
import AlertRuleModal from '../components/alert/AlertRuleModal';
import {useConfirmDanger} from '../components/common/dangerConfirm';
import {useAlertStore} from '../store/alerts';
import {useTabStore} from '../store/tabs';
import {notifyChannelsTab} from '../utils/tabIds';
import {useClusterStore} from '../store/cluster';
import {useSettingsStore} from '../store/settings';
import {
    alertComparator,
    alertMetric,
    alertScopeLabel,
    describeAlertCondition,
    formatAlertScope,
    formatAlertValue,
} from '../../shared/alert-metrics';
import type {AlertEvent, AlertRule, AlertRuleUpsertParams} from '../types';

const {Text} = Typography;

type EventsFilter = 'firing' | 'resolved' | 'all';

const TIME_FORMAT = 'MM-DD HH:mm:ss';

// AlertRule（带时间戳）→ 提交参数：逐字段列出来，而不是 {...rule} 去掉两个键——
// 少列一个字段会得到一条被静默丢回默认的规则，那比编译错误难查。
function toUpsert(rule: AlertRule, patch: Partial<AlertRuleUpsertParams>): AlertRuleUpsertParams {
    return {
        id: rule.id,
        clusterId: rule.clusterId,
        name: rule.name,
        enabled: rule.enabled,
        scope: rule.scope,
        tenant: rule.tenant,
        namespace: rule.namespace,
        topic: rule.topic,
        persistent: rule.persistent,
        metric: rule.metric,
        comparator: rule.comparator,
        threshold: rule.threshold,
        consecutive: rule.consecutive,
        notify: rule.notify,
        ...patch,
    };
}

const AlertCenter: React.FC = () => {
    const confirmDanger = useConfirmDanger();
    const clusters = useClusterStore(state => state.clusters);
    const fetchClusters = useClusterStore(state => state.fetchClusters);
    const alertEnabled = useSettingsStore(state => state.settings.alertEnabled);
    const alertCheckSeconds = useSettingsStore(state => state.settings.alertCheckSeconds);
    const setAlertEnabled = useSettingsStore(state => state.update);
    const addTab = useTabStore(state => state.addTab);

    const rules = useAlertStore(state => state.rules);
    const events = useAlertStore(state => state.events);
    const loading = useAlertStore(state => state.loading);
    const error = useAlertStore(state => state.error);
    const refresh = useAlertStore(state => state.refresh);
    const saveRule = useAlertStore(state => state.saveRule);
    const removeRule = useAlertStore(state => state.removeRule);
    const probe = useAlertStore(state => state.probe);
    const ack = useAlertStore(state => state.ack);
    const removeEvents = useAlertStore(state => state.removeEvents);

    const [clusterFilter, setClusterFilter] = useState<string>('');
    const [eventsFilter, setEventsFilter] = useState<EventsFilter>('firing');
    const [selected, setSelected] = useState<number[]>([]);
    const [modalOpen, setModalOpen] = useState(false);
    const [editing, setEditing] = useState<AlertRule | null>(null);
    const [saving, setSaving] = useState(false);
    const [probingId, setProbingId] = useState<string | null>(null);

    useEffect(() => {
        void refresh();
        // 页签可能是应用启动后第一个打开的，集群列表还没读过来
        if (clusters.length === 0) {
            void fetchClusters();
        }
    }, [refresh, clusters.length, fetchClusters]);

    const clusterName = useCallback(
        (id: string) => clusters.find(cluster => cluster.id === id)?.name || id.slice(0, 8),
        [clusters],
    );

    const visibleRules = useMemo(
        () => rules.filter(rule => !clusterFilter || rule.clusterId === clusterFilter),
        [rules, clusterFilter],
    );

    const visibleEvents = useMemo(
        () =>
            events.filter(event => {
                if (clusterFilter && event.clusterId !== clusterFilter) {
                    return false;
                }
                if (eventsFilter === 'all') {
                    return true;
                }
                return event.state === eventsFilter;
            }),
        [events, clusterFilter, eventsFilter],
    );

    // 只让未确认且仍在烧的行进批量选择：已恢复的批量确认没意义，已确认的再点一次是空转
    const selectableFiring = useMemo(
        () => visibleEvents.filter(event => event.state === 'firing' && event.ackedAt == null),
        [visibleEvents],
    );

    const openCreate = () => {
        setEditing(null);
        setModalOpen(true);
    };

    const openEdit = (rule: AlertRule) => {
        setEditing(rule);
        setModalOpen(true);
    };

    const submitRule = async (params: AlertRuleUpsertParams) => {
        setSaving(true);
        try {
            const saved = await saveRule(params);
            if (saved) {
                setModalOpen(false);
                message.success(params.id ? `已保存规则「${saved.name}」` : `已新建规则「${saved.name}」`);
            }
        } finally {
            setSaving(false);
        }
    };

    const toggleRule = async (rule: AlertRule, enabled: boolean) => {
        const saved = await saveRule(toUpsert(rule, {enabled}));
        if (saved) {
            message.success(enabled ? `已启用「${saved.name}」` : `已停用「${saved.name}」`);
        }
    };

    const testRule = async (rule: AlertRule) => {
        setProbingId(rule.id);
        try {
            const result = await probe(rule.id);
            message.info(
                `${rule.name}：${result.metricLabel}当前 ${result.valueText}，` +
                    `阈值 ${result.thresholdText} → ${result.breached ? '已超标' : '未超标'}`,
                8,
            );
        } catch (err) {
            message.error((err as Error).message);
        } finally {
            setProbingId(null);
        }
    };

    const askDeleteRule = (rule: AlertRule) => {
        confirmDanger({
            title: `删除规则「${rule.name}」`,
            description: '该规则的历史事件会一并删除，且不可恢复。',
            onOk: async () => {
                if (await removeRule(rule.id)) {
                    message.success('规则已删除');
                }
            },
        });
    };

    const ackAll = async () => {
        const ids = selectableFiring.map(event => event.id);
        if (ids.length === 0) {
            message.info('没有待确认的未恢复事件');
            return;
        }
        if (await ack(ids)) {
            message.success(`已确认 ${ids.length} 条`);
        }
    };

    const ackSelected = async () => {
        if (selected.length === 0) {
            return;
        }
        if (await ack(selected)) {
            message.success(`已确认 ${selected.length} 条`);
            setSelected([]);
        }
    };

    const deleteSelected = async () => {
        if (selected.length === 0) {
            return;
        }
        if (await removeEvents(selected)) {
            message.success(`已删除 ${selected.length} 条`);
            setSelected([]);
        }
    };

    const ruleColumns: ColumnsType<AlertRule> = [
        {title: '名称', dataIndex: 'name', width: 180, render: (name: string) => <Text strong>{name}</Text>},
        {title: '集群', dataIndex: 'clusterId', width: 130, render: (id: string) => clusterName(id)},
        {
            title: '口径',
            key: 'scope',
            width: 220,
            ellipsis: true,
            render: (_, rule) => (
                <Space size={4}>
                    <Tag>{alertScopeLabel(rule.scope)}</Tag>
                    <Text style={{fontSize: 'var(--font-size-xs)'}}>{formatAlertScope(rule)}</Text>
                </Space>
            ),
        },
        {
            title: '条件',
            key: 'condition',
            render: (_, rule) => describeAlertCondition(rule),
        },
        {
            title: '通知',
            key: 'notify',
            width: 60,
            render: (_, rule) => (rule.notify ? <Tag color="blue">开</Tag> : <Tag>关</Tag>),
        },
        {
            title: '启用',
            key: 'enabled',
            width: 64,
            render: (_, rule) => (
                <Switch size="small" checked={rule.enabled} onChange={checked => void toggleRule(rule, checked)} />
            ),
        },
        {
            title: '更新',
            dataIndex: 'updatedAt',
            width: 110,
            render: (value: string) => dayjs(value).format('MM-DD HH:mm'),
        },
        {
            title: '操作',
            key: 'actions',
            width: 130,
            render: (_, rule) => (
                <Space size={2}>
                    <IconButton
                        size="small"
                        icon={<ExperimentOutlined />}
                        label="试跑"
                        loading={probingId === rule.id}
                        onClick={() => void testRule(rule)}
                    />
                    <IconButton size="small" icon={<EditOutlined />} label="编辑" onClick={() => openEdit(rule)} />
                    <IconButton
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        label="删除"
                        onClick={() => askDeleteRule(rule)}
                    />
                </Space>
            ),
        },
    ];

    const eventColumns: ColumnsType<AlertEvent> = [
        {
            title: '状态',
            dataIndex: 'state',
            width: 88,
            render: (state: AlertEvent['state'], event) =>
                state === 'firing' ? (
                    <Tag color={event.ackedAt == null ? 'error' : 'warning'}>
                        {event.ackedAt == null ? '未恢复' : '已知悉'}
                    </Tag>
                ) : (
                    <Tag color="success">已恢复</Tag>
                ),
        },
        {title: '规则', dataIndex: 'ruleName', width: 160, render: (name: string) => <Text strong>{name}</Text>},
        {title: '集群', dataIndex: 'clusterId', width: 120, render: (id: string) => clusterName(id)},
        {title: '口径', dataIndex: 'scopeLabel', width: 200, ellipsis: true},
        {
            title: '当前值 / 阈值',
            key: 'value',
            width: 150,
            render: (_, event) => {
                const meta = alertMetric(event.metric);
                const symbol = alertComparator(event.comparator).symbol;
                return (
                    <span>
                        <Text strong style={{color: event.state === 'firing' ? 'var(--color-error)' : undefined}}>
                            {formatAlertValue(event.metric, event.lastValue)}
                        </Text>
                        <span className="hint-text">
                            {' '}
                            {symbol} {formatAlertValue(event.metric, event.threshold)} {meta.unit}
                        </span>
                    </span>
                );
            },
        },
        {title: '说明', dataIndex: 'message', ellipsis: true},
        {
            title: '触发时间',
            dataIndex: 'firedAt',
            width: 120,
            render: (value: number) => dayjs(value).format(TIME_FORMAT),
        },
        {
            title: '最近观测',
            dataIndex: 'lastSeenAt',
            width: 120,
            render: (value: number) => dayjs(value).format(TIME_FORMAT),
        },
        {
            title: '操作',
            key: 'actions',
            width: 70,
            render: (_, event) =>
                event.state === 'firing' && event.ackedAt == null ? (
                    <Button size="small" type="link" onClick={() => void ack([event.id])}>
                        确认
                    </Button>
                ) : null,
        },
    ];

    const firingCount = events.filter(event => event.state === 'firing').length;

    return (
        <PageShell
            subtitle={`引擎${alertEnabled ? `每 ${alertCheckSeconds} 秒评估一次` : '未开启'}`}
            actions={
                <Space size={6}>
                    <Select
                        size="small"
                        style={{width: 160}}
                        value={clusterFilter}
                        onChange={setClusterFilter}
                        options={[
                            {value: '', label: '全部集群'},
                            ...clusters.map(cluster => ({value: cluster.id, label: cluster.name})),
                        ]}
                    />
                    <Button size="small" icon={<ReloadOutlined />} onClick={() => void refresh()} loading={loading}>
                        刷新
                    </Button>
                    {/* 规则里那个「通知」开关只管桌面通知；要发到群里得另配渠道，
                        而这两件事最容易被混为一谈，所以把入口直接摆在告警中心里 */}
                    <Button
                        size="small"
                        icon={<NotificationOutlined />}
                        title="告警要发到哪些外部渠道（群机器人 / webhook）"
                        onClick={() => addTab(notifyChannelsTab())}
                    >
                        通知渠道
                    </Button>
                    <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                        新建规则
                    </Button>
                </Space>
            }
        >
            {!alertEnabled ? (
                <Card size="small" style={{marginBottom: 'var(--spacing-sm)'}}>
                    <Space>
                        <AlertOutlined style={{color: 'var(--color-warning)'}} />
                        <span>告警引擎当前未开启，规则不会评估。</span>
                        <Switch
                            size="small"
                            checked={alertEnabled}
                            onChange={checked =>
                                void setAlertEnabled({alertEnabled: checked}).then(result => {
                                    if (!result.ok) {
                                        message.error(result.error);
                                    }
                                })
                            }
                        />
                        <Text className="hint-text">开启后立即评估一轮。</Text>
                    </Space>
                </Card>
            ) : null}

            <StateBlock
                loading={loading && rules.length === 0}
                error={error}
                onRetry={() => void refresh()}
                height={200}
            >
                <Card size="small" title={`规则（${visibleRules.length}）`} style={{marginBottom: 'var(--spacing-sm)'}}>
                    <Table<AlertRule>
                        size="small"
                        rowKey="id"
                        columns={ruleColumns}
                        dataSource={visibleRules}
                        pagination={false}
                        scroll={{x: 'max-content'}}
                        locale={{emptyText: '还没有告警规则，点上方「新建规则」加一条'}}
                    />
                </Card>

                <Card
                    size="small"
                    title={
                        <Space size={8}>
                            <span>事件（未恢复 {firingCount}）</span>
                            <Segmented
                                size="small"
                                value={eventsFilter}
                                onChange={value => setEventsFilter(value as EventsFilter)}
                                options={[
                                    {value: 'firing', label: '未恢复'},
                                    {value: 'resolved', label: '已恢复'},
                                    {value: 'all', label: '全部'},
                                ]}
                            />
                        </Space>
                    }
                    extra={
                        <Space size={6}>
                            <Button size="small" disabled={selected.length === 0} onClick={() => void ackSelected()}>
                                确认选中（{selected.length}）
                            </Button>
                            <Button
                                size="small"
                                danger
                                disabled={selected.length === 0}
                                onClick={() => void deleteSelected()}
                            >
                                删除选中
                            </Button>
                            <Button size="small" disabled={selectableFiring.length === 0} onClick={() => void ackAll()}>
                                全部确认
                            </Button>
                        </Space>
                    }
                >
                    <Table<AlertEvent>
                        size="small"
                        rowKey="id"
                        columns={eventColumns}
                        dataSource={visibleEvents}
                        pagination={{pageSize: 20, showSizeChanger: false}}
                        scroll={{x: 'max-content'}}
                        rowSelection={{
                            selectedRowKeys: selected,
                            onChange: keys => setSelected(keys as number[]),
                            // 未恢复、未确认的才允许勾选，与「全部确认」的口径保持一致
                            getCheckboxProps: event => ({
                                disabled: event.state !== 'firing' || event.ackedAt != null,
                            }),
                        }}
                        locale={{emptyText: eventsFilter === 'firing' ? '当前没有未恢复的告警' : '暂无事件'}}
                    />
                </Card>
            </StateBlock>

            <AlertRuleModal
                open={modalOpen}
                clusters={clusters}
                rule={editing}
                saving={saving}
                onClose={() => setModalOpen(false)}
                onSubmit={submitRule}
            />
        </PageShell>
    );
};

export default AlertCenter;
