# 贡献指南

欢迎参与 Pulsar Manager Desktop 的贡献。本项目是 Apache-2.0 开源的个人维护项目，任何形式的帮助都欢迎：提 Issue、修 Bug、补文档、提功能建议、答疑。

## 提 Issue

- **Bug 报告**：使用 [Bug 报告模板](./.gitee/ISSUE_TEMPLATE/bug_report.md)，说明环境（操作系统 / Pulsar 版本 / 应用版本）、复现步骤、期望行为与实际行为；能附日志或截图更好
- **功能建议**：使用 [功能建议模板](./.gitee/ISSUE_TEMPLATE/feature_request.md)，说明场景、想要的能力与可接受的替代方案
- 提交前先搜索是否已有相同 Issue，避免重复

## 开发环境

- Node.js 20 或更高（开发在 v24 上验证）
- npm 源已在 `.npmrc` 中指向 npmmirror，Electron 二进制也走国内镜像
- `pulsar-client` 是原生模块，安装失败的处理方式见 [README「环境要求」](./README.md#环境要求)
- 没有现成 Pulsar 集群？用根目录的 `docker-compose.yml` 起一个 standalone Pulsar（见 [一键体验指南](./docs/guides/一键体验指南.md)）

```bash
npm install
npm run dev          # 并行启动 Vite(5173) 与 Electron
```

## 代码约定（改代码前必读）

- **broker I/O 只能写在 `src/main/services/`**；服务层不得 `import src/main/ipc/*`。生产构建的页面 CSP 是 `connect-src 'self'`，把 broker 请求挪到渲染进程会出现"开发正常、打包后静默失败"
- **判定、折叠、diff 这类纯逻辑**要留在可以不连集群的情况下被 `scripts/*-selftest.cjs` 自测覆盖
- **`src/preload.ts` 有两处要同步改**：`exposeInMainWorld` 的实现对象与 `declare global` 的类型声明
- **新增数据库列**要写进 `migrate()` 并用 `PRAGMA table_info` 判存在；基线 DDL 每次启动都重跑，直接 ALTER 会让新库 duplicate column 顶掉整个启动事务
- 完整架构约束见 [README「架构约束」](./README.md#架构约束)，都是踩过坑之后定下的

## 提交前的四道门

```bash
npx tsc -b --force   # 类型
npx eslint src       # 规范（max-len 120 在 prettier 之后重新开启）
npm run format:check # 格式，不符时先 npm run format
npm run build:main && npm run build
```

涉及对应模块时，再跑相关自测：

```bash
npm run selftest            # 模板引擎
npm run selftest:worker     # 函数/连接器
npm run selftest:policies   # 命名空间策略
npm run selftest:topic      # Topic 策略
npm run selftest:k8s        # K8s 端口转发
npm run selftest:inspection # 巡检判定
npm run selftest:schedule   # 定时巡检
npm run selftest:summary    # 跨集群汇总
npm run selftest:docs       # 文档中心
npm run selftest:notify     # 通知渠道
```

改过原生依赖（better-sqlite3 等）后，请在 `release/win-unpacked` 里启动验证一次打包态，开发态能跑不代表打包态能跑。

## 提交约定

- 只按名暂存，不用 `git add -A`
- `docs/pulsar/01-*.md` 到 `docs/pulsar/08-*.md` 是应用内置文档中心的资源，由 `src/renderer/utils/doc-kb-source.ts` 用 Vite `?raw` 打进渲染包，必须入库；缺文件不会让构建失败，但页面会退化成空态。`docs/` 下其余草稿与设计稿不在这个约束内
- 提交信息用中文长正文说明「为什么这样改」，用 `git commit -F -`
- 未经明确要求不 push；本机 git 全局 `credential.helper` 被置空，push 需要显式覆盖，且绝不回显 `git credential fill`

## 发版

发版由维护者执行，流程见 [README「发版」](./README.md#发版)。一句话：`./release.sh` 会跑完静态门、出包、打标签、发布到 Gitee 分发仓（`pulsar-manager-dist`，只放发行版与安装包，仅保留最近 3 个版本）。

## 行为准则

- 友善沟通，就事论事；新人问题值得被认真回答
- 不把凭据、Token 或任何密钥写进代码、Issue 或 PR（`.gitee_token` 已在 `.gitignore`，严禁入库）
- 讨论与答疑也请遵守 Apache-2.0 的开源精神：尊重原作者与贡献者的时间
