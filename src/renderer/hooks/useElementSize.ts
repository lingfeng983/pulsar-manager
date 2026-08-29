import {useCallback, useEffect, useRef, useState} from 'react';

/**
 * 测量元素自身的宽高（整数像素）。
 *
 * ECharts / zrender 会把初始化时量到的高度以行内 style 写回容器，之后再靠
 * `height: 100%` 或 flex 撑开的空间它读不到（行内像素值已经把盒子钉住了），
 * 于是首屏布局没稳定时就会永久停在 100px / 300px。这里把外部容器量出来，
 * 反过来用像素值喂给图表容器，尺寸变化由 ResizeObserver 驱动。
 */
export function useElementSize<T extends HTMLElement>(): {
    ref: (node: T | null) => void;
    width: number;
    height: number;
} {
    const [size, setSize] = useState({width: 0, height: 0});
    const observerRef = useRef<ResizeObserver | null>(null);
    const nodeRef = useRef<T | null>(null);

    const setNode = useCallback((node: T | null) => {
        observerRef.current?.disconnect();
        nodeRef.current = node;
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
        observerRef.current = observer;
        apply();
    }, []);

    useEffect(
        () => () => {
            observerRef.current?.disconnect();
        },
        [],
    );

    return {ref: setNode, width: size.width, height: size.height};
}
