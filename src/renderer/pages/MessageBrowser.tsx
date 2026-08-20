import React, {useState, useEffect, useCallback, useRef} from 'react';
import {
    Card,
    Table,
    Button,
    Input,
    Select,
    Space,
    message,
    Spin,
    Alert,
    Modal,
    Tooltip,
    Tag,
    Empty,
    Dropdown,
} from 'antd';
import {
    UpOutlined,
    DownOutlined,
    ZoomInOutlined,
    ReloadOutlined,
    PauseCircleOutlined,
    PlayCircleOutlined,
    DownloadOutlined,
    SendOutlined,
} from '@ant-design/icons';
import type {Message} from '../types';
import dayjs from 'dayjs';
import {downloadBlob} from '../utils/download';

const {TextArea} = Input;

interface MessageBrowserProps {
    clusterId: string;
    tenant: string;
    namespace: string;
    topic: string;
}

const MessageBrowser: React.FC<MessageBrowserProps> = ({clusterId, tenant, namespace, topic}) => {
    const mountedRef = useRef(true);
    const messagesRequestRef = useRef(0);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const [messages, setMessages] = useState<Message[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [subscription, setSubscription] = useState('');
    const [subscriptions, setSubscriptions] = useState<string[]>([]);
    const [count, setCount] = useState(10);
    const [isStreaming, setIsStreaming] = useState(false);
    const [expandedMessages, setExpandedMessages] = useState<string[]>([]);
    const [showFullMessage, setShowFullMessage] = useState<Message | null>(null);
    const [sendMessage, setSendMessage] = useState('');
    const [sendLoading, setSendLoading] = useState(false);
    const [exportLoading, setExportLoading] = useState(false);
    const [hasLoaded, setHasLoaded] = useState(false);

    const TRUNCATE_LENGTH = 50;
    const MAX_DISPLAY_COUNT = 500;

    // 获取订阅列表
    const fetchSubscriptions = useCallback(async () => {
        try {
            const response = await window.electronAPI.resources.getSubscriptions(clusterId, tenant, namespace, topic);
            if (response.success && response.data) {
                setSubscriptions(response.data);
                if (response.data.length > 0 && !subscription) {
                    setSubscription(response.data[0]);
                }
            }
        } catch (error) {
            console.error('Failed to fetch subscriptions:', error);
        }
    }, [clusterId, tenant, namespace, topic, subscription]);

    // 获取消息
    const fetchMessages = useCallback(async () => {
        if (!subscription) {
            return;
        }

        // 3 秒轮询下单次 peek 可能超过一个周期，请求会叠加。用自增请求号确保
        // 只有最后一次发起的请求能写回 state，避免乱序响应让列表回退。
        const requestId = ++messagesRequestRef.current;
        const isCurrent = () => mountedRef.current && messagesRequestRef.current === requestId;

        setLoading(true);
        setError(null);
        try {
            const response = await window.electronAPI.messages.browse({
                clusterId,
                tenant,
                namespace,
                topic,
                subscription,
                count: Math.min(count, MAX_DISPLAY_COUNT),
            });
            if (!isCurrent()) {
                return;
            }
            if (response.success && response.data) {
                setMessages(response.data.slice(0, MAX_DISPLAY_COUNT));
                setHasLoaded(true);
            } else {
                setError(response.error || 'Failed to fetch messages');
            }
        } catch (error) {
            if (isCurrent()) {
                setError(String(error));
            }
        } finally {
            if (isCurrent()) {
                setLoading(false);
            }
        }
    }, [clusterId, tenant, namespace, topic, subscription, count]);

    // 发送消息
    const handleSendMessage = async () => {
        if (!sendMessage.trim()) return;

        setSendLoading(true);
        try {
            const response = await window.electronAPI.messages.send({
                clusterId,
                tenant,
                namespace,
                topic,
                message: sendMessage,
            });
            if (response.success) {
                message.success('消息发送成功');
                setSendMessage('');
            } else {
                message.error(response.error || '发送失败');
            }
        } catch {
            message.error('发送失败');
        } finally {
            setSendLoading(false);
        }
    };

    // 导出消息
    const handleExportMessages = async (format: 'json' | 'csv' = 'json') => {
        if (messages.length === 0) {
            message.warning('暂无消息可导出');
            return;
        }

        setExportLoading(true);
        try {
            let content: string;
            let mimeType: string;
            let extension: string;

            if (format === 'json') {
                const exportData = messages.map(msg => ({
                    messageId: msg.messageId,
                    producerName: msg.producerName,
                    publishTime: dayjs(msg.publishTime).format('YYYY-MM-DD HH:mm:ss.SSS'),
                    properties: msg.properties,
                    data: formatMessageData(msg.data),
                }));
                content = JSON.stringify(exportData, null, 2);
                mimeType = 'application/json';
                extension = 'json';
            } else {
                // CSV 格式
                const headers = ['messageId', 'publishTime', 'producerName', 'properties', 'data'];
                const rows = messages.map(msg => [
                    msg.messageId,
                    dayjs(msg.publishTime).format('YYYY-MM-DD HH:mm:ss.SSS'),
                    msg.producerName,
                    `"${JSON.stringify(msg.properties).replace(/"/g, '""')}"`,
                    `"${formatMessageData(msg.data).replace(/"/g, '""')}"`,
                ]);
                content = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
                mimeType = 'text/csv';
                extension = 'csv';
            }

            downloadBlob(content, `messages_${topic}_${dayjs().format('YYYYMMDD_HHmmss')}.${extension}`, mimeType);

            message.success(`成功导出 ${messages.length} 条消息 (${extension.toUpperCase()})`);
        } catch (error) {
            console.error('Failed to export messages:', error);
            message.error('导出失败');
        } finally {
            setExportLoading(false);
        }
    };

    // 切换消息展开状态
    const toggleExpand = useCallback((messageId: string) => {
        setExpandedMessages(prev => {
            if (prev.includes(messageId)) {
                return prev.filter(id => id !== messageId);
            } else {
                return [...prev, messageId];
            }
        });
    }, []);

    // 格式化消息数据
    const formatMessageData = (data: string): string => {
        try {
            // 尝试解码 base64
            const decoded = atob(data);
            // 尝试解析为 JSON
            const parsed = JSON.parse(decoded);
            return JSON.stringify(parsed, null, 2);
        } catch {
            try {
                // 直接尝试解析为 JSON
                const parsed = JSON.parse(data);
                return JSON.stringify(parsed, null, 2);
            } catch {
                // 返回原始数据
                return data;
            }
        }
    };

    // 截断消息内容
    const truncateMessage = (content: string, maxLength: number = TRUNCATE_LENGTH): string => {
        if (content.length <= maxLength) return content;
        return content.substring(0, maxLength) + '...';
    };

    // 初始化
    useEffect(() => {
        fetchSubscriptions();
    }, [fetchSubscriptions]);

    // 自动刷新
    useEffect(() => {
        if (!isStreaming) return;

        const interval = setInterval(() => {
            fetchMessages();
        }, 3000);

        return () => clearInterval(interval);
    }, [isStreaming, fetchMessages]);

    // 表格列定义
    const columns = [
        {
            title: 'Message ID',
            dataIndex: 'messageId',
            key: 'messageId',
            width: 180,
            render: (text: string) => <code style={{fontSize: 11, color: 'var(--color-text-secondary)'}}>{text}</code>,
        },
        {
            title: 'Producer',
            dataIndex: 'producerName',
            key: 'producerName',
            width: 120,
        },
        {
            title: 'Publish Time',
            dataIndex: 'publishTime',
            key: 'publishTime',
            width: 150,
            render: (timestamp: number) => (
                <span title={dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss.SSS')}>
                    {dayjs(timestamp).format('MM-DD HH:mm:ss')}
                </span>
            ),
        },
        {
            title: 'Properties',
            dataIndex: 'properties',
            key: 'properties',
            width: 150,
            render: (props: Record<string, string>) => {
                const keys = Object.keys(props);
                if (keys.length === 0) return '-';
                return (
                    <Tooltip title={keys.map(k => `${k}: ${props[k]}`).join('\n')}>
                        <Tag color="blue">{keys.length} 个属性</Tag>
                    </Tooltip>
                );
            },
        },
        {
            title: 'Data',
            dataIndex: 'data',
            key: 'data',
            flex: 1,
            render: (data: string, record: Message) => {
                const formatted = formatMessageData(data);
                const isExpanded = expandedMessages.includes(record.messageId);
                const displayContent = isExpanded ? formatted : truncateMessage(formatted);

                return (
                    <div>
                        <div
                            style={{
                                maxHeight: isExpanded ? '200px' : 'auto',
                                overflow: 'auto',
                                fontFamily: 'monospace',
                                fontSize: 12,
                                wordBreak: 'break-all',
                                color: 'var(--color-text-secondary)',
                            }}
                        >
                            {displayContent}
                        </div>
                        {formatted.length > TRUNCATE_LENGTH && (
                            <Button
                                type="text"
                                size="small"
                                icon={isExpanded ? <UpOutlined /> : <DownOutlined />}
                                onClick={() => toggleExpand(record.messageId)}
                                style={{marginTop: 4}}
                            >
                                {isExpanded ? '收起' : `展开全文 (${formatted.length} 字符)`}
                            </Button>
                        )}
                        <Button
                            type="text"
                            size="small"
                            icon={<ZoomInOutlined />}
                            onClick={() => setShowFullMessage(record)}
                            style={{marginTop: 4, marginLeft: 8}}
                        >
                            全屏查看
                        </Button>
                    </div>
                );
            },
        },
    ];

    return (
        <div style={{padding: 'var(--spacing-lg)', height: '100%', display: 'flex', flexDirection: 'column'}}>
            {/* 工具栏 */}
            <Card style={{marginBottom: 'var(--spacing-md)'}}>
                <Space wrap size="middle">
                    {/* 订阅选择 */}
                    <div>
                        <label style={{marginRight: 8, fontSize: 13, fontWeight: 500}}>订阅:</label>
                        <Select
                            value={subscription}
                            onChange={setSubscription}
                            style={{width: 200}}
                            placeholder="选择订阅"
                            options={subscriptions.map(s => ({value: s, label: s}))}
                        />
                    </div>

                    {/* 消息数量 */}
                    <div>
                        <label style={{marginRight: 8, fontSize: 13, fontWeight: 500}}>数量:</label>
                        <Select
                            value={count}
                            onChange={setCount}
                            style={{width: 100}}
                            options={[
                                {value: 10, label: '10'},
                                {value: 50, label: '50'},
                                {value: 100, label: '100'},
                                {value: 500, label: '500'},
                            ]}
                        />
                    </div>

                    {/* 操作按钮 */}
                    <Button icon={<ReloadOutlined spin={loading} />} onClick={fetchMessages} loading={loading}>
                        刷新
                    </Button>

                    <Button
                        icon={isStreaming ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                        onClick={() => setIsStreaming(!isStreaming)}
                        type={isStreaming ? 'primary' : 'default'}
                    >
                        {isStreaming ? '停止监听' : '开始监听'}
                    </Button>

                    <Dropdown.Button
                        icon={<DownOutlined />}
                        onClick={() => handleExportMessages('json')}
                        menu={{
                            items: [
                                {key: 'json', label: '导出 JSON'},
                                {key: 'csv', label: '导出 CSV'},
                            ],
                            onClick: ({key}) => handleExportMessages(key as 'json' | 'csv'),
                        }}
                        loading={exportLoading}
                        disabled={messages.length === 0}
                    >
                        <DownloadOutlined /> 导出
                    </Dropdown.Button>
                </Space>
            </Card>

            {/* 错误提示 */}
            {error && (
                <Alert
                    message="获取消息失败"
                    description={error}
                    type="error"
                    showIcon
                    closable
                    style={{marginBottom: 'var(--spacing-md)'}}
                />
            )}

            {/* 消息列表 */}
            <Card
                title={`消息列表 - ${messages.length} 条`}
                style={{flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column'}}
            >
                <div style={{flex: 1, overflow: 'auto'}}>
                    <Spin spinning={loading}>
                        {messages.length === 0 ? (
                            <div style={{textAlign: 'center', padding: '40px 0'}}>
                                {hasLoaded ? (
                                    <Empty description="该订阅下暂无消息" />
                                ) : (
                                    <Empty description="选择订阅后点击刷新加载消息" />
                                )}
                            </div>
                        ) : (
                            <Table
                                dataSource={messages}
                                columns={columns}
                                rowKey="messageId"
                                pagination={false}
                                scroll={{y: 'calc(100vh - 400px)'}}
                                size="small"
                            />
                        )}
                    </Spin>
                </div>
            </Card>

            {/* 发送消息区域 */}
            <Card title="发送消息" style={{marginTop: 'var(--spacing-md)'}}>
                <Space direction="vertical" style={{width: '100%'}}>
                    <TextArea
                        value={sendMessage}
                        onChange={e => setSendMessage(e.target.value)}
                        placeholder="输入消息内容..."
                        rows={3}
                        style={{width: '100%'}}
                    />
                    <div style={{textAlign: 'right'}}>
                        <Button
                            type="primary"
                            icon={<SendOutlined />}
                            onClick={handleSendMessage}
                            loading={sendLoading}
                            disabled={!sendMessage.trim()}
                        >
                            发送消息
                        </Button>
                    </div>
                </Space>
            </Card>

            {/* 全屏消息查看弹窗 */}
            <Modal
                title="消息详情"
                open={showFullMessage !== null}
                onCancel={() => setShowFullMessage(null)}
                width={800}
                footer={null}
            >
                {showFullMessage && (
                    <div>
                        <div style={{marginBottom: 16}}>
                            <label style={{fontWeight: 500}}>Message ID:</label>
                            <code style={{marginLeft: 8, fontSize: 12}}>{showFullMessage.messageId}</code>
                        </div>
                        <div style={{marginBottom: 16}}>
                            <label style={{fontWeight: 500}}>Producer:</label>
                            <span style={{marginLeft: 8}}>{showFullMessage.producerName}</span>
                        </div>
                        <div style={{marginBottom: 16}}>
                            <label style={{fontWeight: 500}}>Publish Time:</label>
                            <span style={{marginLeft: 8}}>
                                {dayjs(showFullMessage.publishTime).format('YYYY-MM-DD HH:mm:ss.SSS')}
                            </span>
                        </div>
                        <div style={{marginBottom: 16}}>
                            <label style={{fontWeight: 500}}>Properties:</label>
                            <pre style={{marginLeft: 8, fontSize: 12, maxHeight: 100, overflow: 'auto'}}>
                                {JSON.stringify(showFullMessage.properties, null, 2)}
                            </pre>
                        </div>
                        <div>
                            <label style={{fontWeight: 500}}>Data:</label>
                            <pre
                                style={{
                                    marginLeft: 8,
                                    fontSize: 12,
                                    maxHeight: 400,
                                    overflow: 'auto',
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-all',
                                }}
                            >
                                {formatMessageData(showFullMessage.data)}
                            </pre>
                        </div>
                    </div>
                )}
            </Modal>
        </div>
    );
};

export default MessageBrowser;
