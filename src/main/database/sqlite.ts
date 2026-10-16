import Database from 'better-sqlite3';
import path from 'path';
import {app} from 'electron';
import fs from 'fs';
import {SCHEMA_SQL} from './schema';

// 数据库实例
let db: Database.Database | null = null;

// schema 版本以 user_version 跟踪。改基线 DDL 时：升 SCHEMA_VERSION，
// 并把该版本的增量 DDL 写进 migrate()——CREATE TABLE IF NOT EXISTS 对已存在的
// 旧库什么都不做，没有这套机制，加列只会对新装用户生效，旧库静默落后。
const SCHEMA_VERSION = 7;

function migrate(database: Database.Database, from: number): void {
    // v2：refreshInterval 那行出厂值是 30000，而监控页的刷新间隔单位是秒，
    // 两者永远对不上；换成 refreshIntervalSeconds 后旧行就是纯垃圾，直接删。
    if (from < 2) {
        database.prepare("DELETE FROM user_settings WHERE key = 'refreshInterval'").run();
    }
    // v3：压测预设改由插件系统提供（userData/plugins），这张表从来没有读写方
    if (from < 3) {
        database.prepare('DROP TABLE IF EXISTS load_test_templates').run();
    }
    // v4：快捷键方案实际存在 user_settings.key='shortcuts'，这张表建了也从未被读写，
    // 留着只是多一个「看起来像数据源」的地方
    if (from < 4) {
        database.prepare('DROP TABLE IF EXISTS keyboard_shortcuts').run();
    }
    // v5：生产者/消费者工作台的三张表（模板、会话配置、发送历史）只新增 DDL，
    // 老库靠每次启动的基线语句补齐，这里没有数据要修补——留这段是为了下次加列时
    // 不必回头猜 v5 到底做没做事。
    // v6：模板加 schema_json（发送时的内联 schema 校验）。新库的基线建表已带这一列，
    // 老库才需要 ALTER，所以先查表结构再决定加不加——不加判断的话新库会在事务里
    // 撞上 duplicate column 把整个启动期迁移顶掉。
    if (from < 6) {
        const columns = database.prepare('PRAGMA table_info(message_templates)').all() as {name: string}[];
        if (!columns.some(column => column.name === 'schema_json')) {
            database.prepare('ALTER TABLE message_templates ADD COLUMN schema_json TEXT').run();
        }
    }
    // v7：发送历史加 body_full（全文留存开关打开时存整篇正文）。
    // 和 v6 同一个坑：新库基线已带这列，不查表结构直接 ALTER 会 duplicate column 顶掉启动迁移。
    if (from < 7) {
        const columns = database.prepare('PRAGMA table_info(send_history)').all() as {name: string}[];
        if (!columns.some(column => column.name === 'body_full')) {
            database.prepare('ALTER TABLE send_history ADD COLUMN body_full TEXT').run();
        }
    }
}

