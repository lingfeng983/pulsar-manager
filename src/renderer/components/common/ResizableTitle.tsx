import React from 'react';
import {Resizable} from 'react-resizable';
import type {ResizeCallbackData} from 'react-resizable';

// 表头单元格的可拖拽版本，给 antd Table 的 components.header.cell 用。
// 拖拽把手用东向那一条而不是包默认的东南角：表头只有高度方向的边缘有意义，
// 角上的把手会压在排序图标上，点下去到底是排序还是拖宽说不清。

export interface ResizableTitleProps extends Omit<React.HTMLAttributes<HTMLTableCellElement>, 'onResize'> {
    onResize?: (event: unknown, data: ResizeCallbackData) => void;
    width?: number;
}

const ResizableTitle: React.FC<ResizableTitleProps> = ({onResize, width, className, ...restProps}) => {
    if (!width || !onResize) {
        // 没有宽度的列交回原生 th：Resizable 要求 width 是数字，
        // 传 undefined 进去它按 0 处理，列会被压成一条线。
        return <th className={className} {...restProps} />;
    }
    return (
        <Resizable
            width={width}
            height={0}
            axis="x"
            minConstraints={[60, 0]}
            maxConstraints={[900, 0]}
            onResize={onResize}
            // Resizable 是 cloneElement 把 className 写回子元素，而且是覆盖不是合并，
            // 所以 antd 自己的 .ant-table-cell 必须从这里递进去，否则表头样式全丢。
            className={className}
            handle={(handleAxis, ref) => (
                <span ref={ref} className={`react-resizable-handle react-resizable-handle-${handleAxis}`} />
            )}
        >
            <th {...restProps} style={{...restProps.style, width}} />
        </Resizable>
    );
};

export default ResizableTitle;
