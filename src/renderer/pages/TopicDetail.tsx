import React, {useState, useEffect, useCallback, useRef, useContext} from 'react';
import {
    Card,
    Tabs,
    Row,
    Col,
    Tag,
    Button,
    Table,
    Space,
    Modal,
    Form,
    Input,
    Select,
    DatePicker,
    InputNumber,
    Tooltip,
    message,
} from 'antd';
import dayjs from 'dayjs';
import {
    DatabaseOutlined,
    DownloadOutlined,
    LockOutlined,
    MessageOutlined,
    UserOutlined,
    SettingOutlined,
    BarChartOutlined,
    DeleteOutlined,
    PlusOutlined,
    ReloadOutlined,
    SafetyOutlined,
    SendOutlined,
} from '@ant-design/icons';
import type {TopicConfig, TopicConfigPatch, TopicStats} from '../types';
import {useTabStore} from '../store/tabs';
import {formatBytes, formatMessageRate, formatThroughput} from '../utils/format';
import {topicTabId, producerTab, consumerTab} from '../utils/tabIds';
import {invalidateTopics, invalidateTopicStats} from '../hooks/resourceCache';
import MessageBrowser from './MessageBrowser';
import {useCommand, PaneActiveContext} from '../hooks/useKeybindings';
import PageShell from '../components/common/PageShell';
import StateBlock from '../components/common/StateBlock';
import {useConfirmDanger} from '../components/common/dangerConfirm';
import TopicSchemaTab from '../components/topic/TopicSchemaTab';
import TopicPolicyPanel from '../components/topic/TopicPolicyPanel';
import PermissionsPanel from '../components/common/PermissionsPanel';

interface TopicDetailProps {
    clusterId: string;
    tenant: string;
    namespace: string;
    topic: string;
    persistent?: boolean;
}

// broker 用 -1 表示"该维度不限制"，原样除以 60000 会显示成 -0.0000166 分钟。
function formatBacklogQuota(bytes: number | undefined, millis: number | undefined): string {
    const sizeText = bytes === undefined || bytes < 0 ? '不限制' : formatBytes(bytes);
    const timeText = millis === undefined || millis < 0 ? '不限制' : `${Math.round(millis / 60000)} 分钟`;
    return `${sizeText} / ${timeText}`;
}

// broker 报的类型值两套口径不一样：订阅是 exclusive/shared/failover/key_shared，
// 生产者接入模式是 ExclusiveMode/SharedMode，归一成人话；认不出的原样显示，不硬造。
function typeLabel(raw?: string): string {
    switch ((raw || '').toLowerCase().replace(/_/g, ' ')) {
        case 'exclusive':
        case 'exclusivemode':
            return '独占（Exclusive）';
        case 'shared':
        case 'sharedmode':
            return '共享（Shared）';
        case 'failover':
            return '故障转移（Failover）';
        case 'key shared':
        case 'keyshared':
        case 'keysharedmode':
            return 'Key 共享（Key_Shared）';
        default:
            return raw || '未知';
    }
}

// 悬浮详情的行渲染：跳过没取到的字段，避免整块悬浮框里挂一排"未知"。
function detailRows(rows: [string, unknown][]): React.ReactNode {
    const shown = rows.filter(([, value]) => value !== undefined && value !== null && value !== '');
    if (shown.length === 0) {
        return null;
    }
    return (
        <div>
            {shown.map(([label, value]) => (
                <div key={label}>{`${label}: ${String(value)}`}</div>
            ))}
        </div>
    );
}

