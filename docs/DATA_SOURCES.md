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
    clusters / ssh_tunnels / operation_logs / user_settings
```

## 二、页面数据来源详细说明

### 2.1 首页 (Home.tsx)

**数据来源：**
- **集群列表**: `window.electronAPI.cluster.list()`
  - IPC: `cluster:list`（Handler: `src/main/ipc/cluster-handlers.ts`）
  - 数据源: SQLite `clusters` 表
  - 字段: id, name, service_url, web_service_url, status, version

- **全局统计**: 真实聚合，不是示例值
  - `metrics:getAggregatedStats` 逐集群取回聚合统计（Top 数、分区、订阅、生产者、消费者、输入/输出速率、积压）
  - `metrics:getBrokers` 取回各集群活跃 Broker 数量
  - 渲染层把已连接集群的结果相加得到 6 张卡片：集群总数 / 在线 Brokers / 活跃 Topics（副文案带分区与订阅数）/ 消息输入速率 / 消息输出速率 / 积压消息
  - 单个集群失败只损失它自己的数字，其余照常显示；集群列表在加载期间变化时旧响应会被世代守卫丢弃

- **状态管理**: `useClusterStore` (Zustand)
  - 位置: `src/renderer/store/cluster.ts`
  - 方法: `fetchClusters()`, `deleteClusterAsync()`

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

#### 2.3.3 生产者/消费者
- **来源**: `TopicStats.producers` 和 `TopicStats.consumers`
- **刷新机制**: 15 秒定时刷新，且只在当前页签激活时轮询
  - antd Tabs 关闭才销毁、切走的页签只是 `display:none` 仍然挂载，组件读 `PaneActiveContext` 决定是否启动定时器，避免后台页签一直打 IPC

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
    from: 'earliest' | 'latest' | 'timestamp'
    timestamp?: number   // 仅 from === 'timestamp' 时提交
    maxMessages: number  // 上限 10000
  }
  ```
- **页签生命周期**: 切到内层其它页签（概览/订阅管理/配置）会停掉会话——页签是 `display:none` 而非卸载，不停的话它会一直在后台消费并把消息堆进看不见的列表

#### 2.4.3 消息发送
- **API**: `window.electronAPI.messages.send()`
- **IPC**: `messages:send`
- **实现**: 原生客户端 `producer.send()`，返回真实 `messageId`；属性为可选 JSON 对象（键值各限 1024 字符、条数上限 100）

#### 2.4.4 消息数据结构
```typescript
interface Message {
  messageId: string
  producerName: string
  sequenceId: number
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
    topics: string[]
    stats?: any
  }>
  topics: Array<{
    name: string
    tenant: string
    namespace: string
    partitions: number
    subscriptions: string[]
    producers: number
    consumers: number
    msgRateIn: number
    msgRateOut: number
    backlogSize: number
  }>
}
```

#### 2.6.3 节点关系
- **Broker → Topic**: 只按真实归属连线，归属未知就不连，不按序号轮转分配
- **边权重**: 基于 `msgRateIn`
- **配色**: 运行时从 CSS 变量读取，跟随亮色/暗色/护眼三套主题

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

### 3.5 索引
```sql
CREATE INDEX idx_clusters_status ON clusters(status);
CREATE INDEX idx_operation_logs_cluster_id ON operation_logs(cluster_id);
CREATE INDEX idx_operation_logs_created_at ON operation_logs(created_at);
CREATE INDEX idx_ssh_tunnels_status ON ssh_tunnels(status);
```

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
| `msg:session-end` | main → renderer | 会话自行结束（读满上限或出错）时通知界面复位 |

Admin REST 没有发消息与 peek 的端点（真实 broker 上返回 HTML 404），消息收发只有原生客户端这一条路。

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
                  主进程 pulsar-client 原生消费者
                        ↓
                  按批推送（攒够 50 条或 300ms）
                        ↓
                  渲染层追加到消息列表（base64 尝试解回文本）
```
Admin REST 没有发消息与 peek 的端点，消息收发只有原生客户端这一条路。

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
1. **本地存储**: SQLite 数据库 (集群配置、SSH 隧道、操作日志、应用设置、快捷键绑定)
2. **Pulsar Admin API**: Topic 统计、资源配置与变更、聚合统计、集群拓扑、订阅积压
3. **原生客户端 (pulsar-client)**: 消息发送、订阅消费、Reader 读取、快速压测

### 优化方向
1. 添加数据缓存层 (Redis/内存缓存)
2. 实现增量更新机制
3. 添加数据导出功能 (CSV/JSON)
4. 实现数据压缩和分页