// 每次启动都执行基线再补迁移：基线全是幂等语句，因此旧库缺的表和出厂设置行
// 都会被补齐（只按 user_version 走迁移分支的话，迁移路径上的库永远拿不到
// 后来新增的默认键）。整个过程包在一个事务里——中途崩溃不能留下
// 「DDL 已生效但版本号没推进」的半迁移状态。
function applySchema(database: Database.Database): void {
    const current = database.pragma('user_version', {simple: true}) as number;
    if (current > SCHEMA_VERSION) {
        throw new Error(`Database schema version ${current} is newer than this app supports (${SCHEMA_VERSION})`);
    }
    database.transaction(() => {
        database.exec(SCHEMA_SQL);
        migrate(database, current);
        database.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
}

// 获取数据库文件路径
function getDatabasePath(): string {
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'pulsar-manager.db');
}

// 初始化数据库
export function initDatabase(): Database.Database {
    if (db) {
        return db;
    }

    const dbPath = getDatabasePath();

    // 确保目录存在
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, {recursive: true});
    }

    console.log('[Database] Initializing database at:', dbPath);

    // 创建数据库连接。不开 better-sqlite3 的 verbose：它会把每条 SQL 及参数
    // （含加密后的凭据字段）原样打进控制台。
    // 实例必须在成功建好之后才对外可见：把半成品赋给模块变量会让下一次
    // initDatabase() 直接 return 这个没有表句柄，此后每个通道都报 no such table。
    const database = new Database(dbPath);
    try {
        // 启用 WAL 模式，提升并发性能
        database.pragma('journal_mode = WAL');

        // SQLite 的 foreign_keys 默认是关的：不显式打开，schema 里的
        // operation_logs.cluster_id 外键就是一行装饰
        database.pragma('foreign_keys = ON');

        // 执行 schema 初始化 / 版本迁移
        applySchema(database);
    } catch (error) {
        database.close();
        throw error;
    }
    db = database;

    console.log('[Database] Database initialized successfully');

    // 启动时清理过期操作日志
    cleanupOperationLogs();
    cleanupSendHistory();

    const orphans = cleanupOrphanSshTunnels();
    if (orphans > 0) {
        console.log(`[Database] Cleaned up ${orphans} unreferenced SSH tunnel configs`);
    }

    return db;
}

// 获取数据库实例
export function getDatabase(): Database.Database {
    if (!db) {
        throw new Error('Database not initialized. Call initDatabase() first.');
    }
    return db;
}

// 关闭数据库
export function closeDatabase(): void {
    if (db) {
        db.close();
        db = null;
        console.log('[Database] Database closed');
    }
}

/**
 * 在单个事务中执行多次写入。业务写入与操作日志必须一起成功或一起回滚，
 * 否则会留下「集群已写但无日志」或「日志已记但删除失败」的不一致状态。
 */
export function runInTransaction<T>(fn: () => T): T {
    const database = getDatabase();
    return database.transaction(fn)();
}

// 集群相关操作
export interface ClusterRecord {
    id: string;
    name: string;
    service_url: string;
    web_service_url?: string;
    auth_plugin?: string;
    auth_params?: string;
    tls_enabled: number;
    tls_trust_certs?: string;
    use_ssh_tunnel: number;
    ssh_config_id?: string;
    admin_api_timeout: number;
    status: string;
    version?: string;
    created_at: string;
    updated_at: string;
}

export function getAllClusters(): ClusterRecord[] {
    const database = getDatabase();
    const stmt = database.prepare('SELECT * FROM clusters ORDER BY created_at DESC');
    return stmt.all() as ClusterRecord[];
}

export function getClusterById(id: string): ClusterRecord | undefined {
    const database = getDatabase();
    const stmt = database.prepare('SELECT * FROM clusters WHERE id = ?');
    return stmt.get(id) as ClusterRecord | undefined;
}

export function insertCluster(
    cluster: Omit<ClusterRecord, 'created_at' | 'updated_at' | 'version'> & {version?: string},
): void {
    const database = getDatabase();
    const now = new Date().toISOString();
    const stmt = database.prepare(`
    INSERT INTO clusters (
      id, name, service_url, web_service_url, auth_plugin, auth_params,
      tls_enabled, tls_trust_certs, use_ssh_tunnel, ssh_config_id,
      admin_api_timeout, status, version, created_at, updated_at
    ) VALUES (
      @id, @name, @service_url, @web_service_url, @auth_plugin, @auth_params,
      @tls_enabled, @tls_trust_certs, @use_ssh_tunnel, @ssh_config_id,
      @admin_api_timeout, @status, @version, @created_at, @updated_at
    )
  `);
    stmt.run({...cluster, version: cluster.version || null, created_at: now, updated_at: now});
}

