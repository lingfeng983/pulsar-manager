import React from 'react';
import {ConfigProvider, theme as antTheme} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import {applyTheme, loadPersistedTheme, useThemeStore} from './store/theme';
import {loadAppSettings} from './store/settings';
import {loadPlugins} from './store/plugins';
import Layout from './components/layout/Layout';

// 首屏渲染前就要有属性：子组件在 render 阶段读 CSS 变量取色，父组件的 effect 一定晚于它们。
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
            <Layout />
        </ConfigProvider>
    );
};

export default App;
