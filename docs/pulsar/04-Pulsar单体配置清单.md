# Pulsar 单体（Standalone）配置清单

> 对应 `conf/standalone.conf`（内嵌 Broker + Bookie + ZK 单进程）。适用开发、测试、演示环境。默认值以 branch-3.3 为准。
> 单体和集群共享大部分 broker 参数，本节只列差异与常用项；完整解释见《03-集群配置清单》（新手概念解释见《03》§6）。
> **新手请按顺序读**：§1 启动 → §12 动手演练 → 遇到「和文档不一样」再回来看 §11 差异表。

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
- [12. 动手演练：单机跑通第一条消息](#12-动手演练单机跑通第一条消息)

## 1. 启动方式

前置条件只有一个：**JDK 17**（3.x 强制；`java -version` 确认）。把发行包解压后：

```bash
bin/pulsar standalone          # 前台，默认 public/default 租户
bin/pulsar standalone -nfw     # 仅本地功能（禁 functions_worker）
bin/pulsar standalone --wipe-data   # 清空 data/ 后启动
bin/pulsar standalone -a 0.0.0.0    # 监听所有网卡（容器/远程访问）
```

- 端口：6650（二进制）、8080（HTTP Admin），自动启动内嵌 ZK（2181）与 Bookie（3181）。
- 数据目录：`data/`（zookeeper、bookkeeper、standalone）。
- **第一次启动会做什么**：格式化内嵌 ZK、初始化集群元数据（clusterName=standalone）、建 `public/default` 与 `public/functions` 命名空间、起内嵌 Bookie。日志走到 `messaging service is ready` 才算起完，此时 `curl http://localhost:8080/admin/v2/clusters` 应返回 `["standalone"]`——用这条 curl 判「起没起好」比看日志关键字可靠。
- **Windows 用户**：官方发行包在 Windows 上跑得起来但不受支持（脚本是 bash），推荐用 Docker：`docker run -it --rm -p 8080:8080 -p 6650:6650 apachepulsar/pulsar:3.3.9 bin/pulsar standalone`。

## 2. 基础配置项

| 参数 | 默认值 | 作用/介绍 | 影响 | 建议值（开发） |
|---|---|---|---|---|
| clusterName | standalone | 集群名 | 单体固定 | standalone |
| metadataStoreUrl / configurationMetadataStoreUrl | （空，内嵌） | 单体不填，内部连接本地 ZK | — | 留空 |
| brokerServicePort / brokerServicePortTls | 6650 / （空） | 二进制端口 | 启用 TLS 时显式设 6651 | 默认 |
| webServicePort / webServicePortTls | 8080 / （空） | HTTP Admin 端口 | 启用 TLS 时显式设 8443 | 默认 |
| advertisedAddress | （空） | 【调】通告地址 | 远程访问时设为宿主机 IP | 本机调试留空；容器/远程设 IP |
| bindAddress | 0.0.0.0 | 监听地址 | 远程访问需非 127.0.0.1 | 默认 |

## 3. 消息与托管 Ledger（常用）

| 参数 | 默认值 | 作用/介绍 | 影响 | 建议值（开发） |
|---|---|---|---|---|
| maxMessageSize | 5242880 | 单条最大 5MB | 超限被拒 | 默认 |
| managedLedgerDefaultEnsembleSize | 1 | 副本放置组 | 单 bookie 只能 1 | 1 |
| managedLedgerDefaultWriteQuorum | 1 | 写入副本数 | 单副本 | 1 |
| managedLedgerDefaultAckQuorum | 1 | 确认副本数 | 单副本 | 1 |
| managedLedgerDefaultMarkDeleteRateLimit | 0.1 | ack 游标落盘速率 | **standalone.conf 是 0.1，broker.conf 是 1.0**（两份文件默认不同，别互相照搬） | 保持 |
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
| brokerServiceCompactionThresholdInBytes | 0 | 压缩触发阈值（字节） | 0=不自动触发 | 默认 |
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
> **关于「standalone 放宽了持久化参数」这个说法**：branch-3.3 的 `PulsarStandalone` 是直接 `loadConf(bookkeeper.conf)` 起内嵌 Bookie 的，代码里只额外按直接内存自动计算 `dbStorage_writeCacheMaxSizeMb` / `dbStorage_readAheadCacheMaxSizeMb`，**并没有**把 `journalSyncData` 改成 false 或把磁盘水位放宽到 0.99（旧稿那组「standalone 专属值」不成立，已删）。也就是说：单体里 Bookie 的持久化行为与集群一样由 `bookkeeper.conf` 决定——真正的单体差异只在 broker 侧（E/Qw/Qa=1/1/1、`backlogQuotaDefaultLimitGB=10`、`loadBalancerEnabled=false` + NoopLoadManager）。
> 单点风险来自 **E=Qw=Qa=1**：只有一份副本，Bookie 数据目录损坏即丢数据。这才是「单体不能上生产」的根因，而不是某个 fsync 开关。

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

## 12. 动手演练：单机跑通第一条消息

> 全程约 5 分钟。每一步都注明「这一步在验证什么」，失败时对照 §12.4 排查，不要跳步。
> 命令都在发行包根目录执行；`bin/pulsar-admin` 默认从 `conf/admin.conf` 读 `http://localhost:8080`，单体不用额外传 `--admin-url`。

### 12.1 起服务并确认三件事

```bash
bin/pulsar standalone
```

另开一个终端，逐项确认：

```bash
# ① 集群元数据里有 standalone 这个 cluster
bin/pulsar-admin clusters list                       # 期望：standalone

# ② broker 自认为健康（会检查它能不能连元数据与 BookKeeper）
bin/pulsar-admin brokers healthcheck                 # 期望：No unhealthy brokers found

# ③ 租户/命名空间默认已经建好
bin/pulsar-admin namespaces list public              # 期望：public/default、public/functions
```

三条全对，说明 ZK、Bookie、Broker 三层都通了；后面再出错就基本是「用法」问题而不是「部署」问题。

### 12.2 建自己的租户与命名空间（别用 public/default 练手）

```bash
bin/pulsar-admin tenants create demo --allowed-clusters standalone
bin/pulsar-admin namespaces create demo/ns1
# 保留 3 天：这样消费完的消息还能回放（概念解释见《03》§6.2）
bin/pulsar-admin namespaces set-retention demo/ns1 --size 1G --time 3d
bin/pulsar-admin namespaces get-retention demo/ns1   # 回读确认，别改完就走
```

为什么要自己建：`public/default` 是所有客户端的公共地盘，保留策略、配额、权限都在上面，练手时改坏了会影响别人；养成「先租户后命名空间」的习惯，到生产就是同一套动作。

### 12.3 收发消息的四条命令

```bash
# 生产 3 条（topic 名三段式：persistent://租户/命名空间/主题）
bin/pulsar-client produce persistent://demo/ns1/orders -m "hello-pulsar" -n 3

# 起一个订阅消费 3 条（-n 是「取几条」，不是条数上限；-s 是订阅名）
bin/pulsar-client consume persistent://demo/ns1/orders -s my-sub -n 3 -p Earliest -t Exclusive

# 看统计：backlog、游标位置、订阅列表都在这里
bin/pulsar-admin topics stats persistent://demo/ns1/orders

# 回到最早重放一次（依赖 §12.2 配的 retention，否则没数据可回放）
bin/pulsar-admin topics reset-cursor --help          # 先看当前版本的定位参数写法
bin/pulsar-admin topics reset-cursor persistent://demo/ns1/orders -s my-sub  # 再加时间/消息 ID 选项
```

新手最容易混的两点：

- **`-n 3` 在 produce 与 consume 里含义不同**：produce 是「重复发 3 条」，consume 是「收 3 条后退出」。想常驻消费用 `-n 0`。
- **订阅名是状态的一部分**：换个 `-s` 就等于新建一个订阅，游标从零开始，会看到全部保留中的消息；不是「换个客户端」。
- `reset-cursor` 的参数在各版本间有调整，**用之前先 `bin/pulsar-admin topics reset-cursor --help`**，按提示选时间/消息 ID 模式；本文不固化写法以免版本间对不上。

### 12.4 常见报错与真实原因

| 现象 | 真实原因 | 处理 |
|---|---|---|
| `UnsupportedClassVersionError` / 启动即退出 | JDK 不是 17（3.x 强制） | `java -version` 核对，切到 17 |
| 端口占用：`Address already in use` | 上一次 standalone 没退干净，或 2181/3181/6650/8080 被别的服务占 | 杀掉残留进程；`--wipe-data` 重来 |
| 客户端连得上 8080 但收发报 `Connection refused` | broker 通告的地址是容器内网名/127.0.0.1，客户端拿到后连不上（6650 才是数据口） | 设 `advertisedAddress=<宿主机 IP>` 并用 `-a 0.0.0.0` 重启 |
| `TopicNotFound` | topic 名三段式写错（租户/命名空间少一段或用了 `private://`） | 完整写 `persistent://demo/ns1/orders`；或确认 `allowAutoTopicCreation=true` |
| consume 立刻退出、一条没收到 | 订阅是新建的、消息已被旧订阅 ack 掉，或 `-p` 用了 `Latest` | 加 `-p Earliest`；或先 `topics stats` 看 backlog 是否为 0 |
| 改了 `standalone.conf` 里 bookie 的参数没反应 | Bookie 读的是 `bookkeeper.conf`（见 §7） | 改对文件再重启 |
| 重启后 data 目录越占越大 | 单副本 + retention 拉长 + 从没消费过的订阅拖住游标 | `topics list` + `topics stats` 找 `backlog` 大的订阅，`unsubscribe` 清掉 |
