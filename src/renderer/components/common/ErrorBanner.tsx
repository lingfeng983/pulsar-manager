import React from 'react';
import {Alert} from 'antd';

interface ErrorBannerProps {
    error: string | null;
    onClose?: () => void;
    title?: string;
}

// 数据仍在展示时用横幅提示失败（占位状态由 StateBlock 负责），两处的文案与样式在此对齐。
const ErrorBanner: React.FC<ErrorBannerProps> = ({error, onClose, title = '加载失败'}) => {
    if (!error) {
        return null;
    }
    return <Alert type="error" showIcon closable={!!onClose} onClose={onClose} message={title} description={error} />;
};

export default ErrorBanner;
