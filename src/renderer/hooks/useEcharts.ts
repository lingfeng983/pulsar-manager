import {useEffect, useRef} from 'react';
import type {RefObject} from 'react';

// 只依赖实际用到的方法，兼容直接持有 ECharts 实例和通过 ReactECharts 取实例两种写法。
type EchartsLike =
    | {
          resize: () => void;
          setOption: (option: any, opts?: any) => void;
          getOption: () => any;
      }
    | null
    | undefined;

// 容器尺寸变化（侧栏折叠、标签页切换）不会触发 window resize，
// 因此同时监听 ResizeObserver 和 window resize。
export function useEchartsResize(containerRef: RefObject<HTMLElement | null>, getChart: () => EchartsLike): void {
    const getChartRef = useRef(getChart);
    getChartRef.current = getChart;

    useEffect(() => {
        const handleResize = () => {
            getChartRef.current()?.resize();
        };

        const observer = new ResizeObserver(handleResize);
        if (containerRef.current) {
            observer.observe(containerRef.current);
        }
        window.addEventListener('resize', handleResize);

        return () => {
            observer.disconnect();
            window.removeEventListener('resize', handleResize);
        };
    }, [containerRef]);
}

// graphRoam action 注册时 update 是 'none'，dispatchAction 只改 model 不重绘。
// 缩放必须写回公开的 series.zoom/center，让 echarts 重建 view 坐标系（createView 里会 setCenter/setZoom）。
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 6;

type GraphSeriesOption = {type?: string; zoom?: number; center?: unknown};

function graphSeriesIndex(chart: EchartsLike): number {
    const series: GraphSeriesOption[] = chart?.getOption()?.series ?? [];
    return series.findIndex(item => item?.type === 'graph');
}

function patchGraphSeries(chart: EchartsLike, index: number, patch: GraphSeriesOption): void {
    // 其余系列传空对象占位：setOption 按下标合并，缺位会让 echarts 认为组件被删掉。
    const payload = Array.from({length: index + 1}, (_, i) => (i === index ? patch : {}));
    chart?.setOption({series: payload});
}

// factor 是倍率：放大传 >1，缩小传 <1
export function zoomGraph(chart: EchartsLike, factor: number): void {
    const index = graphSeriesIndex(chart);
    if (index < 0) {
        return;
    }
    const current: GraphSeriesOption[] = chart?.getOption()?.series ?? [];
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (Number(current[index]?.zoom) || 1) * factor));
    patchGraphSeries(chart, index, {zoom: next});
}

// 复位缩放比例与中心点
export function resetGraphView(chart: EchartsLike): void {
    const index = graphSeriesIndex(chart);
    if (index < 0) {
        return;
    }
    patchGraphSeries(chart, index, {zoom: 1, center: ['50%', '50%']});
}
