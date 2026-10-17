# Pulsar 单体（Standalone）配置清单

> 对应 `conf/standalone.conf`（内嵌 Broker + Bookie + ZK 单进程）。适用开发、测试、演示环境。默认值以 branch-3.3 为准。
> 单体和集群共享大部分 broker 参数，本节只列差异与常用项；完整解释见《03-集群配置清单》。

## 目录

- [1. 启动方式](#1-启动方式)
- [2. 基础配置项](#2-基础配置项)
- [3. 消息与托管 Ledger（常用）](#3-消息与托管-ledger常用)
- [4. Topic / 自动化](#4-topic--自动化)
- [5. Functions Worker（单体内置）](#5-functions-worker单体内置)
- [6. 安全（默认关闭）](#6-安全默认关闭)
- [7. 内嵌组件数据目录](#7-内嵌组件数据目录)
- [8. 负载均衡（单体默认已关）](#8-负载均衡单体默认已关)
- [9. JVM](#9-jvm)
- [10. 典型开发配置片段](#10-典型开发配置片段)
- [11. 单体 vs 集群差异要点](#11-单体-vs-集群差异要点)

## 1. 启动方式

```bash
bin/pulsar standalone          # 前台，默认 public/default 租户
bin/pulsar standalone -nfw     # 仅本地功能（禁 functions_worker）
bin/pulsar standalone --wipe-data   # 清空 data/ 后启动
bin/pulsar standalone -a 0.0.0.0    # 监听所有网卡（容器/远程访问）
```

- 端口：6650（二进制）、8080（HTTP Admin），自动启动内嵌 ZK（2181）与 Bookie（3181）。
- 数据目录：`data/`（zookeeper、bookkeeper、standalone）。

## 2. 基础配置项

| 参数 | 默认值 | 作用/介绍 | 影响 | 建议值（开发） |
|---|---|---|---|---|
| clusterName | standalone | 集群名 | 单体固定 | standalone |
| metadataStoreUrl / configurationMetadataStoreUrl | （空，内嵌） | 单体不填，内部连接本地 ZK | — | 留空 |
| brokerServicePort / brokerServicePortTls | 6650 / 6651 | 二进制端口 | — | 默认 |
| webServicePort / webServicePortTls | 8080 / 8443 | HTTP Admin 端口 | — | 默认 |
| advertisedAddress | （空） | 【调】通告地址 | 远程访问时设为宿主机 IP | 本机调试留空；容器/远程设 IP |
| bindAddress | 0.0.0.0 | 监听地址 | 远程访问需非 127.0.0.1 | 默认 |

## 3. 消息与托管 Ledger（常用）

| 参数 | 默认值 | 作用/介绍 | 影响 | 建议值（开发） |
|---|---|---|---|---|
| maxMessageSize | 5242880 | 单条最大 5MB | 超限被拒 | 默认 |
| managedLedgerDefaultEnsembleSize | 1 | 副本放置组 | 单 bookie 只能 1 | 1 |
| managedLedgerDefaultWriteQuorum | 1 | 写入副本数 | 单副本 | 1 |
| managedLedgerDefaultAckQuorum | 1 | 确认副本数 | 单副本 | 1 |
| managedLedgerDefaultMarkDeleteRateLimit | 0.1 | ack 游标落盘速率 | **默认 0.1**（旧稿误写 1.0） | 保持 |
| defaultRetentionTimeInMinutes / SizeInMB | 0 | 保留策略 | 0=按订阅保留 | 默认 |
| backlogQuotaDefaultLimitGB | 10 | 积压上限 | **standalone 保留旧参数名 `backlogQuotaDefaultLimitGB=10`**（broker.conf 已改 bytes；勿混用） | 默认 10GB |
| backlogQuotaDefaultRetentionPolicy | producer_request_hold | 触顶策略 | 积压保护 | 默认 |
| ttlDurationDefaultInSeconds | 0 | 消息 TTL | 0=不做 TTL | 默认 |
| delayedDeliveryEnabled | true | 延迟消息 | 3.x 单体默认开 | 默认 |
| maxUnackedMessagesPerConsumer / Subscription | 50000 / 200000 | 未 ack 上限 | 保护 | 默认 |

## 4. Topic / 自动化

| 参数 | 默认值 | 作用/介绍 | 影响 | 建议值（开发） |
|---|---|---|---|---|
| allowAutoTopicCreation | true | 自动建 topic | 开发便利 | true |
| allowAutoTopicCreationType | non-partitioned | 自动建类型 | — | non-partitioned |
| defaultNumPartitions | 1 | 自动分区 topic 分区数 | — | 1 |
| allowAutoSubscriptionCreation | true | 自动建订阅 | 开发便利 | true |
| brokerDeleteInactiveTopicsEnabled | true | 自动清理不活跃 topic | 注意与长期空闲 topic 冲突 | 开发可关或配长周期 |
| brokerDeleteInactiveTopicsMaxInactiveDurationSeconds | （空） | 不活跃判定时长 | 保护长空闲 topic | 需保留时设长 |
| defaultTopicCompactionThreshold | 0 | 压缩阈值 | 0=不触发 | 默认 |
| schemaValidationEnforced | false | 强制 schema 校验 | 开发一般关 | false |

## 5. Functions Worker（单体内置）

| 参数 | 默认值 | 作用/介绍 | 影响 | 建议值（开发） |
|---|---|---|---|---|
| functionsWorkerEnabled | false | 【调】开启后可运行 Functions/IO | 开启会启动额外进程 | 需要 Functions 时 true |
| numFunctionPackageReplicas | 1 | 包副本数 | 单体保持 1 | 1 |
| functionsWorkerPort | 6750 | worker 端口 | Functions 接入 | 6750 |

> 只用消息收发、不用 Functions/IO 时保持关闭，可降低资源占用并缩小攻击面（见《08》Functions Worker CVE）。

## 6. 安全（默认关闭）

| 参数 | 默认值 | 作用/介绍 | 影响 | 建议值（开发） |
|---|---|---|---|---|
| authenticationEnabled | false | 认证 | 单体常关闭 | false（本地调试） |
| authorizationEnabled | false | 授权 | 同上 | false |
| tlsEnabled | false | TLS | 本地调试可不开 | false |
| superUserRoles | （空） | 超级角色 | 开认证时必配 | 按需 |

## 7. 内嵌组件数据目录

| 参数 | 默认值 | 作用/介绍 | 影响 | 建议 |
|---|---|---|---|---|
| zookeeper dataDir | data/zookeeper | 单体由内嵌 ZK 使用 | 快照/日志 | data/zookeeper |
| bookie journal | data/bookkeeper/journal | 单体复用 bookkeeper.conf | — | data/bookkeeper/journal |
| bookie ledgers | data/bookkeeper/ledgers | 同上 | — | data/bookkeeper/ledgers |
| bookiePort | 3181 | 与 ZK 分开的独立端口 | 端口冲突检查 | 3181 |

> 单体模式同时读取 `standalone.conf`（Broker 部分）与 `bookkeeper.conf`（Bookie 部分），修改 bookie 行为要改后者。
> **注意 standalone 专属差异**（为易用性牺牲持久化/保护，**切勿照搬到生产集群**）：内嵌 bookie `journalSyncData=false`、`diskUsageThreshold=0.99`、`diskUsageWarnThreshold=0.99`、`gcWaitTime=300000`、`flushInterval=60000`。

## 8. 负载均衡（单体默认已关）

| 参数 | 默认值 | 作用/介绍 | 影响 | 建议值（开发） |
|---|---|---|---|---|
| loadBalancerEnabled | false | 负载均衡 | **standalone 默认即 false**（旧稿误写 true）；单机本无意义 | false |
| loadManagerClassName | ...NoopLoadManager | 单体用 Noop | 不做均衡 | 保持 |

## 9. JVM（conf/pulsar_env.sh）

```bash
# 开发环境示例
PULSAR_MEM="-Xms1g -Xmx1g -XX:MaxDirectMemorySize=1g"
```

## 10. 典型开发配置片段

```properties
# 远程可访问 + 单副本 + 延迟消息
advertisedAddress=192.168.1.10
managedLedgerDefaultEnsembleSize=1
managedLedgerDefaultWriteQuorum=1
managedLedgerDefaultAckQuorum=1
delayedDeliveryEnabled=true
loadBalancerEnabled=false
```

## 11. 单体 vs 集群差异要点

| 维度 | 单体 | 集群 |
|---|---|---|
| 进程 | 1 个进程含 ZK+Bookie+Broker | 分离部署，多节点 |
| 副本 | E/Qw/Qa 实际为 1 | 按容错需求 ≥3 |
| 配置文件 | standalone.conf | broker.conf / bookkeeper.conf / zookeeper.conf / proxy.conf |
| 可用性 | 无 HA | Bookie 容错、Broker 无状态可扩展 |
| 适用 | 开发/测试/演示 | 生产 |
