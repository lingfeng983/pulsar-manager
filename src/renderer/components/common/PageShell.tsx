import React, {type CSSProperties, type ReactNode, type Ref} from 'react';

interface PageShellProps {
    /** 页签标题里已经写了页面名，页内不再重复；只有需要额外上下文才传（如 Topic 详情） */
    title?: ReactNode;
    subtitle?: ReactNode;
    actions?: ReactNode;
    className?: string;
    style?: CSSProperties;
    /** 需要拿到页面根节点的场景（如全屏容器）用它，不再自己套一层 div */
    rootRef?: Ref<HTMLDivElement>;
    children: ReactNode;
}

// 页面骨架：统一 16px 内容区内边距、20px/600 标题基线、右对齐操作区。
// 所有区块间距由 .page-body 的 gap 提供，页面不再各写 margin。
const PageShell: React.FC<PageShellProps> = ({title, subtitle, actions, className, style, rootRef, children}) => {
    const heading =
        title || subtitle ? (
            <div className="page-heading">
                {title ? <span className="page-title">{title}</span> : null}
                {subtitle ? <span className="page-subtitle">{subtitle}</span> : null}
            </div>
        ) : null;

    return (
        <div ref={rootRef} className={className ? `page-shell ${className}` : 'page-shell'} style={style}>
            {heading || actions ? (
                <div className="page-header">
                    {heading}
                    {actions ? <div className="page-actions">{actions}</div> : null}
                </div>
            ) : null}
            <div className="page-body">{children}</div>
        </div>
    );
};

export default PageShell;
