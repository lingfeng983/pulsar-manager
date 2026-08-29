import React, {useEffect, useState, useCallback} from 'react';
import {Form, Input, Modal, Select, message} from 'antd';

interface TenantFormValues {
    name: string;
    adminRoles?: string[];
    allowedClusters: string[];
}

interface TenantFormModalProps {
    open: boolean;
    mode: 'create' | 'edit';
    clusterId: string;
    // 编辑时的租户名；创建时留空
    tenant?: string;
    initial?: {adminRoles: string[]; allowedClusters: string[]};
    onClose: () => void;
    onSaved: (tenantName: string) => void;
}

/**
 * 租户表单。allowedClusters 的候选值来自 broker 的 /admin/v2/clusters，
 * 而不是应用里保存的连接名 —— 填错会被 broker 直接拒绝。
 */
const TenantFormModal: React.FC<TenantFormModalProps> = ({
    open,
    mode,
    clusterId,
    tenant,
    initial,
    onClose,
    onSaved,
}) => {
    const [form] = Form.useForm<TenantFormValues>();
    const [clusterOptions, setClusterOptions] = useState<string[]>([]);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        if (!open) return;
        form.setFieldsValue({
            name: mode === 'edit' ? tenant : '',
            adminRoles: initial?.adminRoles ?? [],
            allowedClusters: initial?.allowedClusters ?? [],
        });
        let cancelled = false;
        window.electronAPI.resources.getPulsarClusters(clusterId).then(response => {
            if (cancelled) return;
            if (response.success && response.data) {
                setClusterOptions(response.data);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [open, mode, tenant, initial, clusterId, form]);

    const handleOk = useCallback(async () => {
        let values: TenantFormValues;
        try {
            values = await form.validateFields();
        } catch {
            // antd 已把字段错误显示在表单上
            return;
        }

        setSubmitting(true);
        try {
            const adminRoles = values.adminRoles ?? [];
            const response =
                mode === 'create'
                    ? await window.electronAPI.resources.createTenant(
                          clusterId,
                          values.name,
                          adminRoles,
                          values.allowedClusters,
                      )
                    : await window.electronAPI.resources.updateTenant(
                          clusterId,
                          tenant ?? '',
                          adminRoles,
                          values.allowedClusters,
                      );
            if (!response.success) {
                message.error(response.error || '保存失败');
                return;
            }
            message.success(mode === 'create' ? '租户已创建' : '租户已更新');
            onSaved(mode === 'create' ? values.name : (tenant ?? ''));
            onClose();
        } finally {
            setSubmitting(false);
        }
    }, [form, mode, tenant, clusterId, onSaved, onClose]);

    return (
        <Modal
            title={mode === 'create' ? '新建租户' : `编辑租户 ${tenant ?? ''}`}
            open={open}
            onCancel={onClose}
            onOk={handleOk}
            confirmLoading={submitting}
            okText="保存"
            cancelText="取消"
            destroyOnHidden
        >
            <Form form={form} layout="vertical">
                <Form.Item
                    name="name"
                    label="租户名"
                    extra="只允许字母、数字、下划线和连字符"
                    rules={[
                        {required: true, message: '请输入租户名'},
                        {pattern: /^[a-zA-Z0-9_-]+$/, message: '包含非法字符'},
                    ]}
                >
                    <Input disabled={mode === 'edit'} placeholder="例如 analytics" />
                </Form.Item>
                <Form.Item
                    name="allowedClusters"
                    label="可用集群"
                    extra="租户只能在被授权的集群上创建命名空间"
                    rules={[{required: true, message: '至少选择一个集群'}]}
                >
                    <Select
                        mode="tags"
                        placeholder="选择或输入 Pulsar 集群名"
                        options={clusterOptions.map(name => ({label: name, value: name}))}
                    />
                </Form.Item>
                <Form.Item name="adminRoles" label="管理角色" extra="可留空；这些角色对该租户有管理权">
                    <Select mode="tags" placeholder="输入角色名后回车" options={[]} />
                </Form.Item>
            </Form>
        </Modal>
    );
};

export default TenantFormModal;
