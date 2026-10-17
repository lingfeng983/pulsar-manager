import React, {useMemo, useState, useEffect, useCallback, useRef} from 'react';
import {Button, Input, Tag, type TableColumnsType} from 'antd';
import {FileTextOutlined, DatabaseOutlined, TagOutlined, ArrowRightOutlined, SearchOutlined} from '@ant-design/icons';
import {useTabStore} from '../store/tabs';
import {loadTopics} from '../hooks/resourceCache';
import {shortName} from '../utils/format';
import {matchesFilter} from '../utils/textFilter';
import {topicTab} from '../utils/tabIds';
import ResourceDetailPage, {type ResourceStat} from '../components/common/ResourceDetailPage';
import PermissionsPanel from '../components/common/PermissionsPanel';
import NamespacePolicyPanel from '../components/namespace/NamespacePolicyPanel';
import type {NamespacePolicyView} from '../types';

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
    const [topicFilter, setTopicFilter] = useState('');
    const [namespaceInfo, setNamespaceInfo] = useState<NamespacePolicyView | null>(null);

    // 参数切换时旧请求的晚到响应不能覆盖新数据，编号单调递增、绝不归零
    const requestIdRef = useRef(0);

    const fetchNamespaceInfo = useCallback(async () => {
        const currentRequestId = ++requestIdRef.current;
        setLoading(true);
        setError(null);
        try {
            const [topicItems, nsResponse] = await Promise.all([
                loadTopics(clusterId, tenant, namespace),
                window.electronAPI.namespacePolicy.get({clusterId, tenant, namespace}),
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

    // 筛选在渲染层做：topic 清单已经整份在手，为一个输入框再发一轮 IPC 不值当
    const filtering = topicFilter.trim().length > 0;
    const visibleTopics = useMemo(
        () => (filtering ? topics.filter(t => matchesFilter([t.name], topicFilter)) : topics),
        [topics, topicFilter, filtering],
    );

    const stats: ResourceStat[] = [
        {key: 'topics', title: 'Topic 数量', value: topics.length, prefix: <FileTextOutlined />},
        {
            key: 'replication',
            title: '复制集群数',
            value: namespaceInfo?.replicationClusters?.length || 0,
            prefix: <DatabaseOutlined />,
        },
        {
            key: 'clusters',
            title: '允许集群数',
            value: namespaceInfo?.allowedClusters?.length || 0,
            prefix: <TagOutlined />,
        },
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
                {label: '复制集群', tags: namespaceInfo?.replicationClusters ?? [], fallback: '不复制'},
                {label: '允许集群', tags: namespaceInfo?.allowedClusters ?? [], fallback: '无'},
            ]}
            listLabel="Topics"
            listTitle={
                filtering
                    ? `Topic 列表 (命中 ${visibleTopics.length} / 共 ${topics.length})`
                    : `Topic 列表 (${topics.length})`
            }
            listEmptyText={filtering ? '没有匹配的 topic' : '暂无 Topic'}
            listActions={
                <Input
                    size="small"
                    allowClear
                    style={{width: 180}}
                    prefix={<SearchOutlined />}
                    placeholder="筛选 topic"
                    aria-label="按名称模糊筛选 topic"
                    value={topicFilter}
                    onChange={event => setTopicFilter(event.target.value)}
                />
            }
            columns={topicColumns}
            dataSource={visibleTopics}
            rowKey={record => `${record.persistent ? 'persistent' : 'non-persistent'}://${record.name}`}
            extraTabs={[
                {
                    key: 'policies',
                    label: '策略',
                    // 概览只带复制集群这类头部信息；保留、配额、限速、上限这些
                    // 日常要调的项全在策略页签里，一页装不下也不该装
                    children: <NamespacePolicyPanel clusterId={clusterId} tenant={tenant} namespace={namespace} />,
                },
                {
                    key: 'permissions',
                    label: '权限',
                    children: (
                        <PermissionsPanel
                            scope="namespace"
                            clusterId={clusterId}
                            tenant={tenant}
                            namespace={namespace}
                        />
                    ),
                },
            ]}
        />
    );
};

export default NamespaceDetail;
