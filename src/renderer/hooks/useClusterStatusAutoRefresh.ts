import {useEffect} from 'react';
import {useClusterStore} from '../store/cluster';
import {useSettingsStore} from '../store/settings';

// 首页表格与侧边栏色点共用 cluster store 里的 clusters，状态一轮探活两处同时更新，
// 所以定时器挂在 Layout（常驻，与首页页签是否打开无关）。挂载即探一次，
// store 的 refreshClusterStatus 自带 in-flight 去重，StrictMode 双挂载也只打一轮 broker。
export function useClusterStatusAutoRefresh(): void {
    const statusRefreshSeconds = useSettingsStore(state => state.settings.statusRefreshSeconds);
    const refreshClusterStatus = useClusterStore(state => state.refreshClusterStatus);

    useEffect(() => {
        void refreshClusterStatus();
    }, [refreshClusterStatus]);

    useEffect(() => {
        if (statusRefreshSeconds <= 0) {
            return;
        }
        // 窗口在后台时停表：用户看不到的东西不该每 N 秒敲一次 broker，回来那一刻也不会
        // 和恢复时的补探挤成一批并发。回到前台先补一次，看到的第一眼不是几分钟前的状态。
        let timer: ReturnType<typeof setInterval> | null = null;
        const start = () => {
            if (timer === null) {
                timer = setInterval(() => void refreshClusterStatus(), statusRefreshSeconds * 1000);
            }
        };
        const stop = () => {
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
        };
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') {
                stop();
                return;
            }
            void refreshClusterStatus();
            start();
        };

        if (document.visibilityState !== 'hidden') {
            start();
        }
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            stop();
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [statusRefreshSeconds, refreshClusterStatus]);
}
