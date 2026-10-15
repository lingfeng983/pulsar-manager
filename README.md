# Pulsar Manager Desktop

Apache Pulsar 集群的桌面运维客户端，基于 Electron + React + TypeScript。所有与 broker 的通信都在主进程完成，渲染进程只通过 preload 暴露的白名单接口拿数据。

## 功能

### 集群管理

- 集群增删改查、连接测试（走 Admin API 健康检查，并尝试读取集群版本）
- 首屏进入即对所有集群探活一次（不阻塞页面渲染），列表与资源树的状态点因此反映的是本次启动的实测结果，而不是上次退出时留在库里的那份；顶部导航「刷新集群状态」走同一轮探活
- 凭据以 AES-256 加密后落库，加密密钥由 Electron `safeStorage`（OS 密钥库）保护；平台不支持时默认**拒绝降级**为明文，需显式设置 `ALLOW_PLAINTEXT_KEY=1` 才会写明文密钥文件
- 单实例锁：重复启动会把焦点交回已有窗口，而不是再起一个进程

### 资源浏览与管理

- 资源树按 租户 → 命名空间 → Topic 三层懒加载，带模块级缓存与竞态保护（订阅在 Topic 详情页里管理）
- 树顶部的「筛选 topic」按空白分词，每个词都要命中；词内先试连续子串、再退到跳字子序列（`tns` 能命中 `tenant-ns`），命中的节点保留其所在分支，筛空时明确提示而不是显一棵空树
- **筛选语义全应用只有一套**：首页集群列表、命名空间的 topic 列表、资源树、集群拓扑、插件市场、顶栏全局搜索与各处下拉都走 `utils/textFilter.ts` 同一个匹配器（规则同上），**不支持正则表达式也不支持通配符**，`^t1$` 就是字面量；拓扑与插件市场的搜索框改成边打字边筛，不再要按回车
- **Topic**：详情（stats / 生产者 / 消费者 / 订阅）、创建（分区与非分区、持久与非持久）、删除、配置读取与修改
    - 配置是**逐策略端点**并发读取的（retention、backlog-quota、ttl、max-producers、max-consumers、message-ttl、deduplication、permissions），单个端点缺失只降级该项，不会让整个表单空白
    - 写入是 read-modify-write 后**只 PUT 变更过的键**
    - 「配置」页签直接编辑，不套弹窗：保留时间、保留大小、分区数三项摆在页内，留空即不修改；生效积压配额、去重状态、归属 Broker 是本 broker 没有 topic 级写入口的只读值，放在同一张卡的只读块里，不给能改了却不生效的输入框
- **租户 / 命名空间**：创建、更新、删除
- **订阅**：创建、删除、重置游标、跳过消息；订阅列表除积压外还显示**速率**（`msgRateOut`）与**吞吐量**（`msgThroughputOut`），列名与数值都可悬浮看原始读数
- 上述资源类变更都会写入操作日志，可从顶部导航导出最近 100 条为 JSON

### 消息收发

Topic 详情页的「消息浏览器」有三种模式，互不混淆（不是一个列表里塞所有东西）：

