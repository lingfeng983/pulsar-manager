import {useEffect, useState} from 'react';

/**
 * 大表格按需滚动虚拟化。
 *
 * 为什么不是「无脑全表虚拟化」：开了虚拟之后 antd 会给表体套一个**内部滚动区**，
 * 行数很少时这个滚动区本身就是一个看得见的差异（表头与最后一行之间留出空槽、
 * 竖向滚动条凭空出现）。所以只有行数超过 `VIRTUAL_ROW_LIMIT` 才换模式，
 * 日常几十条的列表与原来逐像素一致。
 *
 * 为什么不能拿容器自己的高度当 `scroll.y`：一旦表体变成定高，容器高度也就
 * 等于这个值，下一次测量又把它读成可用空间……两个值互相追，最后会缩到最小值。
 * 所以这里只用容器的**上边缘**算「到视口底还有多少」，高度由视口决定，
 * 与表格内容无关。
 */

export const VIRTUAL_ROW_LIMIT = 200;

/** 再矮就没法读了：低于这个高度宁可让页面滚动 */
const MIN_HEIGHT = 320;
/** 也不让表格高过视口的这一部分，否则工具栏滚出屏幕就回不来了 */
const MAX_RATIO = 0.78;
/** 底部留白：贴着视口底边很容易被认为「还没到底」 */
const BOTTOM_GAP = 16;

export interface VirtualBox {
    /** 挂在表格外层容器上，只为了量上边缘 */
    ref: (node: HTMLElement | null) => void;
    virtual: boolean;
    scroll: {x: string; y?: number};
}

export function useVirtualTable(rowCount: number): VirtualBox {
    const [node, setNode] = useState<HTMLElement | null>(null);
    const [height, setHeight] = useState(0);

    useEffect(() => {
        if (!node) {
            return;
        }
        const measure = () => {
            const top = Math.max(node.getBoundingClientRect().top, 0);
            const ceiling = window.innerHeight * MAX_RATIO;
            const next = Math.round(Math.min(Math.max(window.innerHeight - top - BOTTOM_GAP, MIN_HEIGHT), ceiling));
            setHeight(current => (current === next ? current : next));
        };
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [node]);

    const virtual = rowCount > VIRTUAL_ROW_LIMIT;
    return {
        ref: setNode,
        virtual,
        scroll: virtual ? {x: 'max-content', y: height} : {x: 'max-content'},
    };
}
