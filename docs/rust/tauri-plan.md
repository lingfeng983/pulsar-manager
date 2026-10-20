# Tauri 迁移方案（定稿）

> 目标：保住现有 React 前端的视觉表现力，同时把 Electron 版的卡顿问题在架构层面解决。
> 状态：待确认。本文只描述方案，不含实施记录。

## 1. 结论

采用 **Tauri 2 + 现有 React 前端 + 已完成的 Rust 服务层**。

- 视觉：前端页面零重写，观感与现版一致
- 性能：消除 Node-API 跨线程、IPC 全量大对象、无虚拟滚动、多路轮询四个瓶颈
- 复用：`pm-core` / `pm-store` / `pm-pulsar` / `pm-services` 共约 6744 行全部保留
- 废弃：`pm-gui`（egui 壳，5544 行）——迁移完成后已删除，不再作为兜底分支维护

## 2. 现状盘点

| 项 | 规模 | 说明 |
|---|---|---|
| 前端框架 | React 18 + Vite 5 | `src/renderer/` |
| 页面 | 19 个 | 含消息浏览、消费工作台、指标大盘、拓扑、插件市场等 |
| 主进程服务 | 34 个文件 | `src/main/services/` |
| RPC 方法 | 约 157 个 | `src/preload.ts` 1115 行，单个 channel 内 switch 分发 |
| Node 依赖 | `pulsar-client`(Node-API) `better-sqlite3` `ssh2` `nodemailer` | 前三项 Rust 侧已有替代 |
| Rust 后端 | 6744 行 | 已编译、33 个单测全绿 |

### 现有性能瓶颈归因

| 瓶颈 | 位置 | 是否 Electron 固有 |
|---|---|---|
| 单个大 RPC 通道，所有调用排队 | `ipcMain.handle` 仅 3 个 | 否，架构问题 |
| 列表无虚拟滚动，全量 DOM | 渲染层无 `virtual` 实现 | 否，架构问题 |
| 三路 `setInterval` 并行全量轮询 | 拓扑 / 集群状态 / 消费工作区 | 否，架构问题 |
| 消息经 C++ 回调跨线程 + 事件循环 + IPC | `pulsar-client` | 换壳可根治 |
| Chromium 多进程内存 | Electron 本身 | 是，Tauri 只能改善不能消除 |

**结论**：四项里三项是架构问题，换壳不等于变快；但换壳是唯一能把消息通路降到 native 的机会。

## 3. 目标架构

```
┌──────────────────────────────────────────────────────┐
│  React 18 渲染层（现有代码，零重写）                  │
│  window.api.xxx()  ——  契约不变                       │
└───────────────────┬──────────────────────────────────┘
                    │ preload 等价层（唯一改动点）
        ┌───────────┴────────────┐
        │                        │
   RPC 通道                 流通道
   请求-响应                单向推送
   157 方法                消息 / 进度 / 日志
   JSON                    二进制批量
        │                        │
┌───────┴────────────────────────┴─────────────────────┐
│  Rust 应用层（Tauri command）                         │
│  dispatch(method, params)  →  pm-services             │
└───────────────────┬──────────────────────────────────┘
                    │
   ┌────────────────┼────────────────┐
   │                │                │
pm-pulsar       pm-store         pm-core
Admin REST      SQLite v17       模型/路径/错误
原生协议        19 张表           格式化
```

## 4. 关键设计决策

### D1. 前端零改动：保留 `window.api` 契约

不把 157 个方法拆成 157 个 `#[tauri::command]`。改为单一入口：

```rust
#[tauri::command]
async fn rpc(method: String, params: serde_json::Value) -> Result<serde_json::Value, String>
```

前端只需把 `preload.ts` 的 `ipcRenderer.invoke(CHANNEL, method, params)` 换成
`tauriInvoke('rpc', { method, params })`，**19 个页面和 34 个 service 一行不改**。

- 收益：迁移风险集中在一个 200 行的适配层，出问题只改这一处
- 代价：无法用 Tauri 的 command 级权限粒度（对本项目无影响，都是本地能力）

### D2. 双通道：请求-响应与高频流分离

高频路径必须绕开「一条消息一次 IPC」：

| 通道 | 用途 | 传输 |
|---|---|---|
| RPC | 157 个方法 | JSON，单次往返 |
| Stream | 消费消息、发送进度、巡检进度、日志 | `emit` + 二进制帧，100ms 或 500 条合批 |

消息帧约定：定长头（时间戳 / 分区 / 偏移 / 长度）+ UTF-8 负载，前端按偏移切片解析，
不做整体 `JSON.parse`。这是 5000 msg/s 下不丢帧的前提。

