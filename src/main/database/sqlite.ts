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
const SCHEMA_VERSION = 12;

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
    // v8：监控时序快照表 metrics_snapshots。只加新表、没有旧列要补，
    // 启动时执行的那遍基线 DDL 已经把表建好（CREATE TABLE IF NOT EXISTS 对老库同样生效），
    // 这段留着只为说明 v8 确实做过事，与 v5 同一个理由。
    // v9：告警两张表（alert_rules / alert_events）与那条"一条规则只允许一条未恢复事件"
    // 的偏唯一索引。同样只加表不动旧列，基线语句对老库生效，这里没有数据要修补。
    // v10：K8s 端口转发。k8s_forwards 这张新表靠基线补齐，但 clusters 上的两列是往
    // 已存在的表上加，基线的 CREATE TABLE IF NOT EXISTS 对老库什么都不做——
    // 不 ALTER 的话，老库读集群时拿到 undefined、写集群时直接 no such column，
    // 而且和 v6/v7 同一个坑：新库基线已带这两列，不查表结构就 ALTER 会 duplicate column
    // 把整个启动期迁移顶掉。
    if (from < 10) {
        const columns = database.prepare('PRAGMA table_info(clusters)').all() as {name: string}[];
        if (!columns.some(column => column.name === 'use_k8s_forward')) {
            database.prepare('ALTER TABLE clusters ADD COLUMN use_k8s_forward INTEGER DEFAULT 0').run();
        }
        if (!columns.some(column => column.name === 'k8s_config_id')) {
            database.prepare('ALTER TABLE clusters ADD COLUMN k8s_config_id TEXT').run();
        }
    }
    // v11：巡检历史表 inspections。只加新表、不动任何旧列，启动时那遍基线 DDL
    // 已经把表建好（CREATE TABLE IF NOT EXISTS 对老库同样生效），这里没有数据要修补——
    // 留这段只为说明 v11 确实做过事，与 v5/v8/v9 同一个理由。
    // v12：巡检口径表 inspection_profiles，以及 inspections 上的 thresholds_json 一列。
    // 新表靠基线补齐就行，老列不行——基线的 CREATE TABLE IF NOT EXISTS 对已存在的
    // inspections 什么都不做，不 ALTER 的话写入会 no such column；而新库基线已经带这一列，
    // 不查表结构直接 ALTER 又是 duplicate column，会把整个启动期事务顶掉（与 v10 同一个坑）。
    if (from < 12) {
        const columns = database.prepare('PRAGMA table_info(inspections)').all() as {name: string}[];
        if (!columns.some(column => column.name === 'thresholds_json')) {
            database.prepare('ALTER TABLE inspections ADD COLUMN thresholds_json TEXT').run();
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

    const orphanForwards = cleanupOrphanK8sForwards();
    if (orphanForwards > 0) {
        console.log(`[Database] Cleaned up ${orphanForwards} unreferenced K8s port-forward configs`);
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
    use_k8s_forward: number;
    k8s_config_id?: string;
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
      use_k8s_forward, k8s_config_id,
      admin_api_timeout, status, version, created_at, updated_at
    ) VALUES (
      @id, @name, @service_url, @web_service_url, @auth_plugin, @auth_params,
      @tls_enabled, @tls_trust_certs, @use_ssh_tunnel, @ssh_config_id,
      @use_k8s_forward, @k8s_config_id,
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
    'use_k8s_forward',
    'k8s_config_id',
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

// K8s 端口转发配置（与 SSH 隧道同一角色：集群表单内联录入、按集群独占）
export interface K8sForwardRecord {
    id: string;
    namespace: string;
    resource: string;
    context?: string;
    kubeconfig_path?: string;
    kubectl_path?: string;
    local_admin_port: number;
    local_broker_port: number;
    remote_admin_port: number;
    remote_broker_port: number;
    status: string;
    created_at: string;
    updated_at: string;
}

export function getAllK8sForwards(): K8sForwardRecord[] {
    const database = getDatabase();
    const stmt = database.prepare('SELECT * FROM k8s_forwards ORDER BY created_at DESC');
    return stmt.all() as K8sForwardRecord[];
}

export function getK8sForwardById(id: string): K8sForwardRecord | undefined {
    const database = getDatabase();
    const stmt = database.prepare('SELECT * FROM k8s_forwards WHERE id = ?');
    return stmt.get(id) as K8sForwardRecord | undefined;
}

export function insertK8sForward(forward: Omit<K8sForwardRecord, 'created_at' | 'updated_at'>): void {
    const database = getDatabase();
    const now = new Date().toISOString();
    const stmt = database.prepare(`
    INSERT INTO k8s_forwards (
      id, namespace, resource, context, kubeconfig_path, kubectl_path,
      local_admin_port, local_broker_port, remote_admin_port, remote_broker_port,
      status, created_at, updated_at
    ) VALUES (
      @id, @namespace, @resource, @context, @kubeconfig_path, @kubectl_path,
      @local_admin_port, @local_broker_port, @remote_admin_port, @remote_broker_port,
      @status, @created_at, @updated_at
    )
  `);
    stmt.run({...forward, created_at: now, updated_at: now});
}

const K8S_FORWARD_ALLOWED_FIELDS = new Set([
    'namespace',
    'resource',
    'context',
    'kubeconfig_path',
    'kubectl_path',
    'local_admin_port',
    'local_broker_port',
    'remote_admin_port',
    'remote_broker_port',
    'status',
]);

export function updateK8sForward(id: string, updates: Partial<K8sForwardRecord>): void {
    const database = getDatabase();
    const now = new Date().toISOString();

    for (const key of Object.keys(updates)) {
        if (key !== 'id' && !K8S_FORWARD_ALLOWED_FIELDS.has(key)) {
            throw new Error(`Invalid field for K8s forward update: ${key}`);
        }
    }

    const fields = Object.keys(updates)
        .filter(k => k !== 'id' && K8S_FORWARD_ALLOWED_FIELDS.has(k))
        .map(k => `${k} = @${k}`)
        .join(', ');

    if (fields === '') {
        throw new Error('No valid fields provided for K8s forward update');
    }

    const stmt = database.prepare(`UPDATE k8s_forwards SET ${fields}, updated_at = @updated_at WHERE id = @id`);
    stmt.run({...updates, id, updated_at: now});
}

export function deleteK8sForward(id: string): void {
    const database = getDatabase();
    const stmt = database.prepare('DELETE FROM k8s_forwards WHERE id = ?');
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

// 监控时序快照（metrics_snapshots）。一次轮询采到的是一组同刻数值，所以整行存、
// 不按 metric 拆行——趋势图取的是一个维度的一段区间，行式一次就能拿齐五条序列。
export interface MetricsSnapshotRecord {
    cluster_id: string;
    // 空串 = 集群总体口径；与 message_templates 用空串表示通用作用域同一个约定
    topic_uri: string;
    msg_rate_in: number;
    msg_rate_out: number;
    throughput_in: number;
    throughput_out: number;
    backlog: number;
    producers: number;
    consumers: number;
    // epoch 毫秒：趋势查询按数值比较时间范围
    captured_at: number;
}

// 同一刻重复采到同一口径（手动刷新撞上定时刷新）走 REPLACE，而不是攒两行相同点，
// 否则柱状图会在同一时间轴上并排出两根一模一样的柱子。
export function insertMetricsSnapshot(entry: MetricsSnapshotRecord): void {
    const database = getDatabase();
    database
        .prepare(
            `INSERT OR REPLACE INTO metrics_snapshots (
               cluster_id, topic_uri, msg_rate_in, msg_rate_out, throughput_in, throughput_out,
               backlog, producers, consumers, captured_at
             ) VALUES (
               @cluster_id, @topic_uri, @msg_rate_in, @msg_rate_out, @throughput_in, @throughput_out,
               @backlog, @producers, @consumers, @captured_at
             )`,
        )
        .run(entry);
}

// 取最近 limit 条按倒序截断、再翻回升序返回，渲染层直接当时间轴用。
export function listMetricsSnapshots(
    clusterId: string,
    topicUri: string,
    sinceMs: number,
    limit: number,
): MetricsSnapshotRecord[] {
    const database = getDatabase();
    return (
        database
            .prepare(
                `SELECT cluster_id, topic_uri, msg_rate_in, msg_rate_out, throughput_in, throughput_out,
                        backlog, producers, consumers, captured_at
                 FROM metrics_snapshots
                 WHERE cluster_id = ? AND topic_uri = ? AND captured_at >= ?
                 ORDER BY captured_at DESC LIMIT ?`,
            )
            .all(clusterId, topicUri, sinceMs, limit) as MetricsSnapshotRecord[]
    ).reverse();
}

// 保留策略：先按天数清，再按总行数兜底。采样间隔跟着监控页的刷新节奏走（最快几秒一点），
// 只按天数清的话极端设置下一周能攒几十万行；行数上限是最后一道闸。
export function cleanupMetricsSnapshots(retentionDays: number, maxRows: number = 200_000): number {
    const database = getDatabase();
    const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
    const byAge = database.prepare('DELETE FROM metrics_snapshots WHERE captured_at < ?').run(cutoff);
    const count = database.prepare('SELECT COUNT(*) as count FROM metrics_snapshots').get() as {count: number};
    let byRows = 0;
    if (count.count > maxRows) {
        byRows = database
            .prepare(
                `DELETE FROM metrics_snapshots
                 WHERE id IN (SELECT id FROM metrics_snapshots ORDER BY captured_at ASC LIMIT ?)`,
            )
            .run(count.count - maxRows).changes;
    }
    return byAge.changes + byRows;
}

// ========== 告警规则 ==========
// 规则整行读写：界面每次提交的是完整草稿（作用域、指标、阈值、开关一起），
// 所以更新走"全列 SET"而不是动态拼字段——列名固定，也就不需要字段白名单。

export interface AlertRuleRecord {
    id: string;
    cluster_id: string;
    name: string;
    // SQLite 没有布尔列，0/1 存、由 handler 解回 boolean
    enabled: number;
    scope: string;
    tenant: string;
    namespace: string;
    topic: string;
    persistent: number;
    metric: string;
    comparator: string;
    threshold: number;
    consecutive: number;
    notify: number;
    created_at: string;
    updated_at: string;
}

// 主键与时间戳由调用方/DAO 分别补：id 在 handler 里生成（更新时它来自入参，
// 且 UPDATE 语句不该改主键），时间戳一律由 DAO 写当前时间。
export type AlertRuleWrite = Omit<AlertRuleRecord, 'id' | 'created_at' | 'updated_at'>;

export function listAlertRules(): AlertRuleRecord[] {
    const database = getDatabase();
    return database
        .prepare('SELECT * FROM alert_rules ORDER BY cluster_id, created_at DESC')
        .all() as AlertRuleRecord[];
}

export function getAlertRuleById(id: string): AlertRuleRecord | undefined {
    const database = getDatabase();
    return database.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id) as AlertRuleRecord | undefined;
}

export function insertAlertRule(rule: AlertRuleWrite & {id: string}): void {
    const database = getDatabase();
    const now = new Date().toISOString();
    database
        .prepare(
            `INSERT INTO alert_rules (
               id, cluster_id, name, enabled, scope, tenant, namespace, topic, persistent,
               metric, comparator, threshold, consecutive, notify, created_at, updated_at
             ) VALUES (
               @id, @cluster_id, @name, @enabled, @scope, @tenant, @namespace, @topic, @persistent,
               @metric, @comparator, @threshold, @consecutive, @notify, @created_at, @updated_at
             )`,
        )
        .run({...rule, created_at: now, updated_at: now});
}

export function updateAlertRule(id: string, rule: AlertRuleWrite): void {
    const database = getDatabase();
    const now = new Date().toISOString();
    database
        .prepare(
            `UPDATE alert_rules SET
               cluster_id = @cluster_id, name = @name, enabled = @enabled, scope = @scope,
               tenant = @tenant, namespace = @namespace, topic = @topic, persistent = @persistent,
               metric = @metric, comparator = @comparator, threshold = @threshold,
               consecutive = @consecutive, notify = @notify, updated_at = @updated_at
             WHERE id = @id`,
        )
        .run({...rule, id, updated_at: now});
}

export function deleteAlertRule(id: string): void {
    const database = getDatabase();
    // 事件行靠 alert_events.rule_id 的 CASCADE 一起走：删掉规则 = "这个告警我不再关心"，
    // 留下一堆指向空规则的历史只会让事件列表读不懂。
    database.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
}

// ========== 告警事件 ==========

export interface AlertEventRecord {
    id: number;
    rule_id: string;
    cluster_id: string;
    rule_name: string;
    scope_label: string;
    metric: string;
    comparator: string;
    threshold: number;
    value: number;
    last_value: number;
    state: string;
    message: string;
    fired_at: number;
    last_seen_at: number;
    resolved_at: number | null;
    acked_at: number | null;
}

export function insertAlertEvent(event: Omit<AlertEventRecord, 'id'>): number {
    const database = getDatabase();
    const result = database
        .prepare(
            `INSERT INTO alert_events (
               rule_id, cluster_id, rule_name, scope_label, metric, comparator, threshold,
               value, last_value, state, message, fired_at, last_seen_at, resolved_at, acked_at
             ) VALUES (
               @rule_id, @cluster_id, @rule_name, @scope_label, @metric, @comparator, @threshold,
               @value, @last_value, @state, @message, @fired_at, @last_seen_at, @resolved_at, @acked_at
             )`,
        )
        .run({...event, resolved_at: event.resolved_at ?? null, acked_at: event.acked_at ?? null});
    return Number(result.lastInsertRowid);
}

// 未恢复事件按规则查：引擎每轮都要知道"这条规则现在是不是已经立案了"，
// 靠它决定是刷新观测值还是新建事件（也是那条偏唯一索引的另一半）。
export function getOpenAlertEvent(ruleId: string): AlertEventRecord | undefined {
    const database = getDatabase();
    return database
        .prepare('SELECT * FROM alert_events WHERE rule_id = ? AND resolved_at IS NULL ORDER BY fired_at DESC LIMIT 1')
        .get(ruleId) as AlertEventRecord | undefined;
}

export function getAlertEventById(id: number): AlertEventRecord | undefined {
    const database = getDatabase();
    return database.prepare('SELECT * FROM alert_events WHERE id = ?').get(id) as AlertEventRecord | undefined;
}

export interface AlertEventFilter {
    clusterId?: string;
    state?: 'firing' | 'resolved';
    limit: number;
}

export function listAlertEvents(filter: AlertEventFilter): AlertEventRecord[] {
    const database = getDatabase();
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.clusterId) {
        conditions.push('cluster_id = ?');
        params.push(filter.clusterId);
    }
    if (filter.state) {
        // 状态用 resolved_at 判而不是 state 列：两者由同一段代码写，但只有一份能当真相
        conditions.push(filter.state === 'resolved' ? 'resolved_at IS NOT NULL' : 'resolved_at IS NULL');
    }
    params.push(filter.limit);
    return database
        .prepare(
            `SELECT * FROM alert_events
             ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
             ORDER BY fired_at DESC LIMIT ?`,
        )
        .all(...params) as AlertEventRecord[];
}

// 未恢复期间只刷新观测值与时间：规则一直超标时用户看到的是一条越来越新的记录，
// 而不是每轮多一条重复事件。
export function observeAlertEvent(id: number, lastValue: number, seenAt: number): void {
    const database = getDatabase();
    database
        .prepare('UPDATE alert_events SET last_value = ?, last_seen_at = ? WHERE id = ?')
        .run(lastValue, seenAt, id);
}

export function resolveAlertEvent(id: number, lastValue: number, seenAt: number): void {
    const database = getDatabase();
    database
        .prepare(
            "UPDATE alert_events SET state = 'resolved', resolved_at = ?, last_value = ?," +
                ' last_seen_at = ? WHERE id = ?',
        )
        .run(seenAt, lastValue, seenAt, id);
}

export function ackAlertEvents(ids: number[], ackedAt: number): number {
    if (ids.length === 0) {
        return 0;
    }
    const database = getDatabase();
    const placeholders = ids.map(() => '?').join(', ');
    return database
        .prepare(`UPDATE alert_events SET acked_at = ? WHERE id IN (${placeholders}) AND acked_at IS NULL`)
        .run(ackedAt, ...ids).changes;
}

export function deleteAlertEvents(ids: number[]): number {
    if (ids.length === 0) {
        return 0;
    }
    const database = getDatabase();
    const placeholders = ids.map(() => '?').join(', ');
    return database.prepare(`DELETE FROM alert_events WHERE id IN (${placeholders})`).run(...ids).changes;
}

// 保留策略只动已恢复的事件：未恢复的那条无论多久都是"现在还烧着"，删了就等于把故障藏起来。
// 行数上限是最后一道闸（清完仍超限时按最旧的先走，含未恢复的，引擎下一轮会重新立案）。
export function cleanupAlertEvents(retentionDays: number, maxRows: number = 20_000): number {
    const database = getDatabase();
    const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
    const byAge = database
        .prepare('DELETE FROM alert_events WHERE resolved_at IS NOT NULL AND resolved_at < ?')
        .run(cutoff).changes;
    const count = database.prepare('SELECT COUNT(*) as count FROM alert_events').get() as {count: number};
    let byRows = 0;
    if (count.count > maxRows) {
        byRows = database
            .prepare(
                `DELETE FROM alert_events
                 WHERE id IN (SELECT id FROM alert_events ORDER BY fired_at ASC LIMIT ?)`,
            )
            .run(count.count - maxRows).changes;
    }
    return byAge + byRows;
}

export function countOpenAlertEvents(): number {
    const database = getDatabase();
    const row = database.prepare('SELECT COUNT(*) as count FROM alert_events WHERE resolved_at IS NULL').get() as {
        count: number;
    };
    return row.count;
}

// ========== 巡检历史 ==========

export interface InspectionRecord {
    id: string;
    cluster_id: string;
    cluster_name: string;
    version: string | null;
    generated_at: string;
    crit: number;
    warn: number;
    ok: number;
    skip: number;
    scope_json: string;
    checks_json: string;
    /** 当次生效的判定口径；v2.8 之前存的行为 null，含义是「口径未知」而不是「用的默认值」。 */
    thresholds_json: string | null;
    markdown: string;
}

/** 历史列表用的行：不带 checks_json / markdown，一屏几十行不去解析整份报告。 */
export type InspectionListRow = Omit<InspectionRecord, 'checks_json' | 'markdown' | 'thresholds_json'>;

const INSPECTION_LIST_COLUMNS = 'id, cluster_id, cluster_name, version, generated_at, crit, warn, ok, skip, scope_json';

export function insertInspection(record: InspectionRecord): void {
    const database = getDatabase();
    database
        .prepare(
            `INSERT INTO inspections (
               id, cluster_id, cluster_name, version, generated_at, crit, warn, ok, skip,
               scope_json, checks_json, thresholds_json, markdown
             ) VALUES (
               @id, @cluster_id, @cluster_name, @version, @generated_at, @crit, @warn, @ok, @skip,
               @scope_json, @checks_json, @thresholds_json, @markdown
             )`,
        )
        .run({...record, version: record.version ?? null, thresholds_json: record.thresholds_json ?? null});
}

export function listInspections(clusterId: string, limit: number): InspectionListRow[] {
    const database = getDatabase();
    return database
        .prepare(
            `SELECT ${INSPECTION_LIST_COLUMNS} FROM inspections
             WHERE cluster_id = ? ORDER BY generated_at DESC LIMIT ?`,
        )
        .all(clusterId, limit) as InspectionListRow[];
}

export function getInspectionById(id: string): InspectionRecord | undefined {
    const database = getDatabase();
    return database.prepare('SELECT * FROM inspections WHERE id = ?').get(id) as InspectionRecord | undefined;
}

/**
 * 环比要的前一份：同集群、在本次之前、排除本次自己。
 * 按 generated_at 而不是 id 排序——id 是随机 uuid，历史两份的写入先后与它的字典序无关。
 */
export function getPreviousInspection(
    clusterId: string,
    generatedAt: string,
    excludeId: string,
): InspectionRecord | undefined {
    const database = getDatabase();
    return database
        .prepare(
            `SELECT * FROM inspections
             WHERE cluster_id = ? AND id <> ? AND generated_at < ?
             ORDER BY generated_at DESC LIMIT 1`,
        )
        .get(clusterId, excludeId, generatedAt) as InspectionRecord | undefined;
}

/** 只留最近 keep 份：一次巡检写入几十 MB 不至于，但一天点几十次、几百个集群攒起来没人收。 */
export function pruneInspections(clusterId: string, keep: number): number {
    const database = getDatabase();
    return database
        .prepare(
            `DELETE FROM inspections
             WHERE cluster_id = ?
               AND id NOT IN (SELECT id FROM inspections WHERE cluster_id = ? ORDER BY generated_at DESC LIMIT ?)`,
        )
        .run(clusterId, clusterId, keep).changes;
}

export function deleteInspections(clusterId: string): number {
    const database = getDatabase();
    return database.prepare('DELETE FROM inspections WHERE cluster_id = ?').run(clusterId).changes;
}

// ========== 巡检口径 ==========

export interface InspectionProfileRecord {
    cluster_id: string;
    thresholds_json: string;
    max_namespaces: number;
    max_topics: number;
    updated_at: string;
}

/**
 * 一簇一行，所以是 upsert 而不是 insert：主键就是 cluster_id。
 * 集群不存在时外键直接抛错，界面上因此不可能把口径配到一台不存在的集群上。
 */
export function upsertInspectionProfile(record: InspectionProfileRecord): void {
    const database = getDatabase();
    database
        .prepare(
            `INSERT INTO inspection_profiles (
               cluster_id, thresholds_json, max_namespaces, max_topics, updated_at
             ) VALUES (
               @cluster_id, @thresholds_json, @max_namespaces, @max_topics, @updated_at
             )
             ON CONFLICT(cluster_id) DO UPDATE SET
               thresholds_json = excluded.thresholds_json,
               max_namespaces = excluded.max_namespaces,
               max_topics = excluded.max_topics,
               updated_at = excluded.updated_at`,
        )
        .run(record);
}

export function getInspectionProfile(clusterId: string): InspectionProfileRecord | undefined {
    const database = getDatabase();
    return database.prepare('SELECT * FROM inspection_profiles WHERE cluster_id = ?').get(clusterId) as
        InspectionProfileRecord | undefined;
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

/**
 * 剪掉没有任何集群引用的 K8s 转发配置。理由与 SSH 隧道那条完全一样：
 * 点一次「测试端口转发」就落一行，用户随后取消弹窗就留下没人引用的行。
 */
export function cleanupOrphanK8sForwards(): number {
    const database = getDatabase();
    const result = database
        .prepare(
            `DELETE FROM k8s_forwards
             WHERE id NOT IN (SELECT k8s_config_id FROM clusters WHERE k8s_config_id IS NOT NULL)`,
        )
        .run();
    return result.changes;
}
