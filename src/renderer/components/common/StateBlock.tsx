import React, {type ReactNode} from 'react';
import {Button, Empty, Result, Skeleton, Spin} from 'antd';

interface StateBlockProps {
    loading?: boolean;
    error?: string | null;
    errorTitle?: ReactNode;
    onRetry?: () => void;
    empty?: boolean;
    emptyText?: ReactNode;
    action?: ReactNode;
    height?: number | string;
    /**
     * 加载态的画法：
     * - `spin`（默认）：居中转圈，适合图表、详情这类内容形状不确定的区块；
     * - `skeleton`：几行占位条，适合表格/列表——先给出"马上会有几行"的形状，
     *   加载完成时不会整块跳一下（规范 §6：优先骨架屏）。
     */
    loadingVariant?: 'spin' | 'skeleton';
    children?: ReactNode;
}

// 全局唯一的三态占位（规范 §2.3）：加载 / 异常 / 空数据。
// 判定顺序固定为 loading → error → empty，页面不再各自手写占位块。
// 三个分支都带 ARIA 语义：状态切换（比如轮询把空态翻成异常）要能被读屏播报，
// 而这块内容通常不在用户当前焦点上。
const StateBlock: React.FC<StateBlockProps> = ({
    loading,
    error,
    errorTitle = '加载失败',
    onRetry,
    empty,
    emptyText = '暂无数据',
    action,
    height,
    loadingVariant = 'spin',
    children,
}) => {
    const style = height ? {minHeight: height, justifyContent: 'center' as const} : undefined;

    if (loading) {
        if (loadingVariant === 'skeleton') {
            return (
                <div className="state-block state-block-skeleton" aria-busy="true" aria-live="polite">
                    <Skeleton active title={false} paragraph={{rows: 5}} />
                </div>
            );
        }
        return (
            <div className="state-block" style={style} role="status" aria-live="polite">
                <Spin size="large" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="state-block" style={style} role="alert">
                <Result
                    status="error"
                    title={errorTitle}
                    subTitle={error}
                    extra={onRetry ? <Button onClick={onRetry}>重试</Button> : undefined}
                />
            </div>
        );
    }

    if (empty) {
        return (
            <div className="state-block" style={style} role="status" aria-live="polite">
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText}>
                    {action}
                </Empty>
            </div>
        );
    }

    return <>{children}</>;
};

export default StateBlock;
