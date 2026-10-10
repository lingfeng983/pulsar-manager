import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
    Alert,
    Button,
    Col,
    Descriptions,
    Divider,
    Form,
    InputNumber,
    Input,
    Modal,
    Progress,
    Row,
    Select,
    Space,
    Switch,
    Tag,
    Tooltip,
    Typography,
    message,
} from 'antd';
import {useClusterStore} from '../store/cluster';
import {usePluginStore, type PresetOption} from '../store/plugins';
import {loadNamespaces, loadTenants, loadTopics} from '../hooks/resourceCache';
import type {LoadTestCompression, LoadTestParams, LoadTestPhase, LoadTestProgress, Topic} from '../types';
import {shortName} from '../utils/format';

const COMPRESSION_OPTIONS: {value: LoadTestCompression; label: string}[] = [
    {value: 'None', label: '不压缩'},
    {value: 'LZ4', label: 'LZ4'},
    {value: 'Zlib', label: 'Zlib'},
    {value: 'SNAPPY', label: 'Snappy'},
    {value: 'ZSTD', label: 'ZSTD'},
];

const PHASE_TAG: Record<LoadTestPhase, {color: string; text: string}> = {
    running: {color: 'processing', text: '运行中'},
    completed: {color: 'success', text: '已完成'},
    stopped: {color: 'warning', text: '已停止'},
    error: {color: 'error', text: '出错'},
};

// 消息大小按 10 的档位显示，输入框收的仍是字节数
function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

