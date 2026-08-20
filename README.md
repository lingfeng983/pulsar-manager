# Pulsar Manager Desktop

Pulsar 桌面管理工具 - 企业级消息中间件运维客户端

## 技术栈

- **桌面容器**: Electron 29.x LTS
- **前端框架**: React 18.x + TypeScript 5.x
- **UI 组件库**: Ant Design 5.x
- **状态管理**: Zustand 4.x
- **图表库**: ECharts 5.4.x
- **数据库**: SQLite (better-sqlite3)
- **HTTP 客户端**: Axios 1.6.x
- **打包工具**: electron-builder 24.x

## 项目结构

```
pulsar-manager/
├── src/
│   ├── main/                    # Electron 主进程
│   │   ├── index.ts            # 主进程入口
│   │   └── ipc/                # IPC 通信处理
│   │       └── handlers.ts     # IPC handlers 注册
│   ├── renderer/               # React 渲染进程
│   │   ├── components/         # UI 组件
│   │   │   └── layout/         # 布局组件
│   │   │       ├── Layout.tsx      # 全局布局
│   │   │       ├── TopNav.tsx      # 顶部导航栏
│   │   │       ├── ResourceTree.tsx # 左侧资源树
│   │   │       └── TabWorkspace.tsx # Tab 工作区
│   │   ├── pages/              # 页面组件
│   │   │   └── Home.tsx        # 首页总览
│   │   ├── store/              # Zustand 状态管理
│   │   │   ├── theme.ts        # 主题状态
│   │   │   ├── cluster.ts      # 集群状态
│   │   │   └── tabs.ts         # Tab 状态
│   │   ├── types/              # TypeScript 类型定义
│   │   │   └── index.ts        # 核心类型
│   │   ├── App.tsx             # 应用根组件
│   │   ├── main.tsx            # React 入口
│   │   └── index.css           # 全局样式（含三套主题）
│   └── preload.ts              # 预加载脚本
├── package.json
├── tsconfig.json               # TypeScript 配置
├── tsconfig.node.json          # Node 进程 TS 配置
├── vite.config.ts              # Vite 构建配置
├── electron-builder.json       # 打包配置
└── index.html                  # HTML 入口
```

## 快速开始

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

这会同时启动：
- Vite 开发服务器（前端，端口 5173）
- Electron 应用（自动加载前端）

### 构建

```bash
# 构建主进程
npm run build:main

# 构建前端
npm run build

# 打包应用
npm run electron:dist
```

## 已实现功能

### ✅ Phase 1: 项目初始化与基础架构

- [x] 项目初始化和依赖安装
- [x] TypeScript、Vite、Electron 配置
- [x] Electron 主进程和预加载脚本
- [x] IPC 通信框架（含 Zod 参数校验）
- [x] 全局四分区布局（顶部导航栏 + 左侧资源树 + Tab 工作区）
- [x] 三套主题系统（亮色/暗色/护眼）
- [x] 状态管理（Zustand）
- [x] 首页集群总览（列表视图）

### 🚧 待实现功能

#### Phase 2: 核心基础设施

- [ ] SQLite 数据库层和 AES-256 加密工具
- [ ] Pulsar Admin API 客户端封装
- [ ] SSH 隧道管理器
- [ ] Prometheus 查询客户端

#### Phase 3: 核心功能模块

- [ ] 集群连接配置（三步式表单）
- [ ] Topic 详情页面
- [ ] 消息浏览器（智能截断与展开）
- [ ] 监控与可视化面板
- [ ] 集群拓扑视图（ECharts Graph）

#### Phase 4: 增强功能

- [ ] 快捷键自定义系统
- [ ] Schema 管理
- [ ] 权限管理
- [ ] 压测引擎

## 设计规范

### 主题系统

项目支持三套主题，通过 CSS 变量统一管理：

**亮色主题（默认）**
- 主色: `#1677FF`
- 成功: `#00B42A`
- 警告: `#FF7D00`
- 危险: `#F53F3F`

**暗色主题**
- 主色: `#4096FF`
- 成功: `#00C42A`
- 警告: `#FF9500`
- 危险: `#FF4D4F`

**护眼主题**
- 主色: `#5B8FF9`
- 背景: `#F5F5DC`

所有样式通过 CSS 变量定义，禁止硬编码颜色值。

### 布局规范

- 顶部导航栏高度: `48px`（固定）
- 左侧资源树宽度: `240px`（可折叠至 `48px`）
- Tab 栏高度: `36px`
- 最小窗口尺寸: `1000px × 700px`

### 间距系统

基于 4px 栅格：
- `--spacing-xs`: 4px
- `--spacing-sm`: 8px
- `--spacing-md`: 12px
- `--spacing-lg`: 16px
- `--spacing-xl`: 24px
- `--spacing-xxl`: 32px

## 已知问题

### Electron 安装问题

如果看到 "Electron failed to install correctly" 错误：

```bash
# Windows
rmdir /s /q node_modules\electron
npm install electron@29.4.6 --save-dev

# Linux/Mac
rm -rf node_modules/electron
npm install electron@29.4.6 --save-dev
```

## 下一步

根据设计文档，接下来需要实现：

1. **SQLite 数据库集成** - 存储集群配置和操作日志
2. **Pulsar Admin API 客户端** - 对接 Pulsar 集群
3. **SSH 隧道管理器** - 内网穿透访问
4. **完整的集群配置页面** - 添加/编辑/删除集群
5. **资源树动态加载** - 从真实集群获取数据

## 参考文档

- [详细设计说明书](../Pulsar 桌面管理工具详细设计说明书.md)
- [UI 详细设计规范](../Pulsar 桌面管理工具 UI 详细设计规范（最终完整版）.md)
- [实施计划](C:\Users\yangjie\AppData\Roaming\QoderCN\SharedClientCache\cli\specs\continue.md)

## 许可证

Apache-2.0
