import {
    ConsumerConfigCopySchema,
    ConsumerConfigDraftSchema,
    ConsumerConfigUpsertSchema,
    MessageTemplateBodySchema,
    ProducerOptionsSchema,
    SendHistoryGetSchema,
    SendHistoryListSchema,
    TemplateCopySchema,
    TemplateIdSchema,
    TemplateScopeSchema,
    formatError,
    insertOperationLog,
    registerHandler,
    uuidv4,
} from './_shared';
import {
    deleteConsumerSessionConfig,
    deleteMessageTemplate,
    getClusterById,
    getConsumerSessionConfigById,
    getMessageTemplateById,
    getSendHistoryById,
    insertConsumerSessionConfig,
    insertMessageTemplate,
    listConsumerSessionConfigs,
    listMessageTemplates,
    listSendHistory,
    updateConsumerSessionConfig,
    updateMessageTemplate,
    type ConsumerSessionConfigRecord,
    type MessageTemplateRecord,
    type SendHistoryRecord,
} from '../database/sqlite';
import {createLogger} from '../utils/logger';
import {parseSchemaJson} from '../../shared/json-schema-lite';
import type {
    ConsumerConfigDraft,
    ConsumerConfigUpsertParams,
    ConsumerSessionConfig,
    MessageTemplate,
    MessageTemplateUpsertParams,
    ProducerOptions,
    SendHistoryEntry,
    TemplateSchemaMode,
    TemplateVariable,
} from '../../shared/types';

const log = createLogger('IPCWorkbench');

// 模板与会话配置的纯 SQLite 增删改查。依赖 handlers.ts 启动期的那次
// ensureDbInitialized（registerHandler 本身不做初始化），所以这里的取数函数
// 直接调 DAO 而不逐个 ensure。
//
// 一律用 registerHandler 而不是 registerClientHandler / registerNativeHandler：
// 这三张表是本地数据，与 broker 无关，为「列出模板」去建 Pulsar 客户端没有意义，
// 而且集群离线时界面照样要能翻出上次写好的报文。

const SCHEMA_MODES: TemplateSchemaMode[] = ['none', 'inline', 'broker'];

// JSON 列坏掉（手工改库、老版本写歪）不能让整张列表 500：退回默认值并留一行警告，
// 用户至少还能看到模板名字并把正文重存一遍。
function parseJsonArray<T>(raw: string): T[] {
    try {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
        log.warn('corrupt JSON array column, fell back to []');
        return [];
    }
}

function parseJsonObject(raw: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        log.warn('corrupt JSON object column, fell back to {}');
        return {};
    }
}

// 空对象表示「模板没有指定生产者参数」，与「参数等于默认值」是两回事：
// 界面据此决定选项表单显示占位还是显示存下来的那一套。
function parseProducerOptions(raw: string): ProducerOptions | undefined {
    if (raw.trim() === '' || raw.trim() === '{}') {
        return undefined;
    }
    const parsed = ProducerOptionsSchema.safeParse(parseJsonObject(raw));
    return parsed.success ? (parsed.data as ProducerOptions) : undefined;
}

function normalizeSchemaMode(value: string): TemplateSchemaMode {
    return SCHEMA_MODES.includes(value as TemplateSchemaMode) ? (value as TemplateSchemaMode) : 'none';
}

function toTemplate(record: MessageTemplateRecord): MessageTemplate {
    return {
        id: record.id,
        clusterId: record.cluster_id,
        topicUri: record.topic_uri,
        name: record.name,
        body: record.body,
        variables: parseJsonArray<MessageTemplate['variables'][number]>(record.variables_json),
        properties: parseJsonObject(record.properties_json) as MessageTemplate['properties'],
        producerOptions: parseProducerOptions(record.producer_options_json),
        schemaMode: normalizeSchemaMode(record.schema_mode),
        schemaJson: record.schema_json ?? undefined,
        createdAt: record.created_at,
        updatedAt: record.updated_at,
    };
}

