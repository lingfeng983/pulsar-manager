# Pulsar 集群调优与架构选型指南

> 覆盖性能调优、架构设计原则与场景选型建议。配合《02-集群部署说明书》《03-集群配置清单》使用。
> 默认值以 branch-3.3 为准；参数名/默认值已按官方 conf 核对。

## 目录

- [1. 性能调优总览](#1-性能调优总览)
- [2. Broker 调优](#2-broker-调优)
- [3. BookKeeper 存储调优](#3-bookkeeper-存储调优)
- [4. ZooKeeper 与操作系统调优](#4-zookeeper-与操作系统调优)
- [5. 容量规划](#5-容量规划)
- [6. 架构设计原则](#6-架构设计原则)
- [7. 场景选型指导](#7-场景选型指导)
- [8. 常见性能问题排查](#8-常见性能问题排查)

## 1. 性能调优总览

### 1.1 调优层次（自上而下）

| 层次 | 关注点 | 主要手段 |
|---|---|---|
| 业务/客户端 | 批量、异步、消息大小 | batching、压缩、分区数 |
| Broker | CPU、内存、bundle 分布 | JVM、缓存、负载均衡参数 |
| BookKeeper | 磁盘 I/O、fsync | Journal 盘、组提交、Entry Log |
| OS/硬件 | 内核参数、磁盘调度 | 文件系统、ulimit、swap |
| 网络 | 带宽、RTT | 万兆网卡、跨机房延迟 |

**原则**：先测量再调优。基线用 `pulsar-perf` 或 OpenMessaging Benchmark 建立，抓 Prometheus 指标定位瓶颈，逐层收敛。**每次只改一项参数**，对照基线判断。

### 1.2 关键指标基线（参考）

- 端到端延迟（p99）：同机房 < 10ms（持久化、Qa=2）
- 单 Broker 吞吐：约 1~5 万 msg/s（小消息）或受限于网卡带宽
- Bookie 写延迟 p99：Journal 盘决定，NVMe 通常 < 2ms

## 2. Broker 调优

### 2.1 JVM

```bash
# 大内存场景：堆不宜过大，Broker 重在堆外（直接内存）
PULSAR_MEM="-Xms8g -Xmx8g -XX:MaxDirectMemorySize=8g"
PULSAR_GC="-XX:+UseG1GC -XX:MaxGCPauseMillis=10"
```

- 堆与直接内存各半起步，按 GC 日志与 `NettyDirectMemory` 使用率调整；-Xms=-Xmx 避免动态扩容抖动。
- 观察 `jvm_gc_*` 指标；长停顿优先怀疑堆过大或 G1 region 不当。

**连接与 IO 线程（高连接数场景关注）**：

| 参数 | 默认值 | 作用/影响 | 建议值 |
|---|---|---|---|
| numIOThreads | 2×CPU | Netty IO 线程 | 默认即可；CPU 核数少可下调 |
| numOrderedExecutorThreads | 8 | ZK/元数据操作线程 | 默认 |
| numHttpServerThreads | 2×CPU | HTTP Admin 线程 | 默认 |
| bookkeeperClientNumWorkerThreads | =CPU | BK 客户端工作线程 | 默认 |
| maxConcurrentTopicLoadRequest | 5000 | topic 加载并发 | 大 topic 集群可调大 |

> 高连接数/高并发 topic 场景，IO 线程与 BK 客户端线程若不足会成为吞吐瓶颈，观察 `NettyEventLoopUtil` 与 `bookkeeper_client_*` 指标判断。

### 2.2 托管 Ledger 缓存

| 参数 | 作用 | 影响 | 建议值 |
|---|---|---|---|
| managedLedgerCacheSizeMB | 页缓存大小（直接内存） | 默认堆外 1/5；读多写少或热 topic 调大，过小增加读 bookie | 直接内存富余时显式设大 |
| managedLedgerCacheEvictionWatermark | 缓存驱逐水位 | 0.9 → 0.95 提利用率，代价是更易触发回压 | 0.9（默认） |
| managedLedgerNewEntriesCheckDelayInMillis | 追尾读检查延迟 | 调小（1~5ms）降追尾延迟，调大提吞吐 | 延迟敏感 1~5 |

### 2.3 副本与写入参数

- 生产推荐 `E=Qw=3, Qa=2`：容忍单 bookie 故障且写入延迟取决于最快的 2 个。
- 延迟敏感且容忍丢少量数据：`E=Qw=2, Qa=1` 或非持久化 topic。
- `managedLedgerMaxEntriesPerLedger` 减小（如 10000）→ ledger 滚动更快、恢复更快，但增加 ZK 元数据压力。
- `managedLedgerDefaultMarkDeleteRateLimit`：提高 ack 落盘速率（如 10）可加快游标推进，代价是更多 ZK/bookkeeper 写。

### 2.4 负载均衡

- `loadBalancerBrokerOverloadedThresholdPercentage`：85 → 80 可提前卸载，减少过载抖动。
- bundle 数：`defaultNumberOfNamespaceBundles` 太少导致倾斜，太多增加 ZK 压力；经验值 = 每 broker 期望承载 topic 组数的 3~5 倍。
- 单 bundle 流量大时（`loadBalancerNamespaceBundleMaxMsgRate=30000` 触发），考虑分区 topic 分摊。

### 2.5 客户端配合（对吞吐影响最大）

- `batchingEnabled=true` + `batchingMaxMessages/MaxBytes`：小消息吞吐可提升数倍。
- 压缩 ZSTD/LZ4：CPU 换带宽。
- Producer/Consumer 数量与分区数匹配；`maxUnackedMessagesPerConsumer` 按消费能力调整。

## 3. BookKeeper 存储调优

### 3.1 磁盘布局（最重要）

| 盘 | 用途 | 要求 |
|---|---|---|
| Journal ×2（RAID1） | 顺序写、fsync | NVMe SSD，决定写延迟上限 |
| Ledger（可多盘） | Entry Log 读写 | SSD 优先；归档/冷读场景可 HDD |
| Index（可独立盘） | 索引随机读写 | SSD |

**Journal 与 Ledger 必须分盘**，否则 fsync 会干扰读 I/O。

### 3.2 写路径

| 参数 | 作用 | 影响 | 建议值 |
|---|---|---|---|
| journalSyncData | 写前 fsync | 默认 true（安全）；超高吞吐测试场景才考虑 false | true |
| journalAdaptiveGroupWrites / journalBufferedWritesThreshold | 组提交 | 提吞吐；低延迟场景调小阈值 | 默认 |
| journalFlushWhenQueueEmpty | 空闲立即刷盘 | 追尾延迟敏感可开 | false |
| journalMaxSizeMB | 单 journal 文件大小 | 默认 2048；单盘容量与滚动时间权衡 | 2048 |
| journalFormatVersionToWrite | journal 格式版本 | 3.3 默认 5；升级时注意兼容 | 保持默认 |

### 3.3 读路径与 GC

- `dbStorage_readAheadCacheBatchSize`（**默认 1000**，DbLedgerStorage 前缀）：回溯读多则调大。
- `compaction*`：Entry Log 大压缩 `majorCompactionThreshold=0.8`；删除频繁场景（TTL 短）可调小阈值提高空间利用率。
- **磁盘水位（3.3 默认）**：`diskUsageThreshold=0.95`（只读）、`diskUsageWarnThreshold=0.90`（暂停 major compaction）、`diskUsageLwmThreshold=0.95`（低于恢复读写，与 Threshold 同默认）。建议给 Threshold 与 Lwm 留回差（如 0.95/0.90）防止在只读-读写间抖动。
- `gcWaitTime`（**默认 900000ms=15 分钟**）：磁盘紧张时可配合 `isForceGCAllowWhenNoSpace` 兜底。

### 3.4 JVM

```bash
BOOKIE_MEM="-Xms16g -Xmx16g -XX:MaxDirectMemorySize=16g"
```

Bookie 大量使用堆外与 PageCache；-Xms=-Xmx 避免动态扩容抖动，剩余物理内存留给 PageCache。

### 3.5 集群拓扑

- 至少 3 个 bookie（E=3 要求）；生产建议 ≥4 以便滚动维护。
- 跨机架感知：`bookieRackAwarenessEnabled` 等放置策略，避免同机架副本同时丢失。
- `lostBookieRecoveryDelay`：设为非 0（如 300s）避免瞬时故障触发大规模重复制。

## 4. ZooKeeper 与操作系统调优

### 4.1 ZooKeeper

- ZK 只存元数据，但 bundle/topic 数量大时仍是热点：单集群 topic 数十万级时关注 ZK znode 数与延迟。
- `autopurge.snapRetainCount=3, autopurge.purgeInterval=24` 开启自动清理。
- 配置存储 ZK 多集群共享时，跨机房 RTT 会影响 namespace 变更传播，可独立部署并就近访问。

### 4.2 操作系统（所有节点）

```bash
# 文件句柄
ulimit -n 1048576
# swap
swapoff -a                          # Bookie/Broker 节点禁用
vm.swappiness = 1
# 网络缓冲（大流量/跨机房）
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
# 磁盘调度器：NVMe 用 none，SSD 用 none/mq-deadline
cat /sys/block/nvme0n1/queue/scheduler
# 文件系统：XFS（data=ordered），挂载 noatime
# 时钟同步：chrony，偏差 < 10ms
```

- JDK 17 + 大页可选：`-XX:+AlwaysPreTouch` 避免运行期缺页（内存充足时）。

## 5. 容量规划

### 5.1 磁盘容量估算

```
每消息落盘字节 ≈ entry 头(~30B) + 消息体 + 元数据
日写入量 = 吞吐(msg/s) × 平均消息大小 × 86400 × 副本数(Qw)
集群磁盘需求 = 日写入量 × 保留天数 / 可用水位(0.9) × Entry Log 放大系数(~1.2)
```

> 注意：公式里的“可用水位”除以的是可用占比（如 0.9），**不是 (1-水位)**——除以 0.9 即预留约 11% 余量，避免磁盘打满触发只读。若写成 `/ (1-0.9)` 会得到 ×10 的错误结果。

示例：1 万 msg/s × 1KB × 3 副本 × 保留 7 天 ≈ 18TB 原始数据 → 18 / 0.9 × 1.2 ≈ 24TB，规划约 25TB 可用空间。

### 5.2 节点数量估算

- Bookie 数：满足 Qw 副本下的写入吞吐（单 bookie Journal 顺序写约 100~300MB/s NVMe），并留 30% 余量。
- Broker 数：单 broker 经验 1~5 万 msg/s（小消息），按峰值吞吐 / 3 取整并加 1 台冗余。
- 内存：Broker 节点每 100 万未消费 backlogged 消息约需额外缓存；Bookie 节点堆外+PageCache 至少覆盖热数据集。

### 5.3 分层存储削减成本

- 冷数据（>某天数）卸载至 S3/OSS：`managedLedgerOffloadAutoTriggerSizeThresholdBytes` + offloader 配置。
- 适合：长保留、回溯读低频场景，可将 Bookie 集群容量需求降低 60%~90%。

## 6. 架构设计原则

### 6.1 计算存储分离（Pulsar 核心优势）

- Broker 无状态：扩容、故障转移对消息数据零迁移（bundle 二次分配即可）。
- Bookie 独立扩容：容量不足加 bookie，计算不足加 broker，互不耦合。
- 设计推论：**Broker 与 Bookie 分机部署**是生产默认；混合部署仅适合小规模/测试。

### 6.2 分层与隔离

| 隔离维度 | 手段 |
|---|---|
| 业务/团队 | Tenant + Namespace，独立配额与 ACL |
| 关键程度 | Namespace 级 `replication` / quota / broker 资源隔离（bundle 隔离策略） |
| 负载类型 | 追尾读 vs 回溯读：分层存储 + 独立 Bookie 集群（按 `bookieNamespace` 分池） |
| 多场景 | Functions/IO Worker 与 Broker 隔离部署，避免计算干扰消息链路 |

### 6.3 接入层设计

- 生产/云环境统一走 Proxy（或 LB 直连 Broker）：
  - 客户端只需知道接入地址，屏蔽集群拓扑变化。
  - TLS 终结、认证在 Proxy 层统一。
  - `forwardAuthorizationCredentials=true` 透传角色。
- 跨集群：Geo-Replication 按 Tenant/Namespace 启用，双向复制需规划 topic 命名与消费幂等。

### 6.4 可用性目标与拓扑

| 目标 | 拓扑建议 |
|---|---|
| 单机故障无感 | 3 ZK + ≥3 Broker + ≥4 Bookie，E=Qw=3/Qa=2 |
| 机架故障无感 | Bookie 机架感知 + ZK/Broker 跨机架分布 |
| 机房级容灾 | 双集群 Geo-Replication（异步），RPO 取决于复制延迟；同城双活用同步/半同步需评估 RTT |
| 城市/区域容灾 | BookKeeper 跨机房部署（RTT < 5ms 才推荐）或三集群复制 |

### 6.5 演进路径

```
单体（开发）→ 3+3 小集群（测试/小规模生产）
  → Broker/Bookie 分离扩容 → Proxy 接入层 → 分层存储
  → 多集群 Geo-Replication → 协议兼容层（KoP/MoP 等）承接存量业务
```

## 7. 场景选型指导

### 7.1 Pulsar 的定位

强项：百万级 topic、多租户、存算分离弹性扩容、分层存储、跨集群复制、多种订阅模式、协议兼容网关。
代价：组件多（ZK+Bookie+Broker），运维复杂度高于单层消息系统；小规模场景优势不明显。

### 7.2 与常见替代方案对比

| 维度 | Pulsar | Kafka | RabbitMQ | RocketMQ |
|---|---|---|---|---|
| 存储 | BookKeeper 分层，存算分离 | 分区日志绑 broker | 队列模型 | CommitLog |
| topic 规模 | 百万级 | 千~万级（过多分区显著劣化） | 万级队列 | 万级 |
| 多租户 | 原生 Tenant/NS + ACL | 弱（依赖上层） | vhost | 弱 |
| 消息回溯/分层 | 原生（ledger 卸载 S3） | 依赖日志留存/外部 | 不支持 | 有限 |
| 延迟 | 低（毫秒级） | 低 | 极低（微秒级单机） | 低 |
| 运维复杂度 | 较高 | 中 | 低 | 中 |

### 7.3 何时选 Pulsar

- **大规模多租户平台**：一个消息平台服务多个业务线，需要配额、隔离、自助管理 → Pulsar 原生优势。
- **海量 topic + 长保留**：IoT 海量设备主题、事件溯源，需要分层存储控制成本。
- **跨地域复制/容灾**：多机房、多 region 数据同步，Geo-Replication 开箱即用。
- **流处理/批流混合**：Functions + IO + SQL + Transactions 一栈式。
- **需要多种协议**：通过 KoP/AoP/MoP/RoP 兼容存量 Kafka/AMQP/MQTT 客户端，逐步统一平台。
- **混合负载隔离**：追尾 + 回溯读共存，BookKeeper 分池隔离避免相互干扰。

### 7.4 何时不必选 Pulsar

- 单业务、topic 数少、团队小：RabbitMQ / Redis Streams / 小规模 Kafka 更省心。
- 已有成熟 Kafka 生态且无多租户诉求：迁移收益需仔细评估（可先 KoP 混跑）。
- 微秒级单机低延迟 RPC 型通信：消息队列本身不合适。
- 资源极度受限（边缘/嵌入式）：选更轻量的方案。

### 7.5 订阅模式选型速查

| 场景 | 推荐 |
|---|---|
| 单消费者按序处理（订单状态机） | Exclusive / Failover |
| 水平扩展提高吞吐、允许乱序（日志采集） | Shared |
| 扩展且同 key 有序（按用户/会话） | Key_Shared（注意 hash 环迁移） |
| 广播通知 | 每个接收方一个订阅（Fan-out） |
| 失败重试 + 死信 | Shared + Retry/DLQ topic |
| 定时/延迟任务 | delayedDelivery + Delayed Delivery 特性 |

### 7.6 典型架构示例

- **IoT 平台**：设备 MQTT（MoP）→ 按设备 ID 分区的 persistent topic → Key_Shared 下行调度 → 冷数据卸载 OSS。
- **事件溯源/CQRS**：事件 persistent topic（长保留 + Schema Avro）→ Functions 投影到物化视图 topic → Trino SQL 审计。
- **多业务消息中台**：每业务一个 Tenant → Proxy 统一接入 + Token 认证 → 配额与隔离 → Grafana 按 Tenant 展示。

## 8. 常见性能问题排查

### 8.1 排查路线图

```
延迟升高 → 区分生产/消费/端到端
  ├─ 生产延迟高：检查 bookie 写延迟（pulsar_storage_write_latency）、磁盘水位、Qa 副本数
  ├─ 消费积压：消费者存活？maxUnacked 打满？backlog quota 触发 producer_request_hold？
  └─ 端到端抖动：GC 停顿？网络重传？负载均衡搬迁 bundle？
吞吐上不去 → 客户端未开 batching？分区数不足？单 broker 过载（loadManager 指标）？
```

### 8.2 常见问题速查

| 症状 | 常见根因 | 处理 |
|---|---|---|
| 写入延迟 p99 尖刺 | Journal 盘共享、fsync 竞争、GC | Journal 独立 NVMe；查 `bookie_journal_*` 指标 |
| Topic 分配不均 | bundle 过少 | 增大 bundle 数 / 手动 unload |
| 消费者频繁被断开 | `maxUnackedMessagesPerConsumer` 触发、连接数超限 | 调大阈值或提高消费端 ack 频率 |
| Bookie 磁盘只读 | `diskUsageThreshold` 触发 | 扩盘、清理、确认 LWM 恢复水位 |
| Producer 报 TopicTerminated / 配额异常 | backlog quota 策略 producer_request_hold | 清积压或调整配额策略 |
| ZK 会话频繁超时 | GC 长停顿、网络抖动、znode 过多 | 修 GC；检查 RTT；控制 topic/bundle 规模 |
| Geo 复制积压 | 跨集群带宽不足 | `replicationConnectionsPerBroker` 调整 + 专线带宽 |
| 升级后性能下降 | 新 JVM 参数/默认值变化 | 对比 release notes，逐项回查配置清单 |

### 8.3 压测建议

- 使用 OpenMessaging Benchmark（官方支持 Pulsar），先测基线再改参数，每次只改一项。
- 压测矩阵：消息大小（1KB/10KB/100KB）× 订阅模式 × 持久化/非持久化 × 副本数。
- 关注 p99/p999 而非平均值；持续 ≥ 30 分钟观察 GC 与负载均衡的稳态行为。

**`pulsar-perf` 快速基线示例**（客户端同机房，先测生产再测消费）：

```bash
# 生产：单 topic 分区 16，消息 1KB，1 万 msg/s，持续 30min
bin/pulsar-perf produce persistent://tenant/ns/topic \
  -rp 16 -m 10000 -s 1024 -n 1800 -z 4   # -z 4=ZSTD 压缩；-n 为输出行数（≈时长×输出间隔）
# 消费：同一 topic，Shared 4 消费端，看消费吞吐与延迟
bin/pulsar-perf consume persistent://tenant/ns/topic -s perftest -m "rate:10000" -n 1800
```

> `pulsar-perf` 输出含 `Latency p99/p999`、`Throughput` 与 `Error` 计数；压测 topic 用独立 namespace（`pulsar-perf` 默认写 `persistent://public/default/perf`，勿与业务混用）。
