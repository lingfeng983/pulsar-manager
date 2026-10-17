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
# 分层存储
managedLedgerOffloadAutoTriggerSizeThresholdBytes=<3天热数据量/分区>
managedLedgerOffloadDriverClassName=org.apache.pulsar.broker.offload.impl.S3OffloaderFactory   # OSS 用 JCloudOffloaderFactory + service endpoint
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
- **Bookie**：Journal 组提交保持默认；关注 `pulsar_storage_write_latency` p99；`lostBookieRecoveryDelay=300s` 防瞬时故障抖动。
- **负载均衡**：`loadBalancerBrokerOverloadedThresholdPercentage=80`；bundle 数按 broker×4 起步。
- **积压治理**：消费端保证 ack 速率 > 生产速率；监控 `pulsar_subscription_backlog` 并按 namespace 告警。

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
