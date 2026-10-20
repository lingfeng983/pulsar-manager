# IoT 高吞吐场景 Pulsar 架构选型方案

> 基于《05-Pulsar集群调优与架构选型指南》落地到典型 IoT 高吞吐场景：百万级设备接入、遥测数据采集 + 下行指令，7×24 小时不间断。
> 参数名/默认值以 branch-3.3 为准。

## 目录

- [1. 需求假设（示例基线）](#1-需求假设示例基线)
- [2. 接入层选型](#2-接入层选型)
- [3. Topic 与租户设计](#3-topic-与租户设计)
- [4. 订阅与投递](#4-订阅与投递)
- [5. 存储与副本配置](#5-存储与副本配置)
- [6. 集群拓扑与容量](#6-集群拓扑与容量)
- [7. 性能调优要点（对应 05 号文档）](#7-性能调优要点对应-05-号文档)
- [8. 可观测性](#8-可观测性)
- [9. 演进路线](#9-演进路线)
- [10. 风险与对策](#10-风险与对策)
- [11. 新手视角：把本方案缩小到一万台设备](#11-新手视角把本方案缩小到一万台设备)

## 1. 需求假设（示例基线）

| 项 | 假设值 |
|---|---|
| 设备数 | 100 万在线 |
| 上行频率 | 平均 1 条/秒/设备（突发 5 倍） |
| 消息大小 | 平均 512B（含 payload + 元数据） |
| 峰值吞吐 | ≈ 100 万 msg/s × 512B ≈ 500MB/s 入 |
| 端到端延迟 | 上行链路 P99 < 50ms；下行指令 P99 < 20ms |
| 保留策略 | 热数据 3 天全量 + 冷数据 90 天（S3 卸载） |
| 可用性 | 单机/单机架故障无感，机房级异步容灾 |

> 换算到具体参数前，先按此表替换为你的真实数值重算（容量公式见《05》§5.1）。

## 2. 接入层选型

> **先分清三个容易混的名词**（本方案与《05》里反复出现）：
> - **Proxy**：Pulsar 自带的无状态接入层，说的是 Pulsar 私有协议/HTTP，作用是「让客户端只记一个地址」+ 统一 TLS 与鉴权。它不认 MQTT。
> - **协议处理器（MoP / KoP / AoP / RoP）**：装在 Broker 上的插件，让 Pulsar 直接听得懂 MQTT / Kafka / AMQP / RabbitMQ 协议。MoP（MQTT-on-Pulsar）就是设备用标准 MQTT 客户端直接连集群，topic 与 Pulsar topic 一一映射，QoS/遗嘱/保留消息由 MoP 实现。**它省掉了独立 MQTT 服务器**，代价是吃 Broker 的 CPU 与内存。
> - **独立 MQTT 网关（EMQX / NanoMQ 等）**：集群外面的另一套服务，靠桥接（或 MoP）把消息搬进 Pulsar。存量设备认证、规则、连接管理已经在网关里做过时才有必要。
>
> 选型只需回答一句：**设备的 MQTT 连接管理与认证，你打算自己再建一套，还是交给 Pulsar（MoP）？**

- **协议**：设备侧 MQTT（低带宽、弱网、QoS 支持）→ 部署 **MoP（MQTT-on-Pulsar）** 协议处理器，或前置 EMQX/NanoMQ 网关桥接到 Pulsar（前者架构更简单，后者复用存量 MQTT 基础设施）。
- **Proxy 层**：
  - MoP 直连 Broker 时可省 Proxy；跨 AZ/云上部署则统一走 Proxy + LB。
  - TLS 终结在 LB/Proxy，设备证书认证（`authenticationEnabled` + Token 或 mTLS）。
- **容错**：接入层无状态，水平扩容 + LB 健康检查即可。

## 3. Topic 与租户设计

```
tenant: iot
├── namespace: telemetry        # 上行遥测
│   └── persistent://iot/telemetry/{productId}/{deviceId}
├── namespace: telemetry-shared # 消费侧用分区聚合 topic（可选）
├── namespace: cmd              # 下行指令（按设备 key 有序）
└── namespace: dlq              # 死信/异常
```

- **百万 topic 是 Pulsar 的强项**：按 `productId/deviceId` 建 topic（非分区），启用 `allowAutoTopicCreation=true`。
- 关闭不活跃自动清理或设长周期（设备离线≠数据可删）：`brokerDeleteInactiveTopicsMaxInactiveDurationSeconds=2592000`（30 天，注意该参数单位为秒；且 3.x `brokerDeleteInactiveTopicsEnabled` 默认 true，必须显式设长周期或对关键 namespace 关闭，防止离线设备 topic 被误删）。
- 租户隔离：其他业务（如告警、日志）建独立 Tenant，互不挤占配额。

## 4. 订阅与投递

| 链路 | 订阅模式 | 理由 |
|---|---|---|
| 遥测 → 实时计算/存储 | Shared | 吞吐优先，乱序可容忍 |
| 遥测 → 按设备状态聚合 | Key_Shared（deviceId 为 key） | 同设备有序 + 水平扩展 |
| 下行指令 | Failover 或 Key_Shared | 同设备指令必须有序；回执 Exclusive |
| 告警广播 | 多订阅 Fan-out | 规则引擎、短信、看板各一个订阅 |
| 异常消息 | Shared + Retry/DLQ | nack 3 次进 `iot/dlq` |

## 5. 存储与副本配置

```properties
# broker.conf / namespace 级
managedLedgerDefaultEnsembleSize=3
managedLedgerDefaultWriteQuorum=3
managedLedgerDefaultAckQuorum=2
backlogQuotaDefaultLimitBytes=107374182400   # 100GB（3.x 参数名，勿用已废弃的 backlogQuotaDefaultLimitGB）
backlogQuotaDefaultRetentionPolicy=producer_exception
ttlDurationDefaultInSeconds=0            # 保留交给 retention，不做 TTL
defaultRetentionTimeInMinutes=4320       # 3 天热数据

# 分层存储（参数名与工厂类名按 branch-3.3 核对）
managedLedgerOffloadDriver=org.apache.bookkeeper.mledger.offload.jcloud.JCloudLedgerOffloaderFactory
#   ↑ jclouds 系（S3 / OSS / Azure Blob / GCS）与本地文件都走这两个工厂之一：
#     本地文件系统用 org.apache.bookkeeper.mledger.offload.filesystem.FileSystemLedgerOffloaderFactory
#     旧稿写的 org.apache.pulsar.broker.offload.impl.S3OffloaderFactory 不是真实类名
managedLedgerOffloadAutoTriggerSizeThresholdBytes=-1   # 默认 -1=不按大小触发；设单 ledger 阈值（如 10737418240=10GB）
managedLedgerOffloadThresholdInSeconds=-1              # 3.x 新增：按「ledger 存活多久」触发卸载，热数据按天数划窗口时用这个
managedLedgerOffloadDeletionLagMs=14400000             # 卸载后过多久才删 Bookie 上的副本（默认 4 小时，留反悔窗口）
managedLedgerOffloadMaxThreads=2
# 再按 driver 补 s3ManagedLedgerOffloadBucket / s3ManagedLedgerOffloadRegion 之类的专有项（--help 与官方 offload 文档为准）
```

- 冷数据 90 天卸载 S3/OSS，Bookie 容量只需覆盖 3 天热数据。
- **容量粗算**（按《05》§5.1 修正后公式）：500MB/s × 3 天 × 3 副本 ≈ 390TB 原始；390 / 0.9（可用水位）× 1.2（放大）≈ 520TB 集群可用容量。此值为粗估，务必按真实消息大小/副本/保留天数精算。
- Entry Log 放大系数与 GC：TTL 短/删除频繁时可调 `majorCompactionThreshold`。

## 6. 集群拓扑与容量

| 组件 | 规模 | 配置要点 |
|---|---|---|
| Bookie | 15~20 台（NVMe×2 RAID1 + 大容量 SSD） | Journal 与 Ledger 分盘；`diskUsageThreshold=0.95`；机架感知放置 |
| Broker | 10~15 台（16C/32G） | 单 broker 按 3~5 万 msg/s 折算峰值，留 30% 余量 |
| ZK | 3 或 5 台 | 百万 topic 下 znode 数量大，SSD + 独立部署 |
| Functions/IO Worker | 3+ 台独立部署 | 规则引擎/格式转换，不与 Broker 混部 |
| 跨机房 | 主备集群 Geo-Replication（异步） | 复制 `iot/cmd` 与关键 namespace；RPO≈秒级 |

- Bookie 与 Broker **分机部署**；MoP 增加 Broker CPU 负担，接入层可再独立（MoP 有独立配置）。
- 所有节点按《05》§4.2 做 OS 调优（ulimit、禁 swap、XFS+noatime、chrony）。

## 7. 性能调优要点（对应 05 号文档）

- **客户端/网关**：`batchingEnabled=true`，`batchingMaxMessages=1000`；压缩 LZ4（CPU 便宜、快）。
- **Broker**：`PULSAR_MEM` 8~16g 堆 + 16g 直接内存；追尾读 `managedLedgerNewEntriesCheckDelayInMillis=1~5`。
- **Bookie**：Journal 组提交保持默认；关注 `pulsar_storage_write_latency_le_10` 与 `_le_100` 两桶的占比（写延迟超过 100ms 的份额抬头就该查盘）；`lostBookieRecoveryDelay=300s` 防瞬时故障抖动。
- **负载均衡**：`loadBalancerBrokerOverloadedThresholdPercentage=80`；bundle 数按 broker×4 起步。
- **积压治理**：消费端保证 ack 速率 > 生产速率；监控 `pulsar_broker_msg_backlog`（broker 汇总）与 `pulsar_subscription_back_log`（订阅级，注意拼写带下划线），按 namespace 告警。

## 8. 可观测性

- Prometheus 采集 Broker/Bookie/MoP 指标；Grafana 按 Tenant/Namespace 维度出看板。
- 核心告警项：
  - 订阅积压持续增长（消费能力不足）
  - Bookie 磁盘水位 > 85%、写延迟 p99 > 10ms
  - ZK 会话超时 / Broker bundle 反复迁移
  - Geo 复制积压（灾备 RPO 恶化）

## 9. 演进路线

```
阶段1：单体/小集群（10 万设备）验证 MoP 与 topic 设计
阶段2：分机部署 + 分层存储（百万设备）
阶段3：Functions 规则引擎下沉 + 双机房 Geo-Replication
阶段4：多产品线接入（Tenant 扩展）+ KoP 承接服务端 Kafka 业务
```

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 百万 topic 下 ZK 压力 | 监控 znode 数；必要时 topic 按 productId 聚合为分区 topic |
| 设备突发 5 倍流量 | 接入层限流 + backlog quota 保护 Broker；Bookie 预留 30% 余量 |
| MoP 单点性能瓶颈 | MoP 独立部署/水平扩容；或前置独立 MQTT 网关 |
| S3 卸载冷读慢 | 回溯分析走分层存储读接口，避免打热 Bookie（分池隔离） |
| Key_Shared 消费者扩缩容抖动 | 用 consistent hashing 模式，低峰期扩缩 |
| 离线设备 topic 被自动清理 | 配长 `brokerDeleteInactiveTopicsMaxInactiveDurationSeconds` 或关键 ns 关闭清理 |

## 11. 新手视角：把本方案缩小到一万台设备

> 本文的规模（百万设备、15~20 台 Bookie）是用来讲「上限在哪」的。**不要照抄成起步配置**——那样只会得到一套你看不懂、也验证不了的集群。
> 一万台设备、平均 1 条/秒、消息 512B ≈ 5MB/s 入，单机集群完全够；正确姿势是先跑小集群，把 §10 的每条风险都亲手触发一次，再按同一套设计放大。

| 维度 | 百万设备（本文） | 一万台起步（建议照这列做） |
|---|---|---|
| 拓扑 | 3 ZK + 10~15 Broker + 15~20 Bookie | **3 台机器，每台混部 ZK+Broker+Bookie**（E=Qw=3/Qa=2 需要 3 台 Bookie 才有意义） |
| 设备接入 | MoP 独立扩容 | 直接装 MoP 在 Broker 上；一台都够 |
| Topic 粒度 | 一设备一 topic（100 万） | **一产品一 topic + 按 deviceId 做 message key**（几千个），等 topic 数真的成为查询瓶颈再拆细 |
| 订阅 | 多链路 fan-out | 先 1 个落库订阅 + 1 个告警订阅，验证游标互不影响 |
| 保留 | 3 天热 + 90 天 S3 | 只配 `defaultRetentionTimeInMinutes=1440`（1 天），**先不做分层存储**——它是本表里最容易配错、也最难验证收益的一项 |
| 分层存储 | JCloud S3/OSS 卸载 | 先用本地文件 offloader 跑通一次卸载与冷读，再换对象存储 |
| 压测 | pulsar-perf 全矩阵 | 1 万 msg/s 单 topic 基线 + 突发 5 倍（`-r` 阶梯） |
| 容灾 | 双集群 Geo-Replication | **先验证备份路径**：ZK 快照 + Bookie 数据盘；复制等多账号业务真要求时再上 |

三件在小规模下也必须做对的事（这三条到了大规模没有补救机会）：

1. **租户/命名空间从第一天就按业务划**，别全塞 `public/default`——后期迁移 topic 要断流。
2. **`advertisedAddress` 与网络规划一次做对**（见《02》§11 ①），跨网段的坑放大到百万连接时会变成事故。
3. **保留/TTL/积压配额三者按《03》§6.2 的语义显式设定**，不要用默认值。默认值（Retention=0、配额=-1）在小集群的表现是「测试一切正常，第一次有慢消费者就磁盘写满」。
