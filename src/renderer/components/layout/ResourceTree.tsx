import React, {useState, useEffect, useCallback, useMemo} from 'react';
import {Tree, Button, Space, Spin, message, Menu, Modal, Input} from 'antd';
import type {DataNode} from 'antd/es/tree';
import {
    ClusterOutlined,
    FolderOutlined,
    DatabaseOutlined,
    TableOutlined,
    ReloadOutlined,
    MenuFoldOutlined,
    BarChartOutlined,
    ApartmentOutlined,
    EyeOutlined,
    DeleteOutlined,
    PlusOutlined,
    EditOutlined,
} from '@ant-design/icons';
import {useClusterStore} from '../../store/cluster';
import {useTabStore} from '../../store/tabs';
import {
    loadTenants,
    loadNamespaces,
    loadTopics,
    invalidateResourceCache,
    invalidateTenants,
    invalidateNamespaces,
    invalidateTopics,
    invalidateTopicStats,
} from '../../hooks/resourceCache';
import {shortName} from '../../utils/format';
import {useCommand} from '../../hooks/useKeybindings';
import TenantFormModal from '../tenant/TenantFormModal';
import TopicFormModal from '../topic/TopicFormModal';
import type {Tenant, Topic} from '../../types';

interface ResourceTreeNode extends DataNode {
    dataRef?: {
        type: 'cluster' | 'tenant' | 'namespace' | 'topic';
        clusterId?: string;
        tenant?: string;
        namespace?: string;
        topic?: string;
        persistent?: boolean;
        cluster?: any;
    };
}

