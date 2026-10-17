import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Alert, Button, Card, Drawer, Space, Tag, Typography, message} from 'antd';
import {DeleteOutlined, EditOutlined, ReloadOutlined} from '@ant-design/icons';
import StateBlock from '../common/StateBlock';
import {useConfirmDanger} from '../common/dangerConfirm';
import IconButton from '../common/IconButton';
import {NOT_SET, TOPIC_POLICY_GROUPS, TopicPolicyRow} from './topicPolicyMeta';
import TopicPolicyEditModal from './TopicPolicyEditModal';
import type {TopicPolicyView} from '../../types';

interface TopicPolicyPanelProps {
    clusterId: string;
    tenant: string;
    namespace: string;
    topic: string;
    persistent: boolean;
    active?: boolean;
}

// Topic 级策略面板：值全部来自 broker 的 TopicPolicies 端点，不留本地副本，
// 所以每次改完都要重读——否则显示的是刚才填的数，而不是 broker 真正接受的数。
const TopicPolicyPanel: React.FC<TopicPolicyPanelProps> = ({
    clusterId,
    tenant,
    namespace,
    topic,
    persistent,
    active = true,
}) => {
    const [view, setView] = useState<TopicPolicyView | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<TopicPolicyRow | null>(null);
    const [rawOpen, setRawOpen] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const loadedRef = useRef(false);
    const requestIdRef = useRef(0);
    const confirmDanger = useConfirmDanger();

    const load = useCallback(async () => {
        const currentRequestId = ++requestIdRef.current;
        setLoading(true);
        setError(null);
        try {
            const response = await window.electronAPI.topicPolicy.get({
                clusterId,
                tenant,
                namespace,
                topic,
                persistent,
            });
            if (currentRequestId !== requestIdRef.current) {
                return;
            }
            if (response.success && response.data) {
                setView(response.data);
                loadedRef.current = true;
            } else {
                setError(response.error || '获取 topic 级策略失败');
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
    }, [clusterId, tenant, namespace, topic, persistent]);

    useEffect(() => {
        if (active && !loadedRef.current) {
            void load();
        }
    }, [active, load]);

    const unavailable = useMemo(
        () => new Map(view ? view.unavailable.map(item => [item.field, item.reason] as const) : []),
        [view],
    );

    const clearField = async (row: TopicPolicyRow) => {
        setBusy(row.field);
        try {
            const response = await window.electronAPI.topicPolicy.clear({
                clusterId,
                tenant,
                namespace,
                topic,
                persistent,
                field: row.field,
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

    // 清除是撤销 topic 级覆盖、退回命名空间的值，不是"关掉这一项"：
    // 命名空间那边可能正好是相反的设置，所以每一笔都要确认。
    const askClear = (row: TopicPolicyRow) => {
        confirmDanger({
            title: `清除${row.label}？`,
            description:
                '清除后这一项退回命名空间/broker 的值，不是「关闭」。命名空间上如果配了别的值，界面会立刻变成那个值。',
            okText: '清除',
            onOk: async () => {
                await clearField(row);
            },
        });
    };

    return (
        <div className="stack">
            <Card
                size="small"
                title={`Topic 级策略 (${tenant}/${namespace}/${topic})`}
                extra={
                    <Space size={4}>
                        <Button size="small" onClick={() => setRawOpen(true)} disabled={!view}>
                            端点原始返回
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
                    errorTitle="获取 topic 级策略失败"
                    onRetry={load}
                    empty={!view}
                    emptyText="没有读到策略"
                >
                    <Typography.Text type="secondary">
                        这里列的是 topic 级覆盖；显示「{NOT_SET}」的项沿用命名空间或 broker 默认，改它会新建 topic
                        级覆盖。命名空间级的整份策略在命名空间详情页改。
                    </Typography.Text>
                </StateBlock>
            </Card>

            {view && unavailable.size > 0 ? (
                <Alert
                    type="warning"
                    showIcon
                    message={`${unavailable.size} 项在本 broker 上读不到`}
                    description={[...unavailable.values()].join('；')}
                />
            ) : null}

            {view
                ? TOPIC_POLICY_GROUPS.map(group => (
                      <Card key={group.title} size="small" title={group.title}>
                          <div className="stack">
                              {group.rows.map(row => {
                                  const reason = unavailable.get(row.field);
                                  if (reason) {
                                      return (
                                          <div className="policy-row" key={row.key}>
                                              <span className="policy-row-label">{row.label}</span>
                                              <span className="policy-row-value">{reason}</span>
                                              <span className="policy-row-actions">
                                                  <Tag>不可写</Tag>
                                              </span>
                                          </div>
                                      );
                                  }
                                  return (
                                      <div className="policy-row" key={row.key}>
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
                                              <IconButton
                                                  size="small"
                                                  danger
                                                  icon={<DeleteOutlined />}
                                                  label={`清除${row.label}`}
                                                  loading={busy === row.field}
                                                  onClick={() => askClear(row)}
                                              />
                                          </span>
                                      </div>
                                  );
                              })}
                          </div>
                      </Card>
                  ))
                : null}

            {view && editing ? (
                <TopicPolicyEditModal
                    row={editing}
                    view={view}
                    clusterId={clusterId}
                    tenant={tenant}
                    namespace={namespace}
                    topic={topic}
                    persistent={persistent}
                    onClose={() => setEditing(null)}
                    onSaved={load}
                />
            ) : null}

            <Drawer
                open={rawOpen}
                onClose={() => setRawOpen(false)}
                width={640}
                title="逐端点原始返回"
                extra={<Typography.Text type="secondary">五个 topic 级端点各自回来的值</Typography.Text>}
            >
                <pre className="mono">{JSON.stringify(view?.raw ?? {}, null, 2)}</pre>
            </Drawer>
        </div>
    );
};

export default TopicPolicyPanel;
