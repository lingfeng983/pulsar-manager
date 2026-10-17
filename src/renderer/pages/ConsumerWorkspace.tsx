import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
    AutoComplete,
    Button,
    Input,
    InputNumber,
    Popconfirm,
    Segmented,
    Select,
    Space,
    Switch,
    Tag,
    Tooltip,
    message,
} from 'antd';
import {
    ClearOutlined,
    CopyOutlined,
    DeleteOutlined,
    DisconnectOutlined,
    DownloadOutlined,
    PlayCircleOutlined,
    ReloadOutlined,
    SaveOutlined,
} from '@ant-design/icons';
import type {
    BacklogInfo,
    ConsumerConfigDraft,
    ConsumerSessionConfig,
    ConsumerSessionInfo,
    Message,
    MessageBatch,
    SessionEndEvent,
} from '../types';
import PageShell from '../components/common/PageShell';
import ErrorBanner from '../components/common/ErrorBanner';
import {themedModal} from '../components/common/dangerConfirm';
import ConsumerConfigForm from '../components/consumer/ConsumerConfigForm';
import MessageListView from '../components/message/MessageListView';
import MessageDetailModal from '../components/message/MessageDetailModal';
import {buildMessagesExport, messagesExportFilename} from '../components/message/exportMessages';
import {DEFAULT_STREAM_LIMIT, useMessageStream} from '../components/message/useMessageStream';
import {downloadBlob} from '../utils/download';
import {formatBytes} from '../utils/format';
import {useSettingsStore} from '../store/settings';

// 消费者工作台：一条 topic 上可以同时挂几条消费会话，每张卡片对应一个原生 consumer，
// 下面的列表按会话分桶显示收到的消息。多会话不是为了好看——对比 Shared 与 Failover、
// 或者拿两个订阅名看同一份积压，都得让两条会话同时在跑。

const NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

const defaultDraft = (): ConsumerConfigDraft => ({
    subscriptionType: 'Shared',
    // 工作台是"点进来看看有什么"，从最早位置读起才不会让新订阅看起来永远没数据；
    // 已有订阅不受这个值影响（broker 按游标继续投），表单里那句提示说的是同一件事。
    initialPosition: 'Earliest',
    autoAck: true,
    // 0 = 不限，一直收到手动停止。监听队列本来就是想知道"来消息了没有"，
    // 收满几百条就自己结束的会话反而要一直点重开。
    maxMessages: 0,
});

// 卡片与分段器都显示这一行：订阅名在前（用户认的是它），后面补消费者名或短 id，
// 同订阅多开时才有区分度。
const sessionLabel = (session: ConsumerSessionInfo): string =>
    `${session.subscription}·${session.consumerName || session.sessionId.slice(0, 8)}`;

// 积压是订阅维度的读数。取不到时显示「—」而不是 0：0 会被读成"订阅已经清空"，
// 而实际可能是订阅还不存在、或那一次 REST 没回来。
const BacklogText: React.FC<{info: BacklogInfo | null | undefined}> = ({info}) => (
    <span>
        积压 <strong>{info ? info.messageCount : '—'}</strong>
        {info ? <span className="hint-text"> / {formatBytes(info.sizeInBytes)}</span> : null}
    </span>
);

interface ConsumerWorkspaceProps {
    clusterId: string;
    tenant: string;
    namespace: string;
    topic: string;
    persistent?: boolean;
}

