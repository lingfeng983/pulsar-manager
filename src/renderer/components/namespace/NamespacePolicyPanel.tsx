import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Button, Card, Drawer, Space, Tag, Typography, message} from 'antd';
import {DeleteOutlined, EditOutlined, ReloadOutlined} from '@ant-design/icons';
import StateBlock from '../common/StateBlock';
import {useConfirmDanger} from '../common/dangerConfirm';
import IconButton from '../common/IconButton';
import type {NamespaceBacklogQuota, NamespacePolicyField, NamespacePolicyView} from '../../types';
import {NOT_SET, POLICY_GROUPS, PolicyRow, isClearable} from './policyMeta';
import PolicyEditModal from './PolicyEditModal';
import PolicySyncModal from './PolicySyncModal';

interface NamespacePolicyPanelProps {
    clusterId: string;
    tenant: string;
    namespace: string;
    active?: boolean;
}

const MB = 1024 * 1024;

function humanBytes(bytes: number): string {
    if (bytes >= MB) {
        return `${Math.round((bytes / MB) * 100) / 100}MB`;
    }
    return `${bytes}B`;
}

// 一个端点下挂着多条配额（按存储 / 按消息年龄），逐条列出来才能各清各的；
// 只显示聚合值的话，想撤掉其中一条只能把两条一起重写。
interface QuotaDetailRowsProps {
    quotas: NamespaceBacklogQuota[];
    busy: string | null;
    onClear: (quotaType: string) => void;
}

const QuotaDetailRows: React.FC<QuotaDetailRowsProps> = ({quotas, busy, onClear}) => (
    <>
        {quotas.map(quota => (
            <div className="policy-row" key={quota.type}>
                <span className="policy-row-label">{`已存配额 · ${quota.type}`}</span>
                <span className="policy-row-value">
                    {`上限 ${humanBytes(quota.limitSizeBytes)}`}
                    {quota.limitTimeSeconds > 0 ? `，时限 ${quota.limitTimeSeconds}s` : ''}
                    {`，超限 ${quota.policy}`}
                </span>
                <span className="policy-row-actions">
                    <IconButton
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        label={`清除 ${quota.type} 配额`}
                        loading={busy === `backlogQuota:${quota.type}`}
                        onClick={() => onClear(quota.type)}
                    />
                </span>
            </div>
        ))}
    </>
);

