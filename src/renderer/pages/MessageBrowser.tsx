import React, {useState, useEffect, useCallback, useMemo, useRef} from 'react';
import {
    Card,
    Table,
    Button,
    Input,
    Select,
    AutoComplete,
    Space,
    message,
    Modal,
    Tooltip,
    Tag,
    Dropdown,
    Segmented,
    Switch,
    InputNumber,
    DatePicker,
} from 'antd';
import {
    UpOutlined,
    DownOutlined,
    ZoomInOutlined,
    PauseCircleOutlined,
    PlayCircleOutlined,
    DownloadOutlined,
    SendOutlined,
    ReloadOutlined,
} from '@ant-design/icons';
import type {Message, MessageBatch, SessionEndEvent} from '../types';
import {formatBytes} from '../utils/format';
import dayjs from 'dayjs';
import {downloadBlob} from '../utils/download';
import {useCommand} from '../hooks/useKeybindings';
import {useSettingsStore} from '../store/settings';
import StateBlock from '../components/common/StateBlock';
import ErrorBanner from '../components/common/ErrorBanner';

const {TextArea} = Input;

type StreamMode = 'consume' | 'read';
type PanelMode = 'send' | StreamMode;

interface MessageBrowserProps {
    clusterId: string;
    tenant: string;
    namespace: string;
    topic: string;
    persistent?: boolean;
    // 外层 Topic 页签里当前选中的是不是「消息浏览器」这个内嵌页签。
    // antd 切走的页签只是 display:none，会话不会自己停，切到概览后还在后台持续收消息。
    active?: boolean;
}

// 主进程传来的 data 是 base64（原生载荷可能是任意二进制）。
// 直接展示 base64 等于没展示内容，所以先解回文本；解出控制字符说明是二进制，保留 base64。
const asText = (base64: string): string | null => {
    let decoded: string;
    try {
        const binary = atob(base64);
        decoded = new TextDecoder().decode(Uint8Array.from(binary, ch => ch.charCodeAt(0)));
    } catch {
        return null;
    }
    for (let index = 0; index < decoded.length; index += 1) {
        const code = decoded.charCodeAt(index);
        const isControl = code < 32 && code !== 9 && code !== 10 && code !== 13;
        if (isControl || code === 0xfffd) {
            return null;
        }
    }
    return decoded;
};

const formatMessageData = (data: string): string => {
    const text = asText(data) ?? data;
    try {
        return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
        return text;
    }
};

interface ActiveSession {
    sessionId: string;
    mode: StreamMode;
}

const MAX_DISPLAY_COUNT = 500;

