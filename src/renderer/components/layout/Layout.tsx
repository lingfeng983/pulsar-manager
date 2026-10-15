import React, {useEffect} from 'react';
import TopNav from './TopNav';
import ResourceTree from './ResourceTree';
import TabWorkspace from './TabWorkspace';
import {useKeybindings, useCommand} from '../../hooks/useKeybindings';
import {useClusterStatusAutoRefresh} from '../../hooks/useClusterStatusAutoRefresh';
import {useThemeStore, type ThemeType} from '../../store/theme';
import {useTabStore} from '../../store/tabs';
import {useShortcutStore} from '../../store/shortcuts';

const THEME_CYCLE: ThemeType[] = ['light', 'dark', 'eyeCare'];

const Layout: React.FC = () => {
    const load = useShortcutStore(state => state.load);
    const addTab = useTabStore(state => state.addTab);
    const theme = useThemeStore(state => state.theme);
    const setTheme = useThemeStore(state => state.setTheme);

    useClusterStatusAutoRefresh();

    useEffect(() => {
        void load();
    }, [load]);

    useKeybindings();

    useCommand('toggleTheme', () => {
        const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length];
        setTheme(next);
    });

    useCommand('openShortcutConfig', () => {
        addTab({id: 'shortcuts', title: '快捷键配置', type: 'shortcuts'});
    });

    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100vh',
                width: '100vw',
                overflow: 'hidden',
            }}
        >
            {/* 顶部导航栏 */}
            <TopNav />

            {/* 主体区域 */}
            <div
                style={{
                    display: 'flex',
                    flex: 1,
                    overflow: 'hidden',
                }}
            >
                {/* 左侧资源树 */}
                <ResourceTree />

                {/* 中间 Tab 工作区 */}
                <TabWorkspace />
            </div>
        </div>
    );
};

export default Layout;
