import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
    Alert,
    Button,
    Descriptions,
    Drawer,
    Form,
    Input,
    Modal,
    Segmented,
    Select,
    Space,
    Table,
    Tag,
    Tooltip,
    Typography,
    message,
} from 'antd';
import type {ColumnsType} from 'antd/es/table';
import {
    DeleteOutlined,
    FileSearchOutlined,
    PlayCircleOutlined,
    PlusOutlined,
    PoweroffOutlined,
    UndoOutlined,
    ThunderboltOutlined,
} from '@ant-design/icons';
import PageShell from '../components/common/PageShell';
import StateBlock from '../components/common/StateBlock';
import IconButton from '../components/common/IconButton';
import RuntimeCreateModal from '../components/worker/RuntimeCreateModal';
import {
    RUNTIME_KINDS,
    fullItemName,
    groupStatusMeta,
    instanceStatusMeta,
    itemKey,
    runtimeKindLabel,
    shortClass,
} from '../components/worker/meta';
import {themedModal, useConfirmDanger} from '../components/common/dangerConfirm';
import {loadNamespaces, loadTenants} from '../hooks/resourceCache';
import {useClusterStore} from '../store/cluster';
import type {
    PulsarBuiltinDefinition,
    PulsarFunctionInstance,
    PulsarResourceKind,
    PulsarRuntimeCreateParams,
    PulsarRuntimeItem,
    PulsarWorkerState,
} from '../types';

const {Text, Paragraph} = Typography;

const ACTION_LABELS: Record<'start' | 'stop' | 'restart', string> = {
    start: '启动',
    stop: '停止',
    restart: '重启',
};

// 并行度大于 1 时，「哪个实例挂了、挂在哪个 worker 上」才是有效信息，
// 所以实例行也给了启停入口：整组停掉再拉起会打断正在处理其它 topic 的实例。
function instanceColumns(
    parent: PulsarRuntimeItem,
    busy: string | null,
    onControl: (item: PulsarRuntimeItem, action: 'start' | 'stop' | 'restart', instanceId?: number) => Promise<void>,
): ColumnsType<PulsarFunctionInstance> {
    return [
        {title: '实例', key: 'id', width: 80, render: (_, row) => `#${row.instanceId}`},
        {
            title: '状态',
            key: 'status',
            width: 110,
            render: (_, row) => {
                const meta = instanceStatusMeta(row.status);
                return <Tag color={meta.color}>{meta.label}</Tag>;
            },
        },
        {title: '所在节点', key: 'worker', render: (_, row) => row.workerId || '—'},
        {title: '重启次数', key: 'restarts', width: 90, render: (_, row) => row.numRestarts ?? 0},
        {
            title: '错误',
            key: 'error',
            // 出错原因常常比状态本身长，让它换行而不是把表格撑出横向滚动
            render: (_, row) =>
                row.error ? (
                    <Text type="danger" style={{fontSize: 12}}>
                        {row.error}
                    </Text>
                ) : (
                    '—'
                ),
        },
        {
            title: '操作',
            key: 'actions',
            width: 120,
            render: (_, row) => (
                <Space size={4}>
                    {row.status === 'running' ? (
                        <IconButton
                            size="small"
                            danger
                            icon={<PoweroffOutlined />}
                            label={`停止实例 ${row.instanceId}`}
                            withTooltip={false}
                            loading={busy === `${itemKey(parent)}:${row.instanceId}:stop`}
                            onClick={() => void onControl(parent, 'stop', row.instanceId)}
                        />
                    ) : (
                        <IconButton
                            size="small"
                            icon={<PlayCircleOutlined />}
                            label={`启动实例 ${row.instanceId}`}
                            withTooltip={false}
                            loading={busy === `${itemKey(parent)}:${row.instanceId}:start`}
                            onClick={() => void onControl(parent, 'start', row.instanceId)}
                        />
                    )}
                    <IconButton
                        size="small"
                        icon={<UndoOutlined />}
                        label={`重启实例 ${row.instanceId}`}
                        withTooltip={false}
                        loading={busy === `${itemKey(parent)}:${row.instanceId}:restart`}
                        onClick={() => void onControl(parent, 'restart', row.instanceId)}
                    />
                </Space>
            ),
        },
    ];
}

