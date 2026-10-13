# 页面数据来源说明文档

## 一、数据流架构

```
渲染进程 (Renderer)
  React Pages ──▶ Zustand Stores ──▶ preload 白名单 API
                          │
                          ▼  IPC（入口 Zod 校验 + 受信来源/主框架检查）
主进程 (Main)
  IPC Handlers（src/main/ipc/*-handlers.ts，按域拆分）
    ├─ cluster / resources / messages / metrics / topology
    ├─ ssh / config / plugin / update
    │      │
    │      ├──▶ Admin REST (axios)：资源与配置、聚合统计、集群拓扑、订阅积压
    │      └──▶ 原生客户端 (pulsar-client, N-API)：消息收发、快速压测
    │
  SQLite（敏感字段 AES-256-GCM 加密）
    clusters / ssh_tunnels / operation_logs / user_settings /
    message_templates / consumer_session_configs / send_history
```

## 二、页面数据来源详细说明

### 2.1 首页 (Home.tsx)

首页分「列表视图」与「拓扑视图」两个模式，都不做跨集群聚合统计。

**数据来源：**
- **集群列表**（列表视图）: `window.electronAPI.cluster.list()`
  - IPC: `cluster:list`（Handler: `src/main/ipc/cluster-handlers.ts`）
  - 数据源: SQLite `clusters` 表
  - 字段: id, name, serviceUrl, webServiceUrl, status, version
  - 名称/地址筛选与状态四选一下拉都在渲染层做（集群数量本来就小，不为过滤再发一轮 IPC），筛空时表格显「没有符合筛选条件的集群」
- **集群状态探活**: 挂载即 `refreshClusterStatus()` → IPC `cluster:checkStatus`（口径见 2.7），列表里的 `status` 是探活写回的持久列；「刷新集群状态」走同一轮，成功与失败都出 toast
- **集群拓扑**（拓扑视图）: 由 `HomeTopology` 组件负责，取数见 2.6；放大缩小 / 刷新 / 全屏四个图标与节点计数默认 portal 到页头这一行，进入全屏后改画在图内右上角（全屏独占的是图这一层，工具栏留在页头就等于「退出全屏」被盖住）
- **状态管理**: `useClusterStore` (Zustand)
  - 位置: `src/renderer/store/cluster.ts`
  - 方法: `fetchClusters()`, `refreshClusterStatus()`, `deleteClusterAsync()`

---

### 2.2 集群配置 (ClusterConfig.tsx)

**数据来源：**
- **集群配置表单**: 本地状态 `useState`
  - 字段: name, serviceUrl, webServiceUrl, authPlugin, authParams, tlsEnabled
  - `webServiceUrl` 可留空；留空时主进程由 `serviceUrl` 推导 Admin 地址：`pulsar://` → `http://`、`pulsar+ssl://` / `ssl://` → `https://`，并把 broker 二进制端口换成同侧默认的 admin 端口（6650→8080、6651→8443）。把 6650 照搬过去会让所有 admin 请求打到一个不说 HTTP 的端口上

- **连接测试**: `window.electronAPI.cluster.testConnection()`
  - IPC: `cluster:testConnection`（Handler: `src/main/ipc/cluster-handlers.ts`）
  - 用集群配置构造一次性 Admin REST 客户端，请求健康检查端点，并尝试读取集群版本

- **保存集群**: `window.electronAPI.cluster.add()`
  - IPC: `cluster:add`
  - 数据存储: SQLite `clusters` 表
  - 敏感字段: `auth_params`, `tls_trust_certs` (AES-256 加密)

- **更新集群**: `window.electronAPI.cluster.update()`
  - IPC: `cluster:update`

---

### 2.3 Topic 详情 (TopicDetail.tsx)

**数据来源：**

#### 2.3.1 Topic 统计信息
- **API**: `window.electronAPI.resources.getTopicStats()`
- **IPC**: `resources:getTopicStats`（Handler: `src/main/ipc/resource-handlers.ts`）
- **Pulsar API**: `GET /admin/v2/{persistent|non-persistent}/{tenant}/{namespace}/{topic}/stats`
- **数据类型**:
  ```typescript
  interface TopicStats {
    name: string
    persistent: boolean
    msgRateIn: number
    msgRateOut: number
    backlogSize: number
    subscriptions: Record<string, SubscriptionStats>
    producers: ProducerStats[]
    consumers: ConsumerStats[]
  }
  ```

#### 2.3.2 订阅列表
- **API**: `window.electronAPI.resources.getSubscriptions()`
- **IPC**: `resources:getSubscriptions`
- **Pulsar API**: `GET /admin/v2/{...}/{topic}/subscriptions`
- 表里的**速率**与**吞吐量**取自 `TopicStats.subscriptions[sub]` 的 `msgRateOut`（msg/s）与 `msgThroughputOut`（B/s），是 broker 采样窗口上的瞬时值，随 15 秒轮询刷新；列名悬浮说明口径，数值悬浮给 broker 报的原始数字（换算后的读数出问题时要看的是原始值）

