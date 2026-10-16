import {
    AlertEventIdsSchema,
    AlertEventQuerySchema,
    AlertRuleIdSchema,
    AlertRuleUpsertSchema,
    OptionalAlertClusterSchema,
    formatError,
    getAdminClient,
    getClusterById,
    insertOperationLog,
    registerHandler,
    uuidv4,
    z,
} from './_shared';
import {
    ackAlertEvents,
    countOpenAlertEvents,
    deleteAlertEvents,
    deleteAlertRule,
    getAlertRuleById,
    insertAlertRule,
    listAlertEvents,
    listAlertRules,
    updateAlertRule,
    type AlertEventFilter,
    type AlertRuleWrite,
} from '../database/sqlite';
import {
    bindAlertEngineDeps,
    probeAlertRule,
    resetAlertRuntime,
    toAlertEvent,
    toAlertRule,
} from '../services/alert-engine';
import {sendToRenderer} from './stream';
import {createLogger} from '../utils/logger';
import {ALERT_EVENT_CHANNEL, type AlertRuleUpsertParams} from '../../shared/types';

const log = createLogger('IPCAlert');

// 告警规则与事件的本地增删改查（SQLite），加上引擎的下行推送接线。
//
// 规则本身不查 broker——评估是引擎按间隔去读的，界面存一条指向不存在 topic 的规则
// 与 broker 离线时改阈值都该成功，所以这里一律 registerHandler，不为本地数据建 admin 客户端。
// 反过来，「试跑」这条通道必须能拿到客户端：它是唯一一次即时评估，走 alert-engine 的取数。

export function registerAlertHandlers() {
    // 引擎模块不许 import 这一层（这一层反过来 import 它的求值入口），
    // 所以取客户端与推送这两个能力在这里注入。
    bindAlertEngineDeps({
        // 经 SSH 隧道的集群会在这里把本地转发建起来，失败当作"该集群本轮跳过"
        getClient: clusterId => getAdminClient(clusterId),
        publish: push => sendToRenderer(ALERT_EVENT_CHANNEL, push),
    });

    registerHandler('alert:rules:list', async (params: unknown) => {
        const {clusterId} = z.object({clusterId: OptionalAlertClusterSchema}).parse(params ?? {});
        return listAlertRules()
            .filter(record => !clusterId || record.cluster_id === clusterId)
            .map(toAlertRule);
    });

    registerHandler('alert:rules:count', async () => countOpenAlertEvents());

    registerHandler('alert:rule:get', async (params: unknown) => {
        const {id} = AlertRuleIdSchema.parse(params);
        const record = getAlertRuleById(id);
        if (!record) {
            throw new Error('规则不存在，可能已被删除');
        }
        return toAlertRule(record);
    });

    registerHandler('alert:rule:upsert', async (params: unknown) => {
        const input = AlertRuleUpsertSchema.parse(params) as AlertRuleUpsertParams;
        if (!getClusterById(input.clusterId)) {
            throw new Error('集群不存在，请先添加该集群');
        }
        const record = toAlertRuleWrite(input);
        const id = input.id ?? uuidv4();
        const isNew = input.id === undefined;
        try {
            if (isNew) {
                insertAlertRule({id, ...record});
            } else if (!getAlertRuleById(id)) {
                throw new Error('规则不存在，可能已被删除');
            } else {
                updateAlertRule(id, record);
            }
        } catch (error) {
            throw new Error(conflictMessage(error, input.name) ?? formatError(error));
        }
        // 阈值/口径/连续次数都可能在这一次被改掉，旧的命中计数在新判定下没有意义
        resetAlertRuntime(id);
        writeLog(input.clusterId, isNew ? 'create' : 'update', id, input.name);
        const saved = getAlertRuleById(id);
        return saved ? toAlertRule(saved) : null;
    });

    registerHandler('alert:rule:delete', async (params: unknown) => {
        const {id} = AlertRuleIdSchema.parse(params);
        const record = getAlertRuleById(id);
        if (!record) {
            return 0;
        }
        deleteAlertRule(id);
        resetAlertRuntime(id);
        writeLog(record.cluster_id, 'delete', id, record.name);
        return 1;
    });

    registerHandler('alert:rule:test', async (params: unknown) => {
        const {id} = AlertRuleIdSchema.parse(params);
        return probeAlertRule(id);
    });

    registerHandler('alert:events:list', async (params: unknown) => {
        // zod 3.25 的推断会把带 .default() 的字段标成可选（运行时 parse 必然补齐 limit），
        // 而 DAO 要的是必填——校验通过之后在这里收一次口。
        const query = AlertEventQuerySchema.parse(params ?? {}) as AlertEventFilter;
        return listAlertEvents(query).map(toAlertEvent);
    });

    registerHandler('alert:events:ack', async (params: unknown) => {
        const {ids} = AlertEventIdsSchema.parse(params);
        return ackAlertEvents(ids, Date.now());
    });

    registerHandler('alert:events:delete', async (params: unknown) => {
        const {ids} = AlertEventIdsSchema.parse(params);
        return deleteAlertEvents(ids);
    });
}

// 作用域决定哪些定位字段有意义：集群口径留着上次选过的 namespace，
// 引擎按 (scope|tenant|namespace|topic) 拼缓存键时就会把两条集群规则算成不同资源，
// 更要命的是 formatAlertScope 会把「整个集群」显示成某个具体命名空间。
function toAlertRuleWrite(input: AlertRuleUpsertParams): AlertRuleWrite {
    const locator =
        input.scope === 'cluster'
            ? {tenant: '', namespace: '', topic: ''}
            : input.scope === 'namespace'
              ? {tenant: input.tenant, namespace: input.namespace, topic: ''}
              : {tenant: input.tenant, namespace: input.namespace, topic: input.topic};
    return {
        cluster_id: input.clusterId,
        name: input.name,
        enabled: input.enabled ? 1 : 0,
        scope: input.scope,
        ...locator,
        persistent: input.persistent ? 1 : 0,
        metric: input.metric,
        comparator: input.comparator,
        threshold: input.threshold,
        consecutive: input.consecutive,
        notify: input.notify ? 1 : 0,
    };
}

function conflictMessage(error: unknown, name: string): string | null {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed/i.test(message)) {
        return `同一集群下已存在名为「${name}」的告警规则，请改个名字`;
    }
    if (/FOREIGN KEY constraint failed/i.test(message)) {
        return '集群不存在，请先添加该集群';
    }
    return null;
}

function writeLog(
    clusterId: string,
    action: 'create' | 'update' | 'delete',
    resourceId: string,
    resourceName: string,
): void {
    try {
        insertOperationLog({
            cluster_id: clusterId,
            action,
            resource_type: 'alert_rule',
            resource_id: resourceId,
            resource_name: resourceName,
            result: 'success',
        });
    } catch (error) {
        // 审计是旁路：日志写失败不能把一次已成功的保存报成失败
        log.warn('operation log write failed', formatError(error));
    }
}
