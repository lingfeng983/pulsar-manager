import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Alert, Button, Card, Checkbox, Modal, Select, Space, Table, Tag, Typography, message} from 'antd';
import StateBlock from '../common/StateBlock';
import {useConfirmDanger} from '../common/dangerConfirm';
import type {
    NamespaceBacklogQuota,
    NamespacePolicyField,
    NamespacePolicySyncDelta,
    NamespacePolicySyncItemResult,
    NamespacePolicySyncPlanResult,
    NamespacePolicySyncTargetPlan,
    NamespacePolicySyncTargetResult,
    NamespacePolicyView,
} from '../../types';
import {POLICY_GROUPS, POLICY_ROW_BY_FIELD, PolicyRow, policyFieldLabel} from './policyMeta';

interface PolicySyncModalProps {
    clusterId: string;
    source: {tenant: string; namespace: string};
    onClose: () => void;
    onApplied: () => void;
}

// 可勾的字段按面板同一套分组给出来：messageTTL 到底是秒还是分钟，
// 只有放在「保留与过期」这种语境里才读得懂，摊平成 25 个复选框更容易勾错。
const EDITABLE_GROUPS: {title: string; fields: {field: NamespacePolicyField; label: string}[]}[] = POLICY_GROUPS.map(
    group => ({
        title: group.title,
        fields: group.rows
            .filter((row: PolicyRow) => !!row.field)
            .map(row => ({field: row.field as NamespacePolicyField, label: row.label})),
    }),
).filter(group => group.fields.length > 0);

const ALL_EDITABLE_FIELDS: NamespacePolicyField[] = EDITABLE_GROUPS.flatMap(group =>
    group.fields.map(item => item.field),
);

const MAX_TARGETS = 20;

function quotaLine(quota: NamespaceBacklogQuota): string {
    const sizeMb = Math.round((quota.limitSizeBytes / 1024 / 1024) * 100) / 100;
    return `${quota.type}：上限 ${sizeMb}MB，时限 ${quota.limitTimeSeconds}s，超限 ${quota.policy}`;
}

/**
 * 一行动作两侧的文案。backlogQuota 单独走：它是一个端点下挂多条配额，
 * 差异按类型逐条给出，用整行的聚合文案会把两条不同的配额显示成同一句话。
 */
function deltaSides(
    delta: NamespacePolicySyncDelta,
    target: NamespacePolicySyncTargetPlan,
    sourceView: NamespacePolicyView | undefined,
): {from: string; to: string} {
    if (delta.field === 'backlogQuota') {
        const current = target.view?.backlogQuotas.find(quota => quota.type === delta.quotaType);
        const from = current ? quotaLine(current) : '未设置';
        if (delta.action === 'clear') {
            return {from, to: '清除（退回 broker 默认）'};
        }
        const next = delta.value as NamespaceBacklogQuota | undefined;
        return {from, to: next ? quotaLine(next) : '—'};
    }
    const row = POLICY_ROW_BY_FIELD.get(delta.field);
    const from = row && target.view ? row.render(target.view) : '—';
    if (delta.action === 'clear') {
        return {from, to: '清除（退回 broker 默认）'};
    }
    if (delta.action === 'skip') {
        return {from, to: delta.reason ?? '保持不变'};
    }
    return {from, to: row && sourceView ? row.render(sourceView) : '—'};
}

const actionTag = (delta: NamespacePolicySyncDelta) => {
    if (delta.action === 'clear') {
        return <Tag color="orange">清除</Tag>;
    }
    return delta.action === 'skip' ? <Tag>不变</Tag> : <Tag color="blue">改为</Tag>;
};

const fieldCell = (row: {field: NamespacePolicyField; quotaType?: string}) => (
    <span>
        {policyFieldLabel(row.field)}
        {row.quotaType ? ` · ${row.quotaType}` : ''}
    </span>
);

const TargetPlanBlock: React.FC<{target: NamespacePolicySyncTargetPlan; sourceView?: NamespacePolicyView}> = ({
    target,
    sourceView,
}) => {
    const rows = target.deltas.map(delta => ({delta, sides: deltaSides(delta, target, sourceView)}));
    return (
        <Card size="small" type="inner" title={`${target.tenant}/${target.namespace}`}>
            {target.error ? <Alert type="error" showIcon message={target.error} /> : null}
            {!target.error && rows.length === 0 ? (
                <Typography.Text type="secondary">所选字段已经与源一致，无需改动</Typography.Text>
            ) : null}
            {rows.length > 0 ? (
                <Table
                    size="small"
                    rowKey={row => `${row.delta.field}:${row.delta.quotaType ?? ''}`}
                    dataSource={rows}
                    pagination={false}
                    columns={[
                        {title: '字段', width: 180, render: (_: unknown, row) => fieldCell(row.delta)},
                        {title: '动作', width: 84, render: (_: unknown, row) => actionTag(row.delta)},
                        {title: '目标当前', width: 220, render: (_: unknown, row) => row.sides.from},
                        {
                            title: '同步后',
                            render: (_: unknown, row) =>
                                row.delta.action === 'skip' ? (
                                    <Typography.Text type="secondary">{row.sides.to}</Typography.Text>
                                ) : (
                                    row.sides.to
                                ),
                        },
                    ]}
                />
            ) : null}
        </Card>
    );
};

