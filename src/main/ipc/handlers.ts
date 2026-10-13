import {registerClusterHandlers} from './cluster-handlers';
import {registerResourceHandlers} from './resource-handlers';
import {registerMessageHandlers} from './message-handlers';
import {registerMetricsHandlers} from './metrics-handlers';
import {registerLoadTestHandlers} from './load-test-handlers';
import {registerConfigHandlers} from './config-handlers';
import {registerPluginHandlers} from './plugin-handlers';
import {registerSystemHandlers} from './system-handlers';
import {registerUpdateHandlers} from './update-handlers';
import {registerTemplateHandlers} from './template-handlers';
import {registerProducerHandlers} from './producer-handlers';
import {registerConsumerHandlers} from './consumer-handlers';
import {ensureDbInitialized, cleanupDatabase} from './_shared';

// Re-export cleanupDatabase for external consumers
export {cleanupDatabase};

// 注册所有 IPC handlers
export function registerIPCHandlers() {
    // 确保数据库已初始化（孤儿 SSH 隧道由 initDatabase 按集群引用清一次，这里不再重复）
    ensureDbInitialized();

    registerClusterHandlers();
    registerResourceHandlers();
    registerMessageHandlers();
    registerMetricsHandlers();
    registerLoadTestHandlers();
    registerConfigHandlers();
    registerPluginHandlers();
    registerSystemHandlers();
    registerUpdateHandlers();
    registerTemplateHandlers();
    registerProducerHandlers();
    registerConsumerHandlers();
}
