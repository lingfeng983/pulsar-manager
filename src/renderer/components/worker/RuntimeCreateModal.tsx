import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
    Alert,
    AutoComplete,
    Button,
    Col,
    Form,
    Input,
    InputNumber,
    Modal,
    Radio,
    Row,
    Select,
    Space,
    Typography,
} from 'antd';
import {loadTopics} from '../../hooks/resourceCache';
import {PROCESSING_GUARANTEES, FUNCTION_RUNTIMES, runtimeKindLabel} from './meta';
import type {
    PickedArchiveFile,
    PulsarBuiltinDefinition,
    PulsarFunctionRuntime,
    PulsarResourceKind,
    PulsarRuntimeCreateParams,
} from '../../types';

const {Text} = Typography;

interface Props {
    open: boolean;
    clusterId: string;
    kind: PulsarResourceKind;
    tenant: string;
    namespace: string;
    /** 页面已经取好的内置清单；为空时下拉只剩「手填类名」这一条路 */
    builtins: PulsarBuiltinDefinition[];
    onClose: () => void;
    onSubmit: (params: PulsarRuntimeCreateParams) => Promise<boolean>;
}

type PackageSource = 'url' | 'local';

interface CreateForm {
    name: string;
    builtin?: string;
    className?: string;
    source: PackageSource;
    archive?: string;
    runtime?: PulsarFunctionRuntime;
    inputs?: string[];
    output?: string;
    logTopic?: string;
    parallelism: number;
    cpu?: number;
    ramMb?: number;
    diskMb?: number;
    processingGuarantee?: string;
    userConfigText?: string;
}

// 参数那一栏只接受扁平 JSON 对象：broker 对 userConfig/configs 就是这个形状，
// 把数组或标量发过去只会得到一个 500，而不是「你填的东西不是对象」。
function parseUserConfig(
    text: string | undefined,
): {ok: true; value?: Record<string, unknown>} | {ok: false; error: string} {
    const trimmed = (text || '').trim();
    if (!trimmed) {
        return {ok: true};
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch (error) {
        return {ok: false, error: `参数不是合法 JSON：${(error as Error).message}`};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {ok: false, error: '参数必须是一个 JSON 对象，比如 {"bootstrapServers": "kafka:9092"}'};
    }
    return {ok: true, value: parsed as Record<string, unknown>};
}

// 文件名猜运行时，只为少点一次下拉：jar/nar 是 JAVA，py 是 PYTHON，
// 其余（Go 的包是编译出来的裸二进制，常常没有后缀）交回给用户自己选。
function guessRuntime(fileName: string): PulsarFunctionRuntime | undefined {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.py')) {
        return 'PYTHON';
    }
    if (lower.endsWith('.jar') || lower.endsWith('.nar')) {
        return 'JAVA';
    }
    return undefined;
}

