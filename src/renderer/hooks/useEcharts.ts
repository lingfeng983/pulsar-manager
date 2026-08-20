import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

// 只依赖实际用到的两个方法，兼容直接持有 ECharts 实例和通过 ReactECharts 取实例两种写法。
// dispatchAction 用宽松签名以兼容 echarts 官方类型（其 payload 要求带 type 字段）。
type EchartsLike = {
  resize: () => void
  dispatchAction: (payload: any, ...args: any[]) => void
} | null | undefined


// 容器尺寸变化（侧栏折叠、标签页切换）不会触发 window resize，
// 因此同时监听 ResizeObserver 和 window resize。
export function useEchartsResize(
  containerRef: RefObject<HTMLElement | null>,
  getChart: () => EchartsLike,
): void {
  const getChartRef = useRef(getChart)
  getChartRef.current = getChart

  useEffect(() => {
    const handleResize = () => {
      getChartRef.current()?.resize()
    }

    const observer = new ResizeObserver(handleResize)
    if (containerRef.current) {
      observer.observe(containerRef.current)
    }
    window.addEventListener('resize', handleResize)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [containerRef])
}

// graph（力导向图）的缩放只能通过 graphRoam action，dataZoom 对它无效
export function zoomGraph(chart: EchartsLike, zoom: number): void {
  chart?.dispatchAction({ type: 'graphRoam', zoom })
}

// 复位缩放比例与中心点
export function resetGraphView(chart: EchartsLike): void {
  chart?.dispatchAction({ type: 'graphRoam', zoom: 1, center: ['50%', '50%'] })
}
