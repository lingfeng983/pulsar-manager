import React, {useState, useEffect} from 'react';
import {
    Modal,
    Form,
    Input,
    InputNumber,
    Select,
    Switch,
    Button,
    Space,
    Steps,
    message,
    Alert,
    Divider,
    Row,
    Col,
    Tag,
} from 'antd';
import {
    ClusterOutlined,
    LockOutlined,
    SettingOutlined,
    CheckCircleOutlined,
    CloseCircleOutlined,
    ApiOutlined,
} from '@ant-design/icons';
import type {ClusterConfig} from '../types';

const {Option} = Select;

interface ClusterConfigModalProps {
    open: boolean;
    onCancel: () => void;
    onSuccess: () => void;
    editingCluster?: ClusterConfig | null;
}

// 表单里只放可编辑的隧道字段；摘要中的 hasPassword / tunnelActive 是只读标记，
// 回填表单会把它们当成输入值再发回主进程。
function sshFormValues(ssh?: ClusterConfig['ssh']) {
    if (!ssh) {
        return undefined;
    }
    return {
        host: ssh.host,
        port: ssh.port,
        username: ssh.username,
        authType: ssh.authType,
        remoteHost: ssh.remoteHost,
    };
}

// K8s 那边没有"已配置凭据"的标记（凭据在 kubeconfig 文件里，不在本应用），
// 所以除 forwardActive 之外都能回填。
function k8sFormValues(k8s?: ClusterConfig['k8s']) {
    if (!k8s) {
        return undefined;
    }
    return {
        namespace: k8s.namespace,
        resource: k8s.resource,
        context: k8s.context,
        kubeconfigPath: k8s.kubeconfigPath,
        kubectlPath: k8s.kubectlPath,
    };
}

