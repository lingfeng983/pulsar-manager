import {type ReactNode} from 'react';
import {Card, Col, Row, Statistic, Table, Tabs, Tag, type TableColumnsType, type TableProps} from 'antd';
import PageShell from './PageShell';
import StateBlock from './StateBlock';

export interface ResourceStat {
    key: string;
    title: ReactNode;
    value: number | string;
    prefix?: ReactNode;
}

export interface ResourceInfoRow {
    label: string;
    /** 标量值（名称、路径等），与 tags 二选一 */
    value?: ReactNode;
    tags?: string[];
    /** 无值时的占位文案（'无' / '默认集群' 各不相同，由页面决定语义） */
    fallback?: ReactNode;
}

interface ResourceDetailPageProps<T extends object> {
    title: ReactNode;
    subtitle?: ReactNode;
    actions?: ReactNode;
    loading: boolean;
    error: string | null;
    onRetry: () => void;
    errorTitle?: ReactNode;
    stats: ResourceStat[];
    infoTitle: ReactNode;
    infoRows: ResourceInfoRow[];
    overviewLabel?: ReactNode;
    listLabel: ReactNode;
    listTitle: ReactNode;
    listEmptyText: ReactNode;
    columns: TableColumnsType<T>;
    dataSource: T[];
    rowKey: TableProps<T>['rowKey'];
}

// 租户详情与命名空间详情同构：概览（统计卡 + 信息区）+ 下级资源列表。
// 抽到这里后两个页面只剩数据映射，不再各写一遍占位、表格与卡片。
function ResourceDetailPage<T extends object>({
    title,
    subtitle,
    actions,
    loading,
    error,
    onRetry,
    errorTitle,
    stats,
    infoTitle,
    infoRows,
    overviewLabel = '概览',
    listLabel,
    listTitle,
    listEmptyText,
    columns,
    dataSource,
    rowKey,
}: ResourceDetailPageProps<T>) {
    const overview = (
        <>
            <Row gutter={[12, 12]}>
                {stats.map(stat => (
                    <Col key={stat.key} span={8}>
                        <Card>
                            <Statistic title={stat.title} value={stat.value} prefix={stat.prefix} />
                        </Card>
                    </Col>
                ))}
            </Row>

            <Card title={infoTitle}>
                <div style={{display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)'}}>
                    {infoRows.map(row => (
                        <div key={row.label}>
                            <span className="field-label">{row.label}:</span>
                            {row.tags ? (
                                <span className="field-tags">
                                    {row.tags.length > 0 ? (
                                        row.tags.map(tag => <Tag key={tag}>{tag}</Tag>)
                                    ) : (
                                        <span className="text-tertiary">{row.fallback}</span>
                                    )}
                                </span>
                            ) : (
                                <code style={{marginLeft: 'var(--spacing-sm)'}}>{row.value}</code>
                            )}
                        </div>
                    ))}
                </div>
            </Card>
        </>
    );

    const list = (
        <Card title={listTitle}>
            <StateBlock empty={dataSource.length === 0} emptyText={listEmptyText}>
                <Table<T>
                    dataSource={dataSource}
                    columns={columns}
                    rowKey={rowKey}
                    pagination={false}
                    size="small"
                    scroll={{x: 'max-content'}}
                />
            </StateBlock>
        </Card>
    );

    return (
        <PageShell title={title} subtitle={subtitle} actions={actions}>
            <StateBlock loading={loading} error={error} errorTitle={errorTitle} onRetry={onRetry}>
                <Tabs
                    items={[
                        {key: 'overview', label: overviewLabel, children: overview},
                        {key: 'list', label: listLabel, children: list},
                    ]}
                />
            </StateBlock>
        </PageShell>
    );
}

export default ResourceDetailPage;
