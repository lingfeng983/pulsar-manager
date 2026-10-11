import React, {useCallback, useRef, type ReactNode} from 'react';
import {Card} from 'antd';
import {CompressOutlined, FullscreenOutlined} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import type {EChartsOption} from 'echarts';
import {useFullscreen} from '../../hooks/useFullscreen';
import {useEchartsResize} from '../../hooks/useEcharts';
import IconButton from '../common/IconButton';
import StateBlock from '../common/StateBlock';

interface ChartCardProps {
    title: ReactNode;
    option: EChartsOption;
    isEmpty: boolean;
    emptyText?: ReactNode;
    height?: number;
    onEvents?: Record<string, (params: any) => void>;
    notMerge?: boolean;
}

// 带全屏按钮的图表卡片：容器、ECharts 实例、尺寸监听由这里统一持有，
// 页面不再为每张图各留一个 ref 和一份 resize 逻辑。
const ChartCard: React.FC<ChartCardProps> = ({
    title,
    option,
    isEmpty,
    emptyText = '暂无数据',
    height = 300,
    onEvents,
    notMerge,
}) => {
    const chartRef = useRef<ReactECharts>(null);
    const getChart = useCallback(() => chartRef.current?.getEchartsInstance() ?? null, []);
    const {ref, isFullscreen, toggle} = useFullscreen<HTMLDivElement>();
    useEchartsResize(ref, getChart);

    // 全屏时不能再写死像素高：:fullscreen 给卡片的是整个视口，图只跟着宽铺、
    // 高度还是 300px，看上去就是"只有长度增加、宽度没变"。改成让卡片当 flex 容器，
    // 图吃满剩余高度，卡片尺寸一变 ResizeObserver 就调 chart.resize()。
    return (
        <Card
            ref={ref}
            title={title}
            extra={
                <IconButton
                    type="text"
                    label={isFullscreen ? '退出全屏' : '全屏'}
                    icon={isFullscreen ? <CompressOutlined /> : <FullscreenOutlined />}
                    onClick={toggle}
                />
            }
            className={isFullscreen ? 'chart-card chart-card-fullscreen' : 'chart-card'}
            styles={{body: {display: 'flex', flexDirection: 'column', minHeight: 0}}}
        >
            {isEmpty ? (
                <StateBlock empty emptyText={emptyText} height={isFullscreen ? '100%' : height} />
            ) : (
                <ReactECharts
                    ref={chartRef}
                    option={option}
                    style={isFullscreen ? {flex: '1 1 auto', minHeight: 0, width: '100%'} : {height, width: '100%'}}
                    onEvents={onEvents}
                    notMerge={notMerge}
                />
            )}
        </Card>
    );
};

export default ChartCard;