const CLUSTER_ALLOWED_FIELDS = new Set([
    'name',
    'service_url',
    'web_service_url',
    'auth_plugin',
    'auth_params',
    'tls_enabled',
    'tls_trust_certs',
    'use_ssh_tunnel',
    'ssh_config_id',
    'admin_api_timeout',
    'status',
    'version',
]);

export function updateCluster(id: string, updates: Partial<ClusterRecord>): void {
    const database = getDatabase();
    const now = new Date().toISOString();

    for (const key of Object.keys(updates)) {
        if (key !== 'id' && !CLUSTER_ALLOWED_FIELDS.has(key)) {
            throw new Error(`Invalid field for cluster update: ${key}`);
        }
    }

    const fields = Object.keys(updates)
        .filter(k => k !== 'id' && CLUSTER_ALLOWED_FIELDS.has(k))
        .map(k => `${k} = @${k}`)
        .join(', ');

    if (fields === '') {
        throw new Error('No valid fields provided for cluster update');
    }

    const stmt = database.prepare(`UPDATE clusters SET ${fields}, updated_at = @updated_at WHERE id = @id`);
    stmt.run({...updates, id, updated_at: now});
}

export function deleteCluster(id: string): void {
    const database = getDatabase();
    const stmt = database.prepare('DELETE FROM clusters WHERE id = ?');
    stmt.run(id);
}

// SSH 隧道相关操作
export interface SSHTunnelRecord {
    id: string;
    host: string;
    port: number;
    username: string;
    auth_type: string;
    password?: string;
    private_key?: string;
    passphrase?: string;
    local_admin_port: number;
    local_broker_port: number;
    remote_host?: string;
    remote_admin_port: number;
    remote_broker_port: number;
    status: string;
    created_at: string;
    updated_at: string;
}

export function getAllSSHTunnels(): SSHTunnelRecord[] {
    const database = getDatabase();
    const stmt = database.prepare('SELECT * FROM ssh_tunnels ORDER BY created_at DESC');
    return stmt.all() as SSHTunnelRecord[];
}

export function getSSHTunnelById(id: string): SSHTunnelRecord | undefined {
    const database = getDatabase();
    const stmt = database.prepare('SELECT * FROM ssh_tunnels WHERE id = ?');
    return stmt.get(id) as SSHTunnelRecord | undefined;
}

export function insertSSHTunnel(tunnel: Omit<SSHTunnelRecord, 'created_at' | 'updated_at'>): void {
    const database = getDatabase();
    const now = new Date().toISOString();
    const stmt = database.prepare(`
    INSERT INTO ssh_tunnels (
      id, host, port, username, auth_type, password, private_key, passphrase,
      local_admin_port, local_broker_port, remote_host, remote_admin_port,
      remote_broker_port, status, created_at, updated_at
    ) VALUES (
      @id, @host, @port, @username, @auth_type, @password, @private_key, @passphrase,
      @local_admin_port, @local_broker_port, @remote_host, @remote_admin_port,
      @remote_broker_port, @status, @created_at, @updated_at
    )
  `);
    stmt.run({...tunnel, created_at: now, updated_at: now});
}

const SSH_TUNNEL_ALLOWED_FIELDS = new Set([
    'host',
    'port',
    'username',
    'auth_type',
    'password',
    'private_key',
    'passphrase',
    'local_admin_port',
    'local_broker_port',
    'remote_host',
    'remote_admin_port',
    'remote_broker_port',
    'status',
]);

export function updateSSHTunnel(id: string, updates: Partial<SSHTunnelRecord>): void {
    const database = getDatabase();
    const now = new Date().toISOString();

    for (const key of Object.keys(updates)) {
        if (key !== 'id' && !SSH_TUNNEL_ALLOWED_FIELDS.has(key)) {
            throw new Error(`Invalid field for SSH tunnel update: ${key}`);
        }
    }

    const fields = Object.keys(updates)
        .filter(k => k !== 'id' && SSH_TUNNEL_ALLOWED_FIELDS.has(k))
        .map(k => `${k} = @${k}`)
        .join(', ');

    if (fields === '') {
        throw new Error('No valid fields provided for SSH tunnel update');
    }

    const stmt = database.prepare(`UPDATE ssh_tunnels SET ${fields}, updated_at = @updated_at WHERE id = @id`);
    stmt.run({...updates, id, updated_at: now});
}

