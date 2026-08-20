import {registerClusterHandlers} from './cluster-handlers';
import {registerResourceHandlers} from './resource-handlers';
import {registerMessageHandlers} from './message-handlers';
import {registerMetricsHandlers} from './metrics-handlers';
import {registerSystemHandlers} from './system-handlers';
import {ensureDbInitialized, cleanupDatabase} from './_shared';

// Re-export cleanupDatabase for external consumers
export {cleanupDatabase};

// 注册所有 IPC handlers
export function registerIPCHandlers() {
    // 确保数据库已初始化
    ensureDbInitialized();

    registerClusterHandlers();
    registerResourceHandlers();
    registerMessageHandlers();
    registerMetricsHandlers();
    registerSystemHandlers();
}
