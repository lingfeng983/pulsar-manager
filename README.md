# Pulsar Manager Desktop

Apache Pulsar 集群的桌面运维客户端，基于 Electron + React + TypeScript。所有与 broker 的通信都在主进程完成，渲染进程只通过 preload 暴露的白名单接口拿数据。

## 功能

### 集群管理

- 集群增删改查、连接测试（走 Admin API 健康检查，并尝试读取集群版本）
- 凭据以 AES-256 加密后落库，加密密钥由 Electron `safeStorage`（OS 密钥库）保护；平台不支持时默认**拒绝降级**为明文，需显式设置 `ALLOW_PLAINTEXT_KEY=1` 才会写明文密钥文件
- 单实例锁：重复启动会把焦点交回已有窗口，而不是再起一个进程

### 资源浏览与管理

- 资源树按 租户 → 命名空间 → Topic 三层懒加载，带模块级缓存与竞态保护（订阅在 Topic 详情页里管理）
- **Topic**：详情（stats / 生产者 / 消费者 / 订阅）、创建（分区与非分区、持久与非持久）、删除、配置读取与修改
    - 配置是**逐策略端点**并发读取的（retention、backlog-quota、ttl、max-producers、max-consumers、message-ttl、deduplication、permissions），单个端点缺失只降级该项，不会让整个表单空白
    - 写入是 read-modify-write 后**只 PUT 变更过的键**
- **租户 / 命名空间**：创建、更新、删除
- **订阅**：创建、删除、重置游标、跳过消息
- 上述资源类变更都会写入操作日志，可从顶部导航导出最近 100 条为 JSON

### 消息收发

三种模式互不混淆（不是一个列表里塞所有东西）：

- **发送测试**：通过原生客户端向指定 topic 发一条消息，返回真实 messageId
- **订阅消费**：以指定订阅消费，支持从 earliest / latest / 指定时间戳开始；自动 ack 可关闭（关闭后消息不被确认，用于观察 backlog 累积），但界面没有逐条手动 ack 的入口
- **Reader 按位置读**：不占用订阅、不影响 backlog 的只读浏览

消息由主进程按批推送（攒够 50 条或 300ms 一批），载荷为 base64；界面会尝试解回文本，判定为二进制时才保留 base64。支持导出 JSON / CSV。

### 监控与拓扑

- 首页总览与监控面板：集群聚合统计与 broker 列表（数据来自 Admin API 的真实 stats 聚合，不是造出来的示例值）
- 集群拓扑图：力导向 / 环形两种布局切换，按节点类型与名称筛选，节点点击可直接打开对应详情页
    - broker→topic 的归属关系只在**能拿到真实来源**时才画连线；拿不到时载荷里 `ownershipSource` 明确标注为不可用，界面也会提示，不编造全连接图
    - 配色运行时从 CSS 变量读取，跟随亮色/暗色/护眼三套主题

### 界面

- 多 Tab 工作区，同一资源不会重复开 Tab
- 快捷键自定义：`ShortcutConfig` 页面按分组列出所有可绑定命令，绑定持久化到本地设置；只有当前页面真的注册了处理器的命令才会响应按键，不会出现"按了没反应"的假绑定
- 三套主题：亮色（默认）、暗色、护眼，全部走 CSS 变量，禁止硬编码颜色

## 技术栈

| 层          | 选型                                                                 |
| ----------- | -------------------------------------------------------------------- |
| 桌面容器    | Electron 29                                                          |
| 前端        | React 18 + TypeScript 5.6 + Vite 5                                   |
| UI / 状态   | Ant Design 5、Zustand 4                                              |
| 图表        | ECharts 5.4                                                          |
| 本地存储    | better-sqlite3 9                                                     |
| Pulsar 通信 | axios（Admin REST）+ pulsar-client 1.18（原生消息收发）              |
| 参数校验    | zod 3                                                                |
| 打包        | electron-builder 24（Windows NSIS / macOS dmg / Linux AppImage+deb） |
| 代码质量    | ESLint 9 + Prettier 3                                                |

## 目录结构

