# 生产环境 Broker/Bookie 参数模板

> 适用 Apache Pulsar 3.x。以「3 ZK + 3 Broker + 4 Bookie、E=Qw=3/Qa=2、TLS 关闭（安全项单独列出）」为基线。所有值需按实际环境（内存、磁盘、吞吐）微调；标注【改】处必须替换为你的环境值。
> 每段注释给出「作用 / 影响 / 建议值」，默认值已按 branch-3.3 官方 conf 核对。

## 目录

- [1. Broker — conf/broker.conf](#1-broker--confbrokerconf)
- [2. Broker — conf/pulsar_env.sh（JVM）](#2-broker--confpulsar_envshjvm)
- [3. Bookie — conf/bookkeeper.conf](#3-bookie--confbookkeeperconf)
- [4. Bookie — conf/bkenv.sh（JVM）](#4-bookie--confbkenvshjvm)
- [5. OS 前置条件（模板生效前提）](#5-os-前置条件模板生效前提)
- [6. 应用模板 Checklist](#6-应用模板-checklist)

## 1. Broker — conf/broker.conf

### 1.1 基础连接

```properties
clusterName=pulsar-cluster-1                              #【改】与 initialize-cluster-metadata 一致
# 3.x 建议直接用 metadataStoreUrl / configurationMetadataStoreUrl（替代旧 zookeeperServers / configurationStoreServers）
metadataStoreUrl=zk:zk1:2181,zk2:2181,zk3:2181            #【改】本地 ZK；缺 schema 默认 ZK
configurationMetadataStoreUrl=zk:zk1:2181,zk2:2181,zk3:2181   #【改】单集群可与本地 ZK 相同
brokerServicePort=6650
webServicePort=8080
advertisedAddress=broker1                                #【改】每台写本机 hostname/IP，多网卡必设
metadataStoreSessionTimeoutMillis=30000
```

### 1.2 副本与托管 Ledger（生产核心）

```properties
# E/Qw/Qa：E≥Qw≥Qa。3/3/2 = 容忍单 bookie 故障，写延迟取决于最快的 2 个
managedLedgerDefaultEnsembleSize=3
managedLedgerDefaultWriteQuorum=3
managedLedgerDefaultAckQuorum=2
managedLedgerMaxEntriesPerLedger=50000        # 减小(如10000)恢复更快但增 ZK 压力
managedLedgerMinLedgerRolloverTimeMinutes=10
managedLedgerMaxLedgerRolloverTimeMinutes=240 # 防止单 ledger 过大
managedLedgerMaxSizePerLedgerMbytes=2048
managedLedgerCacheEvictionWatermark=0.9       # 0.95 提利用率但易触发回压
# 堆外足够时显式设置缓存；不设则按直接内存 1/5 自动
# managedLedgerCacheSizeMB=8192
managedLedgerNewEntriesCheckDelayInMillis=10  # 追尾读延迟敏感可调 1~5
managedLedgerDefaultMarkDeleteRateLimit=10.0  # ack 落盘速率；提吞吐可调大，代价是更多 ZK/BK 写
```

### 1.3 保留、TTL 与积压

```properties
defaultRetentionTimeInMinutes=4320          # 3 天，按业务改
defaultRetentionSizeInMB=0                  # 0=按大小不限
ttlDurationDefaultInSeconds=0               # 保留交给 retention，默认不做 TTL
backlogQuotaCheckEnabled=true               # 积压保护总开关
backlogQuotaDefaultLimitBytes=107374182400     # 100GB，按 namespace 业务量改（3.x 已改名 bytes）
backlogQuotaDefaultRetentionPolicy=producer_exception  # 触顶快速失败，便于告警
retentionCheckIntervalInSeconds=120         # 默认 120；过大会延迟空间回收
```

### 1.4 消费与投递

```properties
maxUnackedMessagesPerConsumer=50000
maxUnackedMessagesPerSubscription=200000
# maxUnackedMessagesPerBroker=0             # 需要 broker 级整体兜底时设
# maxUnackedMessagesPerSubscriptionOnBrokerBlocked=0.16  # 配合上限，阻塞超比例的慢订阅
dispatcherMaxReadBatchSize=100              # broker 从 bookie 批量读条数；回溯读场景可调大(500~1000)
dispatcherMaxRoundRobinBatchSize=20         # Shared 订阅轮询批量
delayedDeliveryEnabled=true                 # 3.x 默认即 true；确定不用延迟消息可 false 省开销
delayedDeliveryMaxDelayInMillis=3600000     # 可选上限 1h；默认 0=无上限，超限报错
delayedDeliveryTickTimeMillis=1000          # 延迟调度 tick；调小提精度增 CPU
subscriptionExpiryCheckIntervalInMinutes=5
maxMessageSize=5242880                      # 5MB
```

### 1.5 Topic 自动化

```properties
allowAutoTopicCreation=true                 # 生产建议 false，用显式建 topic 更可控
allowAutoTopicCreationType=non-partitioned
allowAutoSubscriptionCreation=true
brokerDeleteInactiveTopicsEnabled=true      # 3.x 默认 true；关键 namespace 建议显式关或配长周期
brokerDeleteInactiveTopicsMaxInactiveDurationSeconds=2592000   # 30 天，保护长空闲 topic
brokerDeleteInactiveTopicsMode=delete_when_no_subscriptions    # 只删无订阅无生产者 topic
systemTopicEnabled=true
topicLevelPoliciesEnabled=true
transactionCoordinatorEnabled=false         # 用事务再开
```

### 1.6 负载均衡

```properties
loadBalancerEnabled=true
loadBalancerSheddingEnabled=true
loadBalancerBrokerOverloadedThresholdPercentage=80   # 85→80 提前卸载减少抖动
loadBalancerSheddingIntervalMinutes=1
loadBalancerResourceQuotaUpdateIntervalMinutes=15
defaultNumberOfNamespaceBundles=16          # 按 broker 数 × 3~5 折算
loadBalancerNamespaceBundleMaxMsgRate=30000   # 3.x 默认值
loadBalancerNamespaceBundleMaxBandwidthMbytes=100
```

### 1.7 安全（按需启用，默认关闭）

```properties
authenticationEnabled=false
authorizationEnabled=false
# authenticationProviders=org.apache.pulsar.broker.authentication.AuthenticationProviderToken
# superUserRoles=broker-admin,admin
#authenticateOriginalAuthData=true          # Proxy 透传场景必须 true
#tlsEnabled=false
#tlsCertificateFilePath=/opt/pulsar/cert/broker.crt
#tlsKeyFilePath=/opt/pulsar/cert/broker.key
#tlsTrustCertFilePath=/opt/pulsar/cert/ca.crt
```

## 2. Broker — conf/pulsar_env.sh（JVM）

```bash
# 16G 内存机器示例：堆与直接内存各半
PULSAR_MEM="-Xms8g -Xmx8g -XX:MaxDirectMemorySize=8g"
PULSAR_GC="-XX:+UseG1GC -XX:MaxGCPauseMillis=10"
# 可选：内存充足时预防运行期缺页
OPTS="$OPTS -XX:+AlwaysPreTouch"
```

## 3. Bookie — conf/bookkeeper.conf

### 3.1 基础

```properties
bookiePort=3181
advertisedAddress=bookie1                  #【改】每台必设，否则注册错误 IP
zkServers=zk1:2181,zk2:2181,zk3:2181       #【改】
httpServerEnabled=true
httpServerPort=8000
statsProviderClass=org.apache.bookkeeper.stats.prometheus.PrometheusMetricsProvider
```

### 3.2 磁盘布局（生产必须分盘）

```properties
journalDirectory=/data1/bookkeeper/journal    #【改】独立 NVMe；Journal 决定写延迟上限
ledgerDirectories=/data2/bookkeeper/ledgers,/data3/bookkeeper/ledgers   #【改】大容量 SSD
indexDirectories=/data2/bookkeeper/index       # 可与 ledger 同盘，SSD
```

### 3.3 写路径

```properties
journalSyncData=true                      # 生产勿关（关掉有丢数据风险）
journalMaxSizeMB=2048
journalAdaptiveGroupWrites=true           # 组提交提吞吐
journalMaxGroupWaitMSec=1
journalBufferedWritesThreshold=524288
journalFlushWhenQueueEmpty=false          # 追尾延迟敏感可开
journalRemovePagesFromCache=true
entryLogFilePreallocationEnabled=true
# flushInterval=60000                     # 默认 60000ms；仅 entryLogPerLedgerEnabled 生效
```

### 3.4 读缓存与 Entry Log

```properties
ledgerStorageClass=org.apache.bookkeeper.bookie.storage.ldb.DbLedgerStorage
dbStorage_readAheadCacheBatchSize=1000     # 默认 1000；回溯读多可调大
skipListSizeLimit=67108864                # 64MB 写缓存
# entryLogSizePerLedgerInBytes=           # 默认 2GB，按 ledger 分文件时再设
minorCompactionThreshold=0.2
minorCompactionIntervalSeconds=3600
majorCompactionThreshold=0.8
majorCompactionIntervalSeconds=86400
```

### 3.5 磁盘水位（只读保护）

```properties
# 三件套关系：Threshold 触发只读；Lwm 低于恢复读写（默认同 Threshold）；Warn 触达暂停 major compaction
diskUsageThreshold=0.95                   # 默认 0.95
diskUsageWarnThreshold=0.90               # 默认 0.90
diskUsageLwmThreshold=0.95                # 默认同 Threshold=0.95；可留回差(如0.90)防只读-读写抖动
diskCheckInterval=10000
```

### 3.6 容错与恢复

```properties
autoRecoveryDaemonEnabled=true            # 必须开，否则副本不修复
lostBookieRecoveryDelay=300               # 秒；防瞬时故障触发大规模重复制
auditorPeriodicBookieCheckInterval=86400   # 官方默认每天一次
auditorPeriodicPlacementPolicyCheckInterval=600
rwRereplicateWorkBatchSize=10
gcWaitTime=900000                         # 默认 900000ms(15 分钟)；standalone 为 300000
readOnlyModeEnabled=true                  # 磁盘满进入只读而非 shutdown
```

### 3.7 安全（按需）

```properties
# tlsProvider=OpenSSL
# tlsCertificatePath=/opt/pulsar/cert/bookie.crt
# tlsKeyPath=/opt/pulsar/cert/bookie.key
# tlsTrustCertPath=/opt/pulsar/cert/ca.crt
```

## 4. Bookie — conf/bkenv.sh（JVM）

```bash
# 32G 内存机器示例
BOOKIE_MEM="-Xms16g -Xmx16g -XX:MaxDirectMemorySize=16g"
BOOKIE_GC="-XX:+UseG1GC -XX:MaxGCPauseMillis=10"
# Xms=Xmx 固定堆；剩余物理内存留给 PageCache
```

## 5. OS 前置条件（模板生效前提）

```bash
ulimit -n 1048576
swapoff -a                          # /etc/fstab 同步移除 swap
vm.swappiness = 1
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
# 文件系统 XFS + noatime；NVMe 调度器 none；chrony 时钟同步
```

## 6. 应用模板 Checklist

1. 替换所有【改】项（clusterName、地址、advertisedAddress、磁盘目录）。
2. Broker 与 Bookie JVM 按机器内存减半原则设置堆，剩余留 PageCache/直接内存。
3. 分层存储：长保留场景追加 `managedLedgerOffload*`（S3/OSS）配置。
4. 安全：生产建议启用 Token/mTLS，参考《02》§6。
5. 逐台滚动应用并验证：`pulsar-admin brokers healthcheck`、`bookkeeper shell bookiesanity`、压测基线对比（p99 无回退再全量）。
