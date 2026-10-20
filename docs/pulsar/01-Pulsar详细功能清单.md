# Pulsar 详细功能清单

> 适用版本：Apache Pulsar 3.x（同时标注 2.x 差异）。本文档按功能域梳理 Pulsar 的完整能力，供规划、选型与运维参考。参数默认值以 branch-3.3 发行包 `conf/` 为准（已对照官方仓库）。
>
> **速读**：①消息模型是 Pulsar 的核心差异化（订阅模型 + 存算分离）；②存储/安全/多集群是其工程化优势；③Functions/IO/SQL 是一栈式流处理能力，按需启用。

## 目录

- [1. 消息模型](#1-消息模型)
- [2. 持久化与存储](#2-持久化与存储)
- [3. 计算/IO（Pulsar Functions / IO / Connectors）](#3-计算iopulsar-functions--io--connectors)
- [4. 计算协调（Pulsar SQL / Functions Mesh 等）](#4-计算协调pulsar-sql--functions-mesh-等)
- [5. 安全](#5-安全)
- [6. 多集群与复制](#6-多集群与复制)
- [7. 客户端与生态](#7-客户端与生态)
- [8. 运维与可观测性](#8-运维与可观测性)
- [9. 管理工具](#9-管理工具)
- [10. 选型与版本建议](#10-选型与版本建议)
- [11. 新手导读：核心概念、术语表与一条消息的旅程](#11-新手导读核心概念术语表与一条消息的旅程)

## 1. 消息模型

| 功能 | 作用 | 影响与注意点 | 建议 |
|---|---|---|---|
| Topic（主题） | 消息的逻辑通道，分 persistent / non-persistent 两类 | persistent 落盘 BookKeeper（默认，保证不丢）；non-persistent 纯内存（延迟低但不持久，故障即丢） | 业务消息一律用 persistent；non-persistent 仅用于可容忍丢失的实时信号 |
| 命名空间（Namespace） | Topic 的管理单元，隶属于 Tenant，配置以 Namespace 为粒度继承 | 保留/积压/复制/配额均在 Namespace 级生效，Topic 未单独配置时继承 | 按业务/环境划分 Namespace，避免全用 `public/default` |
| 租户（Tenant） | 多租户隔离单元，可独立配额、ACL、集群绑定 | 租户间默认隔离，配额/权限在租户级可控 | 多业务线务必一业务一 Tenant |
| 订阅模式（Subscription） | Exclusive（独占）、Failover（主备）、Shared（共享/轮询）、Key_Shared（按 key 有序共享） | 4 种模式覆盖「严格有序 / 主备 / 水平扩展 / 有序+扩展」；Key_Shared 扩缩容有 hash 迁移代价 | 见《05》§7.5 订阅模式选型速查 |
| 分区 Topic（Partitioned Topic） | 逻辑 topic 映射到 N 个物理分区，提升并行度 | 分区数决定生产/消费并行上限；分区过多增加 ZK 与 broker 负担 | 分区数按「峰值吞吐 / 单分区能力」定，勿盲目设大 |
| 消息顺序 | 分区内有序；Key_Shared 下同 key 路由到同一消费者 | 跨分区/跨 topic 不保证全局有序 | 需全局有序的场景用单分区或设计聚合层 |
| 消息保留（Retention） | 基于大小/时间的持久化保留策略，独立于订阅回溯 | 默认 0=按订阅保留（不设则只保留到 ack）；要长期保留必须显式配置 | 见《03》§1.2、`defaultRetentionTimeInMinutes` |
| 消息过期（TTL） | 未确认消息超时后标记为可删除或重新投递 | TTL 与 Retention 是两套语义，勿混用 | 业务无 TTL 需求时保持 0 |
| 延迟消息（Delayed Delivery） | 消息级 delay 标记，到时后才可投递 | 3.x 默认开启，有追踪开销；不使用可关省资源 | 用 `delayedDeliveryEnabled` 控制，见《03》 |
| 死信队列（DLQ）/ 重试队列 | 消费失败（nack/重投达阈值）后转入重试 topic，再达上限进 DLQ topic | 由消费者侧参数（`DeadLetterPolicy`）配置，**主要作用于 Shared / Key_Shared 订阅**；Exclusive/Failover 无 DLQ 语义 | 关键消费链路务必配 DLQ，并给 DLQ 本身配监控 |
| 消息去重（Deduplication） | Producer 端幂等去重，基于 message dedup context | 以 ProducerName 为维度；开启增加持久化开销 | 要求「至少一次→精确一次」且 Producer 会重连重发时开启 |
| Schema（模式管理） | 内置 Schema Registry，支持 Avro/JSON/Protobuf/KeyValue，自动兼容检查 | 兼容级别 BACKWARD/FORWARD/FULL/ALWAYS_COMPATIBLE；开强制校验会拒收无 schema 生产者 | 新系统建议从第一天启用 Schema |
| 批量消息（Batching） | Producer 端批量发送，降低开销 | 小消息吞吐可提升数倍，代价是单条延迟上升 | 吞吐场景必开，见《05》§2.5 |
| 压缩（Compression） | LZ4 / ZLib / ZSTD / SNAPPY | 用 CPU 换带宽；ZSTD 压缩比高、LZ4 快 | 大消息/弱网必开；CPU 富余选 ZSTD |
| 大消息 | 单条默认上限 5MB（可调），支持分块（chunking，2.x+） | `maxMessageSize` 可调大，但超大消息会挤占内存；分块解决 >5MB 场景 | 默认 5MB 够用则不改；超大数据另走对象存储 |

## 2. 持久化与存储

| 功能 | 作用 | 影响与注意点 | 建议 |
|---|---|---|---|
| 分层存储（Tiered Storage） | 旧 ledger 自动卸载到 S3/HDFS/Azure/OSS 等 | 显著降低 Bookie 容量需求（可降 60%~90%）；冷读延迟高于热存储 | 长保留+低频回溯场景必用，见《05》§5.3 |
| Ledger | BookKeeper 写入单元，由 Ensemble/Ew/Qw 保证副本 | E≥Qw≥Qa；生产常用 3/3/2 | 见《03》`managedLedgerDefault*Quorum` |
| 存储 Model | Entry log + Index file + Journal（读写分离） | Journal 决定写延迟，Entry log 决定读 | Journal 与 Ledger 分盘，见《05》§3.1 |
| 自动回收 | Ledger 删除、Entry Log GC、空间回收 | GC 参数影响空间利用率与 I/O 峰值 | 见《03》§2.3 compaction 参数 |
| Quorum 配置 | E/Qw/Qa 可按 Namespace 定制 | 控制容错与写延迟的权衡 | 生产 3/3/2，容忍单 bookie 故障 |

## 3. 计算/IO（Pulsar Functions / IO / Connectors）

| 功能 | 作用 | 影响与注意点 | 建议 |
|---|---|---|---|
| Pulsar Functions | 轻量级流计算，支持 Java/Python/Go，多运行时 | 强项是简单 ETL/规则；复杂流处理建议用 Flink | 简单转换/过滤可用；重逻辑下沉 Functions Worker 独立部署 |
| Function 状态 | 基于 Table View 的状态存储 | 提供有状态处理基础 | 状态类场景才启用 |
| Window 函数 | 滚动/滑动窗口聚合 | 有限窗口语义 | 聚合类需求可用，量大仍建议流计算引擎 |
| Pulsar IO (Connector) | Source 拉入 + Sink 写出，连接各种系统 | 连接器丰富；注意凭据安全（见《08》CVE） | 作为「管道胶水」性价比高 |
| Transactions | 跨 topic 原子读-处理-写（2.8+ 引入） | 3.x 仍属 preview 特性：需启用事务协调器与 acknowledge-with-transaction，有额外元数据开销 | 非强一致需求不要为了「看起来更高级」而开，见《03》`transactionCoordinatorEnabled` |

## 4. 计算协调（Pulsar SQL / Functions Mesh 等）

| 功能 | 作用 | 影响与注意点 | 建议 |
|---|---|---|---|
| Pulsar SQL（Presto/Trino） | 直接对 topic 历史数据 SQL 查询 | 需启用对应属性；适合审计/回溯分析 | 审计/离线分析场景有价值 |
| Schema Reader | Trino Connector 解析 Avro/JSON/Primitive topic | 依赖 topic 有 schema | 配好 Schema 才能用 SQL |

## 5. 安全

| 功能 | 作用 | 影响与注意点 | 建议 |
|---|---|---|---|
| TLS 传输加密 | Broker/Bookie/Client/Proxy 双向 TLS | 生产建议开启；证书轮换要规划 | 见《02》§6 |
| 认证 | TLS 证书、Token（JWT）、Athenz、Kerberos、OIDC/OAuth2、LDAP | Token 最简单通用；SASL 升级后须轮换密钥（《08》） | 生产开启 `authenticationEnabled` |
| 授权 | Namespace/Topic/Subscription 级 ACL，角色模型 | produce/consume 权限默认不应触达管理 API（见《08》CVE-2024-29834/28098） | 生产开启 `authorizationEnabled` |
| 端到端加密 | Producer 端加密（Crypto reader/writer，如 RSA/AES） | 密文随消息，broker 不可读 | 敏感数据场景启用 |
| 跨集群复制鉴权 | Replicator 使用独立角色证书 | 避免复制链路越权 | 多集群时单独管理复制角色 |

## 6. 多集群与复制

| 功能 | 作用 | 影响与注意点 | 建议 |
|---|---|---|---|
| Geo-Replication | Tenant/Namespace 级跨集群异步复制 | RPO 取决于复制延迟与带宽；双向复制需规划幂等 | 容灾/多活核心能力，见《05》§6.4 |
| 配置存储（ZooKeeper） | 本地 ZK + 配置存储 ZK 两级元数据 | 单集群可复用；多集群必须独立 configuration store | 新部署用 `configurationMetadataStoreUrl`，见《03》 |
| 全局 Namespace | 通过 configuration store 协调多集群元数据 | 全局 topic 元数据一致 | 多集群场景才需要 |

## 7. 客户端与生态

| 功能 | 作用 | 影响与注意点 | 建议 |
|---|---|---|---|
| 官方客户端 | Java、Python、Go、C++（均由 Apache Pulsar 仓库维护）；Node.js 客户端与 WebSocket API 属官方支持渠道但节奏独立 | 语言覆盖广；C++ 是 Python/Go 客户端的底层实现 | 按团队技术栈选择；跨语言团队注意各客户端特性支持度不完全一致（事务、Key_Shared 等） |
| 协议兼容 | KoP（Kafka）、AoP（AMQP）、MoP（MQTT）、RoP（RabbitMQ）协议处理器 | 承接存量客户端、统一平台；协议处理器有额外资源开销 | 迁移期混跑评估，见《05》§7.3 |
| REST Admin API | `/admin/v2` 全量管理接口 | 无发消息/peek 端点（需原生客户端） | 管理自动化统一走 Admin API |
| Proxy | 无状态接入层，支持 TLS 终结与鉴权透传 | 屏蔽集群拓扑变化；永不直接暴露公网（《08》） | 生产/云环境统一走 Proxy |

## 8. 运维与可观测性

| 功能 | 作用 | 影响与注意点 | 建议 |
|---|---|---|---|
| 动态配置 | 多数 broker/bookie 参数可 `pulsar-admin` 动态更新 | 标注【动】的才支持 | 动态调整省去重启 |
| 自动 bundle 卸载 | Broker 容量触发的 bundle 卸载（load shedder） | 防止热点；参数见《03》§1.6 | 生产开启并调阈值 |
| Topic 自动创建 | 可开/关，支持分区数默认值 | 生产建议显式建 topic 更可控（《07》） | 按环境决定 |
| 指标 | Prometheus 端点（Broker `:8080/metrics`、Bookie `:8000/metrics`）+ 官方 Grafana 模板 | 可观测性基线 | 见《02》§8、《06》§8 |
| 日志 | Log4j2 可调整级别 | 排障时临时提级 | 默认 INFO |
| 审计 | ZK 元数据变更可视化（pulsar-admin） | 变更可追溯 | 关键环境开启 |
| 消息回溯（Reset Cursor） | 按时间/位置重置订阅游标 | 依赖保留策略覆盖范围 | 配好 retention 才能回放 |
| Compaction | Topic 压缩（保留每 key 最新值） | 3.x 有丢消息 bug 史（《08》§2），注意版本 | 需最新值语义时启用 |

## 9. 管理工具

- `pulsar-admin`：租户/命名空间/topic/订阅/schema/functions/集群全量 CLI
- `pulsar-client`：生产/消费调试工具
- `pulsar-perf`：性能测试
- `bookkeeper shell`：Bookie 运维
- Pulsar Manager / StreamNative Console / 本项目（Pulsar Manager 桌面工具）：Web/图形化管理

## 10. 选型与版本建议

- **何时选 Pulsar**：百万级 topic、多租户平台、长保留 + 分层存储、跨地域复制、多协议统一、流批混合（详见《05》§7.3）。
- **何时不必选**：单业务小规模、已成熟 Kafka 生态无多租户诉求、微秒级单机 RPC、资源极度受限（《05》§7.4）。
- **版本底线**：任何 3.x 部署至少 ≥ 3.0.11 / 3.2.2，推荐 3.3.x 最新 patch（详见《08》§3）。

## 11. 新手导读：核心概念、术语表与一条消息的旅程

> 前 10 节是「有什么能力」，这一节是「先搞懂什么才能看懂那 10 节」。第一次接触 Pulsar 请从这里开始读。

### 11.1 五个名词的从属关系（背下这张图，后面所有配置都有位置感）

```
Cluster（一套物理集群：Broker + Bookie + ZK）
  └── Tenant（租户：一个业务线/团队/环境）
        └── Namespace（命名空间：策略真正生效的层级 ← 最重要的一层）
              └── Topic（主题：一条持久消息流）
                    └── Subscription（订阅：某个下游消费组的进度）
                          └── Consumer（消费者实例：无状态，随时上下线）
```

- **策略挂在 Namespace，不挂在 Topic**：保留、TTL、积压配额、副本数、权限、复制关系默认都在 namespace 级设置，topic 只在需要覆盖时才单独设。所以「我改了 broker.conf 怎么没生效」的标准答案几乎都是：改的是默认值，已有 namespace 不吃这个默认（见《03》§6.2、§7）。
- **Tenant 的真正作用是隔离与配额**，不是目录。多业务线各一个 tenant，才能让「一个业务把集群打死」变成「只打爆它自己的配额」。
- **Subscription 属于 topic，不属于客户端**：消费者全下线，订阅还在、消息还在堆。

### 11.2 Topic 名字的三段式，写错就找不到

```
persistent://public/default/orders
    │        │      │      └── topic 名
    │        │      └───────── namespace 名
    │        └──────────────── tenant 名
    └───────────────────────── 持久(non-persistent 为纯内存)
```

- 缺 `persistent://` 前缀时客户端会补默认值，`public/default` 是出厂自带的命名空间——**练手可以，业务别用**。
- `non-persistent://` 的 topic 不落 BookKeeper，broker 重启即丢，只用于可容忍丢失的实时信号。

### 11.3 一条消息在生产集群里走过的路

```
① Producer 客户端攒批（batching）+ 压缩 → 通过 6650 发给「该 topic 的 owner broker」
② owner broker 找到 topic 当前写入的 ledger，拆成 entry 交给 BookKeeper 客户端
③ BookKeeper 把这条 ledger 的 chunk 分散到 E 台 Bookie，写到 Qw 台、Qa 台确认后
   （每台 Bookie 先顺序写 journal 并 fsync，再进 entry log）
④ broker 回 Producer「发送成功」，返回 MessageId        ← 到这里是「生产延迟」
⑤ broker 上的 dispatcher 按订阅模式把 entry 推给 Consumer
⑥ Consumer 处理完调 acknowledge，游标（cursor）向前推进
⑦ 满足「该 topic 上所有订阅都已 ack」+ 过了 retention 窗口的 ledger 才可删，
   由 broker 标记删除、BookKeeper ledger GC 与 entry log compaction 真正回收空间
```

看懂这七步，就看懂了本文档剩下的结构：①④归客户端与 broker（《03》§1.2~1.4、《05》§2），②③归 BookKeeper（《03》§2、《05》§3），⑤⑥归订阅与投递（§1 消息模型），⑦归保留/TTL/配额与 GC（《03》§6.2）。

> 第⑦步那条「**所有**订阅都 ack 才回收」是新手最容易忽视的运维事实：一个早已废弃却没删除的订阅，就能让 topic 的历史数据永远删不掉，把磁盘吃满。排查积压先看订阅列表，不是先看消费者。

### 11.4 术语速查

| 术语 | 一句话 | 出现处 |
|---|---|---|
| Entry | BookKeeper 里的最小写入单元（≈一条消息） | 《03》§2 |
| Ledger | BookKeeper 的一段追加写日志，一个 topic 由多条 ledger 串成 | 《02》§1 |
| Journal | Bookie 的顺序预写日志，决定写延迟 | 《05》§3.1 |
| Entry Log | Bookie 磁盘上承载 entry 的物理文件，多 ledger 混写其中 | 《03》§2.2 |
| Compaction | 把混写文件里仍存活的数据搬到新文件以回收空间（与 topic 的「消息压缩」不是一回事） | 《03》§2.3、《05》§3.3 |
| Offload / 分层存储 | 把旧 ledger 复制到对象存储，本地只留热数据 | 《05》§5.3 |
| Bundle | namespace 被切分的负载分配单元，负载均衡搬的就是它 | 《03》§6.4 |
| Cursor | 某个订阅读到哪了 | 《03》§6.3 |
| Backlog | 游标之后未消费/未 ack 的消息量 | 《03》§6.2 |
| Bookie 机架感知 | 副本放置时避免全落同一机架 | 《05》§3.5 |
| MoP/KoP/AoP/RoP | MQTT/Kafka/AMQP/RabbitMQ 协议处理器 | 《06》§2 |

### 11.5 六条常见误解（每条都会让人白折腾半天）

1. 「Pulsar 是 Kafka 的替代品，配置方式差不多」→ Kafka 的分区绑 broker，Pulsar 的数据在 BookKeeper；Kafka 靠日志留存时间删数据，Pulsar 靠订阅 ack + retention + GC。
2. 「分区数越多吞吐越高」→ 分区解决客户端并行，不解决单 bundle 打满一台 broker；且分区数会推高 ZK 与 broker 负担（《03》§6.4）。
3. 「开了 retention 就不会丢消息」→ retention 只保留「已被所有订阅 ack」的消息；未 ack 且超 TTL 一样会被处理掉（《03》§6.2）。
4. 「backlog 大就是消费者挂了」→ 也可能是消费者活着但 ack 太慢被 `maxUnackedMessagesPerConsumer` 卡住，或配额策略把生产者压住了（hold 模式表现成「生产者超时」）。
5. 「改 broker.conf 就能改所有 topic 的保留策略」→ 已有 namespace 的策略优先，需要 `pulsar-admin namespaces set-*`（《03》§7）。
6. 「Bookie 磁盘满了 broker 会报错」→ 默认行为是 Bookie 进只读，生产者侧表现为写超时/`NoWritableBookiesFound`，看不出是磁盘问题；先看磁盘水位三件套（《03》§2.2）。

### 11.6 建议的上手顺序

```
《04》§12 单体跑通第一条消息（30 分钟，动手）
  → 《01》本文 §11 + §1 消息模型（建立概念）
  → 《02》§1、§5、§11 部署一套 3 节点小集群（动手）
  → 《03》§6 五组概念 + §7 验证方法（回头解释你刚才改了什么）
  → 《07》§7 按模板套生产参数（动手）
  → 《05》§9 调优起步 → 《06》/《08》按场景与安全需要查阅
```