- **发送测试**：向当前 topic 发一条消息并返回真实 messageId。正文按 JSON / XML / 文本 三种语法着色与缩进（可编辑的 CodeMirror 框，带格式化按钮，非法 JSON/XML 会明确拒绝而不是原样"格式化成功"）；正文框与自定义属性框都可以按住底边上下拖动改高度（80–1200px，拖完写进 localStorage，下次进来还是这个高度），看长报文时不用整页滚；单条消息能自带的那几项参数按字段列出——路由键、事件时间（不带/当前/指定时刻）、延时投递（不带/若干秒后/定时）、自定义属性（JSON 或 XML 两种写法，各有「模板」按钮一键插入默认样例，属性框里空着或还是模板原样时切写法会自动换成对应模板，手改过的内容不动），每项都有悬浮说明，不需要手拼一段 JSON。批大小、压缩、发送超时是 producer 级的，这里不出现，去生产者工作台建常驻会话时配
- **订阅消费**：以指定订阅消费，支持从 earliest / latest / 指定时间戳开始；自动 ack 可关闭（关闭后消息不被确认，用于观察 backlog 累积），但界面没有逐条手动 ack 的入口
- **Reader 按位置读**：不占用订阅、不影响 backlog 的只读浏览。起始位置除最早 / 最新 / 指定时间外还有**最近 N 条**：原生 Reader 没有尾部锚点，这条是从最早往后扫、只保留最后 N 条，扫完自动结束，护栏是最多扫 2 万条 / 15 秒 / 8 MB（撞护栏时结束提示会写明"扫过多少、取了几条"，不假装拿到的是真正的尾部）

消息列表（Reader 与订阅消费共用）默认按 Publish Time 倒序、点表头切换升降序，所有列可拖宽（宽度只存在组件状态里，刷新回默认），载荷自动判定类型：JSON 看能否 `JSON.parse`，XML 交给 `DOMParser` 实测能否成树，其余按纯文本——判不出结构就不装作判得出。详情弹窗里同一份正文按判定出的语法着色缩进。

消息由主进程按批推送（攒够 50 条或 300ms 一批），载荷为 base64；界面会尝试解回文本，判定为二进制时才保留 base64。支持导出 JSON / CSV。

### 生产者与消费者工作台

消息浏览器解决"发一条看看"，工作台解决"挂着跑一段"：

- **生产者工作台**：一个 topic 可挂多条常驻会话。报文是**模板**——正文必须是合法 JSON，`${...}` 是占位符，支持 `int/float/bool/string/uuid/choice/seq/index/now/date/timestamp` 这些生成函数与具名变量，整体占位符保留原类型（数字不会被写成字符串），`$each{count,of}` 按列表展开。单发（1–1000 条）走常驻会话，连续发送是可运行时改速率的限速流（`ratePerSecond` 0 为不限、总量 0 为到手动停止、在途上限、出错即停可选），统计给已发/失败/字节、msg/s、MB/s 与 P50/P99 确认延迟；`flush` 只把原生队列最后一段推出，`stop` 才断会话。另有"直接发送"一条现开现关、不留连接的通道。一次上千条大报文时解析与发送是分批交替的（每批不超 200 条、正文合计不超 16MB），主进程不会先把 `条数 × 正文` 整份堆在内存里，界面上拿到的失败清单仍然是完整的。「发送历史」读的是本地 `send_history`，按 集群 + topic 显最近 200 条（模板名、条数、平均单条字节、messageId、失败原因，展开看正文前缀）
- **消费者工作台**：同样多会话并存（Exclusive 除外，重复开时先弹确认）。订阅设置可配类型（Shared/Key_Shared/Failover/Exclusive）、起始（Latest/Earliest）、自动确认开关、限量、`receiverQueueSize`、`ackTimeoutMs`/`nAckRedeliverTimeoutMs`（关掉自动确认才出现）、消费者名与死信策略（死信 topic、最大重投次数、初始订阅）。消息按会话分桶显示、每秒自算速率，可暂停渲染、限制保留条数（1–5000）、导出 JSON/CSV、清空
- 模板、消费者会话配置各一张本地表，支持增删改查与复制，用过几次、最后一次什么时候用过都记着；发送历史那张只写与读，不做编辑

### 快速压测

- 顶部导航「快速压测」向指定 Topic 并发写入，实时统计吞吐、带宽、已消费条数与发送确认延迟（平均 / P50 / P95 / P99 / 最大，蓄水池抽样 2 万条）
- 参数可调：生产者数量、总条数、消息大小、全局限速（逐条时间片，实测精度 ±1%）、单生产者并发（在途窗口 = maxPendingMessages + blockIfQueueFull）、压缩（LZ4/Zlib/Zstd）、批量化、是否同时消费积压
- 压测跑在主进程，关闭弹窗不中断，重新打开仍是同一轮的实时进度；停止按钮先排空在途再叫停，终态与耗时保留在弹窗里
- 「同时消费」可勾选结束后清理订阅，走原生 `consumer.unsubscribe()`，且在关闭消费者之前执行