export function deleteSSHTunnel(id: string): void {
    const database = getDatabase();
    const stmt = database.prepare('DELETE FROM ssh_tunnels WHERE id = ?');
    stmt.run(id);
}

// 报文模板（生产者工作台）
export interface MessageTemplateRecord {
    id: string;
    cluster_id: string;
    topic_uri: string;
    name: string;
    body: string;
    variables_json: string;
    properties_json: string;
    producer_options_json: string;
    schema_mode: string;
    schema_json?: string | null;
    use_count: number;
    last_used_at?: string | null;
    created_at: string;
    updated_at: string;
}

export function listMessageTemplates(clusterId: string, topicUri?: string): MessageTemplateRecord[] {
    const database = getDatabase();
    // 传了 topicUri 就带上通用模板（topic_uri = ''）：工作台列出的应当是
    // 「这个 topic 能用的」，而不是「恰好为该 topic 建过的」。
    if (topicUri === undefined) {
        return database
            .prepare('SELECT * FROM message_templates WHERE cluster_id = ? ORDER BY updated_at DESC')
            .all(clusterId) as MessageTemplateRecord[];
    }
    return database
        .prepare(
            "SELECT * FROM message_templates WHERE cluster_id = ? AND topic_uri IN (?, '')" +
                ' ORDER BY updated_at DESC',
        )
        .all(clusterId, topicUri) as MessageTemplateRecord[];
}

export function getMessageTemplateById(id: string): MessageTemplateRecord | undefined {
    const database = getDatabase();
    return database.prepare('SELECT * FROM message_templates WHERE id = ?').get(id) as
        MessageTemplateRecord | undefined;
}

export function insertMessageTemplate(
    template: Omit<MessageTemplateRecord, 'created_at' | 'updated_at' | 'use_count'> & {use_count?: number},
): void {
    const database = getDatabase();
    const now = new Date().toISOString();
    const stmt = database.prepare(`
    INSERT INTO message_templates (
      id, cluster_id, topic_uri, name, body, variables_json, properties_json,
      producer_options_json, schema_mode, schema_json, use_count, last_used_at, created_at, updated_at
    ) VALUES (
      @id, @cluster_id, @topic_uri, @name, @body, @variables_json, @properties_json,
      @producer_options_json, @schema_mode, @schema_json, @use_count, @last_used_at, @created_at, @updated_at
    )
  `);
    stmt.run({
        ...template,
        // schema 原文没内容时存 NULL 而不是空串：'inline 但 schema 是空的'这种
        // 半配置状态在列上必须看得出来，空串会被读成"存过 schema"。
        schema_json: template.schema_json ?? null,
        // 默认值写在展开之后：调用方传 last_used_at: undefined 时，展开会把
        // null 顶掉，而 better-sqlite3 对 undefined 直接抛错而不是当 NULL。
        last_used_at: template.last_used_at ?? null,
        use_count: template.use_count ?? 0,
        created_at: now,
        updated_at: now,
    });
}

const MESSAGE_TEMPLATE_ALLOWED_FIELDS = new Set([
    'cluster_id',
    'topic_uri',
    'name',
    'body',
    'variables_json',
    'properties_json',
    'producer_options_json',
    'schema_mode',
    'schema_json',
    'last_used_at',
]);

