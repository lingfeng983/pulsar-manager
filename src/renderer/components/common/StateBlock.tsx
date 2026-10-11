import React, {type ReactNode} from 'react';
import {Button, Empty, Result, Spin} from 'antd';

interface StateBlockProps {
    loading?: boolean;
    error?: string | null;
    errorTitle?: ReactNode;
    onRetry?: () => void;
    empty?: boolean;
    emptyText?: ReactNode;
    action?: ReactNode;
    height?: number | string;
    children?: ReactNode;
}

// 全局唯一的三态占位（规范 §2.3）：加载 / 异常 / 空数据。
// 判定顺序固定为 loading → error → empty，页面不再各自手写占位块。
const StateBlock: React.FC<StateBlockProps> = ({
    loading,
    error,
    errorTitle = '加载失败',
    onRetry,
    empty,
    emptyText = '暂无数据',
    action,
    height,
    children,
}) => {
    const style = height ? {minHeight: height, justifyContent: 'center' as const} : undefined;

    if (loading) {
        return (
            <div className="state-block" style={style}>
                <Spin size="large" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="state-block" style={style}>
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
            <div className="state-block" style={style}>
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText}>
                    {action}
                </Empty>
            </div>
        );
    }

    return <>{children}</>;
};

export default StateBlock;
