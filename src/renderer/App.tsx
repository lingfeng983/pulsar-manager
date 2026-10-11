import React from 'react';
import {ConfigProvider, theme as antTheme} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import {applyTheme, loadPersistedTheme, useThemeStore} from './store/theme';
import {loadAppSettings, useSettingsStore} from './store/settings';
import {FONT_BASE_PX, fontFactor} from './utils/fontScale';
import {loadPlugins} from './store/plugins';
import Layout from './components/layout/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import {DangerConfirmHost} from './components/common/dangerConfirm';

// 首屏渲染前就要有属性：子组件在 render 阶段读 CSS 变量取色，父组件的 effect 一定晚于它们。
// 主题走 localStorage 同步副本（store 初始化时已读入），不用等主进程那次异步 IPC。
applyTheme(useThemeStore.getState().theme);
loadPersistedTheme();
// 截断长度、刷新间隔这些设置在消费它们的页面挂载前就取一次，避免先按默认值闪一下
loadAppSettings();
loadPlugins();

// 紧凑档基准：以 large 字号档（14px）为 1 倍，控件高度与内边距按字号档位同比缩放，
// 否则切到"小"字号后仍然是原来那套 32px 高的按钮，视觉上只小了字没小了面。
const DENSITY = {
    controlHeight: 28,
    controlHeightSM: 22,
    controlHeightLG: 34,
    cardPadding: 12,
    cardHeaderHeight: 34,
    tabCardHeight: 26,
    alertPadding: 4,
    statisticTitle: 12,
    statisticContent: 20,
    treeTitleHeight: 22,
    treeIndent: 14,
    formItemMargin: 12,
    descItemPadding: 8,
};

const App: React.FC = () => {
    const {theme} = useThemeStore();
    const fontSizeLevel = useSettingsStore(state => state.settings.fontSize);

    // 根据主题设置 Ant Design 暗色模式
    const isDark = theme === 'dark';
    const d = (value: number) => Math.round(value * fontFactor(fontSizeLevel));

    return (
        <ConfigProvider
            locale={zhCN}
            theme={{
                // compactAlgorithm 一次性下调 padding/margin 系列派生 token，
                // 组件里再显式覆盖少数几处对版面影响最大的尺寸。
                algorithm: isDark
                    ? [antTheme.darkAlgorithm, antTheme.compactAlgorithm]
                    : [antTheme.defaultAlgorithm, antTheme.compactAlgorithm],
                token: {
                    colorPrimary: getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim(),
                    borderRadius: 4,
                    // 字号档位：DOM 文字走 CSS 变量，antd 组件（表格、按钮、正文）走这个 token
                    fontSize: FONT_BASE_PX[fontSizeLevel],
                    controlHeight: d(DENSITY.controlHeight),
                    controlHeightSM: d(DENSITY.controlHeightSM),
                    controlHeightLG: d(DENSITY.controlHeightLG),
                },
                components: {
                    Card: {
                        bodyPadding: d(DENSITY.cardPadding),
                        headerPadding: d(DENSITY.cardPadding),
                        headerHeight: d(DENSITY.cardHeaderHeight),
                        bodyPaddingSM: d(8),
                        headerPaddingSM: d(8),
                        headerHeightSM: d(28),
                        tabsMarginBottom: 0,
                    },
                    Table: {
                        cellPaddingBlockMD: d(7),
                        cellPaddingInlineMD: d(8),
                        cellPaddingBlockSM: d(5),
                        cellPaddingInlineSM: d(8),
                    },
                    Tabs: {
                        cardHeight: d(DENSITY.tabCardHeight),
                        cardPadding: `${d(3)}px ${d(10)}px`,
                        cardGutter: d(2),
                    },
                    Alert: {
                        defaultPadding: `${d(DENSITY.alertPadding)}px ${d(8)}px`,
                        withDescriptionPadding: `${d(6)}px ${d(8)}px`,
                        withDescriptionIconSize: d(14),
                    },
                    Statistic: {
                        titleFontSize: d(DENSITY.statisticTitle),
                        contentFontSize: d(DENSITY.statisticContent),
                    },
                    Tree: {
                        titleHeight: d(DENSITY.treeTitleHeight),
                        indentSize: d(DENSITY.treeIndent),
                    },
                    Form: {itemMarginBottom: d(DENSITY.formItemMargin)},
                    Descriptions: {
                        itemPaddingBottom: d(DENSITY.descItemPadding),
                        titleMarginBottom: d(DENSITY.descItemPadding),
                    },
                },
            }}
        >
            <ErrorBoundary>
                <DangerConfirmHost />
                <Layout />
            </ErrorBoundary>
        </ConfigProvider>
    );
};

export default App;