// 详情抽屉里的原始配置：JSON 缩进两格直接铺开。
// 不做「可读化表格」是因为键集随 broker 版本变（连接器还有各自的 config 段），
// 猜一套列名只会让某些键看起来不存在。
function rawJson(item: PulsarRuntimeItem): string {
    try {
        return JSON.stringify(item.config.raw, null, 2);
    } catch {
        return '（这段配置无法序列化成 JSON）';
    }
}

interface Props {
    /** 从资源树或集群页打开时带上作用域；选择器仍然可改，因为函数常要跨命名空间看 */
    clusterId?: string;
    tenant?: string;
    namespace?: string;
}

const WorkerCenter: React.FC<Props> = ({clusterId: propClusterId, tenant: propTenant, namespace: propNamespace}) => {
    const confirmDanger = useConfirmDanger();
    const clusters = useClusterStore(state => state.clusters);
    const loadClusters = useClusterStore(state => state.fetchClusters);

    const [clusterId, setClusterId] = useState(propClusterId || '');
    const [tenant, setTenant] = useState(propTenant || 'public');
    const [namespace, setNamespace] = useState(propNamespace || 'default');
    const [kind, setKind] = useState<PulsarResourceKind>('function');
    const [tenants, setTenants] = useState<string[]>([]);
    const [namespaces, setNamespaces] = useState<string[]>([]);
    const [items, setItems] = useState<PulsarRuntimeItem[]>([]);
    const [worker, setWorker] = useState<PulsarWorkerState | null>(null);
    const [builtins, setBuiltins] = useState<PulsarBuiltinDefinition[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [createOpen, setCreateOpen] = useState(false);
    const [detail, setDetail] = useState<PulsarRuntimeItem | null>(null);
    const [triggerTarget, setTriggerTarget] = useState<PulsarRuntimeItem | null>(null);
    const [triggerTopic, setTriggerTopic] = useState('');
    const [triggerData, setTriggerData] = useState('');

    useEffect(() => {
        if (!clusters.length) {
            void loadClusters();
        }
    }, [clusters.length, loadClusters]);

    // 没有集群时页面是一张开不了的表单：默认落到第一个连接，
    // 而不是让用户先做一次「选集群」才能看到 worker 有没有启用。
    useEffect(() => {
        if (!clusterId && clusters.length) {
            setClusterId(clusters[0].id);
        }
    }, [clusterId, clusters]);

    // 页签已开着时从资源树再点别的命名空间，props 会变而 state 不会：
    // 这里跟着 props 走一次，否则点开的是 B、表里显示的还是 A 的函数。
    useEffect(() => {
        if (propClusterId) {
            setClusterId(propClusterId);
        }
        if (propTenant) {
            setTenant(propTenant);
        }
        if (propNamespace) {
            setNamespace(propNamespace);
        }
    }, [propClusterId, propTenant, propNamespace]);

    // 作用域候选：租户/命名空间取不到只让下拉变空，不挡住列表刷新——
    // 名字本来就可以手输（选内置项时也会带出作用域）。
    useEffect(() => {
        if (!clusterId) {
            setTenants([]);
            setNamespaces([]);
            return;
        }
        let cancelled = false;
        void loadTenants(clusterId)
            .then(list => {
                if (!cancelled) {
                    setTenants(list.map(item => item.name));
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setTenants([]);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [clusterId]);

    useEffect(() => {
        if (!clusterId || !tenant) {
            setNamespaces([]);
            return;
        }
        let cancelled = false;
        void loadNamespaces(clusterId, tenant)
            .then(list => {
                if (!cancelled) {
                    setNamespaces(list);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setNamespaces([]);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [clusterId, tenant]);

    const loadBuiltins = useCallback(async (targetCluster: string, targetKind: PulsarResourceKind) => {
        try {
            const response = await window.electronAPI.worker.listBuiltins(targetCluster, targetKind);
            if (response.success && response.data) {
                setBuiltins(response.data);
            }
        } catch {
            // 内置清单只是代填来源，失败就留空列表
        }
    }, []);

    const refresh = useCallback(async () => {
        if (!clusterId || !tenant || !namespace) {
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const stateResponse = await window.electronAPI.worker.getState(clusterId);
            if (!stateResponse.success || !stateResponse.data) {
                setError(stateResponse.error || '无法读取 Function Worker 状态');
                setWorker(null);
                return;
            }
            const state = stateResponse.data;
            setWorker(state);
            if (!state.enabled) {
                // 未启用不是错误：这一档部署本来就没有 worker，列表与内置都不必再取
                setItems([]);
                setBuiltins([]);
                return;
            }
            const [itemsResponse] = await Promise.all([
                window.electronAPI.worker.listItems({clusterId, kind, tenant, namespace}),
                loadBuiltins(clusterId, kind),
            ]);
            if (itemsResponse.success) {
                setItems(itemsResponse.data || []);
            } else {
                setError(itemsResponse.error || '列表读取失败');
                setItems([]);
            }
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    }, [clusterId, kind, namespace, tenant, loadBuiltins]);

    useEffect(() => {
        void refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clusterId, kind, namespace, tenant]);

    // 单次操作之后只刷这一条：整表刷新会把用户正在看的那一行的展开状态与滚动位置一起清掉，
    // 而启停本来就是针对一个对象的动作。
    const refreshItem = useCallback(
        async (item: PulsarRuntimeItem) => {
            const response = await window.electronAPI.worker.getItem({
                clusterId,
                kind: item.config.kind,
                tenant: item.config.tenant,
                namespace: item.config.namespace,
                name: item.config.name,
            });
            if (!response.success || !response.data) {
                return;
            }
            setItems(list => list.map(entry => (itemKey(entry) === itemKey(item) ? response.data! : entry)));
        },
        [clusterId],
    );

    const handleControl = useCallback(
        async (item: PulsarRuntimeItem, action: 'start' | 'stop' | 'restart', instanceId?: number) => {
            const key = `${itemKey(item)}:${instanceId === undefined ? 'all' : instanceId}:${action}`;
            setBusy(key);
            try {
                const response = await window.electronAPI.worker.controlItem({
                    clusterId,
                    kind: item.config.kind,
                    tenant: item.config.tenant,
                    namespace: item.config.namespace,
                    name: item.config.name,
                    action,
                    instanceId,
                });
                if (!response.success) {
                    message.error(response.error || '操作失败');
                    return;
                }
                const actionLabel = ACTION_LABELS[action];
                message.info(
                    instanceId === undefined ? `已发送${actionLabel}` : `实例 ${instanceId} 已发送${actionLabel}`,
                );
                await refreshItem(item);
            } finally {
                setBusy(null);
            }
        },
        [clusterId, refreshItem],
    );

    const handleDelete = useCallback(
        (item: PulsarRuntimeItem) => {
            confirmDanger({
                title: `删除${runtimeKindLabel(item.config.kind)}「${item.config.name}」`,
                description: '删除会把已注册的配置从 worker 移除，代码包不会被删。',
                requireExactName: item.config.name,
                onOk: async () => {
                    const response = await window.electronAPI.worker.deleteItem({
                        clusterId,
                        kind: item.config.kind,
                        tenant: item.config.tenant,
                        namespace: item.config.namespace,
                        name: item.config.name,
                    });
                    if (!response.success) {
                        throw new Error(response.error || '删除失败');
                    }
                    setItems(list => list.filter(entry => itemKey(entry) !== itemKey(item)));
                    message.success('已删除');
                },
            });
        },
        [clusterId, confirmDanger],
    );

    const handleCreate = useCallback(
        async (params: PulsarRuntimeCreateParams): Promise<boolean> => {
            const response = await window.electronAPI.worker.createItem(params);
            if (!response.success) {
                message.error(response.error || '创建失败');
                return false;
            }
            message.success(`已创建${runtimeKindLabel(params.kind)}「${params.name}」`);
            setCreateOpen(false);
            await refresh();
            return true;
        },
        [refresh],
    );

    // 打开触发面板时把函数自己的第一个输入 topic 填上：绝大多数触发就是测这条输入，
    // 让人再抄一遍只会抄错到别的 topic 上。
    const openTrigger = useCallback((item: PulsarRuntimeItem) => {
        setTriggerTarget(item);
        setTriggerTopic(item.config.inputs?.[0] || '');
        setTriggerData('');
    }, []);

    const handleTrigger = useCallback(async () => {
        if (!triggerTarget || !triggerTopic.trim()) {
            message.warning('要触发就得给出输入 topic');
            return;
        }
        const response = await window.electronAPI.worker.trigger({
            clusterId,
            tenant: triggerTarget.config.tenant,
            namespace: triggerTarget.config.namespace,
            name: triggerTarget.config.name,
            topic: triggerTopic.trim(),
            data: triggerData.length ? triggerData : undefined,
        });
        if (!response.success) {
            message.error(response.error || '触发失败');
            return;
        }
        const target = triggerTarget;
        setTriggerTarget(null);
        const output = response.data?.output || '';
        themedModal()?.info({
            title: `${target.config.name} 的返回`,
            // 空返回是常态（没有输出 topic 的函数就是空），所以这句话要说清两种可能
            content: output || 'worker 返回为空：函数没有输出 topic，或产出直接写进了目标 topic。',
            width: 640,
        });
        await refreshItem(target);
    }, [clusterId, refreshItem, triggerData, triggerTopic, triggerTarget]);

    const handleReloadBuiltins = useCallback(async () => {
        const response = await window.electronAPI.worker.reloadBuiltins(clusterId, kind);
        if (!response.success) {
            message.error(response.error || '重载失败');
            return;
        }
        message.success('内置清单已重载');
        await loadBuiltins(clusterId, kind);
    }, [clusterId, kind, loadBuiltins]);

    const columns = useMemo<ColumnsType<PulsarRuntimeItem>>(
        () => [
            {
                title: '名称',
                key: 'name',
                render: (_, item) => (
                    <Space direction="vertical" size={0}>
                        <Text strong>{item.config.name}</Text>
                        <Text type="secondary" style={{fontSize: 12}}>
                            {shortClass(item.config.className)}
                        </Text>
                    </Space>
                ),
            },
            {
                title: '状态',
                key: 'status',
                width: 170,
                render: (_, item) => {
                    const meta = groupStatusMeta(item.status);
                    return (
                        <Tooltip title={meta.detail}>
                            <Tag color={meta.color}>{meta.label}</Tag>
                        </Tooltip>
                    );
                },
            },
            {
                title: '输入 / 输出',
                key: 'flow',
                render: (_, item) => (
                    <Space direction="vertical" size={0}>
                        <Text style={{fontSize: 12}}>
                            {item.config.inputs?.length ? item.config.inputs.join(', ') : '—'}
                        </Text>
                        <Text type="secondary" style={{fontSize: 12}}>
                            → {item.config.output || '—'}
                        </Text>
                    </Space>
                ),
            },
            {
                title: '并行',
                key: 'parallelism',
                width: 70,
                render: (_, item) => item.config.parallelism ?? '—',
            },
            {
                title: '处理量',
                key: 'stats',
                width: 150,
                render: (_, item) => {
                    if (!item.stats) {
                        return '—';
                    }
                    return (
                        <Tooltip
                            title={
                                `收到 ${item.stats.received}，成功 ${item.stats.successfullyProcessed}，` +
                                `失败 ${item.stats.unsuccessfullyProcessed}，产出 ${item.stats.emitted}`
                            }
                        >
                            <Text style={{fontSize: 12}}>
                                {item.stats.processed.toLocaleString('zh-CN')} / {item.stats.exceptions}
                            </Text>
                        </Tooltip>
                    );
                },
            },
            {
                title: '操作',
                key: 'actions',
                width: 210,
                render: (_, item) => {
                    const running = item.status ? item.status.running > 0 : false;
                    return (
                        <Space size={4}>
                            {running ? (
                                <IconButton
                                    size="small"
                                    danger
                                    icon={<PoweroffOutlined />}
                                    label="停止"
                                    loading={busy === `${itemKey(item)}:all:stop`}
                                    onClick={() => void handleControl(item, 'stop')}
                                />
                            ) : (
                                <IconButton
                                    size="small"
                                    type="primary"
                                    ghost
                                    icon={<PlayCircleOutlined />}
                                    label="启动"
                                    loading={busy === `${itemKey(item)}:all:start`}
                                    onClick={() => void handleControl(item, 'start')}
                                />
                            )}
                            <IconButton
                                size="small"
                                icon={<UndoOutlined />}
                                label="重启"
                                loading={busy === `${itemKey(item)}:all:restart`}
                                onClick={() => void handleControl(item, 'restart')}
                            />
                            {item.config.kind === 'function' ? (
                                <IconButton
                                    size="small"
                                    icon={<ThunderboltOutlined />}
                                    label="触发一次"
                                    onClick={() => openTrigger(item)}
                                />
                            ) : null}
                            <IconButton
                                size="small"
                                icon={<FileSearchOutlined />}
                                label="查看配置"
                                onClick={() => setDetail(item)}
                            />
                            <IconButton
                                size="small"
                                danger
                                icon={<DeleteOutlined />}
                                label="删除"
                                onClick={() => handleDelete(item)}
                            />
                        </Space>
                    );
                },
            },
        ],
        [busy, handleControl, handleDelete, openTrigger],
    );

    const clusterOptions = useMemo(() => clusters.map(item => ({value: item.id, label: item.name})), [clusters]);
    const scopeMissing = !clusterId || !tenant || !namespace;

    return (
        <PageShell
            title="函数与连接器"
            subtitle={worker?.enabled ? `${worker.nodes.length} 个 worker 节点` : undefined}
            actions={
                <Space wrap>
                    <Select
                        style={{width: 180}}
                        placeholder="选择集群"
                        value={clusterId || undefined}
                        options={clusterOptions}
                        onChange={setClusterId}
                    />
                    <Select
                        style={{width: 150}}
                        showSearch
                        placeholder="租户"
                        value={tenant || undefined}
                        options={tenants.map(name => ({value: name, label: name}))}
                        onChange={setTenant}
                    />
                    <Select
                        style={{width: 170}}
                        showSearch
                        placeholder="命名空间"
                        value={namespace || undefined}
                        options={namespaces.map(name => ({value: name, label: name}))}
                        onChange={setNamespace}
                    />
                    <Button icon={<PlusOutlined />} onClick={() => setCreateOpen(true)} disabled={!worker?.enabled}>
                        新建
                    </Button>
                    <Button onClick={() => void handleReloadBuiltins()} disabled={!worker?.enabled}>
                        重载内置
                    </Button>
                    <Button onClick={() => void refresh()} loading={loading}>
                        刷新
                    </Button>
                </Space>
            }
        >
            <Segmented
                value={kind}
                onChange={value => setKind(value as PulsarResourceKind)}
                options={RUNTIME_KINDS.map(item => ({value: item.key, label: item.label}))}
                style={{marginBottom: 12}}
            />

            {scopeMissing ? (
                <StateBlock empty emptyText="先选集群、租户与命名空间" />
            ) : worker && !worker.enabled ? (
                <Alert
                    type="warning"
                    showIcon
                    message="这个集群没有 Function Worker"
                    description={worker.notice}
                    style={{maxWidth: 720}}
                />
            ) : (
                <StateBlock
                    loading={loading}
                    error={error}
                    onRetry={() => void refresh()}
                    empty={!loading && !error && items.length === 0}
                    emptyText={`该命名空间下没有${runtimeKindLabel(kind)}`}
                    action={
                        <Button icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                            新建{runtimeKindLabel(kind)}
                        </Button>
                    }
                >
                    <Table<PulsarRuntimeItem>
                        rowKey={item => itemKey(item)}
                        size="small"
                        columns={columns}
                        dataSource={items}
                        pagination={items.length > 20 ? {pageSize: 20, showSizeChanger: false} : false}
                        expandable={{
                            // 实例展开：并行度大于 1 时「哪个实例挂了、挂在哪个节点」才是有效信息
                            rowExpandable: item => (item.status?.instances.length ?? 0) > 0,
                            expandedRowRender: item => (
                                <Table
                                    size="small"
                                    rowKey={instance => `${itemKey(item)}#${instance.instanceId}`}
                                    columns={instanceColumns(item, busy, handleControl)}
                                    dataSource={item.status?.instances || []}
                                    pagination={false}
                                />
                            ),
                        }}
                    />
                </StateBlock>
            )}

            <RuntimeCreateModal
                open={createOpen}
                clusterId={clusterId}
                kind={kind}
                tenant={tenant}
                namespace={namespace}
                builtins={builtins}
                onClose={() => setCreateOpen(false)}
                onSubmit={handleCreate}
            />

            <Modal
                open={!!triggerTarget}
                title={`触发 ${triggerTarget?.config.name ?? ''}`}
                onCancel={() => setTriggerTarget(null)}
                onOk={() => void handleTrigger()}
                okText="触发"
                destroyOnClose
            >
                <Paragraph type="secondary" style={{fontSize: 12}}>
                    worker 会往这个 topic 投一条消息并等函数返回它的产出。留空载荷表示投一条空消息。
                </Paragraph>
                <Form layout="vertical">
                    <Form.Item label="输入 topic" required>
                        <Input
                            value={triggerTopic}
                            onChange={event => setTriggerTopic(event.target.value)}
                            placeholder="persistent://public/default/orders"
                        />
                    </Form.Item>
                    <Form.Item label="消息内容（可选）">
                        <Input.TextArea
                            rows={5}
                            value={triggerData}
                            onChange={event => setTriggerData(event.target.value)}
                            placeholder='{"orderId": 42}'
                            style={{fontFamily: 'monospace'}}
                        />
                    </Form.Item>
                </Form>
            </Modal>

            <Drawer
                open={!!detail}
                width={720}
                onClose={() => setDetail(null)}
                title={detail ? fullItemName(detail) : ''}
            >
                {detail ? (
                    <Space direction="vertical" style={{width: '100%'}} size={16}>
                        <Descriptions column={2} size="small" bordered>
                            <Descriptions.Item label="口径">{runtimeKindLabel(detail.config.kind)}</Descriptions.Item>
                            <Descriptions.Item label="类名">{detail.config.className || '—'}</Descriptions.Item>
                            <Descriptions.Item label="包坐标" span={2}>
                                {detail.config.archive || '—'}
                            </Descriptions.Item>
                            <Descriptions.Item label="输入" span={2}>
                                {detail.config.inputs?.join(', ') || '—'}
                            </Descriptions.Item>
                            <Descriptions.Item label="输出">{detail.config.output || '—'}</Descriptions.Item>
                            <Descriptions.Item label="日志 topic">{detail.config.logTopic || '—'}</Descriptions.Item>
                            <Descriptions.Item label="并行度">{detail.config.parallelism ?? '—'}</Descriptions.Item>
                            <Descriptions.Item label="投递保证">
                                {detail.config.processingGuarantee || '—'}
                            </Descriptions.Item>
                            {detail.config.kind === 'function' ? (
                                // 运行时不是 broker 单独回的一个字段，是它按 jar / py / go 哪一个非空给的
                                <Descriptions.Item label="运行时">{detail.config.runtime || '—'}</Descriptions.Item>
                            ) : null}
                            <Descriptions.Item label="CPU">{detail.config.cpu ?? '—'}</Descriptions.Item>
                            <Descriptions.Item label="内存">
                                {detail.config.ramMb ? `${detail.config.ramMb} MB` : '—'}
                            </Descriptions.Item>
                        </Descriptions>
                        <div>
                            <Paragraph strong style={{marginBottom: 8}}>
                                原始配置（broker 返回的全部字段）
                            </Paragraph>
                            <pre className="mono" style={{maxHeight: 360, overflow: 'auto'}}>
                                {rawJson(detail)}
                            </pre>
                        </div>
                    </Space>
                ) : null}
            </Drawer>
        </PageShell>
    );
};

export default WorkerCenter;
