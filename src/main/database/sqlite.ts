import Database from 'better-sqlite3';
import path from 'path';
import {app} from 'electron';
import fs from 'fs';

// 数据库实例
let db: Database.Database | null = null;

// 获取数据库文件路径
function getDatabasePath(): string {
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'pulsar-manager.db');
}

// 获取 schema 文件路径
function getSchemaPath(): string {
    // 在开发模式下，__dirname 指向 dist/src/main/database
    // 需要回溯到 src/main/database/schema.sql
    const isDevelopment = process.env.NODE_ENV === 'development' || !app.isPackaged;

    if (isDevelopment) {
        // 开发模式：从 src 目录读取
        return path.join(__dirname, '..', '..', '..', 'src', 'main', 'database', 'schema.sql');
    } else {
        // 生产模式：从 dist 目录读取
        return path.join(__dirname, 'schema.sql');
    }
}

// 初始化数据库
export function initDatabase(): Database.Database {
    if (db) {
        return db;
    }

    const dbPath = getDatabasePath();
    const schemaPath = getSchemaPath();

    // 确保目录存在
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, {recursive: true});
    }

    console.log('[Database] Initializing database at:', dbPath);

    // 创建数据库连接
    db = new Database(dbPath, {
        verbose: process.env.NODE_ENV === 'development' ? console.log : undefined,
    });

    // 启用 WAL 模式，提升并发性能
    db.pragma('journal_mode = WAL');

    // 执行 schema 初始化
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    db.exec(schema);

    console.log('[Database] Database initialized successfully');

    // 启动时清理过期操作日志
    cleanupOperationLogs();

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
    cluster_id?: string;
    action: string;
    resource_type: string;
    resource_id?: string;
    resource_name?: string;
    details?: string;
    result: string;
    error_message?: string;
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
                'DELETE FROM operation_logs WHERE id IN (SELECT id FROM operation_logs ORDER BY created_at ASC LIMIT ?)',
            )
            .run(deleteCount);
        console.log(`[Database] Cleaned up ${deleteCount} old operation logs`);
    }
}
