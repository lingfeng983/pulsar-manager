# Rust 桌面版（Tauri 外壳，复用同一套界面）

`rust/` 是与 Electron 版并列的实现：**后台全部在 Rust 里**，界面直接复用本仓库的 React 前端，
装在 Tauri 外壳里跑——只依赖系统自带的 WebView2，进程里没有 Chromium，也不打包 Node 运行时。

之所以不是「纯 Rust 自绘界面」：自绘那一版（egui 壳，5000 多行）中途放弃并已删除——它的视觉和
交互与现有界面差得太远，改不动也不该改。要「页面效果和原来完全一致」，唯一稳的路子是复用同一份
前端代码，把 Electron 的主进程换成 Rust。

## 结构

```
rust/
├─ crates/
│  ├─ pm-core      领域模型（对齐 src/shared/types.ts）、错误、路径推导、日志 sink
│  ├─ pm-store     SQLite：18 张表、user_version=17、幂等基线 DDL + 补列
│  ├─ pm-pulsar    Admin REST 客户端 + 原生生产/消费（pulsar crate）
│  ├─ pm-services  业务：集群装配、凭据加密、策略、巡检、告警、通知、消息会话、压测、更新、隧道
│  └─ pm-tauri     Tauri 外壳：单条 `rpc` 命令 + 托盘/单实例/外链/日志
└─ tools/protoc    自带的 protoc（pulsar crate 的 build.rs 需要，离线也能编）
```

## 界面零改动的实现方式

Electron 版里页面只认 `window.electronAPI`（由 `src/preload.ts` 注入）。Tauri 版没有 preload，
于是：

1. `scripts/gen-tauri-bridge.mjs` 从 `src/preload.ts` **生成**一份同名同签名的 `tauri-bridge.generated.ts`，
   把每个 `ipcRenderer.invoke('x', ...)` 换成 `transport.invoke('x', ...)`；
2. `src/renderer/tauri-runtime.ts` 在模块加载时用 `window.__TAURI__.core.invoke('rpc', {method, args})`
   构造出 `window.electronAPI`，字段名 camelCase ↔ snake_case 的转换在这一层做；
3. Rust 侧只有一个命令 `rpc(method, args)`，按业务域链式分发（`crates/pm-tauri/src/rpc/*.rs`），
   返回值统一是 `{success, data?, error?, code?}`，永不 reject。

因此 `src/preload.ts` 仍是唯一的接口真源：改完 preload 重新生成即可，前端页面一行都不用动。

## 性能：为「卡顿、滚动慢、消息延迟」做的四件事

| | 做法 | 效果 |
| --- | --- | --- |
| 协议 | 消息收发走 `pulsar` crate 的二进制协议（原版经 Node 的 pulsar-client 中转） | 少一次进程间拷贝与事件循环排队 |
| 合批 | 消费/读取按 50 条 / 300ms / 8MB 组批推送，不是一条一次 IPC | 高吞吐时 IPC 次数从 O(消息) 降到 O(批) |
| 渲染 | 消息表超过 200 行才切 `virtual`（antd + rc-virtual-list），行高由列表实测 | 5000 行时只渲染视口内的十几行；200 行以内渲染路径与原来完全一致 |
| 空闲 | 窗口在后台时停掉集群状态轮询，回到前台先补探一次 | 托盘常驻不再空转 |

虚拟滚动的阈值是刻意的：开虚拟后表体会套一个内部滚动区，行数少时这个滚动区本身就是视觉差异。
`src/renderer/hooks/useVirtualTable.ts` 只用容器上边缘算「到视口底还剩多少」，不拿容器高度当
`scroll.y`——后者会和表格自身高度互相追，最后缩到最小值。

## 构建与打包

```bash
npm run build:renderer                       # 前端产物 → dist/renderer（两个版本共用）
cd rust/crates/pm-tauri && npx tauri build   # 产物见下
```

产物：

- `rust/target/release/Pulsar Manager.exe` —— 单文件，前端资源已内嵌
- `rust/target/release/bundle/nsis/Pulsar Manager_<版本>_x64-setup.exe` —— 安装包（约 7 MB）

开发态：`cd rust && cargo run -p pm-tauri`（页面读 `dist/renderer`，改前端要重新 `npm run build:renderer`）。

首次构建需要 `protoc`。仓库已把 Windows 版放进 `rust/tools/protoc/bin/protoc.exe`，并通过
`rust/.cargo/config.toml` 的 `[PROTOC]` 注入；其他平台装一个 protoc 或替换该文件即可。

测试：`cargo test --workspace`。

调试用环境变量：

| 变量 | 作用 |
| --- | --- |
| `PM_RPC_LOG=1` | 每个 RPC 调用写日志，并在页面加载后回传渲染探针（DOM 长度、桥是否装上、页面报错） |
| `PULSAR_MANAGER_DB=...` | 覆盖数据库路径（默认 `%APPDATA%\pulsar-manager\pulsar-manager.db`） |
| `ALLOW_PLAINTEXT_KEY=1` | 系统密钥库不可用时允许退回明文密钥文件（不安全，需显式开启） |

## 桌面外壳行为（与 Electron 版对齐）

