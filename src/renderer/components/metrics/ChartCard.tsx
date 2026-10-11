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
        >
            {isEmpty ? (
                <StateBlock empty emptyText={emptyText} height={height} />
            ) : (
                <ReactECharts
                    ref={chartRef}
                    option={option}
                    style={{height, width: '100%'}}
                    onEvents={onEvents}
                    notMerge={notMerge}
                />
            )}
        </Card>
    );
};

export default ChartCard;