### 监控与拓扑

- 首页总览与监控面板：集群聚合统计与 broker 列表（数据来自 Admin API 的真实 stats 聚合，不是造出来的示例值）；首页与侧边栏的集群状态挂载即探一次、之后按配置中心间隔轮询，版本列由探活顺带补齐
- 集群拓扑：一个页签两种形态——全局视图多集群同屏（按集群抽样、离线/取不到明细的集群留降级气泡、点集群气泡下钻），单集群视图整簇全展开（订阅与可选分区）；力导向 / 环形两种布局切换，按节点类型与名称筛选，节点点击可直接打开对应详情页；只在页签激活时加载与轮询
    - broker→topic 的归属关系只在**能拿到真实来源**时才画连线；拿不到时载荷里 `ownershipSource` 明确标注为不可用，界面也会提示，不编造全连接图
    - 配色运行时从 CSS 变量读取，跟随亮色/暗色/护眼三套主题

### 界面

- 多 Tab 工作区，同一资源不会重复开 Tab；例外是生产者/消费者工作台：同一条 topic 可以多开，每个页签带独立序号
- 快捷键自定义：`ShortcutConfig` 页面按分组列出所有可绑定命令，绑定持久化到本地设置；只有当前页面真的注册了处理器的命令才会响应按键，不会出现"按了没反应"的假绑定；进入捕获态后切走页签会自动退出捕获，不会在看不见的页面里截走按键
- 三套主题：亮色（默认）、暗色、护眼，全部走 CSS 变量，禁止硬编码颜色。CodeMirror 的编辑器主题同样只引用变量，所以切主题与切字号时代码框跟着走，不会留下一个白底的编辑器
- 字号四档：小 / 中 / 大（默认）/ 特大。DOM 文字走 `--font-size-*` 梯度，antd 组件的字号族与控件尺寸按同一档位重算（compact 算法会把 ConfigProvider 的 fontSize 种子覆盖掉，所以是自定义算法在它之后再补一层），ECharts 的画布文字同比缩放
- 表格列宽可拖拽（消息列表），拖拽宽度不入库，刷新即回默认
- 顶部导航左上角是「监控」「拓扑」与侧边栏折叠开关（原来的 `⚡Pulsar Manager` 大标题已去掉，应用名只在「关于」弹窗里出现），侧边栏顶部因此只留 topic 筛选框；折叠状态存 localStorage，不进配置中心的可重置项

### 配置中心与在线更新

- 顶部导航「设置 → 配置中心」在独立页签里管理应用自身设置：主题、字号、消息正文截断长度、监控自动刷新与刷新间隔、集群状态刷新间隔。改动写入本地 SQLite 后对应页面当场生效，不需要重启；数值型输入在失焦或回车时才提交，不会敲一个数字就打一次 IPC
- 配置迁移：一键导出集群配置与应用设置为 JSON；导出**不含任何凭据**（Token / TLS 证书、SSH 密码与私钥都以加密形式存在本机），导入方需要重新填一次凭据。导入只做新增，同名集群跳过并列出名字，整包在一个事务里完成
- 「恢复默认」只重置界面与刷新设置，不动集群配置；「清空操作日志」带二次确认
- 本地数据库带 `user_version` 增量迁移，旧库升级按版本逐步改造，不要求删库重建
- 「设置 → 检查更新」比对公开分发仓库的最新发行版版本号，下载 exe 附件后静默安装并重启（无需令牌）

### 插件市场

