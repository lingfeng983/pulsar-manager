import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Alert, Button, Card, Modal, Select, Space, Switch, Table, Tag, Typography, message} from 'antd';
import StateBlock from '../common/StateBlock';
import {useClusterStore} from '../../store/cluster';
import {shortName} from '../../utils/format';
import {TOPIC_POLICY_GROUPS} from './topicPolicyMeta';
import type {TopicPolicyField, TopicPolicySyncScope, TopicPolicyView} from '../../types';

interface TopicPolicyDiffModalProps {
    clusterId: string;
    base: TopicPolicySyncScope;
    onClose: () => void;
    // 同集群时把差异交给批量同步：对比自己不写任何东西
    onSync: (payload: {targets: TopicPolicySyncScope[]; fields: TopicPolicyField[]}) => void;
}

interface DiffRow {
    key: string;
    label: string;
    field: TopicPolicyField;
    left: string;
    right: string;
    equal: boolean;
}

interface PeerOption extends TopicPolicySyncScope {
    label: string;
}

// 对比读的是「界面上的文案」：两侧的文案都由 topicPolicyMeta 那一行自己出，
// 所以判等也就是比这两句文案。这里不另立一套字段级比较——那等于在渲染层
// 再抄一份取值口径，早晚和面板上的对不上；主进程那套按「能否原样写回」的口径
// 留给同步用（只读出一半的保留策略、读不出来的端点在那里会被单独处理）。
function buildRows(base: TopicPolicyView, peer: TopicPolicyView): DiffRow[] {
    const rows: DiffRow[] = [];
    for (const group of TOPIC_POLICY_GROUPS) {
        for (const row of group.rows) {
            const left = row.render(base);
            const right = row.render(peer);
            rows.push({key: row.key, label: row.label, field: row.field, left, right, equal: left === right});
        }
    }
    return rows;
}

function scopeLabel(scope: TopicPolicySyncScope): string {
    return `${scope.persistent ? 'p' : 'np'}://${scope.tenant}/${scope.namespace}/${scope.topic}`;
}