// 命名空间策略是「读一份、按字段写」的面板：值全部来自 broker，不留本地副本，
// 所以改完必须重读一次——否则界面显示的是刚才填的数，而不是 broker 真正接受的数。
const NamespacePolicyPanel: React.FC<NamespacePolicyPanelProps> = ({clusterId, tenant, namespace, active = true}) => {
    const [view, setView] = useState<NamespacePolicyView | null>(null);
    const [clusterOptions, setClusterOptions] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<PolicyRow | null>(null);
    const [rawOpen, setRawOpen] = useState(false);
    const [syncOpen, setSyncOpen] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const loadedRef = useRef(false);
    const requestIdRef = useRef(0);
    const confirmDanger = useConfirmDanger();

    const load = useCallback(async () => {
        const currentRequestId = ++requestIdRef.current;
        setLoading(true);
        setError(null);
        try {
            const [policies, clusters] = await Promise.all([
                window.electronAPI.namespacePolicy.get({clusterId, tenant, namespace}),
                window.electronAPI.resources.getPulsarClusters(clusterId),
            ]);
            if (currentRequestId !== requestIdRef.current) {
                return;
            }
            if (policies.success && policies.data) {
                setView(policies.data);
                loadedRef.current = true;
            } else {
                setError(policies.error || '获取命名空间策略失败');
            }
            // 集群清单只服务复制目标的候选，取不到不该让整页失败
            setClusterOptions(clusters.success ? clusters.data || [] : []);
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
    }, [clusterId, tenant, namespace]);

    useEffect(() => {
        if (active && !loadedRef.current) {
            void load();
        }
    }, [active, load]);

    const clearField = async (row: PolicyRow, field: NamespacePolicyField, quotaType?: string) => {
        const key = `${field}:${quotaType ?? ''}`;
        setBusy(key);
        try {
            const response = await window.electronAPI.namespacePolicy.clear({
                clusterId,
                tenant,
                namespace,
                field,
                quotaType,
            });
            if (response.success) {
                message.success(`${row.label}已清除`);
                await load();
            } else {
                message.error(response.error || '清除失败');
            }
        } finally {
            setBusy(null);
        }
    };

    // 清除不是"删掉一条记录"，而是把命名空间级覆盖撤掉、退回 broker 默认。
    // 默认值可能是"不保留"或"不限"，与当前值差一个方向，所以每一笔都要确认。
    const askClear = (row: PolicyRow, field: NamespacePolicyField, quotaType?: string) => {
        confirmDanger({
            title: `清除${row.label}？`,
            description: '清除后这一项退回 broker 全局默认，不是"关闭"。默认值可能是无限，也可能是完全不保留。',
            okText: '清除',
            onOk: async () => {
                await clearField(row, field, quotaType);
            },
        });
    };

    const quotaRows = useMemo(() => (view ? view.backlogQuotas : []), [view]);

    return (
        <div className="stack">
            <Card
                size="small"
                title={`命名空间策略 (${tenant}/${namespace})`}
                extra={
                    <Space size={4}>
                        <Button size="small" onClick={() => setRawOpen(true)} disabled={!view}>
                            原始 JSON
                        </Button>
                        <Button size="small" disabled={!view} onClick={() => setSyncOpen(true)}>
                            同步到其他命名空间
                        </Button>
                        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
                            刷新
                        </Button>
                    </Space>
                }
            >
                <StateBlock
                    loading={loading && !view}
                    error={error}
                    errorTitle="获取命名空间策略失败"
                    onRetry={load}
                    empty={!view}
                    emptyText="没有读到策略"
                >
                    <Typography.Text type="secondary">
                        这里列的是命名空间级覆盖；显示「{NOT_SET}」的项由 broker
                        全局默认决定，改它会新建命名空间级覆盖。
                    </Typography.Text>
                </StateBlock>
            </Card>

            {view
                ? POLICY_GROUPS.map(group => (
                      <Card key={group.title} size="small" title={group.title}>
                          <div className="stack">
                              {group.rows.map(row => {
                                  if (!row.field || !row.editor) {
                                      return (
                                          <div className="policy-row" key={row.key}>
                                              <span className="policy-row-label">{row.label}</span>
                                              <span className="policy-row-value">{row.render(view)}</span>
                                              <span className="policy-row-actions">
                                                  <Tag>只读</Tag>
                                              </span>
                                          </div>
                                      );
                                  }
                                  const clearable = isClearable(view, row.field);
                                  return (
                                      <React.Fragment key={row.key}>
                                          <div className="policy-row">
                                              <span className="policy-row-label">{row.label}</span>
                                              <span className="policy-row-value">
                                                  {row.render(view)}
                                                  {row.hint ? (
                                                      <Typography.Text type="secondary" style={{marginLeft: 8}}>
                                                          {row.hint}
                                                      </Typography.Text>
                                                  ) : null}
                                              </span>
                                              <span className="policy-row-actions">
                                                  <IconButton
                                                      size="small"
                                                      icon={<EditOutlined />}
                                                      label={`修改${row.label}`}
                                                      onClick={() => setEditing(row)}
                                                  />
                                                  {clearable ? (
                                                      <IconButton
                                                          size="small"
                                                          danger
                                                          icon={<DeleteOutlined />}
                                                          label={`清除${row.label}`}
                                                          loading={busy === `${row.field}:`}
                                                          onClick={() =>
                                                              askClear(row, row.field as NamespacePolicyField)
                                                          }
                                                      />
                                                  ) : null}
                                              </span>
                                          </div>
                                          {row.key === 'backlogQuota' ? (
                                              <QuotaDetailRows
                                                  quotas={quotaRows}
                                                  busy={busy}
                                                  onClear={type =>
                                                      askClear(
                                                          {key: 'backlogQuota', label: '该条配额', render: () => ''},
                                                          'backlogQuota',
                                                          type,
                                                      )
                                                  }
                                              />
                                          ) : null}
                                      </React.Fragment>
                                  );
                              })}
                          </div>
                      </Card>
                  ))
                : null}

            {view && editing?.editor ? (
                <PolicyEditModal
                    row={editing}
                    view={view}
                    clusterId={clusterId}
                    tenant={tenant}
                    namespace={namespace}
                    clusterOptions={clusterOptions}
                    onClose={() => setEditing(null)}
                    onSaved={load}
                />
            ) : null}

            {syncOpen && view ? (
                <PolicySyncModal
                    clusterId={clusterId}
                    source={{tenant, namespace}}
                    onClose={() => setSyncOpen(false)}
                    onApplied={() => void load()}
                />
            ) : null}

            <Drawer
                open={rawOpen}
                onClose={() => setRawOpen(false)}
                width={640}
                title="原始 Policies"
                // 折叠表只列常用字段，其余（offload、inactive topic、persistence、
                // delayed delivery 等）只能在这里看全——否则界面会让人误以为"没有配"
                extra={<Typography.Text type="secondary">未折叠的字段都在这里</Typography.Text>}
            >
                <pre className="mono">{JSON.stringify(view?.raw ?? {}, null, 2)}</pre>
            </Drawer>
        </div>
    );
};

export default NamespacePolicyPanel;
