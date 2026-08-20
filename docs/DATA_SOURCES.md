# 页面数据来源说明文档

## 一、数据流架构

```
┌─────────────────────────────────────────────────────────────┐
│                    渲染进程 (Renderer)                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  React Pages │  │    Stores    │  │  IPC Bridge  │      │
│  │  (UI Layer)  │  │   (Zustand) │  │  (Preload)   │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                 │                 │                │
│         └─────────────────┼─────────────────┘                │
│                           │ IPC 调用                           │
└───────────────────────────┼───────────────────────────────────┘
                            │
┌───────────────────────────┼───────────────────────────────────┐
│                     主进程 (Main)                              │
│                           │                                   │
│  ┌───────────────────────┼───────────────────────────────┐  │
│  │              IPC Handlers (handlers.ts)                │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │  │
│  │  │cluster:list │  │:getTenants  │  │:getTopicStats│  │  │
│  │  │cluster:add  │  │:getNamespaces│ │:browse      │  │  │
│  │  │cluster:update│  │:getTopics   │  │:send        │  │  │
│  │  │cluster:delete│  │:getSubscriptions│            │  │  │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  │  │
│  └─────────┼─────────────────┼─────────────────┼──────────┘  │
│            │                 │                 │              │
│  ┌─────────┼─────────────────┼─────────────────┼──────────┐  │
│  │         ▼                 ▼                 ▼          │  │
│  │  ┌──────────────────────────────────────────────┐     │  │
│  │  │         核心服务层 (Core Services)            │     │  │
│  │  │  ┌──────────────┐  ┌───────────────────┐  │     │  │
│  │  │  │PulsarAdminClient│ │ PulsarClientSDK  │  │     │  │
│  │  │  └──────────────┘  └───────────────────┘  │     │  │
│  │  └──────────────────────────────────────────────┘     │  │
│  └────────────────────────┬──────────────────────────────┘  │
│                           │                                   │
│  ┌────────────────────────┼──────────────────────────────┐  │
│  │                        ▼                              │  │
│  │  ┌──────────────────────────────────────────────┐   │  │
│  │  │         持久层 (SQLite + AES-256)              │   │  │
│  │  │  ┌────────────────────────────────────────┐  │   │  │
│  │  │  │  clusters / ssh_tunnels / operation_logs│  │   │  │
│  │  │  └────────────────────────────────────────┘  │   │  │
│  │  └──────────────────────────────────────────────┘   │  │
│  └─────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────┘
```

## 二、页面数据来源详细说明

### 2.1 首页 (Home.tsx)

**数据来源：**
- **集群列表**: `window.electronAPI.cluster.list()`
  - IPC: `cluster:list`
  - Handler: `src/main/ipc/handlers.ts` 第 128-139 行
  - 数据源: SQLite `clusters` 表
  - 字段: id, name, service_url, web_service_url, status, version

- **全局统计**: 模拟数据（待接入真实 API）
  ```typescript
  const totalBrokers = clusters.length * 2  // TODO: 从 API 获取
  const totalTopics = clusters.length * 50
  const totalTps = clusters.length * 1000
  ```

- **状态管理**: `useClusterStore` (Zustand)
  - 位置: `src/renderer/store/cluster.ts`
  - 方法: `fetchClusters()`, `deleteClusterAsync()`

---

### 2.2 集群配置 (ClusterConfig.tsx)

**数据来源：**
- **集群配置表单**: 本地状态 `useState`
  - 字段: name, serviceUrl, webServiceUrl, authPlugin, authParams, tlsEnabled
  
- **连接测试**: `window.electronAPI.cluster.testConnection()`
  - IPC: `cluster:testConnection`
  - Handler: `src/main/ipc/handlers.ts` 第 250-273 行
  - 创建临时 `PulsarAdminClient` 测试连接
  
