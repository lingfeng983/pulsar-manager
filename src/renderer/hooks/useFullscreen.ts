import {useCallback, useEffect, useRef, useState} from 'react';

// 全屏切换 hook：托管目标元素的 requestFullscreen / exitFullscreen，
// 并以 fullscreenchange 事件为唯一状态来源（含 webkit 前缀回退）。
// onChange 可用于全屏状态变化后重新 resize 图表等副作用。
export function useFullscreen<T extends HTMLElement = HTMLDivElement>(onChange?: (fullscreen: boolean) => void) {
    const ref = useRef<T>(null);
    const [isFullscreen, setIsFullscreen] = useState(false);

    const toggle = useCallback(() => {
        const el = ref.current;
        if (!el) {
            return;
        }

        // 必须比较是不是"自己"在独占全屏：页面上别的元素（例如图表卡片自带的按钮）
        // 进入全屏后，document.fullscreenElement 非空，这里若不比对就会去 exit 掉别人的全屏。
        // requestFullscreen 可能拒绝（浏览器策略/权限），返回的 Promise 必须收掉，
        // 否则每次失败都会冒一个 unhandled rejection。
        const settle = (result: unknown) => {
            if (result instanceof Promise) {
                result.catch(() => {});
            }
        };
        if (document.fullscreenElement !== el) {
            const request = el.requestFullscreen || (el as any).webkitRequestFullscreen;
            settle(request?.call(el));
        } else {
            const exit = document.exitFullscreen || (document as any).webkitExitFullscreen;
            settle(exit?.call(document));
        }
    }, []);

    useEffect(() => {
        const handleChange = () => {
            // 同样只认自己：别人全屏时本组件应保持 false，而不是跟着亮起全屏图标。
            const active = !!ref.current && document.fullscreenElement === ref.current;
            setIsFullscreen(active);
            onChange?.(active);
        };

        document.addEventListener('fullscreenchange', handleChange);
        document.addEventListener('webkitfullscreenchange', handleChange);

        return () => {
            document.removeEventListener('fullscreenchange', handleChange);
            document.removeEventListener('webkitfullscreenchange', handleChange);
        };
    }, [onChange]);

    return {ref, isFullscreen, toggle};
}
