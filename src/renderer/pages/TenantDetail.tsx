import React, {useState, useEffect, useCallback, useRef} from 'react';
import {Button, type TableColumnsType} from 'antd';
import {FolderOutlined, DatabaseOutlined, TagOutlined, ArrowRightOutlined} from '@ant-design/icons';
import {useTabStore} from '../store/tabs';
import {loadNamespaces} from '../hooks/resourceCache';
import {namespaceTab} from '../utils/tabIds';
import ResourceDetailPage, {type ResourceStat} from '../components/common/ResourceDetailPage';

interface TenantDetailProps {
    clusterId: string;
    tenant: string;
}

interface NamespaceInfo {
    name: string;
}

const TenantDetail: React.FC<TenantDetailProps> = ({clusterId, tenant}) => {
    const {addTab} = useTabStore();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [namespaces, setNamespaces] = useState<NamespaceInfo[]>([]);
    const [tenantInfo, setTenantInfo] = useState<{
        adminRoles: string[];
        allowedClusters: string[];
    } | null>(null);

    // 参数切换时旧请求的晚到响应不能覆盖新数据，编号单调递增、绝不归零
    const requestIdRef = useRef(0);

    const fetchTenantInfo = useCallback(async () => {
        const currentRequestId = ++requestIdRef.current;
        setLoading(true);
        setError(null);
        try {
            const [namespaceNames, tenantResponse] = await Promise.all([
                loadNamespaces(clusterId, tenant),
                window.electronAPI.resources.getTenantInfo(clusterId, tenant),
            ]);
            if (currentRequestId !== requestIdRef.current) {
                return;
            }

            // 服务层已经把 "tenant/" 前缀去掉，但命名空间本身可以是分层的
            // ("a/b")：再取一次末段会让点击落到另一个命名空间上。
            setNamespaces(namespaceNames.map((ns: string) => ({name: ns})));

            if (tenantResponse.success && tenantResponse.data) {
                setTenantInfo(tenantResponse.data);
            } else {
                // 静默忽略的话页面会照常渲染 0 个角色/0 个集群，看起来像"租户就是这么空"
                setError(tenantResponse.error || '获取租户信息失败');
            }
        } catch (error) {
            if (currentRequestId !== requestIdRef.current) {
                return;
            }
            console.error('Failed to fetch tenant info:', error);
            setError(error instanceof Error ? error.message : String(error));
        } finally {
            if (currentRequestId === requestIdRef.current) {
                setLoading(false);
            }
        }
    }, [clusterId, tenant]);

    useEffect(() => {
        void fetchTenantInfo();
    }, [fetchTenantInfo]);

    const handleNamespaceClick = (namespace: string) => {
        addTab(namespaceTab(clusterId, tenant, namespace));
    };

    const namespaceColumns: TableColumnsType<NamespaceInfo> = [
        {
            title: '命名空间名称',
            dataIndex: 'name',
            key: 'name',
            render: (name: string) => (
                <Button type="link" onClick={() => handleNamespaceClick(name)}>
                    {name}
                    <ArrowRightOutlined style={{marginLeft: 'var(--spacing-xs)'}} />
                </Button>
            ),
        },
    ];

    const stats: ResourceStat[] = [
        {key: 'namespaces', title: '命名空间数量', value: namespaces.length, prefix: <FolderOutlined />},
        {
            key: 'roles',
            title: '管理角色数',
            value: tenantInfo?.adminRoles?.length || 0,
            prefix: <TagOutlined />,
        },
        {
            key: 'clusters',
            title: '允许的集群数',
            value: tenantInfo?.allowedClusters?.length || 0,
            prefix: <DatabaseOutlined />,
        },
    ];

    return (
        <ResourceDetailPage<NamespaceInfo>
            title={`租户 ${tenant}`}
            loading={loading}
            error={error}
            errorTitle="加载租户信息失败"
            onRetry={() => void fetchTenantInfo()}
            stats={stats}
            infoTitle="租户信息"
            infoRows={[
                {label: '租户名称', value: tenant},
                {label: '管理角色', tags: tenantInfo?.adminRoles ?? [], fallback: '无'},
                {label: '允许的集群', tags: tenantInfo?.allowedClusters ?? [], fallback: '无'},
            ]}
            listLabel="命名空间"
            listTitle={`命名空间列表 (${namespaces.length})`}
            listEmptyText="暂无命名空间"
            columns={namespaceColumns}
            dataSource={namespaces}
            rowKey="name"
        />
    );
};

export default TenantDetail;