```
pulsar-manager/
├── src/
│   ├── main/                  # Electron 主进程：所有 broker I/O 都在这里
│   │   ├── index.ts           # 入口、窗口、单实例锁、生命周期清理
│   │   ├── config/            # 请求并发、重试、聚合上限等常量
│   │   ├── database/          # SQLite schema 与数据访问
│   │   ├── ipc/               # IPC handler（按域拆分）+ 主→渲染推送
│   │   ├── services/          # Admin REST 客户端、指标聚合、原生客户端、加密
│   │   └── utils/             # 日志
│   ├── preload.ts             # 沙箱 preload：唯一暴露给渲染进程的接口面
│   ├── shared/types.ts        # 跨进程共享的领域类型（单一事实来源）
│   └── renderer/              # React 渲染进程
│       ├── components/        # 布局、资源树、拓扑、各类表单弹窗
│       ├── hooks/             # 资源缓存、ECharts、快捷键、全屏、尺寸监听
│       ├── pages/             # 首页、集群配置、Topic/租户/命名空间详情、消息浏览器、监控、快捷键
│       ├── store/             # Zustand：集群、Tab、主题、命令、快捷键
│       └── utils/             # 格式化、导出、拓扑配色、按键解析
├── docs/DATA_SOURCES.md       # 每个页面的数据来源说明
├── release.sh                 # 一键出包 + 发布 Gitee 发行版
├── scripts/release-publish.mjs# 调 Gitee API 建/更新发行版并上传附件
├── electron-builder.json      # 打包配置
├── vite.config.ts             # 前端构建 + 生产 CSP 注入
└── tsconfig.node.json         # 主进程/preload 的 TS 配置（CommonJS）
```

根目录另有一份[《详细设计说明书》](./Pulsar%20桌面管理工具详细设计说明书.md)和一份[《UI 详细设计规范》](./Pulsar%20桌面管理工具%20UI%20详细设计规范（最终完整版）.md)，是项目最初的设计输入，部分细节已被后续实现取代。

## 快速开始

### 环境要求

- Node.js 20 或更高（开发在 v24 上验证）
- npm 源已在 `.npmrc` 中指向 npmmirror，Electron 二进制也走国内镜像
- `pulsar-client` 是原生模块（node-addon-api），安装时会下载预编译产物（Windows 为 `napi-win32-unknown-x64`），需要能访问镜像或 Apache 归档；**不需要**本地 C++ 工具链

### 安装与开发

```bash
npm install          # postinstall 会执行 electron-builder install-app-deps，把 better-sqlite3 重建到 Electron ABI
npm run dev          # 并行启动 Vite(5173) 与 Electron
```

也可以分开跑：`npm run dev:renderer`（只起前端）、`npm run dev:main`（编译主进程后启动 Electron）。

### 构建与打包

```bash
npm run build:main   # tsc -p tsconfig.node.json → dist/src/main、dist/src/preload.js
npm run build        # tsc -b + vite build → dist/renderer
npm run electron:pack  # 免安装目录，产物在 release/win-unpacked
npm run electron:dist  # NSIS 安装包 → release/Pulsar管理工具-安装包-<version>.exe
```

原生 `.node` 通过 `asarUnpack` 精确解包（better-sqlite3、pulsar-client 两个文件各自列出）。`npmRebuild` 保持 `false`，原生模块的 Electron ABI 适配由 `postinstall` 的 `install-app-deps` 在安装阶段一次完成——pulsar-client 走 N-API 跨 ABI 稳定，better-sqlite3 是 V8 ABI，必须按 Electron 头重建，缺了这一步打包态启动即崩。**开发态能跑不代表打包态能跑**，改过原生依赖后请在 `release/win-unpacked` 里启动验证一次。

### 提交前的四道门

```bash
npx tsc -b --force   # 类型
npx eslint src       # 规范（max-len 120 在 prettier 之后重新开启）
npm run format:check # 格式，不符时先 npm run format
npm run build:main && npm run build
```

### 发版

一条命令跑完静态门、出包、打标签、发布到 Gitee 发行版：

```bash
./release.sh                          # 标签取 package.json 的 version（1.0.0 -> v1.0.0）
./release.sh v1.1.0                   # 指定标签
./release.sh v1.1.0 "标题" notes.md   # 指定标题与正文
```

- **凭证**：环境变量 `GITEE_TOKEN`，或仓库根目录的 `.gitee_token` 文件（在 <https://gitee.com/profile/personal_access_tokens> 创建，勾选 projects 权限）。该文件已在 `.gitignore` 里，严禁入库。
- **前置条件**：工作区干净，且本地 HEAD 与 `origin/master` 一致——发行版必须对应一个已推送的提交。
- **产物**：`release/Pulsar管理工具-安装包-<version>.exe` 作为附件挂到发行版，正文自动带上大小、SHA256、提交号与变更列表；完整构建日志在 `release/release.log`。
- **可重复执行**：标签已存在且指向当前提交就复用（发行版转为更新，同名附件先删再传）；指向别的提交则直接报错，不会把新包挂到旧标签上。任何一步失败，修好后重跑即可，不会产生重复发行版或重复附件。
- 中文标题与正文由 `release.sh` 写入 UTF-8 临时文件再交给 `scripts/release-publish.mjs`，**不走命令行参数**——Windows 控制台是 GBK，直接传参会把中文变成乱码。