- 「设置 → 插件市场」列出可安装的官方插件与本机导入的插件，按类型（压测预设 / Topic 模板）与安装状态筛选，卡片展开即可看到插件贡献的具体内容
- 插件是**纯声明式 JSON**：只贡献数据，应用不加载也不执行插件携带的任何代码。一个坏插件最多让某条预设消失
- 官方插件点安装即写入 `userData/plugins/<id>.json`，与第三方导入走同一条加载与校验路径；启用开关即时决定其贡献是否进入界面，卸载即删除本机文件
- 校验失败的文件不会被静默丢掉：页面顶部逐条列出文件名与失败原因（例如 `producers: Number must be less than or equal to 64` 的中文对应描述）
- 已启用插件的贡献直接落到两处真实入口：快速压测弹窗顶部的「预设」下拉（选中后覆盖压测参数并显示套用了哪些数字），新建 Topic 弹窗的「模板」下拉（覆盖持久化与分区数，Topic 名为空时套用模板前缀）

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
│   │   ├── services/          # Admin REST 客户端、指标聚合、原生客户端、SSH 隧道、加密、更新
│   │   └── utils/             # 日志
│   ├── preload.ts             # 沙箱 preload：唯一暴露给渲染进程的接口面
│   ├── shared/types.ts        # 跨进程共享的领域类型（单一事实来源）
│   └── renderer/              # React 渲染进程
│       ├── components/        # 布局、资源树、拓扑、编辑器（CodeMirror 封装）、生产/消费表单、各类弹窗
│       ├── hooks/             # 资源缓存、ECharts、快捷键、全屏、尺寸监听、列宽拖拽
│       ├── pages/             # 首页、集群配置、Topic/租户/命名空间详情、消息浏览器、生产者工作台、
│       │                      # 消费者工作台、监控、配置中心、插件市场、快捷键
│       ├── store/             # Zustand：集群、Tab、主题、命令、快捷键、应用设置、插件
│       └── utils/             # 格式化、导出、拓扑配色、按键解析、统一筛选匹配
├── docs/DATA_SOURCES.md       # 每个页面的数据来源说明
├── release.sh                 # 一键出包 + 发布 Gitee 发行版
├── scripts/release-publish.mjs# 调 Gitee API 建/更新发行版并上传附件
├── scripts/tunnel-selftest/   # SSH 隧道端到端自检（本机起真 SSH 服务器 + 假 Pulsar 源站）
├── scripts/dev-ssh-bridge.js  # 开发期本机 SSH 服务器，供隧道功能实机验证
├── electron-builder.json      # 打包配置
├── vite.config.ts             # 前端构建 + 生产 CSP 注入
└── tsconfig.node.json         # 主进程/preload 的 TS 配置（CommonJS）
```

`docs/` 下另有一份[《详细设计说明书》](./docs/Pulsar%20桌面管理工具详细设计说明书.md)和一份[《UI 详细设计规范》](./docs/Pulsar%20桌面管理工具%20UI%20详细设计规范（最终完整版）.md)，是项目最初的设计输入，部分细节已被后续实现取代。

## 快速开始

### 环境要求

- Node.js 20 或更高（开发在 v24 上验证）
- npm 源已在 `.npmrc` 中指向 npmmirror，Electron 二进制也走国内镜像
- `pulsar-client` 是原生模块（node-addon-api），安装时先下载预编译产物（Windows 为 `napi-win32-unknown-x64`），需要能访问镜像或 Apache 归档。预编译包拿不到时 npm 会退回 `node-gyp` 源码编译，这一步**必须有** MSVC 与 Python 工具链；`ssh2` 的可选加速模块 `cpu-features` 编不过也会让 `npm install` 整体失败（它对本应用无用），此时用 `npm install --ignore-scripts` 装依赖，再单独跑 `npm rebuild better-sqlite3 --update-binary` 与 `npx electron-builder install-app-deps`

### 安装与开发

```bash
npm install          # postinstall 会执行 electron-builder install-app-deps，把 better-sqlite3 重建到 Electron ABI
npm run dev          # 并行启动 Vite(5173) 与 Electron
```

也可以分开跑：`npm run dev:renderer`（只起前端）、`npm run dev:main`（编译主进程后启动 Electron）。未打包运行时窗口一律加载 `http://localhost:5173`，所以 `dev:main` 必须和 Vite 一起用；先起 main、Vite 还在编译的话首帧会连不上，主进程会重试到服务就绪。

