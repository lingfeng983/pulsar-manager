import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Alert, Button, Card, Checkbox, Modal, Select, Space, Table, Tag, Typography, message} from 'antd';
import StateBlock from '../common/StateBlock';
import {useConfirmDanger} from '../common/dangerConfirm';
import {shortName} from '../../utils/format';
import {TOPIC_POLICY_GROUPS, TOPIC_POLICY_ROW_BY_FIELD, topicPolicyFieldLabel} from './topicPolicyMeta';
import type {
    TopicPolicyField,
    TopicPolicySyncDelta,
    TopicPolicySyncItemResult,
    TopicPolicySyncPlanResult,
    TopicPolicySyncScope,
    TopicPolicySyncTargetPlan,
    TopicPolicySyncTargetResult,
    TopicPolicyView,
} from '../../types';

interface TopicPolicySyncModalProps {
    clusterId: string;
    source: {tenant: string; namespace: string; topic: string; persistent: boolean};
    // 从对比弹窗带过来的预选：目标就是那个对端 topic，字段就是界面判出的差异项
    initialTargets?: TopicPolicySyncScope[];
    initialFields?: TopicPolicyField[];
    onClose: () => void;
    onApplied: () => void;
}

const EDITABLE_GROUPS: {title: string; fields: {field: TopicPolicyField; label: string}[]}[] = TOPIC_POLICY_GROUPS.map(
    group => ({
        title: group.title,
        fields: group.rows.map(row => ({field: row.field, label: row.label})),
    }),
);

const ALL_EDITABLE_FIELDS: TopicPolicyField[] = EDITABLE_GROUPS.flatMap(group => group.fields.map(item => item.field));

// 与主进程编排层的 TOPIC_SYNC_MAX_TARGETS 同一个数：这里只负责把上限说在界面上，
// 真正拦下超量请求的是参数校验，两处各写一份迟早一边能选一边被拒。
const MAX_TARGETS = 20;

// 只给界面用的候选条目：topic 名与是否持久要成对出现，
// 拆开后写 params 时容易把非持久 topic 当持久的发出去。
interface TopicOption extends TopicPolicySyncScope {
    label: string;
}

// 候选的键必须带持久标记：persistent 与 non-persistent 下的同名 topic 是两个 topic，
// 只用 topic 名当键会让「选中哪一个」取决于清单里的先后顺序。
function optionKey(item: {topic: string; persistent: boolean}): string {
    return `${item.persistent ? 'p' : 'n'}/${item.topic}`;
}

function scopeLabel(scope: {tenant: string; namespace: string; topic: string; persistent: boolean}): string {
    return `${scope.persistent ? 'p' : 'np'}://${scope.tenant}/${scope.namespace}/${scope.topic}`;
}

function deltaSides(
    delta: TopicPolicySyncDelta,
    target: TopicPolicySyncTargetPlan,
    sourceView: TopicPolicyView | undefined,
): {from: string; to: string} {
    const row = TOPIC_POLICY_ROW_BY_FIELD.get(delta.field);
    const from = row && target.view ? row.render(target.view) : '—';
    if (delta.action === 'clear') {
        // topic 级的「清除」是撤销覆盖退回命名空间，不是关闭这一项
        return {from, to: '清除覆盖（沿用命名空间/broker 的值）'};
    }
    if (delta.action === 'skip') {
        return {from, to: delta.reason ?? '保持不变'};
    }
    return {from, to: row && sourceView ? row.render(sourceView) : '—'};
}

const actionTag = (delta: TopicPolicySyncDelta) => {
    if (delta.action === 'clear') {
        return <Tag color="orange">清除</Tag>;
    }
    return delta.action === 'skip' ? <Tag>不变</Tag> : <Tag color="blue">改为</Tag>;
};

