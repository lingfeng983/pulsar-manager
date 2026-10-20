import React from 'react';
import {Button, Result, Typography} from 'antd';

interface Props {
    children: React.ReactNode;
}

interface State {
    error: Error | null;
}

/**
 * 任何一屏 React 渲染异常都会连带整棵组件树卸载，用户看到的是全白窗口且没有任何
 * 反馈（WebView2 外壳里连控制台都不好打开）。这里兜住并给出错误文本与重载入口。
 */
class ErrorBoundary extends React.Component<Props, State> {
    state: State = {error: null};

    static getDerivedStateFromError(error: Error): State {
        return {error};
    }

    componentDidCatch(error: Error, info: React.ErrorInfo): void {
        console.error('[renderer] uncaught render error:', error, info.componentStack);
    }

    render(): React.ReactNode {
        const {error} = this.state;
        if (!error) {
            return this.props.children;
        }
        return (
            <Result
                status="error"
                title="界面出现异常"
                subTitle="该页面已停止渲染。可以重载界面恢复，操作日志与数据不受影响。"
                extra={
                    <Button type="primary" onClick={() => window.location.reload()}>
                        重载界面
                    </Button>
                }
            >
                <Typography.Paragraph type="secondary" style={{whiteSpace: 'pre-wrap'}}>
                    {error.message}
                </Typography.Paragraph>
            </Result>
        );
    }
}

export default ErrorBoundary;