### 构建与打包

```bash
npm run build:main   # tsc -p tsconfig.node.json → dist/src/main、dist/src/preload.js
npm run build        # 清 dist → tsc -b → build:main → vite build
npm run electron:pack  # 先完整构建，再出免安装目录 release/win-unpacked
npm run electron:dist  # 先完整构建，再出 NSIS 安装包 release/Pulsar管理工具-安装包-<version>.exe
```

数据库结构以 `src/main/database/schema.ts` 里的常量存在，而不是外部 `.sql` 文件：tsc 不拷贝非 TS 资源，走文件读取的话安装包里的其实是某次手工复制进 `dist` 的旧基线，干净环境构建甚至直接找不到文件而启动失败。

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

- **凭证**：依次取环境变量 `GITEE_TOKEN`、仓库根目录的 `.gitee_token` 文件（已在 `.gitignore` 里，严禁入库）、Windows 凭据管理器中 `gitee.com` 那条记录——第三份与 `git push` 用的是同一枚私人令牌，Gitee 的 API 同样认它，所以本机日常发版不需要额外准备凭证。令牌绝不写进代码或加密打包进仓库：`release.sh` 与 `scripts/` 会随 dist 进 asar，内嵌（哪怕加密）等于把凭据交给每个装了安装包的人；在 <https://gitee.com/profile/personal_access_tokens> 创建时勾选 projects 权限。脚本在出包之前就用 `GET /api/v5/user` 验一次令牌，避免构建两三分钟后才在第 4 步吃 401。
- **前置条件**：工作区干净，且本地 HEAD 与 `origin/master` 一致——发行版必须对应一个已推送的提交。
- **产物与发布位置**：`release/Pulsar管理工具-安装包-<version>.exe` 只上传到公开的分发仓 `pulsar-manager-dist`（不存在时脚本自动创建，首次会推一个只含 README 的提交当发行版锚点，因为 Gitee 的发行版必须挂在真实提交上）。**分发仓是唯一的发版处**：源码仓只留提交与标签，脚本会把它上面残留的历史发行版连附件一起删掉——旧渠道每个版本都挂一份 80MB 的包，八份就是几百 MB 白占私有仓容量，而且同一版本两份包迟早会对不上号。完整构建日志在 `release/release.log`。
- **分发仓只保留最近 3 个版本的安装包**（`GITEE_DIST_KEEP` 可调）：一个包 81MB，堆十几份就撞 Gitee 的仓库容量上限。删的是发行版及其附件，标签留着不影响脚本重复执行。
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
8. **渲染层依赖必须留在 `devDependencies`。** antd / echarts / react 等由 Vite 打进 `dist/renderer`，主进程编译产物只 `require` axios、better-sqlite3、pulsar-client、ssh2、uuid、zod。把渲染层依赖挪回 `dependencies`，electron-builder 会把它们的源码再塞进 asar（实测 157 MiB），安装包随即越过 Gitee 附件 100 MB 上限而被拒。
9. **`batchingEnabled` 与 `chunkingEnabled` 不能同时为 true。** 原生绑定（pulsar-client 1.18 的 C++ 层）在这两项都开时直接 abort 整个主进程，实测没有 JS 异常也没有 crashpad 转储。三处同时挡：Zod 校验 `refine` 拒绝、构造 producer 时 `chunkingEnabled && !batchingEnabled`、界面上开了批发送就把分块开关置灰。
10. **代码框的颜色与字号只能写 CSS 变量。** CodeMirror 主题经 style-mod 原样塞进生成的样式表，变量在浏览器里按当前 `<html>` 解析，所以三套主题与四档字号都自动跟随；写成 `#fff` 或固定 px，实测就是"整页变暗了只有编辑器还白底"。

