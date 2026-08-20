import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { Card, Button, Space, Spin, Alert, Statistic, Row, Col, Tag } from 'antd'
import { ReloadOutlined, ZoomInOutlined, ZoomOutOutlined, FullscreenOutlined, CompressOutlined, ClusterOutlined, DatabaseOutlined, MessageOutlined } from '@ant-design/icons'
import ReactECharts from 'echarts-for-react'
import type { EChartsOption } from 'echarts'
import { useClusterStore } from '../store/cluster'

interface TopologyNode {
  id: string
  name: string
  type: 'cluster' | 'broker' | 'topic'
  status?: string
  count?: number
  realData?: boolean
}

interface TopologyEdge {
  source: string
  target: string
  value?: number
}

interface ClusterTopologyData {
  clusterId: string
  clusterName: string
  clusterStatus: string
  brokers: string[]
  topics: { name: string; msgRateIn: number }[]
}

// 节点类型常量
const NODE_TYPES = {
  CLUSTER: 'cluster' as const,
  BROKER: 'broker' as const,
  TOPIC: 'topic' as const
}

// 节点颜色配置
const NODE_COLORS: Record<string, string> = {
  CLUSTER_CONNECTED: '#409EFF',
  CLUSTER_DISCONNECTED: '#F56C6C',
  BROKER: '#67C23A',
  TOPIC: '#E6A23C'
}

// 节点大小配置
const NODE_SIZES: Record<string, number> = {
  CLUSTER: 70,
  BROKER: 35,
  TOPIC: 25
}

// 首页概览只展示少量节点，把规模上限下推给主进程，避免为了几个节点遍历整个集群
const HOME_TOPOLOGY_LIMITS = {
  maxTenants: 3,
  maxNamespacesPerTenant: 2,
  maxTopicsPerNamespace: 3,
  maxTopics: 8
}

// 获取单个集群的拓扑数据：直接复用主进程的聚合实现，不在渲染层重复多轮 IPC
async function fetchClusterTopology(
  clusterId: string,
  clusterName: string,
  clusterStatus: string
): Promise<ClusterTopologyData> {
  const response = await window.electronAPI.topology.getClusterTopology(clusterId, HOME_TOPOLOGY_LIMITS)
  if (!response.success || !response.data) {
    throw new Error(response.error || '获取拓扑数据失败')
  }

  return {
    clusterId,
    clusterName,
    clusterStatus,
    brokers: (response.data.brokers || []).map(broker => broker.name),
    topics: (response.data.topics || []).map(topic => ({
      name: topic.name,
      msgRateIn: topic.msgRateIn || 0
    }))
  }
}