#### 2.3.3 生产者/消费者
- **来源**: `TopicStats.producers` 和 `TopicStats.consumers`
- **刷新机制**: 15 秒定时刷新，且只在当前页签激活时轮询
  - antd Tabs 关闭才销毁、切走的页签只是 `display:none` 仍然挂载，组件读 `PaneActiveContext` 决定是否启动定时器，避免后台页签一直打 IPC

#### 2.3.4 「配置」页签
- **读取**: `resources:getTopicConfig` 逐策略端点并发读，回填进页内表单（不套弹窗，改哪一项就在原地改）
- **写入**: `resources:updateTopicConfig`，read-modify-write 后只 PUT 变更过的键；**留空表示不修改**，`-1` 与 `0` 是两种不同语义（-1 为忽略该项，两项同时 0 才是关闭保留），broker 拒绝只置一项为 0 时会把原始报错回显在页面上
- **页内可编辑**: `retentionTimeInMinutes`、`retentionSizeInMB`、`numPartitions`
- **只读展示**: 生效积压配额、去重状态、归属 Broker——本 broker 上这些只有命名空间级写入口，给输入框只会让人以为改成功了

---

### 2.4 消息浏览器 (MessageBrowser.tsx)

**数据来源：**

#### 2.4.1 订阅列表
- **API**: `window.electronAPI.resources.getSubscriptions()`
- **拉取失败会写入页面 error**，不会只留一句 "点开始没反应"

#### 2.4.2 消息读取（Reader / 订阅消费）
- **API**: `window.electronAPI.messages.startRead()` / `startConsume()`
- **IPC**: `messages:startRead` / `messages:startConsume`（Handler: `src/main/ipc/message-handlers.ts`）
- **实现**: 主进程用原生 `pulsar-client` 起 Reader 或 Consumer，按批经 `msg:read-batch` / `msg:consume-batch` 单向推送到渲染层
  - Reader 只读不 ack，不影响任何订阅游标；订阅消费可关自动 ack（关闭后消息不被确认，用于观察 backlog 累积）
  - 会话因出错或读满上限自行结束时，主进程推 `msg:session-end`，界面据此复位运行态
- **停止**: `messages:stopConsume` / `messages:stopRead`，只需会话 id，会话已自行结束时返回 `stopped: false` 而不是报错
- **积压查询**: `messages:getBacklog`（Admin REST 订阅统计）
- **参数**（Reader）:
  ```typescript
  {
    clusterId: string
    tenant: string
    namespace: string
    topic: string
    persistent: boolean
    from: 'earliest' | 'latest' | 'timestamp' | 'recent'
    timestamp?: number    // 仅 from === 'timestamp' 时提交
    recentCount?: number  // 仅 from === 'recent' 时提交，1–500，默认 20
    maxMessages: number   // 上限 10000；recent 模式下不出现（扫描自己收尾）
  }
  ```
- **「最近 N 条」的实现口径**: Admin REST 没有 peek / lastMessageId 端点，原生 Reader 也没有尾部锚点，所以这条是从 earliest 往后扫、只保留最后 N 条的环形缓冲，扫完（或撞护栏）一次性推给界面。护栏在 `src/main/services/pulsar-native-client.ts`：`RECENT_SCAN_MAX_MESSAGES=20000`、`RECENT_SCAN_MS=15000`、`RECENT_SCAN_MAX_BYTES=8MB`、`RECENT_SCAN_IDLE_ROUNDS=2`（连续两轮无新消息才算读完）。撞护栏时 `msg:session-end` 的 `detail` 会写明"扫过多少、取了几条"，界面照实提示，不声称拿到的是真正的尾部
- **列表交互**: `Publish Time` 列可排序（默认倒序，点表头在倒/正之间切），所有列可拖宽（`useResizableColumns` + react-resizable，宽度只存组件状态，不落库）；Reader 与订阅消费两个子模式共用同一套列定义
- **正文类型判定**: `src/renderer/components/message/messageFormat.ts` 的 `detectPayloadKind` —— 以 `[`/`{` 开头且 `JSON.parse` 成功算 JSON；以 `<` 开头且 `DOMParser` 能成树（无 `parsererror`）算 XML；其余算纯文本。判出来的类型决定列表标签与详情弹窗里的着色缩进
- **页签生命周期**: 切到内层其它页签（概览/订阅管理/配置）会停掉会话——页签是 `display:none` 而非卸载，不停的话它会一直在后台消费并把消息堆进看不见的列表

#### 2.4.3 消息发送
- **API**: `window.electronAPI.messages.send()`
- **IPC**: `messages:send`
- **实现**: 原生客户端 `producer.send()`，返回真实 `messageId`；属性为可选 JSON 对象（键值各限 1024 字符、条数上限 100）
- **单条消息参数**（`options: ProducerMessageOptions`，界面按字段列出而非让人拼 JSON）: `partitionKey`、`eventTimeMode`（none/now/fixed）+ `eventTime`、`deliverAfterMs` 或 `deliverAt`、`properties`。批大小、压缩、发送超时是 producer 级参数，单次发送每次现建一条 producer 用默认值，要调它们去生产者工作台

