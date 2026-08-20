# Pulsar 桌面管理工具 - 继续开发实施计划

## 一、现状分析

### 1.1 已完成的基础架构

| 模块 | 状态 | 说明 |
|------|------|------|
| Electron + React + TypeScript + Vite | ✅ 完成 | 完整的跨平台桌面应用架构 |
| IPC 通信框架 | ✅ 完成 | 通道定义完整，handlers 为 TODO |
| 三套主题系统 | ✅ 完成 | CSS 变量 + light/dark/eyeCare |
| Zustand 状态管理 | ✅ 完成 | cluster/tabs/theme 三个 store |
| 四分区布局组件 | ✅ 完成 | Layout/TopNav/ResourceTree/TabWorkspace |
| 首页集群列表 | ✅ 完成 | 静态数据展示 |
| Ant Design 5.x 集成 | ✅ 完成 | UI 组件库配置完成 |

### 1.2 待实现的核心功能

| 优先级 | 模块 | 说明 |
|--------|------|------|
| **P0** | SQLite 数据库层 | 持久化集群配置、敏感信息加密 |
| **P0** | Pulsar Admin API 客户端 | 对接 Pulsar 集群 REST API |
| **P0** | 集群连接配置页面 | 添加/编辑/删除集群 |
| **P0** | 资源树动态加载 | 从真实集群获取租户/命名空间/Topic |
| **P1** | SSH 隧道管理器 | ssh2 库实现内网穿透 |
| **P1** | Prometheus 监控查询 | 时序数据拉取和展示 |
| **P1** | 消息浏览器 | 消息查看和解码 |
| **P1** | 集群拓扑视图 | ECharts Graph 可视化 |

---

## 二、实施计划

### Phase 2: 核心基础设施（预计 2-3 天）

#### 2.1 SQLite 数据库层集成

**目标**：实现本地数据持久化，存储集群配置、操作日志等数据

**实现文件**：
- `src/main/database/sqlite.ts` - SQLite 连接管理
- `src/main/database/schema.sql` - 表结构定义
- `src/main/services/encryption.ts` - AES-256 加密工具

**具体步骤**：

1. **创建数据库模块**
   - 集成 better-sqlite3
   - 设计表结构：
     - `clusters` - 集群配置表
     - `operation_logs` - 操作日志表
     - `user_settings` - 用户设置表
     - `ssh_tunnels` - SSH 隧道配置表
   - 实现数据库初始化和迁移

2. **实现 AES-256 加密工具**
   - 使用 crypto-js 实现 AES-256-GCM
   - 生成并安全存储加密密钥
   - 提供加密/解密接口

3. **修改 IPC Handlers**
   - 实现 `cluster:add` - 保存集群配置（加密敏感字段）
   - 实现 `cluster:list` - 查询集群列表
   - 实现 `cluster:update` - 更新配置
   - 实现 `cluster:delete` - 删除集群
   - 实现 `cluster:testConnection` - 测试连接

#### 2.2 Pulsar Admin API 客户端

**目标**：封装 Pulsar Admin REST API，提供标准化的集群操作接口

**实现文件**：
- `src/main/services/pulsar-admin.ts` - Admin API 封装

**具体步骤**：

1. **实现 IPulsarAdminClient 接口**
   ```typescript
   interface IPulsarAdminClient {
     // 集群操作
     getClusterInfo(): Promise<ClusterInfo>

     // 租户操作
     getTenants(): Promise<Tenant[]>
     createTenant(name: string, config: TenantConfig): Promise<void>
     updateTenant(name: string, config: TenantConfig): Promise<void>
     deleteTenant(name: string): Promise<void>

     // 命名空间操作
     getNamespaces(tenant: string): Promise<Namespace[]>
     createNamespace(tenant: string, namespace: string): Promise<void>
     deleteNamespace(tenant: string, namespace: string): Promise<void>

     // Topic 操作
     getTopics(tenant: string, namespace: string): Promise<Topic[]>
     getTopicStats(tenant: string, namespace: string, topic: string): Promise<TopicStats>
     createTopic(tenant: string, namespace: string, topic: string, partitions?: number): Promise<void>
     deleteTopic(tenant: string, namespace: string, topic: string): Promise<void>

     // 订阅操作
     getSubscriptions(tenant: string, namespace: string, topic: string): Promise<Subscription[]>
     deleteSubscription(tenant: string, namespace: string, topic: string, subscription: string): Promise<void>

     // 消息操作
     peekMessages(tenant: string, namespace: string, topic: string, subscription: string, count: number): Promise<Message[]>
     expireMessages(tenant: string, namespace: string, topic: string, subscription: string, timestamp: number): Promise<void>
   }
   ```

