# Pulsar 桌面管理工具实施计划

## Context（背景）

用户要求根据两份详细设计文档开发一个 **Pulsar 桌面管理工具**，这是一个企业级消息中间件运维客户端。核心需求包括：

- **技术栈**：Electron 29.x + React 18.x + TypeScript 5.x
- **架构**：四层架构（表现层、IPC桥接层、核心服务层、持久层）
- **核心功能**：多集群管理、资源管理、消息调试、监控可视化、压测引擎
- **UI规范**：极简中后台工业风，支持亮色/暗色/护眼三套主题
- **特殊能力**：SSH隧道代理、AES-256加密存储、ECharts拓扑图、快捷键自定义

这是一个从零开始的全新项目，需要完整的桌面应用架构和跨平台能力。

## 技术方案

### 架构设计

采用 Electron + React 前后端分离混合架构：

1. **表现层（UI Layer）**：React + Ant Design 5.x + ECharts 5.4.x
2. **桥接层（IPC Bridge）**：Electron IPC + Zod 类型校验
3. **核心服务层（Core Service）**：Pulsar Admin API、Pulsar Client SDK、Prometheus查询、SSH隧道
4. **持久层（Storage Layer）**：SQLite (better-sqlite3) + AES-256-GCM加密

### 关键依赖选型

- UI组件库：Ant Design 5.x（替代 shadcn/ui，更适合企业级中后台）
- 状态管理：Zustand 4.x
- HTTP客户端：Axios 1.6.x
- 图表库：ECharts 5.4.x
- SSH隧道：ssh2 1.14.x
- 数据库：better-sqlite3 9.x
- 加密：crypto-js 4.x + node-forge
- 打包：electron-builder 24.x

### 目录结构

```
pulsar-manager/
├── package.json
├── electron-builder.json      # 打包配置
├── tsconfig.json
├── tsconfig.node.json         # Node进程TS配置
├── vite.config.ts             # Vite配置
├── index.html
└── src/
    ├── main/                  # Electron主进程
    │   ├── index.ts           # 主进程入口
    │   ├── ipc/               # IPC通信处理
    │   ├── services/          # 核心服务
    │   │   ├── pulsar-admin.ts    # Pulsar Admin API封装
    │   │   ├── pulsar-client.ts   # Pulsar Client SDK
    │   │   ├── ssh-tunnel.ts      # SSH隧道管理
    │   │   ├── prometheus.ts      # Prometheus查询
    │   │   └── encryption.ts      # AES-256加密
    │   ├── database/          # 数据库层
    │   │   ├── sqlite.ts      # SQLite连接
    │   │   └── schema.sql     # 表结构
    │   └── utils/             # 工具函数
    ├── renderer/              # React渲染进程
    │   ├── App.tsx
    │   ├── main.tsx
    │   ├── index.css          # 全局样式
    │   ├── components/        # UI组件
    │   │   ├── layout/        # 布局组件
    │   │   │   ├── TopNav.tsx       # 顶部导航栏
    │   │   │   ├── ResourceTree.tsx # 左侧资源树
    │   │   │   └── TabWorkspace.tsx # Tab工作区
    │   │   ├── cluster/       # 集群相关
    │   │   ├── topic/         # Topic相关
    │   │   ├── message/       # 消息浏览器
    │   │   ├── metrics/       # 监控图表
    │   │   └── common/        # 通用组件
    │   ├── pages/             # 页面组件
    │   │   ├── Home.tsx       # 首页总览
    │   │   ├── ClusterConfig.tsx  # 集群配置
    │   │   ├── TopicDetail.tsx    # Topic详情
    │   │   ├── MessageBrowser.tsx # 消息浏览器
    │   │   ├── MetricsDashboard.tsx # 监控面板
    │   │   └── Settings.tsx   # 设置页
    │   ├── store/             # Zustand状态管理
    │   │   ├── cluster.ts
    │   │   ├── theme.ts
    │   │   └── tabs.ts
    │   ├── hooks/             # 自定义Hooks
    │   ├── types/             # TypeScript类型定义
    │   └── utils/             # 前端工具
    └── preload.ts             # 预加载脚本
```

## 实施步骤

### Phase 1: 项目初始化与基础架构（1-2天）

1. **初始化项目**
   - 创建 package.json，安装所有依赖
   - 配置 TypeScript、Vite、Electron
   - 设置 electron-builder 打包配置

2. **搭建 Electron 主进程**
   - 创建主进程入口文件 `src/main/index.ts`
   - 实现窗口管理、菜单、托盘图标
   - 配置沙箱模式和安全策略