#### 2.4.4 消息数据结构
```typescript
interface Message {
  messageId: string
  producerName: string
  publishTime: number
  properties: Record<string, string>
  data: string  // Base64 encoded
  topicName: string
}
```
界面拿到 `data` 后先尝试 base64 解码为文本，判定为二进制时才保留 base64 原样显示；列表里的正文按「配置中心 → 消息正文截断长度」折叠，可点「展开全文」看完整内容。

---

### 2.5 监控仪表盘 (MetricsDashboard.tsx)

**数据来源：**

#### 2.5.1 聚合统计
- **API**: `window.electronAPI.metrics.getAggregatedStats()`
- **IPC**: `metrics:getAggregatedStats`（Handler: `src/main/ipc/metrics-handlers.ts`）
- **Pulsar API**: 遍历租户 → 命名空间 → Topic 拉取 stats 后聚合，扇出有固定并发窗口与规模上限
- **数据类型**:
  ```typescript
  interface AggregatedStats {
    totalTopics: number
    totalPartitions: number
    totalSubscriptions: number
    totalProducers: number
    totalConsumers: number
    totalMsgRateIn: number
    totalMsgRateOut: number
    totalThroughputIn: number
    totalThroughputOut: number
    totalBacklog: number
  }
  ```

#### 2.5.2 Broker 信息
- **API**: `window.electronAPI.metrics.getBrokers()`
- **IPC**: `metrics:getBrokers`
- **Pulsar API**: `GET /admin/v2/brokers`（活跃）与 `/admin/v2/brokers/all`

#### 2.5.3 趋势与刷新
- **实现方式**: 每次刷新把当前速率与吞吐追加进组件内的历史数组，图表由这些数据点绘制
- **刷新间隔**: 读应用设置（`autoRefresh` + `refreshIntervalSeconds`，默认 30 秒），选「手动」时只响应刷新按钮
- **时间范围**: 列表上方的 RangePicker 按数据点时间过滤（闭区间），可选日期下界由当前保留窗口决定，历史之外的日期被禁用
- **四张图**: 消息输入速率趋势、消息输出速率趋势、吞吐量对比（按时间戳把输入/输出配对成柱）、资源分布

---

### 2.6 集群拓扑 (HomeTopology.tsx / ClusterTopology)

**数据来源：**

#### 2.6.1 拓扑数据
- **API**: `window.electronAPI.topology.getClusterTopology()`
- **IPC**: `topology:getClusterTopology`（Handler: `src/main/ipc/metrics-handlers.ts`）
- **Pulsar API**:
  - Broker 列表: `GET /admin/v2/brokers`
  - 租户列表: `GET /admin/v2/tenants`
  - 命名空间: `GET /admin/v2/namespaces/{tenant}`
  - Topic 列表: `GET /admin/v2/namespaces/{tenant}/{namespace}/topics`
  - Topic 统计: `GET /admin/v2/{...}/{topic}/stats`
- **规模上限**: 渲染层按场景传入 `limits`（首页概览只取少量节点），主进程再与全局上限取较小值

#### 2.6.2 拓扑数据类型
```typescript
interface ClusterTopology {
  brokers: Array<{
    name: string
    // 由各 topic 的 ownerBrokers 反向聚合而来，归属不可用时为空数组
    topics: string[]
  }>
  topics: Array<{
    name: string
    tenant: string
    namespace: string
    persistent: boolean
    // 分区 URI 列表，长度即分区数；非分区 topic 为空数组
    partitionNames: string[]
    // 承载该 topic（或其某个分区）的 broker，host:port 列表
    ownerBrokers: string[]
    subscriptions: string[]
    producers: number
    consumers: number
    msgRateIn: number
    msgRateOut: number
    backlogSize: number
  }>
  // 归属来源：brokerStats（topic stats 带 ownerBroker）/ singleBroker（集群只有一个 broker）/ none（拿不到，绝不猜）
  ownershipSource: 'brokerStats' | 'singleBroker' | 'none'
}
```

#### 2.6.3 节点关系
- **Broker → Topic**: 只按真实归属（`ownerBrokers`）连线，归属不可用（`ownershipSource === 'none'`）时就不连，不按序号轮转分配
- **边权重**: 基于 `msgRateIn`
- **配色**: 运行时从 CSS 变量读取，跟随亮色/暗色/护眼三套主题

### 2.7 资源树筛选与集群探活 (ResourceTree.tsx / store/cluster.ts)

- **树顶部的 topic 筛选**是纯渲染层过滤，不额外发 IPC：查询串按空白分词，每个词都要命中；词内先试连续子串，退而求其次才允许跳字子序列（`tns` 命中 `tenant-ns`），实现见 `src/renderer/utils/fuzzyMatch.ts`。命中的 topic 保留其租户/命名空间分支，筛空时给出明确提示而不是显一棵空树
- **首屏探活**：`Home` 挂载即 `fetchClusters()` 之后 fire-and-forget 调 `refreshClusterStatus()` → IPC `cluster:checkStatus`（`src/main/ipc/cluster-handlers.ts`），逐集群走 Admin 健康检查、把结果写回 `clusters.status` 并返回整份列表；页面不被它阻塞，`checking` 期间复用同一轮不重复发
- **为什么必须探活**：`clusters.status` 是 SQLite 里的持久列，不探活的话首屏显的是上次退出时留在库里的那份，集群早就停了界面还是一片"在线"
- 顶部导航/首页的「刷新集群状态」走同一个 `cluster:checkStatus`，成功与失败都出 toast