2. **实现请求管理**
   - 请求队列（防止高频请求）
   - 自动重试（3次指数退避）
   - 超时控制（Admin API 5s）
   - 错误处理和日志记录

3. **实现认证支持**
   - 无认证模式
   - JWT Token 认证
   - mTLS 双向认证（未来扩展）

#### 2.3 SSH 隧道管理器

**目标**：实现基于 ssh2 的内网穿透功能

**实现文件**：
- `src/main/services/ssh-tunnel.ts` - SSH 隧道管理

**具体步骤**：

1. **实现 SSH 连接管理**
   - 支持密钥认证和密码认证
   - 自动重连机制（网络波动）
   - 本地随机端口分配

2. **实现端口转发**
   - Pulsar Admin 端口（默认 8080）
   - Pulsar Broker 端口（默认 6650）
   - 多级跳板机支持

3. **实现 IPC 通道**
   - `ssh:connect` - 建立 SSH 隧道
   - `ssh:disconnect` - 断开隧道
   - `ssh:status` - 查询隧道状态

### Phase 3: 核心功能模块（预计 3-4 天）

#### 3.1 集群连接配置页面

**目标**：实现完整的集群添加/编辑/删除功能

**实现文件**：
- `src/renderer/pages/ClusterConfig.tsx` - 集群配置页面
- `src/renderer/components/cluster/ClusterForm.tsx` - 集群表单组件

**具体步骤**：

1. **创建集群配置页面**
   - 三步式表单布局：
     - Step 1: 基础信息（名称、URL、类型）
     - Step 2: 认证配置（无认证/JWT/SSH隧道）
     - Step 3: 高级配置（超时、重试策略）
   - 实时表单校验
   - 在线探活功能

2. **实现集群卡片组件**
   - 集群状态展示（在线/离线/警告）
   - 快速操作按钮
   - 统计指标展示

3. **集成首页集群列表**
   - 替换静态数据为真实 API 调用
   - 实现加载状态和错误处理

#### 3.2 资源树动态加载

**目标**：实现左侧资源树的动态数据加载

**实现文件**：
- `src/renderer/components/layout/ResourceTree.tsx` - 资源树组件
- `src/renderer/hooks/useResources.ts` - 资源数据 Hook

**具体步骤**：

1. **实现资源数据 Hook**
   - `useTenants()` - 获取租户列表
   - `useNamespaces(tenant)` - 获取命名空间
   - `useTopics(tenant, namespace)` - 获取 Topic 列表
   - LRU 缓存策略（5分钟过期）

2. **增强资源树组件**
   - 异步加载子节点
   - 节点状态标色（在线/离线/警告）
   - 展开/折叠动画
   - 右键快捷菜单

3. **实现右键菜单**
   - 查看 Topic 详情
   - 清理积压
   - 编辑配置
   - 删除资源

#### 3.3 Topic 详情页面

**目标**：实现 Topic 的详细信息查看和管理

**实现文件**：
- `src/renderer/pages/TopicDetail.tsx` - Topic 详情页
- `src/renderer/components/topic/MetricsCards.tsx` - 指标卡片
- `src/renderer/components/topic/SubscriptionList.tsx` - 订阅列表
- `src/renderer/components/topic/MessageBrowser.tsx` - 消息浏览器

**具体步骤**：

1. **创建 Topic 详情页布局**
   - 顶部指标卡片（TPS、积压、消费者数）
   - 二级 Tab 体系（订阅/消息/Schema/配置/监控）