const ConsumerWorkspace: React.FC<ConsumerWorkspaceProps> = ({
    clusterId,
    tenant,
    namespace,
    topic,
    persistent = true,
}) => {
    const topicUri = `${persistent ? 'persistent' : 'non-persistent'}://${tenant}/${namespace}/${topic}`;
    const truncateLength = useSettingsStore(state => state.settings.truncateLength);

    const [subscription, setSubscription] = useState('');
    const [subscriptions, setSubscriptions] = useState<string[]>([]);
    const [draft, setDraft] = useState<ConsumerConfigDraft>(defaultDraft);
    const [configs, setConfigs] = useState<ConsumerSessionConfig[]>([]);
    const [currentConfigId, setCurrentConfigId] = useState<string | undefined>(undefined);
    const [configName, setConfigName] = useState('');
    const [sessions, setSessions] = useState<ConsumerSessionInfo[]>([]);
    // 会话结束（收满、出错、被 broker 断开）后卡片留着：列表里的消息还要人看，
    // 直接摘掉卡片等于把"为什么只有这几条"的线索一起删了。
    const [ended, setEnded] = useState<Record<string, SessionEndEvent['reason']>>({});
    // 认领回来的会话只知道"截至那一刻收了多少"，界面从那一刻起自己数增量。
    const [bases, setBases] = useState<Record<string, number>>({});
    const [rates, setRates] = useState<Record<string, number>>({});
    const [selected, setSelected] = useState<string | undefined>(undefined);
    const [backlogs, setBacklogs] = useState<Record<string, BacklogInfo | null>>({});
    const [starting, setStarting] = useState(false);
    // 停止不是瞬间的：consumer.close() 要等在途的 receive() 轮询返回，实测 0.4–2 秒。
    // 没有 loading 的话点了没反应，人会一直重复点。
    const [stopping, setStopping] = useState<Record<string, boolean>>({});
    const [saving, setSaving] = useState(false);
    const [detail, setDetail] = useState<Message | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [streamLimit, setStreamLimit] = useState(DEFAULT_STREAM_LIMIT);
    // 手动确认：主进程按登记表管未确认消息，这里维护一份跟着推送增、跟着确认回落的计数。
    // pending 的权威值始终来自主进程（认领、每次确认/重投的返回都会覆盖它），
    // 批次到达只是本地加一，避免"数字停在旧值、用户以为全确认了"。
    const [pending, setPending] = useState<Record<string, number>>({});
    const [resolvedSeqs, setResolvedSeqs] = useState<Record<string, Record<number, 'acked' | 'nacked'>>>({});
    const [ackBusy, setAckBusy] = useState(false);

    const sessionsRef = useRef<ConsumerSessionInfo[]>([]);
    sessionsRef.current = sessions;
    // 本页签实例的归属标识。同一个 topic 可能开着多个页签，主进程的会话表
    // 只按 cluster + topic 记录；不区分归属时，关掉一个页签会停掉另一个页签
    // 正在用的 consumer（见认领与卸载清理）。
    const ownerId = useRef(`cw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`).current;

    const owns = useCallback((sessionId: string) => sessionsRef.current.some(item => item.sessionId === sessionId), []);

    const handleSessionEnd = useCallback((event: SessionEndEvent) => {
        setEnded(current => ({...current, [event.sessionId]: event.reason}));
        if (event.reason === 'error') {
            setError(event.detail || '消费会话异常终止');
        } else if (event.reason === 'completed') {
            message.info('已收到设定的条数，会话结束');
        }
    }, []);

    // 暂停渲染不代表暂停消费：主进程那边每条都进了未确认登记表，计数必须照加，
    // 否则「全部确认」之后界面还会留着几段没人认领的"未确认"。
    const handleBatch = useCallback((batch: MessageBatch) => {
        let ackables = 0;
        for (const message of batch.messages) {
            if (message.ackable === true) {
                ackables += 1;
            }
        }
        if (ackables > 0) {
            setPending(current => ({...current, [batch.sessionId]: (current[batch.sessionId] ?? 0) + ackables}));
        }
    }, []);

    const {buckets, counts, dropped, paused, setPaused, clear} = useMessageStream({
        owns,
        limit: streamLimit,
        onSessionEnd: handleSessionEnd,
        onBatch: handleBatch,
    });

    // 每秒取一次速率：主进程不推消费统计，界面按"这一秒多了几条"自己算，
    // 读数与列表来自同一批推送，不会出现两个互相对不上的条数。
    const countsRef = useRef(counts);
    countsRef.current = counts;
    const basesRef = useRef(bases);
    basesRef.current = bases;
    useEffect(() => {
        const samples: Record<string, number> = {};
        const timer = window.setInterval(() => {
            // 没有会话就不要每秒空写一次 state（整棵树跟着重渲染）；页签在后台时
            // 也停表，但 samples 仍要跟上新读数，否则回到前台第一秒的速率虚高。
            const seenNow: Record<string, number> = {};
            for (const session of sessionsRef.current) {
                seenNow[session.sessionId] =
                    (basesRef.current[session.sessionId] || 0) + (countsRef.current[session.sessionId] || 0);
            }
            if (sessionsRef.current.length === 0 || document.hidden) {
                for (const [sessionId, seen] of Object.entries(seenNow)) {
                    samples[sessionId] = seen;
                }
                return;
            }
            const next: Record<string, number> = {};
            for (const [sessionId, seen] of Object.entries(seenNow)) {
                const prev = samples[sessionId];
                next[sessionId] = prev === undefined ? 0 : Math.max(0, seen - prev);
                samples[sessionId] = seen;
            }
            setRates(next);
        }, 1000);
        return () => window.clearInterval(timer);
    }, []);

    const receivedOf = useCallback(
        (session: ConsumerSessionInfo) => (bases[session.sessionId] || 0) + (counts[session.sessionId] || 0),
        [bases, counts],
    );

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
            }
        } catch {
            // 订阅列表只是下拉候选，拉不到不影响手输订阅名，这里不打扰用户
        }
    }, [clusterId, tenant, namespace, topic, persistent]);

    useEffect(() => {
        void fetchSubscriptions();
    }, [fetchSubscriptions]);

    const reloadConfigs = useCallback(async () => {
        try {
            const response = await window.electronAPI.consumerConfig.list({clusterId, topicUri});
            if (response.success) {
                setConfigs(response.data || []);
            } else {
                message.error(response.error || '读取消费配置失败');
            }
        } catch (listError) {
            message.error(listError instanceof Error ? listError.message : String(listError));
        }
    }, [clusterId, topicUri]);

    useEffect(() => {
        void reloadConfigs();
    }, [reloadConfigs]);

    // 重新进入页签时认领已经在跑的会话：切页签只是 display:none，主进程那边的 consumer
    // 还在收，不认领就会出现"卡片没了，再开同订阅的却被独占模式拒绝"。
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const response = await window.electronAPI.consumer.listSessions(clusterId);
                if (cancelled || !response.success) {
                    return;
                }
                const mine = (response.data || []).filter(
                    item => item.topicUri === topicUri && item.ownerId === ownerId,
                );
                if (mine.length === 0) {
                    return;
                }
                setBases(current => {
                    const next = {...current};
                    for (const item of mine) {
                        if (!(item.sessionId in next)) {
                            next[item.sessionId] = item.received;
                        }
                    }
                    return next;
                });
                // 认领回来的手动会话只知道"主进程此刻压着几条未确认"，从这里接上计数
                setPending(current => {
                    const next = {...current};
                    for (const item of mine) {
                        if (!(item.sessionId in next)) {
                            next[item.sessionId] = item.pendingAcks;
                        }
                    }
                    return next;
                });
                setSessions(current => {
                    const known = new Set(current.map(item => item.sessionId));
                    const added = mine.filter(item => !known.has(item.sessionId));
                    return added.length ? [...current, ...added] : current;
                });
            } catch {
                // 列举失败按"没有会话"处理：连接状态未知也比把正在跑的会话藏起来强
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [clusterId, topicUri, ownerId]);

    // 关页签即停会话。生产者那边留着连接只是多占一条 producer，这里留着却会继续吃订阅
    // 的投递并自动确认——界面已经不在了，消息却被一条条吞掉，必须停。
    // 只停自己认领的这批：sessions 从认领到新建都带 ownerId。
    useEffect(
        () => () => {
            for (const session of sessionsRef.current) {
                void window.electronAPI.consumer.stop(session.sessionId);
            }
        },
        [],
    );

    const sessionNames = useMemo(() => sessions.map(item => item.subscription), [sessions]);

    const refreshBacklog = useCallback(
        async (names: string[]) => {
            const unique = Array.from(new Set(names.filter(Boolean)));
            if (unique.length === 0) {
                setBacklogs({});
                return;
            }
            const results = await Promise.all(
                unique.map(async name => {
                    try {
                        const response = await window.electronAPI.messages.getBacklog({
                            clusterId,
                            tenant,
                            namespace,
                            topic,
                            persistent,
                            subscription: name,
                        });
                        // 订阅不存在或 REST 报错时读数就是「不知道」，不能写成 0——
                        // 0 会被读成「没有积压」。
                        return [name, response.success && response.data ? response.data : null] as const;
                    } catch {
                        return [name, null] as const;
                    }
                }),
            );
            setBacklogs(current => ({...current, ...Object.fromEntries(results)}));
        },
        [clusterId, tenant, namespace, topic, persistent],
    );

    // 会话集合一变就取一次积压（新建、认领、移除都算），之后靠手动刷新
    const backlogKey = sessionNames.join('|');
    useEffect(() => {
        void refreshBacklog(backlogKey ? backlogKey.split('|') : []);
    }, [refreshBacklog, backlogKey]);

    // 选中项跟着会话走：新增选中第一条，移除后回落到剩下的第一条
    useEffect(() => {
        setSelected(current =>
            current && sessions.some(item => item.sessionId === current) ? current : sessions[0]?.sessionId,
        );
    }, [sessions]);

    const confirmSharedSubscription = (name: string) =>
        new Promise<boolean>(resolve => {
            const api = themedModal();
            if (!api) {
                resolve(true);
                return;
            }
            api.confirm({
                title: '这个订阅已经有会话在跑',
                content: `再开一条「${name}」的会话，broker 会把投递分摊给两条，各自只看到一部分消息。继续？`,
                okText: '继续开',
                cancelText: '取消',
                onOk: () => resolve(true),
                onCancel: () => resolve(false),
            });
        });

    const startSession = async () => {
        const name = subscription.trim();
        if (!NAME_PATTERN.test(name)) {
            setError('订阅名只能有字母、数字、点、下划线和连字符');
            return;
        }
        const running = sessions.filter(item => item.subscription === name && !ended[item.sessionId]);
        if (running.length > 0 && !(await confirmSharedSubscription(name))) {
            return;
        }
        setStarting(true);
        setError(null);
        try {
            const response = await window.electronAPI.consumer.start({
                clusterId,
                tenant,
                namespace,
                topic,
                persistent,
                subscription: name,
                ...draft,
                ownerId,
            });
            if (response.success && response.data) {
                const info = response.data;
                setBases(current => ({...current, [info.sessionId]: info.received}));
                setPending(current => ({...current, [info.sessionId]: info.pendingAcks}));
                setSessions(current => [...current, info]);
                setSelected(info.sessionId);
                message.success(`开始消费：${info.subscription}`);
            } else {
                setError(response.error || '开始消费失败');
            }
        } catch (startError) {
            setError(startError instanceof Error ? startError.message : String(startError));
        } finally {
            setStarting(false);
        }
    };

    const forget = (sessionId: string, subscriptionName?: string) => {
        setSessions(current => current.filter(item => item.sessionId !== sessionId));
        setEnded(current => {
            const {[sessionId]: _gone, ...rest} = current;
            return rest;
        });
        setBases(current => {
            const {[sessionId]: _gone, ...rest} = current;
            return rest;
        });
        setPending(current => {
            const {[sessionId]: _gone, ...rest} = current;
            return rest;
        });
        setResolvedSeqs(current => {
            const {[sessionId]: _gone, ...rest} = current;
            return rest;
        });
        clear(sessionId);
        if (subscriptionName) {
            void refreshBacklog([subscriptionName]);
        }
    };

    const stopSession = async (session: ConsumerSessionInfo) => {
        // 先停主进程再摘卡片：反过来的话停止请求在路上时，界面上已经找不到这条会话了
        setStopping(current => ({...current, [session.sessionId]: true}));
        try {
            const response = await window.electronAPI.consumer.stop(session.sessionId);
            if (response.success) {
                // stopped:false 表示主进程那边已经没有这条会话（自己收满/出错结束了），
                // 按已停止展示仍是真话；只有请求失败时不能这么写。
                setEnded(current => ({...current, [session.sessionId]: 'stopped'}));
                void refreshBacklog([session.subscription]);
            } else {
                // 失败时保持运行态：主进程的 consumer 可能还在吃消息，标成已停止
                // 会让用户以为订阅已经释放，下次开同订阅 Exclusive 才撞上"已有会话"。
                message.warning(response.error || '停止会话失败，会话可能仍在运行，可再次点击停止');
            }
        } catch (error) {
            message.error(
                `停止会话失败，会话可能仍在运行，可再次点击停止：${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        } finally {
            setStopping(current => {
                const {[session.sessionId]: _gone, ...rest} = current;
                return rest;
            });
        }
    };

    const applyConfig = (config: ConsumerSessionConfig) => {
        setCurrentConfigId(config.id);
        setConfigName(config.name);
        setSubscription(config.subscription);
        setDraft({
            subscriptionType: config.subscriptionType,
            initialPosition: config.initialPosition,
            autoAck: config.autoAck,
            maxMessages: config.maxMessages,
            receiverQueueSize: config.receiverQueueSize,
            ackTimeoutMs: config.ackTimeoutMs,
            nAckRedeliverTimeoutMs: config.nAckRedeliverTimeoutMs,
            consumerName: config.consumerName,
            deadLetter: config.deadLetter,
        });
    };

    const persistConfig = async (id?: string) => {
        const name = configName.trim() || subscription.trim();
        if (!name) {
            message.warning('先给这份配置起个名字');
            return;
        }
        if (!NAME_PATTERN.test(subscription.trim())) {
            message.warning('订阅名不合法，存配置前先修好');
            return;
        }
        setSaving(true);
        try {
            const params = {
                id,
                clusterId,
                topicUri,
                subscription: subscription.trim(),
                name,
                ...draft,
            };
            const response = id
                ? await window.electronAPI.consumerConfig.update(params)
                : await window.electronAPI.consumerConfig.create(params);
            if (response.success && response.data) {
                setCurrentConfigId(response.data.id);
                setConfigName(response.data.name);
                void reloadConfigs();
                message.success(id ? `已更新「${response.data.name}」` : `已保存配置：${response.data.name}`);
            } else {
                // 同 topic 下重名会被唯一索引拒掉，这句错误必须原样送到：
                // 只报"保存失败"用户会去查集群连接。
                message.error(response.error || '保存失败');
            }
        } catch (saveError) {
            message.error('保存失败');
            console.error('Failed to save consumer config:', saveError);
        } finally {
            setSaving(false);
        }
    };

    const copyConfig = async (id: string) => {
        const response = await window.electronAPI.consumerConfig.copy({id});
        if (response.success && response.data) {
            void reloadConfigs();
            applyConfig(response.data);
            message.success(`已复制为「${response.data.name}」`);
        } else {
            message.error(response.error || '复制失败');
        }
    };

    const removeConfig = async (id: string) => {
        const response = await window.electronAPI.consumerConfig.delete(id);
        if (response.success) {
            if (currentConfigId === id) {
                setCurrentConfigId(undefined);
                setConfigName('');
            }
            void reloadConfigs();
        } else {
            message.error(response.error || '删除失败');
        }
    };

    const messages = selected ? buckets[selected] || [] : [];
    const selectedSession = sessions.find(item => item.sessionId === selected);
    const selectedDropped = selected ? dropped[selected] || 0 : 0;

    // 手动确认只在"还活着的非 autoAck 会话"上开放：会话结束后主进程的登记表已随
    // 会话销毁，按钮留着只会让用户点出一串"会话不存在"。
    const manualAck = !!selectedSession && !selectedSession.autoAck && !ended[selectedSession.sessionId];
    // broker 只接受 Exclusive/Failover 的累计确认（Shared 上必被拒），按钮同步收敛。
    const cumulativeAllowed =
        !!selectedSession &&
        (selectedSession.subscriptionType === 'Exclusive' || selectedSession.subscriptionType === 'Failover');

    const markResolved = (sessionId: string, seqs: number[], state: 'acked' | 'nacked') => {
        if (seqs.length === 0) {
            return;
        }
        setResolvedSeqs(current => {
            const bucket = {...(current[sessionId] || {})};
            for (const seq of seqs) {
                bucket[seq] = state;
            }
            return {...current, [sessionId]: bucket};
        });
    };

    // 界面上这批里还没处理过的序号：累计确认与「全部确认」都要按这个回写行状态，
    // 已经重投过的行不能被后面的批量操作改写成"已确认"。
    const unresolvedSeqs = (upperBound: number, onlyAckable: boolean) => {
        const resolved = selected ? resolvedSeqs[selected] : undefined;
        const seqs: number[] = [];
        for (const message of messages) {
            const seq = message.ackSeq;
            if (seq === undefined || seq > upperBound || (onlyAckable && message.ackable !== true)) {
                continue;
            }
            if (!resolved?.[seq]) {
                seqs.push(seq);
            }
        }
        return seqs;
    };

    const ackRows = async (seqs: number[], cumulative: boolean) => {
        if (!selectedSession) {
            return;
        }
        const sessionId = selectedSession.sessionId;
        setAckBusy(true);
        try {
            const response = await window.electronAPI.consumer.ack({sessionId, seqs, cumulative});
            const info = response.data;
            if (response.success && info) {
                setPending(current => ({...current, [sessionId]: info.pendingAcks}));
                // 累计确认按 broker 游标把它之前的全部带走，界面里这些行一起翻绿；
                // 逐条确认只翻选中的那几条。
                markResolved(sessionId, cumulative ? unresolvedSeqs(Math.max(...seqs), false) : seqs, 'acked');
            } else {
                message.error(response.error || '确认失败');
            }
        } catch (ackError) {
            message.error(ackError instanceof Error ? ackError.message : String(ackError));
        } finally {
            setAckBusy(false);
        }
    };

    const nackRow = async (seq: number) => {
        if (!selectedSession) {
            return;
        }
        const sessionId = selectedSession.sessionId;
        setAckBusy(true);
        try {
            const response = await window.electronAPI.consumer.nack({sessionId, seqs: [seq]});
            const info = response.data;
            if (response.success && info) {
                setPending(current => ({...current, [sessionId]: info.pendingAcks}));
                markResolved(sessionId, [seq], 'nacked');
                // 重投后很快会以新序号回到列表尾部，积压读数也要跟一下
                void refreshBacklog([selectedSession.subscription]);
            } else {
                message.error(response.error || '重投失败');
            }
        } catch (nackError) {
            message.error(nackError instanceof Error ? nackError.message : String(nackError));
        } finally {
            setAckBusy(false);
        }
    };

    // 空 seqs = 主进程登记表里的全部；界面只把可确认的行标成已确认，
    // 超窗口那几条 broker 那边确实没被确认，不能跟着翻绿。
    const ackAll = async () => {
        if (!selectedSession) {
            return;
        }
        const sessionId = selectedSession.sessionId;
        setAckBusy(true);
        try {
            const response = await window.electronAPI.consumer.ack({sessionId, seqs: [], cumulative: false});
            const info = response.data;
            if (response.success && info) {
                setPending(current => ({...current, [sessionId]: info.pendingAcks}));
                markResolved(sessionId, unresolvedSeqs(Number.MAX_SAFE_INTEGER, true), 'acked');
            } else {
                message.error(response.error || '确认失败');
            }
        } catch (ackError) {
            message.error(ackError instanceof Error ? ackError.message : String(ackError));
        } finally {
            setAckBusy(false);
        }
    };

    const doExport = (format: 'json' | 'csv') => {
        if (messages.length === 0) {
            message.warning('当前会话还没有收到消息');
            return;
        }
        const payload = buildMessagesExport(messages, format);
        downloadBlob(payload.content, messagesExportFilename(topic, format), payload.mimeType);
    };

    return (
        <PageShell
            actions={
                <Space wrap size="small">
                    <span className="field-label">{topicUri}</span>
                    <AutoComplete
                        aria-label="订阅名"
                        size="small"
                        style={{width: 190}}
                        value={subscription}
                        onChange={setSubscription}
                        options={subscriptions.map(item => ({value: item}))}
                        placeholder="订阅名（可选已有的）"
                    />
                    <Button
                        size="small"
                        type="primary"
                        icon={<PlayCircleOutlined />}
                        loading={starting}
                        onClick={() => void startSession()}
                    >
                        开始消费
                    </Button>
                </Space>
            }
        >
            <ErrorBanner error={error} onClose={() => setError(null)} />
            <div className="consumer-layout">
                <div className="consumer-form">
                    <Space wrap size="small">
                        <span className="field-label">配置</span>
                        <Select
                            aria-label="选择消费配置"
                            size="small"
                            style={{width: 240}}
                            placeholder={configs.length ? '选择已保存的配置' : '配置库为空'}
                            value={currentConfigId}
                            onChange={value => {
                                const config = configs.find(item => item.id === value);
                                if (config) {
                                    applyConfig(config);
                                }
                            }}
                            options={configs.map(item => ({
                                value: item.id,
                                label: `${item.name}（${item.subscription}）`,
                            }))}
                        />
                        <Input
                            aria-label="配置名称"
                            size="small"
                            style={{width: 150}}
                            value={configName}
                            onChange={event => setConfigName(event.target.value)}
                            placeholder="配置名称"
                        />
                        {currentConfigId ? (
                            <Button
                                size="small"
                                icon={<SaveOutlined />}
                                loading={saving}
                                onClick={() => void persistConfig(currentConfigId)}
                            >
                                更新
                            </Button>
                        ) : (
                            <Button
                                size="small"
                                icon={<SaveOutlined />}
                                loading={saving}
                                onClick={() => void persistConfig()}
                            >
                                保存
                            </Button>
                        )}
                        <Button
                            size="small"
                            icon={<CopyOutlined />}
                            disabled={!currentConfigId}
                            onClick={() => currentConfigId && void copyConfig(currentConfigId)}
                        >
                            另存副本
                        </Button>
                        <Popconfirm
                            title="删除这份配置？"
                            description="只删本地配置库里的这一条，正在跑的会话不受影响。"
                            okText="删除"
                            okButtonProps={{danger: true}}
                            onConfirm={() => currentConfigId && void removeConfig(currentConfigId)}
                        >
                            <Button
                                size="small"
                                icon={<DeleteOutlined />}
                                disabled={!currentConfigId}
                                aria-label="删除配置"
                            />
                        </Popconfirm>
                        <Button
                            size="small"
                            icon={<ReloadOutlined />}
                            onClick={() => void reloadConfigs()}
                            aria-label="重新读取配置库"
                        />
                    </Space>
                    <ConsumerConfigForm value={draft} onChange={setDraft} />
                </div>

                <div className="consumer-side">
                    <div className="opt-group-title">消费会话</div>
                    {sessions.length === 0 && (
                        <div className="hint-text">
                            还没有会话。「开始消费」会按左边的参数建一条常驻 consumer 并持续接收；
                            同一订阅可以多开（独占类型除外），用来看投递怎么分摊。
                        </div>
                    )}
                    {sessions.map(session => {
                        const endReason = ended[session.sessionId];
                        return (
                            <div className="session-card" key={session.sessionId}>
                                <div className="summary-line">
                                    <strong>{sessionLabel(session)}</strong>
                                    {endReason ? (
                                        <Tag style={{marginRight: 0}}>
                                            {endReason === 'completed'
                                                ? '已收满'
                                                : endReason === 'error'
                                                  ? '异常结束'
                                                  : '已停止'}
                                        </Tag>
                                    ) : (
                                        <Tag color="green" style={{marginRight: 0}}>
                                            消费中
                                        </Tag>
                                    )}
                                </div>
                                <div className="summary-line metric-line">
                                    <span>{session.subscriptionType}</span>
                                    {session.autoAck ? (
                                        <span>自动确认</span>
                                    ) : (
                                        <span className="danger-text">
                                            未确认 <strong>{pending[session.sessionId] || 0}</strong> 条
                                        </span>
                                    )}
                                    <strong>{receivedOf(session)}</strong> 条
                                    <strong>{(rates[session.sessionId] ?? 0).toFixed(1)}</strong> msg/s
                                    <span>
                                        <BacklogText info={backlogs[session.subscription]} />
                                    </span>
                                </div>
                                <Space wrap size="small">
                                    <Button
                                        size="small"
                                        type={session.sessionId === selected ? 'primary' : 'default'}
                                        onClick={() => setSelected(session.sessionId)}
                                    >
                                        看消息
                                    </Button>
                                    {endReason ? (
                                        <Button
                                            size="small"
                                            icon={<ClearOutlined />}
                                            onClick={() => forget(session.sessionId, session.subscription)}
                                        >
                                            移除
                                        </Button>
                                    ) : (
                                        <Button
                                            size="small"
                                            danger
                                            loading={!!stopping[session.sessionId]}
                                            icon={<DisconnectOutlined />}
                                            onClick={() => void stopSession(session)}
                                        >
                                            停止
                                        </Button>
                                    )}
                                </Space>
                            </div>
                        );
                    })}
                </div>

                <div className="consumer-stream">
                    <div className="summary-line stream-toolbar">
                        {sessions.length > 1 && (
                            <Segmented
                                size="small"
                                value={selected || ''}
                                onChange={value => setSelected(String(value))}
                                options={sessions.map(item => ({value: item.sessionId, label: sessionLabel(item)}))}
                            />
                        )}
                        <Tooltip title="暂停只是不再往界面里塞，broker 那边还在投；期间到达的条数单独计出来">
                            <Space wrap size={2}>
                                <span className="field-label">暂停渲染</span>
                                <Switch size="small" checked={paused} onChange={setPaused} />
                            </Space>
                        </Tooltip>
                        {paused && selectedDropped > 0 && (
                            <span className="hint-text">暂停期间已到 {selectedDropped} 条（未显示）</span>
                        )}
                        <span className="field-label">保留</span>
                        <InputNumber
                            size="small"
                            min={1}
                            max={5000}
                            step={100}
                            value={streamLimit}
                            onChange={value => setStreamLimit(value || DEFAULT_STREAM_LIMIT)}
                            aria-label="界面保留条数"
                        />
                        <span className="hint-text">条</span>
                        <span className="hint-text">
                            {selectedSession ? `${selectedSession.subscription} · ` : ''}列表 {messages.length} 条
                        </span>
                        <Button
                            size="small"
                            icon={<ReloadOutlined />}
                            onClick={() => void refreshBacklog(sessionNames)}
                            aria-label="刷新积压"
                        />
                        {manualAck && (
                            <Popconfirm
                                title="确认这个会话的全部未确认消息？"
                                description="确认后 broker 不再重投这批消息；超出未确认窗口的几条不在其中。"
                                okText="全部确认"
                                onConfirm={() => void ackAll()}
                            >
                                <Button size="small" loading={ackBusy}>
                                    全部确认
                                </Button>
                            </Popconfirm>
                        )}
                        <Button size="small" icon={<DownloadOutlined />} onClick={() => doExport('json')}>
                            导出 JSON
                        </Button>
                        <Button size="small" icon={<DownloadOutlined />} onClick={() => doExport('csv')}>
                            导出 CSV
                        </Button>
                        <Button
                            size="small"
                            icon={<ClearOutlined />}
                            disabled={!selected}
                            onClick={() => selected && clear(selected)}
                        >
                            清空列表
                        </Button>
                    </div>
                    {messages.length === 0 ? (
                        <div className="hint-text stream-empty">
                            {sessions.length === 0
                                ? '还没有会话，先按上面的参数点「开始消费」。'
                                : '会话在跑，broker 还没把消息投过来（订阅已有游标时从游标继续，这里选的位置不起作用）。'}
                        </div>
                    ) : (
                        <MessageListView
                            messages={messages}
                            truncateLength={truncateLength}
                            onOpenDetail={setDetail}
                            manualAck={manualAck}
                            cumulativeAllowed={cumulativeAllowed}
                            ackBusy={ackBusy}
                            resolved={selected ? resolvedSeqs[selected] : undefined}
                            onAck={(seqs, cumulative) => void ackRows(seqs, cumulative)}
                            onNack={seq => void nackRow(seq)}
                        />
                    )}
                </div>
            </div>
            <MessageDetailModal message={detail} onClose={() => setDetail(null)} />
        </PageShell>
    );
};

export default ConsumerWorkspace;