## 架构约束

这几条是踩过坑之后定下的，改代码前请先读：

1. **broker I/O 只能在主进程。** 生产构建的页面通过 `file://` 加载，CSP 是 `connect-src 'self'`（由 `vite.config.ts` 在构建时注入 meta）。把任何 broker 请求挪到渲染进程，会出现"开发正常、打包后静默失败"。
2. **沙箱 preload 不能 require 相对模块。** `sandbox: true` 下 preload 只能 require 白名单模块（`electron` 等）。一旦编译产物里出现 `require("./shared/types")`，Electron 会**静默跳过整个 preload**，`window.electronAPI` 直接消失且不打任何日志。因此通道名在 preload 里写字面量，并用 `typeof import('./shared/types')` 的字面量类型钉住，改名即编译失败。
3. **推送载荷只能是纯 JSON。** 主→渲染走 `msg:consume-batch` / `msg:read-batch` / `msg:session-end`，类实例传不过沙箱边界。
4. **`Reader.readNext(timeout)` 在超时真的到期时会段错误**（pulsar-client 1.18.0 实测，进程 exit=139）。所以 Reader 循环用 `hasNext()` 门控 + 250ms 空轮询 + 不带超时的 `readNext()`；停止会话时等的是"在途读取落地 + 资源关闭"的整体，不是直接 close。
5. **不要用 Admin REST 发消息或 peek 消息。** `POST /admin/v2/producers/{t}/{ns}/{topic}/send` 与 `.../subscription/{sub}/peek/{n}` 在真实 broker 上并不存在（返回 HTML 404）。消息收发只有原生客户端这一条路。
6. **分区 topic 的删除走 `.../{topic}/partitions`**，`/partition/-1` 在部分版本上 404。
7. **聚合有上限。** `AGGREGATION_LIMITS` 限制租户/命名空间/topic 数量，聚合内部扇出用 `mapWithConcurrency` 固定并发窗口（外层已持有信号量许可，内部再 acquire 会死锁）。
8. **渲染层依赖必须留在 `devDependencies`。** antd / echarts / react 等由 Vite 打进 `dist/renderer`，主进程编译产物只 `require` axios、better-sqlite3、pulsar-client、uuid、zod。把渲染层依赖挪回 `dependencies`，electron-builder 会把它们的源码再塞进 asar（实测 157 MiB），安装包随即越过 Gitee 附件 100 MB 上限而被拒。

## 本地数据

- SQLite 位于 `app.getPath('userData')/pulsar-manager.db`，存集群配置、SSH 配置、操作日志、界面设置与快捷键绑定
- 调试时可以另起一个实例：`npx electron . --user-data-dir=<临时目录>`（单实例锁按 userData 路径判定）

## 已知限制

以下是**当前确实没做**的部分，界面不会假装它们可用：

- **SSH 隧道端口转发未实现**：`ssh:connect` 只保存配置并明确返回失败，不会编造一个本地端口；集群若开启隧道，连接时主进程直接拒绝并提示直连
- **在线更新依赖 Gitee 私有仓库 API**：设置→检查更新 会拉取最新发行版并对比版本号，下载其 exe 附件后静默安装重启；私有仓库必须先在更新弹窗里配置只读 access_token（本机加密存储）。仓库地址写死为 `lingfeng983/pulsar-manager`，换仓库需改 `src/main/services/update-service.ts`
- **快速压测入口是占位**：顶部导航点击后只提示"功能即将推出"
- **消费没有逐条手动 ack**：只有"自动 ack"开关，关掉之后消息就一直不确认
- 未实现：Schema 管理、权限管理、压测引擎、告警、时序降采样、国际化、K8s 端口转发
- broker→topic 归属在多 broker 集群下没有廉价来源（`/admin/v2/broker-stats/{broker}/topics` 在部分部署上不可用），只能逐 topic 走 `/lookup`；单 broker（standalone）场景下归属是确定的

## 许可证

Apache License 2.0，见 [LICENSE](./LICENSE)。

Copyright 2026 Pulsar Manager Team
