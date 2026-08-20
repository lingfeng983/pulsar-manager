import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { Card, Button, Space, Select, Spin, Empty, message, Statistic, Row, Col } from 'antd'
import { ReloadOutlined, ZoomInOutlined, ZoomOutOutlined, FullscreenOutlined, CompressOutlined, DatabaseOutlined, MessageOutlined, BranchesOutlined } from '@ant-design/icons'
import ReactECharts from 'echarts-for-react'
import type { EChartsOption } from 'echarts'
import { useClusterStore } from '../../store/cluster'
import type { ClusterConfig } from '../../types'
import { useFullscreen } from '../../hooks/useFullscreen'
import { useEchartsResize, zoomGraph, resetGraphView } from '../../hooks/useEcharts'

interface ClusterTopologyProps {
  clusterId?: string
}

interface ClusterTopology {
  brokers: Array<{
    name: string
    topics: string[]
    stats?: any
  }>
  topics: Array<{
    name: string
    tenant: string
    namespace: string
    partitions: number
    subscriptions: string[]
    producers: number
    consumers: number
    msgRateIn: number
    msgRateOut: number
    backlogSize: number
  }>
}

interface TopologyNode {
  id: string
  name: string
  type: 'broker' | 'topic' | 'partition' | 'subscription'
  cluster?: string
  tenant?: string
  namespace?: string
}

interface TopologyEdge {
  source: string
  target: string
  value?: number
}