3. **建立 IPC 通信框架**
   - 创建 IPC 通道定义和类型系统
   - 使用 Zod 实现参数校验
   - 实现请求/响应标准化格式

4. **配置开发环境**
   - Vite 热更新配置
   - 主进程自动重启
   - Source map 调试支持

### Phase 2: 核心基础设施（2-3天）

5. **实现持久层**
   - 集成 better-sqlite3
   - 设计数据库表结构（集群配置、操作日志等）
   - 实现 AES-256-GCM 加密/解密工具

6. **构建 Pulsar Admin API 客户端**
   - 封装 IPulsarAdminClient 接口
   - 实现租户、命名空间、Topic CRUD
   - 添加请求队列、重试、限流机制

7. **实现 SSH 隧道管理器**
   - 基于 ssh2 库实现端口转发
   - 支持密钥认证、自动重连
   - 本地随机端口分配

8. **集成 Prometheus 查询**
   - 实现 PromQL 客户端
   - 预置 Pulsar 核心监控指标查询
   - 时序数据降采样处理

### Phase 3: UI 框架与全局布局（2天）

9. **建立设计系统**
   - 定义 CSS 变量（亮色/暗色/护眼三套主题）
   - 配置 Ant Design 主题定制
   - 实现主题切换机制

10. **实现四分区骨架布局**
    - 顶部全局导航栏（48px固定高度）
    - 左侧资源树面板（240px可折叠）
    - 中间多Tab工作区
    - 底部状态栏（可选）

11. **开发顶部导航栏**
    - Logo区域 + 全局搜索框
    - 工具按钮（探活、压测、导出、主题切换）
    - 网络状态、任务进度提示
    - 设置下拉菜单

12. **实现左侧资源树**
    - 层级结构：集群 → 租户 → 命名空间 → Topic
    - 节点状态标色（在线/离线/警告）
    - 右键快捷菜单
    - LRU缓存策略

### Phase 4: 核心功能模块（5-7天）

13. **首页集群总览**
    - 列表视图：集群卡片 + 全局指标大盘
    - 拓扑视图：ECharts Graph 关系图
      - Broker/Topic/Partition/订阅组四层节点
      - 连线流向规则
      - 画布交互（缩放、拖拽、筛选）
    - 最近操作日志面板

14. **集群连接配置**
    - 三步式表单（基础信息、认证配置、高级配置）
    - 支持直连/SSH/K8s三种网络模式
    - 实时表单校验 + 在线探活
    - 敏感配置加密存储

15. **Topic 详情页面**
    - 顶部指标卡片（TPS、积压、消费者数）
    - 二级Tab体系：订阅管理、消息浏览器、Schema、配置、监控
    - **消息智能截断与展开**（重点）
      - 默认截断前50字符
      - 悬浮Tooltip速览
      - 行内折叠展开
      - 弹窗全屏查看

16. **消息浏览器**
    - Web Worker异步解码管线
    - 多维度游标定位（时间戳、MessageID、Earliest/Latest）
    - 生产者池批量压测
    - 虚拟滚动（单页500条限制）

17. **监控与可视化**
    - ECharts时序图表（折线图、仪表盘）
    - 实时监控数据推送
    - 告警通知（系统原生通知）

18. **Schema 管理**
    - Schema 可视化解析（JSON/Protobuf/Avro）
    - 版本管控（历史对比、回滚）
    - 消息校验

### Phase 5: 增强功能（2-3天）

19. **快捷键自定义系统**
    - 快捷键配置页面
    - 按键捕获与冲突检测
    - 跨平台兼容（Windows/macOS/Linux）
    - 配置导入导出

20. **权限管理模块**
    - 权限可视化树形展示
    - 批量授权
    - 权限审计日志

21. **压测引擎增强**
    - 多压测模式（固定TPS、阶梯升压、最大吞吐）
    - 自动化压测报告生成
    - 模板化复用

### Phase 6: 优化与质量保障（2天）

22. **性能优化**
    - 代码分包懒加载
    - 虚拟滚动优化
    - 内存防泄漏（组件销毁解绑）
    - V8代码缓存加速

23. **异常处理与安全**
    - 网络超时容错（Admin API 5s、消息10s、监控8s）
    - 熔断降级机制
    - 高危操作二次确认
    - 敏感信息清零

24. **测试与验证**
    - 单元测试（核心工具函数）
    - 集成测试（Pulsar API对接）
    - 性能测试（大数据量加载）
    - 兼容性测试（多版本Pulsar、三端OS）

