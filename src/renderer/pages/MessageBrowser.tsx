import React, {useState, useEffect, useCallback, useMemo, useRef, useContext, type ReactNode} from 'react';
import {
    Card,
    Table,
    Button,
    Input,
    Select,
    AutoComplete,
    Space,
    message,
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
    AlignLeftOutlined,
    ProfileOutlined,
} from '@ant-design/icons';
import type {TableColumnsType} from 'antd';
import type {Message, MessageBatch, ProducerMessageOptions, SessionEndEvent} from '../types';
import {formatBytes} from '../utils/format';
import dayjs from 'dayjs';
import {downloadBlob} from '../utils/download';
import {useCommand, PaneActiveContext} from '../hooks/useKeybindings';
import {useSettingsStore} from '../store/settings';
import StateBlock from '../components/common/StateBlock';
import ErrorBanner from '../components/common/ErrorBanner';
import MessageDetailModal from '../components/message/MessageDetailModal';
import CodePane, {type CodePaneHandle} from '../components/editor/CodePane';
import {
    decodeMessageBatch,
    truncateText,
    trimMessageList,
    STREAM_MAX_BYTES,
    type PayloadKind,
} from '../components/message/messageFormat';
import {buildMessagesExport, messagesExportFilename} from '../components/message/exportMessages';
import {useResizableColumns} from '../hooks/useResizableColumns';
import {useVirtualTable} from '../hooks/useVirtualTable';

// 一行"标签 + 问号说明 + 控件"。标签钉宽、控件吃剩下，与工作台那两张参数表同构，
// 说明挂在标签上而不是控件后面：控件右边往往还跟着第二个控件（选择 + 时间），
// 文字挤在中间会把两样都挡住。
const OptRow: React.FC<{label: ReactNode; hint: string; children: ReactNode}> = ({label, hint, children}) => (
    <div className="opt-row">
        <span className="field-label">
            <Tooltip title={hint}>
                <span>{label}</span>
            </Tooltip>
        </span>
        <span className="opt-control">{children}</span>
    </div>
);

type StreamMode = 'consume' | 'read';
type PanelMode = 'send' | StreamMode;

const PROPERTIES_HINT =
    '任意键值的字符串属性，随消息一起存进 broker，接收列表的 Properties 列就是它。' +
    '值只会是字符串：数字与布尔发出去会转成文本；XML 按叶子摊平成点路径（props.env → test）。';

const PEEK_HINT =
    '给该订阅临时挂一条 Shared 消费者取几条就撤：一条都不确认，看完这些消息原样回到积压。' +
    'Exclusive 订阅会被 broker 拒绝，Failover 订阅可能被现役消费者占着看不到。';

// 两种写法各给一份起手的默认模板。XML 的根标签会进键名前缀（<props><env> → props.env），
// JSON 的嵌套值会被摊成字符串，这两条 PROPERTIES_HINT 里都写了。
const PROPERTIES_TEMPLATES: Record<'json' | 'xml', string> = {
    json: `{\n  "env": "test",\n  "traceId": "pm-0001"\n}`,
    xml: `<props>\n  <env>test</env>\n  <traceId>pm-0001</traceId>\n</props>`,
};

