import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
    Button,
    Card,
    Checkbox,
    Input,
    Popconfirm,
    Space,
    Table,
    Tag,
    Typography,
    message,
    type TableColumnsType,
} from 'antd';
import {PlusOutlined, ReloadOutlined} from '@ant-design/icons';
import StateBlock from '../common/StateBlock';
import type {PermissionMap, PulsarAuthAction} from '../../types';

interface PermissionsPanelProps {
    scope: 'namespace' | 'topic';
    clusterId: string;
    tenant: string;
    namespace: string;
    topic?: string;
    persistent?: boolean;
    // 页签切换后组件仍在挂载，首次激活才拉数据
    active?: boolean;
}

const ACTION_OPTIONS: {label: string; value: PulsarAuthAction}[] = [
    {label: 'produce（写）', value: 'produce'},
    {label: 'consume（读）', value: 'consume'},
];

// 预设：日常授权基本就这三种组合，少打两次勾
const PRESETS: {label: string; actions: PulsarAuthAction[]}[] = [
    {label: '只读', actions: ['consume']},
    {label: '只写', actions: ['produce']},
    {label: '读写', actions: ['produce', 'consume']},
];

const actionLabel = (action: string) => (action === 'produce' ? '写' : action === 'consume' ? '读' : action);

// 权限是资源级写操作，broker 侧没有"预演"，所以每一笔都要能在审计里查到谁改的。
const PermissionsPanel: React.FC<PermissionsPanelProps> = ({
    scope,
    clusterId,
    tenant,
    namespace,
    topic,
    persistent = true,
    active = true,
}) => {
    const [permissions, setPermissions] = useState<PermissionMap | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [role, setRole] = useState('');
    const [actions, setActions] = useState<PulsarAuthAction[]>(['consume']);
    const [submitting, setSubmitting] = useState(false);
    const loadedRef = useRef(false);
    const requestIdRef = useRef(0);

    const load = useCallback(async () => {
        const currentRequestId = ++requestIdRef.current;
        setLoading(true);
        setError(null);
        try {
            const response =
                scope === 'topic'
                    ? await window.electronAPI.resources.getTopicPermissions(
                          clusterId,
                          tenant,
                          namespace,
                          topic as string,
                          persistent,
                      )
                    : await window.electronAPI.resources.getNamespacePermissions(clusterId, tenant, namespace);
            if (currentRequestId !== requestIdRef.current) {
                return;
            }
            if (response.success) {
                setPermissions(response.data ?? {});
                loadedRef.current = true;
            } else {
                setError(response.error || '获取权限列表失败');
            }
        } catch (err) {
            if (currentRequestId !== requestIdRef.current) {
                return;
            }
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            if (currentRequestId === requestIdRef.current) {
                setLoading(false);
            }
        }
    }, [scope, clusterId, tenant, namespace, topic, persistent]);

    useEffect(() => {
        if (active && !loadedRef.current) {
            void load();
        }
    }, [active, load]);

    const handleGrant = async () => {
        const trimmed = role.trim();
        if (!trimmed) {
            message.warning('角色名不能为空');
            return;
        }
        if (actions.length === 0) {
            message.warning('至少勾选一个动作');
            return;
        }
        setSubmitting(true);
        try {
            const response =
                scope === 'topic'
                    ? await window.electronAPI.resources.grantTopicPermission(
                          clusterId,
                          tenant,
                          namespace,
                          topic as string,
                          trimmed,
                          actions,
                          persistent,
                      )
                    : await window.electronAPI.resources.grantNamespacePermission(
                          clusterId,
                          tenant,
                          namespace,
                          trimmed,
                          actions,
                      );
            if (response.success) {
                message.success(`已授权 ${trimmed}`);
                setRole('');
                await load();
            } else {
                message.error(response.error || '授权失败');
            }
        } finally {
            setSubmitting(false);
        }
    };

    const handleRevoke = async (targetRole: string) => {
        const response =
            scope === 'topic'
                ? await window.electronAPI.resources.revokeTopicPermission(
                      clusterId,
                      tenant,
                      namespace,
                      topic as string,
                      targetRole,
                      persistent,
                  )
                : await window.electronAPI.resources.revokeNamespacePermission(
                      clusterId,
                      tenant,
                      namespace,
                      targetRole,
                  );
        if (response.success) {
            message.success(`已撤销 ${targetRole}`);
            await load();
        } else {
            message.error(response.error || '撤销失败');
        }
    };

    const columns: TableColumnsType<{role: string; actions: string[]}> = [
        {title: '角色', dataIndex: 'role', key: 'role'},
        {
            title: '动作',
            dataIndex: 'actions',
            key: 'actions',
            render: (value: string[]) =>
                value.length > 0 ? (
                    <Space size={4} wrap>
                        {value.map(action => (
                            <Tag key={action} color={action === 'produce' ? 'orange' : 'green'}>
                                {actionLabel(action)}
                            </Tag>
                        ))}
                    </Space>
                ) : (
                    <Typography.Text type="secondary">无</Typography.Text>
                ),
        },
        {
            title: '操作',
            key: 'op',
            render: (_: unknown, record) => (
                <Popconfirm
                    title={`撤销角色 ${record.role} 的权限？`}
                    description="撤销后该角色立即无法访问这条资源。"
                    okText="撤销"
                    okButtonProps={{danger: true}}
                    onConfirm={() => void handleRevoke(record.role)}
                >
                    <Button type="link" size="small" danger>
                        撤销
                    </Button>
                </Popconfirm>
            ),
        },
    ];

    const rows = Object.entries(permissions ?? {}).map(([name, value]) => ({role: name, actions: value ?? []}));

    return (
        <div className="stack">
            <Card title="新增授权" size="small">
                <div className="stack">
                    <Space size="small" wrap>
                        <Input
                            size="small"
                            style={{width: 260}}
                            placeholder="角色名，如 app-producer"
                            value={role}
                            onChange={event => setRole(event.target.value)}
                            onPressEnter={() => void handleGrant()}
                        />
                        <Checkbox.Group
                            options={ACTION_OPTIONS}
                            value={actions}
                            onChange={checked => setActions(checked as PulsarAuthAction[])}
                        />
                        <Button
                            size="small"
                            type="primary"
                            icon={<PlusOutlined />}
                            loading={submitting}
                            onClick={() => void handleGrant()}
                        >
                            授权
                        </Button>
                    </Space>
                    <Space size={4}>
                        <span className="hint-text">预设</span>
                        {PRESETS.map(preset => (
                            <Button key={preset.label} size="small" onClick={() => setActions(preset.actions)}>
                                {preset.label}
                            </Button>
                        ))}
                    </Space>
                </div>
            </Card>

            <Card
                title={`已授权角色 (${rows.length})`}
                size="small"
                extra={
                    <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
                        刷新
                    </Button>
                }
            >
                <StateBlock
                    loading={loading && !permissions}
                    error={error}
                    errorTitle="获取权限失败"
                    onRetry={load}
                    empty={rows.length === 0}
                    emptyText="该资源没有显式授权"
                >
                    <Table
                        size="small"
                        rowKey="role"
                        columns={columns}
                        dataSource={rows}
                        pagination={false}
                        scroll={{x: 'max-content'}}
                    />
                </StateBlock>
            </Card>
        </div>
    );
};

export default PermissionsPanel;
