# 贡献指南

欢迎参与 Pulsar Manager Desktop 的贡献。本项目是 Apache-2.0 开源的个人维护项目，任何形式的帮助都欢迎：提 Issue、修 Bug、补文档、提功能建议、答疑。

## 提 Issue

- **Bug 报告**：使用 [Bug 报告模板](./.github/ISSUE_TEMPLATE/bug_report.md)，说明环境（操作系统 / Pulsar 版本 / 应用版本）、复现步骤、期望行为与实际行为；能附日志或截图更好
- **功能建议**：使用 [功能建议模板](./.github/ISSUE_TEMPLATE/feature_request.md)，说明场景、想要的能力与可接受的替代方案
- 提交前先搜索是否已有相同 Issue，避免重复

## 开发环境

- Rust（开发在 1.98 上验证）+ 本机 C++ 工具链（`rusqlite` 用 bundled SQLite，Windows 上需要 MSVC）
- Node.js 20 或更高（开发在 v24 上验证）——只用于前端构建、图标脚本与两个自测，运行时不需要 Node
- 首次编译 `pulsar` crate 需要 protoc；仓库自带 Windows 版（`rust/tools/protoc`），其他平台见 [README「环境要求」](./README.md#环境要求)
- 没有现成 Pulsar 集群？用根目录的 `docker-compose.yml` 起一个 standalone Pulsar（见 [一键体验指南](./docs/guides/一键体验指南.md)）

```bash
npm install
npm run app:dev      # 先 build:renderer，再起 Rust 外壳（cargo run -p pm-tauri）
```

## 代码约定（改代码前必读）

- **broker I/O 只写在 `rust/crates/pm-pulsar/`**；`pm-services` 不得依赖 tauri，也不得 import `pm-tauri`。生产页面由 Tauri 外壳加载、CSP 只允许 `self` 与 `ipc:`，把 broker 请求挪到页面会出现"开发正常、打包后静默失败"
- **页面 → 后台只有一个入口**：`rpc(method, args)`（`pm-tauri/src/bridge.rs`），按业务域链式分发到 `pm-tauri/src/rpc/*.rs`。加方法要同时改 `src/renderer/api-contract.ts` 与对应 Rust 模块——类型层钉不住 Rust 侧的字符串，漏配只在运行时报「未知方法」
- **`src/renderer/api-contract.ts` 是契约唯一真源**：方法名、参数顺序、返回类型与 `window.electronAPI` 的 `declare global` 都在这一个文件里，改完不需要重跑任何代码生成
- **判定、折叠、diff 这类纯逻辑**要留在可以不连集群的情况下被单测覆盖：Rust 侧写 `#[test]`（`npm run test:rust`），前端侧是 `npm run selftest` / `selftest:docs`
- **新增数据库列**要写进 `pm-store` 的基线 DDL，并用 `column_exists()`（`PRAGMA table_info`）判存在；基线 DDL 每次启动都重跑，直接 ALTER 会让新库 duplicate column 顶掉整个启动事务
- 完整架构约束见 [README「架构约束」](./README.md#架构约束)，都是踩过坑之后定下的

## 提交前要过的门

```bash
npm run typecheck      # tsc -b --force
npm run lint           # ESLint（max-len 120 在 prettier 之后重新开启）
npm run format:check   # 格式，不符时先 npm run format
npm run build          # 出 dist/renderer（含生产 CSP 注入）
npm run test:rust      # cargo test --workspace：巡检判定、策略 diff、加密、模板、折叠
```

前端侧还有两个不依赖后台的自测：

```bash
npm run selftest       # 报文模板引擎（预览与实发同源这条，靠它证伪）
npm run selftest:docs  # 内置文档中心：目录锚点、跨篇检索、已订正参数名不回流
```

改过 `rust/` 下任何 crate，`npm run test:rust` 是硬门；改过打包相关（`tauri.conf.json`、图标、NSIS 配置），请跑一次 `npm run app:build` 并**装上产物验证**——开发态能跑不代表打包态能跑，WebView2 与自定义协议下的行为差异只在安装包态暴露。

## 提交约定

- 只按名暂存，不用 `git add -A`
- `docs/pulsar/01-*.md` 到 `docs/pulsar/08-*.md` 是应用内置文档中心的资源，由 `src/renderer/utils/doc-kb-source.ts` 用 Vite `?raw` 打进渲染包，必须入库；缺文件不会让构建失败，但页面会退化成空态。`docs/` 下其余草稿与设计稿不在这个约束内
- `rust/target/` 已被忽略，不要提交产物；`rust/tools/protoc/` 是自带的 protoc，属预期入库内容
- 提交信息用中文长正文说明「为什么这样改」，用 `git commit -F -`
- 未经明确要求不 push；本机 git 全局 `credential.helper` 被置空，push 需要显式覆盖，且绝不回显 `git credential fill`

## 发版

发版由维护者执行，流程与硬性规则见 [README「发版」](./README.md#发版)。`npm run release`（`scripts/release-publish.mjs`）会依次做出包、门禁、建发行版、传安装包与匿名回读校验；先跑 `npm run release -- --dry-run` 看门禁结果与发行说明，再去掉 `--dry-run` 发布到公开仓库 `lingfeng983/pulsar-manager` 的 Releases（需要环境变量 `GITHUB_TOKEN`）。发行说明正文**必须带一行 `- SHA256：`<64 位>``**（应用内更新只从正文取校验值，缺了这条等于给所有旧客户端发一条读得到却装不上的更新）；这一行由脚本自动写入并与安装包逐位比对。

## 行为准则

- 友善沟通，就事论事；新人问题值得被认真回答
- 不把凭据、Token 或任何密钥写进代码、Issue 或 PR（发版令牌只从环境变量 `GITHUB_TOKEN` 读，别落进文件）
- 讨论与答疑也请遵守 Apache-2.0 的开源精神：尊重原作者与贡献者的时间
