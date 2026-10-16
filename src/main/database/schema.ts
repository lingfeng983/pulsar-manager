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

-- 报文模板表（生产者工作台）。body 存未解析态，占位符原样保留，
-- 变量侧表单独一列而不是塞进正文头部：混在一段里格式化后顺序会漂、复制时容易一起粘走。
-- topic_uri 用空串而不是 NULL 表示「通用模板」：SQLite 唯一索引里 NULL 互不相等，
-- 用 NULL 的话同名通用模板能无限重复插入。
CREATE TABLE IF NOT EXISTS message_templates (
    id TEXT PRIMARY KEY,
    cluster_id TEXT NOT NULL,
    topic_uri TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    variables_json TEXT NOT NULL DEFAULT '[]',
    properties_json TEXT NOT NULL DEFAULT '{}',
    producer_options_json TEXT NOT NULL DEFAULT '{}',
    schema_mode TEXT NOT NULL DEFAULT 'none',
    -- 「内联 Schema」校验用的 JSON Schema 原文；schema_mode 不是 inline 时为 NULL
    schema_json TEXT,
    use_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (cluster_id, topic_uri, name),
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

-- 消费者会话配置表（消费者工作台）。config_json 是订阅类型/确认方式/死信这一组，
-- 整份存取、不按列查，所以不必拆成列。
CREATE TABLE IF NOT EXISTS consumer_session_configs (
    id TEXT PRIMARY KEY,
    cluster_id TEXT NOT NULL,
    topic_uri TEXT NOT NULL DEFAULT '',
    subscription TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    config_json TEXT NOT NULL,
    use_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (cluster_id, topic_uri, subscription, name),
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

-- 发送历史：默认只记正文前缀与字节数；配置中心开「全文留存」后 body_full 另存
-- 整篇模板正文（单行上限见 producer-handlers 的 HISTORY_FULL_MAX_CHARS）。
-- 整篇载荷仍不落库——逐条解析结果是原生层分批释放的，这里存的是这次投的模板长什么样。
-- template_name 冗余存一份，删模板不丢历史；cluster_id 与 template_id 学 operation_logs
-- 走 SET NULL，因为「消息发过」这件事不该随集群消失而被抹掉。
CREATE TABLE IF NOT EXISTS send_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id TEXT,
    topic_uri TEXT NOT NULL,
    template_id TEXT,
    template_name TEXT NOT NULL,
    body_preview TEXT NOT NULL,
    body_full TEXT,
    body_bytes INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 1,
    message_id TEXT,
    status TEXT NOT NULL,
    error_message TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE SET NULL
);

-- 监控时序快照：以前监控页的曲线只活在组件 state 里，切页签、重启进程即归零。
-- 这张表把每次轮询采到的点落库，topic_uri 用空串表示「集群总体」（与通用模板的
-- 约定一致，也是唯一索引需要的非 NULL 值）；captured_at 存 epoch 毫秒而不是 ISO 串，
-- 因为趋势查询按时间范围与时间轴排序，数值比较比字符串比较快也好写。
CREATE TABLE IF NOT EXISTS metrics_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id TEXT NOT NULL,
    topic_uri TEXT NOT NULL DEFAULT '',
    msg_rate_in REAL NOT NULL DEFAULT 0,
    msg_rate_out REAL NOT NULL DEFAULT 0,
    throughput_in REAL NOT NULL DEFAULT 0,
    throughput_out REAL NOT NULL DEFAULT 0,
    backlog INTEGER NOT NULL DEFAULT 0,
    producers INTEGER NOT NULL DEFAULT 0,
    consumers INTEGER NOT NULL DEFAULT 0,
    captured_at INTEGER NOT NULL,
    UNIQUE (cluster_id, topic_uri, captured_at),
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_clusters_status ON clusters(status);
CREATE INDEX IF NOT EXISTS idx_operation_logs_cluster_id ON operation_logs(cluster_id);
CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_ssh_tunnels_status ON ssh_tunnels(status);
CREATE INDEX IF NOT EXISTS idx_message_templates_scope ON message_templates(cluster_id, topic_uri);
CREATE INDEX IF NOT EXISTS idx_consumer_configs_scope ON consumer_session_configs(cluster_id, topic_uri);
CREATE INDEX IF NOT EXISTS idx_send_history_scope ON send_history(cluster_id, topic_uri);
CREATE INDEX IF NOT EXISTS idx_send_history_created_at ON send_history(created_at);
CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_scope ON metrics_snapshots(cluster_id, topic_uri, captured_at);

-- 出厂默认设置（INSERT OR IGNORE：用户改过的值不会被启动流程覆盖回去）
INSERT OR IGNORE INTO user_settings (key, value, updated_at) VALUES
    ('theme', 'light', datetime('now')),
    ('truncateLength', '50', datetime('now')),
    ('autoRefresh', 'true', datetime('now')),
    ('refreshIntervalSeconds', '30', datetime('now')),
    ('fontSize', 'large', datetime('now'));
`;
