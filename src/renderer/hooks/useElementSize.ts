import {useEffect, useState} from 'react';

/**
 * 测量元素自身的宽高（整数像素）。
 *
 * ECharts / zrender 会把初始化时量到的高度以行内 style 写回容器，之后再靠
 * `height: 100%` 或 flex 撑开的空间它读不到（行内像素值已经把盒子钉住了），
 * 于是首屏布局没稳定时就会永久停在 100px / 300px。这里把外部容器量出来，
 * 反过来用像素值喂给图表容器，尺寸变化由 ResizeObserver 驱动。
 *
 * 观察器必须挂在 effect 里而不是 ref 回调里：StrictMode 会在挂载后立刻把 effect
 * 走一遍 setup→cleanup→setup，如果观察器是 ref 回调建的，cleanup 一断就再也接不上，
 * 首屏量到的尺寸就成了永久值（表现为窗口变化时图表不跟着缩放）。
 */
export function useElementSize<T extends HTMLElement>(): {
    ref: (node: T | null) => void;
    width: number;
    height: number;
} {
    const [node, setNode] = useState<T | null>(null);
    const [size, setSize] = useState({width: 0, height: 0});

    useEffect(() => {
        if (!node) {
            return;
        }
        const apply = () => {
            const rect = node.getBoundingClientRect();
            const next = {width: Math.floor(rect.width), height: Math.floor(rect.height)};
            setSize(current => (current.width === next.width && current.height === next.height ? current : next));
        };
        const observer = new ResizeObserver(apply);
        observer.observe(node);
        apply();
        return () => observer.disconnect();
    }, [node]);

    return {ref: setNode, width: size.width, height: size.height};
}
