import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Alert, Button, Card, Input, Modal, Popconfirm, Select, Space, Table, Tag, message} from 'antd';
import {DeleteOutlined, PlusOutlined, ReloadOutlined} from '@ant-design/icons';
import StateBlock from '../common/StateBlock';
import type {BrokerSchemaInfo, BrokerSchemaType, SchemaCompatibilityPolicy} from '../../types';

interface TopicSchemaTabProps {
    clusterId: string;
    tenant: string;
    namespace: string;
    topic: string;
    persistent: boolean;
    // 页签是 display:none 而非卸载，首次激活才拉数据，避免打开 Topic 页就打两组 IPC
    active: boolean;
}

const STRATEGIES: SchemaCompatibilityPolicy[] = [
    'ALWAYS',
    'BACKWARD',
    'BACKWARD_TRANSITIVE',
    'FORWARD',
    'FORWARD_TRANSITIVE',
    'FULL',
    'FULL_TRANSITIVE',
    'NEVER',
];

// 只放开文本定义能贴进去的类型：PROTOBUF/PARQUET 要二进制 descriptor，
// 放在下拉里等于让用户去撞一句看不懂的 broker 解析错误。
const CREATABLE_TYPES: {value: BrokerSchemaType; label: string}[] = [
    {value: 'STRING', label: 'STRING'},
    {value: 'JSON', label: 'JSON'},
    {value: 'AVRO', label: 'AVRO'},
    {value: 'BSON', label: 'BSON'},
];

const STRATEGY_HINT =
    'topic 级策略需要 broker 侧开启 allow-schema-storage 且为 Pulsar 3.0 及以上；' +
    '旧 broker 只能在命名空间级设置，此处会显示为继承值。';

const EXAMPLE_DEFINITION = [
    '{"type":"record","name":"Demo",',
    '"fields":[{"name":"id","type":"string"},{"name":"ts","type":"long"}]}',
].join('');

function prettyDefinition(raw?: string): string {
    if (!raw) {
        return '';
    }
    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
        // AVRO/BSON 的定义本身就是 JSON 串，认不出格式的（STRING）原样展示，不硬造缩进
        return raw;
    }
}

