import {registerClusterHandlers} from './cluster-handlers';
import {registerResourceHandlers} from './resource-handlers';
import {registerMessageHandlers} from './message-handlers';
import {registerMetricsHandlers} from './metrics-handlers';
import {registerLoadTestHandlers} from './load-test-handlers';
import {registerConfigHandlers} from './config-handlers';
import {registerPluginHandlers} from './plugin-handlers';
import {registerSystemHandlers} from './system-handlers';
import {registerUpdateHandlers} from './update-handlers';
import {ensureDbInitialized, cleanupDatabase} from './_shared';
import {cleanupOrphanSshTunnels} from '../database/sqlite';
import {createLogger} from '../utils/logger';

const log = createLogger('IPC');

// Re-export cleanupDatabase for external consumers
export {cleanupDatabase};

// 注册所有 IPC handlers
export function registerIPCHandlers() {
    // 确保数据库已初始化
    ensureDbInitialized();

    // 集群表单每点一次「测试 SSH 隧道」就落一条隧道配置（含加密的口令/私钥），
    // 用户随后取消弹窗就留下没人引用的孤儿行；应用没有 SSH 配置管理界面，
    // 启动时按集群引用清理一次。
    const orphans = cleanupOrphanSshTunnels();
    if (orphans > 0) {
        log.info(`Removed ${orphans} orphan SSH tunnel config(s)`);
    }

    registerClusterHandlers();
    registerResourceHandlers();
    registerMessageHandlers();
    registerMetricsHandlers();
    registerLoadTestHandlers();
    registerConfigHandlers();
    registerPluginHandlers();
    registerSystemHandlers();
    registerUpdateHandlers();
}