| 行为 | 实现 |
| --- | --- |
| 单实例 | `tauri-plugin-single-instance`：第二次启动把已有窗口叫到前台，不会跑出两套后台任务 |
| 托盘 | 图标取自 `icons/icon.png`，菜单「显示主窗口 / 退出」，双击图标回到窗口 |
| 关闭窗口 | 只收进托盘，不退出进程——定时巡检与告警评估继续跑；真正退出走托盘菜单 |
| 启动不闪白 | 窗口 `visible(false)` 建，首帧 `PageLoadEvent::Finished` 后显示，另有 3 秒兜底 |
| 外链 | `window.open` 与 `<a href>` 都拦下来交给系统浏览器；只放行 http/https，避免点个链接把应用导航走 |
| 日志 | `<userData>/logs/main.log`，与 Electron 版同一份文件、同一行格式（`[ISO时间] [级别] 内容`），超 2 MB 滚成 `main.1.log` |
| 启动失败 | 用系统对话框说明原因并给出日志路径，而不是闪一下就没了 |
| 退出收尾 | `RunEvent::Exit` 时统一收掉 ssh / kubectl 转发的子进程 |

## 与 Electron 版的兼容性

- **同一个数据库文件、同一个 `user_version = 17`**：Rust 版启动时执行与 `schema.ts` 逐列对齐的基线 DDL，
  再按 `PRAGMA table_info` 补齐 v6…v17 新增列，两个版本可以互相打开对方的库，无需迁移脚本。
  （Rust 版多建一张 `k8s_forwards` 表，TS 侧不认识它，但也不影响读自己的表。）
- **同一套凭据密钥**：`.encryption-key.v2` 里是 `v10` + DPAPI 保护的十六进制密钥，密文格式为
  `v2:` + base64(iv12‖tag16‖ciphertext)。读写规则与 `encryption.ts` 一致，能解出老库里的
  `authParams`、通知渠道 URL、SMTP 密码。
- **密钥不可解密时自愈**：若 DPAPI 已解不开（Windows 密码被重置、配置文件搬到另一台机器），
  不阻断启动：旧文件备份成 `.encryption-key.v2.broken-<时间戳>`、生成新密钥，界面顶部挂横幅提示
  「已保存的认证参数需要重新填写」。绝不静默降级成明文存储。
- **Admin API 口径逐条对齐**：6650→8080 / 6651→8443 端口推导、TLS 下拒绝 `http://` 的 webServiceUrl、
  分区 topic 用 `/partitioned-stats` 降级、分区号按数字序排列、`/metrics` 的 `pulsar_version_info` 取版本、
  broker 归属对不上就不连线。

## 功能对等现状

`src/preload.ts` 里的 150 个接口全部有实现（`crates/pm-tauri/src/rpc/` 下按域分布，扫描无缺口），
另有 5 个 Tauri 外壳层新增能力（单实例、托盘、外链、日志、包选择白名单）。

| 能力 | 状态 |
| --- | --- |
| 集群增删改查 / 探活 / 版本探测 / 凭据加密 | 已实现 |
| 租户 / 命名空间 / Topic 资源树与 CRUD、Topic 配置与分区扩容 | 已实现 |
| 命名空间 / Topic 策略读写、清空、跨集群批量同步（plan + apply） | 已实现 |
| Schema（版本/策略）、ACL 授予与撤销 | 已实现 |
| 消息发送、订阅消费、Reader 回溯、订阅积压与偷看 | 已实现（原生协议，批次推送 50 条 / 300ms / 8MB） |
| 生产者 / 消费者工作台（长连接会话、限速、实时统计） | 已实现 |
| 快速压测（按速率生产 + P50/P95/P99 + 进度推送） | 已实现 |
| 概览、broker 列表、时序快照、多集群拓扑 | 已实现 |
| 集群巡检（阈值、报告、历史、环比、Markdown 导出）、定时巡检、跨集群汇总 | 已实现 |
| 告警规则 CRUD + 周期评估 + 连续 N 次立案 / 恢复 + 事件确认 | 已实现（后台 5 秒一拍，改配置即时生效） |
| 通知渠道 / 邮件服务器 CRUD + 试发 + 投递记录 | 已实现（Webhook 与企业微信/钉钉/飞书，SMTP 走 lettre） |
| 报文模板、消费配置、发送历史 | 已实现 |
| 函数与连接器（worker）、本机包上传 | 已实现（选包走系统对话框 + 路径白名单） |
| SSH 隧道 / K8s 端口转发 | 已实现（拉起系统 `ssh -L` / `kubectl port-forward`；SSH 需密钥登录，密码登录在桌面进程里无法自动完成） |
| 在线更新 | 已实现（Gitee 发行版、SHA256 校验、512 MB 闸） |
| 插件（列表/安装/导入/卸载/启停/打开目录） | 已实现：插件是纯声明式 JSON，只贡献压测预设与 Topic 模板，不加载任何代码，因此整个机能 `pm_services::plugins` 模块独立复刻；同一目录、同一份官方目录、同一套校验规则 |

未实现的项都不做「假成功」：要么在界面上明确标注，要么由后端返回可执行的错误原因。

## 设计约束（和 Electron 版一致的坑）

- **凭据写入语义**：`authParams = None` 表示「沿用已保存的」，空串表示「清除」。界面在已有密钥时
  只显示「已保存（不修改）」，避免每次保存把凭据抹掉。
- **告警不追抖动**：单次越线不立案，必须连续 N 次（`consecutive`）满足阈值；回落一次即清零重计。
  规则被修改或删除时，连续计数立即清零，否则新阈值下会少数几轮。
- **投递记录必须留痕**：「渠道关闭 / 未订阅该事件 / 低于级别线」三种跳过也会写一行投递记录并带上理由，
  否则用户只会看到一个没反应的按钮。
- **失败不清空界面**：任何后台任务失败都会清掉 busy 标记、把错误挂到对应页面与提示条，而不是让
  一个 spinner 永久转下去。
- **定时巡检失败也写 `last_run_at`**：不写的话，一台关着的集群会被每分钟敲一次门；同一句失败原因只通知一次。
