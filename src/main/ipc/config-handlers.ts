import {app} from 'electron';
import {z} from 'zod';
import {
    AppSettingsSchema,
    applyConfigBundle,
    buildConfigBundle,
    clearOperationLogs,
    getDatabaseFilePath,
    parseConfigBundle,
    readAppSettings,
    resetAppSettings,
    writeAppSettings,
} from '../services/app-config';
import {ensureDbInitialized, formatError, insertOperationLog, registerHandler} from './_shared';
import {syncAlertEngine} from '../services/alert-engine';
import {createLogger} from '../utils/logger';

const log = createLogger('IPC');

// 告警的总开关与评估间隔就在这一次写入里变了，定时器必须跟着重挂：
// 只写库不重挂的话，"把间隔从 5 分钟改成 10 秒"要等下次启动才生效。
function rescheduleAlertEngine(): void {
    try {
        syncAlertEngine();
    } catch (error) {
        // 设置已经存进去了，不能让重挂失败把整次保存报成失败
        log.error('config: alert engine reschedule failed', formatError(error));
    }
}

// zod 的 issue 列表对用户没有意义（"Number must be greater than 20"），
// 但配置项都是具名字段，取第一条 issue 的路径 + 期望范围足够说清楚。
function describeInvalid(error: z.ZodError): string {
    const issue = error.issues[0];
    if (!issue) {
        return '配置校验失败';
    }
    return `配置项 ${issue.path.join('.') || '未知字段'} 不合法：${issue.message}`;
}

export function registerConfigHandlers() {
    registerHandler('config:getAll', async () => {
        ensureDbInitialized();
        return readAppSettings();
    });

    registerHandler('config:update', async (patch: unknown) => {
        ensureDbInitialized();
        const parsed = AppSettingsSchema.partial().strict().safeParse(patch);
        if (!parsed.success) {
            log.warn('config:update: invalid patch', formatError(parsed.error));
            throw new Error(describeInvalid(parsed.error));
        }
        return writeAppSettings(parsed.data);
    });

    registerHandler('config:reset', async () => {
        ensureDbInitialized();
        const settings = resetAppSettings();
        rescheduleAlertEngine();
        return settings;
    });

    registerHandler('config:meta', async () => {
        ensureDbInitialized();
        return {
            appVersion: app.getVersion(),
            databasePath: getDatabaseFilePath(),
        };
    });

    // 导出的是"可拷走"的明文文件，所以凭据在 app-config 里就被排除掉了
    registerHandler('config:export', async () => {
        ensureDbInitialized();
        return buildConfigBundle();
    });

    registerHandler('config:import', async (bundle: unknown) => {
        ensureDbInitialized();
        const parsed = parseConfigBundle(bundle);
        if ('error' in parsed) {
            log.warn('config:import: invalid bundle', formatError(parsed.error));
            throw new Error(`配置文件不符合格式要求：${describeInvalid(parsed.error)}`);
        }
        const result = applyConfigBundle(parsed.bundle);
        // 两种通道分开报：老导出文件里根本没有 k8s 这一项，只报一个"配置 N 个"
        // 会让人以为导入的东西和导出时不一致
        const summary = [
            `新建集群 ${result.clustersImported} 个`,
            `跳过同名 ${result.clustersSkipped.length} 个`,
            `SSH 配置 ${result.tunnelsImported} 个`,
            `K8s 转发配置 ${result.forwardsImported} 个`,
        ].join('、');
        insertOperationLog({
            cluster_id: null,
            action: 'import',
            resource_type: 'config',
            resource_id: null,
            resource_name: '应用配置',
            details: `导入配置：${summary}`,
            result: 'success',
        });
        return result;
    });

    registerHandler('config:clearLogs', async () => {
        ensureDbInitialized();
        const deleted = clearOperationLogs();
        // 清空之后再记这一条，否则它会被自己删掉
        insertOperationLog({
            cluster_id: null,
            action: 'delete',
            resource_type: 'config',
            resource_id: null,
            resource_name: '操作日志',
            details: `清空操作日志，共删除 ${deleted} 条`,
            result: 'success',
        });
        return {deleted};
    });
}