2. **实现订阅管理 Tab**
   - 订阅列表展示
   - 消费者详情
   - 积压量可视化
   - 清理积压操作

3. **实现消息浏览器 Tab**
   - 多维度游标定位
   - 消息列表展示
   - 智能截断与展开（默认50字符）
   - 消息解码（JSON/Protobuf/Avro）

---

## 三、文件清单

### 主进程新增文件

| 文件路径 | 说明 |
|----------|------|
| `src/main/database/sqlite.ts` | SQLite 数据库连接管理 |
| `src/main/database/schema.sql` | 数据库表结构 |
| `src/main/services/encryption.ts` | AES-256 加密工具 |
| `src/main/services/pulsar-admin.ts` | Pulsar Admin API 客户端 |
| `src/main/services/ssh-tunnel.ts` | SSH 隧道管理器 |
| `src/main/services/prometheus.ts` | Prometheus 查询客户端（未来） |

### 渲染进程新增/修改文件

| 文件路径 | 说明 |
|----------|------|
| `src/renderer/pages/ClusterConfig.tsx` | 集群配置页面（新建） |
| `src/renderer/pages/TopicDetail.tsx` | Topic 详情页（新建） |
| `src/renderer/pages/MessageBrowser.tsx` | 消息浏览器（新建） |
| `src/renderer/pages/Settings.tsx` | 设置页面（新建） |
| `src/renderer/components/cluster/ClusterForm.tsx` | 集群表单组件（新建） |
| `src/renderer/components/topic/*` | Topic 相关组件（新建目录） |
| `src/renderer/components/message/*` | 消息相关组件（新建目录） |
| `src/renderer/hooks/useResources.ts` | 资源数据 Hook（新建） |
| `src/renderer/store/cluster.ts` | 增强集群状态管理 |

### 修改文件

| 文件路径 | 修改内容 |
|----------|----------|
| `src/main/ipc/handlers.ts` | 实现所有 TODO 的 IPC 处理器 |
| `src/main/index.ts` | 初始化数据库、注册服务 |
| `src/preload.ts` | 补充缺失的 API |
| `src/renderer/components/layout/ResourceTree.tsx` | 实现动态加载 |
| `src/renderer/components/layout/TopNav.tsx` | 实现功能入口 |
| `src/renderer/pages/Home.tsx` | 对接真实 API |
| `src/renderer/store/cluster.ts` | 增强状态管理 |

---

## 四、验证方案

### 4.1 功能验证

1. **数据库验证**
   - 启动应用，检查 SQLite 数据库文件创建
   - 添加集群配置，关闭应用后重新打开，数据持久化

2. **集群连接验证**
   - 添加真实 Pulsar 集群配置
   - 测试连接探活功能
   - 资源树正确加载租户/命名空间/Topic

3. **SSH 隧道验证**
   - 配置 SSH 隧道连接内网集群
   - 验证端口转发正常工作

### 4.2 性能验证

1. **启动速度**：冷启动 <3s，二次启动 <2s
2. **资源树加载**：10w+ Topic 无卡顿展示
3. **内存占用**：稳定峰值 <500MB

---

## 五、实施顺序

```
第1步：实现 SQLite 数据库层 + 加密工具
     ↓
第2步：实现 Pulsar Admin API 客户端（核心）
     ↓
第3步：增强 cluster store，支持真实数据
     ↓
第4步：实现集群配置页面（添加/编辑/删除）
     ↓
第5步：增强首页，对接真实 API
     ↓
第6步：实现资源树动态加载
     ↓
第7步：实现 Topic 详情页面 + 消息浏览器
     ↓
第8步：实现 SSH 隧道管理器
```

---

## 六、注意事项

1. **不要过度工程化**：先实现核心功能，再考虑扩展性
2. **严格遵守设计系统**：所有样式通过 CSS 变量定义
3. **安全性第一**：敏感数据必须加密，高危操作必须二次确认
4. **性能持续监控**：每个功能完成后进行内存和 CPU profiling
5. **跨平台早期测试**：不要在单一平台开发太久，尽早三端验证
