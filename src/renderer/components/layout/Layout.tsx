import React, {useEffect} from 'react';
import TopNav from './TopNav';
import ResourceTree from './ResourceTree';
import TabWorkspace from './TabWorkspace';
import {useKeybindings, useCommand} from '../../hooks/useKeybindings';
import {useClusterStatusAutoRefresh} from '../../hooks/useClusterStatusAutoRefresh';
import {useThemeStore, type ThemeType} from '../../store/theme';
import {useSettingsStore} from '../../store/settings';
import {useUpdateStore} from '../../store/update';
import {useTabStore} from '../../store/tabs';
import {useShortcutStore} from '../../store/shortcuts';

const THEME_CYCLE: ThemeType[] = ['light', 'dark', 'eyeCare'];
/** 启动后延迟多久做第一次静默检查：别和首屏的集群探活、文档加载抢带宽 */
const UPDATE_CHECK_DELAY_MS = 8000;
/** 之后每 6 小时一次。匿名 API 每小时 60 次，这个节奏一个进程一天只花 4 次。 */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const Layout: React.FC = () => {
    const load = useShortcutStore(state => state.load);
    const addTab = useTabStore(state => state.addTab);
    const theme = useThemeStore(state => state.theme);
    const setTheme = useThemeStore(state => state.setTheme);
    const autoCheckUpdate = useSettingsStore(state => state.settings.updateAutoCheck);
    const checkUpdate = useUpdateStore(state => state.check);

    useClusterStatusAutoRefresh();

    useEffect(() => {
        void load();
    }, [load]);

    // 静默检查更新：只在顶栏标点，不弹窗。设置关掉就一个定时器都不挂。
    // 放在 Layout 而不是 App：设置是异步读库的，挂在这里能跟着 updateAutoCheck 的
    // 变化重新决定要不要起定时器（首帧默认 true，读到 false 时会清掉）。
    useEffect(() => {
        if (!autoCheckUpdate) {
            return;
        }
        const timer = window.setTimeout(() => void checkUpdate({silent: true}), UPDATE_CHECK_DELAY_MS);
        const interval = window.setInterval(() => void checkUpdate({silent: true}), UPDATE_CHECK_INTERVAL_MS);
        return () => {
            window.clearTimeout(timer);
            window.clearInterval(interval);
        };
    }, [autoCheckUpdate, checkUpdate]);

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