function toConsumerConfig(record: ConsumerSessionConfigRecord): ConsumerSessionConfig {
    // 坏行不致命：退回一份默认草稿，界面照样能改名与删除。
    const parsed = ConsumerConfigDraftSchema.safeParse(parseJsonObject(record.config_json));
    const draft = (parsed.success ? parsed.data : ConsumerConfigDraftSchema.parse({})) as ConsumerConfigDraft;
    return {
        // 草稿先展开、行上的列后写：作用域与名称的唯一真相在列上，
        // config_json 里若残留旧值也不能把它盖掉。
        ...draft,
        id: record.id,
        clusterId: record.cluster_id,
        topicUri: record.topic_uri,
        subscription: record.subscription,
        name: record.name,
        createdAt: record.created_at,
        updatedAt: record.updated_at,
    };
}

function toSendHistory(record: SendHistoryRecord): SendHistoryEntry {
    return {
        id: record.id,
        clusterId: record.cluster_id ?? null,
        topicUri: record.topic_uri,
        templateId: record.template_id ?? null,
        templateName: record.template_name,
        bodyPreview: record.body_preview,
        // 列表行不带全文（DAO 的列表查询刻意没选这一列），只有 sendHistory:get 会填
        bodyFull: record.body_full ?? null,
        bodyBytes: record.body_bytes,
        messageCount: record.message_count,
        messageId: record.message_id ?? null,
        status: record.status === 'failure' ? 'failure' : 'success',
        errorMessage: record.error_message ?? null,
        createdAt: record.created_at,
    };
}

// SQLite 的唯一冲突信息是 "UNIQUE constraint failed: message_templates.cluster_id, ..."，
// 直接进 toast 用户读不懂，而且删掉重名的那条才能保存这件事完全看不出来。
function conflictMessage(error: unknown, kind: string): string | null {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed/i.test(message)) {
        return `同一范围内已存在同名的${kind}，请改个名字`;
    }
    if (/FOREIGN KEY constraint failed/i.test(message)) {
        return '集群不存在，请先添加该集群';
    }
    return null;
}

function requireCluster(clusterId: string): void {
    if (!getClusterById(clusterId)) {
        throw new Error('集群不存在');
    }
}

// zod 3.25 的 z.infer 会把带 .default() 的字段标成可选（运行时 parse 必然补齐），
// 而 shared/types.ts 里这些字段是必填的。校验通过之后在这里收一次口，
// 免得每个字段前都挂一个「?? 默认值」——那等于把默认值写了第二遍，两处迟早对不上。
function parseTemplateInput(params: unknown): MessageTemplateUpsertParams {
    const parsed = MessageTemplateBodySchema.parse(params);
    const input = {
        id: parsed.id,
        clusterId: parsed.clusterId,
        topicUri: parsed.topicUri,
        name: parsed.name,
        body: parsed.body,
        variables: (parsed.variables ?? []) as TemplateVariable[],
        properties: parsed.properties,
        producerOptions: parsed.producerOptions as ProducerOptions | undefined,
        schemaMode: parsed.schemaMode ?? 'none',
        schemaJson: parsed.schemaJson,
    } as MessageTemplateUpsertParams;
    // 保存时就把 schema 本身判一遍：坏 schema 存进去，每条发送都会撞
    // resolveBatch 那道 fail-fast，用户在发送列表里看到的是逐条红字，
    // 而病根其实是三分钟前保存的那份 schema。
    if (input.schemaMode === 'inline') {
        const raw = (input.schemaJson || '').trim();
        if (!raw) {
            throw new Error('选了「内联 Schema」校验，需要同时保存 schema 内容');
        }
        const schema = parseSchemaJson(raw);
        // 主工程没开 strictNullChecks，布尔可辨识联合在这里不做收窄，得显式转一次
        if (!schema.ok) {
            throw new Error(`schema 不合法：${(schema as {error: string}).error}`);
        }
    }
    return input;
}

function parseConsumerInput(params: unknown): ConsumerConfigUpsertParams {
    return ConsumerConfigUpsertSchema.parse(params) as ConsumerConfigUpsertParams;
}

function writeLog(
    clusterId: string,
    action: 'create' | 'update' | 'delete',
    resourceType: 'message_template' | 'consumer_config',
    resourceId: string,
    resourceName: string,
): void {
    try {
        insertOperationLog({
            cluster_id: clusterId,
            action,
            resource_type: resourceType,
            resource_id: resourceId,
            resource_name: resourceName,
            result: 'success',
        });
    } catch (error) {
        // 审计是旁路：日志写失败不能把一次已成功的保存报成失败
        log.warn('operation log write failed', formatError(error));
    }
}

