import {useCallback, useMemo, useState} from 'react';
import type {TableColumnsType} from 'antd';
import type {ResizeCallbackData} from 'react-resizable';
import ResizableTitle from '../components/common/ResizableTitle';

// 让一张表的列都能拖宽。列定义本身不变，只是在渲染前把拖出来的宽度盖上去，
// 再告诉 Table 用可拖拽的表头单元格。宽度只活在组件状态里：刷新页面回到定义值，
// 比落库合理——列宽是此刻看图的心情，不是配置。

/** 无宽度的列（比如"正文"那种吃剩余空间的）给一个可拖的起点 */
const DEFAULT_WIDTH = 200;

type AnyColumn<T> = TableColumnsType<T>[number];

function columnKey<T>(column: AnyColumn<T>, index: number): string {
    if (column.key !== undefined && column.key !== null) {
        return String(column.key);
    }
    const dataIndex = (column as {dataIndex?: unknown}).dataIndex;
    if (typeof dataIndex === 'string') {
        return dataIndex;
    }
    return `column-${index}`;
}

export function useResizableColumns<T>(columns: TableColumnsType<T>) {
    const [widths, setWidths] = useState<Record<string, number>>({});

    const handleResize = useCallback((key: string, {size}: ResizeCallbackData) => {
        setWidths(current => ({...current, [key]: Math.round(size.width)}));
    }, []);

    const resizableColumns = useMemo(
        () =>
            columns.map((column, index) => {
                const key = columnKey(column, index);
                const width = widths[key] ?? (typeof column.width === 'number' ? column.width : DEFAULT_WIDTH);
                // antd 把 onHeaderCell 的返回值限定成 HTMLAttributes，塞不进自定义的
                // onResize（它撞上了 React 的同名事件），所以这里按声明处放开、
                // 在 ResizableTitle 那一侧收回真实类型。
                const headerCell = {
                    width,
                    onResize: (_event: unknown, data: ResizeCallbackData) => handleResize(key, data),
                };
                return {...column, width, onHeaderCell: () => headerCell} as unknown as AnyColumn<T>;
            }),
        [columns, widths, handleResize],
    );

    const components = useMemo(() => ({header: {cell: ResizableTitle}}), []);

    return {resizableColumns, components};
}

export default useResizableColumns;