// 创建拓扑图配置
const createTopologyOption = (
  nodes: TopologyNode[],
  edges: TopologyEdge[]
): EChartsOption => {
  // 节点分类
  const categories = [
    { name: 'Broker', itemStyle: { color: '#409EFF' } },
    { name: 'Topic', itemStyle: { color: '#67C23A' } },
    { name: 'Partition', itemStyle: { color: '#E6A23C' } },
    { name: 'Subscription', itemStyle: { color: '#F56C6C' } }
  ]

  // 动态计算节点大小和斥力（根据节点数量）
  const nodeCount = nodes.length
  const baseSize = Math.max(15, Math.min(40, 50 - nodeCount / 10))
  const repulsion = Math.max(100, Math.min(500, 300 + nodeCount * 5))

  // 转换节点数据
  const graphNodes = nodes.map(node => {
    let symbolSize = baseSize
    let category = 0

    switch (node.type) {
      case 'broker':
        symbolSize = baseSize * 1.8
        category = 0
        break
      case 'topic':
        symbolSize = baseSize * 1.4
        category = 1
        break
      case 'partition':
        symbolSize = baseSize * 1.1
        category = 2
        break
      case 'subscription':
        symbolSize = baseSize
        category = 3
        break
    }

    return {
      id: node.id,
      name: node.name,
      category,
      symbolSize,
      value: node.name,
      itemStyle: {
        borderColor: categories[category].itemStyle.color,
        borderWidth: 3,
        shadowBlur: 15,
        shadowColor: 'rgba(0, 0, 0, 0.3)',
        color: categories[category].itemStyle.color
      },
      emphasis: {
        itemStyle: {
          borderWidth: 4,
          shadowBlur: 20,
          shadowColor: categories[category].itemStyle.color,
          scale: true
        },
        label: {
          fontSize: 14,
          fontWeight: 600
        }
      }
    }
  })

  // 转换边数据
  const graphLinks = edges.map(edge => ({
    source: edge.source,
    target: edge.target,
    value: edge.value,
    lineStyle: {
      color: '#909399',
      width: edge.value ? Math.max(1, edge.value / 200) : 1,
      curveness: 0.2,
      opacity: 0.6
    },
    emphasis: {
      lineStyle: {
        width: 3,
        color: categories[0].itemStyle.color,
        opacity: 1
      }
    }
  }))

  return {
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(255, 255, 255, 0.95)',
      borderColor: '#e8e8e8',
      borderWidth: 1,
      padding: [12, 16],
      textStyle: {
        color: '#333',
        fontSize: 13
      },
      formatter: (params: any) => {
        if (params.dataType === 'node') {
          const node = nodes.find(n => n.id === params.data.id)
          if (node) {
            return `
              <div style="font-weight: 600; font-size: 14px; margin-bottom: 8px">${node.name}</div>
              <div style="color: #909399">类型: ${node.type === 'broker' ? 'Broker' : node.type === 'topic' ? 'Topic' : node.type === 'partition' ? 'Partition' : 'Subscription'}</div>
              ${node.tenant ? `<div>租户: ${node.tenant}</div>` : ''}
              ${node.namespace ? `<div>命名空间: ${node.namespace}</div>` : ''}
            `
          }
        }
        return `${params.data.source} → ${params.data.target}`
      }
    },
    legend: {
      data: categories.map(c => c.name),
      top: 10,
      left: 'center',
      itemWidth: 16,
      itemHeight: 16,
      textStyle: {
        fontSize: 13
      }
    },
    animation: true,
    animationDuration: 1500,
    animationDurationUpdate: 1000,
    animationEasingUpdate: 'quinticInOut',
    series: [{
      type: 'graph',
      layout: 'force',
      roam: true,
      draggable: true,
      label: {
        show: true,
        position: 'bottom',
        formatter: '{b}',
        fontSize: 12,
        color: '#666',
        fontWeight: 500
      },
      edgeSymbol: ['circle', 'arrow'],
      edgeSymbolSize: [4, 12],
      data: graphNodes,
      links: graphLinks,
      categories,
      force: {
        repulsion: repulsion,
        gravity: 0.1,
        edgeLength: [80, 250],
        layoutAnimation: true
      },
      lineStyle: {
        opacity: 0.6
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

const ClusterTopology: React.FC<ClusterTopologyProps> = ({ clusterId: initialClusterId }) => {
  const [loading, setLoading] = useState(false)
  const [nodes, setNodes] = useState<TopologyNode[]>([])
  const [edges, setEdges] = useState<TopologyEdge[]>([])
  const [selectedClusterId, setSelectedClusterId] = useState<string | undefined>(initialClusterId)
  const [stats, setStats] = useState({
    brokers: 0,
    topics: 0,
    subscriptions: 0
  })
  const chartRef = useRef<ReactECharts>(null)
  const chartKey = useRef(0)
  const getChart = useCallback(() => chartRef.current?.getEchartsInstance(), [])

  // 进出全屏后容器尺寸变化，需要等浏览器完成布局再 resize
  const handleFullscreenChange = useCallback(() => {
    setTimeout(() => getChart()?.resize(), 100)
  }, [getChart])

  const {
    ref: chartContainerRef,
    isFullscreen,
    toggle: toggleFullscreen,
  } = useFullscreen<HTMLDivElement>(handleFullscreenChange)
  useEchartsResize(chartContainerRef, getChart)

  const { clusters, fetchClusters } = useClusterStore()

  // 如果传入了特定集群，则使用该集群，否则支持选择
  const selectedCluster = selectedClusterId || clusters.find(c => c.status === 'connected')?.id || clusters[0]?.id

  // 初始化
  useEffect(() => {
    fetchClusters()
  }, [fetchClusters])

  // 图表实例初始化后的处理
  const onChartInit = useCallback((chart: any) => {
    // 确保图表实例正确初始化
    if (chart) {
      // 延迟一点让图表完成初始布局
      setTimeout(() => {
        chart.resize()
      }, 100)
    }
  }, [])

  // 转换拓扑数据
  const transformTopologyData = useCallback((data: any): { nodes: TopologyNode[]; edges: TopologyEdge[] } => {
    const newNodes: TopologyNode[] = []
    const newEdges: TopologyEdge[] = []

    // 添加 Broker 节点
    data.brokers?.forEach((broker: any) => {
      newNodes.push({
        id: broker.name,
        name: broker.name,
        type: 'broker',
        cluster: selectedCluster
      })

      // Broker -> Topic 边
      broker.topics?.forEach((topicName: string) => {
        newEdges.push({
          source: broker.name,
          target: topicName,
          value: 100
        })
      })
    })

    // 添加 Topic 节点和订阅
    data.topics?.forEach((topic: any) => {
      const topicId = `${topic.tenant}/${topic.namespace}/${topic.name}`
      newNodes.push({
        id: topicId,
        name: topic.name,
        type: 'topic',
        tenant: topic.tenant,
        namespace: topic.namespace
      })

      // Topic -> Subscription 边
      topic.subscriptions?.forEach((sub: string) => {
        const subId = `${topicId}/${sub}`
        newNodes.push({
          id: subId,
          name: sub,
          type: 'subscription',
          tenant: topic.tenant,
          namespace: topic.namespace
        })

        newEdges.push({
          source: topicId,
          target: subId,
          value: topic.msgRateIn || 0
        })
      })
    })

    return { nodes: newNodes, edges: newEdges }
  }, [selectedCluster])

  // 加载拓扑数据
  const loadTopology = useCallback(async () => {
    if (!selectedCluster) return

    setLoading(true)
    try {
      const response = await window.electronAPI.topology.getClusterTopology(selectedCluster)

      if (response.success && response.data) {
        const { nodes: newNodes, edges: newEdges } = transformTopologyData(response.data)
        setNodes(newNodes)
        setEdges(newEdges)
        
        // 计算统计数据
        const brokerCount = newNodes.filter(n => n.type === 'broker').length
        const topicCount = newNodes.filter(n => n.type === 'topic').length
        const subCount = newNodes.filter(n => n.type === 'subscription').length
        setStats({ brokers: brokerCount, topics: topicCount, subscriptions: subCount })
        
        chartKey.current += 1
        
        // 图表加载后重新调整大小
        setTimeout(() => {
          chartRef.current?.getEchartsInstance()?.resize()
        }, 100)
      } else {
        message.warning(response.error || '获取拓扑数据失败')
        setStats({ brokers: 0, topics: 0, subscriptions: 0 })
      }
    } catch (error) {
      console.error('Failed to load topology:', error)
      message.error('加载拓扑数据失败')
      setStats({ brokers: 0, topics: 0, subscriptions: 0 })
    } finally {
      setLoading(false)
    }
  }, [selectedCluster, transformTopologyData])

  // 初始加载
  useEffect(() => {
    if (selectedCluster) {
      loadTopology()
    }
  }, [selectedCluster, loadTopology])

  // 图表配置（使用 useMemo 缓存）
  const chartOption = useMemo(() => createTopologyOption(nodes, edges), [nodes, edges])

  // 图表操作 - 放大
  const handleZoomIn = useCallback(() => {
    zoomGraph(getChart(), 1.2)
  }, [getChart])

  // 图表操作 - 缩小
  const handleZoomOut = useCallback(() => {
    zoomGraph(getChart(), 0.8)
  }, [getChart])

  // 重置视图
  const handleResetView = useCallback(() => {
    if (!getChart()) return

    resetGraphView(getChart())

    message.success('视图已重置')
  }, [])

  return (
    <div 
      ref={chartContainerRef}
      style={{ 
        padding: 'var(--spacing-lg)', 
        height: '100%', 
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        backgroundColor: isFullscreen ? '#000' : undefined
      }}
    >
      {/* 页面标题和工具栏 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 'var(--spacing-md)',
          flexWrap: 'wrap',
          gap: 'var(--spacing-sm)'
        }}
      >
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>
          {initialClusterId 
            ? `${clusters.find(c => c.id === initialClusterId)?.name || '集群'}拓扑`
            : '集群拓扑'
          }
          {nodes.length > 0 && (
            <span style={{ fontSize: 12, color: '#909399', marginLeft: 12 }}>
              节点: {nodes.length} | 连接: {edges.length}
            </span>
          )}
        </h2>
        <Space wrap size="small">
          {/* 如果没有传入特定集群，显示集群选择器 */}
          {!initialClusterId && clusters.length > 0 && (
            <Select
              value={selectedClusterId}
              onChange={(value) => {
                setSelectedClusterId(value)
              }}
              style={{ width: 180 }}
              placeholder="选择集群"
              options={clusters.map((c: ClusterConfig) => ({ 
                label: `${c.name} ${c.status === 'connected' ? '(在线)' : '(离线)'}`, 
                value: c.id 
              }))}
            />
          )}
          <Button 
            icon={<ZoomInOutlined />} 
            onClick={handleZoomIn}
            title="放大视图"
          >
            放大
          </Button>
          <Button 
            icon={<ZoomOutOutlined />} 
            onClick={handleZoomOut}
            title="缩小视图"
          >
            缩小
          </Button>
          <Button 
            icon={<ReloadOutlined />} 
            onClick={handleResetView}
            title="重置视图"
          >
            重置
          </Button>
          <Button 
            icon={isFullscreen ? <CompressOutlined /> : <FullscreenOutlined />} 
            onClick={toggleFullscreen}
            title={isFullscreen ? '退出全屏' : '全屏'}
          >
            {isFullscreen ? '退出全屏' : '全屏'}
          </Button>
          <Button 
            icon={<ReloadOutlined spin={loading} />} 
            onClick={loadTopology}
            loading={loading}
            title="刷新数据"
          >
            刷新
          </Button>
        </Space>
      </div>

      {/* 统计概览 */}
      <Row gutter={16} style={{ marginBottom: 'var(--spacing-md)' }}>
        <Col span={8}>
          <Card>
            <Statistic
              title="Brokers"
              value={stats.brokers}
              prefix={<DatabaseOutlined />}
              valueStyle={{ color: '#409EFF' }}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="Topics"
              value={stats.topics}
              prefix={<MessageOutlined />}
              valueStyle={{ color: '#67C23A' }}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="Subscriptions"
              value={stats.subscriptions}
              prefix={<BranchesOutlined />}
              valueStyle={{ color: '#E6A23C' }}
            />
          </Card>
        </Col>
      </Row>

      {/* 拓扑图 */}
      <Card 
        bodyStyle={{ padding: 0, flex: 1, minHeight: 400, display: 'flex', flexDirection: 'column' }}
        style={{ 
          flex: 1,
          height: isFullscreen ? '100vh' : undefined,
          margin: isFullscreen ? 0 : undefined
        }}
      >
        <Spin 
          spinning={loading && nodes.length === 0} 
          tip="正在加载拓扑数据..."
          style={{ flex: 1, display: 'flex' }}
        >
          {nodes.length > 0 ? (
            <ReactECharts
              ref={chartRef}
              key={chartKey.current}
              option={chartOption}
              style={{ height: '100%', width: '100%' }}
              onChartReady={onChartInit}
              opts={{
                renderer: 'canvas',
              }}
              onEvents={{
                click: (params: any) => {
                  console.log('Node clicked:', params)
                }
              }}
            />
          ) : (
            <div style={{ 
              display: 'flex', 
              flexDirection: 'column', 
              alignItems: 'center', 
              justifyContent: 'center',
              flex: 1,
              gap: 16
            }}>
              <Empty description="暂无拓扑数据" />
              <Button type="primary" onClick={loadTopology}>加载拓扑</Button>
            </div>
          )}
        </Spin>
      </Card>
    </div>
  )
}

export default ClusterTopology
