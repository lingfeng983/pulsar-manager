import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Button, InputNumber, Segmented, Space, Tag, Tooltip, message} from 'antd';
import {
    ClearOutlined,
    DisconnectOutlined,
    ExportOutlined,
    FormatPainterOutlined,
    LinkOutlined,
    SendOutlined,
} from '@ant-design/icons';
import type {MessageTemplate, ProducerOptions, ProducerRunStats, ProducerSessionInfo, TemplateVariable} from '../types';
import {defaultProducerOptions} from '../../shared/producer-defaults';
import {validateTemplate} from '../../shared/template-engine';
import PageShell from '../components/common/PageShell';
import ErrorBanner from '../components/common/ErrorBanner';
import JsonEditor, {type JsonEditorHandle} from '../components/editor/JsonEditor';
import TemplateLibrary, {type TemplateDraft} from '../components/producer/TemplateLibrary';
import VariableTable from '../components/producer/VariableTable';
import ProducerOptionsForm from '../components/producer/ProducerOptionsForm';
import PreviewPanel from '../components/producer/PreviewPanel';
import FlowPanel, {type FlowSettings} from '../components/producer/FlowPanel';
import {useCommand} from '../hooks/useKeybindings';

// 生产者工作台：左边写报文，右边管连接。
// 会话做成列表而不是"一个 topic 一条连接"，是因为同一 topic 下常常要同时挂
// 两个 producer（对比批处理开关、或者一个带路由键一个不带）；原生侧本来就允许，
// 界面只给一条会把这层能力藏起来。

const EMPTY_BODY = '{\n  "id": "${uuid()}",\n  "ts": "${now()}"\n}';

interface SessionTally {
    sent: number;
    failed: number;
    bytes: number;
    at: number;
}

interface ProducerWorkspaceProps {
    clusterId: string;
    tenant: string;
    namespace: string;
    topic: string;
    persistent?: boolean;
}