const RuntimeCreateModal: React.FC<Props> = ({
    open,
    clusterId,
    kind,
    tenant,
    namespace,
    builtins,
    onClose,
    onSubmit,
}) => {
    const [form] = Form.useForm<CreateForm>();
    const [topics, setTopics] = useState<string[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [localError, setLocalError] = useState<string | null>(null);
    const [picked, setPicked] = useState<PickedArchiveFile | null>(null);
    const source = Form.useWatch('source', form) ?? 'url';
    const runtime = Form.useWatch('runtime', form) ?? 'JAVA';

    const scope = `${tenant}/${namespace}`;
    const topicOptions = useMemo(() => topics.map(name => ({value: name})), [topics]);
    const builtinOptions = useMemo(
        () =>
            builtins.map(item => ({
                value: item.name,
                label: item.archive ? `${item.name}（自带包）` : item.name,
            })),
        [builtins],
    );

    // Modal 的 children 不会因 open=false 卸载，表单值会留到下一次打开：
    // 上一次选的本地包、填的参数会静默带进新的一次创建。只在「打开」这一刻清空。
    const wasOpen = useRef(false);
    useEffect(() => {
        if (!open) {
            wasOpen.current = false;
            return;
        }
        if (!wasOpen.current) {
            wasOpen.current = true;
            form.resetFields();
            setPicked(null);
            setLocalError(null);
        }
        let cancelled = false;
        // topic 候选只为减少手打，取不到就当没有：创建表单不该被一次列表失败卡住
        if (clusterId && tenant && namespace) {
            void loadTopics(clusterId, tenant, namespace)
                .then(list => {
                    if (!cancelled) {
                        setTopics(list.map(item => item.name));
                    }
                })
                .catch(() => {
                    if (!cancelled) {
                        setTopics([]);
                    }
                });
        }
        return () => {
            cancelled = true;
        };
    }, [open, clusterId, tenant, namespace, form]);

    // 选内置项只代填类名：包坐标由内置清单自己带，猜一个 function://xxx 出来
    // 会创建一个「提交成功但 worker 取不到包」的函数，那比让人手填更难查。
    const applyBuiltin = useCallback(
        (name: string | undefined) => {
            const item = builtins.find(entry => entry.name === name);
            if (!item) {
                return;
            }
            const patch: Partial<CreateForm> = {className: item.className};
            if (item.archive) {
                // 内置项自带的是 worker 认识的坐标，本地文件那一档对它没有意义
                patch.archive = item.archive;
                patch.source = 'url';
                setPicked(null);
            }
            form.setFieldsValue(patch);
        },
        [builtins, form],
    );

    const pickFile = useCallback(async () => {
        setLocalError(null);
        const response = await window.electronAPI.file.pickArchive();
        if (!response.success) {
            setLocalError(response.error || '文件选择失败');
            return;
        }
        // 取消不是失败：保持原状，等用户再点一次或换一档来源
        if (!response.data) {
            return;
        }
        setPicked(response.data);
        if (kind === 'function') {
            const guessed = guessRuntime(response.data.name);
            if (guessed) {
                form.setFieldsValue({runtime: guessed});
            }
        }
    }, [kind, form]);

    const handleSubmit = useCallback(async () => {
        let values: CreateForm;
        try {
            values = await form.validateFields();
        } catch {
            return;
        }
        const useLocal = values.source === 'local';
        if (useLocal && !picked) {
            setLocalError('还没有选本地包：只填坐标或只选文件，二选一');
            return;
        }
        const parsed = parseUserConfig(values.userConfigText);
        if (!parsed.ok) {
            setLocalError(parsed.error);
            return;
        }
        setLocalError(null);
        setSubmitting(true);
        try {
            // 由页面决定关不关：创建失败时这张表单应该还开着，里面填的东西不该消失
            const done = await onSubmit({
                clusterId,
                kind,
                tenant,
                namespace,
                name: values.name.trim(),
                className: values.className?.trim() || undefined,
                archive: useLocal ? undefined : values.archive?.trim() || undefined,
                localPackagePath: useLocal ? picked?.path : undefined,
                runtime: kind === 'function' ? (values.runtime ?? 'JAVA') : undefined,
                inputs: values.inputs?.length ? values.inputs : undefined,
                output: kind === 'sink' ? undefined : values.output?.trim() || undefined,
                logTopic: values.logTopic?.trim() || undefined,
                parallelism: values.parallelism,
                cpu: values.cpu,
                ramMb: values.ramMb,
                diskMb: values.diskMb,
                processingGuarantee: values.processingGuarantee,
                userConfig: parsed.value,
            });
            if (done) {
                form.resetFields();
                setPicked(null);
            }
        } finally {
            setSubmitting(false);
        }
    }, [clusterId, kind, tenant, namespace, form, onSubmit, picked]);

    // GO 不看入口类，连接器更是从包里的 META-INF 自己认；只有 JAVA/PYTHON 少了类名会被 worker 拒。
    const needClassName = kind === 'function' && runtime !== 'GO';

    return (
        <Modal
            open={open}
            title={`新建${runtimeKindLabel(kind)}`}
            width={720}
            onCancel={onClose}
            okText="创建"
            okButtonProps={{loading: submitting}}
            onOk={() => void handleSubmit()}
        >
            {localError ? <Alert type="error" showIcon message={localError} style={{marginBottom: 12}} /> : null}
            <Text type="secondary">作用域：{scope}（要建到别处，先在页面上换命名空间）</Text>

            <Form<CreateForm> form={form} layout="vertical" style={{marginTop: 12}} disabled={submitting}>
                <Row gutter={12}>
                    <Col span={14}>
                        <Form.Item
                            name="name"
                            label="名称"
                            rules={[
                                {required: true, message: '给个名字'},
                                {pattern: /^[a-zA-Z0-9._-]+$/, message: '只能用字母、数字、点、下划线和连字符'},
                            ]}
                        >
                            <Input placeholder="order-enricher" />
                        </Form.Item>
                    </Col>
                    <Col span={10}>
                        <Form.Item name="builtin" label="内置清单" tooltip="选中后代填类名（内置项还代填包坐标）">
                            <Select
                                allowClear
                                showSearch
                                placeholder={builtins.length ? '从内置里选' : '内置清单不可用'}
                                options={builtinOptions}
                                onChange={value => applyBuiltin(value)}
                            />
                        </Form.Item>
                    </Col>
                </Row>

                {kind === 'function' ? (
                    <Form.Item
                        name="runtime"
                        label="运行时"
                        initialValue="JAVA"
                        tooltip="worker 按包字段（jar / py / go）反推运行时，这里选的就是发哪一个字段"
                    >
                        <Radio.Group options={FUNCTION_RUNTIMES} optionType="button" />
                    </Form.Item>
                ) : null}

                <Form.Item
                    name="className"
                    label="类名（className）"
                    rules={needClassName ? [{required: true, message: 'worker 按这个类名加载处理逻辑'}] : []}
                    tooltip={
                        kind === 'source' || kind === 'sink'
                            ? '连接器一般能从包里的 META-INF 认出来，留空让 worker 自己取'
                            : 'GO 的包不需要入口类'
                    }
                >
                    <Input placeholder="org.apache.pulsar.functions.builtins.FilterFunction" />
                </Form.Item>

                <Form.Item name="source" label="包来源" initialValue="url">
                    <Radio.Group
                        options={[
                            {value: 'url', label: 'worker 取到的坐标'},
                            {value: 'local', label: '本机文件'},
                        ]}
                        optionType="button"
                    />
                </Form.Item>

                {source === 'local' ? (
                    <Form.Item label="包文件" required>
                        <Space>
                            <Button onClick={() => void pickFile()}>选择文件</Button>
                            {picked ? (
                                <Text>
                                    {picked.name}（{(picked.size / 1024 / 1024).toFixed(1)}MB）
                                </Text>
                            ) : (
                                <Text type="secondary">还没选：jar / nar / py，或 Go 编译出来的裸二进制</Text>
                            )}
                        </Space>
                    </Form.Item>
                ) : (
                    <Form.Item
                        name="archive"
                        label="包坐标（archive）"
                        tooltip="内置插件是 builtin:// 或 function://，已上传的包是同类坐标，外部包是 http(s) 地址"
                        rules={[{required: true, message: '要运行就得告诉 worker 代码在哪'}]}
                    >
                        <Input placeholder="function://..." />
                    </Form.Item>
                )}

                <Form.Item name="inputs" label={kind === 'source' ? '可选输入 topic' : '输入 topic'}>
                    <Select
                        mode="tags"
                        allowClear
                        placeholder={topics.length ? '从当前命名空间的 topic 里选，或直接输入' : '输入 topic 名'}
                        options={topicOptions}
                        tokenSeparators={[',']}
                    />
                </Form.Item>

                <Row gutter={12}>
                    <Col span={12}>
                        <Form.Item
                            name="output"
                            label={kind === 'source' ? '写入 topic' : '输出 topic'}
                            tooltip="留空表示没有产出：只做副作用的函数本来就不写 topic"
                            hidden={kind === 'sink'}
                        >
                            <AutoComplete options={topicOptions} placeholder="persistent://public/default/out" />
                        </Form.Item>
                    </Col>
                    <Col span={12}>
                        <Form.Item name="logTopic" label="日志 topic">
                            <AutoComplete options={topicOptions} placeholder="留空则不单独收集" />
                        </Form.Item>
                    </Col>
                </Row>

                <Row gutter={12}>
                    <Col span={6}>
                        <Form.Item name="parallelism" label="并行度" initialValue={1}>
                            <InputNumber min={1} max={64} precision={0} style={{width: '100%'}} />
                        </Form.Item>
                    </Col>
                    <Col span={6}>
                        <Form.Item name="cpu" label="CPU" tooltip="单个实例的核数，留空按 broker 默认">
                            <InputNumber min={0.1} max={64} step={0.1} placeholder="1" style={{width: '100%'}} />
                        </Form.Item>
                    </Col>
                    <Col span={6}>
                        <Form.Item name="ramMb" label="内存 MB">
                            <InputNumber min={128} max={65536} step={128} placeholder="1024" style={{width: '100%'}} />
                        </Form.Item>
                    </Col>
                    <Col span={6}>
                        <Form.Item name="diskMb" label="磁盘 MB">
                            <InputNumber
                                min={1024}
                                max={1048576}
                                step={1024}
                                placeholder="10240"
                                style={{width: '100%'}}
                            />
                        </Form.Item>
                    </Col>
                </Row>

                <Form.Item name="processingGuarantee" label="投递保证">
                    <Select allowClear placeholder="按 broker 默认（至少一次）" options={PROCESSING_GUARANTEES} />
                </Form.Item>

                <Form.Item
                    name="userConfigText"
                    label={
                        kind === 'function' ? '参数字段（userConfig，JSON 对象）' : '连接器参数（configs，JSON 对象）'
                    }
                >
                    <Input.TextArea rows={4} placeholder='{"field": "value"}' style={{fontFamily: 'monospace'}} />
                </Form.Item>
            </Form>

            <Text type="secondary">
                {source === 'local'
                    ? '本机文件随创建请求一起发过去，worker 收到后自己落包并记住坐标：包越大这一趟越久，别关窗口。'
                    : '创建只把坐标交给 worker，取包由它完成：坐标不可达时 broker 拒绝，错误原文显示在页面上。'}
            </Text>
            {kind === 'sink' ? (
                <div>
                    <Text type="secondary">连接器的目的地在它自己的参数里配，表单上没有「输出 topic」这一项。</Text>
                </div>
            ) : null}
        </Modal>
    );
};

export default RuntimeCreateModal;
