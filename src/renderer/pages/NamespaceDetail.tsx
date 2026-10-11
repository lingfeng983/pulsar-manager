import React, {useState, useEffect, useCallback, useRef} from 'react';
import {Card, Tabs, Row, Col, Statistic, Tag, Button, Table, Spin, Alert} from 'antd';
import {FileTextOutlined, DatabaseOutlined, TagOutlined, ArrowRightOutlined} from '@ant-design/icons';
import {useTabStore} from '../store/tabs';
import {loadTopics} from '../hooks/resourceCache';
import {shortName} from '../utils/format';
import {topicTab} from '../utils/tabIds';

interface NamespaceDetailProps {
    clusterId: string;
    tenant: string;
    namespace: string;
}

interface TopicInfo {
    name: string;
    persistent: boolean;
    partitions: string[];
}

const NamespaceDetail: React.FC<NamespaceDetailProps> = ({clusterId, tenant, namespace}) => {
    const {addTab} = useTabStore();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [topics, setTopics] = useState<TopicInfo[]>([]);
    const [namespaceInfo, setNamespaceInfo] = useState<{
        replicationClusters: string[];
        clusters: string[];
    } | null>(null);

    // 参数切换时旧请求的晚到响应不能覆盖新数据，编号单调递增、绝不归零
    const requestIdRef = useRef(0);

    const fetchNamespaceInfo = useCallback(async () => {
        const currentRequestId = ++requestIdRef.current;
        setLoading(true);
        setError(null);
        try {
            const [topicItems, nsResponse] = await Promise.all([
                loadTopics(clusterId, tenant, namespace),
                window.electronAPI.resources.getNamespaceInfo(clusterId, tenant, namespace),
            ]);
            if (currentRequestId !== requestIdRef.current) {
                return;
            }

            const topicList: TopicInfo[] = topicItems.map(t => ({
                name: shortName(t.name),
                persistent: t.persistent,
                partitions: t.partitions,
            }));
            setTopics(topicList);

            if (nsResponse.success && nsResponse.data) {
                setNamespaceInfo(nsResponse.data);
            }
        } catch (error) {
            if (currentRequestId !== requestIdRef.current) {
                return;
            }
            console.error('Failed to fetch namespace info:', error);
            setError('获取命名空间信息失败');
        } finally {
            if (currentRequestId === requestIdRef.current) {
                setLoading(false);
            }
        }
    }, [clusterId, tenant, namespace]);

    useEffect(() => {
        fetchNamespaceInfo();
    }, [fetchNamespaceInfo]);

    const handleTopicClick = (topic: string, persistent: boolean) => {
        addTab(topicTab({clusterId, tenant, namespace, topic, persistent}));
    };

    const topicColumns = [
        {
            title: 'Topic 名称',
            dataIndex: 'name',
            key: 'name',
            render: (name: string, record: TopicInfo) => (
                <Button type="link" onClick={() => handleTopicClick(name, record.persistent)}>
                    {name}
                    <ArrowRightOutlined style={{marginLeft: 4}} />
                </Button>
            ),
        },
        {
            title: '类型',
            dataIndex: 'persistent',
            key: 'persistent',
            render: (persistent: boolean) => (
                <Tag color={persistent ? 'blue' : 'green'}>{persistent ? '持久化' : '非持久化'}</Tag>
            ),
        },
        {
            title: '分区',
            dataIndex: 'partitions',
            key: 'partitions',
            render: (partitions: string[]) => (partitions.length > 0 ? `${partitions.length} 个分区` : '非分区'),
        },
    ];

    return (
        <div style={{padding: 'var(--spacing-lg)', height: '100%', overflow: 'auto'}}>
            {loading ? (
                <div style={{display: 'flex', justifyContent: 'center', alignItems: 'center', height: '200px'}}>
                    <Spin size="large" />
                </div>
            ) : error ? (
                <Alert message={error} type="error" showIcon />
            ) : (
                <Tabs
                    items={[
                        {
                            key: 'overview',
                            label: '概览',
                            children: (
                                <>
                                    <Row gutter={16}>
                                        <Col span={8}>
                                            <Card>
                                                <Statistic
                                                    title="Topic 数量"
                                                    value={topics.length}
                                                    prefix={<FileTextOutlined />}
                                                />
                                            </Card>
                                        </Col>
                                        <Col span={8}>
                                            <Card>
                                                <Statistic
                                                    title="复制集群数"
                                                    value={namespaceInfo?.replicationClusters?.length || 0}
                                                    prefix={<DatabaseOutlined />}
                                                />
                                            </Card>
                                        </Col>
                                        <Col span={8}>
                                            <Card>
                                                <Statistic
                                                    title="集群数"
                                                    value={namespaceInfo?.clusters?.length || 0}
                                                    prefix={<TagOutlined />}
                                                />
                                            </Card>
                                        </Col>
                                    </Row>

                                    <Card title="命名空间信息" style={{marginTop: 'var(--spacing-md)'}}>
                                        <div style={{padding: '20px'}}>
                                            <div style={{marginBottom: 'var(--spacing-md)'}}>
                                                <span style={{fontWeight: 500}}>命名空间:</span>
                                                <code style={{marginLeft: 8}}>{`${tenant}/${namespace}`}</code>
                                            </div>
                                            <div style={{marginBottom: 'var(--spacing-md)'}}>
                                                <span style={{fontWeight: 500}}>复制集群:</span>
                                                <div style={{marginLeft: 8, display: 'flex', flexWrap: 'wrap', gap: 8}}>
                                                    {namespaceInfo?.replicationClusters?.map(cluster => (
                                                        <Tag key={cluster}>{cluster}</Tag>
                                                    ))}
                                                    {(!namespaceInfo?.replicationClusters ||
                                                        namespaceInfo?.replicationClusters?.length === 0) && (
                                                        <span style={{color: 'var(--color-text-tertiary)'}}>
                                                            默认集群
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                            <div style={{marginBottom: 'var(--spacing-md)'}}>
                                                <span style={{fontWeight: 500}}>集群:</span>
                                                <div style={{marginLeft: 8, display: 'flex', flexWrap: 'wrap', gap: 8}}>
                                                    {namespaceInfo?.clusters?.map(cluster => (
                                                        <Tag key={cluster}>{cluster}</Tag>
                                                    ))}
                                                    {(!namespaceInfo?.clusters ||
                                                        namespaceInfo?.clusters?.length === 0) && (
                                                        <span style={{color: 'var(--color-text-tertiary)'}}>无</span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    </Card>
                                </>
                            ),
                        },
                        {
                            key: 'topics',
                            label: 'Topics',
                            children: (
                                <Card title={`Topic 列表 (${topics.length})`}>
                                    {topics.length > 0 ? (
                                        <Table
                                            dataSource={topics}
                                            columns={topicColumns}
                                            rowKey="name"
                                            pagination={false}
                                            size="small"
                                            scroll={{x: 'max-content'}}
                                        />
                                    ) : (
                                        <div
                                            style={{
                                                textAlign: 'center',
                                                padding: '40px 0',
                                                color: 'var(--color-text-secondary)',
                                            }}
                                        >
                                            暂无 Topic
                                        </div>
                                    )}
                                </Card>
                            ),
                        },
                    ]}
                />
            )}
        </div>
    );
};

export default NamespaceDetail;