export function updateMessageTemplate(id: string, updates: Partial<MessageTemplateRecord>): void {
    const database = getDatabase();
    const now = new Date().toISOString();

    for (const key of Object.keys(updates)) {
        if (key !== 'id' && !MESSAGE_TEMPLATE_ALLOWED_FIELDS.has(key)) {
            throw new Error(`Invalid field for message template update: ${key}`);
        }
    }

    const fields = Object.keys(updates)
        .filter(k => k !== 'id' && MESSAGE_TEMPLATE_ALLOWED_FIELDS.has(k))
        .map(k => `${k} = @${k}`)
        .join(', ');

    if (fields === '') {
        throw new Error('No valid fields provided for message template update');
    }

    const stmt = database.prepare(`UPDATE message_templates SET ${fields}, updated_at = @updated_at WHERE id = @id`);
    stmt.run({...updates, id, updated_at: now});
}

export function deleteMessageTemplate(id: string): void {
    const database = getDatabase();
    database.prepare('DELETE FROM message_templates WHERE id = ?').run(id);
}

// 发送/引用一次模板就记一笔，模板库按它排序「最近用过」。
// 单独一个语句而不是并进 update：业务改名不该顺带把使用次数写回去。
export function touchMessageTemplateUse(id: string): void {
    const database = getDatabase();
    const now = new Date().toISOString();
    database
        .prepare('UPDATE message_templates SET use_count = use_count + 1, last_used_at = ? WHERE id = ?')
        .run(now, id);
}

// 消费者会话配置（消费者工作台）
export interface ConsumerSessionConfigRecord {
    id: string;
    cluster_id: string;
    topic_uri: string;
    subscription: string;
    name: string;
    config_json: string;
    use_count: number;
    last_used_at?: string | null;
    created_at: string;
    updated_at: string;
}

export function listConsumerSessionConfigs(clusterId: string, topicUri?: string): ConsumerSessionConfigRecord[] {
    const database = getDatabase();
    if (topicUri === undefined) {
        return database
            .prepare('SELECT * FROM consumer_session_configs WHERE cluster_id = ? ORDER BY updated_at DESC')
            .all(clusterId) as ConsumerSessionConfigRecord[];
    }
    return database
        .prepare(
            "SELECT * FROM consumer_session_configs WHERE cluster_id = ? AND topic_uri IN (?, '')" +
                ' ORDER BY updated_at DESC',
        )
        .all(clusterId, topicUri) as ConsumerSessionConfigRecord[];
}

export function getConsumerSessionConfigById(id: string): ConsumerSessionConfigRecord | undefined {
    const database = getDatabase();
    return database.prepare('SELECT * FROM consumer_session_configs WHERE id = ?').get(id) as
        ConsumerSessionConfigRecord | undefined;
}

export function insertConsumerSessionConfig(
    config: Omit<ConsumerSessionConfigRecord, 'created_at' | 'updated_at' | 'use_count'> & {use_count?: number},
): void {
    const database = getDatabase();
    const now = new Date().toISOString();
    const stmt = database.prepare(`
    INSERT INTO consumer_session_configs (
      id, cluster_id, topic_uri, subscription, name, config_json,
      use_count, last_used_at, created_at, updated_at
    ) VALUES (
      @id, @cluster_id, @topic_uri, @subscription, @name, @config_json,
      @use_count, @last_used_at, @created_at, @updated_at
    )
  `);
    stmt.run({
        ...config,
        last_used_at: config.last_used_at ?? null,
        use_count: config.use_count ?? 0,
        created_at: now,
        updated_at: now,
    });
}

const CONSUMER_CONFIG_ALLOWED_FIELDS = new Set([
    'cluster_id',
    'topic_uri',
    'subscription',
    'name',
    'config_json',
    'last_used_at',
]);

