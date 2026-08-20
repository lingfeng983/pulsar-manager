import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Tree, Button, Space, Spin, message, Menu, Modal } from 'antd'
import type { DataNode } from 'antd/es/tree'
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
} from '@ant-design/icons'
import { useClusterStore } from '../../store/cluster'
import { useTabStore } from '../../store/tabs'
import { loadTenants, loadNamespaces, loadTopics, invalidateResourceCache } from '../../hooks/resourceCache'
import { shortName } from '../../utils/format'
import type { Tenant, Topic } from '../../types'

interface ResourceTreeNode extends DataNode {
  dataRef?: {
    type: 'cluster' | 'tenant' | 'namespace' | 'topic'
    clusterId?: string
    tenant?: string
    namespace?: string
    topic?: string
    persistent?: boolean
    cluster?: any
  }
}

const ResourceTree: React.FC = () => {
  const [collapsed, setCollapsed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [treeData, setTreeData] = useState<DataNode[]>([])
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([])
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: ResourceTreeNode | null } | null>(null)
  const { clusters, fetchClusters, setActiveCluster, deleteClusterAsync, expandedClusterId } = useClusterStore()
  const { addTab } = useTabStore()

  // 将集群转换为树节点
  const clusterToTreeData = useMemo(() => {
    return clusters.map((cluster) => ({
      title: (
        <Space>
          <ClusterOutlined style={{ color: 'var(--color-primary)' }} />
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
      dataRef: { type: 'cluster' as const, clusterId: cluster.id, cluster },
      children: [],
      isLeaf: false,
    }))
  }, [clusters])

  // 加载指定节点的子节点（带缓存）
  const loadTreeNodeData = useCallback(
    async (node: ResourceTreeNode): Promise<DataNode[]> => {
      const dataRef = node.dataRef
      if (!dataRef) return []

      const { type, clusterId, tenant, namespace } = dataRef

      try {
        if (type === 'cluster' && clusterId) {
          const tenants = await loadTenants(clusterId)
          return tenants.map((t: Tenant) => ({
            title: (
              <Space>
                <FolderOutlined />
                <span>{t.name}</span>
              </Space>
            ),
            key: `tenant-${clusterId}-${t.name}`,
            dataRef: { type: 'tenant' as const, clusterId, tenant: t.name },
            children: [],
            isLeaf: false,
          }))
        } else if (type === 'tenant' && clusterId && tenant) {
          const namespaces = await loadNamespaces(clusterId, tenant)
          return namespaces.map((ns: string) => ({
            title: (
              <Space>
                <DatabaseOutlined />
                <span>{ns}</span>
              </Space>
            ),
            key: `ns-${clusterId}-${tenant}-${ns}`,
            dataRef: { type: 'namespace' as const, clusterId, tenant, namespace: ns },
            children: [],
            isLeaf: false,
          }))
        } else if (type === 'namespace' && clusterId && tenant && namespace) {
          const topics = await loadTopics(clusterId, tenant, namespace)
          return topics.map((topic: Topic) => {
            const topicName = shortName(topic.name)
            return {
              title: (
                <Space>
                  <TableOutlined />
                  <span style={{ fontSize: 12 }}>{topicName}</span>
                </Space>
              ),
              key: `topic-${clusterId}-${tenant}-${namespace}-${topicName}`,
              dataRef: { type: 'topic' as const, clusterId, tenant, namespace, topic: topicName, persistent: topic.persistent },
              isLeaf: true,
            }
          })
        }
      } catch (error) {
        console.error('Failed to load tree node data:', error)
        message.error('加载资源失败')
      }

      return []
    },
    []
  )

  // 初始加载
  useEffect(() => {
    setTreeData(clusterToTreeData)
  }, [clusterToTreeData])

  // 响应集群展开事件
  useEffect(() => {
    if (expandedClusterId) {
      const clusterKey = `cluster-${expandedClusterId}`
      setExpandedKeys((prev) => {
        if (!prev.includes(clusterKey)) {
          return [...prev, clusterKey]
        }
        return prev
      })
    }
  }, [expandedClusterId])

  // 处理树节点展开
  const handleExpand = useCallback((expandedKeysValue: React.Key[]) => {
    setExpandedKeys(expandedKeysValue)
  }, [])

  // 处理树节点加载数据
  const handleLoadData = useCallback(
    async (node: ResourceTreeNode) => {
      // 检查是否已有子节点
      if ((node?.children?.length ?? 0) > 0) return

      const children = await loadTreeNodeData(node)
      setTreeData((prev) => {
        const updateNode = (nodes: DataNode[]): DataNode[] => {
          return nodes.map((n) => {
            if (n.key === node.key) {
              return { ...n, children }
            }
            if (n.children) {
              return { ...n, children: updateNode(n.children) }
            }
            return n
          })
        }
        return updateNode(prev)
      })
    },
    [loadTreeNodeData]
  )

  // 处理节点选择
  const handleSelect = useCallback(
    (keys: React.Key[], info: any) => {
      if (keys.length === 0) return

      const selectedNode = info.node as ResourceTreeNode
      const dataRef = selectedNode.dataRef

      if (dataRef?.type === 'cluster') {
        setActiveCluster(dataRef.clusterId ?? null)
      } else if (dataRef?.type === 'topic') {
        const clusterId = dataRef.clusterId ?? ''
        const tenant = dataRef.tenant ?? ''
        const namespace = dataRef.namespace ?? ''
        const topic = dataRef.topic ?? ''
        const persistent = dataRef.persistent
        addTab({
          id: `topic-${clusterId}-${tenant}-${namespace}-${topic}`,
          title: topic,
          type: 'topic',
          data: { clusterId, tenant, namespace, topic, persistent },
        })
      } else if (dataRef?.type === 'tenant') {
        addTab({
          id: `tenant-${dataRef.clusterId}-${dataRef.tenant}`,
          title: `${dataRef.tenant}`,
          type: 'tenant',
          data: dataRef,
        })
      } else if (dataRef?.type === 'namespace') {
        addTab({
          id: `ns-${dataRef.clusterId}-${dataRef.tenant}-${dataRef.namespace}`,
          title: `${dataRef.namespace}`,
          type: 'namespace',
          data: dataRef,
        })
      }
    },
    [setActiveCluster, addTab]
  )

  // 右键菜单处理
  const handleContextMenu = useCallback((e: React.MouseEvent, node: DataNode) => {
    e.preventDefault()
    const menuWidth = 180 // approximate menu width
    const menuHeight = 200 // approximate menu height

    let x = e.clientX
    let y = e.clientY

    // Adjust if menu would overflow viewport
    if (x + menuWidth > window.innerWidth) {
      x = window.innerWidth - menuWidth - 8
    }
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 8
    }

    setContextMenu({ x, y, node: node as ResourceTreeNode })
  }, [])

  // 关闭右键菜单
  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  // 点击外部关闭右键菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (contextMenu && !(event.target as Element).closest('.ant-menu')) {
        closeContextMenu()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [contextMenu, closeContextMenu])

  // 右键菜单操作
  const handleContextMenuAction = useCallback(async (action: string, node: ResourceTreeNode) => {
    const dataRef = node.dataRef
    
    switch (action) {
      case 'view':
        if (dataRef?.type === 'topic') {
          const clusterId = dataRef.clusterId ?? ''
          const tenant = dataRef.tenant ?? ''
          const namespace = dataRef.namespace ?? ''
          const topic = dataRef.topic ?? ''
          const persistent = dataRef.persistent
          addTab({
            id: `topic-${clusterId}-${tenant}-${namespace}-${topic}`,
            title: topic,
            type: 'topic',
            data: { clusterId, tenant, namespace, topic, persistent },
          })
        } else if (dataRef?.type === 'cluster') {
          setActiveCluster(dataRef.clusterId ?? '')
        }
        break
      case 'topology':
        if (dataRef?.type === 'cluster') {
          addTab({
            id: `topology-${dataRef.clusterId}`,
            title: `${dataRef.cluster?.name || '集群'}拓扑`,
            type: 'topology',
            data: { clusterId: dataRef.clusterId },
          })
        }
        break
      case 'metrics':
        if (dataRef?.type === 'cluster') {
          addTab({
            id: `metrics-${dataRef.clusterId}`,
            title: `${dataRef.cluster?.name || '集群'}监控`,
            type: 'metrics',
            data: { clusterId: dataRef.clusterId },
          })
        } else if (dataRef?.type === 'topic') {
          const clusterId = dataRef.clusterId ?? ''
          const tenant = dataRef.tenant ?? ''
          const namespace = dataRef.namespace ?? ''
          const topic = dataRef.topic ?? ''
          const persistent = dataRef.persistent
          addTab({
            id: `topic-${clusterId}-${tenant}-${namespace}-${topic}`,
            title: `${topic}`,
            type: 'topic',
            data: { clusterId, tenant, namespace, topic, persistent },
          })
        }
        break
      case 'delete':
        if (dataRef?.type === 'cluster') {
          const clusterName = dataRef.cluster?.name || dataRef.clusterId
          Modal.confirm({
            title: '确认删除',
            content: `确定要删除集群 "${clusterName}" 吗？`,
            okText: '删除',
            okType: 'danger',
            cancelText: '取消',
            onOk: async () => {
              if (dataRef.clusterId && await deleteClusterAsync(dataRef.clusterId)) {
                message.success('删除成功')
              }
            },
          })
        }
        break
    }
    closeContextMenu()
  }, [addTab, setActiveCluster, deleteClusterAsync, closeContextMenu])

  // 构建右键菜单
  const contextMenuItems = useMemo(() => {
    if (!contextMenu?.node) return []
    
    const dataRef = (contextMenu.node as ResourceTreeNode).dataRef
    
    const baseItems = [
      { key: 'view', label: '查看详情', icon: <EyeOutlined /> },
    ]

    if (dataRef?.type === 'cluster') {
      return [
        ...baseItems,
        { key: 'topology', label: '查看拓扑', icon: <ApartmentOutlined /> },
        { key: 'metrics', label: '查看监控', icon: <BarChartOutlined /> },
        { type: 'divider' as const },
        { key: 'delete', label: '删除集群', icon: <DeleteOutlined />, danger: true },
      ]
    }

    if (dataRef?.type === 'topic') {
      return [
        ...baseItems,
        { key: 'metrics', label: '查看监控', icon: <BarChartOutlined /> },
      ]
    }

    return baseItems
  }, [contextMenu])

  // 刷新整个树（重置状态）
  const handleRefresh = useCallback(async () => {
    setLoading(true)
    // 强制刷新时清空资源缓存，确保拉取到最新的租户/命名空间/Topic
    invalidateResourceCache()
    const previousExpanded = [...expandedKeys]
    // Don't collapse - just refresh data
    try {
      await fetchClusters()
      // Keep previous expansion state, filtering out keys for removed clusters
      setExpandedKeys((prev) =>
        prev.filter((key) => {
          if (typeof key === 'string' && key.startsWith('cluster-')) {
            const clusterId = key.replace('cluster-', '')
            return clusters.some((c) => c.id === clusterId)
          }
          return true
        })
      )
      message.success('刷新成功')
    } catch (error) {
      console.error('Failed to refresh clusters:', error)
      setExpandedKeys(previousExpanded)
      message.error('刷新失败')
    } finally {
      setLoading(false)
    }
  }, [fetchClusters, expandedKeys, clusters])

  // 打开监控仪表盘
  const handleOpenMetrics = useCallback(() => {
    addTab({
      id: 'metrics',
      title: '监控仪表盘',
      type: 'metrics',
    })
  }, [addTab])

  // 打开拓扑可视化
  const handleOpenTopology = useCallback(() => {
    addTab({
      id: 'topology',
      title: '集群拓扑',
      type: 'topology',
    })
  }, [addTab])

  // 空状态
  const renderEmpty = () => (
    <div
      style={{
        padding: '40px 16px',
        textAlign: 'center',
        color: 'var(--color-text-secondary)',
      }}
    >
      <ClusterOutlined style={{ fontSize: 32, marginBottom: 8 }} />
      <p style={{ margin: 0 }}>暂无集群</p>
      <p style={{ margin: '8px 0 0', fontSize: 12 }}>
        请在首页添加集群
      </p>
    </div>
  )

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
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
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
          style={{ margin: 'var(--spacing-sm)' }}
          title="展开"
        />
      )}

      {/* 资源树 */}
      {!collapsed && (
        <div style={{ flex: 1, overflow: 'auto', padding: 'var(--spacing-sm)' }}>
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
                onRightClick={(info: { event: React.MouseEvent; node: DataNode }) => 
            handleContextMenu(info.event, info.node)}
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
          onClick={(e) => {
            if (contextMenu.node) {
              handleContextMenuAction(e.key, contextMenu.node)
            }
          }}
        />
      )}
    </div>
  )
}

export default ResourceTree