const ProducerWorkspace: React.FC<ProducerWorkspaceProps> = ({
    clusterId,
    tenant,
    namespace,
    topic,
    persistent = true,
}) => {
    const topicUri = `${persistent ? 'persistent' : 'non-persistent'}://${tenant}/${namespace}/${topic}`;

    const [draft, setDraft] = useState<TemplateDraft>({
        name: '',
        body: EMPTY_BODY,
        variables: [] as TemplateVariable[],
    });
    const [currentId, setCurrentId] = useState<string | undefined>(undefined);
    const [options, setOptions] = useState<ProducerOptions>(() => defaultProducerOptions());
    const [panel, setPanel] = useState<'variables' | 'options' | 'preview'>('variables');
    const [sessions, setSessions] = useState<ProducerSessionInfo[]>([]);
    const [tallies, setTallies] = useState<Record<string, SessionTally>>({});
    const [counts, setCounts] = useState<Record<string, number>>({});
    const [sending, setSending] = useState<Record<string, boolean>>({});
    const [starting, setStarting] = useState(false);
    const [flowBusy, setFlowBusy] = useState<Record<string, boolean>>({});
    // 只存"这一轮最后收到的那帧"：连续发送的统计是纯展示数据，落库或回放都没意义，
    // 停掉之后留在卡片上当作上一轮的读数。
    const [flowStats, setFlowStats] = useState<Record<string, ProducerRunStats>>({});
    const [oneShot, setOneShot] = useState(1);
    const [oneShotLoading, setOneShotLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const editorRef = useRef<JsonEditorHandle>(null);
    // 会话结束事件与停止操作都要读当前会话集合，放 state 会让订阅 effect 反复重订阅，
    // 中途推送就漏掉了（和消息浏览器同一个理由）。
    const sessionsRef = useRef<ProducerSessionInfo[]>([]);
    sessionsRef.current = sessions;

    const templateBody = useMemo(
        () => ({body: draft.body, variables: draft.variables, properties: draft.properties}),
        [draft.body, draft.variables, draft.properties],
    );

    const applyTemplate = useCallback((template: MessageTemplate) => {
        setCurrentId(template.id);
        setDraft({
            name: template.name,
            body: template.body,
            variables: template.variables || [],
            properties: template.properties,
        });
        // 模板里存过参数就一并带回来：不然用户换了模板，参数还是上一个的，
        // 发出去的批大小跟模板说明对不上。没存则保持当前设置不动。
        if (template.producerOptions) {
            const loaded = template.producerOptions;
            // 老的模板文件里可能存着"批量 + 分块"这对会让原生层 abort 的组合，
            // 载入时就按当前约束收一次，别等用户点发送才被 IPC 拒掉。
            setOptions(loaded.batchingEnabled && loaded.chunkingEnabled ? {...loaded, chunkingEnabled: false} : loaded);
        }
    }, []);

    // 重新进入页面时认领已经存在的会话：页签切走只是 display:none，主进程那边的
    // producer 还连着，不认领就会出现"界面上没有按钮能断开、却又新建不了"的连接。
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const response = await window.electronAPI.producer.listSessions(clusterId);
                if (cancelled || !response.success) {
                    return;
                }
                const mine = (response.data || []).filter(item => item.topicUri === topicUri);
                setSessions(current => {
                    const known = new Set(current.map(item => item.sessionId));
                    const added = mine.filter(item => !known.has(item.sessionId));
                    return added.length ? [...current, ...added] : current;
                });
            } catch {
                // 列举会话失败不该挡住页面：连接状态未知比连接断了更难说明白，
                // 但正文（写报文）此时仍然可用，只在这里静默。
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [clusterId, topicUri]);

    // 关页签即断连接：主进程不会自己收，留着下次进来还是"已有会话"。
    useEffect(
        () => () => {
            for (const session of sessionsRef.current) {
                void window.electronAPI.producer.stop(session.sessionId);
            }
        },
        [],
    );

    useEffect(() => {
        const off = window.electronAPI.messages.onSessionEnd(event => {
            if (!sessionsRef.current.some(item => item.sessionId === event.sessionId)) {
                return;
            }
            setSessions(current => current.filter(item => item.sessionId !== event.sessionId));
            // 卡片已经不在了，但终态统计帧随后还会到一帧（循环的 finally 里发的）。
            // 不摘掉的话界面上"上一轮 N 条"会一直挂在这条 topic 的下一个会话身上。
            setFlowStats(current => {
                const {[event.sessionId]: _gone, ...rest} = current;
                return rest;
            });
            if (event.reason === 'error') {
                setError(event.detail || '生产者会话异常终止');
            } else {
                message.info('生产者会话已结束');
            }
        });
        return off;
    }, []);

    // 连续发送的统计帧：只认自己这些会话的，别的 topic 的工作台推来的直接丢。
    useEffect(() => {
        const off = window.electronAPI.producer.onStats(stats => {
            if (!sessionsRef.current.some(item => item.sessionId === stats.sessionId)) {
                return;
            }
            setFlowStats(current => ({...current, [stats.sessionId]: stats}));
            if (!stats.flowRunning) {
                setFlowBusy(current => ({...current, [stats.sessionId]: false}));
            }
        });
        return off;
    }, []);

    const handleFormat = () => {
        if (!editorRef.current?.format()) {
            message.warning('正文不是合法 JSON，先修好语法再格式化');
        }
    };

    const startSession = async () => {
        const check = validateTemplate(draft.body, draft.variables);
        if (!check.ok) {
            setError(check.error || '模板校验失败');
            return;
        }
        setStarting(true);
        setError(null);
        try {
            const response = await window.electronAPI.producer.startSession({
                clusterId,
                tenant,
                namespace,
                topic,
                persistent,
                options,
            });
            if (response.success && response.data) {
                setSessions(current => [...current, response.data as ProducerSessionInfo]);
                message.success(`已连接：${response.data.producerName}`);
            } else {
                setError(response.error || '建立连接失败');
            }
        } catch (startError) {
            setError(startError instanceof Error ? startError.message : String(startError));
        } finally {
            setStarting(false);
        }
    };

    const reportFailures = (failures: {index: number; error: string}[]) => {
        if (failures.length === 0) {
            return;
        }
        // 只报前三条：一批里往往是同一个占位符写错 N 次，全列出来只是刷屏。
        const head = failures
            .slice(0, 3)
            .map(item => `第 ${item.index + 1} 条：${item.error}`)
            .join('；');
        message.warning(`${failures.length} 条未发出。${head}${failures.length > 3 ? '…' : ''}`);
    };

    const stopSession = async (sessionId: string) => {
        setSessions(current => current.filter(item => item.sessionId !== sessionId));
        try {
            const response = await window.electronAPI.producer.stop(sessionId);
            if (!response.success) {
                message.warning(response.error || '断开失败');
            }
        } catch {
            // 会话此时多半已经自行结束（网络断、集群被删），界面已经移除就不再报错
        }
    };

    const sendThrough = async (session: ProducerSessionInfo) => {
        const count = counts[session.sessionId] || 1;
        const check = validateTemplate(draft.body, draft.variables);
        if (!check.ok) {
            setError(check.error || '模板校验失败');
            return;
        }
        setSending(current => ({...current, [session.sessionId]: true}));
        setError(null);
        try {
            const response = await window.electronAPI.producer.send({
                clusterId,
                tenant,
                namespace,
                topic,
                persistent,
                sessionId: session.sessionId,
                template: templateBody,
                count,
            });
            if (response.success && response.data) {
                const result = response.data;
                reportFailures(result.failures);
                if (result.closeError) {
                    setError(result.closeError);
                }
                setTallies(current => {
                    const prev = current[session.sessionId];
                    return {
                        ...current,
                        [session.sessionId]: {
                            sent: (prev?.sent || 0) + result.messageIds.length,
                            failed: (prev?.failed || 0) + result.failures.length,
                            bytes: (prev?.bytes || 0) + result.bytes,
                            at: Date.now(),
                        },
                    };
                });
                if (result.messageIds.length > 0) {
                    message.success(
                        `已投递 ${result.messageIds.length} 条，最后一条 ${result.messageIds[result.messageIds.length - 1]}`,
                    );
                }
            } else {
                setError(response.error || '发送失败');
            }
        } catch (sendError) {
            setError(sendError instanceof Error ? sendError.message : String(sendError));
        } finally {
            setSending(current => ({...current, [session.sessionId]: false}));
        }
    };

    const flushSession = async (sessionId: string) => {
        try {
            const response = await window.electronAPI.producer.flush(sessionId);
            if (!response.success) {
                setError(response.error || 'flush 失败');
            }
        } catch (flushError) {
            setError(flushError instanceof Error ? flushError.message : String(flushError));
        }
    };

    // ========== 连续发送 ==========

    const startFlow = async (session: ProducerSessionInfo, settings: FlowSettings) => {
        const check = validateTemplate(draft.body, draft.variables);
        if (!check.ok) {
            setError(check.error || '模板校验失败');
            return;
        }
        setFlowBusy(current => ({...current, [session.sessionId]: true}));
        setError(null);
        try {
            const response = await window.electronAPI.producer.startFlow({
                sessionId: session.sessionId,
                template: templateBody,
                ratePerSecond: settings.ratePerSecond,
                totalMessages: settings.totalMessages,
                maxInFlight: settings.maxInFlight,
                stopOnError: settings.stopOnError,
            });
            if (response.success && response.data) {
                const info = response.data;
                // busy 只盖住"这一次请求在路上"：留着 true 到本轮结束，「停止」按钮
                // 会一直是 loading 态而 antd 的 loading 按钮点不动，整轮就停不下来。
                setFlowBusy(current => ({...current, [session.sessionId]: false}));
                setSessions(current => current.map(item => (item.sessionId === info.sessionId ? info : item)));
            } else {
                setError(response.error || '连续发送启动失败');
                setFlowBusy(current => ({...current, [session.sessionId]: false}));
            }
        } catch (flowError) {
            setError(flowError instanceof Error ? flowError.message : String(flowError));
            setFlowBusy(current => ({...current, [session.sessionId]: false}));
        }
    };

    const stopFlow = async (session: ProducerSessionInfo) => {
        setFlowBusy(current => ({...current, [session.sessionId]: true}));
        try {
            const response = await window.electronAPI.producer.stopFlow(session.sessionId);
            if (!response.success) {
                setError(response.error || '停止连续发送失败');
            }
        } catch (stopError) {
            setError(stopError instanceof Error ? stopError.message : String(stopError));
        } finally {
            // 终态统计帧到了会再置一次 false，这里先复位是为了"停止"按钮不转个没完：
            // 会话被外部结束（集群删除）时那种帧可能永远不来。
            setFlowBusy(current => ({...current, [session.sessionId]: false}));
        }
    };

    const setFlowRate = async (sessionId: string, ratePerSecond: number) => {
        try {
            const response = await window.electronAPI.producer.setRate({sessionId, ratePerSecond});
            if (!response.success) {
                setError(response.error || '改速率失败');
            }
        } catch (rateError) {
            setError(rateError instanceof Error ? rateError.message : String(rateError));
        }
    };

    // 不留连接的单发：只是"发一条试试"的时候，挂一条常驻 producer 反而说不清
    // 哪条 topic 还连着，所以这条路径单独存在。
    const handleOneShot = async () => {
        const check = validateTemplate(draft.body, draft.variables);
        if (!check.ok) {
            setError(check.error || '模板校验失败');
            return;
        }
        setOneShotLoading(true);
        setError(null);
        try {
            const response = await window.electronAPI.producer.sendOnce({
                clusterId,
                tenant,
                namespace,
                topic,
                persistent,
                template: templateBody,
                count: oneShot,
                options,
            });
            if (response.success && response.data) {
                reportFailures(response.data.failures);
                if (response.data.closeError) {
                    setError(response.data.closeError);
                }
                if (response.data.messageIds.length > 0) {
                    message.success(
                        `已投递 ${response.data.messageIds.length} 条（连接已关闭），最后一条 ${
                            response.data.messageIds[response.data.messageIds.length - 1]
                        }`,
                    );
                }
            } else {
                setError(response.error || '发送失败');
            }
        } catch (sendError) {
            setError(sendError instanceof Error ? sendError.message : String(sendError));
        } finally {
            setOneShotLoading(false);
        }
    };

    useCommand('sendMessage', () => {
        const first = sessionsRef.current[0];
        if (first) {
            void sendThrough(first);
        } else {
            void handleOneShot();
        }
    });

    const resetDraft = () => {
        setCurrentId(undefined);
        setDraft({name: '', body: EMPTY_BODY, variables: []});
    };

    return (
        <PageShell
            actions={
                <Space wrap size="small">
                    <span className="field-label">{topicUri}</span>
                    <Button size="small" icon={<FormatPainterOutlined />} onClick={handleFormat}>
                        格式化
                    </Button>
                    <Button size="small" icon={<ClearOutlined />} onClick={resetDraft}>
                        新建报文
                    </Button>
                    <Tooltip title="不建常驻连接，现开现关投一批（每次都要重新握手，试报文用它）">
                        <Space wrap size={2}>
                            <InputNumber
                                size="small"
                                min={1}
                                max={1000}
                                value={oneShot}
                                onChange={value => setOneShot(value || 1)}
                                style={{width: 64}}
                                aria-label="单发条数"
                            />
                            <Button
                                size="small"
                                icon={<SendOutlined />}
                                loading={oneShotLoading}
                                onClick={() => void handleOneShot()}
                            >
                                直接发送
                            </Button>
                        </Space>
                    </Tooltip>
                    <Button
                        size="small"
                        type="primary"
                        icon={<LinkOutlined />}
                        loading={starting}
                        onClick={() => void startSession()}
                    >
                        建立连接
                    </Button>
                </Space>
            }
        >
            <ErrorBanner error={error} onClose={() => setError(null)} />
            <TemplateLibrary
                clusterId={clusterId}
                topicUri={topicUri}
                draft={draft}
                producerOptions={options}
                currentId={currentId}
                onApply={applyTemplate}
                onSaved={template => setCurrentId(template.id)}
                onNameChange={name => setDraft(current => ({...current, name}))}
            />
            <div className="producer-layout">
                <div className="producer-main">
                    <JsonEditor
                        ref={editorRef}
                        value={draft.body}
                        onChange={body => setDraft(current => ({...current, body}))}
                        variables={draft.variables}
                        ariaLabel="报文模板正文"
                        height={300}
                    />
                    <Segmented
                        size="small"
                        value={panel}
                        onChange={value => setPanel(value as typeof panel)}
                        options={[
                            {value: 'variables', label: `变量 ${draft.variables.length}`},
                            {value: 'options', label: '发送参数'},
                            {value: 'preview', label: '预览'},
                        ]}
                    />
                    {panel === 'variables' && (
                        <VariableTable
                            value={draft.variables}
                            onChange={variables => setDraft(current => ({...current, variables}))}
                            body={draft.body}
                        />
                    )}
                    {panel === 'options' && <ProducerOptionsForm value={options} onChange={setOptions} />}
                    {panel === 'preview' && (
                        <PreviewPanel
                            body={draft.body}
                            variables={draft.variables}
                            seed={options.seed}
                            onSeedChange={seed => setOptions(current => ({...current, seed}))}
                        />
                    )}
                </div>
                <div className="producer-side">
                    <div className="opt-group-title">生产者会话</div>
                    {sessions.length === 0 && (
                        <div className="hint-text">
                            还没有连接。「建立连接」会挂住一条常驻 producer，之后的每次发送都复用它；
                            只想发几条就用右上角的「直接发送」。
                        </div>
                    )}
                    {sessions.map(session => {
                        const tally = tallies[session.sessionId];
                        return (
                            <div className="session-card" key={session.sessionId}>
                                <div className="summary-line">
                                    <strong>{session.producerName}</strong>
                                    {session.connected ? (
                                        <Tag color="green" style={{marginRight: 0}}>
                                            已连接
                                        </Tag>
                                    ) : (
                                        <Tag style={{marginRight: 0}}>已断开</Tag>
                                    )}
                                </div>
                                <div className="summary-line metric-line">
                                    {tally ? (
                                        <>
                                            <strong>{tally.sent}</strong> 条<strong>{tally.failed}</strong> 失败
                                            <strong>{tally.bytes}</strong> 字节
                                            <span className="hint-text">{new Date(tally.at).toLocaleTimeString()}</span>
                                        </>
                                    ) : (
                                        <span className="hint-text">尚未发送</span>
                                    )}
                                </div>
                                <Space wrap size="small">
                                    <InputNumber
                                        size="small"
                                        min={1}
                                        max={1000}
                                        value={counts[session.sessionId] || 1}
                                        onChange={value =>
                                            setCounts(current => ({...current, [session.sessionId]: value || 1}))
                                        }
                                        style={{width: 64}}
                                        aria-label="本次发送条数"
                                    />
                                    <Button
                                        size="small"
                                        type="primary"
                                        icon={<ExportOutlined />}
                                        loading={!!sending[session.sessionId]}
                                        onClick={() => void sendThrough(session)}
                                    >
                                        发送
                                    </Button>
                                    <Tooltip title="批量发送下把原生队列里的最后一段立刻推出去">
                                        <Button
                                            size="small"
                                            onClick={() => void flushSession(session.sessionId)}
                                            aria-label={`刷新队列 ${session.producerName}`}
                                        >
                                            flush
                                        </Button>
                                    </Tooltip>
                                    <Button
                                        size="small"
                                        danger
                                        icon={<DisconnectOutlined />}
                                        onClick={() => void stopSession(session.sessionId)}
                                    >
                                        断开
                                    </Button>
                                </Space>
                                <FlowPanel
                                    running={flowStats[session.sessionId]?.flowRunning ?? session.flowRunning}
                                    stats={flowStats[session.sessionId] || null}
                                    busy={!!flowBusy[session.sessionId]}
                                    onStart={settings => void startFlow(session, settings)}
                                    onStop={() => void stopFlow(session)}
                                    onSetRate={rate => void setFlowRate(session.sessionId, rate)}
                                />
                            </div>
                        );
                    })}
                </div>
            </div>
        </PageShell>
    );
};

export default ProducerWorkspace;
