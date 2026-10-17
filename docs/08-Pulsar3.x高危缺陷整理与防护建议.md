# Pulsar 3.x 高危 Bug 与安全漏洞整理及防护建议

> 基于 CVE.org 官方记录与 apache/pulsar GitHub Release Notes 整理（截至 2026-10）。供版本选型、升级规划与安全加固参考。
> 默认值相关审校以 branch-3.3 官方 conf 原文为准（本版修正了旧审校记录中若干默认值错误）。

## 目录

- [1. 安全漏洞（CVE）](#1-安全漏洞cve)
- [2. 高危可靠性 Bug（非 CVE）](#2-高危可靠性-bug非-cve)
- [3. 版本现状与升级建议](#3-版本现状与升级建议)
- [4. 生产防护建议](#4-生产防护建议)
- [5. 本次文档审校同步修正记录](#5-本次文档审校同步修正记录)

## 1. 安全漏洞（CVE）

| CVE | CVSS | 影响 3.x 版本 | 修复版本 | 说明与缓解 |
|---|---|---|---|---|
| CVE-2024-27135 Functions Worker RCE | 8.5 H | 3.0.0–3.0.2、3.1.0–3.1.2、3.2.0 | 3.0.3 / 3.1.3 / 3.2.1 | 恶意认证用户绕过沙箱在 Worker 上执行任意 Java 代码 |
| CVE-2024-27894 Worker 未授权文件访问/HTTP 代理 | 8.5 H | 同上 | 3.0.3 / 3.1.3 / 3.2.1 | 用 file:// http:// URL 创建 function 读取 Worker 可读文件（含密钥）；修复版默认禁用 URL 引用，需白名单 `additionalEnabledFunctionsUrlPatterns` 放开 |
| CVE-2024-27317 Worker 归档解压路径穿越 | 8.4 H | 同上 | 3.0.3 / 3.1.3 / 3.2.1 | 上传含 `..` 文件名的 jar/nar，解压目录外写文件 |
| CVE-2023-30429 Worker 经 Proxy mTLS 授权不当 | 9.6 C | ≤3.0.0（含 2.x） | 2.11.1 / 3.0.1 | 经 Proxy 使用 mTLS 时 Function Worker 授权校验失效 |
| CVE-2023-37579 Worker 泄露 Sink/Source 凭据 | 8.2 H | ≤3.0.0（含 2.x） | 3.0.1 | 授权不当导致连接器凭据泄露 |
| CVE-2022-34321 Proxy /proxy-stats 未认证 | 8.2 H | 3.0.0–3.0.1、3.1.0 | 3.0.2 / 3.1.1 | 未认证读取连接统计（客户端 IP）并改日志级别刷盘 DoS |
| CVE-2023-51437 SASL token 时序攻击 | 7.4 H | 3.0.0–3.0.1、3.1.0 | 3.0.2 / 3.1.1 | 伪造签名可通过的 SASL Role Token；**升级后必须轮换 signer 密钥** |
| CVE-2023-37544 WebSocket Proxy 未认证 DoS | 7.5 H | 3.0.0 | 3.0.1 | 未认证连 /pingpong 耗尽连接 |
| CVE-2024-47561 Avro Schema 解析 RCE | 9.8 C | 3.x < 3.0.7、3.1.x、3.2.x、3.3.0–3.3.1（**所有 Pulsar Java 客户端 < 3.0.7/3.3.2**） | 3.0.7 / 3.3.2 | Avro Java SDK 1.11.3 及以下 Schema 解析可执行任意代码；升级 Avro ≥1.11.4；Java 客户端务必同步升级 |
| CVE-2025-30677 Kafka 连接器明文记录敏感配置 | 6.3 M | 3.0.0–3.0.10、3.1.0–3.3.5 | 3.0.11 / 3.3.6 | Kafka Source/Sink 明文凭据进日志；升级后清理历史日志并轮换凭据 |
| CVE-2024-29834 Namespace/Topic 管理端点授权不当 | 6.4 M | 3.0.0–3.0.3、3.1.0–3.1.3、3.2.0–3.2.1 | 3.0.4 / 3.2.2 | produce/consume 权限即可 unload/compaction、跨租户改属性；无配置级缓解，只能升级 |
| CVE-2024-28098 Topic 级策略管理授权不当 | 6.4 M | 3.0.0–3.0.2、3.1.0–3.1.2、3.2.0 | 3.0.3 / 3.1.3 / 3.2.1 | produce/consume 权限即可改 retention/TTL/offload 策略 |

> CVE-2023-31007（凭据过期不断开连接）只影响 2.x，3.0+ 不受影响。
>
> **2026 依赖库 CVE（非 Pulsar 自身逻辑，但需最新 patch 兜底）**：3.0.17（2026-04-27）修复 CVE-2026-5588 / CVE-2026-0636（BouncyCastle）、CVE-2026-40490（async-http-client）等依赖漏洞；3.0.16 升级 Netty 4.1.130（#25078）。这些再一次说明「3.x 应锁定分支最新 patch」而非停留在修复 Pulsar 自身 CVE 的最低版本。

## 2. 高危可靠性 Bug（非 CVE，重灾区：消息丢失/卡死）

| Bug | 现象 | 修复版本 |
|---|---|---|
| Topic compaction 丢消息 (#20980) | 压缩过程消息丢失 | 3.0.2 / 3.1.1 / 3.2.0 |
| 消息过期 + compaction/复制并发丢数据 (#21865) | TTL 过期与压缩/复制竞态丢消息 | 3.1.3 / 3.2.1 / 3.3.0 |
| Geo-Replication + dedup 丢消息 (#23697) | 开 dedup 的异地复制丢消息/频繁失败 | 3.0.11 / 3.3.5 |
| 多 schema 版本 auto_produce 内存泄漏+丢消息 (#24178) | broker 泄漏、丢消息、复制状态错乱 | 3.0.12 / 3.3.7 |
| chunked 大消息无可用消费者时丢失 (#25077) | 分块消息丢失 | 3.0.16 |
| ML PayloadProcessor 失败丢消息/乱序 (#24522) | 存储层处理失败时丢序 | 3.0.13 / 3.3.8 |
| compaction 与 topic 删除/txn 快照并发死锁 (#24366/#24401) | broker 卡死 | 3.0.13 / 3.3.8 |
| 非恢复性 ledger 跳过死锁 (#21915) | topic 加载/消费卡死 | 3.0.3 / 3.1.3 / 3.2.0 |
| compaction 内存泄漏 (#21647) | broker 堆内泄漏 | 3.0.3 / 3.1.3 / 3.2.0 |
| Key_Shared 消费卡死 (#23795/#23802) | recentlyJoinedConsumers 乱序 | 3.0.9 / 3.3.4 |
| 大 backlog 消费停滞 (#22454) | consumer 停止收消息 | 3.2.3 / 3.3.0 |
| 孤儿 topic 策略/schema 元数据 (#24150) | 自动删 topic 后 metadata 残留 | 3.0.12 / 3.3.7 |

## 3. 版本现状与升级建议（截至 2026-10）

| 分支 | 最新 patch | 状态 |
|---|---|---|
| 3.0.x | 3.0.17 | 仍在维护 |
| 3.1.x | 3.1.3（终版） | 已停止，用户须迁 3.2/3.3 |
| 3.2.x | 3.2.4 | 3.2.4 后无新 patch |
| 3.3.x | 3.3.9 | 3.x 在维护的最新分支（无 3.4，版本线跳至 4.0） |
| 4.x / 5.x | 4.0.14 / 4.2.5 / 5.0.0 | 新特性线 |

**升级底线**：任何 3.x 部署至少 ≥ 3.0.11 / 3.2.2（覆盖全部上表 CVE 与主要丢消息 bug）；推荐直接到分支最新 patch（3.0.17 / 3.3.9）。

## 4. 生产防护建议

1. **Functions Worker 是最高风险面**（3 个 8.x+ CVE）：不使用 Functions 则关闭 `functionsWorkerEnabled`；使用则必须 ≥3.0.3/3.1.3/3.2.1、独立部署并网络隔离、限制可创建 function 的角色，URL 引用仅按白名单放开。
2. **Proxy / WebSocket Proxy 永不直接暴露公网**，置于 LB/防火墙后；3.0.x 需 ≥3.0.2 修复 /proxy-stats。
3. **SASL 用户**：升级到修复版后务必轮换 `saslJaasServerRoleTokenSignerSecretPath` 密钥。
4. **授权加固**：默认 Provider 下 produce/consume 角色不应能触达管理 API（CVE-2024-29834/28098 修复前无配置缓解，只能升级）；生产开启 `authenticationEnabled` + `authorizationEnabled`，并显式配置 `superUserRoles`。
5. **Kafka 连接器用户**：升 ≥3.0.11/3.3.6，清理含明文凭据的历史日志，轮换 Kafka 凭据。
6. **Avro/Schema 用户（全量 Java 客户端）**：升 ≥3.0.7/3.3.2 修复 CVE-2024-47561（Avro RCE）；所有 Pulsar Java 客户端需 ≥3.0.7/3.3.2（依赖 Avro 1.11.4）。
7. **可靠性场景重点回归**：compaction、TTL 过期、Geo-Replication + dedup、多 schema 版本、chunked 大消息——以上是 3.x 丢消息 bug 集中区；相关功能上线前针对所打 patch 版本做专项压测。
8. **监控兜底**：订阅积压突变（可能丢消息/消费停滞）、broker 堆内存持续增长（泄漏类 bug）、Netty 泄漏检测开启、ZK 会话与 bundle 迁移频率。
9. **版本节奏**：3.x 建议锁定 branch-3.3 最新 patch；升级前比对 release notes，逐项回查《03/07》配置清单默认值。

## 5. 本次文档审校同步修正记录（对照 branch-3.3 官方 conf）

- `delayedDeliveryEnabled` 3.x 分发默认 **true**（03/04/07 原误写 false）
- `delayedDeliveryMaxDelayInMillis` 默认 **0（无上限）**（03/07 原误写 1h）
- `retentionCheckIntervalInSeconds` 默认 **120**（03/07 原误写 600）
- `brokerDeleteInactiveTopicsEnabled` 3.x 默认 **true**（原误写 false）
- `subscriptionKeySharedUseConsistentHashing` 3.x 分发 conf 为 **true**（代码默认 false）
- `backlogQuotaDefaultLimitGB` 在 broker.conf 已改名 **`backlogQuotaDefaultLimitBytes`**；standalone.conf 仍保留旧名 `backlogQuotaDefaultLimitGB=10`
- `loadBalancerNamespaceBundleMaxMsgRate/MaxBandwidthMbytes` 3.x 默认 **30000/100**（原误用 2.x 的 1000/1000000）
- Broker 参数名：`maxClientsPerHost` → **`brokerMaxConnectionsPerIp`**；`replicatedSubscriptionsEnabled` → **`enableReplicatedSubscriptions`**
- BookKeeper：`journalBufferedWritesThreshold=524288`、**`flushInterval=60000`**（原误写 10000）、**`dbStorage_readAheadCacheBatchSize=1000`**（原误写 100）、**`gcWaitTime=900000`**（原误写 1000，standalone 为 300000）、`auditorPeriodicBookieCheckInterval=86400`、`ledgerStorageClass=DbLedgerStorage`
- BookKeeper 磁盘水位（3.3 默认）：`diskUsageThreshold=0.95`、**`diskUsageWarnThreshold=0.90`**（原误写 0.95）、**`diskUsageLwmThreshold=0.95`**（原误写 0.90，默认与 Threshold 相同）
- standalone.conf 中 E/Qw/Qa 默认 **1/1/1**；内嵌 bookie `journalSyncData=false`、`diskUsageThreshold=0.99`、`diskUsageWarnThreshold=0.99`（勿照搬生产）；`loadBalancerEnabled=false`（standalone 默认已关）
- 3.x `configurationStoreServers` 非必填（新参数 metadataStoreUrl/configurationMetadataStoreUrl，为空回退本地元数据）；官方带宽水位参数名拼作 `loadBalancerBandwithInResourceWeight/OutResourceWeight`