### D3. 状态归属

- **UI 状态**（选中页签、表单草稿、滚动位置）留在 React
- **领域状态**（集群、模板、告警规则、会话）留在 Rust / SQLite
- Rust 不向前端「塞结论」，前端不重复计算领域规则（路径推导、端口映射、脱敏等已在 `pm-core`）

### D4. Node 依赖的替代

| 现依赖 | 替代 | 状态 |
|---|---|---|
| `pulsar-client` | `pm-pulsar::native`（pulsar-rs 6.9） | 已完成 |
| `better-sqlite3` | `pm-store`（rusqlite bundled） | 已完成 |
| `nodemailer` | `lettre` | 未做 |
| `ssh2` | `russh` | 未做（当前显式报错） |
| 无（kubectl 子进程） | 保持子进程调用 | 未做 |

## 5. 性能改造清单

### P1 消息通路换成 native

`pulsar-client` 的每批消息要经历：C++ IO 线程 → N-API 回调 → Node 事件循环 → IPC 序列化 → 渲染进程。
`pm-pulsar::native` 直接在 tokio 任务里收，去掉中间三段。

### P2 IPC 批量化 + 二进制

- 合批窗口 100ms，单批上限 500 条
- 超过上限立刻冲刷，避免高吞吐时延迟累积
- 前端用 `Buffer`/`ArrayBuffer` 视图解析，不构造中间对象

### P3 列表虚拟滚动

- 接入 `@tanstack/react-virtual`
- 优先改造：消息浏览、topic 列表、投递记录、操作日志
- 行高固定可省去测量，滚动更稳

### P4 轮询收敛

- 三个 `setInterval` 合并为单调度器
- 页面不可见时（`document.visibilityState`）暂停
- 失败退避：2s → 4s → 8s，上限 60s，成功后复位
- 同一集群的并发请求在 Rust 侧已有 `Semaphore`，无需前端限流

## 6. 分阶段落地

| 阶段 | 内容 | 验收 |
|---|---|---|
| S1 | Tauri 工程初始化、`rpc` 桥、窗口配置、打包流水线 | 打包产物可启动，`rpc` 能调通 1 个方法 |
| S2 | 只读链路：集群列表/连接测试/租户/命名空间/topic/统计 | 概览页数据与 Electron 版一致 |
| S3 | 写操作：集群 CRUD、topic/租户/命名空间创建、策略、订阅 | 增删改与 Electron 版行为一致 |
| S4 | 高频路径：消费会话、发送、模板渲染 | 5000 msg/s 连续 5 分钟不丢帧、UI 可交互 |
| S5 | 长尾：巡检、告警、通知、授权、插件、文档中心 | 功能对等清单全绿 |

**捷径**：P3 + P4 与壳无关，可以先在 Electron 版上做（约 2~3 天），
用真实卡顿场景验证「架构问题」这个判断，再决定是否投入 S1~S5。

## 7. 预期指标

| 指标 | Electron 现状（估） | Tauri 目标 | egui 现状（实测） |
|---|---|---|---|
| 冷启动 | 2~4s | < 1.5s | < 1s |
| 常驻内存 | 300MB+ | 180~220MB | 105MB |
| 安装包 | 150MB 级 | 20~30MB（不含 WebView2） | 21MB 单文件 |
| 万行表格滚动 | 掉帧 | 60fps | 60fps（虚拟化后） |
| 消息吞吐 | 受 IPC 限制 | 5000 msg/s | 同进程无上限 |

说明：内存和包体的改善幅度取决于前端资源体积，不是数量级改善；要数量级只能走原生渲染。

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 目标机 WebView2 版本过低 | 打包时声明最低版本；启动检测并提示安装 |
| 前端 dist 体积偏大（ECharts + CodeMirror） | 路由级动态 import，ECharts 按需引入图表类型 |
| 157 个方法的类型不同步 | 用 `ts-rs` 从 Rust 结构体生成 d.ts，或保留现有 `shared/types.ts` 作为单一真源 |
| Tauri 的 command 无法中途取消 | 长任务改为「启动返回句柄 + 单独的 cancel 方法」，与现有 session 语义一致 |
| 隧道 / K8s 转发未移植 | 保持显式报错，不静默失败 |

## 9. 明确不做的事

- 不重写前端页面
- 不把 egui 作为主壳
- 不在前端保留任何直连 Pulsar / SQLite 的能力（全部经 Rust）
- 不为兼容而保留两套 IPC 实现