export function updateConsumerSessionConfig(id: string, updates: Partial<ConsumerSessionConfigRecord>): void {
    const database = getDatabase();
    const now = new Date().toISOString();

    for (const key of Object.keys(updates)) {
        if (key !== 'id' && !CONSUMER_CONFIG_ALLOWED_FIELDS.has(key)) {
            throw new Error(`Invalid field for consumer session config update: ${key}`);
        }
    }

    const fields = Object.keys(updates)
        .filter(k => k !== 'id' && CONSUMER_CONFIG_ALLOWED_FIELDS.has(k))
        .map(k => `${k} = @${k}`)
        .join(', ');

    if (fields === '') {
        throw new Error('No valid fields provided for consumer session config update');
    }

    const stmt = database.prepare(
        `UPDATE consumer_session_configs SET ${fields}, updated_at = @updated_at WHERE id = @id`,
    );
    stmt.run({...updates, id, updated_at: now});
}

export function deleteConsumerSessionConfig(id: string): void {
    const database = getDatabase();
    database.prepare('DELETE FROM consumer_session_configs WHERE id = ?').run(id);
}

export function touchConsumerSessionConfigUse(id: string): void {
    const database = getDatabase();
    const now = new Date().toISOString();
    database
        .prepare('UPDATE consumer_session_configs SET use_count = use_count + 1, last_used_at = ? WHERE id = ?')
        .run(now, id);
}

// 发送历史（生产者工作台，默认只存预览；全文留存开关打开时带 body_full）
export interface SendHistoryRecord {
    // 读出来的行一定有自增主键；写入走 Omit 去掉它
    id: number;
    cluster_id?: string | null;
    topic_uri: string;
    template_id?: string | null;
    template_name: string;
    body_preview: string;
    body_full?: string | null;
    body_bytes: number;
    message_count: number;
    message_id?: string | null;
    status: string;
    error_message?: string | null;
    created_at: string;
}

export function insertSendHistory(
    entry: Omit<SendHistoryRecord, 'id' | 'created_at' | 'message_count'> & {message_count?: number},
): void {
    const database = getDatabase();
    const now = new Date().toISOString();
    database
        .prepare(
            `INSERT INTO send_history (
               cluster_id, topic_uri, template_id, template_name, body_preview, body_full,
               body_bytes, message_count, message_id, status, error_message, created_at
             ) VALUES (
               @cluster_id, @topic_uri, @template_id, @template_name, @body_preview, @body_full,
               @body_bytes, @message_count, @message_id, @status, @error_message, @created_at
             )`,
        )
        .run({
            ...entry,
            cluster_id: entry.cluster_id ?? null,
            template_id: entry.template_id ?? null,
            message_id: entry.message_id ?? null,
            error_message: entry.error_message ?? null,
            body_full: entry.body_full ?? null,
            message_count: entry.message_count ?? 1,
            created_at: now,
        });
}

// 列表刻意不取 body_full：200 行全文一次进 IPC 太沉，重发要哪一行再单取哪一行。
export function listSendHistory(clusterId: string, topicUri: string, limit = 200): SendHistoryRecord[] {
    const database = getDatabase();
    return database
        .prepare(
            `SELECT id, cluster_id, topic_uri, template_id, template_name, body_preview,
                    body_bytes, message_count, message_id, status, error_message, created_at
             FROM send_history
             WHERE cluster_id = ? AND topic_uri = ?
             ORDER BY created_at DESC LIMIT ?`,
        )
        .all(clusterId, topicUri, limit) as SendHistoryRecord[];
}

export function getSendHistoryById(id: number): SendHistoryRecord | undefined {
    const database = getDatabase();
    return database.prepare('SELECT * FROM send_history WHERE id = ?').get(id) as SendHistoryRecord | undefined;
}

// 与操作日志同一套保留策略。不做 VACUUM：WAL 下 DELETE 本来就不缩文件，
// 而定期 VACUUM 会把主进程卡在一个不可中断的整库重写上。
export function cleanupSendHistory(maxRows: number = 2000): void {
    const database = getDatabase();
    const count = database.prepare('SELECT COUNT(*) as count FROM send_history').get() as {count: number};
    if (count.count > maxRows) {
        const deleteCount = count.count - maxRows;
        database
            .prepare(
                `DELETE FROM send_history
                 WHERE id IN (SELECT id FROM send_history ORDER BY created_at ASC LIMIT ?)`,
            )
            .run(deleteCount);
        console.log(`[Database] Cleaned up ${deleteCount} old send history rows`);
    }
}