// 把 XML 摊平成 properties 的键值表：叶子按点路径成键（<props><env>test</env></props>
// → props.env），同名兄弟按出现顺序补 [n]。properties 的值只会是字符串，
// 所以取 textContent，混合内容丢掉的标记与空白在这里不影响读值。
function flattenXmlProperties(raw: string): Record<string, string> {
    const doc = new DOMParser().parseFromString(raw, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0 || !doc.documentElement) {
        throw new DOMException('XML 解析失败');
    }
    const out: Record<string, string> = {};
    const seen = new Map<string, number>();
    const walk = (node: Element, path: string) => {
        const children = Array.from(node.children);
        if (children.length === 0) {
            const count = (seen.get(path) ?? 0) + 1;
            seen.set(path, count);
            out[count > 1 ? `${path}[${count}]` : path] = node.textContent ?? '';
            return;
        }
        for (const child of children) {
            walk(child, `${path}.${child.tagName}`);
        }
    };
    const root = doc.documentElement;
    walk(root, root.tagName);
    return out;
}

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
    // active 只说明内嵌页签是不是「消息」，TabWorkspace 把非当前主标签页
    // display:none 保留挂载，因此还要看外层页签是否活跃。两者都为真才算用户
    // 真的看得见这个列表——否则 autoAck 会在无人可见时把消息永久确认掉。
    const paneActive = useContext(PaneActiveContext);
    const visible = active && paneActive;
    const [mode, setMode] = useState<PanelMode>('send');
    const [messages, setMessages] = useState<Message[]>([]);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [subscriptions, setSubscriptions] = useState<string[]>([]);
    const [subscription, setSubscription] = useState('');

    const [sendText, setSendText] = useState('');
    const [sendKind, setSendKind] = useState<PayloadKind>('json');
    const [sendProperties, setSendProperties] = useState('');
    const [sendPropertiesKind, setSendPropertiesKind] = useState<'json' | 'xml'>('json');
    const [sendLoading, setSendLoading] = useState(false);
    const [lastMessageId, setLastMessageId] = useState<string | null>(null);

    // 逐条报文参数。只列这四个入口（路由键 / 事件时间 / 延时投递）：原生一条消息
    // 能自带的就这些，其余（批大小、压缩）是 producer 级的，单发用默认值。
    const [sendPartitionKey, setSendPartitionKey] = useState('');
    const [sendEventMode, setSendEventMode] = useState<'none' | 'now' | 'fixed'>('none');
    const [sendEventTime, setSendEventTime] = useState<dayjs.Dayjs | null>(null);
    const [sendDelayMode, setSendDelayMode] = useState<'none' | 'after' | 'at'>('none');
    const [sendDeliverAfterSec, setSendDeliverAfterSec] = useState(10);
    const [sendDeliverAt, setSendDeliverAt] = useState<dayjs.Dayjs | null>(null);

    const [subscriptionType, setSubscriptionType] = useState<'Exclusive' | 'Shared' | 'Failover' | 'Key_Shared'>(
        'Shared',
    );
    const [initialPosition, setInitialPosition] = useState<'Latest' | 'Earliest'>('Earliest');
    const [autoAck, setAutoAck] = useState(true);
    const [consumeMax, setConsumeMax] = useState(0);

    const [readFrom, setReadFrom] = useState<'earliest' | 'latest' | 'timestamp' | 'recent' | 'messageId'>('earliest');
    const [readTimestamp, setReadTimestamp] = useState<dayjs.Dayjs | null>(null);
    const [readMax, setReadMax] = useState(20);
    const [recentCount, setRecentCount] = useState(20);
    // 按 ID 定位的目标：Message ID 是从列表里复制来的字符串，不做格式校验——
    // 格式对不对由 broker 那边的比对说了算，这里拦格式只会拦错。
    const [readMessageId, setReadMessageId] = useState('');

    const [backlog, setBacklog] = useState<{messageCount: number; sizeInBytes: number} | null>(null);
    const [backlogLoading, setBacklogLoading] = useState(false);
    const [expandedMessages, setExpandedMessages] = useState<string[]>([]);
    const [showFullMessage, setShowFullMessage] = useState<Message | null>(null);
    const [exportLoading, setExportLoading] = useState(false);
    const [peeking, setPeeking] = useState(false);

    // 会话 id 同时放 ref：推送回调与卸载清理都要读最新值，
    // 放 state 会让 effect 依赖来回变化，反而漏停或重复停。
    const sessionRef = useRef<ActiveSession | null>(null);
    // 停止请求在途的标记：只防连点重复发停止，不承担"已停"的语义
    const stoppingRef = useRef(false);
    // 启动在途，以及这期间到达的、还不认领得下的事件。startConsume 的 IPC 与主进程
    // 第一批推送是并发的：响应没回来时界面并不知道自己要认领哪个 sessionId，那几批
    // （以及"会话已经结束了"这句）只能先存着，认领上立刻回放。不这么做的话
    // 短会话（reader 扫尾部、收满就结束的几十条）会一条都显不出来。
    const startingRef = useRef(false);
    const earlyEvents = useRef<{batches: MessageBatch[]; ends: SessionEndEvent[]}>({batches: [], ends: []});

    const sendPaneRef = useRef<CodePaneHandle | null>(null);
    const propsPaneRef = useRef<CodePaneHandle | null>(null);

    const stopActiveSession = useCallback(async (notify: boolean) => {
        const session = sessionRef.current;
        if (!session || stoppingRef.current) {
            return;
        }
        stoppingRef.current = true;
        const stop =
            session.mode === 'consume' ? window.electronAPI.messages.stopConsume : window.electronAPI.messages.stopRead;
        try {
            const response = await stop(session.sessionId);
            // 引用只在主进程确认停掉之后才摘：提前清空等于把会话判成"界面无从再管"，
            // 而那边的 consumer/reader 还在跑——autoAck 继续吞消息、订阅被占住，
            // 下次开会被"该订阅已有会话"拒绝，最后吃的是主进程 32 个会话的额度。
            if (response.success) {
                sessionRef.current = null;
                setSessionId(null);
            } else if (notify) {
                message.warning(response.error || '停止会话失败，会话可能仍在运行，可再次点击停止');
            }
        } catch (stopError) {
            if (notify) {
                message.error('停止会话失败，会话可能仍在运行，可再次点击停止');
            }
            console.error('Failed to stop session:', stopError);
        } finally {
            stoppingRef.current = false;
        }
    }, []);

    // 切换模式或换 topic 都会让旧会话失去意义：先停，且不打扰用户
    useEffect(() => {
        void stopActiveSession(false);
        setMessages([]);
        setError(null);
    }, [mode, clusterId, tenant, namespace, topic, persistent, stopActiveSession]);

    // 切到别的内嵌页签或别的顶层标签页就把会话停掉：页签是 display:none 不是卸载，
    // 不停的话它会一直在后台消费并把消息（autoAck 下）永久确认掉。
    useEffect(() => {
        if (!visible) {
            void stopActiveSession(false);
        }
    }, [visible, stopActiveSession]);

    // 组件卸载（关标签页）时主进程侧的 consumer/reader 必须一起关掉，
    // 否则它会一直占着订阅，下次开始消费会被"该订阅已有会话"拒绝。
    useEffect(
        () => () => {
            void stopActiveSession(false);
        },
        [stopActiveSession],
    );

    const appendBatch = useCallback((batch: MessageBatch) => {
        // 流式会话重连时可能重投已经显示过的消息。按 messageId 去重后，
        // 表格才能把 messageId 当稳定 key——否则为躲重复 key 拼上 index，
        // 每来一批新消息都会让所有旧行的 index 后移，整张表重挂、展开状态全丢。
        setMessages(prev => {
            const seen = new Set(prev.map(item => item.messageId));
            const fresh = batch.messages.filter(item => {
                if (seen.has(item.messageId)) {
                    return false;
                }
                seen.add(item.messageId);
                return true;
            });
            return trimMessageList([...fresh, ...prev], MAX_DISPLAY_COUNT, STREAM_MAX_BYTES);
        });
    }, []);

    const applySessionEnd = useCallback((event: SessionEndEvent) => {
        sessionRef.current = null;
        setSessionId(null);
        if (event.reason === 'error') {
            setError(event.detail || '会话异常终止');
        } else if (event.reason === 'completed') {
            // 主进程对一次性回溯扫描会带一句 detail（扫了多少、取了几条、有没有撞护栏），
            // 没有 detail 才是按限量收满的那种结束。
            message.info(event.detail || '已达到消息数量上限，会话结束');
        }
    }, []);

    useEffect(() => {
        const isMine = (id: string) => sessionRef.current?.sessionId === id;

        const stash = (batch: MessageBatch) => {
            const kept = earlyEvents.current.batches.reduce((total, item) => total + item.messages.length, 0);
            if (kept >= MAX_DISPLAY_COUNT) {
                return;
            }
            earlyEvents.current.batches.push(batch);
        };

        const offConsume = window.electronAPI.messages.onConsumeBatch(batch => {
            if (isMine(batch.sessionId)) {
                appendBatch(batch);
            } else if (startingRef.current) {
                stash(batch);
            }
        });
        const offRead = window.electronAPI.messages.onReadBatch(batch => {
            if (isMine(batch.sessionId)) {
                appendBatch(batch);
            } else if (startingRef.current) {
                stash(batch);
            }
        });
        // 收满上限或循环出错时会话会自己结束，不接这个事件界面就会一直显示"运行中"
        const offEnd = window.electronAPI.messages.onSessionEnd((event: SessionEndEvent) => {
            if (isMine(event.sessionId)) {
                applySessionEnd(event);
            } else if (startingRef.current) {
                earlyEvents.current.ends.push(event);
            }
        });

        return () => {
            offConsume();
            offRead();
            offEnd();
        };
    }, [appendBatch, applySessionEnd]);

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

    // properties 只接受扁平键值，但写法随选中的类型走：JSON 对象里写了数字/布尔
    // 一律转成字符串投出去（broker 存的本来就只有字符串），XML 按叶子摊平成点路径。
    const parseProperties = (): Record<string, string> | undefined => {
        const raw = sendProperties.trim();
        if (!raw) {
            return undefined;
        }
        if (sendPropertiesKind === 'xml') {
            return flattenXmlProperties(raw);
        }
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new TypeError('properties 需要是 JSON 对象');
        }
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
            out[key] =
                value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
                    ? String(value)
                    : JSON.stringify(value);
        }
        return out;
    };

    const handleFormatProperties = () => {
        if (!propsPaneRef.current?.format()) {
            message.warning(
                sendPropertiesKind === 'json' ? '属性不是合法 JSON，无法格式化' : '属性格式不符合 XML，无法缩进',
            );
        }
    };

    // 换写法时，框里还是空的或另一份没动过的模板就顺手换成对应写法；
    // 用户改过的内容一律不覆盖，要换模板走「模板」按钮（覆盖后编辑器内 Ctrl+Z 还能撤）。
    const handlePropertiesKindChange = (kind: 'json' | 'xml') => {
        const current = sendProperties.trim();
        const untouched = !current || Object.values(PROPERTIES_TEMPLATES).some(tpl => tpl.trim() === current);
        setSendPropertiesKind(kind);
        if (untouched) {
            setSendProperties(PROPERTIES_TEMPLATES[kind]);
        }
    };

    const applyPropertiesTemplate = (kind: 'json' | 'xml') => {
        setSendPropertiesKind(kind);
        setSendProperties(PROPERTIES_TEMPLATES[kind]);
    };

    // 格式化失败几乎都是"正文本来就不是合法 JSON"，说清这一点而不是只说失败：
    // 用户接下来要发的是文本或没写完的片段时，报错内容比报错动作更有用。
    const handleFormatBody = () => {
        if (!sendPaneRef.current?.format()) {
            message.warning(sendKind === 'json' ? '正文不是合法 JSON，无法格式化' : '正文格式不符合 XML，无法缩进');
        }
    };

    // 面板上的四个入口拼成报文参数。空值一律不写字段而不是写 undefined：
    // 主进程那侧的回落规则认"没这个键"，写进去一个 undefined 会把会话参数盖掉。
    const buildSendOptions = (): ProducerMessageOptions | undefined => {
        const options: ProducerMessageOptions = {};
        const key = sendPartitionKey.trim();
        if (key) {
            options.partitionKey = key;
        }
        if (sendEventMode === 'now') {
            options.eventTimeMode = 'now';
        } else if (sendEventMode === 'fixed') {
            if (!sendEventTime) {
                return undefined;
            }
            options.eventTimeMode = 'fixed';
            options.eventTimeFixed = sendEventTime.valueOf();
        }
        if (sendDelayMode === 'after') {
            options.delayMode = 'deliverAfter';
            options.deliverAfterMs = sendDeliverAfterSec * 1000;
        } else if (sendDelayMode === 'at') {
            if (!sendDeliverAt) {
                return undefined;
            }
            options.delayMode = 'deliverAt';
            options.deliverAt = sendDeliverAt.valueOf();
        }
        return Object.keys(options).length > 0 ? options : undefined;
    };

    const handleSendMessage = async () => {
        if (!sendText.trim()) {
            return;
        }

        let properties: Record<string, string> | undefined;
        try {
            properties = parseProperties();
        } catch {
            message.error(
                sendPropertiesKind === 'json' ? '属性需要是合法的 JSON 对象，例如 {"k":"v"}' : '属性需要是合法的 XML',
            );
            return;
        }
        if (sendEventMode === 'fixed' && !sendEventTime) {
            message.warning('事件时间选了「指定」，还需要选一个时间');
            return;
        }
        if (sendDelayMode === 'at' && !sendDeliverAt) {
            message.warning('延时投递选了「定时」，还需要选一个时间');
            return;
        }
        if (sendDelayMode === 'after' && sendDeliverAfterSec < 1) {
            message.warning('延时秒数至少 1 秒');
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
                options: buildSendOptions(),
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
            startingRef.current = true;
            earlyEvents.current = {batches: [], ends: []};
            try {
                const response = await invoke();
                if (!response.success || !response.data) {
                    setError(response.error || '启动会话失败');
                    return;
                }
                const sessionId = response.data.sessionId;
                sessionRef.current = {sessionId, mode: streamMode};
                setSessionId(sessionId);
                setMessages([]);
                // 认领上了才回放，并且是先批后结束：结束事件如果抢在响应前面到达，
                // 这条会话其实已经跑完了，回放完它界面就直接落到"已停止"。
                const early = earlyEvents.current;
                earlyEvents.current = {batches: [], ends: []};
                startingRef.current = false;
                for (const batch of early.batches) {
                    if (batch.sessionId === sessionId) {
                        appendBatch(batch);
                    }
                }
                for (const event of early.ends) {
                    if (event.sessionId === sessionId) {
                        applySessionEnd(event);
                    }
                }
            } catch (startError) {
                setError(startError instanceof Error ? startError.message : String(startError));
            } finally {
                startingRef.current = false;
                earlyEvents.current = {batches: [], ends: []};
                setStarting(false);
            }
        },
        [appendBatch, applySessionEnd],
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
        if (readFrom === 'messageId' && !readMessageId.trim()) {
            message.warning('先粘贴要定位的 Message ID');
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
                recentCount,
                messageId: readFrom === 'messageId' ? readMessageId.trim() : undefined,
            }),
        );
    };

    // 偷看：主进程给该订阅临时挂一条 Shared 消费者取几条就撤，一条都不确认，
    // 消息原样回到积压。限量沿用「消费限量」那一格（0 或超 200 时按 200 收），
    // 单次 IPC 整份返回，条数必须有个和流式路径不同的上限。
    const handlePeek = async () => {
        if (sessionId || !subscription) {
            return;
        }
        setPeeking(true);
        setError(null);
        try {
            const response = await window.electronAPI.messages.peek({
                clusterId,
                tenant,
                namespace,
                topic,
                persistent,
                subscription,
                maxMessages: consumeMax > 0 ? Math.min(consumeMax, 200) : 20,
            });
            if (response.success && response.data) {
                setMessages(trimMessageList(response.data.messages, MAX_DISPLAY_COUNT, STREAM_MAX_BYTES));
                if (response.data.note) {
                    message.info(response.data.note);
                } else {
                    message.success(`偷看到 ${response.data.messages.length} 条（未确认，积压不动）`);
                }
                void refreshBacklog();
            } else {
                setError(response.error || '偷看失败');
            }
        } catch (peekError) {
            setError(peekError instanceof Error ? peekError.message : String(peekError));
        } finally {
            setPeeking(false);
        }
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

    // 列表里每条消息都要展示格式化后的正文（还要判类型），解 base64 + JSON.parse 是逐条开销；
    // 之前放在列渲染里做，任何一次重渲染（例如展开一条消息）都会对全部 500 条重跑。
    // 按原始 data 缓存（同一条消息重复出现也只需算一次）。
    const decodedData = useMemo(() => decodeMessageBatch(messages.map(msg => msg.data)), [messages]);

    // 重投 = 把这条消息的正文与属性原样装回「发送测试」面板，由用户自己点发送：
    // 不代点是因为发出去的就是"另一条新消息"，topic 是否还该收它、属性要不要改，
    // 都是只有用户能拍板的事；面板里改完 Ctrl+Z 也还能撤。
    const loadIntoSendPanel = (record: Message) => {
        const payload = decodedData.get(record.data);
        setSendText(payload?.formatted ?? '');
        setSendKind(payload?.kind ?? 'text');
        const keys = Object.keys(record.properties || {});
        if (keys.length > 0) {
            setSendPropertiesKind('json');
            setSendProperties(JSON.stringify(record.properties, null, 2));
        }
        setMode('send');
        message.success(`已把 ${record.messageId} 装回发送测试面板，确认后点发送即为重投`);
    };

    const handleExportMessages = async (format: 'json' | 'csv') => {
        if (messages.length === 0) {
            message.warning('暂无消息可导出');
            return;
        }

        setExportLoading(true);
        try {
            const payload = buildMessagesExport(messages, format);
            downloadBlob(payload.content, messagesExportFilename(topic, format), payload.mimeType);
            message.success(`成功导出 ${messages.length} 条消息 (${payload.extension.toUpperCase()})`);
        } catch (exportError) {
            console.error('Failed to export messages:', exportError);
            message.error('导出失败');
        } finally {
            setExportLoading(false);
        }
    };

    const KIND_LABEL = {json: 'JSON', xml: 'XML', text: '文本'} as const;

    const columns: TableColumnsType<Message> = [
        {
            title: 'Message ID',
            dataIndex: 'messageId',
            key: 'messageId',
            width: 190,
            render: (text: string) => (
                <code style={{fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)'}}>{text}</code>
            ),
        },
        {title: 'Producer', dataIndex: 'producerName', key: 'producerName', width: 120},
        {
            title: 'Publish Time',
            dataIndex: 'publishTime',
            key: 'publishTime',
            width: 150,
            defaultSortOrder: 'descend',
            sorter: (a, b) => a.publishTime - b.publishTime,
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
            width: 320,
            render: (data: string, record: Message) => {
                const payload = decodedData.get(data);
                const formatted = payload?.formatted ?? '';
                const isExpanded = expandedMessages.includes(record.messageId);
                const displayContent = isExpanded ? formatted : truncateText(formatted, truncateLength);

                return (
                    <div>
                        <Tag>{payload ? KIND_LABEL[payload.kind] : '文本'}</Tag>
                        <div
                            style={{
                                maxHeight: isExpanded ? 200 : 'auto',
                                overflow: 'auto',
                                fontFamily: 'var(--font-mono)',
                                fontSize: 'var(--font-size-xs)',
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
                        <Button
                            type="text"
                            size="small"
                            icon={<SendOutlined />}
                            onClick={() => loadIntoSendPanel(record)}
                            style={{marginTop: 4, marginLeft: 8}}
                        >
                            重投（装回发送）
                        </Button>
                    </div>
                );
            },
        },
    ];

    // 列宽能拖：Message ID 那列固定 190px 时末尾被截断，想看清整条 ID 只能拖宽，
    // 而拖完这一屏就这样停着，比每次点开都重排要稳。
    const {resizableColumns, components} = useResizableColumns(columns);

    // 界面保留条数可以开到几千：几千行 × 每行一堆 Tag/Tooltip 是这台客户端最主要
    // 的卡顿来源。超过阈值才切成虚拟滚动，几百条以内与原来逐像素一致。
    const box = useVirtualTable(messages.length);

    const fieldLabel = {marginRight: 'var(--spacing-sm)', fontWeight: 500} as const;

    const sendPanel = (
        <div className="stack" style={{gap: 'var(--spacing-md)'}}>
            <div>
                <div
                    className="field-label"
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--spacing-sm)',
                        marginBottom: 'var(--spacing-sm)',
                    }}
                >
                    <span>消息内容</span>
                    <Segmented
                        size="small"
                        value={sendKind}
                        onChange={value => setSendKind(value as PayloadKind)}
                        options={[
                            {value: 'json', label: 'JSON'},
                            {value: 'xml', label: 'XML'},
                            {value: 'text', label: '文本'},
                        ]}
                    />
                    {sendKind !== 'text' && (
                        <Button size="small" type="text" icon={<AlignLeftOutlined />} onClick={handleFormatBody}>
                            格式化
                        </Button>
                    )}
                    <span className="hint-text">只决定这一段按哪套语法着色与缩进，发出去的就是框里的文本本身</span>
                </div>
                <CodePane
                    ref={sendPaneRef}
                    value={sendText}
                    kind={sendKind}
                    editable
                    resizable
                    storageKey="pulsar-manager.message.body-height"
                    height={220}
                    ariaLabel="消息内容"
                    onChange={setSendText}
                />
            </div>

            <div className="options-grid">
                <div className="opt-group">
                    <div className="opt-group-title">常用属性</div>
                    <OptRow
                        label="路由键"
                        hint="partitionKey。分区 topic 上同一个键固定落到同一个分区，用来保证同一实体的消息有序；不填则按 producer 的分布策略投。"
                    >
                        <Input
                            size="small"
                            aria-label="路由键"
                            value={sendPartitionKey}
                            onChange={event => setSendPartitionKey(event.target.value)}
                            placeholder="不带"
                        />
                    </OptRow>
                    <OptRow
                        label="事件时间"
                        hint="eventTimestamp。是 broker 存进 ledger 的业务时间，与 publishTime（broker 收到那一刻）是两回事；窗口计算、时间序订阅读的是它。"
                    >
                        <Select
                            size="small"
                            aria-label="事件时间方式"
                            value={sendEventMode}
                            onChange={setSendEventMode}
                            options={[
                                {value: 'none', label: '不带'},
                                {value: 'now', label: '当前时间'},
                                {value: 'fixed', label: '指定'},
                            ]}
                        />
                        {sendEventMode === 'fixed' && (
                            <DatePicker
                                size="small"
                                aria-label="事件时间"
                                showTime
                                value={sendEventTime}
                                onChange={setSendEventTime}
                            />
                        )}
                    </OptRow>
                    <OptRow
                        label="延时投递"
                        hint="deliverAfter / deliverAt。消息先进 broker 的延时投递队列，到点才投给订阅；到点之前积压数里能看到它。"
                    >
                        <Select
                            size="small"
                            aria-label="延时投递方式"
                            value={sendDelayMode}
                            onChange={setSendDelayMode}
                            options={[
                                {value: 'none', label: '立即'},
                                {value: 'after', label: '延时'},
                                {value: 'at', label: '定时'},
                            ]}
                        />
                        {sendDelayMode === 'after' && (
                            <>
                                <InputNumber
                                    size="small"
                                    min={1}
                                    max={604800}
                                    aria-label="延时秒数"
                                    value={sendDeliverAfterSec}
                                    onChange={value => setSendDeliverAfterSec(value ?? 1)}
                                />
                                <span className="hint-text">秒</span>
                            </>
                        )}
                        {sendDelayMode === 'at' && (
                            <DatePicker
                                size="small"
                                aria-label="定时投递时间"
                                showTime
                                value={sendDeliverAt}
                                onChange={setSendDeliverAt}
                            />
                        )}
                    </OptRow>
                </div>
                <div className="opt-group">
                    <div className="opt-group-title">自定义属性（JSON / XML）</div>
                    {/* 多行编辑占整块宽度，塞进 OptRow 会被 96px 标签挤成一条缝，
                        所以写法选择与格式化排在上面，CodePane 独自在下方铺开 */}
                    <div style={{display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4}}>
                        <Select
                            size="small"
                            aria-label="属性写法"
                            value={sendPropertiesKind}
                            onChange={value => handlePropertiesKindChange(value)}
                            options={[
                                {value: 'json', label: 'JSON'},
                                {value: 'xml', label: 'XML'},
                            ]}
                            style={{width: 90}}
                        />
                        <Button size="small" type="text" icon={<AlignLeftOutlined />} onClick={handleFormatProperties}>
                            格式化
                        </Button>
                        <Dropdown
                            trigger={['click']}
                            menu={{
                                items: [
                                    {key: 'json', label: 'JSON 模板'},
                                    {key: 'xml', label: 'XML 模板'},
                                ],
                                onClick: ({key}) => applyPropertiesTemplate(key as 'json' | 'xml'),
                            }}
                        >
                            <Tooltip title="插入默认模板，会覆盖框里的内容（编辑器内 Ctrl+Z 可撤销）">
                                <Button size="small" type="text" icon={<ProfileOutlined />}>
                                    模板
                                </Button>
                            </Tooltip>
                        </Dropdown>
                        <Tooltip title={PROPERTIES_HINT}>
                            <span className="hint-text">properties 写法</span>
                        </Tooltip>
                    </div>
                    <CodePane
                        ref={propsPaneRef}
                        value={sendProperties}
                        kind={sendPropertiesKind}
                        editable
                        resizable
                        storageKey="pulsar-manager.message.properties-height"
                        height={140}
                        ariaLabel="消息属性"
                        onChange={setSendProperties}
                    />
                    <div className="hint-text">
                        这里给的是单条消息能自带的那几项参数。批大小、压缩、发送超时这些是 producer
                        级的，单次发送每次现建一条 producer，用默认值；要调它们去生产者工作台建常驻会话。
                    </div>
                </div>
            </div>

            <Space size={4}>
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
        </div>
    );

    const streamControls =
        mode === 'consume' ? (
            <Space wrap size="small">
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
            <Space wrap size="small">
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
                            {value: 'recent', label: '最近 N 条'},
                            {value: 'messageId', label: '按 ID 定位'},
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
                {readFrom === 'recent' && (
                    <div>
                        <label style={fieldLabel}>条数:</label>
                        <Tooltip title="原生 Reader 没有尾部锚点，这条是从最早开始扫、只留最后 N 条，扫完自动结束（最多扫 2 万条或 15 秒）。上限与列表保留条数一致。">
                            <InputNumber
                                aria-label="最近多少条"
                                min={1}
                                max={MAX_DISPLAY_COUNT}
                                value={recentCount}
                                onChange={value => setRecentCount(value ?? 20)}
                                style={{width: 90}}
                                disabled={!!sessionId}
                            />
                        </Tooltip>
                    </div>
                )}
                {readFrom === 'messageId' && (
                    <Tooltip title="没有按 ID 直取的协议路由，主进程从最早逐条比对到这个 ID 为止（护栏同回溯扫描：最多 2 万条或 15 秒），找到就显这一条">
                        <Input
                            aria-label="目标 Message ID"
                            value={readMessageId}
                            onChange={event => setReadMessageId(event.target.value)}
                            placeholder="如 52196:16:0"
                            style={{width: 190}}
                            disabled={!!sessionId}
                        />
                    </Tooltip>
                )}
                {readFrom !== 'recent' && readFrom !== 'messageId' && (
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
                )}
            </Space>
        );

    const isRunning = !!sessionId;

    return (
        <div className="stack">
            {/* 一个整体：模式切换、该模式的参数区、结果区全在同一张卡里。
                原先是「工具栏卡 + 结果卡」两张，切换发送/消费/读取时两张卡各自长高、
                各自换内容，界面上就是所有东西分头跳一次。 */}
            <Card
                title={
                    <Segmented
                        value={mode}
                        onChange={value => setMode(value as PanelMode)}
                        options={[
                            {value: 'send', label: '发送测试'},
                            {value: 'consume', label: '订阅消费'},
                            {value: 'read', label: 'Reader 读取'},
                        ]}
                    />
                }
                extra={
                    mode === 'send' ? undefined : (
                        <Space wrap size="small">
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
                                <Tooltip title={PEEK_HINT}>
                                    <Button
                                        size="small"
                                        icon={<ZoomInOutlined />}
                                        loading={peeking}
                                        disabled={isRunning || !subscription}
                                        onClick={() => void handlePeek()}
                                    >
                                        偷看
                                    </Button>
                                </Tooltip>
                            )}
                            {mode === 'consume' && (
                                <Button
                                    size="small"
                                    type="text"
                                    icon={<ReloadOutlined spin={backlogLoading} />}
                                    onClick={refreshBacklog}
                                >
                                    积压:{' '}
                                    {backlog ? `${backlog.messageCount} 条 / ${formatBytes(backlog.sizeInBytes)}` : '-'}
                                </Button>
                            )}
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
                        </Space>
                    )
                }
            >
                {mode !== 'send' && (
                    <div style={{marginBottom: 'var(--spacing-sm)'}}>
                        {streamControls}
                        {mode === 'consume' && !autoAck && (
                            <div className="hint-text" style={{marginTop: 'var(--spacing-sm)'}}>
                                已关闭自动 ack：未确认的消息会在客户端重连后重投，重投列会显示次数。
                            </div>
                        )}
                    </div>
                )}

                <ErrorBanner error={error} title="操作失败" onClose={() => setError(null)} />

                {mode === 'send' ? (
                    sendPanel
                ) : (
                    <>
                        <div className="summary-line">
                            <span>
                                消息列表 <strong>{messages.length}</strong> 条{isRunning && '（实时推送中）'}
                            </span>
                        </div>
                        <StateBlock
                            empty={messages.length === 0}
                            emptyText={isRunning ? '等待消息...' : '点击「开始」接收消息'}
                            height={160}
                        >
                            <div ref={box.ref}>
                                <Table
                                    dataSource={messages}
                                    columns={resizableColumns}
                                    components={components}
                                    // 稳定 key：见 appendBatch 的去重说明
                                    rowKey="messageId"
                                    pagination={false}
                                    size="small"
                                    scroll={box.scroll}
                                    virtual={box.virtual}
                                />
                            </div>
                        </StateBlock>
                    </>
                )}
            </Card>

            <MessageDetailModal message={showFullMessage} onClose={() => setShowFullMessage(null)} />
        </div>
    );
};

export default MessageBrowser;
