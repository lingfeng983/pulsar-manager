import {useMemo} from 'react';
import type {FontSizeLevel} from '../types';
import {useSettingsStore} from '../store/settings';

/**
 * 全局字号档位（DOM 侧）。
 *
 * DOM 文字的尺寸在 index.css 的 --font-size-*（四档取值必须与这里一致）；
 * antd 组件的文字另有基准，见 ANTD_FONT_BASE_PX（compact 算法会覆盖 fontSize token，
 * 直接把这里的值写进 ConfigProvider 是不生效的）；ECharts 的文字画在 canvas 上，
 * 两者都管不到，只能把 fontFactor 乘进图表 option 里的字号。
 */
export const FONT_BASE_PX: Record<FontSizeLevel, number> = {
    small: 12,
    medium: 13,
    large: 14,
    xlarge: 15,
};

export const FONT_SIZE_OPTIONS: {value: FontSizeLevel; label: string}[] = [
    {value: 'small', label: '小'},
    {value: 'medium', label: '中'},
    {value: 'large', label: '大'},
    {value: 'xlarge', label: '特大'},
];

/** 相对默认档（large）的比例：图表按它换算像素字号与气泡直径。 */
export function fontFactor(level: FontSizeLevel): number {
    // 下限 0.92：canvas 里的刻度标签没有 CSS 兜底，10px 的坐标轴数字在图表里等于读不出。
    // 缩放可以收，收到看不清就没有意义了。
    return Math.max(0.92, FONT_BASE_PX[level] / FONT_BASE_PX.large);
}

/**
 * antd 组件文字在本档下的基准字号。
 *
 * compactAlgorithm 把基准字号取成它算出的 fontSizeSM（各档都是 12px），而 ConfigProvider 的
 * fontSize 只是喂给算法的种子、会被这一步覆盖掉，所以档位对表格、按钮、页签一直是无效的。
 * 大档维持多年来的 12px 不变（默认观感不变）；**下限也压在 12px**——"小"档原来是 10px，
 * 中文在 10px 已经糊了，那点密度是用读不清换来的。控件尺寸的缩放另见 antdDensityFactor。
 */
export const ANTD_FONT_BASE_PX: Record<FontSizeLevel, number> = {
    small: 12,
    medium: 12,
    large: 12,
    xlarge: 14,
};

/**
 * antd 组件尺寸（控件高度、内边距）的密度基准，与上面的字号基准解耦。
 *
 * 两者以前共用一个比例，于是"把界面调小"会把文字和控件一起压扁。现在小档照样收紧
 * 行高与内边距（0.83 倍），字号止步于 12px：密度和可读性各走各的。
 */
export const ANTD_DENSITY_BASE_PX: Record<FontSizeLevel, number> = {
    small: 10,
    medium: 11,
    large: 12,
    xlarge: 14,
};

/** 控件尺寸跟着字号档位缩放的比例（large = 1）。 */
export function antdDensityFactor(level: FontSizeLevel): number {
    return ANTD_DENSITY_BASE_PX[level] / ANTD_DENSITY_BASE_PX.large;
}

/**
 * 按 antd 自己的字号阶梯（以基准为锚点按 e^((i-1)/5) 扩散、向下取偶、基准位保持不变）
 * 反推整族字号与行高，供 compact 之后那层算法覆盖用。
 * 只改 fontSize 一个 token 会让 fontSizeSM、行高、控件文字高度继续停在旧基准上。
 */
export function antdFontTokens(base: number) {
    const sizes = Array.from({length: 10}, (_, index) => {
        if (index === 1) return base;
        const raw = base * Math.exp((index - 1) / 5);
        const rounded = index > 1 ? Math.floor(raw) : Math.ceil(raw);
        return Math.floor(rounded / 2) * 2;
    });
    const heights = sizes.map(size => (size + 8) / size);
    return {
        fontSizeSM: sizes[0],
        fontSize: sizes[1],
        fontSizeLG: sizes[2],
        fontSizeXL: sizes[3],
        fontSizeHeading5: sizes[2],
        fontSizeHeading4: sizes[3],
        fontSizeHeading3: sizes[4],
        fontSizeHeading2: sizes[5],
        fontSizeHeading1: sizes[6],
        lineHeightSM: heights[0],
        lineHeight: heights[1],
        lineHeightLG: heights[2],
        lineHeightHeading5: heights[2],
        lineHeightHeading4: heights[3],
        lineHeightHeading3: heights[4],
        lineHeightHeading2: heights[5],
        lineHeightHeading1: heights[6],
        fontHeightSM: Math.round(heights[0] * sizes[0]),
        fontHeight: Math.round(heights[1] * sizes[1]),
        fontHeightLG: Math.round(heights[2] * sizes[2]),
    };
}

/** 档位变了要重画：订阅设置，返回当前缩放比例。 */
export function useFontFactor(): number {
    const level = useSettingsStore(state => state.settings.fontSize);
    return useMemo(() => fontFactor(level), [level]);
}