const TargetResultBlock: React.FC<{target: NamespacePolicySyncTargetResult}> = ({target}) => (
    <Card size="small" type="inner" title={`${target.tenant}/${target.namespace}`}>
        {target.error ? <Alert type="error" showIcon message={target.error} /> : null}
        {target.items.length === 0 && !target.error ? (
            <Typography.Text type="secondary">该命名空间无需改动</Typography.Text>
        ) : null}
        {target.items.length > 0 ? (
            <Table
                size="small"
                rowKey={row => `${row.field}:${row.quotaType ?? ''}`}
                dataSource={target.items}
                pagination={false}
                columns={[
                    {
                        title: '字段',
                        width: 180,
                        render: (_: unknown, row: NamespacePolicySyncItemResult) => fieldCell(row),
                    },
                    {
                        title: '结果',
                        width: 90,
                        render: (_: unknown, row: NamespacePolicySyncItemResult) =>
                            row.action === 'skip' ? (
                                <Tag>不变</Tag>
                            ) : row.ok ? (
                                <Tag color="green">已写入</Tag>
                            ) : (
                                <Tag color="red">失败</Tag>
                            ),
                    },
                    {title: '说明', render: (_: unknown, row: NamespacePolicySyncItemResult) => row.message ?? '—'},
                ]}
            />
        ) : null}
    </Card>
);

