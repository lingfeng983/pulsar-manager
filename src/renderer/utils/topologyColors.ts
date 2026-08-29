import {useMemo} from 'react';
import {useThemeStore} from '../store/theme';

/**
 * 拓扑图与图例共用的配色。以前是一组硬编码常量，两处拓扑图各抄一遍，
 * 结果亮色/暗色/护眼三套主题下节点颜色始终停在同一批色值上，
 * 暗色主题里灰标签和灰连线几乎看不见。现在运行时从 CSS 变量读取。
 */
export interface TopologyPalette {
    primary: string;
    success: string;
    warning: string;
    danger: string;
    /** 连线 */
    edge: string;
    /** 节点标签 */
    label: string;
    /** tooltip / 强调文字 */
    text: string;
    /** tooltip 背景 */
    surface: string;
    border: string;
}

// getComputedStyle 拿不到变量时的兜底值，取亮色主题的一套。
const FALLBACK: TopologyPalette = {
    primary: '#1677FF',
    success: '#00B42A',
    warning: '#FF7D00',
    danger: '#F53F3F',
    edge: '#86909C',
    label: '#86909C',
    text: '#1D2129',
    surface: '#FFFFFF',
    border: '#E5E6EB',
};

export function readTopologyPalette(): TopologyPalette {
    if (typeof window === 'undefined') {
        return FALLBACK;
    }
    const styles = getComputedStyle(document.documentElement);
    const read = (name: keyof TopologyPalette, cssVar: string): string =>
        styles.getPropertyValue(cssVar).trim() || FALLBACK[name];

    return {
        primary: read('primary', '--color-primary'),
        success: read('success', '--color-success'),
        warning: read('warning', '--color-warning'),
        danger: read('danger', '--color-danger'),
        edge: read('edge', '--color-info'),
        label: read('label', '--color-text-secondary'),
        text: read('text', '--color-text-primary'),
        surface: read('surface', '--color-bg-elevated'),
        border: read('border', '--color-border'),
    };
}

/** 随主题切换重新取色：theme 变了必须重算，否则 ECharts option 里还是旧色值。 */
export function useTopologyPalette(): TopologyPalette {
    const theme = useThemeStore(state => state.theme);
    // CSS 变量不是 React 状态，只能靠主题变化触发重算，所以 theme 是刻意的依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return useMemo(() => readTopologyPalette(), [theme]);
}