// 创建拓扑图配置（使用 useMemo 缓存）
const createTopologyOption = (
  nodes: TopologyNode[],
  edges: TopologyEdge[]
): EChartsOption => {
  const categories = [
    { name: 'Cluster', itemStyle: { color: NODE_COLORS.CLUSTER_CONNECTED } },
    { name: 'Broker', itemStyle: { color: NODE_COLORS.BROKER } },
    { name: 'Topic', itemStyle: { color: NODE_COLORS.TOPIC } }
  ]

  const graphNodes = nodes.map(node => {
    let symbolSize = NODE_SIZES.CLUSTER
    let category = 0
    let color = NODE_COLORS.CLUSTER_CONNECTED

    switch (node.type) {
      case NODE_TYPES.CLUSTER:
        symbolSize = NODE_SIZES.CLUSTER
        category = 0
        color = node.status === 'connected' ? NODE_COLORS.CLUSTER_CONNECTED : NODE_COLORS.CLUSTER_DISCONNECTED
        break
      case NODE_TYPES.BROKER:
        symbolSize = NODE_SIZES.BROKER
        category = 1
        color = NODE_COLORS.BROKER
        break
      case NODE_TYPES.TOPIC:
        symbolSize = NODE_SIZES.TOPIC
        category = 2
        color = NODE_COLORS.TOPIC
        break
    }

    return {
      id: node.id,
      name: node.name,
      category,
      symbolSize,
      value: node.count,
      itemStyle: {
        color,
        borderColor: color,
        borderWidth: 3,
        shadowBlur: 15,
        shadowColor: 'rgba(0, 0, 0, 0.3)'
      },
      label: {
        show: true,
        position: 'bottom' as const,
        fontSize: 12,
        color: '#666'
      }
    }
  })

  const graphLinks = edges.map(edge => ({
    source: edge.source,
    target: edge.target,
    value: edge.value || 1,
    lineStyle: {
      color: '#999',
      width: Math.max(1, (edge.value || 1) / 10),
      curveness: 0.2
    }
  }))

  return {
    tooltip: {
      trigger: 'item' as const,
      formatter: (params: any) => {
        if (params.dataType === 'node') {
          const node = nodes.find(n => n.id === params.data.id)
          if (node) {
            const statusHtml = node.status
              ? `<div>状态: ${node.status === 'connected'
                  ? '<span style="color:#67C23A">● 在线</span>'
                  : '<span style="color:#F56C6C">● 离线</span>'}</div>`
              : ''
            const countHtml = node.count !== undefined
              ? `<div>${node.type === 'cluster' ? 'Topics' : '消息速率'}: ${node.count}</div>`
              : ''
            const dataTypeHtml = node.realData !== undefined
              ? `<div>数据来源: ${node.realData ? '真实' : '模拟'}</div>`
              : ''

            return `<div style="font-weight:bold;margin-bottom:8px;">${node.name}</div>
                    <div>类型: ${node.type === 'cluster' ? '集群' : node.type === 'broker' ? 'Broker' : 'Topic'}</div>
                    ${statusHtml}${countHtml}${dataTypeHtml}`
          }
        }
        return params.data?.id || ''
      }
    },
    legend: {
      data: ['Cluster', 'Broker', 'Topic'],
      top: 10
    },
    animationDuration: 1500,
    animationEasingUpdate: 'quinticInOut',
    series: [{
      type: 'graph',
      layout: 'force',
      data: graphNodes,
      links: graphLinks,
      categories: categories,
      roam: true,
      draggable: true,
      force: {
        repulsion: 300,
        gravity: 0.1,
        edgeLength: [80, 200],
        layoutAnimation: true
      },
      emphasis: {
        focus: 'adjacency',
        lineStyle: {
          width: 4
        }
      }
    }]
  }
}

// 构建拓扑节点和边
function buildTopologyFromData(clusterData: ClusterTopologyData[]): { nodes: TopologyNode[]; edges: TopologyEdge[] } {
  const nodes: TopologyNode[] = []
  const edges: TopologyEdge[] = []

  for (const cluster of clusterData) {
    const clusterBrokers = cluster.brokers || []
    const clusterTopics = cluster.topics || []
    
    // 添加集群节点
    nodes.push({
      id: cluster.clusterId,
      name: cluster.clusterName,
      type: NODE_TYPES.CLUSTER,
      status: cluster.clusterStatus,
      count: clusterTopics.length
    })

    // 添加 Broker 节点
    const brokersMap = new Map<number, string>() // index -> brokerId
    clusterBrokers.forEach((broker, idx) => {
      const brokerId = `${cluster.clusterId}-broker-${idx}`
      brokersMap.set(idx, brokerId)
      nodes.push({
        id: brokerId,
        name: broker,
        type: NODE_TYPES.BROKER,
        count: clusterTopics.filter((_, i) => i % Math.max(clusterBrokers.length, 1) === idx).length
      })
      edges.push({
        source: cluster.clusterId,
        target: brokerId,
        value: 10
      })
    })

    // 添加 Topic 节点（均匀分布在 Brokers 上）
    clusterTopics.forEach((topic, idx) => {
      const topicId = `${cluster.clusterId}-topic-${idx}`
      const targetBrokerIdx = idx % Math.max(clusterBrokers.length, 1)
      const brokerId = brokersMap.get(targetBrokerIdx) || `${cluster.clusterId}-broker-0`

      nodes.push({
        id: topicId,
        name: topic.name,
        type: NODE_TYPES.TOPIC,
        count: Math.floor(topic.msgRateIn),
        realData: true
      })
      edges.push({
        source: brokerId,
        target: topicId,
        value: Math.floor(topic.msgRateIn) + 10 || 10
      })
    })
  }

  return { nodes, edges }
}

