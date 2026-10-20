//! 数据库基线 DDL：与原 Electron 版的 schema.ts 逐表对齐（那份已随 Electron 删除，
//! 对照请查 git 历史），为的是两版能互开同一个库文件。
//!
//! 所有语句必须幂等——每次启动都会整份执行一遍，再按 `user_version` 补列。
/// 与 TS 侧 `SCHEMA_VERSION` 一致：Rust 版读完老库后仍写回同一个版本号，
/// 这样两个版本交替启动时不会互相把对方的数据当成「需要迁移的旧库」。
pub const SCHEMA_VERSION: i64 = 17;

pub const SCHEMA_SQL: &str = r#"
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
    use_k8s_forward INTEGER DEFAULT 0,
    k8s_config_id TEXT,
    admin_api_timeout INTEGER DEFAULT 5000,
    status TEXT DEFAULT 'disconnected',
    version TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

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
    host_fingerprint TEXT,
    status TEXT DEFAULT 'disconnected',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS k8s_forwards (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    resource TEXT NOT NULL,
    context TEXT,
    kubeconfig_path TEXT,
    kubectl_path TEXT,
    local_admin_port INTEGER DEFAULT 0,
    local_broker_port INTEGER DEFAULT 0,
    remote_admin_port INTEGER DEFAULT 8080,
    remote_broker_port INTEGER DEFAULT 6650,
    status TEXT DEFAULT 'disconnected',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS user_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

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
    schema_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (cluster_id, topic_uri, name),
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS consumer_session_configs (
    id TEXT PRIMARY KEY,
    cluster_id TEXT NOT NULL,
    topic_uri TEXT NOT NULL DEFAULT '',
    subscription TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (cluster_id, topic_uri, subscription, name),
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

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

CREATE TABLE IF NOT EXISTS alert_rules (
    id TEXT PRIMARY KEY,
    cluster_id TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    scope TEXT NOT NULL,
    tenant TEXT NOT NULL DEFAULT '',
    namespace TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL DEFAULT '',
    persistent INTEGER NOT NULL DEFAULT 1,
    metric TEXT NOT NULL,
    comparator TEXT NOT NULL,
    threshold REAL NOT NULL,
    consecutive INTEGER NOT NULL DEFAULT 1,
    notify INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (cluster_id, name),
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alert_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id TEXT NOT NULL,
    cluster_id TEXT NOT NULL,
    rule_name TEXT NOT NULL,
    scope_label TEXT NOT NULL,
    metric TEXT NOT NULL,
    comparator TEXT NOT NULL,
    threshold REAL NOT NULL,
    value REAL NOT NULL,
    last_value REAL NOT NULL,
    state TEXT NOT NULL,
    message TEXT NOT NULL,
    fired_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    resolved_at INTEGER,
    acked_at INTEGER,
    FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE,
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS inspections (
    id TEXT PRIMARY KEY,
    cluster_id TEXT NOT NULL,
    cluster_name TEXT NOT NULL,
    version TEXT,
    generated_at TEXT NOT NULL,
    crit INTEGER NOT NULL DEFAULT 0,
    warn INTEGER NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL DEFAULT 0,
    skip INTEGER NOT NULL DEFAULT 0,
    scope_json TEXT NOT NULL,
    checks_json TEXT NOT NULL,
    thresholds_json TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    markdown TEXT NOT NULL,
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS inspection_profiles (
    cluster_id TEXT PRIMARY KEY,
    thresholds_json TEXT NOT NULL,
    max_namespaces INTEGER NOT NULL,
    max_topics INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS inspection_schedules (
    cluster_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    interval_minutes INTEGER NOT NULL,
    notify_on_crit INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    last_error TEXT,
    last_notified_crit INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notify_mail_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    security TEXT NOT NULL DEFAULT 'starttls',
    username TEXT NOT NULL DEFAULT '',
    password_enc TEXT,
    from_address TEXT NOT NULL,
    from_name TEXT NOT NULL DEFAULT '',
    allow_self_signed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notify_channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    url_enc TEXT NOT NULL,
    secret_enc TEXT,
    mail_profile_id TEXT,
    recipients TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    events_json TEXT NOT NULL,
    min_level TEXT NOT NULL DEFAULT 'warn',
    timeout_ms INTEGER NOT NULL DEFAULT 5000,
    rate_per_minute INTEGER NOT NULL DEFAULT 20,
    last_sent_at TEXT,
    last_error TEXT,
    fail_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notify_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    level TEXT NOT NULL,
    ok INTEGER NOT NULL,
    skipped INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (channel_id) REFERENCES notify_channels(id) ON DELETE CASCADE
);

-- v17 曾被一个未发布的内部版本占用：那个版本的 license_state 是商业授权的单行状态表。
-- 授权机制已整体移除，这里用幂等 DROP 清掉可能在旧库里留下的残留——基线每次启动都重跑，
-- 任何见过那个版本的库跑完这句就回到与当前基线一致的结构，不需要动 user_version。
DROP TABLE IF EXISTS license_state;

CREATE INDEX IF NOT EXISTS idx_clusters_status ON clusters(status);
CREATE INDEX IF NOT EXISTS idx_operation_logs_cluster_id ON operation_logs(cluster_id);
CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_ssh_tunnels_status ON ssh_tunnels(status);
CREATE INDEX IF NOT EXISTS idx_k8s_forwards_status ON k8s_forwards(status);
CREATE INDEX IF NOT EXISTS idx_message_templates_scope ON message_templates(cluster_id, topic_uri);
CREATE INDEX IF NOT EXISTS idx_consumer_configs_scope ON consumer_session_configs(cluster_id, topic_uri);
CREATE INDEX IF NOT EXISTS idx_send_history_scope ON send_history(cluster_id, topic_uri);
CREATE INDEX IF NOT EXISTS idx_send_history_created_at ON send_history(created_at);
CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_scope ON metrics_snapshots(cluster_id, topic_uri, captured_at);
CREATE INDEX IF NOT EXISTS idx_alert_rules_cluster ON alert_rules(cluster_id, enabled);
CREATE INDEX IF NOT EXISTS idx_alert_events_state ON alert_events(state, fired_at);
CREATE INDEX IF NOT EXISTS idx_notify_deliveries_channel ON notify_deliveries(channel_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_events_open ON alert_events(rule_id) WHERE resolved_at IS NULL;

INSERT OR IGNORE INTO user_settings (key, value, updated_at) VALUES
    ('theme', 'light', datetime('now')),
    ('truncateLength', '50', datetime('now')),
    ('autoRefresh', 'true', datetime('now')),
    ('refreshIntervalSeconds', '30', datetime('now')),
    ('fontSize', 'large', datetime('now'));
"#;

/// 老库缺列时的补列清单（对应 TS 侧 v5..v17 的 ALTER）。
/// 新库基线已带这些列，所以必须先查 `PRAGMA table_info` 再决定加不加——
/// 直接 ALTER 会 duplicate column，把整个启动事务顶掉。
pub const COLUMN_PATCHES: &[(&str, &str, &str)] = &[
    ("message_templates", "schema_json", "TEXT"),
    ("send_history", "body_full", "TEXT"),
    ("clusters", "use_k8s_forward", "INTEGER DEFAULT 0"),
    ("clusters", "k8s_config_id", "TEXT"),
    ("inspections", "thresholds_json", "TEXT"),
    ("inspections", "source", "TEXT NOT NULL DEFAULT 'manual'"),
    ("notify_channels", "mail_profile_id", "TEXT"),
    ("notify_channels", "recipients", "TEXT NOT NULL DEFAULT ''"),
];