---

### 2.8 生产者工作台 (ProducerWorkspace.tsx)

- **常驻会话**: `producer:startSession`（带 `ProducerOptions`）→ `producer:send`（单发 1–1000 条）→ `producer:flush`（只把原生队列最后一段推出，不关会话）→ `producer:stop`（断会话，回 `stopped` 不报错）；`producer:listSessions` 列当前会话
- **不建会话的一次性发送**: `producer:sendOnce`，现开现关，用于"就发一条、别留连接"
- **分批解析与发送**: `producer:send`、`producer:sendOnce`、连续流三条路径都由原生层逐批 resolve→send→release（每批 ≤200 条、正文合计 ≤16MB），主进程不会同时持有 `条数 × 正文`；每条仍重新过一遍占位符，序号跨批连续，界面拿到的失败清单是完整的
- **连续限速流**: `producer:startFlow`（`ratePerSecond` 0 为不限、`totalMessages` 0 为到手动停止、`maxInFlight`、`stopOnError`），运行中改速率走 `producer:setRate`（只换限速器，不重建 producer），停止走 `producer:stopFlow`
- **统计推送**: `msg:producer-stats`（main → renderer），已发/失败/字节、msg/s、MB/s 与 P50/P99 确认延迟
- **发送历史**: 单发、直接发送与连续发送的每一轮（终态帧）都写 `send_history`，正文只留前 400 字符与平均单条字节；界面入口是工作台顶部的「发送历史」，走 `sendHistory:list` 按 集群 + topic 读最近 200 条
- **报文模板**: `template:list/get/create/update/delete/copy`，存 `message_templates`。正文必须是合法 JSON，`${...}` 为占位符，生成函数见 `src/shared/template-engine.ts` 的 `KNOWN_FUNCTIONS`（`int/float/bool/string/uuid/choice/seq/index/now/date/timestamp`），支持具名变量与 `$each{count,of}` 展开，整体占位符保留原类型，渲染结果上限 5MB
- **producer 级参数**（`src/shared/producer-defaults.ts` 为唯一事实来源，主进程建 producer、IPC Zod 默认值、界面初值三处同源）: 发送超时、在途队列、队列满是否阻塞、压缩、批大小/批字节/批时间、`chunkingEnabled`。`batchingEnabled` 与 `chunkingEnabled` 同真会 abort 原生进程，Zod `refine` 与界面都拦

### 2.9 消费者工作台 (ConsumerWorkspace.tsx)

- **会话**: `consumer:start` / `consumer:stop` / `consumer:list`，多会话并存（Exclusive 除外，重复开先弹确认）；消息批次仍走 `msg:consume-batch`，结束走 `msg:session-end`
- **订阅设置**（`ConsumerConfigForm`）: 类型 `Shared/Key_Shared/Failover/Exclusive`、起始 `Latest/Earliest`、自动确认开关、`maxMessages`（0 不限）、`receiverQueueSize`、`ackTimeoutMs` 与 `nAckRedeliverTimeoutMs`（关掉自动确认才出现）、消费者名、死信策略（`topicName`/`maxRedeliverCount`/`initialSubscriptionName`）
- **消息列表**: 按会话分桶、每秒自算速率、可暂停渲染、保留条数 1–5000、导出 JSON/CSV、清空；积压走 `messages:getBacklog`
- **配置库**: `consumerConfig:list/get/create/update/delete/copy`，存 `consumer_session_configs`，`config_json` 整份存取

---

## 三、数据库表结构