function formatElapsed(ms: number): string {
    if (ms < 1000) return `${ms} ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
    return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
}

interface FormValues {
    clusterId: string;
    tenant: string;
    namespace: string;
    topic: string;
    producers: number;
    totalMessages: number;
    messageSizeBytes: number;
    ratePerSecond: number;
    maxInFlightPerProducer: number;
    batchingEnabled: boolean;
    compression: LoadTestCompression;
    consumeBacklog: boolean;
    subscription: string;
    unsubscribeAfterRun: boolean;
}

interface BenchmarkModalProps {
    open: boolean;
    onClose: () => void;
}

/**
 * 快速压测。生产与消费在主进程并发跑，这里只负责提交参数和显示进度——
 * 关闭弹窗不会中断压测，重新打开还能看到实时数字。
 */
const BenchmarkModal: React.FC<BenchmarkModalProps> = ({open, onClose}) => {
    const [form] = Form.useForm<FormValues>();
    const clusters = useClusterStore(state => state.clusters);
    const presets = usePluginStore(state => state.presets);
    const [presetKey, setPresetKey] = useState<string | undefined>(undefined);
    const [appliedPreset, setAppliedPreset] = useState<PresetOption | null>(null);
    const fetchClusters = useClusterStore(state => state.fetchClusters);

    const [tenants, setTenants] = useState<string[]>([]);
    const [namespaces, setNamespaces] = useState<string[]>([]);
    const [topics, setTopics] = useState<Topic[]>([]);
    const [loadingOptions, setLoadingOptions] = useState(false);
    const [starting, setStarting] = useState(false);
    const [progress, setProgress] = useState<LoadTestProgress | null>(null);

    const runIdRef = useRef<string | null>(null);
    // 级联加载各自一张代次表：三个下拉共用一个计数器的话，任何一次相邻刷新
    // 都会把对方正在飞行的响应判成"过期"，结果就是下拉永远空着
    const generationRef = useRef({tenants: 0, namespaces: 0, topics: 0});

    const clusterId = Form.useWatch('clusterId', form);
    const tenant = Form.useWatch('tenant', form);
    const namespace = Form.useWatch('namespace', form);
    const consumeBacklog = Form.useWatch('consumeBacklog', form) ?? false;

    // 进度通道在组件挂载期一直开着：压测可能比弹窗存在得更久
    useEffect(() => {
        return window.electronAPI.benchmark.onProgress(next => {
            runIdRef.current = next.runId;
            setProgress(next);
            if (next.phase !== 'running') {
                setStarting(false);
            }
        });
    }, []);

    useEffect(() => {
        if (open && clusters.length === 0) {
            void fetchClusters();
        }
    }, [open, clusters.length, fetchClusters]);

    useEffect(() => {
        if (!clusterId) {
            setTenants([]);
            return;
        }
        const generation = ++generationRef.current.tenants;
        setLoadingOptions(true);
        loadTenants(clusterId)
            .then(items => {
                if (generation !== generationRef.current.tenants) return;
                setTenants(items.map(item => item.name));
            })
            .catch(error => {
                if (generation !== generationRef.current.tenants) return;
                message.error(`加载租户失败：${(error as Error).message}`);
            })
            .finally(() => {
                if (generation === generationRef.current.tenants) setLoadingOptions(false);
            });
    }, [clusterId]);

    useEffect(() => {
        setNamespaces([]);
        if (!clusterId || !tenant) return;
        const generation = ++generationRef.current.namespaces;
        setLoadingOptions(true);
        loadNamespaces(clusterId, tenant)
            .then(items => {
                if (generation !== generationRef.current.namespaces) return;
                // 命名空间可能带 "tenant/ns" 前缀，只显示末段并保持与加载参数一致
                setNamespaces(items.map(item => item.split('/').pop() || item));
            })
            .catch(error => {
                if (generation !== generationRef.current.namespaces) return;
                message.error(`加载命名空间失败：${(error as Error).message}`);
            })
            .finally(() => {
                if (generation === generationRef.current.namespaces) setLoadingOptions(false);
            });
    }, [clusterId, tenant]);

    useEffect(() => {
        setTopics([]);
        if (!clusterId || !tenant || !namespace) return;
        const generation = ++generationRef.current.topics;
        setLoadingOptions(true);
        loadTopics(clusterId, tenant, namespace)
            .then(items => {
                if (generation !== generationRef.current.topics) return;
                setTopics(items);
            })
            .catch(error => {
                if (generation !== generationRef.current.topics) return;
                message.error(`加载 Topic 失败：${(error as Error).message}`);
            })
            .finally(() => {
                if (generation === generationRef.current.topics) setLoadingOptions(false);
            });
    }, [clusterId, tenant, namespace]);

    const running = progress?.phase === 'running';

    const handleStart = useCallback(async () => {
        let values: FormValues;
        try {
            values = await form.validateFields();
        } catch {
            return;
        }
        setStarting(true);
        setProgress(null);
        try {
            // topic 表单值存的是 topicUri，持久化标记只在这里回读；主进程按完整 URI
            // 建生产者，非持久化主题不会被静默压到 persistent 上。
            const selected = topics.find(topic => topic.topicUri === values.topic);
            if (!selected) {
                message.error('请重新选择 Topic');
                setStarting(false);
                return;
            }
            const params: LoadTestParams = {
                clusterId: values.clusterId,
                tenant: values.tenant,
                namespace: values.namespace,
                // 主进程按 tenant/namespace/topic 三段拼 URI 并校验字符集，
                // 所以这里只能提交末段名，不能把整条 topicUri 塞进去
                topic: shortName(selected.name),
                persistent: selected.persistent,
                producers: values.producers,
                totalMessages: values.totalMessages,
                messageSizeBytes: values.messageSizeBytes,
                ratePerSecond: values.ratePerSecond,
                maxInFlightPerProducer: values.maxInFlightPerProducer,
                batchingEnabled: values.batchingEnabled,
                compression: values.compression,
                consumeBacklog: values.consumeBacklog,
                subscription: values.subscription,
                unsubscribeAfterRun: values.consumeBacklog ? values.unsubscribeAfterRun : false,
            };
            const response = await window.electronAPI.benchmark.start(params);
            if (!response.success) {
                message.error(response.error || '压测启动失败');
                setStarting(false);
                return;
            }
            runIdRef.current = response.data?.runId ?? null;
            message.success(`压测已启动：${response.data?.topic}`);
        } catch (error) {
            message.error(`压测启动失败：${(error as Error).message}`);
            setStarting(false);
        }
    }, [form, topics]);

    const handleStop = useCallback(async () => {
        const runId = runIdRef.current;
        if (!runId) {
            setStarting(false);
            return;
        }
        // 运行可能已经自行结束，这里不等它——终态由进度通道送达
        void window.electronAPI.benchmark.stop(runId).catch(() => undefined);
    }, []);

    // 套用后把实际写进表单的数字摊开显示，用户不必逐个字段核对
    const presetHint = appliedPreset
        ? [
              `已套用「${appliedPreset.pluginName} · ${appliedPreset.preset.name}」`,
              `${appliedPreset.preset.params.producers} 生产者`,
              `${appliedPreset.preset.params.totalMessages} 条`,
              `${appliedPreset.preset.params.messageSizeBytes} B`,
              appliedPreset.preset.params.ratePerSecond > 0
                  ? `${appliedPreset.preset.params.ratePerSecond} msg/s`
                  : '全速',
              `在途 ${appliedPreset.preset.params.maxInFlightPerProducer}`,
              appliedPreset.preset.params.batchingEnabled ? '开批' : '关批',
              COMPRESSION_OPTIONS.find(item => item.value === appliedPreset.preset.params.compression)?.label ??
                  appliedPreset.preset.params.compression,
              appliedPreset.preset.params.consumeBacklog ? '同时消费' : null,
          ]
              .filter(Boolean)
              .join(' · ')
        : '来自已启用的插件，选中后覆盖下方压测参数';

    const percent =
        progress && progress.totalMessages > 0
            ? Math.min(100, Math.round(((progress.sent + progress.failed) / progress.totalMessages) * 100))
            : 0;

    return (
        <Modal
            title="快速压测"
            open={open}
            onCancel={onClose}
            width={860}
            footer={
                <Space>
                    <Button onClick={onClose}>关闭</Button>
                    {running ? (
                        <Button danger onClick={handleStop}>
                            停止
                        </Button>
                    ) : (
                        <Button type="primary" loading={starting} onClick={handleStart}>
                            开始压测
                        </Button>
                    )}
                </Space>
            }
        >
            <Form
                form={form}
                layout="vertical"
                initialValues={{
                    producers: 4,
                    totalMessages: 10000,
                    messageSizeBytes: 1024,
                    ratePerSecond: 0,
                    maxInFlightPerProducer: 500,
                    batchingEnabled: true,
                    compression: 'None' as LoadTestCompression,
                    consumeBacklog: false,
                    subscription: 'pm-benchmark',
                    unsubscribeAfterRun: true,
                }}
            >
                {/* 插件贡献的压测预设：只填参数，目标集群与 topic 仍由用户选 */}
                {presets.length > 0 && (
                    <Row gutter={12}>
                        <Col span={24}>
                            <Form.Item label="预设" extra={presetHint} style={{marginBottom: 12}}>
                                <Select
                                    allowClear
                                    placeholder="选择插件预设"
                                    disabled={running}
                                    value={presetKey}
                                    onChange={key => {
                                        setPresetKey(key);
                                        if (!key) {
                                            setAppliedPreset(null);
                                            return;
                                        }
                                        const option = presets.find(
                                            item => `${item.pluginId}#${item.preset.name}` === key,
                                        );
                                        if (option) {
                                            form.setFieldsValue(option.preset.params);
                                            setAppliedPreset(option);
                                        }
                                    }}
                                    options={presets.map(item => ({
                                        value: `${item.pluginId}#${item.preset.name}`,
                                        label: `${item.pluginName} · ${item.preset.name}`,
                                    }))}
                                />
                            </Form.Item>
                        </Col>
                    </Row>
                )}
                <Row gutter={12}>
                    <Col span={6}>
                        <Form.Item name="clusterId" label="集群" rules={[{required: true, message: '请选择集群'}]}>
                            <Select
                                showSearch
                                optionFilterProp="label"
                                placeholder="选择集群"
                                onChange={() => {
                                    form.setFieldsValue({tenant: undefined, namespace: undefined, topic: undefined});
                                }}
                                options={clusters.map(cluster => ({
                                    value: cluster.id,
                                    label: cluster.name || cluster.serviceUrl,
                                }))}
                            />
                        </Form.Item>
                    </Col>
                    <Col span={6}>
                        <Form.Item name="tenant" label="租户" rules={[{required: true, message: '请选择租户'}]}>
                            <Select
                                showSearch
                                placeholder="选择租户"
                                loading={loadingOptions}
                                options={tenants.map(name => ({value: name, label: name}))}
                                onChange={() => form.setFieldsValue({namespace: undefined, topic: undefined})}
                            />
                        </Form.Item>
                    </Col>
                    <Col span={6}>
                        <Form.Item
                            name="namespace"
                            label="命名空间"
                            rules={[{required: true, message: '请选择命名空间'}]}
                        >
                            <Select
                                showSearch
                                placeholder="选择命名空间"
                                loading={loadingOptions}
                                options={namespaces.map(name => ({value: name, label: name}))}
                                onChange={() => form.setFieldsValue({topic: undefined})}
                            />
                        </Form.Item>
                    </Col>
                    <Col span={6}>
                        <Form.Item name="topic" label="Topic" rules={[{required: true, message: '请选择 Topic'}]}>
                            <Select
                                showSearch
                                placeholder="选择 Topic"
                                loading={loadingOptions}
                                options={topics.map(topic => ({
                                    value: topic.topicUri,
                                    label: topic.persistent
                                        ? shortName(topic.name)
                                        : `${shortName(topic.name)}（非持久化）`,
                                }))}
                            />
                        </Form.Item>
                    </Col>
                </Row>

                <Row gutter={12}>
                    <Col span={6}>
                        <Form.Item name="producers" label="生产者数" rules={[{required: true, message: '必填'}]}>
                            <InputNumber min={1} max={32} style={{width: '100%'}} />
                        </Form.Item>
                    </Col>
                    <Col span={6}>
                        <Form.Item
                            name="totalMessages"
                            label="总条数"
                            extra="所有生产者合计"
                            rules={[{required: true, message: '必填'}]}
                        >
                            <InputNumber min={1} max={1000000} step={1000} style={{width: '100%'}} />
                        </Form.Item>
                    </Col>
                    <Col span={6}>
                        <Form.Item
                            name="messageSizeBytes"
                            label="消息大小（字节）"
                            rules={[{required: true, message: '必填'}]}
                        >
                            <InputNumber min={1} max={1048576} style={{width: '100%'}} />
                        </Form.Item>
                    </Col>
                    <Col span={6}>
                        <Form.Item name="ratePerSecond" label="限速（条/秒）" extra="0 表示不限速">
                            <InputNumber min={0} max={200000} style={{width: '100%'}} />
                        </Form.Item>
                    </Col>
                </Row>

                <Row gutter={12}>
                    <Col span={6}>
                        <Form.Item name="maxInFlightPerProducer" label="单生产者并发" extra="在途未确认的消息数">
                            <InputNumber min={1} max={2000} style={{width: '100%'}} />
                        </Form.Item>
                    </Col>
                    <Col span={6}>
                        <Form.Item name="compression" label="压缩">
                            <Select options={COMPRESSION_OPTIONS} />
                        </Form.Item>
                    </Col>
                    <Col span={5}>
                        <Form.Item name="batchingEnabled" label="批量化" valuePropName="checked">
                            <Switch />
                        </Form.Item>
                    </Col>
                    <Col span={7}>
                        <Tooltip title="开启后同轮并发消费，可看端到端；关闭则只生产">
                            <Form.Item name="consumeBacklog" label="同时消费" valuePropName="checked">
                                <Switch
                                    onChange={checked => {
                                        if (!checked) form.setFieldsValue({unsubscribeAfterRun: false});
                                        else form.setFieldsValue({unsubscribeAfterRun: true});
                                    }}
                                />
                            </Form.Item>
                        </Tooltip>
                    </Col>
                </Row>

                {consumeBacklog && (
                    <Row gutter={12}>
                        <Col span={10}>
                            <Form.Item
                                name="subscription"
                                label="订阅名"
                                rules={[
                                    {required: true, message: '请输入订阅名'},
                                    {
                                        pattern: /^[a-zA-Z0-9._:-]+$/,
                                        message: '只允许字母、数字、点、下划线、冒号和连字符',
                                    },
                                ]}
                            >
                                <Input />
                            </Form.Item>
                        </Col>
                        <Col span={6}>
                            <Form.Item name="unsubscribeAfterRun" label="结束清理订阅" valuePropName="checked">
                                <Switch />
                            </Form.Item>
                        </Col>
                    </Row>
                )}
            </Form>

            <Divider style={{margin: '8px 0 16px'}} />

            {progress ? (
                <div>
                    <Space style={{marginBottom: 8}} wrap>
                        <Tag color={PHASE_TAG[progress.phase].color}>{PHASE_TAG[progress.phase].text}</Tag>
                        <Typography.Text type="secondary">
                            已发送 {progress.sent.toLocaleString()} / {progress.totalMessages.toLocaleString()} 条
                            {progress.failed > 0 ? `，失败 ${progress.failed.toLocaleString()} 条` : ''}
                        </Typography.Text>
                    </Space>
                    <Progress
                        percent={percent}
                        status={
                            progress.phase === 'error'
                                ? 'exception'
                                : progress.phase === 'running'
                                  ? 'active'
                                  : 'normal'
                        }
                    />
                    <Descriptions size="small" column={3} style={{marginTop: 12}} bordered>
                        <Descriptions.Item label="吞吐">{progress.msgPerSec.toLocaleString()} 条/秒</Descriptions.Item>
                        <Descriptions.Item label="带宽">{progress.mbPerSec} MB/秒</Descriptions.Item>
                        <Descriptions.Item label="耗时">{formatElapsed(progress.elapsedMs)}</Descriptions.Item>
                        <Descriptions.Item label="数据量">{formatBytes(progress.bytesSent)}</Descriptions.Item>
                        <Descriptions.Item label="已消费">{progress.consumed.toLocaleString()} 条</Descriptions.Item>
                        <Descriptions.Item label="生产者">
                            {progress.producerCount} 个 × {formatBytes(progress.messageSizeBytes)}
                        </Descriptions.Item>
                        {progress.latency && (
                            <Descriptions.Item label="发送确认延迟" span={3}>
                                平均 {progress.latency.avgMs} ms ｜ P50 {progress.latency.p50Ms} ms ｜ P95{' '}
                                {progress.latency.p95Ms} ms ｜ P99 {progress.latency.p99Ms} ms ｜ 最大{' '}
                                {progress.latency.maxMs} ms（抽样 {progress.latency.count.toLocaleString()} 条）
                                <Typography.Text type="secondary">
                                    {' '}
                                    —— 从 send() 调用算到 broker 确认，在途并发越大、这个数越含排队
                                </Typography.Text>
                            </Descriptions.Item>
                        )}
                    </Descriptions>
                    {progress.error && <Alert style={{marginTop: 12}} type="error" showIcon message={progress.error} />}
                    {progress.lastError && (
                        <Alert
                            style={{marginTop: 12}}
                            type="warning"
                            showIcon
                            message={`最近一条发送失败：${progress.lastError}`}
                        />
                    )}
                </div>
            ) : (
                <Typography.Text type="secondary">
                    填写参数后点击「开始压测」。压测在后台运行，关闭本窗口不会中断，重新打开可继续查看进度。
                </Typography.Text>
            )}
        </Modal>
    );
};

export default BenchmarkModal;
