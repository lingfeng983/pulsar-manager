import React, {useCallback, useEffect, useMemo} from 'react';
import {Alert, Col, Form, Input, InputNumber, Modal, Radio, Row, Select, Switch} from 'antd';
import {
    ALERT_COMPARATORS,
    ALERT_METRICS,
    ALERT_SCOPES,
    alertMetric,
    type AlertMetricMeta,
} from '../../../shared/alert-metrics';
import {loadNamespaces, loadTenants, loadTopics} from '../../hooks/resourceCache';
import type {
    AlertComparator,
    AlertMetricKey,
    AlertRule,
    AlertRuleUpsertParams,
    AlertScope,
    ClusterConfig,
} from '../../types';

interface AlertRuleForm {
    name: string;
    clusterId: string;
    scope: AlertScope;
    tenant: string;
    namespace: string;
    topic: string;
    persistent: boolean;
    metric: AlertMetricKey;
    comparator: AlertComparator;
    // 表单里填的是"看得懂的数"（KB/秒、MB），落库要换算回原生单位
    threshold: number;
    consecutive: number;
    notify: boolean;
}

interface AlertRuleModalProps {
    open: boolean;
    clusters: ClusterConfig[];
    /** null = 新建；带行则是编辑，表单按这一行回填 */
    rule: AlertRule | null;
    saving: boolean;
    onClose: () => void;
    onSubmit: (params: AlertRuleUpsertParams) => Promise<void>;
}

const METRIC_OPTIONS = ALERT_METRICS.map(metric => ({
    value: metric.key,
    // 带上单位：只写"积压消息数"与"吞吐量"而不说单位，用户只能猜该填条数还是字节
    label: `${metric.label}（${metric.unit}）`,
}));

const SCOPE_OPTIONS = ALERT_SCOPES.map(scope => ({value: scope.key, label: scope.label}));

const COMPARATOR_OPTIONS = ALERT_COMPARATORS.map(item => ({
    value: item.key,
    // 符号在前、中文在后：只写「高于」的话，用户得回想一下方向是谁比谁
    label: `${item.symbol} ${item.label}`,
}));

const CLUSTER_OPTIONS = METRIC_OPTIONS.filter(item => item.value !== 'storageSize');

// 资源缓存里的 topic 名可能带着 "persistent://tenant/ns/" 前缀，下拉只留裸名
function shortTopic(name: string): string {
    const parts = name.split('/');
    return parts[parts.length - 1];
}

function initialForm(rule: AlertRule | null, clusters: ClusterConfig[]): AlertRuleForm {
    if (rule) {
        return {
            name: rule.name,
            clusterId: rule.clusterId,
            scope: rule.scope,
            tenant: rule.tenant,
            namespace: rule.namespace,
            topic: rule.topic,
            persistent: rule.persistent,
            metric: rule.metric,
            comparator: rule.comparator,
            threshold: rule.threshold / alertMetric(rule.metric).scale,
            consecutive: rule.consecutive,
            notify: rule.notify,
        };
    }
    return {
        name: '',
        clusterId: clusters[0]?.id ?? '',
        scope: 'topic',
        tenant: '',
        namespace: '',
        topic: '',
        persistent: true,
        metric: 'backlog',
        comparator: 'gt',
        threshold: 10000,
        consecutive: 3,
        notify: true,
    };
}

/**
 * 逐层下拉的数据源：选了集群才取租户，选了租户才取命名空间，依此类推。
 * 三份列表都走 resourceCache 的共享缓存，与资源树、全局搜索读到的是同一份数据。
 */
async function loadScopeLevel(
    clusterId: string,
    tenant: string,
    namespace: string,
): Promise<{tenants: string[]; namespaces: string[]; topics: string[]; error: string | null}> {
    const empty = {tenants: [], namespaces: [], topics: [], error: null};
    if (!clusterId) {
        return empty;
    }
    try {
        const tenants = (await loadTenants(clusterId)).map(item => item.name);
        const namespaces = tenant ? await loadNamespaces(clusterId, tenant) : [];
        const topics =
            tenant && namespace
                ? (await loadTopics(clusterId, tenant, namespace)).map(item => shortTopic(item.name))
                : [];
        return {tenants, namespaces, topics, error: null};
    } catch (error) {
        // 集群离线时这里必然失败：表单照样能填完（规则是本地数据， broker 恢复后一样会评估），
        // 只是下拉没有候选，所以提示写成 warning 而不是把表单锁死
        return {...empty, error: (error as Error).message};
    }
}

