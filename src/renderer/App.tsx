import React, {useEffect} from 'react';
import {ConfigProvider, notification, theme as antTheme} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import {applyTheme, loadPersistedTheme, useThemeStore} from './store/theme';
import {loadAppSettings, useSettingsStore} from './store/settings';
import {ANTD_FONT_BASE_PX, antdDensityFactor, antdFontTokens} from './utils/fontScale';
import {loadPlugins} from './store/plugins';
import {startAlertRuntime} from './store/alerts';
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
// 告警推送的订阅要早于任何页面挂载：立案可能发生在窗口收进托盘的时候。
startAlertRuntime();

// 启动期告警只提示一次：StrictMode 下 effect 会跑两遍，模块级标记比 useRef 更稳。
let runtimeWarningShown = false;

/**
 * 读取后台攒下的启动期非致命问题并提示。
 *
 * 最典型的是凭据密钥被迫轮换：旧密钥解不开，已存集群的认证参数与通知渠道密钥全部失效。
 * 后台不能因此拒绝启动，但也不能一声不吭——用户会以为"昨天还好好的，今天所有集群都连不上"。
 * 只在启动时读一次，失败也不打扰用户（这类诊断信息不该盖住真正的业务错误）。
 */
function useRuntimeWarnings(): void {
    useEffect(() => {
        if (runtimeWarningShown) {
            return;
        }
        runtimeWarningShown = true;
        // 非 Tauri 外壳（纯浏览器调试）下桥接没装上，这里什么都不用做。
        if (!window.electronAPI?.system) {
            return;
        }
        void window.electronAPI.system.runtimeWarnings().then(response => {
            if (!response.success) {
                console.warn('读取启动期告警失败：', response.error);
                return;
            }
            const warning = response.data?.warning;
            if (!warning) {
                return;
            }
            // 不自动消失：这条提示说明"凭据需要重新填"，用户没看到就等于没提示。
            notification.warning({
                message: '启动检查发现问题',
                description: warning,
                duration: 0,
                placement: 'topRight',
            });
        });
    }, []);
}

// 紧凑档基准：以 large 字号档的 antd 基准文字（12px）为 1 倍，控件高度与内边距按字号档位同比缩放，
// 否则切到"小"字号后仍然是原来那套 32px 高的按钮，视觉上只小了字没小了面。
// 注意这里乘的是**密度**因子而不是字号因子：字号已经有 12px 下限，控件尺寸照旧收。
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
    useRuntimeWarnings();

    // 根据主题设置 Ant Design 暗色模式
    const isDark = theme === 'dark';
    const d = (value: number) => Math.round(value * antdDensityFactor(fontSizeLevel));

    // compactAlgorithm 在派生阶段把基准字号取成它自己算出的 fontSizeSM（各档都是 12px），
    // 而 ConfigProvider 的 fontSize 只是喂给算法的种子，会被这一步整个覆盖掉，
    // 所以字号档位过去只作用得到 DOM 文字、表格与按钮永远是一号。这里在它之后再套一层，
    // 按当前档位把整族字号与行高补回去（大档补回的就是原来的 12px，默认观感不变）。
    const compactWithFont: typeof antTheme.compactAlgorithm = (seed, derived) => ({
        ...antTheme.compactAlgorithm(seed, derived),
        ...antdFontTokens(ANTD_FONT_BASE_PX[fontSizeLevel]),
    });

    return (
        <ConfigProvider
            locale={zhCN}
            theme={{
                // compactAlgorithm 一次性下调 padding/margin 系列派生 token，
                // 组件里再显式覆盖少数几处对版面影响最大的尺寸。
                algorithm: isDark
                    ? [antTheme.darkAlgorithm, compactWithFont]
                    : [antTheme.defaultAlgorithm, compactWithFont],
                token: {
                    colorPrimary: getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim(),
                    borderRadius: 4,
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