const MessageBrowser: React.FC<MessageBrowserProps> = ({
    clusterId,
    tenant,
    namespace,
    topic,
    persistent = true,
    active = true,
}) => {
    // 正文截断长度是配置中心里的应用设置，改完立刻对所有消息浏览器生效
    const truncateLength = useSettingsStore(state => state.settings.truncateLength);
    const [mode, setMode] = useState<PanelMode>('send');
    const [messages, setMessages] = useState<Message[]>([]);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [subscriptions, setSubscriptions] = useState<string[]>([]);
    const [subscription, setSubscription] = useState('');

    const [sendText, setSendText] = useState('');
    const [sendProperties, setSendProperties] = useState('');
    const [sendLoading, setSendLoading] = useState(false);
    const [lastMessageId, setLastMessageId] = useState<string | null>(null);

    const [subscriptionType, setSubscriptionType] = useState<'Exclusive' | 'Shared' | 'Failover' | 'Key_Shared'>(
        'Shared',
    );
    const [initialPosition, setInitialPosition] = useState<'Latest' | 'Earliest'>('Earliest');
    const [autoAck, setAutoAck] = useState(true);
    const [consumeMax, setConsumeMax] = useState(0);

    const [readFrom, setReadFrom] = useState<'earliest' | 'latest' | 'timestamp'>('earliest');
    const [readTimestamp, setReadTimestamp] = useState<dayjs.Dayjs | null>(null);
    const [readMax, setReadMax] = useState(20);

    const [backlog, setBacklog] = useState<{messageCount: number; sizeInBytes: number} | null>(null);
    const [backlogLoading, setBacklogLoading] = useState(false);
    const [expandedMessages, setExpandedMessages] = useState<string[]>([]);
    const [showFullMessage, setShowFullMessage] = useState<Message | null>(null);
    const [exportLoading, setExportLoading] = useState(false);

    // 会话 id 同时放 ref：推送回调与卸载清理都要读最新值，
    // 放 state 会让 effect 依赖来回变化，反而漏停或重复停。
    const sessionRef = useRef<ActiveSession | null>(null);

    const stopActiveSession = useCallback(async (notify: boolean) => {
        const session = sessionRef.current;
        if (!session) {
            return;
        }
        // 先摘掉引用：在途的批次会因为 id 对不上被丢弃，重复点击也不会重复停止
        sessionRef.current = null;
        setSessionId(null);
        const stop =
            session.mode === 'consume' ? window.electronAPI.messages.stopConsume : window.electronAPI.messages.stopRead;
        try {
            const response = await stop(session.sessionId);
            if (notify && !response.success) {
                message.warning(response.error || '停止会话失败');
            }
        } catch (stopError) {
            if (notify) {
                message.error('停止会话失败');
            }
            console.error('Failed to stop session:', stopError);
        }
    }, []);

    // 切换模式或换 topic 都会让旧会话失去意义：先停，且不打扰用户
    useEffect(() => {
        void stopActiveSession(false);
        setMessages([]);
        setError(null);
    }, [mode, clusterId, tenant, namespace, topic, persistent, stopActiveSession]);

    // 切到别的内嵌页签（概览/订阅/配置）就把会话停掉：页签是 display:none 不是卸载，
    // 不停的话它会一直在后台消费并把消息堆进这个看不见的列表。
    useEffect(() => {
        if (!active) {
            void stopActiveSession(false);
        }
    }, [active, stopActiveSession]);

    // 组件卸载（关标签页）时主进程侧的 consumer/reader 必须一起关掉，
    // 否则它会一直占着订阅，下次开始消费会被"该订阅已有会话"拒绝。
    useEffect(
        () => () => {
            void stopActiveSession(false);
        },
        [stopActiveSession],
    );

    const appendBatch = useCallback((batch: MessageBatch) => {
        setMessages(prev => [...batch.messages, ...prev].slice(0, MAX_DISPLAY_COUNT));
    }, []);

    useEffect(() => {
        const isMine = (id: string) => sessionRef.current?.sessionId === id;

        const offConsume = window.electronAPI.messages.onConsumeBatch(batch => {
            if (isMine(batch.sessionId)) {
                appendBatch(batch);
            }
        });
        const offRead = window.electronAPI.messages.onReadBatch(batch => {
            if (isMine(batch.sessionId)) {
                appendBatch(batch);
            }
        });
        // 收满上限或循环出错时会话会自己结束，不接这个事件界面就会一直显示"运行中"
        const offEnd = window.electronAPI.messages.onSessionEnd((event: SessionEndEvent) => {
            if (!isMine(event.sessionId)) {
                return;
            }
            sessionRef.current = null;
            setSessionId(null);
            if (event.reason === 'error') {
                setError(event.detail || '会话异常终止');
            } else if (event.reason === 'completed') {
                message.info('已达到消息数量上限，会话结束');
            }
        });

        return () => {
            offConsume();
            offRead();
            offEnd();
        };
    }, [appendBatch]);

    const fetchSubscriptions = useCallback(async () => {
        try {
            const response = await window.electronAPI.resources.getSubscriptions(
                clusterId,
                tenant,
                namespace,
                topic,
                persistent,
            );
            if (response.success && response.data) {
                setSubscriptions(response.data);
                setSubscription(current => current || response.data?.[0] || '');
            } else if (!response.success) {
                // 订阅列表拉不到会让"订阅消费"直接没法用（下拉里一个名字都没有），
                // 只写 console 用户只会看到"点开始没反应"。
                setError(response.error || '获取订阅列表失败');
            }
        } catch (fetchError) {
            console.error('Failed to fetch subscriptions:', fetchError);
            setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
        }
    }, [clusterId, tenant, namespace, topic, persistent]);

    useEffect(() => {
        void fetchSubscriptions();
    }, [fetchSubscriptions]);

    const refreshBacklog = useCallback(async () => {
        if (!subscription) {
            setBacklog(null);
            return;
        }
        setBacklogLoading(true);
        try {
            const response = await window.electronAPI.messages.getBacklog({
                clusterId,
                tenant,
                namespace,
                topic,
                persistent,
                subscription,
            });
            if (response.success && response.data) {
                setBacklog(response.data);
            } else {
                setBacklog(null);
                setError(response.error || '获取积压失败');
            }
        } catch (backlogError) {
            setBacklog(null);
            setError(backlogError instanceof Error ? backlogError.message : String(backlogError));
        } finally {
            setBacklogLoading(false);
        }
    }, [clusterId, tenant, namespace, topic, persistent, subscription]);

    const parseProperties = (): Record<string, string> | undefined => {
        const raw = sendProperties.trim();
        if (!raw) {
            return undefined;
        }
        const parsed = JSON.parse(raw) as Record<string, string>;
        return parsed;
    };

    const handleSendMessage = async () => {
        if (!sendText.trim()) {
            return;
        }

        let properties: Record<string, string> | undefined;
        try {
            properties = parseProperties();
        } catch {
            message.error('属性必须是合法的 JSON 对象，例如 {"k":"v"}');
            return;
        }

        setSendLoading(true);
        setError(null);
        try {
            const response = await window.electronAPI.messages.send({
                clusterId,
                tenant,
                namespace,
                topic,
                persistent,
                message: sendText,
                properties,
            });
            if (response.success && response.data) {
                setLastMessageId(response.data.messageId);
                message.success(`发送成功：${response.data.messageId}`);
                void refreshBacklog();
            } else {
                setError(response.error || '发送失败');
            }
        } catch (sendError) {
            setError(sendError instanceof Error ? sendError.message : String(sendError));
        } finally {
            setSendLoading(false);
        }
    };

    const startSession = useCallback(
        async (
            streamMode: StreamMode,
            invoke: () => Promise<{success: boolean; data?: {sessionId: string}; error?: string}>,
        ) => {
            if (sessionRef.current) {
                message.warning('已有会话在运行，请先停止');
                return;
            }
            setStarting(true);
            setError(null);
            try {
                const response = await invoke();
                if (!response.success || !response.data) {
                    setError(response.error || '启动会话失败');
                    return;
                }
                sessionRef.current = {sessionId: response.data.sessionId, mode: streamMode};
                setSessionId(response.data.sessionId);
                setMessages([]);
            } catch (startError) {
                setError(startError instanceof Error ? startError.message : String(startError));
            } finally {
                setStarting(false);
            }
        },
        [],
    );

    const handleStartConsume = () =>
        startSession('consume', () =>
            window.electronAPI.messages.startConsume({
                clusterId,
                tenant,
                namespace,
                topic,
                persistent,
                subscription,
                subscriptionType,
                initialPosition,
                autoAck,
                maxMessages: consumeMax,
            }),
        );

    const handleStartRead = () => {
        if (readFrom === 'timestamp' && !readTimestamp) {
            message.warning('请选择起始时间');
            return;
        }
        return startSession('read', () =>
            window.electronAPI.messages.startRead({
                clusterId,
                tenant,
                namespace,
                topic,
                persistent,
                from: readFrom,
                // 时间戳只在「按时间」时带上：选过时间再切回最新/最早，控件里的值还在，
                // 带着它提交会被主进程按「起点与时间戳二选一」拒掉，用户只看到一句参数错误。
                timestamp: readFrom === 'timestamp' ? readTimestamp?.valueOf() : undefined,
                maxMessages: readMax,
            }),
        );
    };

    const handleToggleSession = () => {
        if (sessionId) {
            void stopActiveSession(true);
            void refreshBacklog();
        } else if (mode === 'consume') {
            void handleStartConsume();
        } else {
            void handleStartRead();
        }
    };

    useCommand('refreshMessages', () => {
        void refreshBacklog();
        void fetchSubscriptions();
    });

    useCommand('sendMessage', () => {
        if (mode === 'send') {
            void handleSendMessage();
        }
    });

    const toggleExpand = useCallback((messageId: string) => {
        setExpandedMessages(prev =>
            prev.includes(messageId) ? prev.filter(id => id !== messageId) : [...prev, messageId],
        );
    }, []);

    // 列表里每条消息都要展示格式化后的正文，解 base64 + JSON.parse 是逐条开销；
    // 之前放在列渲染里做，任何一次重渲染（例如展开一条消息）都会对全部 500 条重跑。
    // 按原始 data 缓存（同一条消息重复出现也只需算一次）。
    const formattedData = useMemo(() => {
        const cache = new Map<string, string>();
        for (const msg of messages) {
            if (!cache.has(msg.data)) {
                cache.set(msg.data, formatMessageData(msg.data));
            }
        }
        return cache;
    }, [messages]);

    const truncateMessage = (content: string, maxLength: number = truncateLength): string =>
        content.length <= maxLength ? content : content.substring(0, maxLength) + '...';

    const handleExportMessages = async (format: 'json' | 'csv') => {
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
        } catch (exportError) {
            console.error('Failed to export messages:', exportError);
            message.error('导出失败');
        } finally {
            setExportLoading(false);
        }
    };

    const columns = [
        {
            title: 'Message ID',
            dataIndex: 'messageId',
            key: 'messageId',
            width: 190,
            render: (text: string) => <code style={{fontSize: 11, color: 'var(--color-text-secondary)'}}>{text}</code>,
        },
        {title: 'Producer', dataIndex: 'producerName', key: 'producerName', width: 120},
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
            width: 110,
            render: (props: Record<string, string>) => {
                const keys = Object.keys(props || {});
                if (keys.length === 0) {
                    return '-';
                }
                return (
                    <Tooltip title={keys.map(k => `${k}: ${props[k]}`).join('\n')}>
                        <Tag color="blue">{keys.length} 个属性</Tag>
                    </Tooltip>
                );
            },
        },
        {
            title: '重投',
            dataIndex: 'redeliveryCount',
            key: 'redeliveryCount',
            width: 60,
            render: (count?: number) => (count ? <Tag color="orange">{count}</Tag> : '-'),
        },
        {
            title: 'Data',
            dataIndex: 'data',
            key: 'data',
            render: (data: string, record: Message) => {
                const formatted = formattedData.get(data) ?? formatMessageData(data);
                const isExpanded = expandedMessages.includes(record.messageId);
                const displayContent = isExpanded ? formatted : truncateMessage(formatted);

                return (
                    <div>
                        <div
                            style={{
                                maxHeight: isExpanded ? 200 : 'auto',
                                overflow: 'auto',
                                fontFamily: 'monospace',
                                fontSize: 12,
                                wordBreak: 'break-all',
                                color: 'var(--color-text-secondary)',
                            }}
                        >
                            {displayContent}
                        </div>
                        {formatted.length > truncateLength && (
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

    const fieldLabel = {marginRight: 'var(--spacing-sm)', fontWeight: 500} as const;

    const sendPanel = (
        <Space direction="vertical" style={{width: '100%'}} size="middle">
            <div>
                <div className="field-label" style={{marginBottom: 'var(--spacing-sm)'}}>
                    消息内容
                </div>
                <TextArea
                    aria-label="消息内容"
                    value={sendText}
                    onChange={e => setSendText(e.target.value)}
                    placeholder="输入要发送的消息内容..."
                    rows={4}
                />
            </div>
            <div>
                <div className="field-label" style={{marginBottom: 'var(--spacing-sm)'}}>
                    属性（可选，JSON 对象）
                    <Tooltip title="作为 message properties 一起发出，接收列表里会显示出来">
                        <span style={{marginLeft: 'var(--spacing-sm)', color: 'var(--color-text-tertiary)'}}>?</span>
                    </Tooltip>
                </div>
                <Input
                    aria-label="消息属性 JSON"
                    value={sendProperties}
                    onChange={e => setSendProperties(e.target.value)}
                    placeholder='{"env":"test","trace":"abc"}'
                />
            </div>
            <Space>
                <Button
                    type="primary"
                    icon={<SendOutlined />}
                    onClick={handleSendMessage}
                    loading={sendLoading}
                    disabled={!sendText.trim()}
                >
                    发送到 {persistent ? 'persistent' : 'non-persistent'}://{tenant}/{namespace}/{topic}
                </Button>
                {lastMessageId && <Tag color="green">最后一条 ID: {lastMessageId}</Tag>}
            </Space>
        </Space>
    );

    const streamControls =
        mode === 'consume' ? (
            <Space wrap size="middle">
                <div>
                    <label style={fieldLabel}>订阅:</label>
                    <AutoComplete
                        aria-label="订阅名称"
                        value={subscription}
                        onChange={value => setSubscription(value)}
                        options={subscriptions.map(s => ({value: s, label: s}))}
                        placeholder="已有订阅或输入新订阅名"
                        style={{width: 220}}
                        disabled={!!sessionId}
                    />
                </div>
                <div>
                    <label style={fieldLabel}>类型:</label>
                    <Select
                        aria-label="订阅类型"
                        value={subscriptionType}
                        onChange={setSubscriptionType}
                        style={{width: 120}}
                        disabled={!!sessionId}
                        options={[
                            {value: 'Shared', label: 'Shared'},
                            {value: 'Exclusive', label: 'Exclusive'},
                            {value: 'Failover', label: 'Failover'},
                            {value: 'Key_Shared', label: 'Key_Shared'},
                        ]}
                    />
                </div>
                <div>
                    <label style={fieldLabel}>起始:</label>
                    <Select
                        aria-label="起始消费位置"
                        value={initialPosition}
                        onChange={setInitialPosition}
                        style={{width: 110}}
                        disabled={!!sessionId}
                        options={[
                            {value: 'Earliest', label: 'Earliest'},
                            {value: 'Latest', label: 'Latest'},
                        ]}
                    />
                </div>
                <div>
                    <label style={fieldLabel}>自动 ack:</label>
                    <Switch aria-label="自动 ack" checked={autoAck} onChange={setAutoAck} disabled={!!sessionId} />
                </div>
                <Tooltip title="0 表示不限量，一直收到手动停止为止">
                    <div>
                        <label style={fieldLabel}>限量:</label>
                        <InputNumber
                            aria-label="消费消息限量"
                            min={0}
                            max={10000}
                            value={consumeMax}
                            onChange={value => setConsumeMax(value ?? 0)}
                            style={{width: 90}}
                            disabled={!!sessionId}
                        />
                    </div>
                </Tooltip>
            </Space>
        ) : (
            <Space wrap size="middle">
                <div>
                    <label style={fieldLabel}>起始位置:</label>
                    <Select
                        aria-label="读取起始位置"
                        value={readFrom}
                        onChange={setReadFrom}
                        style={{width: 130}}
                        disabled={!!sessionId}
                        options={[
                            {value: 'earliest', label: '最早'},
                            {value: 'latest', label: '最新之后'},
                            {value: 'timestamp', label: '指定时间'},
                        ]}
                    />
                </div>
                {readFrom === 'timestamp' && (
                    <DatePicker
                        aria-label="读取起始时间"
                        showTime
                        value={readTimestamp}
                        onChange={setReadTimestamp}
                        placeholder="起始时间"
                        disabled={!!sessionId}
                    />
                )}
                <Tooltip title="Reader 只读不确认，不影响任何订阅的游标">
                    <div>
                        <label style={fieldLabel}>限量:</label>
                        <InputNumber
                            aria-label="读取消息限量"
                            min={1}
                            max={10000}
                            value={readMax}
                            onChange={value => setReadMax(value ?? 1)}
                            style={{width: 90}}
                            disabled={!!sessionId}
                        />
                    </div>
                </Tooltip>
            </Space>
        );

    const isRunning = !!sessionId;

    return (
        <div className="stack">
            <Card>
                <Space wrap size="middle" style={{width: '100%', justifyContent: 'space-between'}}>
                    <Segmented
                        value={mode}
                        onChange={value => setMode(value as PanelMode)}
                        options={[
                            {value: 'send', label: '发送测试'},
                            {value: 'consume', label: '订阅消费'},
                            {value: 'read', label: 'Reader 读取'},
                        ]}
                    />
                    {mode !== 'send' && (
                        <Space wrap size="middle">
                            <Button
                                type={isRunning ? 'default' : 'primary'}
                                icon={isRunning ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                                onClick={handleToggleSession}
                                loading={starting}
                                disabled={mode === 'consume' && !subscription}
                            >
                                {isRunning ? '停止' : '开始'}
                            </Button>
                            {mode === 'consume' && (
                                <Space size={4}>
                                    <Button
                                        size="small"
                                        type="text"
                                        icon={<ReloadOutlined spin={backlogLoading} />}
                                        onClick={refreshBacklog}
                                    >
                                        积压:{' '}
                                        {backlog
                                            ? `${backlog.messageCount} 条 / ${formatBytes(backlog.sizeInBytes)}`
                                            : '-'}
                                    </Button>
                                </Space>
                            )}
                        </Space>
                    )}
                </Space>
                {mode !== 'send' && (
                    <div style={{marginTop: 'var(--spacing-md)'}}>
                        {streamControls}
                        {mode === 'consume' && !autoAck && (
                            <div className="hint-text" style={{marginTop: 'var(--spacing-sm)'}}>
                                已关闭自动 ack：未确认的消息会在客户端重连后重投，重投列会显示次数。
                            </div>
                        )}
                    </div>
                )}
            </Card>

            <ErrorBanner error={error} title="操作失败" onClose={() => setError(null)} />

            {mode === 'send' ? (
                <Card title="发送消息">{sendPanel}</Card>
            ) : (
                <Card
                    title={`消息列表 - ${messages.length} 条${isRunning ? '（实时推送中）' : ''}`}
                    extra={
                        <Dropdown.Button
                            size="small"
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
                    }
                >
                    <StateBlock
                        empty={messages.length === 0}
                        emptyText={isRunning ? '等待消息...' : '点击「开始」接收消息'}
                        height={160}
                    >
                        <Table
                            dataSource={messages}
                            columns={columns}
                            rowKey={(record, index) => `${record.messageId}-${index}`}
                            pagination={false}
                            size="small"
                            scroll={{x: 'max-content'}}
                        />
                    </StateBlock>
                </Card>
            )}

            <Modal
                title="消息详情"
                open={showFullMessage !== null}
                onCancel={() => setShowFullMessage(null)}
                width={800}
                footer={null}
            >
                {showFullMessage && (
                    <div className="stack" style={{gap: 'var(--spacing-md)'}}>
                        <div>
                            <label className="field-label">Message ID:</label>
                            <code className="field-value hint-text">{showFullMessage.messageId}</code>
                        </div>
                        <div>
                            <label className="field-label">Producer:</label>
                            <span className="field-value">{showFullMessage.producerName}</span>
                        </div>
                        <div>
                            <label className="field-label">Publish Time:</label>
                            <span className="field-value">
                                {dayjs(showFullMessage.publishTime).format('YYYY-MM-DD HH:mm:ss.SSS')}
                            </span>
                        </div>
                        <div>
                            <label className="field-label">Properties:</label>
                            <pre className="field-value hint-text" style={{maxHeight: 100, overflow: 'auto'}}>
                                {JSON.stringify(showFullMessage.properties, null, 2)}
                            </pre>
                        </div>
                        <div>
                            <label className="field-label">Data:</label>
                            <pre
                                className="field-value hint-text"
                                style={{
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
