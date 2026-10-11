import React from 'react';
import {Alert} from 'antd';

interface ErrorBannerProps {
    error: string | null;
    onClose?: () => void;
    title?: string;
}

// 数据仍在展示时用横幅提示失败（占位状态由 StateBlock 负责），两处的文案在此对齐。
// 单行形态：标题与详情拼在一句里。带 description 的两行 Alert 常驻时白吃掉一截正文高度。
const ErrorBanner: React.FC<ErrorBannerProps> = ({error, onClose, title = '加载失败'}) => {
    if (!error) {
        return null;
    }
    return <Alert type="error" showIcon closable={!!onClose} onClose={onClose} message={`${title}：${error}`} />;
};

export default ErrorBanner;
