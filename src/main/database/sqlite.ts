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
const SCHEMA_VERSION = 4;

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
    stmt.run({
        ...log,
        details: log.details || null,
        error_message: log.error_message || null,
        created_at: now,
    });
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
