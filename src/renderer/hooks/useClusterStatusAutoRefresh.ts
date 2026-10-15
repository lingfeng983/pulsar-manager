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
        const timer = setInterval(() => void refreshClusterStatus(), statusRefreshSeconds * 1000);
        return () => clearInterval(timer);
    }, [statusRefreshSeconds, refreshClusterStatus]);
}