const TargetPlanBlock: React.FC<{target: TopicPolicySyncTargetPlan; sourceView?: TopicPolicyView}> = ({
    target,
    sourceView,
}) => {
    const rows = target.deltas.map(delta => ({delta, sides: deltaSides(delta, target, sourceView)}));
    return (
        <Card size="small" type="inner" title={scopeLabel(target)}>
            {target.error ? <Alert type="error" showIcon message={target.error} /> : null}
            {!target.error && rows.length === 0 ? (
                <Typography.Text type="secondary">所选字段已经与源一致，无需改动</Typography.Text>
            ) : null}
            {rows.length > 0 ? (
                <Table
                    size="small"
                    rowKey={row => row.delta.field}
                    dataSource={rows}
                    pagination={false}
                    columns={[
                        {
                            title: '字段',
                            width: 180,
                            render: (_: unknown, row) => topicPolicyFieldLabel(row.delta.field),
                        },
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

const TargetResultBlock: React.FC<{target: TopicPolicySyncTargetResult}> = ({target}) => (
    <Card size="small" type="inner" title={scopeLabel(target)}>
        {target.error ? <Alert type="error" showIcon message={target.error} /> : null}
        {target.items.length === 0 && !target.error ? (
            <Typography.Text type="secondary">该 topic 无需改动</Typography.Text>
        ) : null}
        {target.items.length > 0 ? (
            <Table
                size="small"
                rowKey={row => row.field}
                dataSource={target.items}
                pagination={false}
                columns={[
                    {
                        title: '字段',
                        width: 180,
                        render: (_: unknown, row: TopicPolicySyncItemResult) => topicPolicyFieldLabel(row.field),
                    },
                    {
                        title: '结果',
                        width: 90,
                        render: (_: unknown, row: TopicPolicySyncItemResult) =>
                            row.action === 'skip' ? (
                                <Tag>不变</Tag>
                            ) : row.ok ? (
                                <Tag color="green">已写入</Tag>
                            ) : (
                                <Tag color="red">失败</Tag>
                            ),
                    },
                    {title: '说明', render: (_: unknown, row: TopicPolicySyncItemResult) => row.message ?? '—'},
                ]}
            />
        ) : null}
    </Card>
);

const TopicPolicySyncModal: React.FC<TopicPolicySyncModalProps> = ({
    clusterId,
    source,
    initialTargets,
    initialFields,
    onClose,
    onApplied,
}) => {
    const [tenants, setTenants] = useState<string[]>([]);
    const initialTenant = initialTargets?.[0]?.tenant ?? source.tenant;
    const [tenant, setTenant] = useState(initialTenant);
    const [namespaces, setNamespaces] = useState<string[]>([]);
    const initialNamespace = initialTargets?.[0]?.namespace ?? source.namespace;
    const [namespace, setNamespace] = useState(initialNamespace);
    const [topics, setTopics] = useState<TopicOption[]>([]);
    const [targets, setTargets] = useState<string[]>(() =>
        (initialTargets ?? [])
            .filter(item => item.tenant === initialTenant && item.namespace === initialNamespace)
            .map(optionKey),
    );
    const [fields, setFields] = useState<TopicPolicyField[]>(initialFields ?? []);
    const [plan, setPlan] = useState<TopicPolicySyncPlanResult | null>(null);
    const [planning, setPlanning] = useState(false);
    const [planError, setPlanError] = useState<string | null>(null);
    const [result, setResult] = useState<TopicPolicySyncTargetResult[] | null>(null);
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
                setNamespaces(response.data);
            } else {
                message.error(response.error || '获取命名空间列表失败');
            }
        });
        return () => {
            cancelled = true;
        };
    }, [clusterId, tenant]);

    // 目标清单按「一个租户 + 一个命名空间」给出：topic 列表本身是命名空间级的，
    // 跨命名空间凑目标会让这一屏的候选数随选择跳变，也比主进程一次 20 个上限更难核对。
    useEffect(() => {
        let cancelled = false;
        setTopics([]);
        void window.electronAPI.resources.getTopics(clusterId, tenant, namespace).then(response => {
            if (cancelled) {
                return;
            }
            if (!response.success || !response.data) {
                message.error(response.error || '获取 topic 列表失败');
                return;
            }
            setTopics(
                response.data
                    // 源自己从候选里去掉：同步到自己身上是一次白写的整值覆盖。
                    // 判等要带 persistent——persistent 与 non-persistent 下的同名 topic
                    // 是两个 topic，那种目标合法，不该被当成源自己剔掉。
                    .filter(
                        item =>
                            !(
                                item.persistent === source.persistent &&
                                shortName(item.name) === source.topic &&
                                tenant === source.tenant &&
                                namespace === source.namespace
                            ),
                    )
                    .map(item => ({
                        tenant,
                        namespace,
                        topic: shortName(item.name),
                        persistent: item.persistent,
                        label: `${shortName(item.name)}（${item.persistent ? '持久' : '非持久'}）`,
                    })),
            );
        });
        return () => {
            cancelled = true;
        };
    }, [clusterId, tenant, namespace, source.namespace, source.persistent, source.tenant, source.topic]);

    const params = useMemo(
        () => ({
            clusterId,
            source,
            // 界面选的是「持久标记 + 名字」这一对，落到参数里才是完整的 topic 作用域
            targets: targets
                .map(key => topics.find(item => optionKey(item) === key))
                .filter((item): item is TopicOption => !!item)
                .map(item => ({
                    tenant: item.tenant,
                    namespace: item.namespace,
                    topic: item.topic,
                    persistent: item.persistent,
                })),
            fields,
        }),
        [clusterId, source, targets, fields, topics],
    );

    const runPlan = useCallback(async () => {
        setPlanning(true);
        setPlanError(null);
        setResult(null);
        try {
            const response = await window.electronAPI.topicPolicy.syncPlan(params);
            if (response.success && response.data) {
                setPlan(response.data);
                if (response.data.sourceError) {
                    setPlanError(`源 topic 读不出来：${response.data.sourceError}`);
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
            const response = await window.electronAPI.topicPolicy.syncApply(params);
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
            title: `把 ${scopeLabel(source)} 的策略同步到 ${targets.length} 个 topic？`,
            description:
                `本次共 ${changedCount} 处改动。选中的字段在目标上是整值覆盖（不是合并），未选中的字段不受影响；` +
                '「清除」表示撤销目标上的 topic 级覆盖、退回命名空间的值，那个值可能正好相反。' +
                '执行前主进程会重新读一遍两边的值，界面这份预览只用于核对。',
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
            title={`同步 topic 级策略到其它 topic（源 ${scopeLabel(source)}）`}
            okText="预览差异"
            okButtonProps={{disabled: !ready, loading: planning}}
            onOk={() => void runPlan()}
            onCancel={onClose}
        >
            <div className="stack">
                <Card size="small" title={`目标（一次最多 ${MAX_TARGETS} 个 topic）`}>
                    <Space size={8} wrap>
                        <Typography.Text>租户</Typography.Text>
                        <Select
                            size="small"
                            style={{width: 160}}
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
                            size="small"
                            style={{width: 180}}
                            value={namespace}
                            showSearch
                            onChange={value => {
                                setNamespace(value);
                                setTargets([]);
                                setPlan(null);
                            }}
                            options={(namespaces.length > 0 ? namespaces : [namespace]).map(name => ({
                                label: name,
                                value: name,
                            }))}
                        />
                        <Typography.Text>Topic</Typography.Text>
                        <Select
                            mode="multiple"
                            size="small"
                            style={{minWidth: 320, maxWidth: 520}}
                            value={targets}
                            showSearch
                            maxTagCount="responsive"
                            // 与命名空间同步同一条规矩：上限在选的时候就拦住，
                            // 不让用户填满一屏再被主进程的 zod 拒绝
                            maxCount={MAX_TARGETS}
                            onChange={value => {
                                setTargets(value);
                                setPlan(null);
                                setResult(null);
                            }}
                            options={topics.map(item => ({label: item.label, value: optionKey(item)}))}
                            placeholder={topics.length > 0 ? '选择目标 topic' : '该命名空间下没有可选 topic'}
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
                                            ...(values as TopicPolicyField[]),
                                        ]);
                                    }}
                                    options={group.fields.map(item => ({label: item.label, value: item.field}))}
                                />
                            </div>
                        ))}
                        <Typography.Text type="secondary">
                            读不出来的字段（broker 没开 topic 级策略、版本太旧）会整项标「不变」并带上原因，
                            不会被当成「源没设过」而清掉目标上的覆盖。
                        </Typography.Text>
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
                                    key={scopeLabel(target)}
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
                                <TargetResultBlock key={scopeLabel(item)} target={item} />
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

export default TopicPolicySyncModal;