export function registerTemplateHandlers() {
    // ---------- 报文模板 ----------

    registerHandler('template:list', async (params: unknown) => {
        const {clusterId, topicUri} = TemplateScopeSchema.parse(params);
        return listMessageTemplates(clusterId, topicUri).map(toTemplate);
    });

    registerHandler('template:create', async (params: unknown) => {
        const input = parseTemplateInput(params);
        requireCluster(input.clusterId);
        const id = uuidv4();
        try {
            insertMessageTemplate({
                id,
                cluster_id: input.clusterId,
                topic_uri: input.topicUri,
                name: input.name,
                body: input.body,
                variables_json: JSON.stringify(input.variables ?? []),
                properties_json: JSON.stringify(input.properties ?? {}),
                producer_options_json: JSON.stringify(input.producerOptions ?? {}),
                schema_mode: input.schemaMode,
                // 非 inline 一律存 NULL：切回「不校验」后还留着旧 schema，
                // 下次再选 inline 时会拿一份没人看过的旧内容去校验
                schema_json: input.schemaMode === 'inline' ? (input.schemaJson ?? null) : null,
            });
        } catch (error) {
            throw new Error(conflictMessage(error, '模板') ?? formatError(error));
        }
        writeLog(input.clusterId, 'create', 'message_template', id, input.name);
        return toTemplate(getMessageTemplateById(id)!);
    });

    registerHandler('template:update', async (params: unknown) => {
        const input = parseTemplateInput(params);
        if (!input.id) {
            throw new Error('缺少模板 id');
        }
        const existing = getMessageTemplateById(input.id);
        if (!existing) {
            throw new Error('模板不存在');
        }
        requireCluster(input.clusterId);
        try {
            updateMessageTemplate(input.id, {
                cluster_id: input.clusterId,
                topic_uri: input.topicUri,
                name: input.name,
                body: input.body,
                variables_json: JSON.stringify(input.variables ?? []),
                properties_json: JSON.stringify(input.properties ?? {}),
                producer_options_json: JSON.stringify(input.producerOptions ?? {}),
                schema_mode: input.schemaMode,
                schema_json: input.schemaMode === 'inline' ? (input.schemaJson ?? null) : null,
            });
        } catch (error) {
            throw new Error(conflictMessage(error, '模板') ?? formatError(error));
        }
        writeLog(input.clusterId, 'update', 'message_template', input.id, input.name);
        return toTemplate(getMessageTemplateById(input.id)!);
    });

    registerHandler('template:delete', async (params: unknown) => {
        const {id} = TemplateIdSchema.parse(params);
        const existing = getMessageTemplateById(id);
        if (!existing) {
            return {deleted: false};
        }
        deleteMessageTemplate(id);
        writeLog(existing.cluster_id, 'delete', 'message_template', id, existing.name);
        return {deleted: true};
    });

    // 复制在服务层组合（读原行 + 插新行），DAO 不写 copyXxx：
    // 表结构变了只有一处转换代码要改。
    registerHandler('template:copy', async (params: unknown) => {
        const input = TemplateCopySchema.parse(params);
        const source = getMessageTemplateById(input.id);
        if (!source) {
            throw new Error('模板不存在');
        }
        const id = uuidv4();
        try {
            insertMessageTemplate({
                id,
                cluster_id: source.cluster_id,
                topic_uri: input.topicUri ?? source.topic_uri,
                name: input.name ?? `${source.name} 副本`,
                body: source.body,
                variables_json: source.variables_json,
                properties_json: source.properties_json,
                producer_options_json: source.producer_options_json,
                schema_mode: source.schema_mode,
                schema_json: source.schema_json ?? null,
            });
        } catch (error) {
            throw new Error(conflictMessage(error, '模板') ?? formatError(error));
        }
        writeLog(source.cluster_id, 'create', 'message_template', id, input.name ?? `${source.name} 副本`);
        return toTemplate(getMessageTemplateById(id)!);
    });

    // ---------- 消费者会话配置 ----------

    registerHandler('consumerConfig:list', async (params: unknown) => {
        const {clusterId, topicUri} = TemplateScopeSchema.parse(params);
        return listConsumerSessionConfigs(clusterId, topicUri).map(toConsumerConfig);
    });

    registerHandler('consumerConfig:create', async (params: unknown) => {
        const input = parseConsumerInput(params);
        requireCluster(input.clusterId);
        const id = uuidv4();
        try {
            insertConsumerSessionConfig({
                id,
                cluster_id: input.clusterId,
                topic_uri: input.topicUri,
                subscription: input.subscription,
                name: input.name,
                config_json: JSON.stringify(draftOf(input)),
            });
        } catch (error) {
            throw new Error(conflictMessage(error, '消费配置') ?? formatError(error));
        }
        writeLog(input.clusterId, 'create', 'consumer_config', id, input.name);
        return toConsumerConfig(getConsumerSessionConfigById(id)!);
    });

    registerHandler('consumerConfig:update', async (params: unknown) => {
        const input = parseConsumerInput(params);
        if (!input.id) {
            throw new Error('缺少配置 id');
        }
        const existing = getConsumerSessionConfigById(input.id);
        if (!existing) {
            throw new Error('配置不存在');
        }
        requireCluster(input.clusterId);
        try {
            updateConsumerSessionConfig(input.id, {
                cluster_id: input.clusterId,
                topic_uri: input.topicUri,
                subscription: input.subscription,
                name: input.name,
                config_json: JSON.stringify(draftOf(input)),
            });
        } catch (error) {
            throw new Error(conflictMessage(error, '消费配置') ?? formatError(error));
        }
        writeLog(input.clusterId, 'update', 'consumer_config', input.id, input.name);
        return toConsumerConfig(getConsumerSessionConfigById(input.id)!);
    });

    registerHandler('consumerConfig:delete', async (params: unknown) => {
        const {id} = TemplateIdSchema.parse(params);
        const existing = getConsumerSessionConfigById(id);
        if (!existing) {
            return {deleted: false};
        }
        deleteConsumerSessionConfig(id);
        writeLog(existing.cluster_id, 'delete', 'consumer_config', id, existing.name);
        return {deleted: true};
    });

    registerHandler('consumerConfig:copy', async (params: unknown) => {
        const input = ConsumerConfigCopySchema.parse(params);
        const source = getConsumerSessionConfigById(input.id);
        if (!source) {
            throw new Error('配置不存在');
        }
        const id = uuidv4();
        try {
            insertConsumerSessionConfig({
                id,
                cluster_id: source.cluster_id,
                topic_uri: input.topicUri ?? source.topic_uri,
                subscription: input.subscription ?? source.subscription,
                name: input.name ?? `${source.name} 副本`,
                config_json: source.config_json,
            });
        } catch (error) {
            throw new Error(conflictMessage(error, '消费配置') ?? formatError(error));
        }
        writeLog(source.cluster_id, 'create', 'consumer_config', id, input.name ?? `${source.name} 副本`);
        return toConsumerConfig(getConsumerSessionConfigById(id)!);
    });

    // ---------- 发送历史（只读；写入在 producer 发送路径里）----------

    registerHandler('sendHistory:list', async (params: unknown) => {
        const {clusterId, topicUri, limit} = SendHistoryListSchema.parse(params);
        return listSendHistory(clusterId, topicUri, limit).map(toSendHistory);
    });

    // 单取一行的全文：列表为了 IPC 体积不带 body_full，「重发」点这里把整篇正文取回去
    registerHandler('sendHistory:get', async (params: unknown) => {
        const {id} = SendHistoryGetSchema.parse(params);
        const record = getSendHistoryById(id);
        return record ? toSendHistory(record) : null;
    });
}

// 存进 config_json 的只有会话参数本身：作用域与名称是列，重复存一份就有两处真相。
function draftOf(input: ConsumerConfigUpsertParams): ConsumerConfigDraft {
    return {
        subscriptionType: input.subscriptionType,
        initialPosition: input.initialPosition,
        autoAck: input.autoAck,
        maxMessages: input.maxMessages,
        receiverQueueSize: input.receiverQueueSize,
        ackTimeoutMs: input.ackTimeoutMs,
        nAckRedeliverTimeoutMs: input.nAckRedeliverTimeoutMs,
        consumerName: input.consumerName,
        deadLetter: input.deadLetter,
    };
}
