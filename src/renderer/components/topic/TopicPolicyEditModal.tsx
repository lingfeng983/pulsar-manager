import React, {useEffect, useMemo, useState} from 'react';
import {Alert, Form, InputNumber, Modal, Select, Space, Typography, message} from 'antd';
import type {NamespaceRetentionValue, TopicPolicyView} from '../../types';
import type {TopicPolicyRow} from './topicPolicyMeta';

interface TopicPolicyEditModalProps {
    row: TopicPolicyRow;
    view: TopicPolicyView;
    clusterId: string;
    tenant: string;
    namespace: string;
    topic: string;
    persistent: boolean;
    onClose: () => void;
    onSaved: () => Promise<void> | void;
}

// topic 级保留策略是整对象替换，所以两个维度一起发；而这条 topic 没设过 topic 级覆盖时
// broker 生效的是命名空间的值——预填必须按命名空间那份来，否则一保存就把
// 「命名空间保留 7 天」悄悄改成了弹窗里的默认数字。
function useNamespaceRetention(
    kind: string,
    clusterId: string,
    tenant: string,
    namespace: string,
): {retention: NamespaceRetentionValue | null; loading: boolean} {
    const [retention, setRetention] = useState<NamespaceRetentionValue | null>(null);
    const [loading, setLoading] = useState(kind === 'retention');

    useEffect(() => {
        if (kind !== 'retention') {
            return undefined;
        }
        let cancelled = false;
        setLoading(true);
        void window.electronAPI.namespacePolicy
            .get({clusterId, tenant, namespace})
            .then(response => {
                if (cancelled) {
                    return;
                }
                const view = response.data;
                if (view && view.retentionTimeInMinutes !== null && view.retentionSizeInMB !== null) {
                    setRetention({timeInMinutes: view.retentionTimeInMinutes, sizeInMB: view.retentionSizeInMB});
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setLoading(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [kind, clusterId, tenant, namespace]);

    return {retention, loading};
}

const TopicPolicyEditModal: React.FC<TopicPolicyEditModalProps> = ({
    row,
    view,
    clusterId,
    tenant,
    namespace,
    topic,
    persistent,
    onClose,
    onSaved,
}) => {
    const kind = row.editor.kind;
    const [form] = Form.useForm();
    const [submitting, setSubmitting] = useState(false);
    const {retention: nsRetention, loading: nsLoading} = useNamespaceRetention(kind, clusterId, tenant, namespace);

    const initialValues = useMemo(() => buildInitial(row, view, nsRetention), [row, view, nsRetention]);

    // 命名空间那份保留策略是异步读回来的：读到的瞬间要重铺一次表单，
    // 否则预填停留在兜底值上，用户没注意就直接提交了那个数字。
    useEffect(() => {
        form.resetFields();
        form.setFieldsValue(initialValues as never);
    }, [form, initialValues]);

    const finish = async (value: unknown) => {
        setSubmitting(true);
        try {
            const response = await window.electronAPI.topicPolicy.set({
                clusterId,
                tenant,
                namespace,
                topic,
                persistent,
                field: row.field,
                value,
            });
            if (response.success) {
                message.success(`${row.label}已更新`);
                await onSaved();
                onClose();
            } else {
                message.error(response.error || '保存失败');
            }
        } finally {
            setSubmitting(false);
        }
    };

    const handleSubmit = async () => {
        const values = await form.validateFields();
        if (kind === 'boolean') {
            await finish(values.boolean === 'true');
            return;
        }
        if (kind === 'seconds' || kind === 'count') {
            await finish(values.number);
            return;
        }
        if (kind === 'retention') {
            await finish({timeInMinutes: values.retentionMinutes, sizeInMB: values.retentionSizeMb});
        }
    };

    const inheritedText =
        kind === 'retention' && nsRetention
            ? `命名空间当前：时长 ${nsRetention.timeInMinutes} 分钟，容量 ${nsRetention.sizeInMB}MB`
            : null;

    return (
        <Modal
            open
            destroyOnClose
            title={`修改${row.label}`}
            okText="保存"
            confirmLoading={submitting}
            onOk={() => void handleSubmit()}
            onCancel={onClose}
            width={520}
        >
            <Space direction="vertical" size={8} style={{width: '100%'}}>
                {row.hint ? <Typography.Text type="secondary">{row.hint}</Typography.Text> : null}
                <Typography.Text type="secondary">当前：{row.render(view)}</Typography.Text>
                {kind === 'retention' ? (
                    <Alert
                        type="info"
                        showIcon
                        message={
                            nsLoading
                                ? '正在读取命名空间的保留策略（用于预填）'
                                : inheritedText || '命名空间没有读到保留策略，预填按不限'
                        }
                    />
                ) : null}
                <Form form={form} layout="vertical" size="small">
                    {(kind === 'seconds' || kind === 'count') && row.editor ? (
                        <Form.Item
                            name="number"
                            label={`新值（${row.editor.unit}）`}
                            rules={[{required: true, message: '请填写数值'}]}
                        >
                            <InputNumber
                                min={row.editor.min}
                                max={row.editor.max}
                                precision={0}
                                style={{width: '100%'}}
                                step={1}
                            />
                        </Form.Item>
                    ) : null}
                    {kind === 'boolean' && row.editor.options ? (
                        <Form.Item name="boolean" label="新值" rules={[{required: true, message: '请选择'}]}>
                            <Select options={row.editor.options} />
                        </Form.Item>
                    ) : null}
                    {kind === 'retention' ? (
                        <>
                            <Form.Item
                                name="retentionMinutes"
                                label="保留时长（分钟，-1 = 无限）"
                                rules={[{required: true, message: '请填写保留时长'}]}
                            >
                                <InputNumber min={-1} max={525600} style={{width: '100%'}} step={60} />
                            </Form.Item>
                            <Form.Item
                                name="retentionSizeMb"
                                label="保留容量（MB，-1 = 无限）"
                                rules={[{required: true, message: '请填写保留容量'}]}
                            >
                                <InputNumber min={-1} max={1024 * 1024} style={{width: '100%'}} step={1024} />
                            </Form.Item>
                        </>
                    ) : null}
                </Form>
                <Typography.Text type="secondary">
                    保存写的是 topic 级覆盖；要退回命名空间的值，用面板上的「清除」。
                </Typography.Text>
            </Space>
        </Modal>
    );
};

// 预填当前值：留空让运营猜「现在是几」是错的来源。topic 级没设过时按生效值预填
// （保留策略取命名空间那份，其余给该字段的常规起点）：TTL 的 0 是「立刻过期」、
// 上限的 0 是「不限」，两者都是有效值而不是「没填」，兜底方向按各自语义走。
function buildInitial(row: TopicPolicyRow, view: TopicPolicyView, nsRetention: NamespaceRetentionValue | null) {
    switch (row.editor.kind) {
        case 'seconds':
            return {number: view.messageTtlSeconds ?? 86400};
        case 'count':
            return {
                number:
                    row.key === 'maxUnackedMessagesPerConsumer'
                        ? (view.maxUnackedMessagesPerConsumer ?? 0)
                        : (view.maxUnackedMessagesPerSubscription ?? 0),
            };
        case 'boolean':
            return {boolean: String(view.deduplicationEnabled ?? false)};
        case 'retention':
            return {
                retentionMinutes: view.retentionTimeInMinutes ?? nsRetention?.timeInMinutes ?? -1,
                retentionSizeMb: view.retentionSizeInMB ?? nsRetention?.sizeInMB ?? -1,
            };
        default:
            return {};
    }
}

export default TopicPolicyEditModal;
