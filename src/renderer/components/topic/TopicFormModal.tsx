import React, {useCallback, useState} from 'react';
import {Form, Input, InputNumber, Modal, Switch, message} from 'antd';

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
        } finally {
            setSubmitting(false);
        }
    }, [form, clusterId, tenant, namespace, onSaved, onClose]);

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
