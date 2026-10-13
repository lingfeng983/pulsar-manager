import React, {useCallback, useEffect, useState} from 'react';
import {Form, Input, InputNumber, Modal, Select, Switch, message} from 'antd';
import {usePluginStore} from '../../store/plugins';

interface TopicFormValues {
    name: string;
    persistent: boolean;
    partitions: number;
}

interface TopicFormModalProps {
    open: boolean;
    clusterId: string;
    tenant: string;
    namespace: string;
    onClose: () => void;
    onSaved: (topicName: string) => void;
}

/**
 * 新建 Topic。分区数为 0 时走非分区创建端点 —— 两者在 Admin API 里是不同路径，
 * 旧实现一律调用 /partitions，导致非分区 topic 根本创建不出来。
 */
const TopicFormModal: React.FC<TopicFormModalProps> = ({open, clusterId, tenant, namespace, onClose, onSaved}) => {
    const [form] = Form.useForm<TopicFormValues>();
    const persistent = Form.useWatch('persistent', form) ?? true;
    const [submitting, setSubmitting] = useState(false);
    const templates = usePluginStore(state => state.templates);
    const [templateKey, setTemplateKey] = useState<string | undefined>(undefined);

    // 每次打开都从空白开始：弹窗关闭只是把 DOM 拆掉，useForm 的表单值仍留在 store 里，
    // 不清的话上次输入的 Topic 名、套用的模板会原地出现，容易误建同名 topic。
    useEffect(() => {
        if (open) {
            form.resetFields();
            setTemplateKey(undefined);
        }
    }, [open, form]);

    const handleOk = useCallback(async () => {
        let values: TopicFormValues;
        try {
            values = await form.validateFields();
        } catch {
            return;
        }

        setSubmitting(true);
        try {
            const response = await window.electronAPI.resources.createTopic(
                clusterId,
                tenant,
                namespace,
                values.name,
                values.persistent,
                values.persistent ? values.partitions : 0,
            );
            if (!response.success) {
                message.error(response.error || '创建失败');
                return;
            }
            message.success('Topic 已创建');
            onSaved(values.name);
            onClose();
        } catch {
            // IPC 传输层异常没有 response，不接住就是按钮转一下什么也不说
            message.error('创建失败');
        } finally {
            setSubmitting(false);
        }
    }, [form, clusterId, tenant, namespace, onSaved, onClose]);

    const applyTemplate = (key?: string) => {
        setTemplateKey(key);
        if (!key) {
            return;
        }
        const option = templates.find(item => `${item.pluginId}#${item.template.name}` === key);
        if (!option) {
            return;
        }
        const {template} = option;
        const current = form.getFieldValue('name') as string | undefined;
        form.setFieldsValue({
            persistent: template.persistent,
            partitions: template.persistent ? template.partitions : 0,
            name: !current?.trim() && template.namePrefix ? template.namePrefix : current,
        });
    };

    return (
        <Modal
            title={`新建 Topic（${tenant}/${namespace}）`}
            open={open}
            onCancel={onClose}
            onOk={handleOk}
            confirmLoading={submitting}
            okText="创建"
            cancelText="取消"
            destroyOnHidden
        >
            <Form form={form} layout="vertical" initialValues={{persistent: true, partitions: 0}}>
                {templates.length > 0 && (
                    <Form.Item
                        label="模板"
                        extra="来自已启用的插件，套用后覆盖持久化与分区数"
                        style={{marginBottom: 12}}
                    >
                        <Select
                            allowClear
                            placeholder="选择 Topic 模板"
                            value={templateKey}
                            onChange={applyTemplate}
                            options={templates.map(item => ({
                                value: `${item.pluginId}#${item.template.name}`,
                                label: `${item.pluginName} · ${item.template.name}`,
                            }))}
                        />
                    </Form.Item>
                )}
                <Form.Item
                    name="name"
                    label="Topic 名"
                    extra="只允许字母、数字、点、下划线和连字符"
                    rules={[
                        {required: true, message: '请输入 Topic 名'},
                        {pattern: /^[a-zA-Z0-9._-]+$/, message: '包含非法字符'},
                    ]}
                >
                    <Input placeholder="例如 orders-events" />
                </Form.Item>
                <Form.Item
                    name="persistent"
                    label="持久化"
                    valuePropName="checked"
                    extra="非持久 topic 的数据只在 broker 内存/BookKeeper 日志中，broker 重启即丢失"
                >
                    <Switch checkedChildren="persistent" unCheckedChildren="non-persistent" />
                </Form.Item>
                <Form.Item
                    name="partitions"
                    label="分区数"
                    extra={
                        persistent
                            ? '0 表示非分区 topic；分区数创建后只能在配置页修改，且只能增加'
                            : '非持久 topic 不支持分区'
                    }
                >
                    <InputNumber min={0} max={1000} precision={0} style={{width: '100%'}} disabled={!persistent} />
                </Form.Item>
            </Form>
        </Modal>
    );
};

export default TopicFormModal;