const TopicSchemaTab: React.FC<TopicSchemaTabProps> = ({clusterId, tenant, namespace, topic, persistent, active}) => {
    const [schema, setSchema] = useState<BrokerSchemaInfo | null>(null);
    const [strategy, setStrategy] = useState<{strategy: string | null; scope: 'topic' | 'namespace'} | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pendingStrategy, setPendingStrategy] = useState<SchemaCompatibilityPolicy>('FULL');
    const [savingStrategy, setSavingStrategy] = useState(false);
    const [createOpen, setCreateOpen] = useState(false);
    const [createType, setCreateType] = useState<BrokerSchemaType>('AVRO');
    const [definition, setDefinition] = useState('');
    const [creating, setCreating] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const loadedRef = useRef(false);
    const requestIdRef = useRef(0);

    const load = useCallback(async () => {
        const currentRequestId = ++requestIdRef.current;
        setLoading(true);
        setError(null);
        try {
            // 两条请求并行且都允许 404（未注册 schema / 不支持 topic 级策略），
            // 任一失败都不能让另一半的结果消失，所以分别吞掉再合并判断。
            const [schemaRes, strategyRes] = await Promise.all([
                window.electronAPI.resources.getSchema(clusterId, tenant, namespace, topic, persistent),
                window.electronAPI.resources.getSchemaStrategy(clusterId, tenant, namespace, topic, persistent),
            ]);
            if (currentRequestId !== requestIdRef.current) {
                return;
            }
            if (!schemaRes.success && !strategyRes.success) {
                setError(schemaRes.error || strategyRes.error || '获取 Schema 信息失败');
            } else {
                setSchema(schemaRes.success ? (schemaRes.data ?? null) : null);
                setStrategy(strategyRes.success ? (strategyRes.data ?? null) : null);
                if (strategyRes.success && strategyRes.data?.strategy) {
                    setPendingStrategy(strategyRes.data.strategy as SchemaCompatibilityPolicy);
                }
                loadedRef.current = true;
            }
        } catch (err) {
            if (currentRequestId !== requestIdRef.current) {
                return;
            }
            setError(String(err));
        } finally {
            if (currentRequestId === requestIdRef.current) {
                setLoading(false);
            }
        }
    }, [clusterId, tenant, namespace, topic, persistent]);

    useEffect(() => {
        if (active && !loadedRef.current) {
            void load();
        }
    }, [active, load]);

    const handleSaveStrategy = async () => {
        setSavingStrategy(true);
        try {
            const res = await window.electronAPI.resources.setSchemaStrategy(
                clusterId,
                tenant,
                namespace,
                topic,
                pendingStrategy,
                persistent,
            );
            if (res.success) {
                message.success('兼容性策略已更新');
                // 写完立刻回读：topic 级 PUT 在旧 broker 上可能成功但读回 UNDEFINED，
                // 只信 PUT 的返回值会把界面停在假状态上。
                await load();
            } else {
                message.error(res.error || '更新兼容性策略失败');
            }
        } finally {
            setSavingStrategy(false);
        }
    };

    const handleCreate = async () => {
        if (!definition.trim()) {
            message.warning('Schema 定义不能为空');
            return;
        }
        setCreating(true);
        try {
            const res = await window.electronAPI.resources.createSchemaVersion(
                clusterId,
                tenant,
                namespace,
                topic,
                createType,
                definition,
                persistent,
            );
            if (res.success) {
                message.success('新版本已注册');
                setCreateOpen(false);
                setDefinition('');
                await load();
            } else {
                message.error(res.error || '注册 Schema 失败');
            }
        } finally {
            setCreating(false);
        }
    };

    const handleDelete = async () => {
        setDeleting(true);
        try {
            const res = await window.electronAPI.resources.deleteSchema(
                clusterId,
                tenant,
                namespace,
                topic,
                persistent,
            );
            if (res.success) {
                message.success('Schema 已删除');
                await load();
            } else {
                message.error(res.error || '删除 Schema 失败');
            }
        } finally {
            setDeleting(false);
        }
    };

    if (!active) {
        return null;
    }

    return (
        <div className="stack">
            <Card
                title="兼容性策略"
                size="small"
                extra={
                    <Space size="small">
                        <Select
                            size="small"
                            style={{width: 200}}
                            value={pendingStrategy}
                            options={STRATEGIES.map(value => ({value, label: value}))}
                            onChange={value => setPendingStrategy(value)}
                        />
                        <Button size="small" loading={savingStrategy} onClick={() => void handleSaveStrategy()}>
                            保存
                        </Button>
                    </Space>
                }
            >
                <StateBlock loading={loading && !strategy} error={error} errorTitle="获取策略失败" onRetry={load}>
                    <div className="hint-text">
                        {strategy?.scope === 'topic'
                            ? '当前为 topic 级策略'
                            : `当前继承命名空间级策略${strategy?.strategy ? `：${strategy.strategy}` : '（未设置）'}`}
                    </div>
                    <div className="hint-text">策略决定新版本能否覆盖不兼容的旧定义。</div>
                    <div className="hint-text">{STRATEGY_HINT}</div>
                </StateBlock>
            </Card>

            <Card
                title="当前 Schema"
                size="small"
                extra={
                    <Space size="small">
                        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} />
                        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                            注册新版本
                        </Button>
                        <Popconfirm
                            title="删除该 Topic 的全部 Schema 版本？"
                            description="已落盘的消息不会丢，但后续按 Schema 解码的消费端会失败。"
                            okText="删除"
                            okButtonProps={{danger: true}}
                            onConfirm={() => void handleDelete()}
                        >
                            <Button size="small" danger icon={<DeleteOutlined />} loading={deleting} disabled={!schema}>
                                删除
                            </Button>
                        </Popconfirm>
                    </Space>
                }
            >
                <StateBlock
                    loading={loading && !schema}
                    error={error}
                    errorTitle="获取 Schema 失败"
                    onRetry={load}
                    empty={!schema}
                    emptyText="该 Topic 未注册 Schema"
                >
                    {schema ? (
                        <div className="stack">
                            <Space size="small" wrap>
                                <Tag color="blue">{schema.type}</Tag>
                                {schema.version !== undefined && <Tag>v{schema.version}</Tag>}
                                {schema.timestamp ? (
                                    <span className="hint-text">{new Date(schema.timestamp).toLocaleString()}</span>
                                ) : null}
                            </Space>
                            {Object.keys(schema.properties ?? {}).length > 0 && (
                                <Table
                                    size="small"
                                    pagination={false}
                                    rowKey="key"
                                    dataSource={Object.entries(schema.properties ?? {}).map(([key, value]) => ({
                                        key,
                                        name: key,
                                        value,
                                    }))}
                                    columns={[
                                        {title: '属性', dataIndex: 'name', width: 180},
                                        {title: '值', dataIndex: 'value'},
                                    ]}
                                />
                            )}
                            <pre className="mono" style={{whiteSpace: 'pre-wrap'}}>
                                {prettyDefinition(schema.schema)}
                            </pre>
                        </div>
                    ) : null}
                </StateBlock>
            </Card>

            {schema?.type === 'NONE' && (
                <Alert
                    type="info"
                    showIcon
                    message="Broker 记录的类型为 NONE，等价于不校验；发送时仍可先用内联 JSON Schema 兜底。"
                />
            )}

            <Modal
                title="注册 Schema 新版本"
                open={createOpen}
                onCancel={() => setCreateOpen(false)}
                onOk={() => void handleCreate()}
                okText="注册"
                confirmLoading={creating}
                width={720}
            >
                <div className="stack">
                    <Space size="small">
                        <span>类型</span>
                        <Select
                            value={createType}
                            style={{width: 160}}
                            options={CREATABLE_TYPES}
                            onChange={value => setCreateType(value)}
                        />
                    </Space>
                    <Alert
                        type="warning"
                        showIcon
                        message="新版本会受兼容性策略约束；不通过时 broker 直接拒绝，正文不会落库。"
                    />
                    <div>
                        <div className="hint-text" style={{marginBottom: 4}}>
                            定义（JSON / AVRO / BSON 填 schema 文本，STRING 可填任意标记）
                        </div>
                        <Button
                            size="small"
                            style={{marginBottom: 8}}
                            onClick={() => setDefinition(EXAMPLE_DEFINITION)}
                        >
                            填充示例
                        </Button>
                        <Input.TextArea
                            rows={12}
                            value={definition}
                            onChange={event => setDefinition(event.target.value)}
                            placeholder='{"type":"record","name":"Demo","fields":[{"name":"id","type":"string"}]}'
                        />
                    </div>
                </div>
            </Modal>
        </div>
    );
};

export default TopicSchemaTab;