const HomeTopology: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [nodes, setNodes] = useState<TopologyNode[]>([])
  const [edges, setEdges] = useState<TopologyEdge[]>([])
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState({
    clusters: 0,
    brokers: 0,
    topics: 0
  })
  const chartRef = useRef<HTMLDivElement>(null)
  const chartInstance = useRef<any>(null)

  const { clusters } = useClusterStore()

  // 缓存 ECharts 配置
  const chartOption = useMemo(() => createTopologyOption(nodes, edges), [nodes, edges])

  // 清理图表实例
  useEffect(() => {
    return () => {
      if (chartInstance.current) {
        chartInstance.current.dispose()
        chartInstance.current = null
      }
    }
  }, [])

  // 监听容器大小变化，触发 ECharts resize
  useEffect(() => {
    const handleResize = () => {
      if (chartInstance.current) {
        chartInstance.current.resize()
      }
    }

    const resizeObserver = new ResizeObserver(() => {
      handleResize()
    })

    if (chartRef.current) {
      resizeObserver.observe(chartRef.current)
    }

    window.addEventListener('resize', handleResize)

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  // 全屏切换
  const toggleFullscreen = useCallback(() => {
    if (!chartRef.current) return

    if (!isFullscreen) {
      chartRef.current.requestFullscreen?.()
    } else {
      document.exitFullscreen?.()
    }
    setIsFullscreen(!isFullscreen)
  }, [isFullscreen])

  // 监听全屏状态变化
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  // 加载集群拓扑数据
  const loadTopology = useCallback(async () => {
    if (clusters.length === 0) {
      setNodes([])
      setEdges([])
      setStats({ clusters: 0, brokers: 0, topics: 0 })
      return
    }

    // 只对已连接的集群加载拓扑数据
    const connectedClusters = clusters.filter(c => c.status === 'connected')
    if (connectedClusters.length === 0) {
      setNodes(clusters.map(c => ({
        id: c.id,
        name: c.name,
        type: 'cluster',
        status: 'disconnected',
      })))
      setEdges([])
      setStats({ clusters: clusters.length, brokers: 0, topics: 0 })
      return
    }

    setLoading(true)
    setError(null)

    try {
      // 并发获取所有已连接集群的拓扑数据
      const results = await Promise.allSettled(
        connectedClusters.map(cluster =>
          fetchClusterTopology(cluster.id, cluster.name, cluster.status || 'disconnected')
        )
      )

      const successfulData: ClusterTopologyData[] = []
      const errors: string[] = []

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          successfulData.push(result.value)
        } else {
          errors.push(`${connectedClusters[index].name}: ${result.reason}`)
        }
      })

      // 显示部分错误
      if (errors.length > 0) {
        setError(`部分集群数据加载失败: ${errors.slice(0, 2).join(', ')}${errors.length > 2 ? '...' : ''}`)
      }

      // 构建拓扑图数据
      const { nodes: newNodes, edges: newEdges } = buildTopologyFromData(successfulData)
      setNodes(newNodes)
      setEdges(newEdges)

      // 更新统计
      setStats({
        clusters: successfulData.length,
        brokers: successfulData.reduce((sum, d) => sum + d.brokers.length, 0),
        topics: successfulData.reduce((sum, d) => sum + d.topics.length, 0)
      })
    } catch (err) {
      console.error('Failed to load topology:', err)
      setError('加载拓扑数据失败，请稍后重试')
    } finally {
      setLoading(false)
    }
  }, [clusters])

  useEffect(() => {
    loadTopology()
  }, [loadTopology])

  // 放大
  const handleZoomIn = useCallback(() => {
    if (!chartInstance.current) return
    chartInstance.current.dispatchAction({
      type: 'graphRoam',
      zoom: 1.2,
    })
  }, [])

  // 缩小
  const handleZoomOut = useCallback(() => {
    if (!chartInstance.current) return
    chartInstance.current.dispatchAction({
      type: 'graphRoam',
      zoom: 0.8,
    })
  }, [])

  // 空状态
  if (clusters.length === 0) {
    return (
      <Card>
        <div
          style={{
            height: '500px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--color-text-secondary)',
          }}
        >
          <ClusterOutlined style={{ fontSize: 64, marginBottom: 16 }} />
          <p style={{ fontSize: 18, marginBottom: 8 }}>暂无集群配置</p>
          <p style={{ fontSize: 12, color: 'var(--color-text-hint)' }}>
            请先添加集群配置以查看拓扑图
          </p>
        </div>
      </Card>
    )
  }

  return (
    <Card
      title="集群拓扑总览"
      extra={
        <Space>
          <Button
            icon={<ZoomOutOutlined />}
            onClick={handleZoomOut}
            size="small"
            title="缩小"
          />
          <Button
            icon={<ZoomInOutlined />}
            onClick={handleZoomIn}
            size="small"
            title="放大"
          />
          <Button
            icon={<ReloadOutlined />}
            onClick={loadTopology}
            loading={loading}
            size="small"
          >
            刷新
          </Button>
          <Button
            icon={isFullscreen ? <CompressOutlined /> : <FullscreenOutlined />}
            onClick={toggleFullscreen}
            size="small"
            title={isFullscreen ? '退出全屏' : '全屏'}
          />
        </Space>
      }
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      bodyStyle={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <Spin spinning={loading} tip="正在加载拓扑数据...">
        {/* 统计信息 */}
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={8}>
            <Statistic
              title="集群数"
              value={stats.clusters}
              prefix={<ClusterOutlined />}
              valueStyle={{ color: '#409EFF' }}
            />
          </Col>
          <Col span={8}>
            <Statistic
              title="Brokers"
              value={stats.brokers}
              prefix={<DatabaseOutlined />}
              valueStyle={{ color: '#67C23A' }}
            />
          </Col>
          <Col span={8}>
            <Statistic
              title="Topics"
              value={stats.topics}
              prefix={<MessageOutlined />}
              valueStyle={{ color: '#E6A23C' }}
            />
          </Col>
        </Row>

        {/* 错误提示 */}
        {error && (
          <Alert
            message={error}
            type="warning"
            showIcon
            closable
            onClose={() => setError(null)}
            style={{ marginBottom: 16 }}
          />
        )}

        {/* 拓扑图 */}
        <div ref={chartRef} style={{ flex: 1, minHeight: 300 }}>
          {nodes.length > 0 && (
            <ReactECharts
              ref={(e) => { chartInstance.current = e?.getEchartsInstance() as typeof chartInstance.current }}
              option={chartOption}
              style={{ height: '100%', width: '100%' }}
              opts={{ renderer: 'canvas' }}
            />
          )}
        </div>

        {/* 图例说明 */}
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #eee' }}>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
            <Space size={16}>
              <Tag color="blue">集群</Tag>
              <Tag color="green">Broker</Tag>
              <Tag color="orange">Topic</Tag>
            </Space>
            <Space size={8}>
              <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', backgroundColor: '#409EFF' }} />
              <span style={{ fontSize: 12, color: '#666' }}>在线</span>
              <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', backgroundColor: '#F56C6C' }} />
              <span style={{ fontSize: 12, color: '#666' }}>离线</span>
            </Space>
          </div>
        </div>
      </Spin>
    </Card>
  )
}

export default HomeTopology