### Phase 7: 打包发布准备（1天）

25. **跨平台打包配置**
    - Windows NSIS安装包 + 便携版
    - macOS DMG镜像 + PKG（双架构适配）
    - Linux DEB/RPM/AppImage

26. **自动更新机制**
    - electron-updater差分更新
    - 分层更新策略
    - 故障自动回滚

27. **应用安全加固**
    - 官方代码签名准备
    - 进程沙箱隔离
    - 权限最小化配置

## 关键文件清单

### 核心配置文件
- `package.json` - 项目依赖和脚本
- `electron-builder.json` - 打包配置
- `vite.config.ts` - Vite构建配置
- `tsconfig.json` / `tsconfig.node.json` - TypeScript配置

### 主进程关键文件
- `src/main/index.ts` - 主进程入口
- `src/main/ipc/handlers.ts` - IPC处理器注册
- `src/main/services/pulsar-admin.ts` - Pulsar Admin API封装
- `src/main/services/ssh-tunnel.ts` - SSH隧道管理
- `src/main/database/sqlite.ts` - SQLite数据库连接
- `src/preload.ts` - 预加载脚本

### 渲染进程关键文件
- `src/renderer/App.tsx` - 应用根组件
- `src/renderer/components/layout/TopNav.tsx` - 顶部导航栏
- `src/renderer/components/layout/ResourceTree.tsx` - 资源树
- `src/renderer/pages/Home.tsx` - 首页总览
- `src/renderer/pages/TopicDetail.tsx` - Topic详情页
- `src/renderer/store/cluster.ts` - 集群状态管理
- `src/renderer/store/theme.ts` - 主题状态管理

### 样式系统
- `src/renderer/index.css` - 全局样式和CSS变量
- `src/renderer/styles/themes.ts` - 主题配置

## 验证方案

### 功能验证
1. **集群管理**：添加多个集群配置，测试连接探活
2. **资源浏览**：查看租户、命名空间、Topic树状结构
3. **消息收发**：发送测试消息，查看消息内容（含超长报文截断）
4. **监控查看**：连接Prometheus，查看实时指标图表
5. **拓扑视图**：渲染Broker-Topic-Partition-订阅组关系图
6. **快捷键**：自定义快捷键配置，测试冲突检测

### 性能验证
1. **启动速度**：冷启动 <3s，二次启动 <2s
2. **内存占用**：稳定峰值 <1GB，消息浏览器 <500MB
3. **大数据渲染**：10w+ Topic无卡顿展示
4. **图表性能**：海量监控数据60fps渲染

### 兼容性验证
1. **Pulsar版本**：2.8.x ~ 3.2.x LTS
2. **操作系统**：Windows 10/11、macOS 12+、Ubuntu 20.04+
3. **高分屏**：100%/125%/150%/200%缩放

### 安全验证
1. **加密存储**：JWT Token、密钥等敏感信息AES-256加密
2. **高危操作**：删除Topic等操作需输入名称二次确认
3. **内存清零**：临时Token使用后立即清空

## 风险与应对

### 技术风险
- **Electron + React集成复杂度**：优先搭建最小可行原型，逐步迭代
- **Pulsar多版本API差异**：实现API适配层，统一DTO转换
- **大数据量内存泄漏**：严格虚拟滚动，定时内存快照检测

### 进度风险
- **功能范围过大**：优先实现核心功能（集群管理、消息浏览、监控），高级功能（压测、插件）后续迭代
- **跨平台兼容问题**：早期在三个平台测试，避免后期大规模调整

## 优先级排序

### P0（必须实现）
- 多集群连接管理
- 资源树浏览（租户/命名空间/Topic）
- 消息查看器（含智能截断）
- 基础监控图表
- 三套主题切换

### P1（重要）
- 集群拓扑可视化
- SSH隧道代理
- Schema管理
- 快捷键自定义
- 批量操作能力

### P2（可选）
- 压测引擎
- 插件系统
- 事务消息管理
- 死信队列管理
- 国际化多语言

## 注意事项

1. **不要过度工程化初期版本**：先实现核心功能，再考虑扩展性
2. **严格遵守设计系统**：所有样式通过CSS变量定义，禁止硬编码颜色
3. **安全性第一**：敏感数据必须加密，高危操作必须二次确认
4. **性能持续监控**：每个功能完成后进行内存和CPU profiling
5. **跨平台早期测试**：不要在单一平台开发太久，尽早三端验证
