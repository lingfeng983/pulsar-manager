import React, {useEffect, useMemo, useState} from 'react';
import {Alert, Form, InputNumber, Modal, Select, Space, Typography, message} from 'antd';
import type {NamespacePolicyView, NamespaceRetentionValue} from '../../types';
import {useConfirmDanger} from '../common/dangerConfirm';
import {PolicyRow, QUOTA_POLICY_OPTIONS, QUOTA_TYPE_OPTIONS} from './policyMeta';

interface PolicyEditModalProps {
    row: PolicyRow;
    view: NamespacePolicyView;
    clusterId: string;
    tenant: string;
    namespace: string;
    clusterOptions: string[];
    onClose: () => void;
    onSaved: () => Promise<void> | void;
}

const MB = 1024 * 1024;

// 每个编辑器只负责把界面填的数字换成 broker 要的形状：
// 限速按「每秒」输入、按 broker 的「每周期」下发，两者差一个周期倍数，
// 不做这层换算的话同一份配置在界面上填 100 与 broker 存的 100 含义不同。
const PolicyEditModal: React.FC<PolicyEditModalProps> = ({
    row,
    view,
    clusterId,
    tenant,
    namespace,
    clusterOptions,
    onClose,
    onSaved,
}) => {
    const kind = row.editor?.kind;
    const [form] = Form.useForm();
    const [submitting, setSubmitting] = useState(false);
    const confirmDanger = useConfirmDanger();

    const initialValues = useMemo(() => buildInitial(row, view), [row, view]);

    // 换一个字段重新铺一遍表单：残留上一字段的值会让提交带着没填过的键
    useEffect(() => {
        form.resetFields();
        form.setFieldsValue(initialValues as never);
    }, [form, initialValues]);

    const finish = async (value: unknown) => {
        if (!row.field) {
            return;
        }
        setSubmitting(true);
        try {
            const response = await window.electronAPI.namespacePolicy.set({
                clusterId,
                tenant,
                namespace,
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
        if (kind === 'seconds' || kind === 'minutes' || kind === 'count' || kind === 'strategy') {
            await finish(kind === 'strategy' ? values.strategy : values.number);
            return;
        }
        if (kind === 'retention') {
            const retention: NamespaceRetentionValue = {
                timeInMinutes: values.retentionMinutes,
                sizeInMB: values.retentionSizeMb,
            };
            await finish(retention);
            return;
        }
        if (kind === 'quota') {
            await finish({
                type: values.quotaType,
                policy: values.quotaPolicy,
                // 界面按 MB 收，broker 的 limitSize 是字节
                limitSizeBytes: Math.round(values.quotaSizeMb * MB),
                limitTimeSeconds: values.quotaLimitSeconds ?? 0,
            });
            return;
        }
        if (kind === 'rate' || kind === 'publishRate') {
            const period = kind === 'rate' ? values.ratePeriod : 1;
            await finish({
                msgPerPeriod: values.rateMsg * period,
                bytePerPeriod: Math.round(values.rateByteMb * MB) * period,
                periodInSeconds: period,
            });
            return;
        }
        if (kind === 'clusters') {
            const next: string[] = values.clusters ?? [];
            const removed = (view.replicationClusters || []).filter(name => !next.includes(name));
            if (removed.length === 0) {
                await finish(next);
                return;
            }
            // 移除复制目标在所有部署下都是不可逆的：共用元数据存储时被移除集群的数据直接删掉，
            // 分开存储时也只停止复制、回来的不是原来那份账。这种动作不能只靠一次「确定」。
            confirmDanger({
                title: `停止向 ${removed.join('、')} 复制？`,
                description: '被移除集群上的数据不会自动同步回来；共用元数据存储的部署里，该集群的数据会被直接删除。',
                okText: '移除并保存',
                requireExactName: removed.length === 1 ? removed[0] : `${tenant}/${namespace}`,
                onOk: async () => {
                    await finish(next);
                },
            });
        }
    };

    const editor = row.editor;
    // 候选里补上当前正在复制、但集群清单里没有的名字：
    // 只按清单渲染会让这些集群在界面上消失，一保存就成了「悄悄摘掉复制目标」
    const clusterChoices = useMemo(
        () =>
            Array.from(new Set([...clusterOptions, ...view.replicationClusters])).map(name => ({
                label: name,
                value: name,
            })),
        [clusterOptions, view.replicationClusters],
    );

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
                {kind === 'clusters' && clusterOptions.length === 0 ? (
                    <Alert type="warning" showIcon message="集群清单为空，无法选择复制目标" />
                ) : null}
                <Form form={form} layout="vertical" size="small">
                    {(kind === 'seconds' || kind === 'minutes' || kind === 'count') && editor ? (
                        <Form.Item
                            name="number"
                            label={`新值（${editor.unit}）`}
                            rules={[{required: true, message: '请填写数值'}]}
                        >
                            <InputNumber min={editor.min} max={editor.max} style={{width: '100%'}} step={1} />
                        </Form.Item>
                    ) : null}
                    {kind === 'boolean' && editor?.options ? (
                        <Form.Item name="boolean" label="新值" rules={[{required: true, message: '请选择'}]}>
                            <Select options={editor.options} />
                        </Form.Item>
                    ) : null}
                    {kind === 'strategy' && editor?.options ? (
                        <Form.Item name="strategy" label="新值" rules={[{required: true, message: '请选择'}]}>
                            <Select options={editor.options} showSearch />
                        </Form.Item>
                    ) : null}
                    {kind === 'retention' ? (
                        <>
                            <Form.Item
                                name="retentionMinutes"
                                label="保留时长（分钟，-1 = 无限）"
                                rules={[{required: true, message: '请填写保留时长'}]}
                            >
                                <InputNumber min={-1} max={2147483647} style={{width: '100%'}} step={60} />
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
                    {kind === 'quota' ? (
                        <>
                            <Form.Item name="quotaType" label="配额类型" rules={[{required: true}]}>
                                <Select options={QUOTA_TYPE_OPTIONS} />
                            </Form.Item>
                            <Form.Item
                                name="quotaSizeMb"
                                label="配额大小（MB）"
                                rules={[{required: true, message: '请填写配额大小'}]}
                            >
                                <InputNumber min={0} style={{width: '100%'}} step={128} />
                            </Form.Item>
                            <Form.Item
                                name="quotaLimitSeconds"
                                label="配额时长（秒，仅 message_age 生效）"
                                tooltip="destination_storage 忽略这一项，填了也不影响"
                            >
                                <InputNumber min={0} max={2147483647} style={{width: '100%'}} step={60} />
                            </Form.Item>
                            <Form.Item name="quotaPolicy" label="超限处理" rules={[{required: true}]}>
                                <Select options={QUOTA_POLICY_OPTIONS} />
                            </Form.Item>
                        </>
                    ) : null}
                    {kind === 'rate' || kind === 'publishRate' ? (
                        <>
                            <Form.Item
                                name="rateMsg"
                                label={kind === 'rate' ? '条数（条/秒，-1 = 不限）' : '次数（次/秒，-1 = 不限）'}
                                rules={[{required: true, message: '请填写条数'}]}
                            >
                                <InputNumber min={-1} max={2147483647} style={{width: '100%'}} />
                            </Form.Item>
                            <Form.Item
                                name="rateByteMb"
                                label="大小（MB/秒，-1 = 不限）"
                                rules={[{required: true, message: '请填写大小'}]}
                            >
                                <InputNumber min={-1} max={1024 * 1024} style={{width: '100%'}} />
                            </Form.Item>
                            {kind === 'rate' ? (
                                <Form.Item
                                    name="ratePeriod"
                                    label="统计周期（秒）"
                                    rules={[{required: true, message: '请填写统计周期'}]}
                                >
                                    <InputNumber min={1} max={3600} style={{width: '100%'}} step={1} />
                                </Form.Item>
                            ) : null}
                        </>
                    ) : null}
                    {kind === 'clusters' ? (
                        <Form.Item
                            name="clusters"
                            label="复制目标集群（整表覆盖）"
                            rules={[{required: true, message: '至少选择一个集群；一个都不选等于停止全部复制'}]}
                        >
                            <Select mode="multiple" options={clusterChoices} />
                        </Form.Item>
                    ) : null}
                </Form>
            </Space>
        </Modal>
    );
};

// 预填当前值：编辑弹窗里显示空着让运营猜"现在是几"是错的来源。
// 未设置时给该字段的常规起点而不是 0——0 在很多字段是「立刻过期 / 全部禁掉」的有效值。
function buildInitial(row: PolicyRow, view: NamespacePolicyView): Record<string, unknown> {
    const kind = row.editor?.kind;
    switch (kind) {
        case 'seconds':
            return {
                number:
                    row.key === 'messageTtlSeconds'
                        ? view.messageTtlSeconds
                        : view.deduplicationSnapshotIntervalSeconds,
            };
        case 'minutes':
            return {number: view.subscriptionExpirationTimeMinutes};
        case 'count':
            return {number: countValueOf(row.key, view)};
        case 'boolean':
            return {boolean: String(booleanValueOf(row.key, view) ?? false)};
        case 'strategy':
            return {
                strategy:
                    row.key === 'schemaCompatibilityStrategy'
                        ? (view.schemaCompatibilityStrategy ?? 'UNDEFINED')
                        : (view.schemaAutoUpdateStrategy ?? 'Backward'),
            };
        case 'retention':
            return {
                retentionMinutes: view.retentionTimeInMinutes ?? 1440,
                retentionSizeMb: view.retentionSizeInMB ?? 0,
            };
        case 'quota': {
            const quota = view.backlogQuotas[0];
            return {
                quotaType: quota?.type ?? 'destination_storage',
                quotaSizeMb: quota ? Math.round(quota.limitSizeBytes / MB) : 1024,
                quotaLimitSeconds: quota?.limitTimeSeconds ?? 0,
                quotaPolicy: quota?.policy ?? 'producer_request_hold',
            };
        }
        case 'rate': {
            const rate = rateValueOf(row.key, view);
            const period = rate?.periodInSeconds && rate.periodInSeconds > 0 ? rate.periodInSeconds : 1;
            return {
                rateMsg: rate && rate.msgPerPeriod >= 0 ? rate.msgPerPeriod / period : -1,
                rateByteMb: rate && rate.bytePerPeriod >= 0 ? round2(rate.bytePerPeriod / period / MB) : -1,
                ratePeriod: period,
            };
        }
        case 'publishRate': {
            const rate = view.publishRate;
            return {
                rateMsg: rate && rate.msgPerPeriod >= 0 ? rate.msgPerPeriod : -1,
                rateByteMb: rate && rate.bytePerPeriod >= 0 ? round2(rate.bytePerPeriod / MB) : -1,
            };
        }
        case 'clusters':
            // 只预填当前真正在复制的集群。把候选清单一起填进去等于一保存就朝
            // 所有集群开复制——那是比清空更严重的误操作。
            return {clusters: view.replicationClusters};
        default:
            return {};
    }
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

function countValueOf(key: string, view: NamespacePolicyView): number | null {
    switch (key) {
        case 'maxProducersPerTopic':
            return view.maxProducersPerTopic;
        case 'maxConsumersPerTopic':
            return view.maxConsumersPerTopic;
        case 'maxConsumersPerSubscription':
            return view.maxConsumersPerSubscription;
        case 'maxUnackedMessagesPerConsumer':
            return view.maxUnackedMessagesPerConsumer;
        case 'maxUnackedMessagesPerSubscription':
            return view.maxUnackedMessagesPerSubscription;
        case 'maxSubscriptionsPerTopic':
            return view.maxSubscriptionsPerTopic;
        case 'maxTopicsPerNamespace':
            return view.maxTopicsPerNamespace;
        case 'compactionThreshold':
            return view.compactionThreshold;
        default:
            return null;
    }
}

function booleanValueOf(key: string, view: NamespacePolicyView): boolean | null {
    switch (key) {
        case 'deduplicationEnabled':
            return view.deduplicationEnabled;
        case 'encryptionRequired':
            return view.encryptionRequired;
        case 'schemaValidationEnforced':
            return view.schemaValidationEnforced;
        case 'allowAutoUpdateSchema':
            return view.allowAutoUpdateSchema;
        default:
            return null;
    }
}

function rateValueOf(key: string, view: NamespacePolicyView) {
    switch (key) {
        case 'dispatchRate':
            return view.dispatchRate;
        case 'subscriptionDispatchRate':
            return view.subscriptionDispatchRate;
        case 'replicatorDispatchRate':
            return view.replicatorDispatchRate;
        case 'subscribeRate':
            return view.subscribeRate;
        default:
            return null;
    }
}

export default PolicyEditModal;
