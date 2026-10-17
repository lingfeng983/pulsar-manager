import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Alert, Button, Card, Modal, Select, Space, Switch, Table, Tag, Typography, message} from 'antd';
import StateBlock from '../common/StateBlock';
import {useClusterStore} from '../../store/cluster';
import type {NamespacePolicyField, NamespacePolicySyncScope, NamespacePolicyView} from '../../types';
import {POLICY_GROUPS} from './policyMeta';

interface PolicyDiffModalProps {
    clusterId: string;
    base: {tenant: string; namespace: string};
    onClose: () => void;
    // 同集群时把差异交给批量同步（v2.1 的引擎）：对比自己不写任何东西
    onSync: (payload: {targets: NamespacePolicySyncScope[]; fields: NamespacePolicyField[]}) => void;
}

interface DiffRow {
    key: string;
    label: string;
    field?: NamespacePolicyField;
    left: string;
    right: string;
    equal: boolean;
}

// 对比读的是「界面上的文案」：两侧的文案都由 policyMeta 那一行自己出，
// 所以判等也就是比这两句文案。这里不另立一套字段级比较——那等于在渲染层
// 再抄一份单位换算，早晚和面板上的对不上；主进程那套按「能否写回」的口径
// 留给同步用（限速周期、只读出一半的保留策略在那里会被归一）。
function buildRows(base: NamespacePolicyView, peer: NamespacePolicyView): DiffRow[] {
    const rows: DiffRow[] = [];
    for (const group of POLICY_GROUPS) {
        for (const row of group.rows) {
            const left = row.render(base);
            const right = row.render(peer);
            rows.push({key: row.key, label: row.label, field: row.field, left, right, equal: left === right});
        }
    }
    return rows;
}

const PolicyDiffModal: React.FC<PolicyDiffModalProps> = ({clusterId, base, onClose, onSync}) => {
    const clusters = useClusterStore(state => state.clusters);
    const fetchClusters = useClusterStore(state => state.fetchClusters);
    const [peerClusterId, setPeerClusterId] = useState(clusterId);
    const [tenants, setTenants] = useState<string[]>([]);
    const [peerTenant, setPeerTenant] = useState(base.tenant);
    const [namespaces, setNamespaces] = useState<string[]>([]);
    const [peerNamespace, setPeerNamespace] = useState<string | null>(null);
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

    const sameNamespace = peerClusterId === clusterId && peerTenant === base.tenant && peerNamespace === base.namespace;
    const ready = !!peerNamespace && !sameNamespace;
    const sameCluster = peerClusterId === clusterId;

    // 每次对比都重新读两边：这里要回答的是「现在这两份配置一样吗」，
    // 拿面板上那份可能几分钟前读的视图来比，结论一过期就会误导下一步操作。
    const runDiff = useCallback(async () => {
        if (!peerNamespace) {
            return;
        }
        setLoading(true);
        setError(null);
        setRows(null);
        try {
            const [baseResponse, peerResponse] = await Promise.all([
                window.electronAPI.namespacePolicy.get({clusterId, tenant: base.tenant, namespace: base.namespace}),
                window.electronAPI.namespacePolicy.get({
                    clusterId: peerClusterId,
                    tenant: peerTenant,
                    namespace: peerNamespace,
                }),
            ]);
            if (!baseResponse.success || !baseResponse.data) {
                setError(`读基准命名空间失败：${baseResponse.error || '未知原因'}`);
                return;
            }
            if (!peerResponse.success || !peerResponse.data) {
                setError(`读对端命名空间失败：${peerResponse.error || '未知原因'}`);
                return;
            }
            setRows(buildRows(baseResponse.data, peerResponse.data));
        } finally {
            setLoading(false);
        }
    }, [base.namespace, base.tenant, clusterId, peerClusterId, peerNamespace, peerTenant]);

    const diffRows = useMemo(() => (rows ? rows.filter(row => !row.equal) : []), [rows]);
    // 只读行（允许的集群、订阅类型、资源组）在 policyMeta 里没有 field，天然进不了同步字段
    const syncFields = useMemo(
        () => diffRows.filter(row => !!row.field).map(row => row.field as NamespacePolicyField),
        [diffRows],
    );
    const readOnlyDiffCount = diffRows.length - syncFields.length;
    const peerName = peerNamespace ?? '—';

    const columns = [
        {title: '字段', dataIndex: 'label', width: 200},
        {title: '基准', dataIndex: 'left', width: 240},
        {
            title: `对端（${peerTenant}/${peerName}）`,
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
            title="与另一个命名空间对比策略"
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
                            style={{width: 200}}
                            value={peerClusterId}
                            showSearch
                            optionFilterProp="label"
                            onChange={value => {
                                setPeerClusterId(value);
                                setPeerTenant(base.tenant);
                                setPeerNamespace(null);
                                setRows(null);
                                setError(null);
                            }}
                            options={clusters.map(item => ({label: item.name, value: item.id}))}
                        />
                        <Typography.Text>租户</Typography.Text>
                        <Select
                            size="small"
                            style={{width: 180}}
                            value={peerTenant}
                            showSearch
                            onChange={value => {
                                setPeerTenant(value);
                                setPeerNamespace(null);
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
                            style={{width: 220}}
                            value={peerNamespace}
                            showSearch
                            onChange={value => {
                                setPeerNamespace(value);
                                setRows(null);
                            }}
                            options={namespaces.map(name => ({label: name, value: name}))}
                            placeholder={namespaces.length > 0 ? '选择对端命名空间' : '该租户下没有命名空间'}
                        />
                    </Space>
                    {sameNamespace ? (
                        <Typography.Text type="secondary" style={{display: 'block', marginTop: 8}}>
                            对端与基准是同一个命名空间，自己跟自己比永远是「一致」。
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
                                <Alert type="info" showIcon message="两个命名空间在界面列出的这些项上完全一致" />
                            ) : null}
                            {POLICY_GROUPS.map(group => {
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
                            {readOnlyDiffCount > 0 ? (
                                <Typography.Text type="secondary">
                                    其中 {readOnlyDiffCount} 项是只读项（broker 侧没有写入口），不参与同步。
                                </Typography.Text>
                            ) : null}
                            {syncFields.length > 0 && sameCluster ? (
                                <Space size={8} wrap>
                                    <Button
                                        type="primary"
                                        onClick={() =>
                                            onSync({
                                                targets: [{tenant: peerTenant, namespace: peerName}],
                                                fields: syncFields,
                                            })
                                        }
                                    >
                                        把这 {syncFields.length} 项差异以基准为准同步到对端
                                    </Button>
                                    <Typography.Text type="secondary">
                                        同步预览会按「能不能原样写回」重新判一次，个别项到预览才发现不用改（例如限速的周期）。
                                    </Typography.Text>
                                </Space>
                            ) : null}
                            {syncFields.length > 0 && !sameCluster ? (
                                <Typography.Text type="secondary">
                                    跨集群只做对比：批量同步的目标命名空间与源属于同一个集群，
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

export default PolicyDiffModal;
