import {useMemo} from 'react';
import type {FontSizeLevel} from '../types';
import {useSettingsStore} from '../store/settings';

/**
 * 全局字号档位。
 *
 * DOM 文字的尺寸在 index.css 的 --font-size-*（三档取值必须与这里一致）；
 * antd 组件走 ConfigProvider 的 fontSize token；ECharts 的文字是画在 canvas 上的，
 * 两者都管不到，只能把 fontFactor 乘进图表 option 里的字号。
 */
export const FONT_BASE_PX: Record<FontSizeLevel, number> = {
    small: 12,
    medium: 13,
    large: 14,
};

export const FONT_SIZE_OPTIONS: {value: FontSizeLevel; label: string}[] = [
    {value: 'small', label: '小'},
    {value: 'medium', label: '中'},
    {value: 'large', label: '大'},
];

/** 相对默认档（large）的比例：图表按它换算像素字号与气泡直径。 */
export function fontFactor(level: FontSizeLevel): number {
    return FONT_BASE_PX[level] / FONT_BASE_PX.large;
}

/** 档位变了要重画：订阅设置，返回当前缩放比例。 */
export function useFontFactor(): number {
    const level = useSettingsStore(state => state.settings.fontSize);
    return useMemo(() => fontFactor(level), [level]);
}
