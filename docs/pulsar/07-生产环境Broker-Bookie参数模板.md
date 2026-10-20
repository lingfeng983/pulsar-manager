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
- [7. 新手：从零按模板部署的分步流程](#7-新手从零按模板部署的分步流程)

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
managedLedgerDefaultMarkDeleteRateLimit=10.0  # 每写 N 条 entry 落一次游标（broker.conf 默认 1.0）；调大省 ZK/BK 写，代价是崩溃后重复投递更多
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
minorCompactionInterval=3600              # conf 里的参数名就是这个，注意别自己加 Seconds
majorCompactionThreshold=0.5              # 官方默认 0.5；调到 0.6=压缩更积极、空间回收更快但 IO 更多
majorCompactionInterval=86400             # 同上
```

> 阈值语义（新手最容易搞反的一处）：compaction 阈值判的是「entry log 里**仍然存活**的数据占比」，**低于**阈值的文件才会被压缩。
> 想把空间榨得更干，是把阈值**调大**（让更多文件进入压缩条件），不是调小。详见《05》§3.3。

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
autoRecoveryDaemonEnabled=true            # 必须开，否则副本不修复（Auditor 由恢复节点自己选出，不用单独起进程）
lostBookieRecoveryDelay=300               # 秒；防瞬时故障触发大规模重复制（默认 0=立刻重复制）
auditorPeriodicBookieCheckInterval=86400   # 官方默认每天一次
auditorPeriodicPlacementPolicyCheckInterval=600   # 代码默认 0（关闭）；这里显式开=定期巡检副本是否违反机架策略
openLedgerRereplicationGracePeriod=30000  # 重复制前等 ledger 自然关闭的宽限（ms，默认值）
gcWaitTime=900000                         # 默认 900000ms(15 分钟)；standalone 读的也是 bookkeeper.conf，无例外
readOnlyModeEnabled=true                  # 磁盘满进入只读而非 shutdown
```

> 重复制的节奏由 `lostBookieRecoveryDelay`、`openLedgerRereplicationGracePeriod` 与 Auditor 的两个检查周期共同决定，**没有单独的「批量大小」开关**（订正记录见《08》§5.1）。

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

## 7. 新手：从零按模板部署的分步流程

> §6 是「改完之后的检查」，这一节是「改之前到改完之后的完整动作序列」。
> 每一步都写了「做完应该看到什么」——看不对就停下排查，别带着红灯往下走，后面每一步都会继承这个错。

### 7.1 先分清你要改的是哪一份 conf

| 你动的东西 | 正确文件 | 常见错法 |
|---|---|---|
| Broker（端口、副本数、保留、配额、认证） | `conf/broker.conf` | 改了 `standalone.conf`（那是单体的），或改了 `proxy.conf` 里的同名项 |
| Bookie（journal/ledger 目录、磁盘水位、GC） | `conf/bookkeeper.conf` | 在 broker.conf 里找 `journalSyncData`；或改了 broker 机器上的 conf 以为 bookie 会读 |
| ZK | `conf/zookeeper.conf` | 配置存储 ZK 复用了本地 ZK 的 conf 却改了端口，两边打架 |
| JVM 内存 | `conf/pulsar_env.sh`（Broker）/ `conf/bkenv.sh`（Bookie） | 在 conf 里写 `-Xmx`（不会生效） |
| 客户端/管理工具默认地址 | `conf/client.conf`、`conf/admin.conf` | 以为改 broker.conf 就能让客户端知道地址 |

每台机器只需要它自己那部分：Broker 机器发 `broker.conf`+`pulsar_env.sh`，Bookie 机器发 `bookkeeper.conf`+`bkenv.sh`，ZK 机器发 `zookeeper.conf`。**同一份文件在所有同类节点上必须只差 `advertisedAddress`**，否则负载会倾斜。

### 7.2 按顺序执行（含每步的验收点）

```bash
# ① OS 前置（§5）：所有节点
ulimit -n 1048576; swapoff -a; systemctl enable --now chronyd
# 验收：ulimit -n 输出 1048576；free 里 Swap 为 0；timedatectl 显示 NTP synchronized

# ② 起 ZK 三台
bin/pulsar-daemon start zookeeper
# 验收：每台 echo mntr | nc <host> 2181 返回含 zk_serverState；三台里恰好 1 leader 2 follower

# ③ 登记集群身份（只做一次）
bin/pulsar initialize-cluster-metadata --cluster pulsar-cluster-1 \
  --zookeeper zk1:2181,zk2:2181,zk3:2181 --configuration-store zk1:2181,zk2:2181,zk3:2181 \
  --web-service-url http://broker1:8080,broker2:8080,broker3:8080 \
  --broker-service-url pulsar://broker1:6650,broker2:6650,broker3:6650
# 验收：日志出现 successfully；重复执行会报已存在（这是正常的，不代表部署失败）

# ④ 格式化 BookKeeper 元数据（首次部署且 /ledgers 不存在时）
bin/bookkeeper shell metaformat
# 验收：交互确认后无异常；再次执行会提示已存在

# ⑤ 起 Bookie 三~四台
bin/pulsar-daemon start bookie
# 验收：bin/bookkeeper shell listbookies -rw 列出全部节点，且 IP/hostname 是你期望的 advertisedAddress
# 验收：bin/bookkeeper shell bookiesanity 通过

# ⑥ 起 Broker
bin/pulsar-daemon start broker
# 验收：logs/pulsar-broker-*.log 无 ConfigurationException；bin/pulsar-admin brokers list pulsar-cluster-1 数量对

# ⑦ 端到端验证（这一步才是「能用」）
bin/pulsar-client produce persistent://public/default/probe -m ok -n 1
bin/pulsar-client consume persistent://public/default/probe -s probe -n 1 -p Earliest
bin/pulsar-admin topics stats persistent://public/default/probe   # backlog 归零、订阅数 1

# ⑧ 建业务租户/命名空间，把 §1.3 的保留与配额落到 namespace 级
bin/pulsar-admin tenants create biz --allowed-clusters pulsar-cluster-1
bin/pulsar-admin namespaces create biz/prod
bin/pulsar-admin namespaces set-retention biz/prod --size 1G --time 3d
bin/pulsar-admin namespaces set-backlog-quota biz/prod --limitSize 100G --type producer_exception
bin/pulsar-admin namespaces set-message-ttl biz/prod --messageTTL 0
# 验收：三条 get-* 回读出来的值与你设的一致（《03》§6.2：broker.conf 只是新 namespace 的默认值）

# ⑨ 建基线并留档（之后所有调优都对照这份数）
bin/pulsar-perf produce persistent://biz/prod/perf -np 8 -r 5000 -s 1024 -time 600 -au http://broker1:8080
```

### 7.3 只有 8 步都绿了，才动 §1.2 之后的性能参数

模板里 §1.2~§1.6 的值是「生产可用」而不是「最优」。第一次部署的正确目标是小范围内**行为可预测**（副本数对、水位对、配额生效、能重放），性能调优等到业务流量特征清楚再做，方法见《05》§9。