const ResourceTree: React.FC = () => {
    const [collapsed, setCollapsed] = useState(false);
    const [loading, setLoading] = useState(false);
    const [treeData, setTreeData] = useState<DataNode[]>([]);
    const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
    const [contextMenu, setContextMenu] = useState<{x: number; y: number; node: ResourceTreeNode | null} | null>(null);
    const {clusters, fetchClusters, setActiveCluster, deleteClusterAsync, expandedClusterId} = useClusterStore();
    const {addTab} = useTabStore();
    const [tenantForm, setTenantForm] = useState<{
        open: boolean;
        mode: 'create' | 'edit';
        clusterId: string;
        tenant?: string;
        initial?: {adminRoles: string[]; allowedClusters: string[]};
    }>({open: false, mode: 'create', clusterId: ''});
    const [topicForm, setTopicForm] = useState<{
        open: boolean;
        clusterId: string;
        tenant: string;
        namespace: string;
    }>({open: false, clusterId: '', tenant: '', namespace: ''});

    // 将集群转换为树节点
    const clusterToTreeData = useMemo(() => {
        return clusters.map(cluster => ({
            title: (
                <Space>
                    <ClusterOutlined style={{color: 'var(--color-primary)'}} />
                    <span>{cluster.name}</span>
                    <span
                        style={{
                            fontSize: 10,
                            padding: '0 4px',
                            borderRadius: 4,
                            backgroundColor:
                                cluster.status === 'connected'
                                    ? 'var(--color-success)'
                                    : cluster.status === 'warning'
                                      ? 'var(--color-warning)'
                                      : 'var(--color-text-secondary)',
                            color: '#fff',
                        }}
                    >
                        {cluster.status === 'connected' ? '在线' : cluster.status === 'warning' ? '警告' : '离线'}
                    </span>
                </Space>
            ),
            key: `cluster-${cluster.id}`,
            dataRef: {type: 'cluster' as const, clusterId: cluster.id, cluster},
            children: [],
            isLeaf: false,
        }));
    }, [clusters]);

    // 加载指定节点的子节点（带缓存）
    const loadTreeNodeData = useCallback(async (node: ResourceTreeNode): Promise<DataNode[]> => {
        const dataRef = node.dataRef;
        if (!dataRef) return [];

        const {type, clusterId, tenant, namespace} = dataRef;

        try {
            if (type === 'cluster' && clusterId) {
                const tenants = await loadTenants(clusterId);
                return tenants.map((t: Tenant) => ({
                    title: (
                        <Space>
                            <FolderOutlined />
                            <span>{t.name}</span>
                        </Space>
                    ),
                    key: `tenant-${clusterId}-${t.name}`,
                    dataRef: {type: 'tenant' as const, clusterId, tenant: t.name},
                    children: [],
                    isLeaf: false,
                }));
            } else if (type === 'tenant' && clusterId && tenant) {
                const namespaces = await loadNamespaces(clusterId, tenant);
                return namespaces.map((ns: string) => ({
                    title: (
                        <Space>
                            <DatabaseOutlined />
                            <span>{ns}</span>
                        </Space>
                    ),
                    key: `ns-${clusterId}-${tenant}-${ns}`,
                    dataRef: {type: 'namespace' as const, clusterId, tenant, namespace: ns},
                    children: [],
                    isLeaf: false,
                }));
            } else if (type === 'namespace' && clusterId && tenant && namespace) {
                const topics = await loadTopics(clusterId, tenant, namespace);
                return topics.map((topic: Topic) => {
                    const topicName = shortName(topic.name);
                    return {
                        title: (
                            <Space>
                                <TableOutlined />
                                <span style={{fontSize: 12}}>{topicName}</span>
                            </Space>
                        ),
                        key: `topic-${clusterId}-${tenant}-${namespace}-${topicName}`,
                        dataRef: {
                            type: 'topic' as const,
                            clusterId,
                            tenant,
                            namespace,
                            topic: topicName,
                            persistent: topic.persistent,
                        },
                        isLeaf: true,
                    };
                });
            }
        } catch (error) {
            console.error('Failed to load tree node data:', error);
            message.error('加载资源失败');
        }

        return [];
    }, []);

    // 变更后重新读取某个节点的子节点。handleLoadData 会跳过"已有子节点"的节点，
    // 所以增删改之后必须走这个强制重载，否则树会一直显示旧列表。
    const reloadNodeChildren = useCallback(
        async (node: ResourceTreeNode) => {
            if (!node.dataRef) return;
            const children = await loadTreeNodeData(node);
            setTreeData(prev => {
                const update = (nodes: DataNode[]): DataNode[] =>
                    nodes.map(n => {
                        if (n.key === node.key) {
                            return {...n, children};
                        }
                        if (n.children) {
                            return {...n, children: update(n.children)};
                        }
                        return n;
                    });
                return update(prev);
            });
        },
        [loadTreeNodeData],
    );

    // 增删改之后要重载的是"父节点"，这里按 key 约定合成父节点，
    // 不必先在 treeData 里把它找出来。
    const clusterNode = (clusterId: string): ResourceTreeNode => ({
        key: `cluster-${clusterId}`,
        dataRef: {type: 'cluster', clusterId},
    });

    const tenantNode = (clusterId: string, tenant: string): ResourceTreeNode => ({
        key: `tenant-${clusterId}-${tenant}`,
        dataRef: {type: 'tenant', clusterId, tenant},
    });

    const namespaceNode = (clusterId: string, tenant: string, namespace: string): ResourceTreeNode => ({
        key: `ns-${clusterId}-${tenant}-${namespace}`,
        dataRef: {type: 'namespace', clusterId, tenant, namespace},
    });

    // 初始加载
    useEffect(() => {
        setTreeData(clusterToTreeData);
    }, [clusterToTreeData]);

    // 响应集群展开事件
    useEffect(() => {
        if (expandedClusterId) {
            const clusterKey = `cluster-${expandedClusterId}`;
            setExpandedKeys(prev => {
                if (!prev.includes(clusterKey)) {
                    return [...prev, clusterKey];
                }
                return prev;
            });
        }
    }, [expandedClusterId]);

    // 处理树节点展开
    const handleExpand = useCallback((expandedKeysValue: React.Key[]) => {
        setExpandedKeys(expandedKeysValue);
    }, []);

    // 处理树节点加载数据
    const handleLoadData = useCallback(
        async (node: ResourceTreeNode) => {
            // 检查是否已有子节点
            if ((node?.children?.length ?? 0) > 0) return;

            const children = await loadTreeNodeData(node);
            setTreeData(prev => {
                const updateNode = (nodes: DataNode[]): DataNode[] => {
                    return nodes.map(n => {
                        if (n.key === node.key) {
                            return {...n, children};
                        }
                        if (n.children) {
                            return {...n, children: updateNode(n.children)};
                        }
                        return n;
                    });
                };
                return updateNode(prev);
            });
        },
        [loadTreeNodeData],
    );

    // 处理节点选择
    const handleSelect = useCallback(
        (keys: React.Key[], info: any) => {
            if (keys.length === 0) return;

            const selectedNode = info.node as ResourceTreeNode;
            const dataRef = selectedNode.dataRef;

            if (dataRef?.type === 'cluster') {
                setActiveCluster(dataRef.clusterId ?? null);
            } else if (dataRef?.type === 'topic') {
                const clusterId = dataRef.clusterId ?? '';
                const tenant = dataRef.tenant ?? '';
                const namespace = dataRef.namespace ?? '';
                const topic = dataRef.topic ?? '';
                const persistent = dataRef.persistent;
                addTab({
                    id: `topic-${clusterId}-${tenant}-${namespace}-${topic}`,
                    title: topic,
                    type: 'topic',
                    data: {clusterId, tenant, namespace, topic, persistent},
                });
            } else if (dataRef?.type === 'tenant') {
                addTab({
                    id: `tenant-${dataRef.clusterId}-${dataRef.tenant}`,
                    title: `${dataRef.tenant}`,
                    type: 'tenant',
                    data: dataRef,
                });
            } else if (dataRef?.type === 'namespace') {
                addTab({
                    id: `ns-${dataRef.clusterId}-${dataRef.tenant}-${dataRef.namespace}`,
                    title: `${dataRef.namespace}`,
                    type: 'namespace',
                    data: dataRef,
                });
            }
        },
        [setActiveCluster, addTab],
    );

    // 右键菜单处理
    const handleContextMenu = useCallback((e: React.MouseEvent, node: DataNode) => {
        e.preventDefault();
        const menuWidth = 180; // approximate menu width
        const menuHeight = 200; // approximate menu height

        let x = e.clientX;
        let y = e.clientY;

        // Adjust if menu would overflow viewport
        if (x + menuWidth > window.innerWidth) {
            x = window.innerWidth - menuWidth - 8;
        }
        if (y + menuHeight > window.innerHeight) {
            y = window.innerHeight - menuHeight - 8;
        }

        setContextMenu({x, y, node: node as ResourceTreeNode});
    }, []);

    // 关闭右键菜单
    const closeContextMenu = useCallback(() => {
        setContextMenu(null);
    }, []);

    // 点击外部关闭右键菜单
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (contextMenu && !(event.target as Element).closest('.ant-menu')) {
                closeContextMenu();
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [contextMenu, closeContextMenu]);

    // 右键菜单操作
    // 命名空间只需要一个名字，用轻量确认框即可，不必再做一个表单组件。
    const promptCreateNamespace = useCallback(
        (clusterId: string, tenant: string) => {
            let draft = '';
            Modal.confirm({
                title: `新建命名空间（${tenant}）`,
                icon: null,
                content: (
                    <Input
                        autoFocus
                        placeholder="命名空间名"
                        onChange={e => {
                            draft = e.target.value;
                        }}
                    />
                ),
                okText: '创建',
                cancelText: '取消',
                onOk: async () => {
                    const name = draft.trim();
                    if (!name) {
                        message.warning('请输入命名空间名');
                        return Promise.reject(new Error('name required'));
                    }
                    const response = await window.electronAPI.resources.createNamespace(clusterId, tenant, name);
                    if (!response.success) {
                        message.error(response.error || '创建失败');
                        return Promise.reject(new Error('create failed'));
                    }
                    message.success('命名空间已创建');
                    invalidateNamespaces(clusterId, tenant);
                    const parentKey = `tenant-${clusterId}-${tenant}`;
                    setExpandedKeys(prev => (prev.includes(parentKey) ? prev : [...prev, parentKey]));
                    await reloadNodeChildren(tenantNode(clusterId, tenant));
                },
            });
        },
        [reloadNodeChildren],
    );

    const handleContextMenuAction = useCallback(
        async (action: string, node: ResourceTreeNode) => {
            const dataRef = node.dataRef;

            switch (action) {
                case 'view':
                    if (dataRef?.type === 'topic') {
                        const clusterId = dataRef.clusterId ?? '';
                        const tenant = dataRef.tenant ?? '';
                        const namespace = dataRef.namespace ?? '';
                        const topic = dataRef.topic ?? '';
                        const persistent = dataRef.persistent;
                        addTab({
                            id: `topic-${clusterId}-${tenant}-${namespace}-${topic}`,
                            title: topic,
                            type: 'topic',
                            data: {clusterId, tenant, namespace, topic, persistent},
                        });
                    } else if (dataRef?.type === 'cluster') {
                        setActiveCluster(dataRef.clusterId ?? '');
                    }
                    break;
                case 'topology':
                    if (dataRef?.type === 'cluster') {
                        addTab({
                            id: `topology-${dataRef.clusterId}`,
                            title: `${dataRef.cluster?.name || '集群'}拓扑`,
                            type: 'topology',
                            data: {clusterId: dataRef.clusterId},
                        });
                    }
                    break;
                case 'metrics':
                    if (dataRef?.type === 'cluster') {
                        addTab({
                            id: `metrics-${dataRef.clusterId}`,
                            title: `${dataRef.cluster?.name || '集群'}监控`,
                            type: 'metrics',
                            data: {clusterId: dataRef.clusterId},
                        });
                    } else if (dataRef?.type === 'topic') {
                        const clusterId = dataRef.clusterId ?? '';
                        const tenant = dataRef.tenant ?? '';
                        const namespace = dataRef.namespace ?? '';
                        const topic = dataRef.topic ?? '';
                        const persistent = dataRef.persistent;
                        addTab({
                            id: `topic-${clusterId}-${tenant}-${namespace}-${topic}`,
                            title: `${topic}`,
                            type: 'topic',
                            data: {clusterId, tenant, namespace, topic, persistent},
                        });
                    }
                    break;
                case 'delete':
                    if (dataRef?.type === 'cluster') {
                        const clusterName = dataRef.cluster?.name || dataRef.clusterId;
                        Modal.confirm({
                            title: '确认删除',
                            content: `确定要删除集群 "${clusterName}" 吗？`,
                            okText: '删除',
                            okType: 'danger',
                            cancelText: '取消',
                            onOk: async () => {
                                if (dataRef.clusterId && (await deleteClusterAsync(dataRef.clusterId))) {
                                    message.success('删除成功');
                                }
                            },
                        });
                    } else if (dataRef?.type === 'tenant' && dataRef.clusterId && dataRef.tenant) {
                        const {clusterId, tenant} = dataRef;
                        Modal.confirm({
                            title: '确认删除租户',
                            content: `删除租户 "${tenant}"。broker 会拒绝删除仍包含命名空间的租户。`,
                            okText: '删除',
                            okType: 'danger',
                            cancelText: '取消',
                            onOk: async () => {
                                const response = await window.electronAPI.resources.deleteTenant(clusterId, tenant);
                                if (!response.success) {
                                    message.error(response.error || '删除失败');
                                    return;
                                }
                                message.success('租户已删除');
                                invalidateTenants(clusterId);
                                await reloadNodeChildren(clusterNode(clusterId));
                            },
                        });
                    } else if (
                        dataRef?.type === 'namespace' &&
                        dataRef.clusterId &&
                        dataRef.tenant &&
                        dataRef.namespace
                    ) {
                        const {clusterId, tenant, namespace} = dataRef;
                        Modal.confirm({
                            title: '确认删除命名空间',
                            content: `删除 "${tenant}/${namespace}" 会同时删除其中所有 Topic，且不可恢复。`,
                            okText: '删除',
                            okType: 'danger',
                            cancelText: '取消',
                            onOk: async () => {
                                const response = await window.electronAPI.resources.deleteNamespace(
                                    clusterId,
                                    tenant,
                                    namespace,
                                );
                                if (!response.success) {
                                    message.error(response.error || '删除失败');
                                    return;
                                }
                                message.success('命名空间已删除');
                                invalidateNamespaces(clusterId, tenant);
                                invalidateTopics(clusterId, tenant, namespace);
                                await reloadNodeChildren(tenantNode(clusterId, tenant));
                            },
                        });
                    } else if (dataRef?.type === 'topic' && dataRef.clusterId && dataRef.tenant && dataRef.namespace) {
                        const {clusterId, tenant, namespace, topic, persistent} = dataRef;
                        Modal.confirm({
                            title: '确认删除 Topic',
                            content: `删除 "${tenant}/${namespace}/${topic}" 会丢弃其全部消息与订阅游标，不可恢复。`,
                            okText: '删除',
                            okType: 'danger',
                            cancelText: '取消',
                            onOk: async () => {
                                const response = await window.electronAPI.resources.deleteTopic(
                                    clusterId,
                                    tenant,
                                    namespace,
                                    topic ?? '',
                                    persistent,
                                );
                                if (!response.success) {
                                    message.error(response.error || '删除失败');
                                    return;
                                }
                                message.success('Topic 已删除');
                                invalidateTopics(clusterId, tenant, namespace);
                                invalidateTopicStats(clusterId, tenant, namespace, topic ?? '');
                                await reloadNodeChildren(namespaceNode(clusterId, tenant, namespace));
                            },
                        });
                    }
                    break;
                case 'createTenant':
                    if (dataRef?.clusterId) {
                        setTenantForm({open: true, mode: 'create', clusterId: dataRef.clusterId});
                    }
                    break;
                case 'editTenant':
                    if (dataRef?.clusterId && dataRef.tenant) {
                        const {clusterId, tenant} = dataRef;
                        const response = await window.electronAPI.resources.getTenantInfo(clusterId, tenant);
                        if (!response.success || !response.data) {
                            message.error(response.error || '读取租户信息失败');
                            return;
                        }
                        setTenantForm({
                            open: true,
                            mode: 'edit',
                            clusterId,
                            tenant,
                            initial: {
                                adminRoles: response.data.adminRoles ?? [],
                                allowedClusters: response.data.allowedClusters ?? [],
                            },
                        });
                    }
                    break;
                case 'createNamespace':
                    if (dataRef?.clusterId && dataRef.tenant) {
                        promptCreateNamespace(dataRef.clusterId, dataRef.tenant);
                    }
                    break;
                case 'createTopic':
                    if (dataRef?.clusterId && dataRef.tenant && dataRef.namespace) {
                        setTopicForm({
                            open: true,
                            clusterId: dataRef.clusterId,
                            tenant: dataRef.tenant,
                            namespace: dataRef.namespace,
                        });
                    }
                    break;
            }
            closeContextMenu();
        },
        [addTab, setActiveCluster, deleteClusterAsync, closeContextMenu, reloadNodeChildren, promptCreateNamespace],
    );

    // 构建右键菜单
    const contextMenuItems = useMemo(() => {
        if (!contextMenu?.node) return [];

        const dataRef = (contextMenu.node as ResourceTreeNode).dataRef;

        const baseItems = [{key: 'view', label: '查看详情', icon: <EyeOutlined />}];

        if (dataRef?.type === 'cluster') {
            return [
                ...baseItems,
                {key: 'topology', label: '查看拓扑', icon: <ApartmentOutlined />},
                {key: 'metrics', label: '查看监控', icon: <BarChartOutlined />},
                {type: 'divider' as const},
                {key: 'createTenant', label: '新建租户', icon: <PlusOutlined />},
                {type: 'divider' as const},
                {key: 'delete', label: '删除集群', icon: <DeleteOutlined />, danger: true},
            ];
        }

        if (dataRef?.type === 'tenant') {
            return [
                ...baseItems,
                {key: 'createNamespace', label: '新建命名空间', icon: <PlusOutlined />},
                {key: 'editTenant', label: '编辑租户', icon: <EditOutlined />},
                {type: 'divider' as const},
                {key: 'delete', label: '删除租户', icon: <DeleteOutlined />, danger: true},
            ];
        }

        if (dataRef?.type === 'namespace') {
            return [
                ...baseItems,
                {key: 'createTopic', label: '新建 Topic', icon: <PlusOutlined />},
                {type: 'divider' as const},
                {key: 'delete', label: '删除命名空间', icon: <DeleteOutlined />, danger: true},
            ];
        }

        if (dataRef?.type === 'topic') {
            return [
                ...baseItems,
                {key: 'metrics', label: '查看监控', icon: <BarChartOutlined />},
                {type: 'divider' as const},
                {key: 'delete', label: '删除 Topic', icon: <DeleteOutlined />, danger: true},
            ];
        }

        return baseItems;
    }, [contextMenu]);

    // 刷新整个树（重置状态）
    const handleRefresh = useCallback(async () => {
        setLoading(true);
        // 强制刷新时清空资源缓存，确保拉取到最新的租户/命名空间/Topic
        invalidateResourceCache();
        const previousExpanded = [...expandedKeys];
        // Don't collapse - just refresh data
        try {
            await fetchClusters();
            // Keep previous expansion state, filtering out keys for removed clusters
            setExpandedKeys(prev =>
                prev.filter(key => {
                    if (typeof key === 'string' && key.startsWith('cluster-')) {
                        const clusterId = key.replace('cluster-', '');
                        return clusters.some(c => c.id === clusterId);
                    }
                    return true;
                }),
            );
            message.success('刷新成功');
        } catch (error) {
            console.error('Failed to refresh clusters:', error);
            setExpandedKeys(previousExpanded);
            message.error('刷新失败');
        } finally {
            setLoading(false);
        }
    }, [fetchClusters, expandedKeys, clusters]);

    useCommand('refreshResources', () => {
        void handleRefresh();
    });

    // 打开监控仪表盘
    const handleOpenMetrics = useCallback(() => {
        addTab({
            id: 'metrics',
            title: '监控仪表盘',
            type: 'metrics',
        });
    }, [addTab]);

    // 打开拓扑可视化
    const handleOpenTopology = useCallback(() => {
        addTab({
            id: 'topology',
            title: '集群拓扑',
            type: 'topology',
        });
    }, [addTab]);

    // 空状态
    const renderEmpty = () => (
        <div
            style={{
                padding: '40px 16px',
                textAlign: 'center',
                color: 'var(--color-text-secondary)',
            }}
        >
            <ClusterOutlined style={{fontSize: 32, marginBottom: 8}} />
            <p style={{margin: 0}}>暂无集群</p>
            <p style={{margin: '8px 0 0', fontSize: 12}}>请在首页添加集群</p>
        </div>
    );

    return (
        <div
            style={{
                width: collapsed ? '48px' : 'var(--sidebar-width)',
                backgroundColor: 'var(--color-bg-secondary)',
                borderRight: '1px solid var(--color-border)',
                display: 'flex',
                flexDirection: 'column',
                transition: 'width 0.2s ease',
                overflow: 'hidden',
            }}
        >
            {/* 工具栏 */}
            {!collapsed && (
                <div
                    style={{
                        padding: 'var(--spacing-sm)',
                        borderBottom: '1px solid var(--color-border)',
                    }}
                >
                    <Space direction="vertical" size="small" style={{width: '100%'}}>
                        <Space wrap>
                            <Button
                                size="small"
                                icon={<BarChartOutlined />}
                                onClick={handleOpenMetrics}
                                title="监控仪表盘"
                            >
                                监控
                            </Button>
                            <Button
                                size="small"
                                icon={<ApartmentOutlined />}
                                onClick={handleOpenTopology}
                                title="集群拓扑"
                            >
                                拓扑
                            </Button>
                        </Space>
                        <Space wrap>
                            <Button
                                size="small"
                                icon={<ReloadOutlined spin={loading} />}
                                onClick={handleRefresh}
                                title="刷新"
                            >
                                刷新
                            </Button>
                            <Button
                                size="small"
                                icon={<MenuFoldOutlined />}
                                onClick={() => setCollapsed(true)}
                                title="折叠"
                            >
                                折叠
                            </Button>
                        </Space>
                    </Space>
                </div>
            )}

            {/* 展开/折叠按钮 */}
            {collapsed && (
                <Button
                    size="small"
                    icon={<MenuFoldOutlined rotate={180} />}
                    onClick={() => setCollapsed(false)}
                    style={{margin: 'var(--spacing-sm)'}}
                    title="展开"
                />
            )}

            {/* 资源树 */}
            {!collapsed && (
                <div style={{flex: 1, overflow: 'auto', padding: 'var(--spacing-sm)'}}>
                    <Spin spinning={loading}>
                        {treeData.length === 0 ? (
                            renderEmpty()
                        ) : (
                            <Tree
                                treeData={treeData}
                                loadData={handleLoadData}
                                expandedKeys={expandedKeys}
                                onExpand={handleExpand}
                                defaultExpandAll={false}
                                showLine
                                showIcon
                                blockNode
                                onSelect={handleSelect}
                                onRightClick={(info: {event: React.MouseEvent; node: DataNode}) =>
                                    handleContextMenu(info.event, info.node)
                                }
                            />
                        )}
                    </Spin>
                </div>
            )}

            {/* 右键菜单 */}
            {contextMenu && (
                <Menu
                    items={contextMenuItems}
                    style={{
                        position: 'fixed',
                        top: contextMenu.y,
                        left: contextMenu.x,
                        zIndex: 1000,
                        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                        borderRadius: 4,
                        border: '1px solid var(--color-border)',
                    }}
                    onClick={e => {
                        if (contextMenu.node) {
                            handleContextMenuAction(e.key, contextMenu.node);
                        }
                    }}
                />
            )}
            {/* 资源增删改表单 */}
            <TenantFormModal
                open={tenantForm.open}
                mode={tenantForm.mode}
                clusterId={tenantForm.clusterId}
                tenant={tenantForm.tenant}
                initial={tenantForm.initial}
                onClose={() => setTenantForm(prev => ({...prev, open: false}))}
                onSaved={async tenantName => {
                    const {clusterId, mode} = tenantForm;
                    invalidateTenants(clusterId);
                    if (mode === 'create') {
                        const parentKey = `cluster-${clusterId}`;
                        setExpandedKeys(prev => (prev.includes(parentKey) ? prev : [...prev, parentKey]));
                        await reloadNodeChildren(clusterNode(clusterId));
                    } else {
                        invalidateNamespaces(clusterId, tenantName);
                        await reloadNodeChildren(tenantNode(clusterId, tenantName));
                    }
                }}
            />
            <TopicFormModal
                open={topicForm.open}
                clusterId={topicForm.clusterId}
                tenant={topicForm.tenant}
                namespace={topicForm.namespace}
                onClose={() => setTopicForm(prev => ({...prev, open: false}))}
                onSaved={async () => {
                    const {clusterId, tenant, namespace} = topicForm;
                    invalidateTopics(clusterId, tenant, namespace);
                    const parentKey = `ns-${clusterId}-${tenant}-${namespace}`;
                    setExpandedKeys(prev => (prev.includes(parentKey) ? prev : [...prev, parentKey]));
                    await reloadNodeChildren(namespaceNode(clusterId, tenant, namespace));
                }}
            />
        </div>
    );
};

export default ResourceTree;
