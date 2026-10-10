import React, {useState, useEffect} from 'react';
import {Modal, Form, Input, InputNumber, Select, Switch, Button, Space, Steps, message, Alert, Divider} from 'antd';
import {
    ClusterOutlined,
    LockOutlined,
    SettingOutlined,
    CheckCircleOutlined,
    CloseCircleOutlined,
} from '@ant-design/icons';
import type {ClusterConfig} from '../types';

const {Option} = Select;

interface ClusterConfigModalProps {
    open: boolean;
    onCancel: () => void;
    onSuccess: () => void;
    editingCluster?: ClusterConfig | null;
}

const ClusterConfigModal: React.FC<ClusterConfigModalProps> = ({open, onCancel, onSuccess, editingCluster}) => {
    const [form] = Form.useForm();
    const [currentStep, setCurrentStep] = useState(0);
    const [loading, setLoading] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{connected: boolean; version?: string} | null>(null);

    useEffect(() => {
        if (open) {
            if (editingCluster) {
                form.setFieldsValue(editingCluster);
            } else {
                form.resetFields();
                form.setFieldsValue({
                    serviceUrl: 'pulsar://192.168.222.121:6650',
                    webServiceUrl: 'http://192.168.222.121:8080',
                    adminApiTimeout: 5000,
                    tlsEnabled: false,
                    useSshTunnel: false,
                });
            }
            setCurrentStep(0);
            setTestResult(null);
        }
    }, [open, editingCluster, form]);

    const handleTestConnection = async () => {
        try {
            const values = await form.validateFields(['serviceUrl', 'webServiceUrl', 'authPlugin', 'authParams']);
            setTesting(true);
            setTestResult(null);

            const response = await window.electronAPI.cluster.testConnection(values);
            if (response.success && response.data) {
                setTestResult(response.data);
                message.success('连接成功！');
            } else {
                setTestResult({connected: false});
                message.error(response.error || '连接失败');
            }
        } catch {
            setTestResult({connected: false});
            message.error('连接测试失败');
        } finally {
            setTesting(false);
        }
    };

    const handleSubmit = async () => {
        let allValues: ClusterConfig;
        try {
            // 表单值即集群配置（id 由 update 调用单独传）
            allValues = (await form.validateFields()) as unknown as ClusterConfig;
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
        form.resetFields();
        setCurrentStep(0);
        setTestResult(null);
        onCancel();
    };

    const STEP_FIELDS: string[][] = [
        ['name', 'serviceUrl', 'webServiceUrl', 'adminApiTimeout'],
        ['authPlugin', 'authParams', 'useSshTunnel'],
        ['tlsEnabled', 'tlsTrustCerts'],
    ];

    const nextStep = async () => {
        try {
            await form.validateFields(STEP_FIELDS[currentStep]);
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
                extra="Pulsar Admin HTTP 地址，如 http://localhost:8080"
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

            <Divider>或使用 SSH 隧道</Divider>

            <Form.Item
                name="useSshTunnel"
                label="启用 SSH 隧道"
                valuePropName="checked"
                extra="隧道功能尚未实现，开启后连接会被主进程拒绝，请先直连"
            >
                <Switch />
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

    const renderStep2 = () => (
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
        </>
    );

    const steps = [
        {title: '基础信息', icon: <ClusterOutlined />, content: renderStep0},
        {title: '认证配置', icon: <LockOutlined />, content: renderStep1},
        {title: '高级配置', icon: <SettingOutlined />, content: renderStep2},
    ];

    return (
        <Modal
            title={editingCluster ? '编辑集群' : '添加集群'}
            open={open}
            onCancel={handleCancel}
            width={680}
            footer={
                <Space>
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
                }}
            >
                {steps[currentStep].content()}
            </Form>
        </Modal>
    );
};

export default ClusterConfigModal;
