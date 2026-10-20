# Pulsar 集群配置清单

> 覆盖 Broker（broker.conf）、BookKeeper（bookkeeper.conf）、ZooKeeper（zookeeper.conf）与 Proxy（proxy.conf）的关键配置项。
> 默认值以 branch-3.3 发行包 `conf/` 原文为准（已逐一对照官方仓库，本版修正了旧稿若干默认值错误）。
> BookKeeper 参数同时对照了 bookkeeper 4.17 的 `ServerConfiguration` 源码；发行包 conf 里没写出来的参数，本文标注为「代码默认」。
> 标注：
> - **【调】** 常用需按环境调整项；**【动】** 支持 `pulsar-admin` 动态更新（无需重启）。
> - 每参数给出「作用 / 影响 / 建议值」，建议值按「3 ZK + 3 Broker + 4 Bookie、E=Qw=3/Qa=2」的生产基线给出，须按实际环境微调。
>
> **新手请先读**：§6「五组最容易混淆的概念」与 §7「改完配置怎么确认生效」，再回来查参数表。

## 目录

- [1. broker.conf](#1-brokerconf)
- [2. bookkeeper.conf](#2-bookkeeperconf)
- [3. zookeeper.conf](#3-zookeeperconf)
- [4. proxy.conf](#4-proxyconf)
- [5. client.conf / 生产建议速查](#5-clientconf--生产建议速查)
- [6. 新手必读：五组最容易混淆的概念](#6-新手必读五组最容易混淆的概念)
- [7. 改完配置怎么确认生效](#7-改完配置怎么确认生效)

## 1. broker.conf

### 1.1 基础连接

| 参数 | 默认值 | 作用/介绍 | 影响 | 建议值 |
|---|---|---|---|---|
| clusterName | （空） | 【调】集群名，须与 `initialize-cluster-metadata` 一致 | 不一致会导致 topic 创建/归属异常 | `pulsar-cluster-1` |
| metadataStoreUrl | （空） | 【调】3.x 元数据地址（`zk:host1,host2`）；替代旧 `zookeeperServers` | 连不上则 broker 无法加载元数据 | `zk:zk1:2181,zk2:2181,zk3:2181` |
| configurationMetadataStoreUrl | （空） | 【调】配置存储地址；为空回退 metadataStoreUrl | 多集群扩展必需；单集群可复用 | 显式给出，便于扩展 |
| brokerServicePort / brokerServicePortTls | 6650 / （空） | 二进制协议端口 | 客户端接入点 | 6650；启用 TLS 时显式设 6651 |
| webServicePort / webServicePortTls | 8080 / （空） | HTTP Admin 端口 | Admin/监控接入点 | 8080；启用 TLS 时显式设 8443 |
| advertisedAddress | （空） | 【调】对外通告地址 | 多网卡不设会通告错误 IP | 每台写本机 hostname/IP |
| bindAddress | 0.0.0.0 | 监听地址 | 默认全网卡 | 保持默认 |
| metadataStoreSessionTimeoutMillis | 30000 | 元数据会话超时 | 过小易误判 broker 失联 | 30000 |

### 1.2 消息与托管 Ledger（生产核心）

| 参数 | 默认值 | 作用/介绍 | 影响 | 建议值 |
|---|---|---|---|---|
| maxMessageSize | 5242880 | 单条消息最大 5MB | 超限被拒；调大挤占内存 | 默认即可 |
| defaultRetentionTimeInMinutes | 0 | 默认保留时长 | 0=按订阅保留；想长期保留必须显式配置 | 按业务（如 4320=3 天） |
| defaultRetentionSizeInMB | 0 | 默认保留大小 | 同上 | 0（不限） |
| backlogQuotaCheckEnabled | true | 【动】积压配额检查开关 | 关掉则积压无上限保护 | true |
| backlogQuotaCheckIntervalInSeconds | 60 | 积压检查周期 | 越小越及时、略增开销 | 60 |
| backlogQuotaDefaultLimitBytes | -1 | 【动】每 topic 积压上限（字节） | -1=不限；触发后按策略处理，防止磁盘被积压撑爆 | 按业务（如 100GB=107374182400） |
| backlogQuotaDefaultRetentionPolicy | producer_request_hold | 【动】触顶策略：`producer_request_hold` / `producer_exception` / `consumer_backlog_eviction` | hold=压住生产端、exception=抛异常拒生产、eviction=驱逐最旧消息 | 生产常用 `producer_exception`（快速失败便于告警） |
| retentionCheckIntervalInSeconds | 120 | 【动】保留清理检查周期 | 过大会延迟空间回收 | 120（默认） |
| ttlDurationDefaultInSeconds | 0 | 【动】默认消息 TTL | 0=不做 TTL；与 retention 是两套语义 | 无 TTL 需求保持 0 |
| maxNumPartitionsPerPartitionedTopic | 0 | 分区数上限 | 0=不限制；过大增加 ZK/broker 负担 | 按需 |
| defaultNumberOfNamespaceBundles | 4 | 【动】Namespace 初始 bundle 数 | 太少负载倾斜、太多增 ZK 压力 | 按 broker 数×3~5 折算（见《05》§2.4） |
| managedLedgerDefaultEnsembleSize (E) | 2 | 【动】副本放置组大小（bookie 数） | 决定最多可同时故障几台 bookie 而不丢数据 | 3（生产） |
| managedLedgerDefaultWriteQuorum (Qw) | 2 | 【动】写入副本数 | E≥Qw≥Qa；副本越多写入带宽越大 | 3 |
| managedLedgerDefaultAckQuorum (Qa) | 2 | 【动】确认副本数 | Qa 越小写延迟越低、容错越弱 | 2（容忍单 bookie 故障） |
| managedLedgerMaxEntriesPerLedger | 50000 | 单 ledger 条数上限 | 越小滚动越快、恢复越快，但增 ZK 元数据压力 | 50000；恢复敏感可降 10000 |
| managedLedgerMinLedgerRolloverTimeMinutes | 10 | ledger 最小滚动间隔 | 防止频繁滚动 | 10 |
| managedLedgerMaxLedgerRolloverTimeMinutes | 240 | ledger 最大滚动间隔 | 防止单 ledger 过大 | 240（默认） |
| managedLedgerMaxSizePerLedgerMbytes | 2048 | ledger 最大大小（MB） | 触发滚动的体积条件 | 2048 |
| managedLedgerCursorMaxEntriesPerLedger | 50000 | 游标 ledger 条数上限 | 游标元数据滚动 | 50000 |
| managedLedgerNewEntriesCheckDelayInMillis | 10 | 【动】追尾读检查延迟 | 调小降延迟、调大提吞吐 | 延迟敏感 1~5，吞吐优先 10 |
| managedLedgerCacheSizeMB | （堆外 1/5） | 【调】页缓存大小（直接内存） | 读多写少/热 topic 调大；过小增加读 bookie | 直接内存富余时显式设 8G+ |
| managedLedgerCacheEvictionWatermark | 0.9 | 【动】缓存驱逐水位 | 0.95 提利用率但易触发回压 | 0.9（默认） |
| managedLedgerDefaultMarkDeleteRateLimit | 1.0 | 【动】ack 游标落盘速率（每写 N 条 entry 才 mark-delete 一次游标） | 过小会频繁写游标（增 BookKeeper/ZK 写）、恢复时重放更少；过大批游标推进慢、崩溃后重复投递多 | broker.conf 是 1.0、standalone.conf 是 0.1；吞吐场景可调 10（见《07》） |

### 1.3 消费/投递

| 参数 | 默认值 | 作用/介绍 | 影响 | 建议值 |
|---|---|---|---|---|
| subscriptionRedeliveryTrackerEnabled | true | 重投递追踪 | 关闭可省少量开销 | true |
| delayedDeliveryEnabled | true | 【动】延迟消息开关 | 3.x 默认开；不用延迟消息可关省追踪开销 | 用则 true，不用 false |
| delayedDeliveryMaxDelayInMillis | 0 | 延迟上限 | **默认 0=无上限**（旧稿误写 1h）；设值后超限报错 | 业务需上限时设（如 3600000=1h） |
| maxUnackedMessagesPerConsumer | 50000 | 消费者未 ack 上限 | 打满会停止投递直到 ack | 50000（默认） |
| maxUnackedMessagesPerSubscription | 200000 | 订阅级未 ack 上限 | 保护慢消费/失联 | 200000（默认） |
| maxUnackedMessagesPerBroker | 0 | broker 级未 ack 上限 | 0=不限制；设置后整体兜底 | 0 或按容量设 |
| maxUnackedMessagesPerSubscriptionOnBrokerBlocked | 0.16 | 触达 broker 上限时，订阅未 ack 超过该比例即被阻塞 | 配合 `maxUnackedMessagesPerBroker` 用，防止少数慢订阅拖垮整体 | 0.16（默认） |
| dispatcherMaxReadBatchSize | 100 | broker 从 bookie 单次读的条数 | 调大提追尾吞吐、增内存；回溯读场景可调大 | 100；回溯读 500~1000 |
| dispatcherMaxRoundRobinBatchSize | 20 | Shared 订阅轮询批量 | 控制每个消费者的分发粒度 | 20（默认） |
| delayedDeliveryTickTimeMillis | 1000 | 延迟消息调度 tick | 调小提升到期精度、增 CPU；调大降低开销 | 1000（默认） |
| subscriptionExpiryCheckIntervalInMinutes | 5 | 订阅过期检查 | 配 `subscriptionExpirationTimeMinutes` 用 | 5 |
| subscriptionKeySharedUseConsistentHashing | true（3.x conf） | Key_Shared 路由算法 | true 减少扩缩容时 key 迁移 | true（3.x conf 默认） |

### 1.4 Topic / Schema / 自动化

| 参数 | 默认值 | 作用/介绍 | 影响 | 建议值 |
|---|---|---|---|---|
| allowAutoTopicCreation | true | 【动】自动建 topic | 生产建议 false，显式建更可控 | 按环境（生产建议 false） |
| allowAutoTopicCreationType | non-partitioned | 自动建的类型 | 需自动分区 topic 时改 partitioned | non-partitioned |
| defaultNumPartitions | 1 | 自动分区 topic 默认分区数 | 自动建分区时生效 | 按需 |
| allowAutoSubscriptionCreation | true | 【动】自动建订阅 | 关掉需显式建订阅 | 按环境 |
| brokerServiceCompactionThresholdInBytes | 0 | 【动】Topic 压缩触发阈值（字节，0=不自动触发） | 越小越频繁压缩、读到最新值越快，但增 IO | 需压缩时设阈值（如 10485760=10MB） |
| brokerDeleteInactiveTopicsEnabled | true | 【动】自动清理不活跃 topic | 3.x 默认开，注意保护长期无流量 topic | true，配长周期/关关键 ns |
| brokerDeleteInactiveTopicsMaxInactiveDurationSeconds | （空） | 【动】不活跃判定时长 | 空则用检查周期；设长可保护离线 topic | 需长保时设 2592000（30 天） |
| brokerDeleteInactiveTopicsMode | delete_when_no_subscriptions | 清理模式 | 只删无订阅无生产者的 topic；`delete_when_subscriptions_caught_up` 需积压清空 | 默认即可 |
| systemTopicEnabled | true | 3.x 系统主题 | 主题级策略/复制订阅依赖它 | true |
| topicLevelPoliciesEnabled | true | 主题级策略 | 依赖 system topic | true |
| transactionCoordinatorEnabled | false | 事务协调器 | 用事务再开；有额外元数据开销 | 按需 |
| schemaCompatibilityStrategy | FULL | Schema 兼容级别 | BACKWARD/FORWARD/FULL/ALWAYS_* | FULL |
| schemaValidationEnforced | false | 【动】强制 schema 校验 | 开启后无 schema 生产者被拒 | 新系统建议 true |

### 1.5 复制 / 安全 / 限流

| 参数 | 默认值 | 作用/介绍 | 影响 | 建议值 |
|---|---|---|---|---|
| replicationConnectionsPerBroker | 16 | 到每个对端集群的复制连接数 | 跨集群高延迟链路易成瓶颈时加大 | 16，按专线带宽调 |
| replicationProducerQueueSize | 1000 | 每个复制 Producer 的待发队列长度 | 队列打满会阻塞复制；过大占内存 | 1000（默认） |
| replicationPolicyCheckDurationSeconds | 600 | 复制策略一致性巡检周期 | 避免 namespace 策略变更后复制端不一致 | 600（默认） |
| createTopicToRemoteClusterForReplication | true | 本地向对端复制时，若对端无此 topic 是否自动创建 | 关掉要求运维在对端预建 topic，防意外写数据 | 按治理要求选 |
| enableReplicatedSubscriptions | true | 复制订阅游标（代码默认 true；conf 未列出） | 跨集群消费游标同步；旧稿参数名误写 `replicatedSubscriptionsEnabled` | true |
| authenticationEnabled | false | 【调】认证开关 | 开启后需配 Provider 与 superUserRoles | 生产 true |
| authorizationEnabled | false | 【调】授权开关 | 建议与认证同开 | 生产 true |
| authenticationProviders | （空） | Token/Athenz/OIDC Provider | 决定认证方式 | Token Provider |
| superUserRoles | （空） | 【调】超级角色 | 漏配会导致管理操作全被拒 | 显式列管理角色 |
| authenticateOriginalAuthData | false | Proxy 透传鉴权 | Proxy 场景必须 true 才能透传原始身份 | Proxy 场景 true |
| maxConcurrentLookupRequest | 50000 | lookup 并发上限 | 保护 broker 免被查找打爆 | 50000（默认） |
| brokerMaxConnections | 0 | broker 总连接上限 | 0=不限制；保护 | 0 或按容量 |
| brokerMaxConnectionsPerIp | 0 | 单 IP 连接上限 | 0=不限制；防单点刷爆（旧稿误写 `maxClientsPerHost`） | 需要防刷时设 |
| maxTenants / maxNamespacesPerTenant | 0 | 租户/命名空间配额 | 0=不限制 | 按容量 |
| tlsEnabled | false | 【调】TLS | 生产建议开 | 按需 |
| tlsCertificateFilePath / tlsKeyFilePath / tlsTrustCertFilePath | — | 【调】证书 | 启用 TLS 必配 | 证书路径 |
| tlsAllowInsecureConnection | false | 【调】允许不受信证书 | 生产勿开 | false |

> **新手最容易踩的坑**：3.x 的 broker.conf 里**没有 `replicationEnabled` 这个开关**（旧稿有这一行，已删）。跨集群复制不是在 broker 上「打开总开关」，而是按 Namespace 启用：
> 先把对端集群注册进来（`pulsar-admin clusters create`），再 `pulsar-admin namespaces set-clusters <tenant>/<ns> --clusters cluster-a,cluster-b`。
> 这一节里的 `replication*` 参数只负责「已经启用的复制链路跑得多快、怎么连」，不决定「是否复制」。

### 1.6 负载均衡与容量

| 参数 | 默认值 | 作用/介绍 | 影响 | 建议值 |
|---|---|---|---|---|
| loadManagerClassName | ...ModularLoadManager | 3.x 模块化负载管理器 | 影响 bundle 分配策略 | 保持默认 |
| loadBalancerEnabled | true | 负载均衡开关 | 集群必须开 | true |
| loadBalancerSheddingEnabled | true | 【动】自动 bundle 卸载 | 防止单 broker 过载 | true |
| loadBalancerBrokerOverloadedThresholdPercentage | 85 | 【动】过载阈值（CPU/内存/流量） | 调低提前卸载、减少抖动 | 80（见《05》§2.4） |
| loadBalancerResourceQuotaUpdateIntervalMinutes | 15 | 【动】资源配额上报周期 | 过小增 ZK 压力 | 15 |
| loadBalancerBandwithInResourceWeight / BandwithOutResourceWeight | 1.0 | 带宽权重 | 官方参数名即拼作 "Bandwith" | 按网络敏感度调 |
| loadBalancerSheddingIntervalMinutes | 1 | 【动】卸载检查周期 | 越小越及时 | 1 |
| loadBalancerNamespaceBundleMaxMsgRate | 30000 | 单 bundle 消息速率上限 | 触发 bundle 分裂/卸载阈值（3.x 默认；2.x 为 1000） | 30000 |
| loadBalancerNamespaceBundleMaxBandwidthMbytes | 100 | 单 bundle 带宽上限 | 同上（3.x 默认；2.x 为 1000000） | 100 |

### 1.7 JVM（conf/pulsar_env.sh）

```bash
# 16G 机器示例：堆与直接内存各半
PULSAR_MEM="-Xms8g -Xmx8g -XX:MaxDirectMemorySize=8g"
PULSAR_GC="-XX:+UseG1GC -XX:MaxGCPauseMillis=10"   # 3.x 默认 G1
# 可选：内存充足时预防缺页抖动
OPTS="$OPTS -XX:+AlwaysPreTouch"
```

## 2. bookkeeper.conf

### 2.1 基础

| 参数 | 默认值 | 作用/介绍 | 影响 | 建议值 |
|---|---|---|---|---|
| bookiePort | 3181 | Bookie 端口 | 节点间复制端口 | 3181 |
| advertisedAddress | （空） | 【调】通告地址 | **不设会注册错误 IP**，多网卡必设 | 每台写本机 hostname/IP |
| zkServers | localhost:2181 | 【调】ZK 地址（conf 里预填 localhost:2181，多机部署必须改） | 连不上则无法注册 | zk 列表 |
| allowLoopback | false | 是否允许 loopback 注册 | 单机测试可开 | 生产 false |
| statsProviderClass | PrometheusMetricsProvider | metrics 上报 | 监控依赖 | 保持 |
| httpServerEnabled / httpServerPort | **false** / 8000 | Bookie 的 HTTP Admin（`/api/v1/...`）服务 | 官方 conf 默认关闭；关掉不影响 Prometheus 抓指标 | 需要 Bookie Admin API 时再开 |
| prometheusStatsHttpPort | 8000 | Prometheus 指标端口（由 `statsProviderClass` 提供） | **抓 `/metrics` 靠的是这个端口**，不是上面的 httpServer | 8000（默认） |

### 2.2 存储

| 参数 | 默认值 | 作用/介绍 | 影响 | 建议值 |
|---|---|---|---|---|
| journalDirectory | data/bookkeeper/journal | 【调】Journal 目录 | 决定写延迟上限；建议 NVMe 独立盘 | 独立 NVMe |
| journalDirectories | — | 多 journal 目录（逗号分隔） | 多盘分摊写 | 按盘数 |
| ledgerDirectories | data/bookkeeper/ledgers | 【调】Ledger 目录 | 可多目录/多盘 | 大容量 SSD 多盘 |
| indexDirectories | 同 ledger | 索引目录 | 可独立盘提升随机读 | 独立 SSD |
| journalMaxSizeMB | 2048 | 单 journal 文件大小 | 权衡滚动与恢复 | 2048 |
| journalSyncData | true | 写前 fsync | 保证持久化；关掉提吞吐但丢数据风险 | true（生产勿关） |
| journalAdaptiveGroupWrites | true | 组提交 | 提吞吐；低延迟调小 | true |
| journalMaxGroupWaitMSec | 1 | 组提交等待 | 组延迟上限 | 1（默认） |
| journalBufferedWritesThreshold | 524288 | 组提交缓冲阈值 | 决定组提交触发点 | 524288（默认） |
| journalFlushWhenQueueEmpty | false | 空闲立即刷盘 | 追尾延迟敏感可开 | false |
| journalRemovePagesFromCache | true | 写后从页缓存移除 | 平衡页缓存 | true |
| flushInterval | 60000 | entry log 刷盘间隔（ms） | **默认 60000**（旧稿误写 10000）；仅 entryLogPerLedgerEnabled 生效 | 60000 |
| entryLogFilePreallocationEnabled | true | entry log 预分配 | 减少写放大 | true |
| ledgerStorageClass | ...DbLedgerStorage | 3.x 默认存储实现 | 影响读写/GC 行为 | 保持 |
| skipListSizeLimit | 64MB | 读写缓存（EntryMemTable） | 调大提升写缓存 | 默认 |
| dbStorage_readAheadCacheBatchSize | 1000 | 读缓存预取条数 | **默认 1000**（旧稿误写 100）；回溯读多可调大 | 1000 |
| dbStorage_writeCacheMaxSizeMb | （直接内存 1/4） | 写缓存 | 自动分配 | 保持自动 |
| compactionMaxOutstandingRequests | 100000 | GC 压缩时「已写新位置、未更新索引」的条目上限 | 调大省内存但索引更新滞后；官方注释明确「非必要不要改」 | 100000（默认） |
| isForceGCAllowWhenNoSpace | false | 磁盘满强制 GC | 开可回收但可能加速填满 | false |
| diskUsageThreshold | 0.95 | 【调】只读水位 | 超阈值进入只读 | 0.95 |
| diskUsageWarnThreshold | 0.90 | 【调】告警水位（暂停 major compaction） | **默认 0.90**（旧稿误写 0.95）；standalone 与集群读同一份 bookkeeper.conf，不额外放宽 | 0.90 |
| diskUsageLwmThreshold | 0.95 | 【调】恢复读写水位 | **默认与 Threshold 相同 0.95**（旧稿误写 0.90）；低于此恢复读写 | 0.95（或略低于阈值防抖动） |
| diskCheckInterval | 10000 | 水位检查周期 | 越小越及时 | 10000 |

> **磁盘水位三件套关系**：`Threshold(0.95)` 触发只读；`LwmThreshold(0.95)` 低于则恢复读写；`WarnThreshold(0.90)` 触达暂停 major compaction。合理做法：Threshold 与 Lwm 保留一定回差（如 0.95/0.90）防止在只读-读写间抖动。

### 2.3 容错与 GC

| 参数 | 默认值 | 作用/介绍 | 影响 | 建议值 |
|---|---|---|---|---|
| auditorPeriodicBookieCheckInterval | 86400s | Auditor 周期审计（bookie 存活） | 每天一次；过频增负载 | 86400 |
| auditorPeriodicPlacementPolicyCheckInterval | 0（关闭，代码默认） | 周期性检查副本分布是否违反放置策略 | 开启后会把「同机架副本」这类问题标成欠副本并触发重复制，代价是突发 IO | 机架感知部署时设 600~3600 |
| lostBookieRecoveryDelay | 0 | 【调】故障 bookie 隔离后再复制延迟（秒） | 0 会瞬时触发大规模重复制 | 300s（防抖动） |
| autoRecoveryDaemonEnabled | true | 自动恢复 | 必须开否则副本不修复 | true |
| openLedgerRereplicationGracePeriod | 30000ms | 重复制前等待 ledger 自然关闭的宽限 | 太短会对「还开着的 ledger」做无谓处理 | 30000（默认） |
| gcWaitTime | 900000 | ledger GC 等待（ms） | **默认 900000（15 分钟）**（旧稿误写 1000）；standalone 同样是这份 conf，无 300000 的例外 | 900000 |
| gcOverreplicatedLedgerWaitTime | 86400000 | 过多副本清理间隔 | 默认 1 天 | 86400000 |
| minorCompactionThreshold / minorCompactionInterval | 0.2 / 3600s | entry log 小压缩：entry log 中**存活数据占比低于阈值**才压缩 | 阈值调**大**→ 更多文件满足条件→压缩更积极、空间回收更快，代价是 IO/CPU | 默认 0.2；TTL 短、删除频繁可调到 0.3~0.4 |
| majorCompactionThreshold / majorCompactionInterval | **0.5** / 86400s | entry log 大压缩（同上语义，conf 参数名是 `majorCompactionInterval`，不是 `...IntervalSeconds`） | 同上：旧稿写成 0.8 且把方向说反了 | 默认 0.5；磁盘紧张可提到 0.6 |
| useTransactionalCompaction | false | 事务压缩 | 默认关 | false |
| readOnlyModeEnabled | true | 磁盘满进入只读 | 否则直接 shutdown | true |

### 2.4 JVM（conf/bkenv.sh / bk_env.sh）

```bash
# 32G 机器示例：Xms=Xmx 固定堆，剩余物理内存留给 PageCache
BOOKIE_MEM="-Xms16g -Xmx16g -XX:MaxDirectMemorySize=16g"
BOOKIE_GC="-XX:+UseG1GC -XX:MaxGCPauseMillis=10"
```

## 3. zookeeper.conf

| 参数 | 默认值 | 作用/介绍 | 影响 | 建议值 |
|---|---|---|---|---|
| dataDir | data/zookeeper | 【调】数据目录 | 快照/事务日志；SSD | 独立 SSD 目录 |
| clientPort | 2181 | 【调】ZK 客户端端口 | 客户端接入 | 2181 |
| server.N=host:2888:3888 | — | 【调】集群成员（N=myid） | 决定 quorum | 3 台起步 |
| tickTime | 2000 | 心跳基础单位 | — | 2000 |
| initLimit | 10 | 初始化连接超时 | 网络慢可加大 | 10 |
| syncLimit | 5 | 【调】心跳同步超时 | 跨机房可加大 | 5 |
| maxClientCnxns | 60 | 单 IP 连接上限（conf 里注释掉，取代码默认 60） | 防刷；Broker+Bookie 同机时容易撞 | 60，多组件同机时调大 |
| admin.enableServer | **true** | ZK AdminServer（HTTP，默认 9990 端口） | 官方 conf 默认开启；不需要就显式关掉，别让它裸奔 | false，或绑内网并加防火墙 |
| admin.serverPort | 9990 | AdminServer 端口 | 与 Broker 8080/Bookie 8000 不同，注意别撞 | 保持 |
| 4lw.commands.whitelist | （conf 未设） | 四字命令白名单 | 不设时 ZK 只放行少量命令；监控常用 `mntr`、`ruok` | `mntr,ruok`（别写 `*`） |
| autopurge.snapRetainCount / purgeInterval | 3 / **1** | 快照清理（保留份数 / 每 N 小时清一次） | 官方 conf 默认 `purgeInterval=1`；旧稿写 0 | 3 / 1~24 |

> 配置存储 ZK 复用同一发行包：独立部署时用独立 conf 与独立端口（注意 **2181/2888/3888 是本地 ZK，3181 是 Bookie 端口，配置存储 ZK 勿用 3181**，可整体 +100 或另规划），`dataDir` 分开。

## 4. proxy.conf

| 参数 | 默认值 | 作用/介绍 | 影响 | 建议值 |
|---|---|---|---|---|
| metadataStoreUrl / configurationMetadataStoreUrl | （空） | 【调】元数据地址 | 连不上无法服务 | zk 列表 |
| clusterName | （空） | 【调】集群名 | 须一致 | 集群名 |
| servicePort / servicePortTls | 6650 / （空） | 客户端接入端口 | 统一接入点；TLS 端口启用时显式设 6651 | 6650 / 6651 |
| webServicePort / webServicePortTls | 8080 / （空） | Admin 转发端口 | 同上，启用 TLS 时显式设 8443 | 8080 / 8443 |
| brokerServiceURL / brokerWebServiceURL | （空） | 指向集群服务发现 | 代理后端地址 | 集群列表 |
| forwardAuthorizationCredentials | false | 透传客户端凭据 | Proxy 场景建议 true | 按需 |
| authenticationEnabled | false | 【调】认证 | 生产开启 | true |
| superUserRoles | （空） | 【调】超级角色 | 漏配管理被拒 | 管理角色 |
| tlsEnabledInProxy / tlsEnabledWithBroker | false | 【调】TLS | 接入与到 broker 两段 | 按需 |

## 5. client.conf / 生产建议速查

- client.conf：`webServiceUrl`、`brokerServiceUrl`、authPlugin/authParams、tls 配置。
- **生产基线速查**：
  - E=Qw=3, Qa=2（容忍单 bookie 故障，写延迟取决于最快 2 个）
  - Bookie：Journal 用 NVMe 独立盘、Ledger 大容量 SSD；`diskUsageThreshold=0.95`、`Warn=0.90`、`Lwm=0.95`（可留回差防抖动）
  - 开启 `statsProviderClass=PrometheusMetricsProvider`
  - Broker 与 Bookie **分机部署**；`ulimit -n ≥ 100k`；时钟同步（chrony）
  - 保留/积压按业务在 Namespace 级配置，不依赖全局默认

## 6. 新手必读：五组最容易混淆的概念

> 这一节不讲参数，只讲「参数背后的东西是什么」。第一次接触 Pulsar 时，绝大多数配置改错的根因都在这里——不是拼错参数名，而是改了一套其实管不着的机制。

### 6.1 E、Qw、Qa：副本三件套到底在数什么

一条消息写进 BookKeeper 时涉及三个数字，直觉理解是「**摊在几台机器上、要求几台写成功、承认几台算数**」：

| 名字 | 全称 | 白话 | 调大的效果 | 调小的代价 |
|---|---|---|---|---|
| E | Ensemble | 这条 ledger 的数据分散到几台 Bookie 上存放（放置组大小） | 读并行度、可承载的总写带宽上升 | 占用更多 Bookie、元数据更大 |
| Qw | Write Quorum | 一次写入必须落到其中几台 Bookie 才叫「写完」 | 持久性更强 | 写延迟取决于第 Qw 快的机器，通常变慢 |
| Qa | Ack Quorum | 其中几台确认后就先回客户端成功 | 一致性更强 | 低于 Qw 时「已确认但机器不足」的窗口变长 |

硬约束：**E ≥ Qw ≥ Qa**；E 通常取 Qw 的整数倍，不成整数倍时最后一个 ensemble 分组会复用同一批 Bookie，副本分布的保护意义被削弱。常见组合：

- `3/3/2`（本表建议值）：数据摊在 3 台，要求 3 台都写、承认 2 台即返回。**挂 1 台不丢数据、不影响读写**；写延迟由第 2 快的 Bookie 决定。
- `2/2/1`（broker.conf 出厂默认）：机器省一半，但挂 1 台就只剩单副本，属于「测试可用、生产别用」。
- `3/2/2`（延迟优先）：只要 2 台落盘就返回，第 3 台异步补齐；容忍极端情况下的少量数据损失时才用。

一个容易忽略的点：**这三个值是 ledger 创建时快照下去的**，改了 `managedLedgerDefault*` 只影响**之后新滚动出来的 ledger**，正在写的那条 ledger 仍是老配置。所以调完参数看不到立刻变化是正常的，等一次 ledger 滚动（默认最长 240 分钟）再看。

### 6.2 Retention、TTL、Backlog Quota：三套「删数据」机制

新手最常被「消息为什么没了 / 为什么没删」困住，因为它们管的是**不同的对象**，各自独立触发，不存在谁先谁后的流水线：

- **TTL 与 Backlog Quota 管「还没被确认的消息」**：同一条未 ack 的消息，谁的条件先到就按谁处理（先到期就按 TTL，先撑满配额就按配额策略）。
- **Retention 管「已经被所有订阅确认的消息」**：从全部订阅 ack 完的那一刻起才开始计时，与 TTL 无关。

| 机制 | 回答的问题 | 生效对象 | 默认 | 关掉会怎样 |
|---|---|---|---|---|
| TTL（`ttlDurationDefaultInSeconds` / namespace `set-message-ttl`） | 「没被确认的消息最多活多久」 | **未 ack** 的消息 | 0（不做 TTL） | 未 ack 消息永远堆着，直到 ack |
| Backlog Quota（`backlogQuotaDefault*`） | 「积压最多允许占多少磁盘/条数」 | 每个 topic 的**积压总量** | -1（不限） | 慢消费者能把集群磁盘撑爆 |
| Retention（`defaultRetention*`） | 「已经全部 ack 完的消息再多留多久」 | **已 ack** 的消息 | 0（ack 完即可删） | 想回放历史时无从回放 |

三条推论，直接决定日常配置：

1. 想要「消费完还能回放 3 天」→ 只配 **Retention=3d**，TTL 保持 0。
2. 想要「消费者挂了别让消息无限堆」→ 只配 **TTL** 或 **Backlog Quota**，Retention 保持 0。
3. Backlog Quota 的三种触顶策略含义完全不同：`producer_request_hold` 是「压住生产者，等消费者追上」（生产者看到发送超时/重试，不报错丢数据）；`producer_exception` 是「直接给生产者抛异常」（快速失败、好告警，但业务必须处理）；`consumer_backlog_eviction` 是「丢最旧的消息」（会真丢数据，只有可容忍丢失的遥测类链路用）。

> 注意：这些是 **Namespace 级策略**。`broker.conf` 里的 `defaultRetention*`、`backlogQuotaDefault*` 只是「新建 namespace 时继承的默认值」——**已经存在的 namespace 不会因为你改了 broker.conf 而改变**。改完 broker.conf 还要对目标 namespace 执行 `pulsar-admin namespaces set-retention / set-backlog-quota / set-message-ttl`，或新建 namespace 才能吃到新默认。

### 6.3 Subscription、Cursor、Backlog：谁属于谁

```
Topic（一条持久日志）
  └── Subscription（订阅名，如 order-service）        ← 消费组，逻辑概念
        └── Cursor（游标，记录读到哪了）                ← 真正落在 BookKeeper 上的进度
              └── Consumer × N（连上来的客户端实例）    ← 无状态，随时上下线
```

- **订阅属于 topic，不属于客户端**：消费者全下线，订阅和游标还在，消息继续堆积。
- **同一个 topic 上多个订阅互不影响**：这就是「广播」（Fan-out）的实现方式——每个下游建一个订阅名，而不是「多建几个 topic」。
- **积压 = 游标之后未被该订阅消费/确认的消息数**，指标名 `pulsar_broker_msg_backlog`（broker 汇总）或 `pulsar_subscription_back_log`（订阅级）。注意订阅级那个是 `back_log`，中间有下划线，抄监控 PromQL 时容易拼错。
- 只有**所有**订阅都 ack 且过了 Retention 窗口，数据才真正可删。所以「磁盘莫名其妙满」的常见根因是一个早已废弃但没人删的订阅拖住了全部历史。

### 6.4 分区、Bundle、Broker：三层「并行」不是一回事

| 层次 | 由什么决定 | 改变它意味着 |
|---|---|---|
| 分区（Partition） | 建 topic 时指定的物理 topic 数量 | 生产/消费并行度上限；分区数变更会影响 keyed 消息路由 |
| Bundle | Namespace 被切成的**负载分配单元**（`defaultNumberOfNamespaceBundles`） | 负载均衡搬迁的就是 bundle，不是 topic 也不是分区 |
| Broker | 某个 bundle 当前由哪台 broker 负责（服务发现的结果） | 搬迁数据零迁移（broker 无状态），只是所有者换人 |

新手常见误解：「吞吐上不去就加分区」——但如果瓶颈其实是「单个 bundle 把一台 broker 打满」，正确做法是**先让 bundle 重新分配/分裂**（`pulsar-admin namespaces unload <tenant>/<ns>` 强制卸载该 namespace 的所有 bundle 触发重分配，或调低 `loadBalancerNamespaceBundleMaxMsgRate` 让它更早分裂），加分区只解决客户端并行度问题。判断方法：看该 topic 的 owner broker 是否只有 1 台扛全部流量。

### 6.5 动态参数 vs 重启生效：怎么确认自己改对了

本表标【动】的参数支持不重启更新（通过 Admin API 改运行时值），其余必须重启进程。三条实操纪律：

1. **改文件 ≠ 改运行中的进程**：broker.conf 只在启动时被读一次。【动】参数可以用 `pulsar-admin` 热改，但**热改的值不会写回 conf 文件**——下次重启就回落到文件里的值。所以热改验证有效后，务必把同样的值补进 conf，否则下次滚动升级会「神秘回退」。
2. **改 namespace 策略是真持久化**：`pulsar-admin namespaces set-*` 写进元数据，重启不丢，优先级高于 broker 默认值。
3. **BookKeeper 的 journal/ledger 目录类参数不可热改**：`journalDirectory`、`ledgerDirectories`、`diskUsageThreshold` 等只能重启。

## 7. 改完配置怎么确认生效

按这个顺序做完，才算「改好了」，而不是「改完了」：

```bash
# 1) 语法层：进程能起、日志无 ConfigurationException
grep -E 'ERROR|Exception' logs/pulsar-broker-*.log | tail -30

# 2) 运行时值核对（broker 暴露的是当前生效值，不是文件值）
#    brokers 子命令名以 bin/pulsar-admin brokers --help 为准（不同版本有 get-runtime / get-all-runtime-configurations 等）
bin/pulsar-admin brokers --help
bin/pulsar-admin brokers get-runtime --admin-url http://broker1:8080 | grep -iE 'backlog|retention|quorum'

# 3) namespace 是否真的继承到了（优先级比 broker 默认更高）
bin/pulsar-admin namespaces get-retention <tenant>/<ns>
bin/pulsar-admin namespaces get-backlog-quotas <tenant>/<ns>
bin/pulsar-admin namespaces get-message-ttl <tenant>/<ns>

# 4) 行为验证：造一条能证伪的消息，而不是只看指标
bin/pulsar-client produce persistent://<tenant>/<ns>/t -m "probe" -n 1
bin/pulsar-admin topics stats persistent://<tenant>/<ns>/t   # 看 backlog / 游标 / 订阅数是否符合预期

# 5) 逐台灰度：先 1 台 broker（或 1 台 bookie）跑 10~30 分钟，
#    对比 p99 延迟与错误计数，确认无回退再全量。出问题先回滚这一台，而不是全量回滚。
```

「改了没生效」的四个高频原因，按概率排序：

| 现象 | 最可能的真实原因 |
|---|---|
| 改了 broker.conf 但值没变 | 改的是 `standalone.conf`/`proxy.conf` 那份；或参数是 namespace 策略，被已有 namespace 覆盖 |
| Bookie 行为没变 | standalone 与集群共用 `bookkeeper.conf`，改错文件；或该参数只在 ledger 创建时快照，要等滚动 |
| 集群里只有一台生效 | 只重启了一台 broker；配置分发靠 `pulsar-admin` 的 `--admin-url` 指向哪台 |
| 重启后配置又变回去 | 之前是用 Admin 热改的，没写回 conf 文件（见 §6.5） |