- **保存集群**: `window.electronAPI.cluster.add()`
  - IPC: `cluster:add`
  - Handler: `src/main/ipc/handlers.ts` 第 142-182 行
  - 数据存储: SQLite `clusters` 表
  - 敏感字段: `auth_params`, `tls_trust_certs` (AES-256 加密)

- **更新集群**: `window.electronAPI.cluster.update()`
  - IPC: `cluster:update`
  - Handler: `src/main/ipc/handlers.ts` 第 185-218 行

---

### 2.3 Topic 详情 (TopicDetail.tsx)

**数据来源：**

#### 2.3.1 Topic 统计信息
- **API**: `window.electronAPI.resources.getTopicStats()`
- **IPC**: `resources:getTopicStats`
- **Handler**: `src/main/ipc/handlers.ts` 第 378-414 行
- **Pulsar API**: `GET /admin/v2/persistent/{tenant}/{namespace}/{topic}/stats`
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
- **Pulsar API**: `GET /admin/v2/persistent/{tenant}/{namespace}/{topic}/subscriptions`

#### 2.3.3 生产者/消费者
- **来源**: `TopicStats.producers` 和 `TopicStats.consumers`
- **刷新机制**: 5秒定时刷新
  ```typescript
  useEffect(() => {
    fetchTopicStats()
    const interval = setInterval(fetchTopicStats, 5000)
    return () => clearInterval(interval)
  }, [fetchTopicStats])
  ```

---

### 2.4 消息浏览器 (MessageBrowser.tsx)

**数据来源：**

#### 2.4.1 订阅列表
- **API**: `window.electronAPI.resources.getSubscriptions()`
- **位置**: `src/renderer/pages/MessageBrowser.tsx` 第 46-63 行

#### 2.4.2 消息浏览
- **API**: `window.electronAPI.messages.browse()`
- **IPC**: `messages:browse`
- **Handler**: `src/main/ipc/handlers.ts`
- **Pulsar API**: `GET /admin/v2/persistent/{tenant}/{namespace}/{topic}/subscription/{sub}/peek/{count}`
- **参数**:
  ```typescript
  {
    clusterId: string
    tenant: string
    namespace: string
    topic: string
    subscription: string
    count: number  // 最大 500
  }
  ```

#### 2.4.3 消息发送
- **API**: `window.electronAPI.messages.send()`
- **IPC**: `messages:send`
- **Pulsar API**: `POST /admin/v2/persistent/{tenant}/{namespace}/{topic}/produce`

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

---

### 5.5 监控仪表盘 (MetricsDashboard.tsx)

**数据来源：**

#### 5.5.1 聚合统计（已实现真实 API）
- **API**: `window.electronAPI.metrics.getAggregatedStats()`
- **IPC**: `metrics:getAggregatedStats`
- **Handler**: `src/main/ipc/handlers.ts` 第 455-479 行
- **Pulsar API**: 遍历所有租户、命名空间和 Topic，聚合统计
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

#### 5.5.2 Broker 信息
- **API**: `window.electronAPI.metrics.getBrokers()`
- **IPC**: `metrics:getBrokers`
- **Pulsar API**: `GET /admin/v2/brokers`

#### 5.5.3 消息速率趋势
- **实现方式**: 定时刷新，每次刷新记录当前消息速率到历史数组
- **刷新间隔**: 可配置（5s/10s/30s/60s/手动）
- **历史记录**: 保留最近 60 个数据点

---

### 5.6 集群拓扑 (ClusterTopology.tsx)

**数据来源：**

#### 5.6.1 拓扑数据（已实现真实 API）
- **API**: `window.electronAPI.topology.getClusterTopology()`
- **IPC**: `topology:getClusterTopology`
- **Handler**: `src/main/ipc/handlers.ts` 第 538-562 行
- **Pulsar API**: 
  - Broker 列表: `GET /admin/v2/brokers`
  - 租户列表: `GET /admin/v2/tenants`
  - 命名空间: `GET /admin/v2/namespaces/{tenant}`
  - Topic 列表: `GET /admin/v2/namespaces/{tenant}/{namespace}/topics`
  - Topic 统计: `GET /admin/v2/persistent/{tenant}/{namespace}/{topic}/stats`

