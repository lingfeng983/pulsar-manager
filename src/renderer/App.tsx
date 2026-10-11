import React from 'react';
import {ConfigProvider, theme as antTheme} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import {applyTheme, loadPersistedTheme, useThemeStore} from './store/theme';
import {loadAppSettings} from './store/settings';
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

const App: React.FC = () => {
    const {theme} = useThemeStore();

    // 根据主题设置 Ant Design 暗色模式
    const isDark = theme === 'dark';

    return (
        <ConfigProvider
            locale={zhCN}
            theme={{
                algorithm: isDark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
                token: {
                    colorPrimary: getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim(),
                    borderRadius: 4,
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