const PolicySyncModal: React.FC<PolicySyncModalProps> = ({clusterId, source, onClose, onApplied}) => {
    const [tenants, setTenants] = useState<string[]>([]);
    const [tenant, setTenant] = useState(source.tenant);
    const [namespaces, setNamespaces] = useState<string[]>([]);
    const [targets, setTargets] = useState<string[]>([]);
    const [fields, setFields] = useState<NamespacePolicyField[]>([]);
    const [plan, setPlan] = useState<NamespacePolicySyncPlanResult | null>(null);
    const [planning, setPlanning] = useState(false);
    const [planError, setPlanError] = useState<string | null>(null);
    const [result, setResult] = useState<NamespacePolicySyncTargetResult[] | null>(null);
    const [applying, setApplying] = useState(false);
    const [applyError, setApplyError] = useState<string | null>(null);
    const confirmDanger = useConfirmDanger();

    // 租户清单只服务「同步到别的租户」，取不到就退回源租户，不该拦下整次同步
    useEffect(() => {
        let cancelled = false;
        void window.electronAPI.resources.getTenants(clusterId).then(response => {
            if (!cancelled && response.success && response.data) {
                setTenants(response.data.map(item => item.name));
            }
        });
        return () => {
            cancelled = true;
        };
    }, [clusterId]);

    useEffect(() => {
        let cancelled = false;
        setNamespaces([]);
        void window.electronAPI.resources.getNamespaces(clusterId, tenant).then(response => {
            if (cancelled) {
                return;
            }
            if (response.success && response.data) {
                // 源自己从候选里去掉：同步到自己身上是一次白写的整值覆盖
                setNamespaces(response.data.filter(name => !(name === source.namespace && tenant === source.tenant)));
            } else {
                message.error(response.error || '获取命名空间列表失败');
            }
        });
        return () => {
            cancelled = true;
        };
    }, [clusterId, tenant, source.namespace, source.tenant]);

    const params = useMemo(
        () => ({clusterId, source, targets: targets.map(namespace => ({tenant, namespace})), fields}),
        [clusterId, source, targets, tenant, fields],
    );

    const runPlan = useCallback(async () => {
        setPlanning(true);
        setPlanError(null);
        setResult(null);
        try {
            const response = await window.electronAPI.namespacePolicy.syncPlan(params);
            if (response.success && response.data) {
                setPlan(response.data);
                if (response.data.sourceError) {
                    setPlanError(`源命名空间读不出来：${response.data.sourceError}`);
                }
            } else {
                setPlan(null);
                setPlanError(response.error || '预览差异失败');
            }
        } finally {
            setPlanning(false);
        }
    }, [params]);

    const runApply = useCallback(async () => {
        setApplying(true);
        setApplyError(null);
        try {
            const response = await window.electronAPI.namespacePolicy.syncApply(params);
            if (response.success && response.data) {
                setResult(response.data.targets);
                message.success(`同步完成：成功 ${response.data.succeeded} 项，失败 ${response.data.failed} 项`);
                onApplied();
            } else {
                setResult(null);
                setApplyError(response.error || '同步失败');
            }
        } finally {
            setApplying(false);
        }
    }, [params, onApplied]);

    const changedCount = plan
        ? plan.targets.reduce(
              (count, target) => count + target.deltas.filter(delta => delta.action !== 'skip').length,
              0,
          )
        : 0;

    const askApply = () => {
        confirmDanger({
            title: `把 ${source.tenant}/${source.namespace} 的策略同步到 ${targets.length} 个命名空间？`,
            description:
                `本次共 ${changedCount} 处改动。选中的字段在目标上是整值覆盖（不是合并），未选中的字段不受影响；` +
                '「清除」表示该字段退回 broker 全局默认，不是关闭。执行前主进程会重新读一遍两边的值，' +
                '界面这份预览只用于核对。',
            okText: '执行同步',
            onOk: async () => {
                await runApply();
            },
        });
    };

    const ready = targets.length > 0 && fields.length > 0;
    const unchanged = plan !== null && changedCount === 0 && !planError;

    return (
        <Modal
            open
            width={860}
            title={`同步策略到其它命名空间（源 ${source.tenant}/${source.namespace}）`}
            okText="预览差异"
            okButtonProps={{disabled: !ready, loading: planning}}
            onOk={() => void runPlan()}
            onCancel={onClose}
        >
            <div className="stack">
                <Card size="small" title={`目标（一次最多 ${MAX_TARGETS} 个命名空间）`}>
                    <Space size={8} wrap>
                        <Typography.Text>租户</Typography.Text>
                        <Select
                            size="small"
                            style={{width: 200}}
                            value={tenant}
                            showSearch
                            onChange={value => {
                                setTenant(value);
                                setTargets([]);
                                setPlan(null);
                            }}
                            options={(tenants.length > 0 ? tenants : [tenant]).map(name => ({
                                label: name,
                                value: name,
                            }))}
                        />
                        <Typography.Text>命名空间</Typography.Text>
                        <Select
                            mode="multiple"
                            size="small"
                            style={{minWidth: 320, maxWidth: 520}}
                            value={targets}
                            showSearch
                            maxTagCount="responsive"
                            onChange={value => {
                                setTargets(value);
                                setPlan(null);
                                setResult(null);
                            }}
                            options={namespaces.map(name => ({label: name, value: name}))}
                            placeholder={namespaces.length > 0 ? '选择目标命名空间' : '该租户下没有可选命名空间'}
                        />
                    </Space>
                </Card>

                <Card
                    size="small"
                    title="要同步的字段"
                    extra={
                        <Space size={4}>
                            <Button size="small" onClick={() => setFields(ALL_EDITABLE_FIELDS)}>
                                全选
                            </Button>
                            <Button size="small" onClick={() => setFields([])}>
                                清空
                            </Button>
                        </Space>
                    }
                >
                    <div className="stack">
                        {EDITABLE_GROUPS.map(group => (
                            <div key={group.title}>
                                <Typography.Text strong>{group.title}</Typography.Text>
                                <br />
                                <Checkbox.Group
                                    // 勾一项就等于「该字段在所有目标上按源覆盖」，所以逐项列全名而不只给分组标题
                                    value={group.fields
                                        .filter(item => fields.includes(item.field))
                                        .map(item => item.field)}
                                    onChange={values => {
                                        // 只替换本组的选项：跨组各写各的，勾掉一组不会误删另一组的勾选
                                        const inGroup = new Set(group.fields.map(item => item.field));
                                        setFields([
                                            ...fields.filter(field => !inGroup.has(field)),
                                            ...(values as NamespacePolicyField[]),
                                        ]);
                                    }}
                                    options={group.fields.map(item => ({label: item.label, value: item.field}))}
                                />
                            </div>
                        ))}
                    </div>
                </Card>

                {planError ? <Alert type="error" showIcon message="预览差异失败" description={planError} /> : null}
                {applyError ? <Alert type="error" showIcon message="同步失败" description={applyError} /> : null}
                {unchanged ? (
                    <Alert type="info" showIcon message="所选字段在所有目标上都与源一致，本次没有需要改动" />
                ) : null}

                {planning && !plan ? <StateBlock loading /> : null}

                {plan && !planError ? (
                    <Card size="small" title={`差异预览（${changedCount} 处改动）`}>
                        <div className="stack">
                            {plan.targets.map(target => (
                                <TargetPlanBlock
                                    key={`${target.tenant}/${target.namespace}`}
                                    target={target}
                                    sourceView={plan.sourceView}
                                />
                            ))}
                        </div>
                    </Card>
                ) : null}

                {result ? (
                    <Card size="small" title="执行结果">
                        <div className="stack">
                            {result.map(item => (
                                <TargetResultBlock key={`${item.tenant}/${item.namespace}`} target={item} />
                            ))}
                        </div>
                    </Card>
                ) : null}
            </div>

            {plan && !planning ? (
                <div style={{marginTop: 12, textAlign: 'right'}}>
                    <Button danger type="primary" loading={applying} disabled={changedCount === 0} onClick={askApply}>
                        执行同步
                    </Button>
                </div>
            ) : null}
        </Modal>
    );
};

export default PolicySyncModal;