const ClusterConfigModal: React.FC<ClusterConfigModalProps> = ({open, onCancel, onSuccess, editingCluster}) => {
    const [form] = Form.useForm();
    const [currentStep, setCurrentStep] = useState(0);
    const [loading, setLoading] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{connected: boolean; version?: string} | null>(null);
    const [tunnelTesting, setTunnelTesting] = useState(false);
    const [tunnelResult, setTunnelResult] = useState<{ok: boolean; text: string} | null>(null);
    const [forwardTesting, setForwardTesting] = useState(false);
    const [forwardResult, setForwardResult] = useState<{ok: boolean; text: string} | null>(null);

    useEffect(() => {
        if (open) {
            if (editingCluster) {
                form.setFieldsValue({
                    ...editingCluster,
                    ssh: sshFormValues(editingCluster.ssh),
                    k8s: k8sFormValues(editingCluster.k8s),
                });
            } else {
                form.resetFields();
                form.setFieldsValue({
                    serviceUrl: 'pulsar://localhost:6650',
                    webServiceUrl: 'http://localhost:8080',
                    adminApiTimeout: 5000,
                    tlsEnabled: false,
                    useSshTunnel: false,
                    ssh: {port: 22, authType: 'password'},
                    useK8sForward: false,
                });
            }
            setCurrentStep(0);
            setTestResult(null);
            setTunnelResult(null);
            setForwardResult(null);
        }
    }, [open, editingCluster, form]);

    // 经隧道的集群，测试连接会先按当前隧道参数建立转发；主进程把落库后的
    // 隧道 id 回传，这里回填表单，避免"测一次存一条、保存再存一条"。
    const handleTestConnection = async () => {
        try {
            await form.validateFields(connectionTestFields());
        } catch {
            return;
        }
        const values = form.getFieldsValue(true);
        setTesting(true);
        setTestResult(null);

        try {
            const response = await window.electronAPI.cluster.testConnection(values);
            // 失败时主进程同样回传它建立/落库的通道 id：连不上不代表转发没建，
            // 不接住这条 id，保存时会再落一条重复的配置。
            if (response.data?.sshConfigId) {
                form.setFieldValue('sshConfigId', response.data.sshConfigId);
            }
            if (response.data?.k8sConfigId) {
                form.setFieldValue('k8sConfigId', response.data.k8sConfigId);
            }
            if (response.success && response.data) {
                setTestResult(response.data);
                message.success('连接成功！');
            } else {
                setTestResult({connected: false});
                message.error(response.error || '连接失败');
            }
        } catch (error) {
            setTestResult({connected: false});
            message.error(error instanceof Error ? error.message : '连接测试失败');
        } finally {
            setTesting(false);
        }
    };

    const handleTestTunnel = async () => {
        try {
            await form.validateFields([
                ['ssh', 'host'],
                ['ssh', 'username'],
                ['ssh', 'authType'],
                ['ssh', 'password'],
                ['ssh', 'privateKey'],
            ]);
        } catch {
            return;
        }
        const ssh = form.getFieldValue('ssh');
        setTunnelTesting(true);
        setTunnelResult(null);
        try {
            const response = await window.electronAPI.ssh.connect({
                ...ssh,
                id: form.getFieldValue('sshConfigId') || editingCluster?.sshConfigId,
            });
            if (response.success && response.data) {
                form.setFieldValue('sshConfigId', response.data.tunnelId);
                const admin = `127.0.0.1:${response.data.localPort}`;
                const broker = `127.0.0.1:${response.data.localBrokerPort}`;
                setTunnelResult({ok: true, text: `隧道已建立：Admin ${admin}，Broker ${broker}`});
            } else {
                setTunnelResult({ok: false, text: response.error || '隧道建立失败'});
            }
        } catch (error) {
            setTunnelResult({ok: false, text: error instanceof Error ? error.message : '隧道建立失败'});
        } finally {
            setTunnelTesting(false);
        }
    };

    // 单独测一次转发：它只会证明"kubectl 能不能把这个资源的两条端口接到本地"，
    // 不碰 Pulsar 本身。集群里还没填 Admin 地址时，这一步是唯一能核对命名空间与
    // 资源名有没有写错的机会——报错也直接来自 kubectl，比 broker 的超时具体得多。
    const handleTestForward = async () => {
        try {
            await form.validateFields([
                ['k8s', 'namespace'],
                ['k8s', 'resource'],
            ]);
        } catch {
            return;
        }
        const k8s = form.getFieldValue('k8s');
        setForwardTesting(true);
        setForwardResult(null);
        try {
            const response = await window.electronAPI.k8s.connect({
                ...k8s,
                id: form.getFieldValue('k8sConfigId') || editingCluster?.k8sConfigId,
                remoteAdminPort: k8s?.remoteAdminPort || 8080,
                remoteBrokerPort: k8s?.remoteBrokerPort || 6650,
            });
            if (response.success && response.data) {
                form.setFieldValue('k8sConfigId', response.data.forwardId);
                const admin = `127.0.0.1:${response.data.localAdminPort}`;
                const broker = `127.0.0.1:${response.data.localBrokerPort}`;
                setForwardResult({ok: true, text: `转发已建立：Admin ${admin}，Broker ${broker}`});
            } else {
                setForwardResult({ok: false, text: response.error || '端口转发建立失败'});
            }
        } catch (error) {
            setForwardResult({ok: false, text: error instanceof Error ? error.message : '端口转发建立失败'});
        } finally {
            setForwardTesting(false);
        }
    };

    const handleSubmit = async () => {
        let allValues: ClusterConfig;
        try {
            // validateFields() 只返回"当前这一步挂载着"的字段，分步表单里前几步的值
            // 会被丢掉（保存时就表现为 name/serviceUrl 缺失）。所以校验用 validateFields，
            // 取值用整个 store。
            await form.validateFields();
            allValues = form.getFieldsValue(true) as unknown as ClusterConfig;
        } catch (error) {
            // 校验失败时字段下方已有红字提示，不要再叠一条全局 message
            if (error && typeof error === 'object' && 'errorFields' in error) {
                return;
            }
            message.error('操作失败');
            return;
        }

        try {
            setLoading(true);

            let response;
            if (editingCluster) {
                response = await window.electronAPI.cluster.update(editingCluster.id, allValues);
            } else {
                response = await window.electronAPI.cluster.add(allValues);
            }

            if (response.success) {
                message.success(editingCluster ? '集群配置已更新' : '集群添加成功');
                onSuccess();
            } else {
                message.error(response.error || '操作失败');
            }
        } catch {
            message.error('操作失败');
        } finally {
            setLoading(false);
        }
    };

    const handleCancel = () => {
        // 「测试 SSH 隧道」建立的转发是真实占着本地端口的活动连接，弹窗关掉不等于
        // 断开；只有编辑已有集群且隧道就是它自己那条时才留着（保存后还要用）。
        const testTunnelId = form.getFieldValue('sshConfigId');
        if (typeof testTunnelId === 'string' && testTunnelId && testTunnelId !== editingCluster?.sshConfigId) {
            void window.electronAPI.ssh.disconnect(testTunnelId).catch(() => {});
        }
        const testForwardId = form.getFieldValue('k8sConfigId');
        if (typeof testForwardId === 'string' && testForwardId && testForwardId !== editingCluster?.k8sConfigId) {
            void window.electronAPI.k8s.disconnect(testForwardId).catch(() => {});
        }
        form.resetFields();
        setCurrentStep(0);
        setTestResult(null);
        setTunnelResult(null);
        setForwardResult(null);
        onCancel();
    };

    const STEP_FIELDS: (string | string[])[][] = [
        ['name', 'serviceUrl', 'webServiceUrl', 'adminApiTimeout'],
        ['authPlugin', 'authParams'],
        ['useSshTunnel', 'useK8sForward'],
        ['tlsEnabled', 'tlsTrustCerts'],
    ];

    // 隧道字段只在勾选后渲染，未渲染时提交校验不到；测试连接前按开关补齐。
    const sshStepFields = (): (string | string[])[] =>
        form.getFieldValue('useSshTunnel')
            ? [
                  ['ssh', 'host'],
                  ['ssh', 'username'],
                  ['ssh', 'authType'],
                  ['ssh', 'password'],
                  ['ssh', 'privateKey'],
              ]
            : [];

    const k8sStepFields = (): (string | string[])[] =>
        form.getFieldValue('useK8sForward')
            ? [
                  ['k8s', 'namespace'],
                  ['k8s', 'resource'],
              ]
            : [];

    const connectionTestFields = (): (string | string[])[] => [
        'serviceUrl',
        'webServiceUrl',
        'authPlugin',
        'authParams',
        'tlsEnabled',
        'tlsTrustCerts',
        ...sshStepFields(),
        ...k8sStepFields(),
    ];

    const nextStep = async () => {
        const fields =
            currentStep === 2
                ? ['useSshTunnel', 'useK8sForward', ...sshStepFields(), ...k8sStepFields()]
                : STEP_FIELDS[currentStep];
        try {
            await form.validateFields(fields);
        } catch {
            return;
        }
        setCurrentStep(prev => prev + 1);
    };
    const prevStep = () => setCurrentStep(prev => prev - 1);

    const renderStep0 = () => (
        <>
            <Form.Item name="name" label="集群名称" rules={[{required: true, message: '请输入集群名称'}]}>
                <Input placeholder="例如：生产集群-A" />
            </Form.Item>

            <Form.Item
                name="serviceUrl"
                label="Broker Service URL"
                rules={[
                    {required: true, message: '请输入 Broker Service URL'},
                    {
                        // type:'url' 的正则不认 pulsar:// 这类自定义协议，必须按 scheme 白名单校验
                        pattern: /^(pulsar|pulsar\+ssl|ssl):\/\/[^\s]+$/,
                        message: '需为 pulsar://、pulsar+ssl:// 或 ssl:// 地址',
                    },
                ]}
                extra="Pulsar Broker 协议地址，如 pulsar://localhost:6650"
            >
                <Input placeholder="pulsar://localhost:6650" />
            </Form.Item>

            <Form.Item
                name="webServiceUrl"
                label="Admin API URL"
                rules={[
                    {
                        pattern: /^https?:\/\/[^\s]+$/,
                        message: '需为 http:// 或 https:// 地址',
                    },
                ]}
                extra="Pulsar Admin HTTP 地址，如 http://localhost:8080；留空则按 Broker 地址推导（6650→8080，6651→8443）"
            >
                <Input placeholder="http://localhost:8080" />
            </Form.Item>

            <Form.Item name="adminApiTimeout" label="API 超时时间" extra="单位：毫秒">
                <InputNumber min={100} max={600000} step={500} placeholder="5000" style={{width: '100%'}} />
            </Form.Item>
        </>
    );

    const renderStep1 = () => (
        <>
            <Form.Item name="authPlugin" label="认证方式">
                <Select allowClear placeholder="选择认证方式（可选）">
                    <Option value="org.apache.pulsar.client.impl.auth.AuthenticationToken">Token 认证</Option>
                    <Option value="org.apache.pulsar.client.impl.auth.AuthenticationTls">TLS 认证</Option>
                    <Option value="org.apache.pulsar.client.impl.auth.AuthenticationAthenz">Athenz 认证</Option>
                    <Option value="org.apache.pulsar.client.impl.auth.AuthenticationBasic">Basic 认证</Option>
                </Select>
            </Form.Item>

            <Form.Item noStyle shouldUpdate={(prev, curr) => prev.authPlugin !== curr.authPlugin}>
                {({getFieldValue}) =>
                    getFieldValue('authPlugin') && (
                        <Form.Item
                            name="authParams"
                            label="认证参数"
                            extra={editingCluster?.hasAuthParams ? '留空表示沿用已保存的认证参数' : undefined}
                            rules={[{required: !editingCluster?.hasAuthParams, message: '请输入认证参数'}]}
                        >
                            <Input.TextArea placeholder='{"token": "your-jwt-token"}' rows={3} />
                        </Form.Item>
                    )
                }
            </Form.Item>
        </>
    );

    const renderStep2 = () => {
        const saved = editingCluster?.ssh;
        return (
            <>
                <Form.Item
                    name="useSshTunnel"
                    label="启用 SSH 隧道"
                    valuePropName="checked"
                    extra="开启后应用会在本机随机端口起转发，Admin 与 Broker 地址都指向这条隧道"
                >
                    <Switch
                        onChange={checked => {
                            if (checked) {
                                form.setFieldValue('useK8sForward', false);
                            }
                        }}
                    />
                </Form.Item>

                {/* 拒绝发生在原生消息路径建 Client 的那一刻，等用户点发送才撞上就太晚了，
                    这里按同一条件（本地转发开 + Broker 地址是 TLS scheme）提前显出来说明 */}
                <Form.Item
                    noStyle
                    shouldUpdate={(prev, curr) =>
                        prev.useSshTunnel !== curr.useSshTunnel ||
                        prev.useK8sForward !== curr.useK8sForward ||
                        prev.serviceUrl !== curr.serviceUrl
                    }
                >
                    {({getFieldValue}) =>
                        (getFieldValue('useSshTunnel') || getFieldValue('useK8sForward')) &&
                        /^(pulsar\+ssl|ssl):\/\//.test(String(getFieldValue('serviceUrl') || '')) ? (
                            <Alert
                                type="warning"
                                showIcon
                                message="「TLS + 本地转发（SSH 隧道 / K8s 端口转发）」下消息收发不可用"
                                description={
                                    <>
                                        转发会把 Broker 地址换成 127.0.0.1，TLS
                                        证书的主机名校验必然失败，原生客户端又没有 SNI 覆盖参数可绕。管理
                                        API、命名空间与监控走 HTTP，<strong>不受影响</strong>
                                        ；只有生产/消费/读取会被拒。二选一：经转发访问时把 Broker 地址改成
                                        pulsar://（流量已在转发通道内加密），或关闭转发直连 pulsar+ssl://。
                                    </>
                                }
                                style={{marginBottom: 12}}
                            />
                        ) : null
                    }
                </Form.Item>

                <Form.Item
                    noStyle
                    shouldUpdate={(prev, curr) =>
                        prev.useSshTunnel !== curr.useSshTunnel || prev.ssh?.authType !== curr.ssh?.authType
                    }
                >
                    {({getFieldValue}) =>
                        !getFieldValue('useSshTunnel') ? null : (
                            <>
                                <Row gutter={12}>
                                    <Col span={16}>
                                        <Form.Item
                                            name={['ssh', 'host']}
                                            label="SSH 主机"
                                            rules={[{required: true, message: '请输入 SSH 主机地址'}]}
                                        >
                                            <Input placeholder="jump.example.com" />
                                        </Form.Item>
                                    </Col>
                                    <Col span={8}>
                                        <Form.Item name={['ssh', 'port']} label="端口" initialValue={22}>
                                            <InputNumber min={1} max={65535} style={{width: '100%'}} />
                                        </Form.Item>
                                    </Col>
                                </Row>

                                <Form.Item
                                    name={['ssh', 'username']}
                                    label="SSH 用户名"
                                    rules={[{required: true, message: '请输入 SSH 用户名'}]}
                                >
                                    <Input placeholder="deploy" />
                                </Form.Item>

                                <Form.Item name={['ssh', 'authType']} label="认证方式" initialValue="password">
                                    <Select>
                                        <Option value="password">密码</Option>
                                        <Option value="privateKey">私钥</Option>
                                    </Select>
                                </Form.Item>

                                {getFieldValue('ssh')?.authType === 'privateKey' ? (
                                    <>
                                        <Form.Item
                                            name={['ssh', 'privateKey']}
                                            label="SSH 私钥"
                                            rules={[
                                                {
                                                    required: !saved?.hasPrivateKey,
                                                    message: '请输入私钥内容或私钥文件路径',
                                                },
                                            ]}
                                            extra={
                                                saved?.hasPrivateKey
                                                    ? '留空表示沿用已保存的私钥'
                                                    : '可粘贴私钥内容，也可只填文件路径（如 ~/.ssh/id_rsa）'
                                            }
                                        >
                                            <Input.TextArea
                                                rows={3}
                                                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                                            />
                                        </Form.Item>
                                        <Form.Item name={['ssh', 'passphrase']} label="私钥口令">
                                            <Input.Password placeholder="私钥未加密时留空" />
                                        </Form.Item>
                                    </>
                                ) : (
                                    <Form.Item
                                        name={['ssh', 'password']}
                                        label="SSH 密码"
                                        rules={[{required: !saved?.hasPassword, message: '请输入 SSH 密码'}]}
                                        extra={saved?.hasPassword ? '留空表示沿用已保存的密码' : undefined}
                                    >
                                        <Input.Password placeholder="SSH 登录密码" />
                                    </Form.Item>
                                )}

                                <Divider plain>隧道远端（可选）</Divider>

                                <Form.Item
                                    name={['ssh', 'remoteHost']}
                                    label="远端 Pulsar 主机"
                                    extra="留空则按上面的 Broker / Admin 地址解析；仅当集群地址要从跳板机侧访问时才需要填"
                                >
                                    <Input placeholder="pulsar.internal" />
                                </Form.Item>

                                {editingCluster?.ssh?.tunnelActive && <Tag color="green">当前隧道已在转发</Tag>}

                                {tunnelResult && (
                                    <Alert
                                        type={tunnelResult.ok ? 'success' : 'error'}
                                        message={tunnelResult.text}
                                        icon={tunnelResult.ok ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
                                        showIcon
                                        style={{marginBottom: 12}}
                                    />
                                )}

                                <Button type="default" onClick={handleTestTunnel} loading={tunnelTesting}>
                                    测试 SSH 隧道
                                </Button>
                            </>
                        )
                    }
                </Form.Item>

                <Divider plain>K8s 端口转发（kubectl port-forward）</Divider>

                <Form.Item
                    name="useK8sForward"
                    label="启用 K8s 端口转发"
                    valuePropName="checked"
                    extra={
                        '集群跑在 Kubernetes 里、又只想在本机连时用它：应用会调用 kubectl ' +
                        '把 Admin 与 Broker 端口接到本机随机端口。需要本机已安装 kubectl，且所选上下文能访问该集群'
                    }
                >
                    <Switch
                        // 两条通道都会改写同一对地址，同时开着没有"哪个赢"的定义，
                        // 所以界面上勾一个就替用户取消另一个（主进程 schema 是同一口径的兜底）
                        onChange={checked => {
                            if (checked) {
                                form.setFieldValue('useSshTunnel', false);
                            }
                        }}
                    />
                </Form.Item>

                <Form.Item
                    noStyle
                    shouldUpdate={(prev, curr) =>
                        prev.useK8sForward !== curr.useK8sForward || prev.serviceUrl !== curr.serviceUrl
                    }
                >
                    {({getFieldValue}) => {
                        if (!getFieldValue('useK8sForward')) {
                            return null;
                        }
                        return (
                            <>
                                <Form.Item
                                    name={['k8s', 'namespace']}
                                    label="命名空间"
                                    rules={[
                                        {required: true, message: '请输入命名空间'},
                                        {
                                            pattern: /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
                                            message: '只能用小写字母、数字与 -（K8s 命名空间的写法）',
                                        },
                                    ]}
                                    extra="例如 pulsar、default"
                                >
                                    <Input placeholder="pulsar" />
                                </Form.Item>

                                <Form.Item
                                    name={['k8s', 'resource']}
                                    label="资源"
                                    rules={[
                                        {required: true, message: '请输入要转发的资源'},
                                        {
                                            pattern: /^[a-z][a-z0-9.]*\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/,
                                            message: '需形如 service/pulsar-broker（小写的 TYPE/NAME）',
                                        },
                                    ]}
                                    // 只填名字的话 kubectl 会按 pod 去找，转发到不存在的东西上；
                                    // 这里把 TYPE/NAME 说死，省掉一次"资源找不到"的往返
                                    extra="TYPE/NAME 写法：service/xxx、statefulset/xxx、pod/xxx、deployment/xxx"
                                >
                                    <Input placeholder="service/pulsar-broker" />
                                </Form.Item>

                                <Form.Item
                                    name={['k8s', 'context']}
                                    label="上下文"
                                    extra="留空用 kubectl 当前上下文；可用 kubectl config get-contexts 查看名字"
                                >
                                    <Input placeholder="gke_my-project_us-central1_my-cluster" />
                                </Form.Item>

                                <Form.Item
                                    name={['k8s', 'kubeconfigPath']}
                                    label="kubeconfig 路径"
                                    extra="留空用 KUBECONFIG 或 ~/.kube/config。本应用只保存这个路径，不会读取文件里的凭据"
                                >
                                    <Input placeholder="~/.kube/config" />
                                </Form.Item>

                                <Form.Item
                                    name={['k8s', 'kubectlPath']}
                                    label="kubectl 路径"
                                    extra="留空用 PATH 里的 kubectl。从桌面图标启动时 PATH 常常不含 brew / npm 装的目录，那种情况在这里填绝对路径"
                                >
                                    <Input placeholder="/usr/local/bin/kubectl" />
                                </Form.Item>

                                {editingCluster?.k8s?.forwardActive ? <Tag color="green">当前转发已在进行</Tag> : null}

                                {forwardResult ? (
                                    <Alert
                                        type={forwardResult.ok ? 'success' : 'error'}
                                        message={forwardResult.text}
                                        icon={forwardResult.ok ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
                                        showIcon
                                        style={{marginBottom: 12}}
                                    />
                                ) : null}

                                <Button type="default" onClick={handleTestForward} loading={forwardTesting}>
                                    测试端口转发
                                </Button>
                            </>
                        );
                    }}
                </Form.Item>
            </>
        );
    };

    const renderStep3 = () => (
        <>
            <Form.Item name="tlsEnabled" label="启用 TLS" valuePropName="checked">
                <Switch />
            </Form.Item>

            <Form.Item noStyle shouldUpdate={(prev, curr) => prev.tlsEnabled !== curr.tlsEnabled}>
                {({getFieldValue}) =>
                    getFieldValue('tlsEnabled') && (
                        <Form.Item
                            name="tlsTrustCerts"
                            label="TLS 受信任证书"
                            extra={
                                editingCluster?.hasTlsTrustCerts
                                    ? '留空表示沿用已保存的证书'
                                    : '粘贴 CA 证书内容或选择证书文件路径'
                            }
                        >
                            <Input.TextArea placeholder="/path/to/ca.cert" rows={3} />
                        </Form.Item>
                    )
                }
            </Form.Item>

            {testResult && (
                <Alert
                    type={testResult.connected ? 'success' : 'error'}
                    message={
                        testResult.connected
                            ? `连接成功！Pulsar 版本: ${testResult.version || '未知'}`
                            : '连接失败，请检查配置'
                    }
                    icon={testResult.connected ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
                    style={{marginTop: 16}}
                />
            )}

            <Button type="default" onClick={handleTestConnection} loading={testing} style={{marginTop: 16}}>
                测试连接
            </Button>
        </>
    );

    const steps = [
        {title: '基础信息', icon: <ClusterOutlined />, content: renderStep0},
        {title: '认证配置', icon: <LockOutlined />, content: renderStep1},
        {title: '隧道 / 转发', icon: <ApiOutlined />, content: renderStep2},
        {title: '高级配置', icon: <SettingOutlined />, content: renderStep3},
    ];

    return (
        <Modal
            title={editingCluster ? '编辑集群' : '添加集群'}
            open={open}
            onCancel={handleCancel}
            width={680}
            footer={
                <Space size={4}>
                    {currentStep > 0 && <Button onClick={prevStep}>上一步</Button>}
                    {currentStep < steps.length - 1 ? (
                        <Button type="primary" onClick={nextStep}>
                            下一步
                        </Button>
                    ) : (
                        <Button
                            type="primary"
                            onClick={handleSubmit}
                            loading={loading}
                            disabled={!editingCluster && !testResult?.connected}
                        >
                            {editingCluster ? '保存' : '添加'}
                        </Button>
                    )}
                    <Button onClick={handleCancel}>取消</Button>
                </Space>
            }
        >
            <Steps
                current={currentStep}
                items={steps.map(s => ({title: s.title, icon: s.icon}))}
                style={{marginBottom: 24}}
            />

            <Form
                form={form}
                layout="vertical"
                initialValues={{
                    adminApiTimeout: 5000,
                    tlsEnabled: false,
                    useSshTunnel: false,
                    useK8sForward: false,
                }}
            >
                {steps[currentStep].content()}
            </Form>
        </Modal>
    );
};

export default ClusterConfigModal;