const TopicDetail: React.FC<TopicDetailProps> = ({clusterId, tenant, namespace, topic, persistent = true}) => {
    const [stats, setStats] = useState<TopicStats | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState('overview');
    const [createModalOpen, setCreateModalOpen] = useState(false);
    const [createForm] = Form.useForm();
    const [creatingInProgress, setCreatingInProgress] = useState(false);
    const [resetCursorModalOpen, setResetCursorModalOpen] = useState(false);
    const [resettingSubscription, setResettingSubscription] = useState<string | null>(null);
    const [resettingInProgress, setResettingInProgress] = useState(false);
    const [resetPosition, setResetPosition] = useState<'earliest' | 'latest' | 'timestamp'>('latest');
    const [resetTimestamp, setResetTimestamp] = useState<number | null>(null);
    const [skipMessagesModalOpen, setSkipMessagesModalOpen] = useState(false);
    const [skippingSubscription, setSkippingSubscription] = useState<string | null>(null);
    const [skippingInProgress, setSkippingInProgress] = useState(false);
    const [skipCount, setSkipCount] = useState(0);
    const [topicConfig, setTopicConfig] = useState<TopicConfig | null>(null);
    const [configError, setConfigError] = useState<string | null>(null);
    const [editConfigForm] = Form.useForm();
    const [configLoading, setConfigLoading] = useState(false);
    const [savingInProgress, setSavingInProgress] = useState(false);

    const {addTab, removeTab} = useTabStore();
    const confirmDanger = useConfirmDanger();
    const tabId = topicTabId({clusterId, tenant, namespace, topic, persistent});
    // 外层页签被切走时 antd 只是 display:none，组件仍然挂载，15s 轮询会在后台
    // 一直打 IPC。这里跟随页签激活态，非当前页签不启动轮询。
    const paneActive = useContext(PaneActiveContext);

    useCommand('browseMessages', () => setActiveTab('messages'));
    // Topic 完整 URI，供配置页展示
    const topicUri = `${persistent ? 'persistent' : 'non-persistent'}://${tenant}/${namespace}/${topic}`;
    // 实测 Admin API 对 non-persistent topic 的订阅管理直接返回 400
    // （`Create subscription on non-persistent topic can only be done through client`），
    // 只能由客户端自己建，所以在界面上先禁用入口而不是让人去撞这条报错。
    const adminSubscriptionUnsupported = !persistent;
    const adminSubscriptionHint = 'non-persistent topic 的订阅只能由客户端创建，Admin API 不支持';

    const requestIdRef = useRef(0);

    // 获取Topic统计信息。
    // 这里故意绕开 resourceCache 的 loadTopicStats：本页每 15s 轮询一次，而
    // topicStats 缓存 TTL 是 30s，走缓存会有一半的轮询拿到上一轮的旧数据。
    // 详情页要的是实时值，所以直接打 IPC；写操作后再显式失效共享缓存。
    const fetchTopicStats = useCallback(async () => {
        const currentRequestId = ++requestIdRef.current;
        setLoading(true);
        setError(null);
        try {
            const response = await window.electronAPI.resources.getTopicStats(
                clusterId,
                tenant,
                namespace,
                topic,
                persistent,
            );
            if (currentRequestId !== requestIdRef.current) {
                return;
            }
            if (response.success && response.data) {
                setStats(response.data);
            } else {
                setError(response.error || 'Failed to fetch topic stats');
            }
        } catch (error) {
            if (currentRequestId !== requestIdRef.current) {
                return;
            }
            setError(String(error));
        } finally {
            if (currentRequestId === requestIdRef.current) {
                setLoading(false);
            }
        }
    }, [clusterId, tenant, namespace, topic, persistent]);

    useEffect(() => {
        if (!paneActive) {
            return;
        }
        fetchTopicStats();
        const interval = setInterval(() => {
            // 窗口最小化/隐藏时不轮询；回到可见时由 visibilitychange 补一次
            if (!document.hidden) {
                fetchTopicStats();
            }
        }, 15000);
        const onVisible = () => {
            if (!document.hidden) {
                fetchTopicStats();
            }
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            clearInterval(interval);
            document.removeEventListener('visibilitychange', onVisible);
            // 不清零 requestIdRef：归零后新请求会复用旧编号，
            // 失效前发出的在途响应就能冒充最新结果落进 state
        };
    }, [fetchTopicStats, paneActive]);

    // 删除订阅
    const handleDeleteSubscription = (subscriptionName: string) => {
        confirmDanger({
            title: '删除订阅',
            description: (
                <>
                    删除订阅 <strong>{subscriptionName}</strong> 会同时丢弃它的游标与未确认消息，此操作不可恢复。
                </>
            ),
            okText: '确认删除',
            requireExactName: subscriptionName,
            onOk: async () => {
                const response = await window.electronAPI.resources.deleteSubscription(
                    clusterId,
                    tenant,
                    namespace,
                    topic,
                    subscriptionName,
                    persistent,
                );
                if (!response.success) {
                    // 抛错让确认框保持打开，失败不会被静默关掉
                    throw new Error(response.error || '删除失败');
                }
                message.success('订阅删除成功');
                invalidateTopicStats(clusterId, tenant, namespace, topic);
                await fetchTopicStats();
            },
        });
    };

    // 创建订阅
    const handleCreateSubscription = async () => {
        let values: {name: string; initialPosition?: 'Earliest' | 'Latest'};
        try {
            values = await createForm.validateFields();
        } catch {
            // 校验失败时 antd 抛出 errorFields，字段上已有红字提示，不该再弹"创建失败"
            return;
        }
        setCreatingInProgress(true);
        try {
            const response = await window.electronAPI.resources.createSubscription(
                clusterId,
                tenant,
                namespace,
                topic,
                values.name,
                values.initialPosition || 'Latest',
                persistent,
            );
            if (response.success) {
                message.success('订阅创建成功');
                setCreateModalOpen(false);
                createForm.resetFields();
                invalidateTopicStats(clusterId, tenant, namespace, topic);
                await fetchTopicStats();
            } else {
                message.error(response.error || '创建失败');
            }
        } catch {
            message.error('创建失败');
        } finally {
            setCreatingInProgress(false);
        }
    };

    // 重置游标
    const handleResetCursor = (subscriptionName: string) => {
        setResettingSubscription(subscriptionName);
        setResetPosition('latest');
        setResetTimestamp(null);
        setResetCursorModalOpen(true);
    };

    // 执行重置游标
    const executeResetCursor = async () => {
        if (!resettingSubscription) return;

        setResettingInProgress(true);
        try {
            const response = await window.electronAPI.resources.resetCursor(
                clusterId,
                tenant,
                namespace,
                topic,
                resettingSubscription,
                resetPosition,
                resetPosition === 'timestamp' ? (resetTimestamp as number) : undefined,
                persistent,
            );
            if (response.success) {
                message.success('游标重置成功');
                setResetCursorModalOpen(false);
                setResettingSubscription(null);
                invalidateTopicStats(clusterId, tenant, namespace, topic);
                await fetchTopicStats();
            } else {
                message.error(response.error || '重置失败');
            }
        } catch {
            message.error('重置失败');
        } finally {
            setResettingInProgress(false);
        }
    };

    // 跳过消息
    const handleSkipMessages = (subscriptionName: string) => {
        setSkippingSubscription(subscriptionName);
        setSkipCount(0);
        setSkipMessagesModalOpen(true);
    };

    // 执行跳过消息
    const executeSkipMessages = async () => {
        if (!skippingSubscription || skipCount <= 0) return;

        setSkippingInProgress(true);
        try {
            const response = await window.electronAPI.resources.skipMessages(
                clusterId,
                tenant,
                namespace,
                topic,
                skippingSubscription,
                skipCount,
                persistent,
            );
            if (response.success) {
                message.success(`已跳过 ${skipCount} 条消息`);
                setSkipMessagesModalOpen(false);
                setSkippingSubscription(null);
                invalidateTopicStats(clusterId, tenant, namespace, topic);
                await fetchTopicStats();
            } else {
                message.error(response.error || '跳过失败');
            }
        } catch {
            message.error('跳过失败');
        } finally {
            setSkippingInProgress(false);
        }
    };

    // 配置直接摊在页签里编辑，不再走弹窗：切进「配置」页签就拉一次 topic 级配置。
    // 每次进来都重拉，免得拿着上一轮的覆盖值去保存（broker 侧可能已被命名空间改动带偏）。
    const loadTopicConfig = useCallback(async () => {
        setConfigLoading(true);
        setConfigError(null);
        try {
            const response = await window.electronAPI.resources.getTopicConfig(
                clusterId,
                tenant,
                namespace,
                topic,
                persistent,
            );
            if (response.success && response.data) {
                const config = response.data;
                setTopicConfig(config);
                editConfigForm.setFieldsValue({
                    // 留空 = 不修改。分区数是 0 就真的是 0（非分区），不能拿它当"没填"看。
                    numPartitions: config.partitions.length > 0 ? config.partitions.length : null,
                });
            } else {
                setConfigError(response.error || '获取配置失败');
            }
        } catch (configFetchError) {
            setConfigError(configFetchError instanceof Error ? configFetchError.message : '获取配置失败');
        } finally {
            setConfigLoading(false);
        }
    }, [clusterId, tenant, namespace, topic, persistent, editConfigForm]);

    useEffect(() => {
        if (paneActive && activeTab === 'config') {
            void loadTopicConfig();
        }
    }, [paneActive, activeTab, loadTopicConfig]);

    // 保存配置
    const handleSaveConfig = async () => {
        try {
            const values = await editConfigForm.validateFields();
            const patch: TopicConfigPatch = {};

            if (typeof values.numPartitions === 'number') {
                patch.numPartitions = values.numPartitions;
            }

            if (Object.keys(patch).length === 0) {
                message.warning('没有需要修改的配置项');
                return;
            }

            setSavingInProgress(true);
            const response = await window.electronAPI.resources.updateTopicConfig(
                clusterId,
                tenant,
                namespace,
                topic,
                patch,
                persistent,
            );
            if (response.success) {
                message.success('配置更新成功');
                // 分区数变化会改变 topic 列表本身，只失效 stats 不够
                invalidateTopics(clusterId, tenant, namespace);
                invalidateTopicStats(clusterId, tenant, namespace, topic);
                await Promise.all([fetchTopicStats(), loadTopicConfig()]);
            } else {
                message.error(response.error || '更新失败');
            }
        } catch (error: any) {
            // 校验失败时 antd 会抛 errorInfo，不应笼统报"更新失败"
            if (error?.errorFields) return;
            message.error(error?.message || '更新失败');
        } finally {
            setSavingInProgress(false);
        }
    };

    // 删除Topic
    const handleDeleteTopic = () => {
        confirmDanger({
            title: '确认删除 Topic',
            description: '此操作不可恢复，且会删除所有关联的订阅和消息！',
            okText: '确认删除',
            requireExactName: topic,
            onOk: async () => {
                const response = await window.electronAPI.resources.deleteTopic(
                    clusterId,
                    tenant,
                    namespace,
                    topic,
                    persistent,
                );
                if (!response.success) {
                    throw new Error(response.error || '删除失败');
                }
                message.success('Topic 删除成功');
                // Topic 已不存在，列表缓存必须失效，否则资源树仍显示它
                invalidateTopics(clusterId, tenant, namespace);
                invalidateTopicStats(clusterId, tenant, namespace, topic);
                // 关闭当前 tab
                removeTab(tabId);
            },
        });
    };

    // 订阅表格列
    const subscriptionColumns = [
        {
            title: '订阅名称',
            dataIndex: 'name',
            key: 'name',
        },
        {
            title: '积压消息',
            dataIndex: 'msgBacklog',
            key: 'msgBacklog',
            render: (value: number, record: SubscriptionTableItem) => (
                <Tooltip title={`未投递与未确认共 ${value.toLocaleString()} 条，占 ${formatBytes(record.backlogSize)}`}>
                    <Tag color={value > 0 ? 'warning' : 'success'}>{value.toLocaleString()}</Tag>
                </Tooltip>
            ),
        },
        {
            // 速率与吞吐量都是 broker 在采样窗口上的瞬时值，悬浮给原始数字：
            // 表格里是换算后的读数，出问题时人要看的是 broker 报了什么。
            title: (
                <Tooltip title="该订阅每秒取走的消息数（msgRateOut）。为 0 表示当前没有消费者在拉，或没有可投递的消息。">
                    速率
                </Tooltip>
            ),
            dataIndex: 'msgRateOut',
            key: 'msgRateOut',
            render: (value: number | undefined) =>
                value === undefined || value === null ? (
                    '—'
                ) : (
                    <Tooltip title={`msgRateOut = ${value.toFixed(4)} msg/s（瞬时值，随 15s 轮询刷新）`}>
                        <span>{formatMessageRate(value)}</span>
                    </Tooltip>
                ),
        },
        {
            title: (
                <Tooltip title="该订阅每秒流出的字节数（msgThroughputOut），等于速率 × 平均消息体积。">吞吐量</Tooltip>
            ),
            dataIndex: 'msgThroughputOut',
            key: 'msgThroughputOut',
            render: (value: number | undefined) =>
                value === undefined || value === null ? (
                    '—'
                ) : (
                    <Tooltip title={`msgThroughputOut = ${value.toFixed(1)} B/s（瞬时值，随 15s 轮询刷新）`}>
                        <span>{formatThroughput(value)}</span>
                    </Tooltip>
                ),
        },
        {
            title: '消费者数',
            dataIndex: 'consumerCount',
            key: 'consumerCount',
        },
        {
            title: '类型',
            dataIndex: 'type',
            key: 'type',
            render: (value: string) => <Tag>{typeLabel(value)}</Tag>,
        },
        {
            title: '操作',
            key: 'action',
            render: (_: any, record: SubscriptionTableItem) => (
                <Space size={4}>
                    <Button type="link" size="small" onClick={() => handleResetCursor(record.name)}>
                        重置游标
                    </Button>
                    <Button type="link" size="small" onClick={() => handleSkipMessages(record.name)}>
                        跳过消息
                    </Button>
                    <Button type="link" size="small" danger onClick={() => handleDeleteSubscription(record.name)}>
                        删除
                    </Button>
                </Space>
            ),
        },
    ];

    // 生产者表格列
    const producerColumns = [
        {
            // 名称列兼任详情入口：地址、原始速率这些平铺成列会把表格撑出横向滚动，
            // 悬浮一次看全更贴合"偶尔核对一下"的用法
            title: '生产者名称',
            dataIndex: 'producerName',
            key: 'producerName',
            render: (name: string, record: TopicStats['producers'][number]) => (
                <Tooltip
                    title={detailRows([
                        ['类型', typeLabel(record.accessMode)],
                        ['生产者 ID', record.producerId],
                        ['连接', record.connected ? '在线' : '离线'],
                        ['地址', record.address],
                        ['连接时间', record.connectedSince],
                        ['客户端版本', record.clientVersion],
                        [
                            '输入速率',
                            record.msgRateIn === undefined ? undefined : `${record.msgRateIn.toFixed(4)} msg/s`,
                        ],
                        [
                            '吞吐量',
                            record.msgThroughputIn === undefined
                                ? undefined
                                : `${record.msgThroughputIn.toFixed(1)} B/s`,
                        ],
                        ['平均消息大小', record.avgMsgSize === undefined ? undefined : formatBytes(record.avgMsgSize)],
                    ])}
                >
                    <span>{name}</span>
                </Tooltip>
            ),
        },
        {
            title: '类型',
            dataIndex: 'accessMode',
            key: 'accessMode',
            render: (value: string | undefined) => <Tag>{typeLabel(value)}</Tag>,
        },
        {
            title: '输入速率',
            dataIndex: 'msgRateIn',
            key: 'msgRateIn',
            render: (value: number) => formatMessageRate(value),
        },
        {
            title: '吞吐量',
            dataIndex: 'msgThroughputIn',
            key: 'msgThroughputIn',
            render: (value: number) => formatThroughput(value),
        },
        {
            title: '客户端版本',
            dataIndex: 'clientVersion',
            key: 'clientVersion',
        },
    ];

    // 消费者表格列
    const consumerColumns = [
        {
            title: '消费者名称',
            dataIndex: 'consumerName',
            key: 'consumerName',
            render: (name: string, record: TopicStats['consumers'][number]) => (
                <Tooltip
                    title={detailRows([
                        ['所属订阅', record.subscription],
                        ['订阅类型', typeLabel(record.subscriptionType)],
                        ['连接', record.connected ? '在线' : '离线'],
                        ['地址', record.address],
                        ['连接时间', record.connectedSince],
                        ['客户端版本', record.clientVersion],
                        [
                            '输出速率',
                            record.msgRateOut === undefined ? undefined : `${record.msgRateOut.toFixed(4)} msg/s`,
                        ],
                        [
                            '吞吐量',
                            record.msgThroughputOut === undefined
                                ? undefined
                                : `${record.msgThroughputOut.toFixed(1)} B/s`,
                        ],
                        [
                            '重投速率',
                            record.msgRateRedeliver === undefined
                                ? undefined
                                : `${record.msgRateRedeliver.toFixed(4)} msg/s`,
                        ],
                        ['未确认消息', record.unackedMessages],
                        ['可用信用许可', record.availablePermits],
                        [
                            '因未确认积压被阻塞',
                            record.blockedConsumerOnUnackedMsgs === undefined
                                ? undefined
                                : record.blockedConsumerOnUnackedMsgs
                                  ? '是'
                                  : '否',
                        ],
                    ])}
                >
                    <span>{name}</span>
                </Tooltip>
            ),
        },
        {
            title: '所属订阅',
            dataIndex: 'subscription',
            key: 'subscription',
        },
        {
            title: '类型',
            dataIndex: 'subscriptionType',
            key: 'subscriptionType',
            render: (value: string | undefined) => <Tag>{typeLabel(value)}</Tag>,
        },
        {
            title: '输出速率',
            dataIndex: 'msgRateOut',
            key: 'msgRateOut',
            render: (value: number) => formatMessageRate(value),
        },
        {
            // 积压属于订阅维度，单个消费者能看到的只有未确认消息数
            title: '未确认消息',
            dataIndex: 'unackedMessages',
            key: 'unackedMessages',
            render: (value: number) => {
                const unacked = value || 0;
                return <Tag color={unacked > 0 ? 'warning' : 'success'}>{unacked.toLocaleString()}</Tag>;
            },
        },
        {
            title: '客户端版本',
            dataIndex: 'clientVersion',
            key: 'clientVersion',
        },
    ];

    interface SubscriptionTableItem {
        key: string;
        name: string;
        msgBacklog: number;
        backlogSize: number;
        msgRateExpired: number;
        msgRateOut?: number;
        msgThroughputOut?: number;
        unackedMessages: number;
        consumerCount: number;
        type: string;
    }

    // 转换订阅统计为表格数据
    const subscriptionData: SubscriptionTableItem[] =
        stats && stats.subscriptions
            ? Object.entries(stats.subscriptions).map(([name, sub]) => ({
                  key: name,
                  name,
                  msgBacklog: sub.msgBacklog || 0,
                  backlogSize: sub.backlogSize || 0,
                  msgRateExpired: sub.msgRateExpired || 0,
                  msgRateOut: sub.msgRateOut,
                  msgThroughputOut: sub.msgThroughputOut,
                  unackedMessages: sub.unackedMessages || 0,
                  consumerCount: sub.consumerCount || 0,
                  type: sub.type || 'exclusive',
              }))
            : [];

    return (
        <PageShell
            title={`Topic ${topic}`}
            subtitle={`${topicUri} · ${persistent ? '持久化' : '非持久化'}`}
            actions={
                <Space wrap size="small">
                    <Button
                        icon={<SendOutlined />}
                        onClick={() => addTab(producerTab({clusterId, tenant, namespace, topic, persistent}))}
                    >
                        生产者工作台
                    </Button>
                    <Button
                        icon={<DownloadOutlined />}
                        onClick={() => addTab(consumerTab({clusterId, tenant, namespace, topic, persistent}))}
                    >
                        消费者工作台
                    </Button>
                    <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void fetchTopicStats()}>
                        刷新
                    </Button>
                </Space>
            }
        >
            {/* 顶部指标：一行读完。四个 Statistic 竖着排要吃 90px，而这页真正要看的是下面的
                生产者 / 消费者 / 订阅；「消息输入速率」这类长标签在行内只剩「输入」。 */}
            <div className="summary-line metric-line">
                <span>
                    <BarChartOutlined style={{color: 'var(--color-primary)'}} /> 输入{' '}
                    <strong>{(stats?.msgRateIn || 0).toFixed(2)}</strong> msg/s
                </span>
                <span>
                    <MessageOutlined style={{color: 'var(--color-success)'}} /> 输出{' '}
                    <strong>{(stats?.msgRateOut || 0).toFixed(2)}</strong> msg/s
                </span>
                <span>
                    <DatabaseOutlined
                        style={
                            stats?.backlogSize && stats.backlogSize > 0 ? {color: 'var(--color-warning)'} : undefined
                        }
                    />{' '}
                    积压 <strong>{formatBytes(stats?.backlogSize ?? 0)}</strong>
                </span>
                <span>
                    <UserOutlined /> 消费者 <strong>{stats?.consumers?.length || 0}</strong>
                </span>
            </div>

            {/* Tab内容区域 */}
            <Tabs
                activeKey={activeTab}
                onChange={setActiveTab}
                items={[
                    {
                        key: 'overview',
                        label: '概览',
                        icon: <BarChartOutlined />,
                        children: (
                            <StateBlock
                                loading={loading && !stats}
                                error={error}
                                errorTitle="获取数据失败"
                                onRetry={() => void fetchTopicStats()}
                                empty={!stats}
                                emptyText="暂无 Topic 统计"
                            >
                                {stats ? (
                                    <div className="stack">
                                        <Card title="存储信息">
                                            <Row gutter={[12, 12]}>
                                                <Col span={8}>
                                                    <div className="hint-text">总存储大小</div>
                                                    <p className="metric-value">{formatBytes(stats.storageSize)}</p>
                                                </Col>
                                                <Col span={8}>
                                                    <div className="hint-text">积压大小</div>
                                                    <p className="metric-value">{formatBytes(stats.backlogSize)}</p>
                                                </Col>
                                                <Col span={8}>
                                                    <div className="hint-text">消息输入速率</div>
                                                    <p className="metric-value">{formatMessageRate(stats.msgRateIn)}</p>
                                                </Col>
                                            </Row>
                                        </Card>

                                        <Card title={`生产者 (${stats.producers?.length || 0})`}>
                                            {stats.producers && stats.producers.length > 0 ? (
                                                <Table
                                                    dataSource={stats.producers}
                                                    columns={producerColumns}
                                                    rowKey={record => `${record.producerName}-${record.address ?? ''}`}
                                                    pagination={false}
                                                    size="small"
                                                    scroll={{x: 'max-content'}}
                                                />
                                            ) : (
                                                <StateBlock empty emptyText="暂无生产者" height={120} />
                                            )}
                                        </Card>

                                        <Card title={`消费者 (${stats.consumers?.length || 0})`}>
                                            {stats.consumers && stats.consumers.length > 0 ? (
                                                <Table
                                                    dataSource={stats.consumers}
                                                    columns={consumerColumns}
                                                    rowKey={record => `${record.subscription}-${record.consumerName}`}
                                                    pagination={false}
                                                    size="small"
                                                    scroll={{x: 'max-content'}}
                                                />
                                            ) : (
                                                <StateBlock empty emptyText="暂无消费者" height={120} />
                                            )}
                                        </Card>
                                    </div>
                                ) : null}
                            </StateBlock>
                        ),
                    },
                    {
                        key: 'subscriptions',
                        label: '订阅管理',
                        icon: <UserOutlined />,
                        children: (
                            <Card
                                title={`订阅列表 (${subscriptionData.length})`}
                                extra={
                                    <Tooltip title={adminSubscriptionUnsupported ? adminSubscriptionHint : ''}>
                                        <Button
                                            type="primary"
                                            icon={<PlusOutlined />}
                                            disabled={adminSubscriptionUnsupported}
                                            onClick={() => setCreateModalOpen(true)}
                                        >
                                            创建订阅
                                        </Button>
                                    </Tooltip>
                                }
                            >
                                {subscriptionData.length > 0 ? (
                                    <Table
                                        dataSource={subscriptionData}
                                        columns={subscriptionColumns}
                                        rowKey="name"
                                        pagination={false}
                                        size="small"
                                        scroll={{x: 'max-content'}}
                                    />
                                ) : (
                                    <StateBlock empty emptyText="暂无订阅" height={160} />
                                )}
                            </Card>
                        ),
                    },
                    {
                        key: 'messages',
                        label: '消息浏览器',
                        icon: <MessageOutlined />,
                        children: (
                            <MessageBrowser
                                clusterId={clusterId}
                                tenant={tenant}
                                namespace={namespace}
                                topic={topic}
                                persistent={persistent}
                                // 内层页签是 display:none 而非卸载，会话得靠这个标记停掉，
                                // 否则切到概览后消息浏览器还在后台收消息。
                                active={activeTab === 'messages'}
                            />
                        ),
                    },
                    {
                        key: 'schema',
                        label: 'Schema',
                        icon: <DatabaseOutlined />,
                        children: (
                            <TopicSchemaTab
                                clusterId={clusterId}
                                tenant={tenant}
                                namespace={namespace}
                                topic={topic}
                                persistent={persistent}
                                active={activeTab === 'schema'}
                            />
                        ),
                    },
                    {
                        key: 'permissions',
                        label: '权限',
                        icon: <LockOutlined />,
                        children: (
                            <PermissionsPanel
                                scope="topic"
                                clusterId={clusterId}
                                tenant={tenant}
                                namespace={namespace}
                                topic={topic}
                                persistent={persistent}
                                // antd 页签只隐藏不卸载，首次激活再拉，避免打开详情页就多一轮 IPC
                                active={activeTab === 'permissions'}
                            />
                        ),
                    },
                    {
                        key: 'config',
                        label: '配置',
                        icon: <SettingOutlined />,
                        children: (
                            <Card
                                title="Topic 配置"
                                extra={
                                    <Space size="small">
                                        <Button
                                            icon={<ReloadOutlined />}
                                            loading={configLoading}
                                            onClick={() => void loadTopicConfig()}
                                        >
                                            重新载入
                                        </Button>
                                        <Button
                                            type="primary"
                                            loading={savingInProgress}
                                            disabled={!topicConfig}
                                            onClick={() => void handleSaveConfig()}
                                        >
                                            保存配置
                                        </Button>
                                        <Button icon={<DeleteOutlined />} danger onClick={handleDeleteTopic}>
                                            删除 Topic
                                        </Button>
                                    </Space>
                                }
                            >
                                <StateBlock loading={configLoading} error={configError} onRetry={loadTopicConfig}>
                                    <Form form={editConfigForm} layout="vertical" className="stack">
                                        <div className="summary-line">
                                            <span className="field-label">Topic 名称</span>
                                            <code>{topicUri}</code>
                                            <span className="field-label">是否持久化</span>
                                            <span>{persistent ? '是' : '否'}</span>
                                            <span className="field-label">当前分区数</span>
                                            <span>{topicConfig?.partitions.length ?? 0}</span>
                                        </div>
                                        <div className="options-grid">
                                            <div className="opt-group">
                                                <div className="opt-group-title">分区</div>
                                                <Form.Item
                                                    name="numPartitions"
                                                    label="分区数"
                                                    extra="仅分区 topic 可调整；给非分区 topic 设置大于 0 的分区数会把它变成分区 topic"
                                                >
                                                    <InputNumber
                                                        min={0}
                                                        max={1000}
                                                        precision={0}
                                                        style={{width: '100%'}}
                                                        placeholder="不修改"
                                                    />
                                                </Form.Item>
                                                {/* 这里显示的是实际生效值（来自 stats），通常是命名空间或 broker 默认；
                                                    topic 级覆盖值在「策略」页签，两者可以不一样 */}
                                                <div className="readonly-block">
                                                    <div>
                                                        生效积压配额：
                                                        {formatBacklogQuota(
                                                            stats?.backlogQuotaLimitSize,
                                                            stats?.backlogQuotaLimitTime,
                                                        )}
                                                    </div>
                                                    <div>去重状态：{stats?.deduplicationStatus || '未知'}</div>
                                                    <div>
                                                        归属 Broker：
                                                        {stats?.ownerBrokers?.length
                                                            ? stats.ownerBrokers.join('、')
                                                            : topicConfig?.ownerBrokers?.length
                                                              ? topicConfig.ownerBrokers.join('、')
                                                              : '未知'}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                        <p className="hint-text">
                                            保留策略、消息 TTL、去重与未确认上限都有 topic
                                            级端点，在「策略」页签按覆盖值修改；
                                            积压配额、最大消息大小、生产/消费者数量上限等仍只有命名空间级写入口，
                                            上面这几行显示的是实际生效值，不是 topic 级覆盖。
                                        </p>
                                    </Form>
                                </StateBlock>
                            </Card>
                        ),
                    },
                    {
                        key: 'policy',
                        label: '策略',
                        icon: <SafetyOutlined />,
                        children: (
                            <TopicPolicyPanel
                                clusterId={clusterId}
                                tenant={tenant}
                                namespace={namespace}
                                topic={topic}
                                persistent={persistent}
                                // antd 页签只隐藏不卸载：首次激活再读六个端点，
                                // 否则打开详情页要多一轮 IPC
                                active={activeTab === 'policy'}
                            />
                        ),
                    },
                ]}
            />

            {/* 创建订阅弹窗 */}
            <Modal
                title="创建订阅"
                open={createModalOpen}
                onCancel={() => {
                    setCreateModalOpen(false);
                    createForm.resetFields();
                }}
                footer={[
                    <Button
                        key="back"
                        onClick={() => {
                            setCreateModalOpen(false);
                            createForm.resetFields();
                        }}
                    >
                        取消
                    </Button>,
                    <Button key="submit" type="primary" loading={creatingInProgress} onClick={handleCreateSubscription}>
                        创建
                    </Button>,
                ]}
            >
                <Form form={createForm} layout="vertical">
                    <Form.Item name="name" label="订阅名称" rules={[{required: true, message: '请输入订阅名称'}]}>
                        <Input placeholder="输入订阅名称" />
                    </Form.Item>
                    <Form.Item
                        name="initialPosition"
                        label="起始消费位置"
                        initialValue="Latest"
                        extra="订阅类型由第一个连上来的消费者决定，创建时无法指定"
                    >
                        <Select style={{width: '100%'}}>
                            <Select.Option value="Latest">最新位置（只消费新消息）</Select.Option>
                            <Select.Option value="Earliest">最早位置（从保留的消息开头消费）</Select.Option>
                        </Select>
                    </Form.Item>
                </Form>
            </Modal>

            {/* 重置游标弹窗 */}
            <Modal
                title={`重置订阅游标 - ${resettingSubscription}`}
                open={resetCursorModalOpen}
                onCancel={() => {
                    setResetCursorModalOpen(false);
                    setResettingSubscription(null);
                }}
                footer={[
                    <Button
                        key="back"
                        onClick={() => {
                            setResetCursorModalOpen(false);
                            setResettingSubscription(null);
                        }}
                    >
                        取消
                    </Button>,
                    <Button
                        key="submit"
                        type="primary"
                        loading={resettingInProgress}
                        onClick={() => void executeResetCursor()}
                        disabled={resetPosition === 'timestamp' && !resetTimestamp}
                    >
                        确认重置
                    </Button>,
                ]}
            >
                <Form layout="vertical">
                    <Form.Item label="重置位置">
                        <Select
                            value={resetPosition}
                            onChange={value => setResetPosition(value as 'earliest' | 'latest' | 'timestamp')}
                            style={{width: '100%'}}
                        >
                            <Select.Option value="earliest">最早位置</Select.Option>
                            <Select.Option value="latest">最新位置</Select.Option>
                            <Select.Option value="timestamp">指定时间戳</Select.Option>
                        </Select>
                    </Form.Item>
                    {resetPosition === 'timestamp' && (
                        <Form.Item label="时间戳">
                            <DatePicker
                                showTime
                                style={{width: '100%'}}
                                placeholder="选择日期时间"
                                value={resetTimestamp ? dayjs(resetTimestamp) : null}
                                onChange={date => setResetTimestamp(date ? date.valueOf() : null)}
                            />
                        </Form.Item>
                    )}
                    <p className="hint-text" style={{marginTop: 'var(--spacing-sm)'}}>
                        最早位置与指定时间戳会重置游标；本 broker 没有"跳到最新"的游标接口，
                        该选项实现为跳过当前全部积压消息（skip_all），已被跳过的消息不会再次投递。
                    </p>
                </Form>
            </Modal>

            {/* 跳过消息弹窗 */}
            <Modal
                title={`跳过消息 - ${skippingSubscription}`}
                open={skipMessagesModalOpen}
                onCancel={() => {
                    setSkipMessagesModalOpen(false);
                    setSkippingSubscription(null);
                }}
                footer={[
                    <Button
                        key="back"
                        onClick={() => {
                            setSkipMessagesModalOpen(false);
                            setSkippingSubscription(null);
                        }}
                    >
                        取消
                    </Button>,
                    <Button
                        key="submit"
                        type="primary"
                        loading={skippingInProgress}
                        onClick={executeSkipMessages}
                        disabled={skipCount <= 0}
                    >
                        确认跳过
                    </Button>,
                ]}
            >
                <Form layout="vertical">
                    <Form.Item label="跳过消息数量">
                        <InputNumber
                            placeholder="输入要跳过的消息数量"
                            value={skipCount > 0 ? skipCount : null}
                            onChange={value => setSkipCount(typeof value === 'number' ? Math.floor(value) : 0)}
                            min={1}
                            style={{width: '100%'}}
                        />
                    </Form.Item>
                    <p className="hint-text" style={{marginTop: 'var(--spacing-sm)'}}>
                        跳过消息后，积压消息数将减少对应数量。
                    </p>
                </Form>
            </Modal>
        </PageShell>
    );
};

export default TopicDetail;