const AlertRuleModal: React.FC<AlertRuleModalProps> = ({open, clusters, rule, saving, onClose, onSubmit}) => {
    const [form] = Form.useForm<AlertRuleForm>();
    const scope = Form.useWatch('scope', form);
    const metric = Form.useWatch('metric', form);
    const clusterId = Form.useWatch('clusterId', form);
    const tenant = Form.useWatch('tenant', form);
    const namespace = Form.useWatch('namespace', form);
    const [levels, setLevels] = React.useState<{
        tenants: string[];
        namespaces: string[];
        topics: string[];
        error: string | null;
    }>({tenants: [], namespaces: [], topics: [], error: null});

    // 每次打开都重算初值：上一次留下的选择不能带进这一条规则的表单
    useEffect(() => {
        if (!open) {
            return;
        }
        const next = initialForm(rule, clusters);
        form.setFieldsValue(next);
        // 编辑已有规则时先按行上的定位取一次候选，新建则等用户选集群
        void loadScopeLevel(next.clusterId, next.tenant, next.namespace).then(setLevels);
    }, [open, rule, clusters, form]);

    useEffect(() => {
        if (!open) {
            return;
        }
        let cancelled = false;
        void loadScopeLevel(clusterId ?? '', tenant ?? '', namespace ?? '').then(result => {
            if (!cancelled) {
                setLevels(result);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [open, clusterId, tenant, namespace]);

    const metricMeta: AlertMetricMeta = useMemo(() => alertMetric(metric ?? 'backlog'), [metric]);
    const needsScope = scope !== 'cluster';

    const handleFinish = useCallback(
        (draft: AlertRuleForm) => {
            const meta = alertMetric(draft.metric);
            void onSubmit({
                id: rule?.id,
                clusterId: draft.clusterId,
                name: draft.name.trim(),
                // 停用开关在规则列表的行上，表单不动它：编辑弹窗里改个阈值
                // 却顺手把规则启用了，是最难查的那种意外
                enabled: rule?.enabled ?? true,
                scope: draft.scope,
                tenant: draft.scope === 'cluster' ? '' : draft.tenant,
                namespace: draft.scope === 'cluster' ? '' : draft.namespace,
                topic: draft.scope === 'topic' ? draft.topic : '',
                persistent: draft.persistent,
                metric: draft.metric,
                comparator: draft.comparator,
                threshold: meta.integer ? Math.round(draft.threshold * meta.scale) : draft.threshold * meta.scale,
                consecutive: draft.consecutive,
                notify: draft.notify,
            });
        },
        [onSubmit, rule],
    );

    return (
        <Modal
            title={rule ? `编辑规则「${rule.name}」` : '新建告警规则'}
            open={open}
            onCancel={onClose}
            onOk={() => form.submit()}
            okText="保存"
            cancelText="取消"
            confirmLoading={saving}
            width={620}
            destroyOnClose
        >
            <Form
                form={form}
                layout="vertical"
                initialValues={initialForm(rule, clusters)}
                onFinish={handleFinish}
                requiredMark={false}
            >
                {levels.error ? (
                    <Alert
                        type="warning"
                        showIcon
                        message={`资源列表读取失败：${levels.error}`}
                        description="集群离线时下拉没有候选，可以先填好规则，等集群恢复后再核对。"
                        style={{marginBottom: 'var(--spacing-sm)'}}
                    />
                ) : null}

                <Row gutter={12}>
                    <Col span={14}>
                        <Form.Item
                            name="name"
                            label="规则名称"
                            rules={[
                                {required: true, message: '给规则起个名字'},
                                {max: 100, message: '名称最长 100 字'},
                            ]}
                        >
                            <Input placeholder="例如：订单 Topic 积压过高" />
                        </Form.Item>
                    </Col>
                    <Col span={10}>
                        <Form.Item name="comparator" label="判定方向">
                            <Select options={COMPARATOR_OPTIONS} />
                        </Form.Item>
                    </Col>
                </Row>

                <Form.Item name="clusterId" label="集群" rules={[{required: true, message: '需要选择集群'}]}>
                    <Select
                        placeholder="选择集群"
                        // 集群列表来自 store，为空时提示去集群配置，而不是给一个空白下拉
                        notFoundContent="还没有集群，请先在「集群配置」里添加"
                        options={clusters.map(cluster => ({value: cluster.id, label: cluster.name}))}
                        onChange={() => form.setFieldsValue({tenant: '', namespace: '', topic: ''})}
                    />
                </Form.Item>

                <Form.Item name="scope" label="评估口径">
                    <Radio.Group
                        options={SCOPE_OPTIONS}
                        optionType="button"
                        onChange={event => {
                            // 换口径要重置定位：从 Topic 切回命名空间却留着 topic 名，
                            // 存进去就是"命名空间口径带着 topic"的坏规则
                            const next = event.target.value as AlertScope;
                            form.setFieldsValue({
                                scope: next,
                                tenant: next === 'cluster' ? '' : (form.getFieldValue('tenant') ?? ''),
                                namespace: next === 'cluster' ? '' : (form.getFieldValue('namespace') ?? ''),
                                topic: '',
                            });
                        }}
                    />
                </Form.Item>

                {needsScope ? (
                    <Row gutter={12}>
                        <Col span={8}>
                            <Form.Item name="tenant" label="租户">
                                <Select
                                    showSearch
                                    allowClear
                                    placeholder="租户"
                                    options={levels.tenants.map(name => ({value: name, label: name}))}
                                    onChange={() => form.setFieldsValue({namespace: '', topic: ''})}
                                />
                            </Form.Item>
                        </Col>
                        <Col span={8}>
                            <Form.Item name="namespace" label="命名空间">
                                <Select
                                    showSearch
                                    allowClear
                                    placeholder="命名空间"
                                    options={levels.namespaces.map(name => ({value: name, label: name}))}
                                    onChange={() => form.setFieldsValue({topic: ''})}
                                />
                            </Form.Item>
                        </Col>
                        <Col span={8}>
                            <Form.Item name="topic" label="Topic">
                                <Select
                                    showSearch
                                    allowClear
                                    disabled={scope !== 'topic'}
                                    placeholder={scope === 'topic' ? 'Topic' : '（命名空间口径不用选）'}
                                    options={levels.topics.map(name => ({value: name, label: name}))}
                                />
                            </Form.Item>
                        </Col>
                    </Row>
                ) : null}

                <Row gutter={12}>
                    {needsScope ? (
                        <Col span={8}>
                            <Form.Item name="persistent" label="持久 Topic" valuePropName="checked">
                                <Switch checkedChildren="是" unCheckedChildren="否" />
                            </Form.Item>
                        </Col>
                    ) : null}
                    <Col span={needsScope ? 8 : 12}>
                        <Form.Item name="metric" label="监控指标" rules={[{required: true, message: '需要选择指标'}]}>
                            <Select
                                options={scope === 'cluster' ? CLUSTER_OPTIONS : METRIC_OPTIONS}
                                // 集群口径没有存储量：切了口径还留着这个指标就换到第一项，
                                // 否则提交时才被主进程拒掉，用户看到的是"保存失败"
                                onChange={value => form.setFieldsValue({metric: value})}
                            />
                        </Form.Item>
                    </Col>
                    <Col span={8}>
                        <Form.Item
                            name="threshold"
                            label={`阈值（${metricMeta.unit}）`}
                            rules={[{required: true, message: '需要填写阈值'}]}
                        >
                            <InputNumber min={0} style={{width: '100%'}} placeholder="0" />
                        </Form.Item>
                    </Col>
                </Row>

                <Row gutter={12}>
                    <Col span={8}>
                        <Form.Item
                            name="consecutive"
                            label="连续命中轮数"
                            tooltip="连续几轮都超标才立案，用来挡住瞬时抖动"
                        >
                            <InputNumber min={1} max={60} precision={0} style={{width: '100%'}} />
                        </Form.Item>
                    </Col>
                    <Col span={8}>
                        <Form.Item name="notify" label="桌面通知" valuePropName="checked">
                            <Switch checkedChildren="开" unCheckedChildren="关" />
                        </Form.Item>
                    </Col>
                </Row>

                <div className="hint-text">
                    评估由主进程按配置中心的间隔执行；保存后用列表行的「试跑」可以随时取一次数。
                </div>
            </Form>
        </Modal>
    );
};

export default AlertRuleModal;
