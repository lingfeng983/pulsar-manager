import React, {type CSSProperties, type ReactNode, type Ref} from 'react';

interface PageShellProps {
    title: ReactNode;
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
const PageShell: React.FC<PageShellProps> = ({title, subtitle, actions, className, style, rootRef, children}) => (
    <div ref={rootRef} className={className ? `page-shell ${className}` : 'page-shell'} style={style}>
        <div className="page-header">
            <div className="page-heading">
                <span className="page-title">{title}</span>
                {subtitle ? <span className="page-subtitle">{subtitle}</span> : null}
            </div>
            {actions ? <div className="page-actions">{actions}</div> : null}
        </div>
        <div className="page-body">{children}</div>
    </div>
);

export default PageShell;
