import React, {useState, useEffect, useCallback, useRef} from 'react';
import {Button, Tag, type TableColumnsType} from 'antd';
import {FileTextOutlined, DatabaseOutlined, TagOutlined, ArrowRightOutlined} from '@ant-design/icons';
import {useTabStore} from '../store/tabs';
import {loadTopics} from '../hooks/resourceCache';
import {shortName} from '../utils/format';
import {topicTab} from '../utils/tabIds';
import ResourceDetailPage, {type ResourceStat} from '../components/common/ResourceDetailPage';

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

            setTopics(
                topicItems.map(t => ({
                    name: shortName(t.name),
                    persistent: t.persistent,
                    partitions: t.partitions,
                })),
            );

            if (nsResponse.success && nsResponse.data) {
                setNamespaceInfo(nsResponse.data);
            } else {
                // 静默忽略会让页面照常显示 0 个集群，看不出是请求失败了
                setError(nsResponse.error || '获取命名空间信息失败');
            }
        } catch (error) {
            if (currentRequestId !== requestIdRef.current) {
                return;
            }
            console.error('Failed to fetch namespace info:', error);
            setError(error instanceof Error ? error.message : String(error));
        } finally {
            if (currentRequestId === requestIdRef.current) {
                setLoading(false);
            }
        }
    }, [clusterId, tenant, namespace]);

    useEffect(() => {
        void fetchNamespaceInfo();
    }, [fetchNamespaceInfo]);

    const handleTopicClick = (topic: string, persistent: boolean) => {
        addTab(topicTab({clusterId, tenant, namespace, topic, persistent}));
    };

    const topicColumns: TableColumnsType<TopicInfo> = [
        {
            title: 'Topic 名称',
            dataIndex: 'name',
            key: 'name',
            render: (name: string, record: TopicInfo) => (
                <Button type="link" onClick={() => handleTopicClick(name, record.persistent)}>
                    {name}
                    <ArrowRightOutlined style={{marginLeft: 'var(--spacing-xs)'}} />
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

    const stats: ResourceStat[] = [
        {key: 'topics', title: 'Topic 数量', value: topics.length, prefix: <FileTextOutlined />},
        {
            key: 'replication',
            title: '复制集群数',
            value: namespaceInfo?.replicationClusters?.length || 0,
            prefix: <DatabaseOutlined />,
        },
        {key: 'clusters', title: '集群数', value: namespaceInfo?.clusters?.length || 0, prefix: <TagOutlined />},
    ];

    return (
        <ResourceDetailPage<TopicInfo>
            title={`命名空间 ${tenant}/${namespace}`}
            loading={loading}
            error={error}
            errorTitle="加载命名空间信息失败"
            onRetry={() => void fetchNamespaceInfo()}
            stats={stats}
            infoTitle="命名空间信息"
            infoRows={[
                {label: '命名空间', value: `${tenant}/${namespace}`},
                {label: '复制集群', tags: namespaceInfo?.replicationClusters ?? [], fallback: '默认集群'},
                {label: '集群', tags: namespaceInfo?.clusters ?? [], fallback: '无'},
            ]}
            listLabel="Topics"
            listTitle={`Topic 列表 (${topics.length})`}
            listEmptyText="暂无 Topic"
            columns={topicColumns}
            dataSource={topics}
            rowKey="name"
        />
    );
};

export default NamespaceDetail;
