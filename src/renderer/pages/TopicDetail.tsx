import React, {useState, useEffect, useCallback, useRef} from 'react';
import {
    Card,
    Tabs,
    Row,
    Col,
    Statistic,
    Tag,
    Button,
    Table,
    Space,
    Spin,
    Alert,
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
    MessageOutlined,
    UserOutlined,
    SettingOutlined,
    BarChartOutlined,
    EditOutlined,
    DeleteOutlined,
    PlusOutlined,
} from '@ant-design/icons';
import type {TopicConfigPatch, TopicStats} from '../types';
import {useTabStore} from '../store/tabs';
import {formatBytes, formatMessageRate, formatThroughput} from '../utils/format';
import {invalidateTopics, invalidateTopicStats} from '../hooks/resourceCache';
import MessageBrowser from './MessageBrowser';
import {useCommand} from '../hooks/useKeybindings';

interface TopicDetailProps {
    clusterId: string;
    tenant: string;
    namespace: string;
    topic: string;
    persistent?: boolean;
}

const TopicDetail: React.FC<TopicDetailProps> = ({clusterId, tenant, namespace, topic, persistent = true}) => {
    const [stats, setStats] = useState<TopicStats | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState('overview');
    const [deleteModalOpen, setDeleteModalOpen] = useState(false);
    const [deletingSubscription, setDeletingSubscription] = useState<string | null>(null);
    const [createModalOpen, setCreateModalOpen] = useState(false);
    const [createForm] = Form.useForm();
    const [resetCursorModalOpen, setResetCursorModalOpen] = useState(false);
    const [resettingSubscription, setResettingSubscription] = useState<string | null>(null);
    const [resetPosition, setResetPosition] = useState<'earliest' | 'latest' | 'timestamp'>('latest');
    const [resetTimestamp, setResetTimestamp] = useState<number | null>(null);
    const [skipMessagesModalOpen, setSkipMessagesModalOpen] = useState(false);
    const [skippingSubscription, setSkippingSubscription] = useState<string | null>(null);
    const [skipCount, setSkipCount] = useState(0);
    const [editConfigModalOpen, setEditConfigModalOpen] = useState(false);
    const [editConfigForm] = Form.useForm();
    const [configLoading, setConfigLoading] = useState(false);

    const {removeTab} = useTabStore();
    const tabId = `topic-${clusterId}-${tenant}-${namespace}-${topic}`;

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
    }, [fetchTopicStats]);

    // 删除订阅
    const handleDeleteSubscription = async (subscriptionName: string) => {
        setDeletingSubscription(subscriptionName);
        try {
            const response = await window.electronAPI.resources.deleteSubscription(
                clusterId,
                tenant,
                namespace,
                topic,
                subscriptionName,
                persistent,
            );
            if (response.success) {
                message.success('订阅删除成功');
                setDeleteModalOpen(false);
                invalidateTopicStats(clusterId, tenant, namespace, topic);
                await fetchTopicStats();
            } else {
                message.error(response.error || '删除失败');
            }
        } catch {
            message.error('删除失败');
        } finally {
            setDeletingSubscription(null);
        }
    };

    // 创建订阅
    const handleCreateSubscription = async () => {
        try {
            const values = await createForm.validateFields();
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
                invalidateTopicStats(clusterId, tenant, namespace, topic);
                await fetchTopicStats();
            } else {
                message.error(response.error || '重置失败');
            }
        } catch {
            message.error('重置失败');
        } finally {
            setResettingSubscription(null);
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
                invalidateTopicStats(clusterId, tenant, namespace, topic);
                await fetchTopicStats();
            } else {
                message.error(response.error || '跳过失败');
            }
        } catch {
            message.error('跳过失败');
        } finally {
            setSkippingSubscription(null);
        }
    };

    // 打开编辑配置弹窗
    const handleOpenEditConfig = async () => {
        setConfigLoading(true);
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
                editConfigForm.setFieldsValue({
                    // 留空 = 不修改。broker 没给出 topic 级覆盖值时不填 0，
                    // 否则保存会把"继承命名空间"误写成"显式设为 0"。
                    retentionTimeInMinutes: config.retentionTimeInMinutes ?? null,
                    retentionSizeInMB: config.retentionSizeInMB ?? null,
                    numPartitions: config.partitions.length > 0 ? config.partitions.length : null,
                });
                setEditConfigModalOpen(true);
            } else {
                message.error(response.error || '获取配置失败');
            }
        } catch {
            message.error('获取配置失败');
        } finally {
            setConfigLoading(false);
        }
    };

    // 保存配置
    const handleSaveConfig = async () => {
        try {
            const values = await editConfigForm.validateFields();
            const patch: TopicConfigPatch = {};

            if (typeof values.retentionTimeInMinutes === 'number') {
                patch.retentionTimeInMinutes = values.retentionTimeInMinutes;
            }
            if (typeof values.retentionSizeInMB === 'number') {
                patch.retentionSizeInMB = values.retentionSizeInMB;
            }
            if (typeof values.numPartitions === 'number') {
                patch.numPartitions = values.numPartitions;
            }

            if (Object.keys(patch).length === 0) {
                message.warning('没有需要修改的配置项');
                return;
            }

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
                setEditConfigModalOpen(false);
                editConfigForm.resetFields();
                // 分区数变化会改变 topic 列表本身，只失效 stats 不够
                invalidateTopics(clusterId, tenant, namespace);
                invalidateTopicStats(clusterId, tenant, namespace, topic);
                await fetchTopicStats();
            } else {
                message.error(response.error || '更新失败');
            }
        } catch (error: any) {
            // 校验失败时 antd 会抛 errorInfo，不应笼统报"更新失败"
            if (error?.errorFields) return;
            message.error(error?.message || '更新失败');
        }
    };

    // 删除Topic
    const handleDeleteTopic = async () => {
        Modal.confirm({
            title: '确认删除 Topic',
            content: (
                <div>
                    <p>
                        确定要删除 Topic <strong>{topic}</strong> 吗？
                    </p>
                    <p style={{color: 'var(--color-danger)', fontSize: 12, marginTop: 8}}>
                        此操作不可恢复，且会删除所有关联的订阅和消息！
                    </p>
                </div>
            ),
            okText: '确认删除',
            okType: 'danger',
            cancelText: '取消',
            async onOk() {
                try {
                    const response = await window.electronAPI.resources.deleteTopic(
                        clusterId,
                        tenant,
                        namespace,
                        topic,
                        persistent,
                    );
                    if (response.success) {
                        message.success('Topic 删除成功');
                        // Topic 已不存在，列表缓存必须失效，否则资源树仍显示它
                        invalidateTopics(clusterId, tenant, namespace);
                        invalidateTopicStats(clusterId, tenant, namespace, topic);
                        // 关闭当前 tab
                        removeTab(tabId);
                    } else {
                        message.error(response.error || '删除失败');
                    }
                } catch {
                    message.error('删除失败');
                }
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
            render: (value: number) => <Tag color={value > 0 ? 'warning' : 'success'}>{value.toLocaleString()}</Tag>,
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
            render: (value: string) => <Tag>{value}</Tag>,
        },
        {
            title: '操作',
            key: 'action',
            render: (_: any, record: SubscriptionTableItem) => (
                <Space>
                    <Button type="link" size="small" onClick={() => handleResetCursor(record.name)}>
                        重置游标
                    </Button>
                    <Button type="link" size="small" onClick={() => handleSkipMessages(record.name)}>
                        跳过消息
                    </Button>
                    <Button
                        type="link"
                        size="small"
                        danger
                        onClick={() => {
                            setDeletingSubscription(record.name);
                            setDeleteModalOpen(true);
                        }}
                    >
                        删除
                    </Button>
                </Space>
            ),
        },
    ];

    // 生产者表格列
    const producerColumns = [
        {
            title: '生产者名称',
            dataIndex: 'producerName',
            key: 'producerName',
        },
        {
            title: '状态',
            dataIndex: 'connected',
            key: 'connected',
            render: (value: boolean) => <Tag color={value ? 'success' : 'error'}>{value ? '在线' : '离线'}</Tag>,
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
        },
        {
            title: '所属订阅',
            dataIndex: 'subscription',
            key: 'subscription',
        },
        {
            title: '状态',
            dataIndex: 'connected',
            key: 'connected',
            render: (value: boolean) => <Tag color={value ? 'success' : 'error'}>{value ? '在线' : '离线'}</Tag>,
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
        msgRateExpired: number;
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
                  msgRateExpired: sub.msgRateExpired || 0,
                  consumerCount: sub.consumerCount || 0,
                  type: sub.type || 'exclusive',
              }))
            : [];

    return (
        <div style={{height: '100%', display: 'flex', flexDirection: 'column'}}>
            {/* 顶部指标卡片 */}
            <Card style={{margin: 'var(--spacing-md)', marginBottom: 0}}>
                <Row gutter={16}>
                    <Col span={6}>
                        <Statistic
                            title="消息输入速率"
                            value={stats?.msgRateIn || 0}
                            prefix={<BarChartOutlined />}
                            suffix=" msg/s"
                            valueStyle={{color: 'var(--color-primary)'}}
                        />
                    </Col>
                    <Col span={6}>
                        <Statistic
                            title="消息输出速率"
                            value={stats?.msgRateOut || 0}
                            prefix={<MessageOutlined />}
                            suffix=" msg/s"
                            valueStyle={{color: 'var(--color-success)'}}
                        />
                    </Col>
                    <Col span={6}>
                        <Statistic
                            title="总积压"
                            value={stats?.backlogSize || 0}
                            prefix={<DatabaseOutlined />}
                            valueStyle={{
                                color:
                                    stats?.backlogSize && stats.backlogSize > 0
                                        ? 'var(--color-warning)'
                                        : 'var(--color-text-primary)',
                            }}
                        />
                    </Col>
                    <Col span={6}>
                        <Statistic
                            title="消费者数"
                            value={stats?.consumers?.length || 0}
                            prefix={<UserOutlined />}
                            valueStyle={{color: 'var(--color-info)'}}
                        />
                    </Col>
                </Row>
            </Card>

            {/* Tab内容区域 */}
            <div style={{flex: 1, margin: 'var(--spacing-md)', overflow: 'hidden'}}>
                <Tabs
                    activeKey={activeTab}
                    onChange={setActiveTab}
                    items={[
                        {
                            key: 'overview',
                            label: '概览',
                            icon: <BarChartOutlined />,
                            children: (
                                <Spin spinning={loading}>
                                    {error ? (
                                        <Alert message="获取数据失败" description={error} type="error" showIcon />
                                    ) : stats ? (
                                        <div>
                                            <Card title="存储信息" style={{marginBottom: 'var(--spacing-md)'}}>
                                                <Row gutter={16}>
                                                    <Col span={8}>
                                                        <div>
                                                            <span style={{color: 'var(--color-text-secondary)'}}>
                                                                总存储大小
                                                            </span>
                                                            <p style={{fontSize: 24, fontWeight: 600}}>
                                                                {formatBytes(stats.storageSize)}
                                                            </p>
                                                        </div>
                                                    </Col>
                                                    <Col span={8}>
                                                        <div>
                                                            <span style={{color: 'var(--color-text-secondary)'}}>
                                                                积压大小
                                                            </span>
                                                            <p style={{fontSize: 24, fontWeight: 600}}>
                                                                {formatBytes(stats.backlogSize)}
                                                            </p>
                                                        </div>
                                                    </Col>
                                                    <Col span={8}>
                                                        <div>
                                                            <span style={{color: 'var(--color-text-secondary)'}}>
                                                                消息输入速率
                                                            </span>
                                                            <p style={{fontSize: 24, fontWeight: 600}}>
                                                                {formatMessageRate(stats.msgRateIn)}
                                                            </p>
                                                        </div>
                                                    </Col>
                                                </Row>
                                            </Card>

                                            <Card
                                                title={`生产者 (${stats.producers?.length || 0})`}
                                                style={{marginBottom: 'var(--spacing-md)'}}
                                            >
                                                {stats.producers && stats.producers.length > 0 ? (
                                                    <Table
                                                        dataSource={stats.producers}
                                                        columns={producerColumns}
                                                        rowKey={record =>
                                                            `${record.producerName}-${record.address ?? ''}`
                                                        }
                                                        pagination={false}
                                                        size="small"
                                                        scroll={{x: 'max-content'}}
                                                    />
                                                ) : (
                                                    <div
                                                        style={{
                                                            textAlign: 'center',
                                                            padding: '20px 0',
                                                            color: 'var(--color-text-secondary)',
                                                        }}
                                                    >
                                                        暂无生产者
                                                    </div>
                                                )}
                                            </Card>

                                            <Card title={`消费者 (${stats.consumers?.length || 0})`}>
                                                {stats.consumers && stats.consumers.length > 0 ? (
                                                    <Table
                                                        dataSource={stats.consumers}
                                                        columns={consumerColumns}
                                                        rowKey={record =>
                                                            `${record.subscription}-${record.consumerName}`
                                                        }
                                                        pagination={false}
                                                        size="small"
                                                        scroll={{x: 'max-content'}}
                                                    />
                                                ) : (
                                                    <div
                                                        style={{
                                                            textAlign: 'center',
                                                            padding: '20px 0',
                                                            color: 'var(--color-text-secondary)',
                                                        }}
                                                    >
                                                        暂无消费者
                                                    </div>
                                                )}
                                            </Card>
                                        </div>
                                    ) : (
                                        <div style={{textAlign: 'center', padding: '40px 0'}}>加载中...</div>
                                    )}
                                </Spin>
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
                                        <div
                                            style={{
                                                textAlign: 'center',
                                                padding: '40px 0',
                                                color: 'var(--color-text-secondary)',
                                            }}
                                        >
                                            暂无订阅
                                        </div>
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
                                />
                            ),
                        },
                        {
                            key: 'config',
                            label: '配置',
                            icon: <SettingOutlined />,
                            children: (
                                <Card title="Topic 配置">
                                    <div style={{padding: '20px'}}>
                                        <div style={{marginBottom: 'var(--spacing-md)'}}>
                                            <span style={{fontWeight: 500}}>Topic 名称:</span>
                                            <code style={{marginLeft: 8}}>{topicUri}</code>
                                        </div>
                                        <div style={{marginBottom: 'var(--spacing-md)'}}>
                                            <span style={{fontWeight: 500}}>分区数:</span>
                                            <span style={{marginLeft: 8}}>{stats?.partitions?.length || 0}</span>
                                        </div>
                                        <div style={{marginBottom: 'var(--spacing-md)'}}>
                                            <span style={{fontWeight: 500}}>是否持久化:</span>
                                            <span style={{marginLeft: 8}}>{persistent ? '是' : '否'}</span>
                                        </div>
                                        <Space style={{marginTop: 'var(--spacing-md)'}}>
                                            <Button
                                                icon={<EditOutlined />}
                                                loading={configLoading}
                                                onClick={handleOpenEditConfig}
                                            >
                                                编辑配置
                                            </Button>
                                            <Button icon={<DeleteOutlined />} danger onClick={handleDeleteTopic}>
                                                删除 Topic
                                            </Button>
                                        </Space>
                                    </div>
                                </Card>
                            ),
                        },
                    ]}
                    style={{height: '100%'}}
                />
            </div>

            {/* 删除订阅确认弹窗 */}
            <Modal
                title="确认删除"
                open={deleteModalOpen}
                onCancel={() => {
                    setDeleteModalOpen(false);
                    setDeletingSubscription(null);
                }}
                footer={[
                    <Button
                        key="back"
                        onClick={() => {
                            setDeleteModalOpen(false);
                            setDeletingSubscription(null);
                        }}
                    >
                        取消
                    </Button>,
                    <Button
                        key="submit"
                        type="primary"
                        danger
                        loading={!!deletingSubscription}
                        onClick={() => deletingSubscription && handleDeleteSubscription(deletingSubscription)}
                    >
                        确认删除
                    </Button>,
                ]}
            >
                <p>
                    确定要删除订阅 <strong>{deletingSubscription}</strong> 吗？
                </p>
                <p style={{color: 'var(--color-danger)', fontSize: 12, marginTop: 8}}>此操作不可恢复，请谨慎操作。</p>
            </Modal>

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
                    <Button key="submit" type="primary" onClick={handleCreateSubscription}>
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
                    <Button key="submit" type="primary" onClick={executeResetCursor}>
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
                    <p style={{color: 'var(--color-text-secondary)', fontSize: 12, marginTop: 8}}>
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
                    <Button key="submit" type="primary" onClick={executeSkipMessages} disabled={skipCount <= 0}>
                        确认跳过
                    </Button>,
                ]}
            >
                <Form layout="vertical">
                    <Form.Item label="跳过消息数量">
                        <Input
                            type="number"
                            placeholder="输入要跳过的消息数量"
                            value={skipCount}
                            onChange={e => setSkipCount(e.target.value ? parseInt(e.target.value, 10) : 0)}
                            min={1}
                        />
                    </Form.Item>
                    <p style={{color: 'var(--color-text-secondary)', fontSize: 12, marginTop: 8}}>
                        跳过消息后，积压消息数将减少对应数量。
                    </p>
                </Form>
            </Modal>

            {/* 编辑配置弹窗 */}
            <Modal
                title="编辑 Topic 配置"
                open={editConfigModalOpen}
                onCancel={() => {
                    setEditConfigModalOpen(false);
                    editConfigForm.resetFields();
                }}
                footer={[
                    <Button
                        key="back"
                        onClick={() => {
                            setEditConfigModalOpen(false);
                            editConfigForm.resetFields();
                        }}
                    >
                        取消
                    </Button>,
                    <Button key="submit" type="primary" onClick={handleSaveConfig}>
                        保存配置
                    </Button>,
                ]}
                width={600}
            >
                <Form form={editConfigForm} layout="vertical">
                    <Form.Item
                        name="retentionTimeInMinutes"
                        label="保留时间（分钟）"
                        extra="0 表示永不按时间删除；留空表示不修改"
                    >
                        <InputNumber min={0} max={525600} style={{width: '100%'}} placeholder="不修改" />
                    </Form.Item>
                    <Form.Item name="retentionSizeInMB" label="保留大小（MB）" extra="0 表示不限制容量；留空表示不修改">
                        <InputNumber min={0} max={1048576} style={{width: '100%'}} placeholder="不修改" />
                    </Form.Item>
                    <Form.Item
                        name="numPartitions"
                        label="分区数"
                        extra="仅分区 topic 可调整；给非分区 topic 设置大于 0 的分区数会把它变成分区 topic"
                    >
                        <InputNumber min={0} max={1000} precision={0} style={{width: '100%'}} placeholder="不修改" />
                    </Form.Item>

                    {/* 生效值只读展示：这些策略本 broker 没有 topic 级写入口 */}
                    <div
                        style={{
                            padding: 'var(--spacing-sm) var(--spacing-md)',
                            background: 'var(--color-bg-secondary)',
                            borderRadius: 6,
                            fontSize: 12,
                            lineHeight: 1.9,
                        }}
                    >
                        <div>
                            生效积压配额：{formatBytes(stats?.backlogQuotaLimitSize ?? 0)} /
                            {` ${(stats?.backlogQuotaLimitTime ?? 0) / 60000} 分钟`}
                        </div>
                        <div>去重状态：{stats?.deduplicationStatus || '未知'}</div>
                        <div>归属 Broker：{stats?.ownerBrokers?.length ? stats.ownerBrokers.join('、') : '未知'}</div>
                    </div>

                    <p style={{color: 'var(--color-text-secondary)', fontSize: 12, marginTop: 8}}>
                        最大消息大小、积压配额、TTL、生产/消费者上限等策略在本 broker 上只有命名空间级别的写入口， 在
                        topic 级别修改不会生效，因此这里不提供输入框。
                    </p>
                </Form>
            </Modal>
        </div>
    );
};

export default TopicDetail;
