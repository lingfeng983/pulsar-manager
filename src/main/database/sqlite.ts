import Database from 'better-sqlite3';
import path from 'path';
import {app} from 'electron';
import fs from 'fs';
import {SCHEMA_SQL} from './schema';
import type {InspectionSource} from '../../shared/types';

// 数据库实例
let db: Database.Database | null = null;

// schema 版本以 user_version 跟踪。改基线 DDL 时：升 SCHEMA_VERSION，
// 并把该版本的增量 DDL 写进 migrate()——CREATE TABLE IF NOT EXISTS 对已存在的
// 旧库什么都不做，没有这套机制，加列只会对新装用户生效，旧库静默落后。
const SCHEMA_VERSION = 16;

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
    // v13：定时巡检。inspection_schedules 靠基线补齐；inspections 上多一个 source 列，
    // 老库必须 ALTER——不 ALTER 的话写入直接 no such column，而新库基线已带这一列，
    // 不查表结构就 ALTER 又是 duplicate column 顶掉整个启动事务（与 v10/v12 同一个坑）。
    // 默认值 'manual' 是给老行补的：v3.1 之前没有定时这条路，历史上每一份都只能是手点的。
    if (from < 13) {
        const columns = database.prepare('PRAGMA table_info(inspections)').all() as {name: string}[];
        if (!columns.some(column => column.name === 'source')) {
            database.prepare("ALTER TABLE inspections ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'").run();
        }
    }
    // v14：外部通知渠道。notify_channels / notify_deliveries 都是新表，靠每次启动的幂等基线
    // 补齐，这里没有数据要修补——老库里这两张表本来不存在，也没有任何东西引用过它们，
    // 不存在「老行缺列」这种状态。留这一段是为了下次翻 user_version 不必回头猜 v14 做没做事
    // （与 v5 同一口径）。
    // v15：邮件渠道。notify_mail_profiles 是新表（基线补齐就行），但 notify_channels 上多了
    // mail_profile_id 与 recipients 两列——v14 的库已经有渠道行了，基线那句
    // CREATE TABLE IF NOT EXISTS 对已存在的表什么都不做，不 ALTER 的话读渠道拿到 undefined、
    // 写渠道直接 no such column；而新库基线已带这两列，不查表结构就 ALTER 又是 duplicate
    // column 顶掉整个启动事务（与 v10/v12/v13 同一个坑）。
    // recipients 用 NOT NULL DEFAULT ''：ALTER 给老行补的就是这个默认值，而不是要事后
    // 逐行 UPDATE 一遍——非邮件渠道永远不该有收件人，空串正是「没有」的那个写法。
    if (from < 15) {
        const columns = database.prepare('PRAGMA table_info(notify_channels)').all() as {name: string}[];
        if (!columns.some(column => column.name === 'mail_profile_id')) {
            database.prepare('ALTER TABLE notify_channels ADD COLUMN mail_profile_id TEXT').run();
        }
        if (!columns.some(column => column.name === 'recipients')) {
            database.prepare("ALTER TABLE notify_channels ADD COLUMN recipients TEXT NOT NULL DEFAULT ''").run();
        }
    }
    // v16：SSH 主机密钥指纹。新库基线已带这一列；老库必须 ALTER，否则连接时
    // 读写这一列会 no such column，而新库直接 ALTER 又会 duplicate column
    // 顶掉整个启动事务（与 v6/v7/v10/v12/v13/v15 同一个坑）。
    if (from < 16) {
        const columns = database.prepare('PRAGMA table_info(ssh_tunnels)').all() as {name: string}[];
        if (!columns.some(column => column.name === 'host_fingerprint')) {
            database.prepare('ALTER TABLE ssh_tunnels ADD COLUMN host_fingerprint TEXT').run();
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
    host_fingerprint?: string;
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
      remote_broker_port, host_fingerprint, status, created_at, updated_at
    ) VALUES (
      @id, @host, @port, @username, @auth_type, @password, @private_key, @passphrase,
      @local_admin_port, @local_broker_port, @remote_host, @remote_admin_port,
      @remote_broker_port, @host_fingerprint, @status, @created_at, @updated_at
    )
  `);
    stmt.run({...tunnel, host_fingerprint: tunnel.host_fingerprint ?? null, created_at: now, updated_at: now});
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
    'host_fingerprint',
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

export function insertMessageTemplate(template: Omit<MessageTemplateRecord, 'created_at' | 'updated_at'>): void {
    const database = getDatabase();
    const now = new Date().toISOString();
    const stmt = database.prepare(`
    INSERT INTO message_templates (
      id, cluster_id, topic_uri, name, body, variables_json, properties_json,
      producer_options_json, schema_mode, schema_json, created_at, updated_at
    ) VALUES (
      @id, @cluster_id, @topic_uri, @name, @body, @variables_json, @properties_json,
      @producer_options_json, @schema_mode, @schema_json, @created_at, @updated_at
    )
  `);
    stmt.run({
        ...template,
        // schema 原文没内容时存 NULL 而不是空串：'inline 但 schema 是空的'这种
        // 半配置状态在列上必须看得出来，空串会被读成"存过 schema"。
        schema_json: template.schema_json ?? null,
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

// 消费者会话配置（消费者工作台）
export interface ConsumerSessionConfigRecord {
    id: string;
    cluster_id: string;
    topic_uri: string;
    subscription: string;
    name: string;
    config_json: string;
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
    config: Omit<ConsumerSessionConfigRecord, 'created_at' | 'updated_at'>,
): void {
    const database = getDatabase();
    const now = new Date().toISOString();
    const stmt = database.prepare(`
    INSERT INTO consumer_session_configs (
      id, cluster_id, topic_uri, subscription, name, config_json, created_at, updated_at
    ) VALUES (
      @id, @cluster_id, @topic_uri, @subscription, @name, @config_json, @created_at, @updated_at
    )
  `);
    stmt.run({
        ...config,
        created_at: now,
        updated_at: now,
    });
}

const CONSUMER_CONFIG_ALLOWED_FIELDS = new Set(['cluster_id', 'topic_uri', 'subscription', 'name', 'config_json']);

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
    /** 手点的还是定时跑的；v3.1 之前的行由迁移补成 manual。 */
    source: InspectionSource;
    markdown: string;
}

/** 历史列表用的行：不带 checks_json / markdown，一屏几十行不去解析整份报告。 */
export type InspectionListRow = Omit<InspectionRecord, 'checks_json' | 'markdown' | 'thresholds_json'>;

const INSPECTION_LIST_COLUMNS =
    'id, cluster_id, cluster_name, version, generated_at, crit, warn, ok, skip, scope_json, source';

export function insertInspection(record: InspectionRecord): void {
    const database = getDatabase();
    database
        .prepare(
            `INSERT INTO inspections (
               id, cluster_id, cluster_name, version, generated_at, crit, warn, ok, skip,
               scope_json, checks_json, thresholds_json, source, markdown
             ) VALUES (
               @id, @cluster_id, @cluster_name, @version, @generated_at, @crit, @warn, @ok, @skip,
               @scope_json, @checks_json, @thresholds_json, @source, @markdown
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

/** 汇总要的那份行：比历史列表多带 checks_json（跨集群分组要用），但仍旧不带 markdown。 */
export type InspectionLatestRow = Omit<InspectionRecord, 'markdown'>;

/**
 * 每台集群最近的一份报告。
 *
 * 一条 SQL 而不是按集群循环查：汇总页打开就要跑，几十台集群几十次查询会明显卡一下界面。
 * generated_at 完全相同的两份（同一毫秒里手点一次、定时一次）会各出一行，
 * 由调用方按 cluster_id 去重——这里不 DISTINCT，因为要保住的列不止一个。
 */
export function listLatestInspections(): InspectionLatestRow[] {
    const database = getDatabase();
    return database
        .prepare(
            `SELECT i.id, i.cluster_id, i.cluster_name, i.version, i.generated_at,
                    i.crit, i.warn, i.ok, i.skip, i.scope_json, i.checks_json, i.thresholds_json, i.source
             FROM inspections i
             JOIN (
               SELECT cluster_id, MAX(generated_at) AS generated_at
               FROM inspections
               GROUP BY cluster_id
             ) t ON t.cluster_id = i.cluster_id AND t.generated_at = i.generated_at
             ORDER BY i.cluster_id`,
        )
        .all() as InspectionLatestRow[];
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

// ========== 定时巡检 ==========

export interface InspectionScheduleRecord {
    cluster_id: string;
    enabled: number;
    interval_minutes: number;
    notify_on_crit: number;
    last_run_at: string | null;
    last_error: string | null;
    last_notified_crit: number;
    updated_at: string;
}

/**
 * 保存的是配置四列，运行期三列（last_run_at / last_error / last_notified_crit）在更新分支里
 * 刻意不写：改一次间隔不该把「上次什么时候跑的」抹成空，否则刚存完配置就立刻又到期、
 * 又跑一遍，而且上一轮的通知去重依据也没了。首次插入时这三列由调用方给默认值。
 */
export function upsertInspectionSchedule(record: InspectionScheduleRecord): void {
    const database = getDatabase();
    database
        .prepare(
            `INSERT INTO inspection_schedules (
               cluster_id, enabled, interval_minutes, notify_on_crit,
               last_run_at, last_error, last_notified_crit, updated_at
             ) VALUES (
               @cluster_id, @enabled, @interval_minutes, @notify_on_crit,
               @last_run_at, @last_error, @last_notified_crit, @updated_at
             )
             ON CONFLICT(cluster_id) DO UPDATE SET
               enabled = excluded.enabled,
               interval_minutes = excluded.interval_minutes,
               notify_on_crit = excluded.notify_on_crit,
               updated_at = excluded.updated_at`,
        )
        .run(record);
}

export function getInspectionSchedule(clusterId: string): InspectionScheduleRecord | undefined {
    const database = getDatabase();
    return database.prepare('SELECT * FROM inspection_schedules WHERE cluster_id = ?').get(clusterId) as
        InspectionScheduleRecord | undefined;
}

export function listInspectionSchedules(): InspectionScheduleRecord[] {
    const database = getDatabase();
    return database
        .prepare('SELECT * FROM inspection_schedules ORDER BY cluster_id')
        .all() as InspectionScheduleRecord[];
}

/** 引擎每轮只要开着的那几行：一簇一行、总量等于集群数，不必为它建索引。 */
export function listEnabledInspectionSchedules(): InspectionScheduleRecord[] {
    const database = getDatabase();
    return database
        .prepare('SELECT * FROM inspection_schedules WHERE enabled = 1 ORDER BY cluster_id')
        .all() as InspectionScheduleRecord[];
}

/**
 * 跑完一轮之后的回写。用 UPDATE 而不是 upsert：调度行可能在这一轮跑的过程中被删掉
 * （集群删了、级联删了这行），此时该什么都不写，而不是替一台不存在的集群复活一行调度。
 */
export function markInspectionScheduleRun(
    clusterId: string,
    args: {ranAt: string; error: string | null; notifiedCrit: number | null},
): void {
    const database = getDatabase();
    database
        .prepare(
            `UPDATE inspection_schedules
             SET last_run_at = @ranAt,
                 last_error = @error,
                 last_notified_crit = COALESCE(@notifiedCrit, last_notified_crit)
             WHERE cluster_id = @clusterId`,
        )
        .run({ranAt: args.ranAt, error: args.error, notifiedCrit: args.notifiedCrit, clusterId});
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

// ========== 邮件服务器（SMTP）配置 ==========

export interface MailProfileRecord {
    id: string;
    name: string;
    host: string;
    port: number;
    security: string;
    /** 用户名原文：它不是凭据（信头里本来就看得见），但出界时仍按长度打码。 */
    username: string;
    /** 密码只以密文经过这一层；渲染层拿到的是 hasPassword 这一个布尔值。 */
    password_enc: string | null;
    from_address: string;
    from_name: string;
    allow_self_signed: number;
    created_at: string;
    updated_at: string;
}

const MAIL_PROFILE_COLUMNS =
    'id, name, host, port, security, username, password_enc, from_address, from_name, ' +
    'allow_self_signed, created_at, updated_at';

export function listMailProfiles(): MailProfileRecord[] {
    const database = getDatabase();
    return database
        .prepare(`SELECT ${MAIL_PROFILE_COLUMNS} FROM notify_mail_profiles ORDER BY created_at, name`)
        .all() as MailProfileRecord[];
}

export function getMailProfileById(id: string): MailProfileRecord | null {
    const database = getDatabase();
    const row = database.prepare(`SELECT ${MAIL_PROFILE_COLUMNS} FROM notify_mail_profiles WHERE id = ?`).get(id) as
        MailProfileRecord | undefined;
    return row ?? null;
}

export function insertMailProfile(record: MailProfileRecord): void {
    const database = getDatabase();
    database
        .prepare(
            `INSERT INTO notify_mail_profiles (${MAIL_PROFILE_COLUMNS})
             VALUES (@id, @name, @host, @port, @security, @username, @password_enc, @from_address,
                     @from_name, @allow_self_signed, @created_at, @updated_at)`,
        )
        .run(record);
}

/** 整行覆盖（不含 created_at）：与 notify_channels 同一口径，被别的窗口删掉的配置不复活。 */
export function updateMailProfile(record: MailProfileRecord): number {
    const database = getDatabase();
    return database
        .prepare(
            `UPDATE notify_mail_profiles
             SET name = @name, host = @host, port = @port, security = @security, username = @username,
                 password_enc = @password_enc, from_address = @from_address, from_name = @from_name,
                 allow_self_signed = @allow_self_signed, updated_at = @updated_at
             WHERE id = @id`,
        )
        .run(record).changes;
}

/**
 * 删掉一台服务器。
 *
 * 不级联删除渠道（notify_channels.mail_profile_id 故意没有外键）：正在用它的渠道会变成
 * 「这台邮件服务器已经不在了」那一条 skip 记录，而不是从列表里消失。
 */
export function deleteMailProfile(id: string): number {
    const database = getDatabase();
    return database.prepare('DELETE FROM notify_mail_profiles WHERE id = ?').run(id).changes;
}

/** 还有几条邮件渠道指着这一台：删除前的提示要用它，「删了没事」与「有 3 条渠道会立刻发不出去」是两句话。 */
export function countNotifyChannelsUsingMailProfile(id: string): number {
    const database = getDatabase();
    const row = database.prepare('SELECT COUNT(*) AS n FROM notify_channels WHERE mail_profile_id = ?').get(id) as {
        n: number;
    };
    return row.n;
}

// ========== 外部通知渠道 ==========

export interface NotifyChannelRecord {
    id: string;
    name: string;
    kind: string;
    /** 完整地址的密文。这一列没有任何读取方能拿到明文——出界的地方只给打码后的地址。邮件渠道为空串。 */
    url_enc: string;
    secret_enc: string | null;
    /** 邮件渠道指向的 notify_mail_profiles.id；没有外键，删掉服务器时这里会变成一句投递记录里的原因。 */
    mail_profile_id: string | null;
    /** 邮件渠道的收件人原文（分隔符随意）；解析与校验在 shared/notify-mail.ts。 */
    recipients: string;
    enabled: number;
    events_json: string;
    min_level: string;
    timeout_ms: number;
    rate_per_minute: number;
    last_sent_at: string | null;
    last_error: string | null;
    fail_count: number;
    created_at: string;
    updated_at: string;
}

const NOTIFY_CHANNEL_COLUMNS =
    'id, name, kind, url_enc, secret_enc, mail_profile_id, recipients, enabled, events_json, min_level, ' +
    'timeout_ms, rate_per_minute, last_sent_at, last_error, fail_count, created_at, updated_at';

export function listNotifyChannels(): NotifyChannelRecord[] {
    const database = getDatabase();
    return database
        .prepare(`SELECT ${NOTIFY_CHANNEL_COLUMNS} FROM notify_channels ORDER BY created_at, name`)
        .all() as NotifyChannelRecord[];
}

export function getNotifyChannelById(id: string): NotifyChannelRecord | null {
    const database = getDatabase();
    const row = database.prepare(`SELECT ${NOTIFY_CHANNEL_COLUMNS} FROM notify_channels WHERE id = ?`).get(id) as
        NotifyChannelRecord | undefined;
    return row ?? null;
}

export function insertNotifyChannel(record: NotifyChannelRecord): void {
    const database = getDatabase();
    database
        .prepare(
            `INSERT INTO notify_channels (${NOTIFY_CHANNEL_COLUMNS})
             VALUES (@id, @name, @kind, @url_enc, @secret_enc, @mail_profile_id, @recipients, @enabled,
                     @events_json, @min_level, @timeout_ms, @rate_per_minute, @last_sent_at, @last_error,
                     @fail_count, @created_at, @updated_at)`,
        )
        .run(record);
}

/**
 * 整行覆盖（不含 created_at）。
 *
 * 只 UPDATE 不 upsert：调用方拿到 id 就必须先确认这一行存在，否则一条被别的窗口删掉的渠道
 * 会被这里悄悄写回来，而那个 id 是别人手里的——与 clusters 上那套按 owner 校验同一个理由。
 */
export function updateNotifyChannel(record: NotifyChannelRecord): number {
    const database = getDatabase();
    return database
        .prepare(
            `UPDATE notify_channels
             SET name = @name, kind = @kind, url_enc = @url_enc, secret_enc = @secret_enc,
                 mail_profile_id = @mail_profile_id, recipients = @recipients,
                 enabled = @enabled, events_json = @events_json, min_level = @min_level,
                 timeout_ms = @timeout_ms, rate_per_minute = @rate_per_minute, updated_at = @updated_at
             WHERE id = @id`,
        )
        .run(record).changes;
}

export function deleteNotifyChannel(id: string): number {
    const database = getDatabase();
    // 投递记录跟着外键一起删：留着指向不存在渠道的行，界面上只能说「这条记录没有主人」
    return database.prepare('DELETE FROM notify_channels WHERE id = ?').run(id).changes;
}

/**
 * 把一次投递的结论写回渠道：成功就清掉连败计数并盖时间，失败就累加并留下原因。
 *
 * 时间一律由调用方给（不是 datetime('now')）：这条更新要和投递记录行用同一个时刻，
 * 否则「最近一次」与「最近一条投递」在边界上会互相说不上一致。
 */
export function markNotifyChannelResult(id: string, args: {ok: boolean; message: string; at: string}): void {
    const database = getDatabase();
    if (args.ok) {
        database
            .prepare(
                `UPDATE notify_channels
                 SET last_sent_at = ?, last_error = NULL, fail_count = 0, updated_at = ?
                 WHERE id = ?`,
            )
            .run(args.at, args.at, id);
        return;
    }
    database
        .prepare(
            `UPDATE notify_channels
             SET last_error = ?, fail_count = fail_count + 1, updated_at = ?
             WHERE id = ?`,
        )
        .run(args.message.slice(0, 500), args.at, id);
}

export interface NotifyDeliveryRecord {
    /** 自增主键：界面上「最近投递」那一段用它做行 key 与「这一条之后没有更新的了」的判断 */
    id: number;
    channel_id: string;
    channel_name: string;
    event_kind: string;
    level: string;
    ok: number;
    skipped: number;
    message: string;
    created_at: string;
}

export function insertNotifyDelivery(record: Omit<NotifyDeliveryRecord, 'id'>): number {
    const database = getDatabase();
    return database
        .prepare(
            `INSERT INTO notify_deliveries
             (channel_id, channel_name, event_kind, level, ok, skipped, message, created_at)
             VALUES (@channel_id, @channel_name, @event_kind, @level, @ok, @skipped, @message, @created_at)`,
        )
        .run(record).lastInsertRowid as number;
}

export function listNotifyDeliveries(limit: number): NotifyDeliveryRecord[] {
    const database = getDatabase();
    return database
        .prepare(
            `SELECT id, channel_id, channel_name, event_kind, level, ok, skipped, message, created_at
             FROM notify_deliveries
             ORDER BY id DESC
             LIMIT ?`,
        )
        .all(limit) as NotifyDeliveryRecord[];
}

/**
 * 只留最近 keep 条。这张表是唯一随告警频率一直长的：一条每分钟都在触发的规则，
 * 一天就是上千行，而没人会去看三个月前那次投递成功还是失败。
 */
export function pruneNotifyDeliveries(keep: number): number {
    const database = getDatabase();
    return database
        .prepare(
            `DELETE FROM notify_deliveries
             WHERE id NOT IN (SELECT id FROM notify_deliveries ORDER BY id DESC LIMIT ?)`,
        )
        .run(keep).changes;
}

/** 表格里那个开关：单独一条 UPDATE，而不是把整行 draft 送回去再拼一遍——开关不该有清空地址的机会。 */
export function setNotifyChannelEnabled(id: string, enabled: boolean): number {
    const database = getDatabase();
    return database
        .prepare('UPDATE notify_channels SET enabled = ?, updated_at = ? WHERE id = ?')
        .run(enabled ? 1 : 0, new Date().toISOString(), id).changes;
}