#### 5.6.2 拓扑数据类型
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

#### 5.6.3 节点关系
- **Broker → Topic**: 边权重固定为 100（可扩展为基于 broker 负载）
- **Topic → Subscription**: 边权重基于 `msgRateIn`

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
    details TEXT,
    result TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE SET NULL
);
```

---

## 四、IPC 通道清单

### 4.1 集群管理
| IPC 通道 | 方向 | 功能 |
|---------|------|------|
| `cluster:list` | renderer → main | 获取集群列表 |
| `cluster:add` | renderer → main | 添加集群 |
| `cluster:update` | renderer → main | 更新集群 |
| `cluster:delete` | renderer → main | 删除集群 |
| `cluster:testConnection` | renderer → main | 测试连接 |

### 4.2 资源管理
| IPC 通道 | 方向 | 功能 |
|---------|------|------|
| `resources:getTenants` | renderer → main | 获取租户列表 |
| `resources:getNamespaces` | renderer → main | 获取命名空间 |
| `resources:getTopics` | renderer → main | 获取 Topic 列表 |
| `resources:getTopicStats` | renderer → main | 获取 Topic 统计 |
| `resources:getSubscriptions` | renderer → main | 获取订阅列表 |

### 4.3 消息操作
| IPC 通道 | 方向 | 功能 |
|---------|------|------|
| `messages:browse` | renderer → main | 浏览消息 |
| `messages:send` | renderer → main | 发送消息 |
| `messages:peek` | renderer → main | 预览消息 |

### 4.4 监控
| IPC 通道 | 方向 | 功能 |
|---------|------|------|
| `metrics:getAggregatedStats` | renderer → main | 获取集群聚合统计 |
| `metrics:getBrokers` | renderer → main | 获取 Broker 列表 |
| `metrics:getNamespaceStats` | renderer → main | 获取命名空间统计 |

### 4.5 拓扑
| IPC 通道 | 方向 | 功能 |
|---------|------|------|
| `topology:getClusterTopology` | renderer → main | 获取集群拓扑 |

### 4.6 SSH 隧道
| IPC 通道 | 方向 | 功能 |
|---------|------|------|
| `ssh:list` | renderer → main | 获取隧道列表 |
| `ssh:add` | renderer → main | 添加隧道 |
| `ssh:connect` | renderer → main | 连接隧道 |
| `ssh:disconnect` | renderer → main | 断开隧道 |

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
                        创建/获取 PulsarAdminClient
                              ↓
                        REST API: /admin/v2/persistent/.../stats
                              ↓
                        解析响应数据
                              ↓
                        更新 React 状态 (5秒刷新)
```

### 5.3 消息浏览数据流
```
用户选择订阅 → MessageBrowser.tsx
                        ↓
                  IPC:messages:browse
                        ↓
                  Pulsar Admin API
                  GET /admin/v2/persistent/.../subscription/{sub}/peek/{count}
                        ↓
                  Base64 解码消息内容
                        ↓
                  更新消息列表 (最多500条)
```

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
- **加密算法**: AES-256-CBC
- **密钥管理**: 使用应用级密钥

### 7.2 数据传输
- **IPC 通信**: 使用 Electron IPC 通道
- **类型验证**: 使用 Zod 进行参数校验
- **错误处理**: 统一的错误响应格式

---

## 八、总结

### 当前数据来源
1. **本地存储**: SQLite 数据库 (集群配置、SSH 隧道、操作日志)
2. **Pulsar Admin API**: Topic 统计、消息浏览、资源列表、聚合统计、集群拓扑
3. **真实 API**: 监控仪表盘、集群拓扑（已实现）

### 优化方向
1. 添加数据缓存层 (Redis/内存缓存)
2. 实现增量更新机制
3. 添加数据导出功能 (CSV/JSON)
4. 实现数据压缩和分页
