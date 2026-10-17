# pulsar-manager

Electron 29 + React 18 + TypeScript 桌面端 Pulsar 管理工具（主进程走 Admin REST / 原生 pulsar-client，数据存 SQLite）。

## 常用命令

- `npm run dev` — 并行启动主进程与 Vite 渲染进程
- `npm run typecheck` — `tsc -b --force`，提交前必过
- `npm run lint` / `lint:fix` — ESLint（`max-len` 120）
- `npm run format` / `format:check` — Prettier（printWidth 120）
- `npm run build` — clean + `tsc -b` + 主进程 + Vite
- 自测：`npm run selftest`（模板引擎）、`selftest:worker`、`selftest:policies`、`selftest:topic`、`selftest:k8s`、`selftest:inspection`、`selftest:schedule`、`selftest:summary`、`selftest:docs`、`selftest:notify`

## 分层约束

- 与 broker 的网络 I/O 只写在 `src/main/services/`；服务层不得 import `src/main/ipc/*`。
- `PulsarAdminClient` 是 ResourceAPI / MetricsAPI / WorkerAPI / NamespacePolicyAPI / TopicPolicyAPI 的薄门面，IPC handler 负责取客户端与转发，服务层不碰 ipc。
- 判定、折叠、diff 这类纯逻辑要留在可以不连集群的情况下被 `scripts/*.cjs` 自测覆盖。
- `src/preload.ts` 有两处要同步改：`exposeInMainWorld` 的实现对象与 `declare global` 的类型声明。
- 新增数据库列要写进 `migrate()` 里并用 `PRAGMA table_info` 判存在；基线 DDL 每次启动都重跑，直接 ALTER 会让新库 duplicate column 顶掉整个启动事务。

## 提交约定

- 只按名暂存，不用 `git add -A`。
- `docs/pulsar/01-*.md` 到 `docs/pulsar/08-*.md` 是应用内置文档中心的资源，由 `src/renderer/utils/doc-kb-source.ts` 用 Vite `?raw` 打进渲染包，必须入库；缺文件不会让构建失败（`import.meta.glob` 返回空集），但页面会退化成空态。`docs/` 下其余草稿与设计稿不在这个约束内。
- 提交信息用中文长正文说明「为什么这样改」，用 `git commit -F -`。
- 未经明确要求不 push。本机 git 全局 `credential.helper` 被置空，push 需要显式覆盖，且绝不回显 `git credential fill`。