// 用户设置相关操作
export function getSetting(key: string): string | undefined {
    const database = getDatabase();
    const stmt = database.prepare('SELECT value FROM user_settings WHERE key = ?');
    const result = stmt.get(key) as {value: string} | undefined;
    return result?.value;
}

export function setSetting(key: string, value: string): void {
    const database = getDatabase();
    const now = new Date().toISOString();
    const stmt = database.prepare(`
    INSERT INTO user_settings (key, value, updated_at)
    VALUES (@key, @value, @updated_at)
    ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @updated_at
  `);
    stmt.run({key, value, updated_at: now});
}

// 操作日志相关操作
export interface OperationLogRecord {
    id?: number;
    // 集群删除后的日志没有归属集群，写入 null
    cluster_id?: string | null;
    action: string;
    resource_type: string;
    resource_id?: string;
    resource_name?: string;
    details?: string | null;
    result: string;
    error_message?: string | null;
    created_at: string;
}

export function insertOperationLog(
    log: Omit<OperationLogRecord, 'id' | 'created_at' | 'details' | 'error_message'> & {
        details?: string;
        error_message?: string;
    },
): void {
    const database = getDatabase();
    const now = new Date().toISOString();
    const stmt = database.prepare(`
    INSERT INTO operation_logs (
      cluster_id, action, resource_type, resource_id, resource_name,
      details, result, error_message, created_at
    ) VALUES (
      @cluster_id, @action, @resource_type, @resource_id, @resource_name,
      @details, @result, @error_message, @created_at
    )
  `);
    try {
        stmt.run({
            ...log,
            details: log.details || null,
            error_message: log.error_message || null,
            created_at: now,
        });
    } catch (error) {
        // 审计是旁路，不能反噬业务：开了外键之后，「消息已发出去、日志却插不进去」
        // 是会真实发生的——删集群与发消息并发时，写日志那一步面对的集群行已经没了，
        // FOREIGN KEY constraint failed 会把一次成功的操作报成失败。
        console.warn('[Database] Operation log write failed:', error instanceof Error ? error.message : error);
    }
}

export function getRecentOperationLogs(limit: number = 50): OperationLogRecord[] {
    const database = getDatabase();
    const stmt = database.prepare('SELECT * FROM operation_logs ORDER BY created_at DESC LIMIT ?');
    return stmt.all(limit) as OperationLogRecord[];
}

// 操作日志自动清理，保留最近的 maxLogs 条记录
export function cleanupOperationLogs(maxLogs: number = 10000): void {
    const database = getDatabase();
    const count = database.prepare('SELECT COUNT(*) as count FROM operation_logs').get() as {count: number};
    if (count.count > maxLogs) {
        const deleteCount = count.count - maxLogs;
        database
            .prepare(
                `DELETE FROM operation_logs
                 WHERE id IN (SELECT id FROM operation_logs ORDER BY created_at ASC LIMIT ?)`,
            )
            .run(deleteCount);
        console.log(`[Database] Cleaned up ${deleteCount} old operation logs`);
    }
}

/**
 * 剪掉没有任何集群引用的 SSH 隧道配置。
 * 集群表单里点一次「测试 SSH 隧道」就会落一条配置，用户随后取消弹窗就留下孤儿行；
 * 应用没有独立的 SSH 配置管理界面，所以启动时按引用清理一次。
 */
export function cleanupOrphanSshTunnels(): number {
    const database = getDatabase();
    const result = database
        .prepare(
            `DELETE FROM ssh_tunnels
             WHERE id NOT IN (SELECT ssh_config_id FROM clusters WHERE ssh_config_id IS NOT NULL)`,
        )
        .run();
    return result.changes;
}