## 本地数据

- SQLite 位于 `app.getPath('userData')/pulsar-manager.db`，存集群配置、SSH 配置、操作日志、界面设置与快捷键绑定、报文模板、消费者会话配置、发送历史；表结构以 `PRAGMA user_version` 跟踪并增量迁移
- 已安装的插件是 `app.getPath('userData')/plugins/*.json`（或 `plugins/<目录>/plugin.json`），启用状态记在 `user_settings` 的 `disabledPlugins` 里
- 调试时可以另起一个实例：`npx electron . --user-data-dir=<临时目录>`（单实例锁按 userData 路径判定）

## 已知限制

以下是**当前确实没做**的部分，界面不会假装它们可用：

- **SSH 隧道的边界**：启用后应用在本机起两条随机端口转发（Admin 与 Broker 各一条），集群地址自动改写到隧道上，TLS 仍按用户填写的原始主机名校验证书。两点限制：原生客户端（消息收发）无法指定 SNI，所以「TLS + SSH 隧道」会被明确拒绝，请改用 `pulsar://` 明文经隧道；topic lookup 之后 broker 回源的地址若本机不可达，原生收发仍需直连或代理
- **在线更新走公开分发仓库**：设置→检查更新 读取 `lingfeng983/pulsar-manager-dist`（公开，只放发行版与安装包）的最新发行版，比对版本号后下载 exe 附件并校验 SHA256，再静默安装重启。公开仓库匿名就能读，应用内没有任何令牌入口，用户不用配任何东西；源码仓库保持私有也不发版。仓库地址写死在两处：应用侧 `src/main/services/update-service.ts`，发版侧 `release.sh` 的 `DIST_REPO`（可用 `GITEE_DIST_REPO` 覆盖）——换仓库两处必须一起改，否则发出去的包读不到新版本。
- **快速压测的延迟口径**：统计的是 `send()` 调用到 broker 确认的时间，包含客户端在途队列的排队；单生产者并发调大时 P50 会显著上升，这不是 broker 变慢
- **消费没有逐条手动 ack**：只有"自动 ack"开关，关掉之后消息就一直不确认
- **消息浏览器没有 peek / 重投 / 按 ID 定位**：只能从头或从某个时间点开始读，不能"看一眼订阅游标下一条再决定消不消费"，也不能把一条已收到的消息原样再发一次
- **发送历史只存前缀**：每次发送（单发、直接发送、连续发送的每一轮）都往 `send_history` 落一行，生产者工作台的「发送历史」按 集群 + topic 读最近 200 条；正文只留前 400 字符与平均单条字节数，整篇载荷当时就在原生层释放，所以历史不能拿来重发
- **模板的 schema 校验未实现**：`message_templates.schema_mode` 只是存下来的字段，发送时不做任何结构校验
- **插件只贡献数据**：插件市场里的插件是本地 JSON 声明，只能提供压测预设与 Topic 创建模板，不能新增界面、不能访问 broker、不能执行代码；需要这类能力请直接把需求提为应用功能
- 未实现：Schema 管理、权限管理、告警、时序降采样、国际化、K8s 端口转发
- broker→topic 归属在多 broker 集群下没有廉价来源（`/admin/v2/broker-stats/{broker}/topics` 在部分部署上不可用），只能逐 topic 走 `/lookup`；单 broker（standalone）场景下归属是确定的

## 许可证

Apache License 2.0，见 [LICENSE](./LICENSE)。

Copyright 2026 Pulsar Manager Team
