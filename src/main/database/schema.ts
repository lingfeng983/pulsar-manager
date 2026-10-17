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
    use_k8s_forward INTEGER DEFAULT 0,
    k8s_config_id TEXT,
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

-- 集群端口转发表（kubectl port-forward）
-- 与 ssh_tunnels 同一角色：集群表单内联录入、按集群独占的一行转发配置。
-- 这里没有任何凭据——kubeconfig 路径指向的文件才是凭据，本表只存路径字符串，
-- 所以既不用加密，也不该把文件内容读进来存一遍。
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

-- 告警规则：作用域定位三件套用空串表示"该维度不参与定位"（与 message_templates
-- 的 topic_uri 约定同源）。阈值存原生单位，换算只在显示侧做。
-- 同一集群内规则名唯一：列表里两条同名的规则没人分得出该关哪条。
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

-- 告警事件：rule_name / scope_label / message 都是立案那一刻写死的文本副本，
-- 规则后来改名改阈值不该改写历史——用户半年后翻到这条事件时要知道当时卡在哪。
-- fired_at 等一律 epoch 毫秒（与 metrics_snapshots 同一个理由：按时间范围清理与排序）。
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

-- 巡检报告：一次巡检一行，checks / scope 存 JSON 而不是拆成子表——
-- 报告是「某时刻的整份快照」，从来只被整体读取和整体导出，拆开只会让环比要拼四次 JOIN。
-- cluster_name / version 是当时写死的副本：集群后来改名不该改写历史，
-- 半年后翻到这份报告的人要看到的是当时那台集群的名字（与 alert_events 同一个理由）。
-- 四个级别计数单独立列：历史列表只扫这几个数，不该为渲染一行去解析整份 JSON。
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
    -- 当次生效的判定口径。可空：v2.8 存的那些报告根本没有这个概念，
    -- 空就是「口径未知」，环比时不据此下「判定线没动」的结论。
    thresholds_json TEXT,
    markdown TEXT NOT NULL,
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

-- 巡检口径：一台集群一行。阈值与采样上限存整份 JSON 而不是每字段一列——
-- 判定要一次拿全六个数，读一行拿半个口径反而更容易写出「改了积压线却忘了 rateRatio」这种状态。
-- 用 cluster_id 当主键而不是再生成一个 id：这张表按定义就是「这台集群的当前口径」，
-- 没有第二份并存，也没有历史（历史口径已经抄在每份报告的 thresholds 里了）。
CREATE TABLE IF NOT EXISTS inspection_profiles (
    cluster_id TEXT PRIMARY KEY,
    thresholds_json TEXT NOT NULL,
    max_namespaces INTEGER NOT NULL,
    max_topics INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

-- 创建索引
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
-- 一条规则同时只能有一条未恢复事件。这条偏唯一索引是让"是否已立案"这个判断
-- 不依赖进程内存：重启后引擎照样能看到事件还开着，只刷新观测值、不再弹一次通知。
CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_events_open ON alert_events(rule_id) WHERE resolved_at IS NULL;

-- 出厂默认设置（INSERT OR IGNORE：用户改过的值不会被启动流程覆盖回去）
INSERT OR IGNORE INTO user_settings (key, value, updated_at) VALUES
    ('theme', 'light', datetime('now')),
    ('truncateLength', '50', datetime('now')),
    ('autoRefresh', 'true', datetime('now')),
    ('refreshIntervalSeconds', '30', datetime('now')),
    ('fontSize', 'large', datetime('now'));
`;
