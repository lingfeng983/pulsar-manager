-- Pulsar Manager Database Schema

-- 集群配置表
CREATE TABLE IF NOT EXISTS clusters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    service_url TEXT NOT NULL,
    web_service_url TEXT,
    auth_plugin TEXT,
    auth_params TEXT,  -- AES-256 加密存储
    tls_enabled INTEGER DEFAULT 0,
    tls_trust_certs TEXT,
    use_ssh_tunnel INTEGER DEFAULT 0,
    ssh_config_id TEXT,
    admin_api_timeout INTEGER DEFAULT 5000,
    status TEXT DEFAULT 'disconnected',  -- connected, disconnected, warning
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
    auth_type TEXT NOT NULL,  -- password, privateKey
    password TEXT,  -- AES-256 加密存储
    private_key TEXT,  -- AES-256 加密存储
    passphrase TEXT,  -- AES-256 加密存储
    local_admin_port INTEGER DEFAULT 0,  -- 0 表示自动分配
    local_broker_port INTEGER DEFAULT 0,
    remote_host TEXT,  -- 远端 Pulsar 地址
    remote_admin_port INTEGER DEFAULT 8080,
    remote_broker_port INTEGER DEFAULT 6650,
    status TEXT DEFAULT 'disconnected',  -- connected, disconnected, error
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 操作日志表
CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id TEXT,
    action TEXT NOT NULL,  -- create, update, delete, connect, disconnect
    resource_type TEXT NOT NULL,  -- cluster, tenant, namespace, topic, subscription
    resource_id TEXT,
    resource_name TEXT,
    details TEXT,  -- JSON 格式的详细信息
    result TEXT,  -- success, failure
    error_message TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE SET NULL
);

-- 用户设置表
CREATE TABLE IF NOT EXISTS user_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 压测模板表
CREATE TABLE IF NOT EXISTS load_test_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    config TEXT NOT NULL,  -- JSON 格式的压测配置
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 快捷键配置表
CREATE TABLE IF NOT EXISTS keyboard_shortcuts (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL UNIQUE,
    shortcut TEXT,
    description TEXT,
    platform TEXT,  -- windows, mac, linux, all
    updated_at TEXT NOT NULL
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_clusters_status ON clusters(status);
CREATE INDEX IF NOT EXISTS idx_operation_logs_cluster_id ON operation_logs(cluster_id);
CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_ssh_tunnels_status ON ssh_tunnels(status);

-- 初始化默认快捷键配置
INSERT OR IGNORE INTO keyboard_shortcuts (id, action, shortcut, description, platform) VALUES
    ('global-search', 'global:search', 'Ctrl+K', '全局搜索', 'windows'),
    ('new-tab', 'tab:new', 'Ctrl+T', '新建标签页', 'windows'),
    ('close-tab', 'tab:close', 'Ctrl+W', '关闭标签页', 'windows'),
    ('refresh', 'view:refresh', 'F5', '刷新页面', 'all'),
    ('settings', 'app:settings', 'Ctrl+,', '打开设置', 'windows'),
    ('cluster-health', 'cluster:health', 'Ctrl+Shift+H', '集群健康检查', 'windows'),
    ('quick-test', 'test:quick', 'Ctrl+Shift+T', '快速压测', 'windows');

-- 初始化默认主题设置
INSERT OR IGNORE INTO user_settings (key, value, updated_at) VALUES
    ('theme', 'light', datetime('now')),
    ('truncateLength', '50', datetime('now')),
    ('autoRefresh', 'true', datetime('now')),
    ('refreshIntervalSeconds', '30', datetime('now'));
