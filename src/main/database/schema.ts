// 数据库基线 DDL 以模块常量存在，而不是外部 .sql 文件：tsc 不会拷贝 .sql，
// 走文件读取的话打包产物里带的就是某次手工复制进 dist 的旧基线（实测新库
// 建出了早已废弃的表，而干净环境构建直接 ENOENT 打不开界面）。
// 所有语句必须幂等：每次启动都会执行一遍基线，再按 user_version 补做迁移。
export const SCHEMA_SQL = `
-- 集群配置表
CREATE TABLE IF NOT EXISTS clusters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    service_url TEXT NOT NULL,
    web_service_url TEXT,
    auth_plugin TEXT,
    auth_params TEXT,
    tls_enabled INTEGER DEFAULT 0,
    tls_trust_certs TEXT,
    use_ssh_tunnel INTEGER DEFAULT 0,
    ssh_config_id TEXT,
    admin_api_timeout INTEGER DEFAULT 5000,
    status TEXT DEFAULT 'disconnected',
    version TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- SSH 隧道配置表
CREATE TABLE IF NOT EXISTS ssh_tunnels (
    id TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    port INTEGER DEFAULT 22,
    username TEXT NOT NULL,
    auth_type TEXT NOT NULL,
    password TEXT,
    private_key TEXT,
    passphrase TEXT,
    local_admin_port INTEGER DEFAULT 0,
    local_broker_port INTEGER DEFAULT 0,
    remote_host TEXT,
    remote_admin_port INTEGER DEFAULT 8080,
    remote_broker_port INTEGER DEFAULT 6650,
    status TEXT DEFAULT 'disconnected',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 操作日志表（凭据不进 details：导出与查看日志都是明文）
CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id TEXT,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    resource_name TEXT,
    details TEXT,
    result TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE SET NULL
);

-- 用户设置表：应用设置、主题、快捷键方案都以 JSON/标量存在这里
CREATE TABLE IF NOT EXISTS user_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_clusters_status ON clusters(status);
CREATE INDEX IF NOT EXISTS idx_operation_logs_cluster_id ON operation_logs(cluster_id);
CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_ssh_tunnels_status ON ssh_tunnels(status);

-- 出厂默认设置（INSERT OR IGNORE：用户改过的值不会被启动流程覆盖回去）
INSERT OR IGNORE INTO user_settings (key, value, updated_at) VALUES
    ('theme', 'light', datetime('now')),
    ('truncateLength', '50', datetime('now')),
    ('autoRefresh', 'true', datetime('now')),
    ('refreshIntervalSeconds', '30', datetime('now'));
`;
