# pulsar-manager

Tauri 2 + React 18 + TypeScript 桌面端 Pulsar 管理工具。后台全在 Rust（Admin REST + `pulsar` crate 原生收发，数据存 SQLite），页面复用本仓库的 React 前端，只依赖系统 WebView2。

## 常用命令

- `npm run dev` — 只起 Vite（渲染层热更新）；配合 `cd rust && cargo run -p pm-tauri` 跑外壳
- `npm run app:dev` — 先 `build:renderer` 再起 Rust 外壳（改完前端必须重新 build，外壳读的是 `dist/renderer`）
- `npm run app:build` — 出安装包，产物在 `rust/target/release/bundle/nsis/`
- `npm run typecheck` — `tsc -b --force`，提交前必过
- `npm run lint` / `lint:fix` — ESLint（`max-len` 120）
- `npm run format` / `format:check` — Prettier（printWidth 120）
- `npm run build` — clean + `tsc -b` + `build:shared` + Vite
- `npm run test:rust` — `cargo test --workspace`（约 60 个单测，覆盖判定/折叠/加解密/策略 diff）
- 自测：`npm run selftest`（模板引擎，直接 import `src/shared/template-engine.ts`）、`npm run selftest:docs`（内置文档中心的锚点、目录与检索，需要 `build:shared` 产物）
- `npm run icon` — 图标唯一来源，产出 `rust/crates/pm-tauri/icons/`；改设计改脚本后必须重跑并把产物入库
- `npm run release` — 发版：出包 → 门禁 → 建发行版 → 传安装包 → 匿名回读校验；`--dry-run` 只出包过门禁、不发布（规则见 README「发版」）

## 分层约束

- 与 broker 的网络 I/O 只写在 `rust/crates/pm-pulsar/`；`pm-services` 不得依赖 tauri，也不得 import `pm-tauri`。
- `pm_pulsar::AdminClient` 是 resource / metrics / policies / worker 的薄门面；`rpc` 层负责取客户端与转发，服务层不碰分发。
- 页面 → 后台只有一个入口：`rpc(method, args)`（`pm-tauri/src/bridge.rs`）。它按业务域链式分发到 `pm-tauri/src/rpc/*.rs`，每个模块的 `dispatch` 命中返回 `Some`、未命中返回 `None` 交给下一段；返回统一是 `{success, data?, error?, code?}`，永不 reject。
- **前后端契约的唯一真源是 `src/renderer/api-contract.ts`**：150 个方法的名称、参数顺序、返回类型，以及 `window.electronAPI` 的 `declare global` 都在这一个文件里（名字里的 electron 是历史包袱，改掉要动 40 多个页面）。它已不再由代码生成器产出——生成器与 Electron 的 `src/preload.ts` 一起删了，改完不用重跑任何脚本。
- 通道名（`cluster:list`、`msg:consume-batch` …）同时写在 `api-contract.ts` 和 Rust 侧，靠 `src/shared/types.ts` 里的通道常量与字面量类型钉住一致性：不一致不会让 typecheck 失败，只会运行时报「未知方法」。加方法时两边都要改。
- 判定、折叠、diff 这类纯逻辑要留在可以不连集群的情况下被单测覆盖的形式（Rust `#[test]`，前端侧剩的两个 `.cjs`/`.mjs` 自测）。
- 新增数据库列要写进 `pm-store` 的基线 DDL，并用 `column_exists()`（`PRAGMA table_info`）判存在；基线 DDL 每次启动都重跑，直接 ALTER 会让新库 duplicate column 顶掉整个启动事务。`SCHEMA_VERSION` 与 TS 时代对齐为 17。
- Electron/Node 侧已经删除：`src/main/**`、`src/preload.ts`、electron 与 electron-builder 依赖、依赖 `dist/src/main` 的 8 个 selftest、`release.sh` 与整条 Electron 发版链。不要往回加；**发版走 `npm run release`**（`scripts/release-publish.mjs`：出包 → 门禁 → 建发行版 → 传安装包 → 匿名回读校验；GitHub Releases 与发行说明必须带 SHA256 行的规则见 README，令牌只从 `GITHUB_TOKEN` 环境变量读）。

## 提交约定

- 只按名暂存，不用 `git add -A`。
- `docs/pulsar/01-*.md` 到 `docs/pulsar/08-*.md` 是应用内置文档中心的资源，由 `src/renderer/utils/doc-kb-source.ts` 用 Vite `?raw` 打进渲染包，必须入库；缺文件不会让构建失败（`import.meta.glob` 返回空集），但页面会退化成空态。`docs/` 下其余草稿与设计稿不在这个约束内。
- `rust/target/` 与 `.workbuddy/` 已被忽略，别提交产物；`rust/tools/protoc/` 是**自带**的 protoc（`pulsar` crate 的 build.rs 需要它，删了新克隆就编不过），12MB 属预期。
- 提交信息用中文长正文说明「为什么这样改」，用 `git commit -F -`。
- 未经明确要求不 push。本机 git 全局 `credential.helper` 被置空，push 需要显式覆盖，且绝不回显 `git credential fill`。