### 3.1 clusters 表
```sql
CREATE TABLE clusters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    service_url TEXT NOT NULL,
    web_service_url TEXT,
    auth_plugin TEXT,
    auth_params TEXT,          -- AES-256 加密
    tls_enabled INTEGER DEFAULT 0,
    tls_trust_certs TEXT,       -- AES-256 加密
    use_ssh_tunnel INTEGER DEFAULT 0,
    ssh_config_id TEXT,
    admin_api_timeout INTEGER DEFAULT 5000,
    status TEXT DEFAULT 'disconnected',
    version TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

### 3.2 ssh_tunnels 表
```sql
CREATE TABLE ssh_tunnels (
    id TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    port INTEGER DEFAULT 22,
    username TEXT NOT NULL,
    auth_type TEXT NOT NULL,
    password TEXT,              -- AES-256 加密
    private_key TEXT,           -- AES-256 加密
    passphrase TEXT,             -- AES-256 加密
    local_admin_port INTEGER DEFAULT 0,
    local_broker_port INTEGER DEFAULT 0,
    remote_host TEXT,
    remote_admin_port INTEGER DEFAULT 8080,
    remote_broker_port INTEGER DEFAULT 6650,
    status TEXT DEFAULT 'disconnected',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

### 3.3 operation_logs 表
```sql
CREATE TABLE operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id TEXT,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    resource_name TEXT,
    details TEXT,           -- 凭据不进这里：日志查看与导出都是明文
    result TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE SET NULL
);
```

### 3.4 user_settings 表
```sql
CREATE TABLE user_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```
键值表，应用设置、主题、快捷键方案、已停用的插件都存这里。出厂默认行用 `INSERT OR IGNORE` 写入（`theme`、`truncateLength`、`autoRefresh`、`refreshIntervalSeconds`、`fontSize`），改过的值不会被启动流程覆盖。

### 3.5 message_templates 表
```sql
CREATE TABLE message_templates (
    id TEXT PRIMARY KEY,
    cluster_id TEXT NOT NULL,
    topic_uri TEXT NOT NULL DEFAULT '',   -- 空串表示「通用模板」，不用 NULL：
                                          -- SQLite 唯一索引里 NULL 互不相等，用 NULL 同名通用模板能无限重复插入
    name TEXT NOT NULL,
    body TEXT NOT NULL,                   -- JSON 正文，${...} 为占位符
    variables_json TEXT NOT NULL DEFAULT '[]',
    properties_json TEXT NOT NULL DEFAULT '{}',
    producer_options_json TEXT NOT NULL DEFAULT '{}',
    schema_mode TEXT NOT NULL DEFAULT 'none',
    use_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (cluster_id, topic_uri, name),
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);
```

### 3.6 consumer_session_configs 表
```sql
CREATE TABLE consumer_session_configs (
    id TEXT PRIMARY KEY,
    cluster_id TEXT NOT NULL,
    topic_uri TEXT NOT NULL DEFAULT '',
    subscription TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    config_json TEXT NOT NULL,            -- 订阅类型/确认方式/死信这一组，整份存取、不按列查
    use_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (cluster_id, topic_uri, subscription, name),
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);
```

### 3.7 send_history 表
```sql
CREATE TABLE send_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id TEXT,
    topic_uri TEXT NOT NULL,
    template_id TEXT,
    template_name TEXT NOT NULL,          -- 冗余存一份：删模板不丢历史
    body_preview TEXT NOT NULL,           -- 只记正文前缀与字节数，不存解析后的载荷
    body_bytes INTEGER NOT NULL,          -- 平均每条字节（逐条正文分批发送后即释放，留不了逐条体积）
    message_count INTEGER NOT NULL DEFAULT 1,
    message_id TEXT,
    status TEXT NOT NULL,
    error_message TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE SET NULL
);
```
单条报文上限 5MB，整份落库迟早几十 GB；`cluster_id` 与 `template_id` 学 `operation_logs` 走 `SET NULL`，"消息发过"这件事不该随集群删除而被抹掉。

### 3.8 索引
```sql
CREATE INDEX idx_clusters_status ON clusters(status);
CREATE INDEX idx_operation_logs_cluster_id ON operation_logs(cluster_id);
CREATE INDEX idx_operation_logs_created_at ON operation_logs(created_at);
CREATE INDEX idx_ssh_tunnels_status ON ssh_tunnels(status);
CREATE INDEX idx_message_templates_scope ON message_templates(cluster_id, topic_uri);
CREATE INDEX idx_consumer_configs_scope ON consumer_session_configs(cluster_id, topic_uri);
CREATE INDEX idx_send_history_scope ON send_history(cluster_id, topic_uri);
CREATE INDEX idx_send_history_created_at ON send_history(created_at);
```

表结构版本为 `PRAGMA user_version = 5`，基线 DDL 与增量迁移都在 `src/main/database/` 里，每次启动先跑幂等基线再按版本补做迁移。

---

## 四、IPC 通道清单

### 4.1 集群管理（`cluster-handlers.ts`）
| IPC 通道 | 方向 | 功能 |
|---------|------|------|
| `cluster:list` | renderer → main | 获取集群列表 |
| `cluster:add` | renderer → main | 添加集群 |
| `cluster:update` | renderer → main | 更新集群 |
| `cluster:delete` | renderer → main | 删除集群（连带清理其 SSH 隧道配置） |
| `cluster:testConnection` | renderer → main | 测试连接并读取集群版本 |
| `cluster:checkStatus` | renderer → main | 逐集群健康检查、把结果写回 `clusters.status` 并返回整份列表（首屏自动跑一次，「刷新集群状态」手动跑） |

### 4.2 资源管理（`resource-handlers.ts`）
| IPC 通道 | 方向 | 功能 |
|---------|------|------|
| `resources:getTenants` | renderer → main | 获取租户列表 |
| `resources:createTenant` / `resources:updateTenant` / `resources:deleteTenant` | renderer → main | 租户增改删 |
| `resources:getNamespaces` | renderer → main | 获取命名空间 |
| `resources:createNamespace` / `resources:deleteNamespace` | renderer → main | 命名空间增删 |
| `resources:getTopics` | renderer → main | 获取 Topic 列表 |
| `resources:createTopic` / `resources:deleteTopic` | renderer → main | Topic 增删（分区 topic 的删除走 `/{topic}/partitions`） |
| `resources:getTopicStats` | renderer → main | 获取 Topic 统计 |
| `resources:getTopicConfig` / `resources:updateTopicConfig` | renderer → main | 逐策略端点读取配置 / 只 PUT 变更过的键 |
| `resources:getSubscriptions` | renderer → main | 获取订阅列表 |
| `resources:createSubscription` / `resources:deleteSubscription` | renderer → main | 订阅增删 |
| `resources:resetCursor` / `resources:skipMessages` | renderer → main | 重置游标 / 跳过消息 |
| `resources:getTenantInfo` / `resources:getNamespaceInfo` | renderer → main | 租户与命名空间详情 |
| `resources:getPulsarClusters` | renderer → main | 获取 Pulsar 集群列表（租户表单里选择 allowedClusters） |

### 4.3 消息操作（`message-handlers.ts`，全部走原生客户端）
| IPC 通道 | 方向 | 功能 |
|---------|------|------|
| `messages:send` | renderer → main | 发送一条消息，返回真实 messageId |
| `messages:startRead` / `messages:stopRead` | renderer → main | 启动 / 停止 Reader 会话 |
| `messages:startConsume` / `messages:stopConsume` | renderer → main | 启动 / 停止订阅消费会话 |
| `messages:getBacklog` | renderer → main | 查询订阅积压 |
| `msg:read-batch` / `msg:consume-batch` | main → renderer | 单向推送消息批次（攒够 50 条或 300ms） |
| `msg:session-end` | main → renderer | 会话自行结束（读满上限、扫描收尾或出错）时通知界面复位，`detail` 带结束原因 |

Admin REST 没有发消息与 peek 的端点（真实 broker 上返回 HTML 404），消息收发只有原生客户端这一条路；同理"最近 N 条"也只能靠从 earliest 往后扫实现（见 2.4.2）。`messages:send` 的 `options` 是单条消息级参数（`partitionKey`、`eventTime`、`deliverAfterMs`/`deliverAt`、`properties`），与 producer 级参数分开放，避免界面上出现"改了不生效"的输入框。

### 4.4 监控与拓扑（`metrics-handlers.ts`）
| IPC 通道 | 方向 | 功能 |
|---------|------|------|
| `metrics:getAggregatedStats` | renderer → main | 获取集群聚合统计 |
| `metrics:getBrokers` | renderer → main | 获取 Broker 列表 |
| `topology:getClusterTopology` | renderer → main | 获取集群拓扑（可传 `limits` 限制规模） |

### 4.5 SSH 隧道（`system-handlers.ts`）
| IPC 通道 | 方向 | 功能 |
|---------|------|------|
| `ssh:list` | renderer → main | 获取隧道配置与状态列表 |
| `ssh:connect` | renderer → main | 按表单里的参数建立本地端口转发 |
| `ssh:disconnect` | renderer → main | 关闭指定隧道并释放本地端口 |

隧道配置本身随集群保存（`clusters.ssh_config_id` 指向 `ssh_tunnels` 行），没有独立的"添加隧道"通道；删除集群会连带删除其隧道配置，启动时也会剪掉无人引用的残留行。

### 4.6 快速压测（`load-test-handlers.ts`）
| IPC 通道 | 方向 | 功能 |
|---------|------|------|
| `benchmark:start` | renderer → main | 校验参数并启动一轮压测，立即返回 `{runId, topic}` |
| `benchmark:stop` | renderer → main | 按 runId 停止，先排空在途发送再关闭资源 |
| `benchmark:progress` | main → renderer | 单向推送进度（每 500ms 一次），终态为 completed / stopped / failed |

压测数据不来自 Admin API，全部由主进程原生客户端现场产生：吞吐与带宽按已确认的发送数除以运行时长，延迟统计是 `send()` 调用到 broker 回调的耗时（含客户端在途队列排队），消费侧只计已收到条数。同一目标（集群 + topic + 订阅）并发只允许一轮，第二轮会被直接拒绝。

### 4.7 应用配置（`config-handlers.ts`）

| IPC 通道 | 方向 | 功能 |
|---------|------|------|
| `config:getAll` | renderer → main | 读取应用设置（截断长度、自动刷新、刷新间隔），缺项按默认值补齐 |
| `config:update` | renderer → main | 局部更新设置，Zod 逐字段校验后写 `user_settings` |
| `config:reset` | renderer → main | 恢复出厂设置并返回全量结果 |
| `config:meta` | renderer → main | 应用版本与本地数据库文件路径 |
| `config:export` | renderer → main | 生成配置包（设置 + 集群 + 快捷键），不含任何凭据字段 |
| `config:import` | renderer → main | 校验并导入配置包，事务内完成，同名集群跳过 |
| `config:clearLogs` | renderer → main | 清空 `operation_logs`，返回删除条数 |

设置全部存在本机 SQLite 的 `user_settings` 键值表里，渲染层用 `useSettingsStore` 缓存一份并订阅变更：`App` 读字号档位（小 / 中 / 大 / 特大，写进 `<html data-font-size>` 并驱动 antd 字号族），`MessageBrowser` 读截断长度，`MetricsDashboard` 读自动刷新与刷新间隔（单位为秒）。导出的配置包以 `format: 'pulsar-manager-config'` + `version: 1` 为标记，导入方先做本地体检再发往主进程。

### 4.8 插件市场（`plugin-handlers.ts`）

| IPC 通道 | 方向 | 功能 |
|---------|------|------|
| `plugin:list` | renderer → main | 扫描 `userData/plugins`，与官方目录合并，返回条目、加载失败清单与插件目录路径 |
| `plugin:installOfficial` | renderer → main | 把官方目录里的插件写入本机（与导入同一条落盘路径） |
| `plugin:import` | renderer → main | 接收插件 JSON **文本**（渲染层读的文件），校验后落盘；主进程不接触文件路径 |
| `plugin:uninstall` | renderer → main | 删除本机插件文件并清掉其启用状态 |
| `plugin:setEnabled` | renderer → main | 启用/停用（停用只让贡献数据消失，文件保留） |
| `plugin:revealDir` | renderer → main | 打开插件目录，回传路径与失败原因 |

插件清单由 zod 整份校验：`id` 形状、`version` 形如 1.0/1.0.0、压测参数逐字段带范围、Topic 模板的 `namePrefix` 限定字符集，且必须至少贡献一条预设或一个模板。校验不过的文件不静默丢弃，`plugin:list` 会把文件名与原因一并返回。渲染层 `usePluginStore` 从启用条目里派生 `presets` / `templates` 两个列表，分别由 `BenchmarkModal` 与 `TopicFormModal` 消费。

### 4.9 系统、主题与日志（`system-handlers.ts`）

| IPC 通道 | 方向 | 功能 |
|---------|------|------|
| `settings:get` / `settings:set` | renderer → main | 快捷键方案与其它界面设置的读写 |
| `theme:get` / `theme:set` | renderer → main | 三套主题的读取与切换 |
| `logs:getRecent` | renderer → main | 读取最近的操作日志（导出与查看共用一个上限） |

### 4.10 在线更新（`update-handlers.ts`）

| IPC 通道 | 方向 | 功能 |
|---------|------|------|
| `update:tokenStatus` | renderer → main | 查询本机是否已配置 Gitee 只读令牌 |
| `update:setToken` | renderer → main | 加密保存令牌 |
| `update:check` | renderer → main | 拉取最新发行版并比对版本号 |
| `update:download` | renderer → main | 下载发行版 exe 附件 |
| `update:install` | renderer → main | 静默安装并重启 |

### 4.11 生产者（`producer-handlers.ts`）

| IPC 通道 | 方向 | 功能 |
|---------|------|------|
| `producer:startSession` | renderer → main | 在指定 topic 上建常驻 producer 会话（带 `ProducerOptions`） |
| `producer:send` | renderer → main | 走常驻会话发送 1–1000 条（分批渲染逐条投），`templateName`/`templateId` 只给发送历史用 |
| `producer:sendOnce` | renderer → main | 不建会话的一次性发送，现开现关 |
| `producer:startFlow` / `producer:stopFlow` | renderer → main | 启动 / 停止连续限速流（`ratePerSecond` 0 不限、`totalMessages` 0 到手动停止、`maxInFlight`、`stopOnError`） |
| `producer:setRate` | renderer → main | 运行中改速率，只换限速器不重建 producer |
| `producer:flush` | renderer → main | 把原生队列最后一段立刻推出，不关会话 |
| `producer:stop` | renderer → main | 断开会话并移除；已不在时返回 `stopped: false` 而不是报错 |
| `producer:listSessions` | renderer → main | 列出当前常驻会话 |
| `msg:producer-stats` | main → renderer | 单向推送运行统计（已发/失败/字节、msg/s、MB/s、P50/P99） |

`batchingEnabled` 与 `chunkingEnabled` 同时为 true 会让原生绑定 abort 整个主进程，参数在 IPC 边界由 Zod `refine` 拒绝，构造 producer 时再兜一层 `chunkingEnabled && !batchingEnabled`。

### 4.12 消费者（`consumer-handlers.ts`）

| IPC 通道 | 方向 | 功能 |
|---------|------|------|
| `consumer:start` | renderer → main | 按订阅设置起一个消费会话（可多会话并存，Exclusive 除外） |
| `consumer:list` | renderer → main | 列出运行中的会话及其计数 |
| `consumer:stop` | renderer → main | 停止指定会话 |

批次与结束事件复用消息浏览器那两条推送通道（`msg:consume-batch` / `msg:session-end`），渲染层按 `sessionId` 分桶，不额外开新通道。

### 4.13 模板、消费配置与发送历史（`template-handlers.ts`）

| IPC 通道 | 方向 | 功能 |
|---------|------|------|
| `template:list` / `get` / `create` / `update` / `delete` / `copy` | renderer → main | 报文模板增删改查与复制，落 `message_templates`，作用域为 集群 + topic（空 topic 为通用） |
| `consumerConfig:list` / `get` / `create` / `update` / `delete` / `copy` | renderer → main | 消费者会话配置，落 `consumer_session_configs` |
| `sendHistory:list` | renderer → main | 按 集群 + topic 读最近 200 条发送历史，供生产者工作台的「发送历史」弹窗 |

---

## 五、数据流向图

### 5.1 集群配置数据流
```
用户输入 → ClusterConfig.tsx → IPC:cluster:add
                                    ↓
                              Zod 验证
                                    ↓
                              AES-256 加密 (auth_params)
                                    ↓
                              SQLite clusters 表
                                    ↓
                              返回成功响应
                                    ↓
                              useClusterStore 状态更新
```

### 5.2 Topic 统计数据流
```
用户打开 Topic 详情 → TopicDetail.tsx
                              ↓
                        IPC:resources:getTopicStats
                              ↓
                        获取 cluster 配置
                              ↓
                        创建/获取 Admin REST 客户端
                              ↓
                        REST API: /admin/v2/persistent/.../stats
                              ↓
                        解析响应数据
                              ↓
                        更新 React 状态 (15 秒刷新，仅在当前页签激活时轮询)
```

### 5.3 消息浏览数据流
```
用户打开消息浏览器 → MessageBrowser.tsx
                        ↓
                  IPC:messages:startRead（Reader）/ messages:startConsume（订阅）
                        ↓
                  主进程 pulsar-client 原生消费者 / Reader
                        ↓
                  「最近 N 条」= 从 earliest 往后扫 + 环形缓冲只留末 N 条（撞 2 万条 / 15 秒 / 8MB 任一护栏即收尾）
                        ↓
                  按批推送（攒够 50 条或 300ms）
                        ↓
                  渲染层追加到消息列表（base64 解回文本 → 判 json / xml / text → 着色与缩进）
```
Admin REST 没有发消息与 peek 的端点，消息收发只有原生客户端这一条路；类型判定以"能不能真解析出来"为准，判不出结构就按纯文本显示，列表标签与详情弹窗读的是同一份判定结果。

---

## 六、待完善的数据源

### 6.1 Prometheus 监控（规划中）
- **目标数据源**: Prometheus
- **实现方式**:
  1. 添加 `prometheus.ts` 服务
  2. 实现 PromQL 查询接口
  3. 预置核心指标查询模板
- **待实现指标**:
  - `pulsar_rate_in` - 消息输入速率
  - `pulsar_rate_out` - 消息输出速率
  - `pulsar_backlog` - 积压消息
  - `pulsar_storage_size` - 存储大小

### 6.2 历史数据查询（规划中）
- **目标**: 支持时间范围的历史数据查询
- **实现方式**:
  1. 集成 Prometheus 或 InfluxDB
  2. 实现时间范围选择器
  3. 支持导出历史数据

### 6.3 告警系统（规划中）
- **目标**: 实时监控 + 告警通知
- **实现方式**:
  1. 定义告警规则
  2. 实时监控指标变化
  3. 支持邮件、Webhook 通知

---

## 七、安全性说明

### 7.1 敏感数据加密
- **加密字段**: `auth_params`, `tls_trust_certs`, `password`, `private_key`, `passphrase`
- **加密算法**: AES-256-GCM（带完整性校验，密文被篡改时解密直接失败，而不是静默返回一段错误明文）
- **密钥管理**: 随机生成的数据密钥由 Electron `safeStorage`（OS 密钥库）保护；平台不支持时默认**拒绝降级**为明文密钥文件，需显式设置 `ALLOW_PLAINTEXT_KEY=1` 才会写明文密钥（不安全）

### 7.2 数据传输
- **接口面**: preload 以白名单形式暴露 `window.electronAPI`，通道名在 preload 里写字面量并用共享类型的字面量类型钉住，改名即编译失败；`sandbox: true` 下 preload 不能 require 相对模块，否则整个 preload 会被 Electron 静默跳过
- **调用方校验**: 主进程在 IPC 边界校验消息发送方必须是受信任来源且是主框架（页面里嵌一个 `file://` 的 iframe 拿不到全部通道），生产构建另有 CSP 兜住 `connect-src 'self'`
- **类型验证**: 每个通道的参数在入口用 Zod 解析，校验不过直接拒绝，不进入服务层
- **错误处理**: 统一的错误响应格式，主进程异常一律转成 `{success:false, error}`，不把原生堆栈直接抛给渲染进程
- **推送**: 主→渲染只推纯 JSON 载荷（`msg:read-batch` / `msg:consume-batch` / `msg:session-end` / `benchmark:progress`），类实例过不了沙箱边界

---

## 八、总结

### 当前数据来源
1. **本地存储**: SQLite 数据库（集群配置、SSH 隧道、操作日志、应用设置、快捷键绑定、报文模板、消费者会话配置、发送历史）
2. **Pulsar Admin API**: Topic 统计、资源配置与变更、聚合统计、集群拓扑、订阅积压、集群健康检查
3. **原生客户端 (pulsar-client)**: 消息发送（单发、常驻会话、连续限速流）、订阅消费、Reader 读取（含"最近 N 条"的扫描收尾）、快速压测

### 优化方向
1. 添加数据缓存层 (Redis/内存缓存)
2. 实现增量更新机制
3. 添加数据导出功能 (CSV/JSON)
4. 实现数据压缩和分页