const TopicPolicyDiffModal: React.FC<TopicPolicyDiffModalProps> = ({clusterId, base, onClose, onSync}) => {
    const clusters = useClusterStore(state => state.clusters);
    const fetchClusters = useClusterStore(state => state.fetchClusters);
    const [peerClusterId, setPeerClusterId] = useState(clusterId);
    const [tenants, setTenants] = useState<string[]>([]);
    const [peerTenant, setPeerTenant] = useState(base.tenant);
    const [namespaces, setNamespaces] = useState<string[]>([]);
    const [peerNamespace, setPeerNamespace] = useState<string | null>(base.namespace);
    const [peers, setPeers] = useState<PeerOption[]>([]);
    const [peerTopic, setPeerTopic] = useState<string | null>(null);
    const [rows, setRows] = useState<DiffRow[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [onlyDiff, setOnlyDiff] = useState(true);

    useEffect(() => {
        if (clusters.length === 0) {
            void fetchClusters();
        }
    }, [clusters.length, fetchClusters]);

    // 换集群要先重取租户：命名空间清单挂在所选集群下，留着上一份会选到对端没有的名字
    useEffect(() => {
        let cancelled = false;
        setTenants([]);
        void window.electronAPI.resources.getTenants(peerClusterId).then(response => {
            if (!cancelled && response.success && response.data) {
                setTenants(response.data.map(item => item.name));
            }
        });
        return () => {
            cancelled = true;
        };
    }, [peerClusterId]);

    useEffect(() => {
        let cancelled = false;
        setNamespaces([]);
        void window.electronAPI.resources.getNamespaces(peerClusterId, peerTenant).then(response => {
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
    }, [peerClusterId, peerTenant]);

    useEffect(() => {
        let cancelled = false;
        setPeers([]);
        if (!peerNamespace) {
            return () => {
                cancelled = true;
            };
        }
        void window.electronAPI.resources.getTopics(peerClusterId, peerTenant, peerNamespace).then(response => {
            if (cancelled) {
                return;
            }
            if (!response.success || !response.data) {
                message.error(response.error || '获取 topic 列表失败');
                return;
            }
            setPeers(
                response.data.map(item => ({
                    tenant: peerTenant,
                    namespace: peerNamespace,
                    topic: shortName(item.name),
                    persistent: item.persistent,
                    // 同名 topic 的持久与非持久两行都要能分辨：只看名字会选错对象
                    label: `${shortName(item.name)}（${item.persistent ? '持久' : '非持久'}）`,
                })),
            );
        });
        return () => {
            cancelled = true;
        };
    }, [peerClusterId, peerTenant, peerNamespace]);

    const peer = useMemo(() => peers.find(item => optionKeyOf(item) === peerTopic) ?? null, [peers, peerTopic]);
    const sameTopic = !!peer && scopeLabel(peer) === scopeLabel(base) && peerClusterId === clusterId;
    const ready = !!peer && !sameTopic;
    const sameCluster = peerClusterId === clusterId;

    // 每次对比都重新读两边：这里要回答的是「现在这两份配置一样吗」，
    // 拿面板上那份可能几分钟前读的视图来比，结论一过期就会误导下一步操作。
    const runDiff = useCallback(async () => {
        if (!peer) {
            return;
        }
        setLoading(true);
        setError(null);
        setRows(null);
        try {
            const [baseResponse, peerResponse] = await Promise.all([
                window.electronAPI.topicPolicy.get({clusterId, ...base}),
                window.electronAPI.topicPolicy.get({clusterId: peerClusterId, ...peer}),
            ]);
            if (!baseResponse.success || !baseResponse.data) {
                setError(`读基准 topic 失败：${baseResponse.error || '未知原因'}`);
                return;
            }
            if (!peerResponse.success || !peerResponse.data) {
                setError(`读对端 topic 失败：${peerResponse.error || '未知原因'}`);
                return;
            }
            setRows(buildRows(baseResponse.data, peerResponse.data));
        } finally {
            setLoading(false);
        }
    }, [base, clusterId, peer, peerClusterId]);

    const diffRows = useMemo(() => (rows ? rows.filter(row => !row.equal) : []), [rows]);
    // 这里每一行都有 field（topic 级没有只读行），所以差异项全部可以进同步字段
    const syncFields = useMemo(() => diffRows.map(row => row.field), [diffRows]);
    // 两侧都显示「未设置」时，含义是「各按自己的命名空间生效」，不等于两边生效值相同
    const bothInherit = rows ? rows.filter(row => row.equal && row.left.startsWith('未设置')).length : 0;

    const columns = [
        {title: '字段', dataIndex: 'label', width: 180},
        {title: '基准', dataIndex: 'left', width: 260},
        {
            title: `对端（${peer ? `${scopeLabel(peer)}` : '—'}）`,
            dataIndex: 'right',
            render: (value: string, row: DiffRow) => (row.equal ? value : <strong>{value}</strong>),
        },
        {
            title: '状态',
            width: 88,
            render: (_: unknown, row: DiffRow) => (row.equal ? <Tag>一致</Tag> : <Tag color="orange">不同</Tag>),
        },
    ];

    return (
        <Modal
            open
            width={900}
            title="与另一个 topic 对比策略"
            okText="开始对比"
            okButtonProps={{disabled: !ready, loading}}
            onOk={() => void runDiff()}
            onCancel={onClose}
        >
            <div className="stack">
                <Card size="small" title="对端（对比只读，不会改动任何一边）">
                    <Space size={8} wrap>
                        <Typography.Text>集群</Typography.Text>
                        <Select
                            size="small"
                            style={{width: 180}}
                            value={peerClusterId}
                            showSearch
                            optionFilterProp="label"
                            onChange={value => {
                                setPeerClusterId(value);
                                setPeerTenant(base.tenant);
                                setPeerNamespace(base.namespace);
                                setPeerTopic(null);
                                setRows(null);
                                setError(null);
                            }}
                            options={clusters.map(item => ({label: item.name, value: item.id}))}
                        />
                        <Typography.Text>租户</Typography.Text>
                        <Select
                            size="small"
                            style={{width: 150}}
                            value={peerTenant}
                            showSearch
                            onChange={value => {
                                setPeerTenant(value);
                                setPeerNamespace(null);
                                setPeerTopic(null);
                                setRows(null);
                            }}
                            options={(tenants.length > 0 ? tenants : [peerTenant]).map(name => ({
                                label: name,
                                value: name,
                            }))}
                        />
                        <Typography.Text>命名空间</Typography.Text>
                        <Select
                            size="small"
                            style={{width: 170}}
                            value={peerNamespace}
                            showSearch
                            onChange={value => {
                                setPeerNamespace(value);
                                setPeerTopic(null);
                                setRows(null);
                            }}
                            options={namespaces.map(name => ({label: name, value: name}))}
                            placeholder={namespaces.length > 0 ? '选择命名空间' : '该租户下没有命名空间'}
                        />
                        <Typography.Text>Topic</Typography.Text>
                        <Select
                            size="small"
                            style={{width: 240}}
                            value={peerTopic}
                            showSearch
                            onChange={value => {
                                setPeerTopic(value);
                                setRows(null);
                            }}
                            options={peers.map(item => ({label: item.label, value: optionKeyOf(item)}))}
                            placeholder={peers.length > 0 ? '选择对端 topic' : '该命名空间下没有 topic'}
                        />
                    </Space>
                    {sameTopic ? (
                        <Typography.Text type="secondary" style={{display: 'block', marginTop: 8}}>
                            对端与基准是同一个 topic，自己跟自己比永远是「一致」。
                        </Typography.Text>
                    ) : null}
                </Card>

                {error ? <Alert type="error" showIcon message="对比失败" description={error} /> : null}
                {loading && !rows ? <StateBlock loading /> : null}

                {rows ? (
                    <Card
                        size="small"
                        title={`对比结果：${diffRows.length} 项不同`}
                        extra={
                            <Space size={8}>
                                <Typography.Text type="secondary">只看差异</Typography.Text>
                                <Switch size="small" checked={onlyDiff} onChange={setOnlyDiff} />
                            </Space>
                        }
                    >
                        <div className="stack">
                            {diffRows.length === 0 ? (
                                <Alert type="info" showIcon message="两个 topic 在这五项 topic 级覆盖上完全一致" />
                            ) : null}
                            {bothInherit > 0 ? (
                                <Alert
                                    type="warning"
                                    showIcon
                                    message={`其中 ${bothInherit} 项两侧都显示「未设置」`}
                                    description="「未设置」表示各自沿用所在命名空间的值，两边填的一样时这里才算真的一样。"
                                />
                            ) : null}
                            {TOPIC_POLICY_GROUPS.map(group => {
                                const groupRows = group.rows
                                    .map(row => rows.find(item => item.key === row.key))
                                    .filter((row): row is DiffRow => !!row)
                                    .filter(row => !onlyDiff || !row.equal);
                                if (groupRows.length === 0) {
                                    return null;
                                }
                                return (
                                    <Table
                                        key={group.title}
                                        size="small"
                                        rowKey="key"
                                        dataSource={groupRows}
                                        columns={columns}
                                        pagination={false}
                                    />
                                );
                            })}
                            {syncFields.length > 0 && sameCluster && peer ? (
                                <Space size={8} wrap>
                                    <Button
                                        type="primary"
                                        onClick={() => onSync({targets: [peer], fields: syncFields})}
                                    >
                                        把这 {syncFields.length} 项差异以基准为准同步到对端
                                    </Button>
                                    <Typography.Text type="secondary">
                                        同步预览会按「能不能原样写回」重新判一次，读不出来的项到预览会变成「不变」并带原因。
                                    </Typography.Text>
                                </Space>
                            ) : null}
                            {syncFields.length > 0 && !sameCluster ? (
                                <Typography.Text type="secondary">
                                    跨集群只做对比：批量同步的目标 topic 与源属于同一个集群，
                                    要把基准推到这个集群，得先切到该集群再发起同步。
                                </Typography.Text>
                            ) : null}
                        </div>
                    </Card>
                ) : null}
            </div>
        </Modal>
    );
};

// 候选项的键带持久标记：同名 topic 的持久与非持久两行是两个对象
function optionKeyOf(scope: TopicPolicySyncScope): string {
    return `${scope.persistent ? 'p' : 'n'}/${scope.topic}`;
}

export default TopicPolicyDiffModal;
