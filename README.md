# Pulsar Manager Desktop

Apache Pulsar 集群的桌面运维客户端，后台是 Rust（Tauri 2 外壳），界面是 React + TypeScript。官方 Apache Pulsar Manager（Web 管理 UI）已停止维护，本项目以桌面客户端承接 Pulsar 运维的完整链路：集群管理、消息收发、快速压测、监控巡检、告警通知、内置文档与插件市场——一个本地、安全、免费的工具装下 Pulsar 运维的七件事。

所有与 broker 的通信都在 Rust 后台完成，页面只有一个入口 `rpc(method, args)`，契约写在 `src/renderer/api-contract.ts`；凭据以 AES-256 加密后落库，加密密钥由系统密钥库保护（Windows DPAPI；平台不支持时默认拒绝降级为明文），数据存于本地 SQLite，不依赖任何外部服务。进程里没有 Node 运行时，也不打包 Chromium，页面跑在系统自带的 WebView2 上，安装包约 7 MB。

![License](https://img.shields.io/badge/License-Apache%202.0-blue)
![Version](https://img.shields.io/badge/Version-v1.6.2-orange)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Tauri](https://img.shields.io/badge/Tauri-2-FFC131)
![Rust](https://img.shields.io/badge/Rust-1.98-DEA584)
![React](https://img.shields.io/badge/React-18-61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6)
![PRs](https://img.shields.io/badge/PRs-welcome-brightgreen)

- **下载安装**：前往 [GitHub Releases](https://github.com/lingfeng983/pulsar-manager/releases) 下载最新安装包（Windows 一键安装，应用内支持在线更新）
- **一键体验**：不想先装集群？用 docker 起一个 standalone Pulsar，5 分钟跑通全部功能，见 [一键体验指南](./docs/guides/一键体验指南.md)
- **反馈与贡献**：Bug / 需求请走 [Issue 模板](./.github/ISSUE_TEMPLATE/)，参与开发见 [CONTRIBUTING.md](./CONTRIBUTING.md)

## 功能矩阵

| 能力域         | 一句话                                                     | 详见                                                                                                 |
| -------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 集群与资源管理 | 集群增删改查、探活、租户/命名空间/Topic 三层资源树         | [集群管理](#集群管理)、[资源浏览与管理](#资源浏览与管理)                                             |
| 消息收发       | 发送测试、订阅消费、Reader 按位置读、生产者/消费者工作台   | [消息收发](#消息收发)、[生产者与消费者工作台](#生产者与消费者工作台)                                 |
| 快速压测       | 并发写入、实时吞吐与延迟统计（P50/P95/P99）                | [快速压测](#快速压测)                                                                                |
| 监控与拓扑     | 集群聚合统计、broker 列表、多集群/单集群拓扑、时序快照留存 | [监控与拓扑](#监控与拓扑)                                                                            |
| 巡检与告警     | 集群巡检、定时巡检、跨集群汇总、告警规则、通知渠道         | [集群巡检与告警](#集群巡检与告警)                                                                    |
| 策略管理       | 命名空间/Topic 级策略读写、批量同步、跨集群对比            | [策略管理](#策略管理)                                                                                |
| 函数与连接器   | Functions / Connectors 管理、本机包上传                    | [函数与连接器](#函数与连接器)                                                                        |
| 接入与扩展     | SSH 隧道、K8s 端口转发、Schema、ACL、插件市场、文档中心    | [接入通道](#接入通道)、[Schema 与权限](#schema-与权限)、[文档中心](#文档中心)、[插件市场](#插件市场) |

## 架构（Rust 后台 + 复用 React 界面）

```
React 18 页面（src/renderer）
   │  window.electronAPI.xxx()        ← 名字是 Electron 时代留下的，改动它要动 40 多个页面
   │  单一入口 rpc(method, args) + 事件推送
Rust 后台（rust/crates）
   pm-tauri    外壳：rpc 按业务域链式分发、托盘、单实例、外链、日志
   pm-services 业务：集群装配、凭据加密、策略、巡检、告警、通知、消息会话、压测、更新、隧道
   pm-pulsar   Admin REST 客户端 + pulsar crate 原生收发
   pm-store    SQLite（18 张表，user_version = 17，幂等基线 DDL + 补列）
   pm-core     领域模型、错误、路径推导、日志 sink
```

前后端契约的唯一真源是 `src/renderer/api-contract.ts`：150 个方法的名称、参数顺序、返回类型，
以及 `window.electronAPI` 的 `declare global` 都在这一个文件里，加方法不需要重跑任何代码生成。

历史上这里还有一套 Electron 实现（`src/main/**` + 沙箱 preload + electron-builder）。它已被整体删除，
页面与 Rust 后台是唯一的实现；`docs/rust/README.md` 里保留了迁移期攒下的性能与外壳行为对照，
两版共用同一份 `pulsar-manager.db`（`user_version = 17`）与同一套 DPAPI 保护的凭据密钥，
所以老用户装的 Electron 版数据可以直接被现在的版本打开。

```bash
# 1) 先出前端产物（外壳读 dist/renderer）
npm run build:renderer
# 2) 编译并打包（产物：rust/target/release/Pulsar Manager.exe
#    与 rust/target/release/bundle/nsis/Pulsar Manager_<版本>_x64-setup.exe）
npm run app:build
```

模块划分、外壳行为与调试用环境变量见 [docs/rust/README.md](./docs/rust/README.md)。

## 界面预览

> 截图素材待采集，采集清单见 [docs/screenshots/README.md](./docs/screenshots/README.md)。

- 首页集群总览与监控
- 消息浏览器（发送测试 / 订阅消费 / Reader）
- 生产者 / 消费者工作台
- 快速压测
- 集群拓扑
- 巡检报告与告警中心
- 插件市场

## 功能

### 集群管理

- 集群增删改查、连接测试（走 Admin API 健康检查，并尝试读取集群版本）
- 首屏进入即对所有集群探活一次（不阻塞页面渲染），列表与资源树的状态点因此反映的是本次启动的实测结果，而不是上次退出时留在库里的那份；顶部导航「刷新集群状态」走同一轮探活
- 凭据以 AES-256-GCM 加密后落库，加密密钥由系统密钥库保护（Windows 走 DPAPI，见 `pm-services/src/crypto.rs`）；密钥不可用时默认**拒绝降级**为明文，需显式设置 `ALLOW_PLAINTEXT_KEY=1` 才写明文密钥文件。DPAPI 解不开时不阻断启动：旧密钥改名 `.encryption-key.v2.broken-<时间戳>` 并重新生成，界面顶部挂横幅提示重填认证参数
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
- **订阅消费**：以指定订阅消费，支持从 earliest / latest / 指定时间戳开始；自动 ack 可关闭（关闭后消息不被确认，用于观察 backlog 累积）；逐条手动确认与重投在消费者工作台里（关闭自动确认后）进行
- **Reader 按位置读**：不占用订阅、不影响 backlog 的只读浏览。起始位置除最早 / 最新 / 指定时间外还有**最近 N 条**：原生 Reader 没有尾部锚点，这条是从最早往后扫、只保留最后 N 条，扫完自动结束，护栏是最多扫 2 万条 / 15 秒 / 8 MB（撞护栏时结束提示会写明"扫过多少、取了几条"，不假装拿到的是真正的尾部）

消息列表（Reader 与订阅消费共用）默认按 Publish Time 倒序、点表头切换升降序，所有列可拖宽（宽度只存在组件状态里，刷新回默认），载荷自动判定类型：JSON 看能否 `JSON.parse`，XML 交给 `DOMParser` 实测能否成树，其余按纯文本——判不出结构就不装作判得出。详情弹窗里同一份正文按判定出的语法着色缩进。

消息由后台按批推送（攒够 50 条 / 300ms / 8MB 一批），载荷为 base64；界面会尝试解回文本，判定为二进制时才保留 base64。支持导出 JSON / CSV。

### 生产者与消费者工作台

消息浏览器解决"发一条看看"，工作台解决"挂着跑一段"：

- **生产者工作台**：一个 topic 可挂多条常驻会话。报文是**模板**——正文必须是合法 JSON，`${...}` 是占位符，支持 `int/float/bool/string/uuid/choice/seq/index/now/date/timestamp` 这些生成函数与具名变量，整体占位符保留原类型（数字不会被写成字符串），`$each{count,of}` 按列表展开。单发（1–1000 条）走常驻会话，连续发送是可运行时改速率的限速流（`ratePerSecond` 0 为不限、总量 0 为到手动停止、在途上限、出错即停可选），统计给已发/失败/字节、msg/s、MB/s 与 P50/P99 确认延迟；`flush` 只把原生队列最后一段推出，`stop` 才断会话。另有"直接发送"一条现开现关、不留连接的通道。一次上千条大报文时解析与发送是分批交替的（每批不超 200 条、正文合计不超 16MB），后台不会先把 `条数 × 正文` 整份堆在内存里，界面上拿到的失败清单仍然是完整的。「发送历史」读的是本地 `send_history`，按 集群 + topic 显最近 200 条（模板名、条数、平均单条字节、messageId、失败原因，展开看正文前缀）
- **消费者工作台**：同样多会话并存（Exclusive 除外，重复开时先弹确认）。订阅设置可配类型（Shared/Key_Shared/Failover/Exclusive）、起始（Latest/Earliest）、自动确认开关、限量、`receiverQueueSize`、`ackTimeoutMs`/`nAckRedeliverTimeoutMs`（关掉自动确认才出现）、消费者名与死信策略（死信 topic、最大重投次数、初始订阅）。消息按会话分桶显示、每秒自算速率，可暂停渲染、限制保留条数（1–5000）、导出 JSON/CSV、清空
- 模板、消费者会话配置各一张本地表，支持增删改查与复制，用过几次、最后一次什么时候用过都记着；发送历史那张只写与读，不做编辑

### 快速压测

- 顶部导航「快速压测」向指定 Topic 并发写入，实时统计吞吐、带宽、已消费条数与发送确认延迟（平均 / P50 / P95 / P99 / 最大，蓄水池抽样 2 万条）
- 参数可调：生产者数量、总条数、消息大小、全局限速（逐条时间片，实测精度 ±1%）、单生产者并发（在途窗口 = maxPendingMessages + blockIfQueueFull）、压缩（LZ4/Zlib/Zstd）、批量化、是否同时消费积压
- 压测跑在后台，关闭弹窗不中断，重新打开仍是同一轮的实时进度；停止按钮先排空在途再叫停，终态与耗时保留在弹窗里
- 「同时消费」可勾选结束后清理订阅，走原生 `consumer.unsubscribe()`，且在关闭消费者之前执行

### 监控与拓扑

- 首页总览与监控面板：集群聚合统计与 broker 列表（数据来自 Admin API 的真实 stats 聚合，不是造出来的示例值）；首页与侧边栏的集群状态挂载即探一次、之后按配置中心间隔轮询，版本列由探活顺带补齐；监控曲线**时序快照本地留存**（原样留存，不做降采样），可回看历史
- 集群拓扑：一个页签两种形态——全局视图多集群同屏（按集群抽样、离线/取不到明细的集群留降级气泡、点集群气泡下钻），单集群视图整簇全展开（订阅与可选分区）；力导向 / 环形两种布局切换，按节点类型与名称筛选，节点点击可直接打开对应详情页；只在页签激活时加载与轮询
    - broker→topic 的归属关系只在**能拿到真实来源**时才画连线；拿不到时载荷里 `ownershipSource` 明确标注为不可用，界面也会提示，不编造全连接图
    - 配色运行时从 CSS 变量读取，跟随亮色/暗色/护眼三套主题

### 集群巡检与告警

- **集群巡检**：一次只读采集换一份能直接发出去的体检报告——积压、未确认消息、生产/消费速率、阻塞订阅、broker 覆盖等逐项判定为 ok / warn / crit / 未覆盖 四档，每项判定都给出照着能做的结论；命名空间与 topic 按上限采样，报告写明采样范围与截断，不把"没采到的部分"说成全集群结论；可导出 Markdown 贴工单、发群
- **巡检历史与环比**：报告落 SQLite，同一集群可对比上次结论，回答"比上次多了还是少了"，而不是只给一份互不相干的快照
- **巡检口径可配置**：判定线（积压关注/严重线、未 ack 关注线、入出向倍数等）与采样上限按集群各存一份；每份报告记录实际使用的口径，判定线动过时环比会明确说清，不会把"判定线变了"伪装成"集群变了"
- **定时自动巡检**：到点由应用自己跑一次只读巡检，结论与手点走同一条路
- **跨集群巡检汇总**：把 N 份单集群报告拼成一张"先看哪台"的表——按严重级与新鲜度排序，逐台标注最近一次报告时间与过期程度，从没看过的集群不会混进"看过了没问题"那一堆；可导出 Markdown
- **告警规则**：规则、定时评估、事件留存、桌面通知与告警中心；规则存本地 SQLite，导出配置包时随行
- **通知渠道**：钉钉 / 企业微信 / 飞书 / Slack / 邮件，渠道地址与签名密钥按凭据处理（库里只有密文，列表页可截图发群）；每条投递记录自证"发、没发、为什么不发"——200 不等于送达（按各家 errcode/ok 判定），限流与拒发原因落库可查

### 策略管理

- **命名空间策略**：Policies 逐字段读、写、清，覆盖 25 个字段（TTL、积压配额、限速、去重、复制集群等）；未设置 / 0 / -1 三种值不互相塌缩；没有 DELETE 端点的字段不给清除按钮
- **复制集群管理**：读写命名空间复制目标；移除复制目标是不可逆动作，走输入确认，预填只填当前真正在复制的集群
- **批量同步**：源命名空间整值推到同集群多个目标，先预览差异再下发
- **跨集群只读对比**：同名命名空间策略跨集群比对差异
- **Topic 级策略**：TopicPolicies 读取、按字段写入与清除
- **Topic 级对比与批量同步**：只同步"这一项在本 broker 上真的读出来了"的字段，broker 缺端点时整项 skip，绝不把 404 当成"未设置"去批量清空别人配好的覆盖

### 函数与连接器

- **Functions / Connectors**：列表、详情、启停、重载、分配表与内置清单（worker 端点整套走 Admin REST）
- **本机包上传**：支持上传本机 zip 包注册函数/连接器，注册请求字段对齐 worker 真实 schema

### 接入通道

- **SSH 隧道**：启用后应用在本机起两条随机端口转发（Admin 与 Broker 各一条），集群地址自动改写到隧道上，TLS 仍按用户填写的原始主机名校验证书；原生客户端无法指定 SNI，所以「TLS + SSH 隧道」会被明确拒绝，请改用 `pulsar://` 明文经隧道
- **K8s 端口转发**：集群跑在 Kubernetes 里时，直接 spawn 本机 `kubectl` 做 `port-forward`（认证沿用本机 kubeconfig，应用不读其内容），与 SSH 隧道并列第三条连接通道；就绪判定与失败原因分类（RBAC、上下文、x509 等）都给出运维照着能做的提示；SSH 与 K8s 两条通道在配置上互斥

### Schema 与权限

- **Schema 管理**：Topic 的 schema 查看与管理（含 schema 兼容策略等）
- **权限（ACL）写入**：租户/命名空间/Topic 级权限管理，配置可写可查

### 界面

- 多 Tab 工作区，同一资源不会重复开 Tab；例外是生产者/消费者工作台：同一条 topic 可以多开，每个页签带独立序号
- 快捷键自定义：`ShortcutConfig` 页面按分组列出所有可绑定命令，绑定持久化到本地设置；只有当前页面真的注册了处理器的命令才会响应按键，不会出现"按了没反应"的假绑定；进入捕获态后切走页签会自动退出捕获，不会在看不见的页面里截走按键
- 三套主题：亮色（默认）、暗色、护眼，全部走 CSS 变量，禁止硬编码颜色。CodeMirror 的编辑器主题同样只引用变量，所以切主题与切字号时代码框跟着走，不会留下一个白底的编辑器
- 字号四档：小 / 中 / 大（默认）/ 特大。DOM 文字走 `--font-size-*` 梯度，antd 组件的字号族与控件尺寸按同一档位重算（compact 算法会把 ConfigProvider 的 fontSize 种子覆盖掉，所以是自定义算法在它之后再补一层），ECharts 的画布文字同比缩放
- 表格列宽可拖拽（消息列表），拖拽宽度不入库，刷新即回默认
- 顶部导航左上角是「监控」「拓扑」与侧边栏折叠开关（原来的 `⚡Pulsar Manager` 大标题已去掉，应用名只在「关于」弹窗里出现），侧边栏顶部因此只留 topic 筛选框；折叠状态存 localStorage，不进配置中心的可重置项

### 文档中心

- 内置 8 篇 Pulsar 资料（详细功能清单、集群部署、配置清单、调优与架构选型、IoT 高吞吐场景方案、生产环境 Broker/Bookie 参数模板、3.x 高危缺陷整理与防护建议等），随构建打进渲染包，应用内即可查
- 支持目录锚点与跨文档全文检索，命中后自动定位到对应小节

### 配置中心与在线更新

- 顶部导航「设置 → 配置中心」在独立页签里管理应用自身设置：主题、字号、消息正文截断长度、监控自动刷新与刷新间隔、集群状态刷新间隔。改动写入本地 SQLite 后对应页面当场生效，不需要重启；数值型输入在失焦或回车时才提交，不会敲一个数字就打一次 IPC
- 配置迁移：一键导出集群配置与应用设置为 JSON；导出**不含任何凭据**（Token / TLS 证书、SSH 密码与私钥都以加密形式存在本机），导入方需要重新填一次凭据。导入只做新增，同名集群跳过并列出名字，整包在一个事务里完成
- 「恢复默认」只重置界面与刷新设置，不动集群配置；「清空操作日志」带二次确认
- 本地数据库带 `user_version` 增量迁移，旧库升级按版本逐步改造，不要求删库重建
- 「设置 → 检查更新」比对 GitHub 公开仓库 Releases 的最新发行版版本号，下载 exe 附件后静默安装并重启（无需令牌）

### 插件市场

- 「设置 → 插件市场」列出可安装的官方插件与本机导入的插件，按类型（压测预设 / Topic 模板）与安装状态筛选，卡片展开即可看到插件贡献的具体内容
- 插件是**纯声明式 JSON**：只贡献数据，应用不加载也不执行插件携带的任何代码。一个坏插件最多让某条预设消失
- 官方插件点安装即写入 `userData/plugins/<id>.json`，与第三方导入走同一条加载与校验路径；启用开关即时决定其贡献是否进入界面，卸载即删除本机文件
- 校验失败的文件不会被静默丢掉：页面顶部逐条列出文件名与失败原因（例如 `producers: Number must be less than or equal to 64` 的中文对应描述）
- 已启用插件的贡献直接落到两处真实入口：快速压测弹窗顶部的「预设」下拉（选中后覆盖压测参数并显示套用了哪些数字），新建 Topic 弹窗的「模板」下拉（覆盖持久化与分区数，Topic 名为空时套用模板前缀）

## 技术栈

| 层          | 选型                                                                    |
| ----------- | ----------------------------------------------------------------------- |
| 桌面容器    | Tauri 2（Rust 后台 + 系统 WebView2，安装包约 7 MB）                     |
| 后台语言    | Rust 2021（tokio + reqwest + serde），五个 crate 分层                   |
| 前端        | React 18 + TypeScript 5.6 + Vite 5                                      |
| UI / 状态   | Ant Design 5、Zustand 4                                                 |
| 图表        | ECharts 5.4                                                             |
| 本地存储    | rusqlite（bundled SQLite，幂等基线 DDL + `PRAGMA table_info` 增量补列） |
| Pulsar 通信 | reqwest（Admin REST）+ pulsar crate（原生消息收发，二进制协议直连）     |
| 接入通道    | 拉起系统 `ssh -L`（SSH 隧道）、复用本机 `kubectl port-forward`          |
| 通知渠道    | lettre（SMTP 邮件）+ 钉钉/企微/飞书/Slack Webhook                       |
| 凭据加密    | AES-256-GCM，密钥由 Windows DPAPI 保护（不可用时默认拒绝降级为明文）    |
| 文档渲染    | marked + dompurify（内置文档中心，渲染层）                              |
| 参数校验    | zod 3（前端表单）+ Rust 侧 serde/校验                                   |
| 打包        | tauri-bundler（Windows NSIS，currentUser 安装）                         |
| 代码质量    | ESLint 9 + Prettier 3（前端）、`cargo test --workspace`（后台）         |

## 目录结构

```
pulsar-manager/
├── rust/
│   ├── crates/
│   │   ├── pm-core/           # 领域模型、错误、路径推导、日志 sink
│   │   ├── pm-store/          # SQLite：基线 DDL、按表的 DAO、user_version 迁移
│   │   ├── pm-pulsar/         # Admin REST 客户端（resource/metrics/policies）+ pulsar 原生收发
│   │   ├── pm-services/       # 业务：集群、加密、策略、巡检（含汇总/定时）、告警、通知、
│   │   │                      # 消息会话、生产者、模板、压测、更新、隧道、插件
│   │   └── pm-tauri/          # 外壳：rpc 分发（按业务域拆 8 个模块）、托盘、单实例、日志、后台调度
│   └── tools/protoc/          # 自带的 protoc（pulsar crate 的 build.rs 需要，离线也能编）
├── src/
│   ├── renderer/              # React 页面（19 个页面、组件、hooks、store、utils）
│   │   ├── api-contract.ts    # 前后端契约唯一真源：150 个方法 + window.electronAPI 类型
│   │   └── tauri-runtime.ts   # 提供 BridgeTransport，把契约工厂的返回值挂到 window
│   └── shared/                # 领域类型、通道常量、巡检口径、模板引擎等纯逻辑（两端共用）
├── docs/pulsar/               # 内置文档中心的 8 篇 Pulsar 资料（随构建打进渲染包）
├── docs/design/               # 项目设计稿与实施方案
├── docs/guides/               # 使用与扩展指南（含一键体验指南、插件编写说明）
├── docs/rust/                 # Rust 版实现说明与迁移方案
├── docs/screenshots/          # 界面截图素材与采集清单
├── docs/reference/            # 数据来源等内部参考说明
├── .github/ISSUE_TEMPLATE/    # Issue 模板（Bug 报告 / 功能建议）
├── CONTRIBUTING.md            # 贡献指南
├── docker-compose.yml         # 一键体验：standalone Pulsar 示例集群
├── scripts/make-icon.mjs      # 图标唯一来源：纯 Node 画图标，产出 rust/crates/pm-tauri/icons/*
├── scripts/*selftest.*        # 模板引擎与内置文档中心两个不依赖后端的自测
├── vite.config.ts             # 前端构建 + 生产 CSP 注入
└── tsconfig.node.json         # src/shared 的 CommonJS 产物（供文档中心自测 require）
```

`docs/design/` 下另有一份[《详细设计说明书》](./docs/design/Pulsar%20桌面管理工具详细设计说明书.md)和一份[《UI 详细设计规范》](./docs/design/Pulsar%20桌面管理工具%20UI%20详细设计规范（最终完整版）.md)，是项目最初的设计输入，部分细节已被后续实现取代。

## 快速开始

### 一键体验（推荐先试）

不想先搭集群？项目根目录提供 standalone Pulsar 的 docker-compose：

```bash
docker compose up -d        # 启动 standalone Pulsar（broker 6650 / admin 8080）
```

起好后在应用里添加集群：Admin 地址 `http://127.0.0.1:8080`，Broker 地址 `pulsar://127.0.0.1:6650`（无需凭据），即可体验消息收发、压测、巡检等全部功能。详细步骤见 [一键体验指南](./docs/guides/一键体验指南.md)。

### 环境要求

- Rust（开发在 1.98 上验证）与本机 C++ 工具链：`rusqlite` 用 bundled SQLite，Windows 上需要 MSVC（`cargo` + Visual Studio Build Tools）
- Node.js 20 或更高（开发在 v24 上验证）——只用于前端构建、图标脚本与两个自测，**运行时不再需要 Node**
- `pulsar` crate 的 `build.rs` 需要 protoc。仓库已自带 Windows 版（`rust/tools/protoc/bin/protoc.exe`），由 `rust/.cargo/config.toml` 的 `[PROTOC]` 注入，离线也能编；其他平台装一个 protoc 或替换该目录
- Windows 需要 WebView2 运行时（Win10 1803+ 一般自带；缺失时外壳会用系统对话框说明并给出日志路径）
- npm 源已在 `.npmrc` 中指向 npmmirror；crates.io 镜像按需自行配在 `rust/.cargo/config.toml`

### 安装与开发

```bash
npm install           # 只装前端依赖，没有原生模块要重建
npm run app:dev       # 先 build:renderer，再 cargo run -p pm-tauri 起外壳
```

外壳读的是 `dist/renderer`（`tauri.conf.json` 的 `frontendDist`），**改完页面必须重新 `npm run build:renderer` 再刷新窗口**，不然看到的还是上一版产物。只想调样式时可以 `npm run dev` 起 Vite(5173) 单独看页面，但它没有 `window.electronAPI`，所有数据请求会报「未连接」——这是预期行为，不是坏了。

### 构建与打包

```bash
npm run build        # clean → tsc -b → build:shared → vite build（产出 dist/renderer）
npm run app:build    # build:renderer + tauri build，出 NSIS 安装包
npm run icon         # 重新生成应用图标（rust/crates/pm-tauri/icons/icon.ico 与 icon.png）
```

产物在 `rust/target/release/bundle/nsis/Pulsar Manager_<版本>_x64-setup.exe`（约 7 MB），单文件 exe 在 `rust/target/release/Pulsar Manager.exe`。

安装/升级/卸载时对文件的处理写在 `rust/crates/pm-tauri/windows/installer-hooks.nsh`（Tauri 的 `bundle.windows.nsis.installerHooks` 挂载）：升级前清理旧 Electron 版与旧 Rust 版的安装目录/快捷方式/卸载注册表项，卸载时整目录删除，并在用户勾选「删除应用程序数据」时删掉 `%APPDATA%\pulsar-manager`。安装器语言固定为简体中文，改安装界面行为改这个文件后重新 `npm run app:build` 验证。

改应用图标只改 `scripts/make-icon.mjs` 然后跑 `npm run icon`，产物要入库——`tauri.conf.json` 的 `bundle.icon` 指的就是它；ICO 容器必须用未压缩 DIB 目录项，Vista 之后允许的「目录项直接挂 PNG」体积小三倍，但按 DIB 解析的加载器（任务栏与属性面板走的就是它）会把 PNG 字节当位图读，画出来是一片彩色噪点。

数据库结构以常量写在 `rust/crates/pm-store/src/schema.rs`，而不是外部 `.sql` 文件：基线 DDL 每次启动整份幂等执行，再按 `PRAGMA table_info` 补齐新增列。走文件读取的话产物里带的其实是某次手工复制的旧基线，干净环境甚至直接找不到文件而启动失败。

### 提交前的几道门

```bash
npm run typecheck      # tsc -b --force
npm run lint           # ESLint（max-len 120 在 prettier 之后重新开启）
npm run format:check   # 不符时先 npm run format
npm run selftest       # 模板引擎（不连集群）
npm run selftest:docs  # 内置文档中心：目录锚点、跨篇检索、已订正参数名不回流
npm run test:rust      # cargo test --workspace（约 60 个单测：判定、折叠、diff、加解密、策略）
npm run build          # 出 dist/renderer，确认 Vite 与 CSP 注入没问题
```

后台改过 `pm-*` 任何一个 crate，提交前至少要过 `npm run test:rust`；改过 `api-contract.ts` 的通道名，`cargo test` 不会替你发现 Rust 侧的漏配——那条通道的 Rust 分支不存在时只会运行时报「未知方法」，所以加方法请连 `pm-tauri/src/rpc/*.rs` 一起改。

### 发版

发版走 `scripts/release-publish.mjs`（`npm run release`），一条命令串起「出包 → 门禁 → 建发行版 → 传安装包 → 匿名回读校验」：

```bash
npm run release -- --dry-run                   # 出包 + 全部门禁 + 打印发行说明，不建发行版
npm run release                                # 正式发布（先 npm run app:build）
npm run release -- --skip-build                # 复用已打好的包，不重新构建
npm run release -- --verify-only --tag v1.6.2  # 只回读校验已发布的发行版
```

脚本会拦下这些事故，任何一条不过都不发：

- 版本号三处不一致：`package.json`、`rust/Cargo.toml` 的 workspace version、`tauri.conf.json` 的 version。「设置 → 关于」与在线更新比对的都是它（`update:getVersion` 走后台返回应用版本，不是运行时版本）。
- 标签 `v<版本>` 不存在、不指向 HEAD，或还没推到 origin；工作区有未提交的已跟踪改动（`--allow-dirty` 可跳过）。
- 安装包大小不在 5–12 MB，或 exe 属性里的文件 / 产品版本不等于当前版本——拦的是被文件锁截断的半成品与误传的 Electron 包。
- 发行说明缺文件：脚本按提交记录生成草稿后停下，等你补完再跑。

发行说明正文存在 `docs/releases/v<版本>.md` 并随仓库入库。**正文里必须有一行 `- SHA256：` 加反引号包住的 64 位十六进制**：脚本会用刚算出的值替换或补上这一行，再与安装包逐位比对。应用内「检查更新」的校验值**只从正文里取**（`rust/crates/pm-services/src/update.rs` 的 `sha256_from_notes`）——漏了这行，所有旧客户端读得到新版本却拒绝下载；写错值，每个用户都下载成功却装不上。

发布后用匿名请求回读，跑一遍客户端会做的事：最新发行版必须是这一版、附件名与大小要对、下载回来的 SHA256 与说明一致且与本地安装包逐字节一致。

发版凭据按「环境变量 `GITHUB_TOKEN`（或 GitHub CLI 惯用的 `GH_TOKEN`）→ Windows 凭据管理器」的顺序取，不会回显；令牌只需要对仓库有 `Contents: write`。令牌不落文件，仓库里也没有任何令牌文件。Windows 上推荐一次性把令牌存进凭据管理器（交互式，不回显、不进 shell 历史）：

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/wincred.ps1 -Action store
```

存好后 `npm run release` 会自己取用，不必再设环境变量；想先单独确认令牌可用就跑 `npm run release -- --check-auth`（只读校验，不创建发行版），查看与删除改用 `-Action get` / `-Action delete`（对应 `scripts/wincred.ps1`，目标名 `pulsar-manager:github-token`）。其余约束：

- **发行版仓库必须是公开的**：匿名就能读，应用内没有任何令牌入口，用户不用配凭证；源码仓与发行版在同一个公开仓库（`pulsar-manager`），避免同一版本两份包对不上号。
- 仓库只保留最近几个版本的大体积安装包；删发行版与附件不影响标签。

## 架构约束

这几条是踩过坑之后定下的，改代码前请先读：

1. **broker I/O 只能在 Rust 后台。** 生产页面由 Tauri 外壳加载，CSP 是 `connect-src 'self' ipc: http://ipc.localhost`（由 `vite.config.ts` 在构建时注入 meta）。把任何 broker 请求挪到页面，会出现"开发正常、打包后静默失败"。
2. **契约只有一个真源，通道名却写在两处。** `src/renderer/api-contract.ts` 定方法与类型，`rust/crates/pm-tauri/src/rpc/*.rs` 按同一个字符串匹配（`cluster:list`、`msg:consume-batch`…）。类型层能钉住前端内部的一致性，钉不住 Rust 侧——漏配不会编译失败，只会在运行时报「未知方法」。加方法请两边一起改。
3. **推送载荷只能是纯 JSON。** 后台 → 页面走 `msg:consume-batch` / `msg:read-batch` / `msg:session-end` 等通道（`src/shared/types.ts` 里的 `MESSAGE_STREAM_CHANNELS`），类实例传不过去；消息按 50 条 / 300ms / 8MB 合批，不是一条一次 IPC。
4. **不要用 Admin REST 发消息或 peek 消息。** `POST /admin/v2/producers/{t}/{ns}/{topic}/send` 与 `.../subscription/{sub}/peek/{n}` 在真实 broker 上并不存在（返回 HTML 404）。消息收发只有 `pm-pulsar::native`（pulsar crate）这一条路。
5. **分区 topic 的删除走 `.../{topic}/partitions`**，`/partition/-1` 在部分版本上 404。
6. **聚合有上限、扇出有并发窗口。** 拓扑与资源树的规模上限见 `pm-core` 的 `TopologyLimits`；`pm-pulsar::client` 持有一个 `Semaphore(8)` 限制同一集群的并发请求。外层已经拿着许可的代码再去 acquire 就是死锁——内部并发要复用同一处，不要嵌套。
7. **`batchingEnabled` 与 `chunkingEnabled` 在界面上互斥。** 这条约束来自 Node 时代：pulsar-client 1.18 的 C++ 层在两项同时为 true 时直接 abort 整个进程，没有 JS 异常也没有转储。Rust 侧没有实测过同时开启的行为，所以界面仍然把分块置灰、读历史配置时强制归一，别顺手放开。
8. **代码框的颜色与字号只能写 CSS 变量。** CodeMirror 主题经 style-mod 原样塞进生成的样式表，变量在浏览器里按当前 `<html>` 解析，所以三套主题与四档字号都自动跟随；写成 `#fff` 或固定 px，实测就是"整页变暗了只有编辑器还白底"。
9. **版本号有三个必须同步的落点。** `package.json`、`rust/Cargo.toml` 的 workspace version、`rust/crates/pm-tauri/tauri.conf.json`。「设置 → 关于」与在线更新比对用的 `update:getVersion` 取的是 `env!("CARGO_PKG_VERSION")`（不再写死常量），exe 的产品名与版本由 Tauri 从 `tauri.conf.json` 写入，所以三处不一致时界面上的版本会和安装包对不上。
10. **图标只有 `scripts/make-icon.mjs` 一个来源。** 跑 `npm run icon` 产出 `rust/crates/pm-tauri/icons/icon.ico` 与 `icon.png`，两个产物都要入库，`tauri.conf.json` 的 `bundle.icon` 指它。**ICO 容器必须用未压缩 DIB 目录项**：Vista 之后允许的"目录项直接挂 PNG"体积小三倍，但按 DIB 解析的加载器（任务栏与属性面板走的就是它）会把 PNG 字节当位图读，画出来是一片彩色噪点。

## 本地数据

- SQLite 位于 `%APPDATA%\pulsar-manager\pulsar-manager.db`（其他平台是 `$HOME/.config/pulsar-manager/…`，与原 Electron 版 `app.getPath('userData')` 同目录，所以老数据直接能读），存集群配置、SSH/K8s 转发配置、操作日志、界面设置与快捷键绑定、报文模板、消费者会话配置、发送历史、巡检报告与历史、告警规则与事件、通知渠道与投递记录；表结构以 `PRAGMA user_version` 跟踪并增量迁移
- 运行时日志默认在 `%APPDATA%\pulsar-manager\logs\main.log`（单文件超过 2 MB 轮转为 `main.1.log`…`main.5.log`，保留最近 5 份、最多约 12 MB），排障要的完整链路都在这里；日志会记录启动基准线、每次 Admin REST 请求（方法/路径/状态码/耗时）、RPC 方法名以及原生协议的连接/发送/订阅结果，不记录凭据与消息正文；「设置 → 日志」可以直接打开目录、改存储位置（立即生效，落库 `user_settings.logDirectory`）或导出（系统「另存为」选位置，内容是操作日志 + 运行时日志的合并 JSON）
- 卸载默认保留用户数据；在卸载确认页勾选「删除应用程序数据」后，会连同 `%APPDATA%\pulsar-manager`（数据库、日志、加密密钥）一起删除。升级时会清理旧版本遗留的安装文件，但不动用户数据
- 已安装的插件是 `<userData>/plugins/*.json`（或 `plugins/<目录>/plugin.json`），启用状态记在 `user_settings` 的 `disabledPlugins` 里
- 调试时想用一个干净的库：设 `PULSAR_MANAGER_DB=<临时路径>` 再起外壳（单实例锁按 userData 路径判定，同一份数据不会跑出两套后台任务）

## 已知限制

以下是**当前确实没做**的部分，界面不会假装它们可用：

- **SSH 隧道 / K8s 转发的边界**：隧道管理器本身在 Rust 侧已实现（拉起系统的 `ssh -L` 与 `kubectl port-forward`，见 `pm-services/src/tunnel.rs` 与「接入通道」页面），但**集群配置里勾选「走 SSH 隧道 / K8s 端口转发」这条自动改写地址的路径还没接上**：`pm-services/src/cluster.rs` 的 `reject_unported_reachability` 会对这类集群直接返回「暂未实现」的可执行提示，而不是悄悄直连卡到超时。当前用法：在本机（或应用的隧道面板）手动建好转发，再在集群配置里直接填本地可达地址。另两点限制：SSH 只支持密钥认证——`ssh` 从终端读密码，桌面进程里无法自动完成，密码登录会明确报错请改用密钥或 agent；原生收发路径不做隧道可达性检查，地址不可达时表现为连接超时。
- **在线更新走公开仓库的 Releases**：设置→检查更新 读取 `lingfeng983/pulsar-manager`（公开）的最新发行版，比对版本号后下载 exe 附件并校验 SHA256，再静默安装重启。公开仓库匿名就能读，应用内没有任何令牌入口，用户不用配任何东西。仓库地址写死在应用侧 `rust/crates/pm-services/src/update.rs` 的 `OWNER` / `REPO` 常量里（GitHub 匿名 API 有每小时 60 次的请求上限，单机日常检查更新的量级远用不到）——换仓库时应用侧常量与发版脚本 `scripts/release-publish.mjs` 的 `DEFAULT_REPO` 两处必须一起改，否则发出去的包读不到新版本。
- **快速压测的延迟口径**：统计的是 `send()` 调用到 broker 确认的时间，包含客户端在途队列的排队；单生产者并发调大时 P50 会显著上升，这不是 broker 变慢
- **发送历史只存前缀**：每次发送（单发、直接发送、连续发送的每一轮）都往 `send_history` 落一行，生产者工作台的「发送历史」按 集群 + topic 读最近 200 条；正文只留前 400 字符与平均单条字节数，整篇载荷当时就在原生层释放，所以历史不能拿来重发
- **跨集群巡检汇总是快照对比**：汇总页读的是各集群最近一份历史报告，屏幕上的数字可能已是几小时前的；页面按新鲜度分级提示，并以报告生成时间为准，导出文档会写明"这不是同一时刻的快照"
- **插件只贡献数据**：插件市场里的插件是本地 JSON 声明，只能提供压测预设与 Topic 创建模板，不能新增界面、不能访问 broker、不能执行代码；需要这类能力请直接把需求提为应用功能
- 未实现：国际化；监控时序快照按原样留存，不做降采样
- broker→topic 归属在多 broker 集群下没有廉价来源（`/admin/v2/broker-stats/{broker}/topics` 在部分部署上不可用），只能逐 topic 走 `/lookup`；单 broker（standalone）场景下归属是确定的

## 社区与贡献

- **反馈问题 / 提需求**：请使用 [Bug 报告模板](./.github/ISSUE_TEMPLATE/bug_report.md) 与 [功能建议模板](./.github/ISSUE_TEMPLATE/feature_request.md) 提交 Issue
- **参与开发**：见 [CONTRIBUTING.md](./CONTRIBUTING.md)——开发环境、自测清单、提交前四道门、提交约定与发版流程
- **安装与更新**：安装包与版本说明统一在 [GitHub Releases](https://github.com/lingfeng983/pulsar-manager/releases) 发布，应用内「设置 → 检查更新」自动比对
- 如果你觉得这个工具顺手，欢迎点个 Star；也欢迎把使用中遇到的坑提成 Issue，一起把 Pulsar 运维这件事做得更顺

## 版本与许可证

本项目以 Apache License 2.0 全量开源发布，所有功能（集群管理、消息收发、快速压测、监控巡检、
定时巡检、告警通知、SSH 隧道 / K8s 转发、策略批量同步、函数与连接器上传）完整开放，
不设任何版本分区、激活码或用量上限。许可证全文见 [LICENSE](./LICENSE)。

Copyright 2026 Pulsar Manager Team
