import React, {type ReactNode} from 'react';
import {Button, Tooltip, type ButtonProps} from 'antd';

interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'children'> {
    icon: ReactNode;
    /** 可访问名：同时作为悬停提示、title 与 aria-label，缺失就无法通过类型检查 */
    label: string;
    /** 关闭悬停提示（按钮已在语义分组里、提示会重复时） */
    withTooltip?: boolean;
}

// 纯图标按钮的唯一入口：label 必填，从类型层面杜绝"图标按钮没有任何可访问名"。
const IconButton: React.FC<IconButtonProps> = ({icon, label, withTooltip = true, ...rest}) => {
    const button = <Button {...rest} icon={icon} aria-label={label} title={withTooltip ? undefined : label} />;
    return withTooltip ? <Tooltip title={label}>{button}</Tooltip> : button;
};

export default IconButton;
