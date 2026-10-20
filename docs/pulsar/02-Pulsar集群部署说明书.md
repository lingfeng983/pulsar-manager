# Pulsar 集群部署说明书

> 适用版本：Apache Pulsar 3.x（含 2.x 兼容说明）。生产环境部署参考，配合《03-集群配置清单》《07-生产环境参数模板》使用。
> 参数名以 branch-3.3 发行包为准。
>
> **新手请先建立心智模型**（§1）再动手；照抄命令但不知道每步在改什么，是部署失败时最难排查的原因。
> 想先用 5 分钟摸到「一条消息怎么收发」，看《04-单体配置清单》§12，再回来部署集群。

## 目录

- [1. 架构概览](#1-架构概览)
- [2. 环境要求](#2-环境要求)
- [3. 安装](#3-安装)
- [4. 端口规划](#4-端口规划)
- [5. 部署步骤](#5-部署步骤)
- [6. TLS 安全部署（要点）](#6-tls-安全部署要点)
- [7. systemd 托管（推荐替代 pulsar-daemon）](#7-systemd-托管推荐替代-pulsar-daemon)
- [8. 监控](#8-监控)
- [9. 滚动升级流程](#9-滚动升级流程)
- [10. 常见问题](#10-常见问题)
- [11. 新手第一次部署最容易卡住的六件事](#11-新手第一次部署最容易卡住的六件事)

## 1. 架构概览

```
Client ──> Broker (BrokerService + Bookie Client)
              │
              ├── ZooKeeper (本地元数据) ──┬── Configuration Store（全局元数据）
              └── BookKeeper (Bookie 集群，消息持久化)
```

- **Broker**：无状态计算层，处理生产/消费、Topic 路由（bundle）。
- **Bookie**：BookKeeper 存储节点，保存消息 ledger。
- **ZooKeeper**：本地 ZK（集群元数据）+ 配置存储 ZK（多集群共享，单集群部署可复用）。

**为什么是三层，而不是像 Kafka 那样一层**：Broker 只管「谁的消息往哪送、谁订阅到哪」，数据一个字节都不落自己的盘，全交给 Bookie。好处是计算和存储各自独立扩容（Broker 挂了重启即可、没有数据搬迁；Bookie 不够就加机器），代价是部署时要同时伺候三套进程。新手第一次部署的挫败感几乎都来自「三层的元数据/注册信息没对上」，所以 §5 每一步都标注它在写哪一层的元数据。

| 组件 | 存什么 | 丢了会怎样 | 谁连它 |
|---|---|---|---|
| ZooKeeper（本地元数据） | 集群/租户/命名空间/topic 结构、ledger 元数据、Broker 存活注册、bundle 归属 | 元数据丢失＝集群无法解读已有数据，必须靠备份恢复 | Broker、Bookie |
| Configuration Store（全局元数据） | 跨集群共享的租户/命名空间与复制关系 | 单集群可复用本地 ZK，风险同上 | Broker（多集群时） |
| Bookie 磁盘 | 消息本体（ledger / entry log / index）+ journal | 副本不足时消息真丢 | Broker（客户端不直连） |
| Broker 内存 | 只有路由、游标缓存、页缓存 | 重启即恢复，无数据丢失 | 客户端 |

> 3.x 已将元数据访问抽象为 `metadataStoreUrl`（默认 `zk:`），配置存储为 `configurationMetadataStoreUrl`。新部署建议直接使用新参数（见《03》§1.1）。

## 2. 环境要求

| 项 | 最低建议 | 生产建议 | 影响说明 |
|---|---|---|---|
| OS | Linux x86_64 | Linux x86_64（禁用 swap，XFS） | XFS 大文件/顺序写友好；swap 会引发 GC 抖动 |
| JDK | 17（3.x）/ 11（2.10-2.11）/ 8（≤2.9） | 官方 Temurin 17 | 3.x 强制 JDK17；版本不符直接启动失败 |
| CPU | 4C | 16C+（Broker 与 Bookie 分机） | Broker 靠 CPU 做路由/批量/压缩 |
| 内存 | 8G | Broker 16G+ / Bookie 32G+ | 堆与直接内存各半；Bookie 大量堆外+PageCache |
| 磁盘 | SSD | Journal：NVMe×2（RAID1）；Storage：SSD/HDD 多盘 | Journal 决定写延迟上限；与 Ledger 必须分盘 |
| 网络 | 万兆内网 | 万兆，节点间 RTT < 1ms | 跨机房 RTT 影响复制与 ZK 心跳 |
| 端口 | 见 §4 | — | 提前放行防火墙 |

**集群规模建议**：3 台 Broker + 3 台 Bookie 起步（生产推荐 ≥4~5 Bookie 以便滚动维护，E=3 至少 3 台）。

## 3. 安装

```bash
# 下载（示例 3.3.x；版本选择见《08-高危缺陷整理》§3，推荐分支最新 patch）
wget https://archive.apache.org/dist/pulsar/pulsar-3.3.9/apache-pulsar-3.3.9-bin.tar.gz
tar -xzf apache-pulsar-3.3.9-bin.tar.gz -C /opt
ln -s /opt/apache-pulsar-3.3.9 /opt/pulsar
```

所有节点（Broker / Bookie / ZK）均需解压同一发行包。**校验发行包 SHA256**，避免下载被篡改。

## 4. 端口规划

| 端口 | 组件 | 用途 |
|---|---|---|
| 2181 | ZooKeeper | ZK 客户端 |
| 2888/3888 | ZooKeeper | ZK 内部（leader 选举） |
| 6650 | Broker | Pulsar 二进制协议 |
| 8080 | Broker | HTTP Admin/WebSocket |
| 8443 / 6651 | Broker | TLS Admin / TLS 二进制（若启用 TLS） |
| 3181 | Bookie | Bookie Server 默认端口（`bookiePort`） |
| 8000 | Bookie | Bookie HTTP Admin / Prometheus metrics |
| 6650 / 6651 | Proxy（若启用） | 客户端二进制 / TLS 接入 |
| 8080 / 8443 | Proxy（若启用） | Admin HTTP / TLS 转发 |

> 若配置存储 ZK 与本地 ZK 独立部署，通常将端口整体 +100（2281/2388/2488 等），自行规划即可。注意 **3181 是 Bookie 端口**，配置存储 ZK 勿占用 3181。

## 5. 部署步骤

**顺序不能换的原因**：ZK 是所有其它组件写元数据的地方，所以它必须先在；`initialize-cluster-metadata` 是在 ZK 里「登记这个集群的身份」，Broker 与 Bookie 启动时都要读它才能确认自己属于哪个 cluster；Bookie 起来才会在 `/ledgers` 下注册自己，Broker 第一次有消息要写时才会发现「有可用 Bookie」。跳步的典型症状是 Broker 能启动但生产报 `NoWritableBookiesFound`，或 Bookie 起来了却没进集群。

```
ZK 起 → initialize-cluster-metadata（只做一次）→ Bookie 起并注册 → Broker 起 → 冒烟测试 →（可选）Proxy
```

### 5.1 部署 ZooKeeper（3 节点，zk1-zk3）

编辑 `conf/zookeeper.conf`：

```properties
# zk1 示例
server.1=zk1:2888:3888
server.2=zk2:2888:3888
server.3=zk3:2888:3888
# 建议生产参数
admin.enableServer=true
# 4lw 白名单按需放开最小命令集，不要用 *（srst 会重置统计，mntr/ruok 够监控用）
4lw.commands.whitelist=mntr,ruok
```

各节点写 myid：

```bash
echo 1 > data/zookeeper/myid   # zk2 为 2，zk3 为 3
```

启动：`bin/pulsar-daemon start zookeeper`（或 systemd，见 §7）。

**配置存储 ZK（Configuration Store）独立部署**（仅多集群/跨区域时必要）：
- 单集群可复用本地 ZK；但未来要扩展为多集群 Geo-Replication 时，配置存储须独立成集群，否则全局元数据无法跨集群协调。
- 独立部署做法：复用同一发行包，用 `conf/global-zookeeper.conf`（若提供）或另写一套 conf，端口整体 +100（2181→2281、2888→2388、3888→2488），`dataDir` 单独分区，避免与本地 ZK 混用端口/数据。
- 部署顺序：先配置存储 ZK，再本地 ZK，再 `initialize-cluster-metadata`（此时 `--configuration-store` 指向配置存储 ZK）。

### 5.2 初始化集群元数据（任意一台执行一次）

```bash
bin/pulsar initialize-cluster-metadata \
  --cluster pulsar-cluster-1 \
  --zookeeper zk1:2181,zk2:2181,zk3:2181 \
  --configuration-store zk1:2181,zk2:2181,zk3:2181 \
  --web-service-url http://broker1:8080,broker2:8080,broker3:8080 \
  --web-service-url-tls https://broker1:8443,... \
  --broker-service-url pulsar://broker1:6650,broker2:6650,broker3:6650 \
  --broker-service-url-tls pulsar+ssl://broker1:6651,...
```

> 单集群部署时 configuration-store 可与本地 ZK 相同；3.x 中该项非必填（`configurationMetadataStoreUrl` 为空时回退本地元数据地址），但生产建议显式给出，便于未来多集群扩展。**只执行一次**，重复执行会因已存在而失败。

### 5.3 部署 Bookie（bookie1-bookie3）

编辑 `conf/bookkeeper.conf`（完整参数见《03》§2、《07》§3）：

```properties
advertisedAddress=bookie1
zkServers=zk1:2181,zk2:2181,zk3:2181
journalDirectory=/data1/bookkeeper/journal        # 独立 NVMe 盘（决定写延迟上限）
ledgerDirectories=/data2/bookkeeper/ledgers,/data3/bookkeeper/ledgers   # 大容量 SSD 多盘
indexDirectories=/data2/bookkeeper/index          # 可与 ledger 同盘
```

**磁盘布局原则**（详见《05》§3.1）：Journal 与 Ledger **必须分盘**，否则 fsync 会干扰读 I/O。建议目录挂载为 XFS（noatime）、NVMe 调度器 `none`；多盘用逗号分隔声明目录，Bookie 会自动分摊。

格式化并启动：

```bash
bin/bookkeeper shell metaformat   # 首次部署、且 ZK 中无 /ledgers 时执行（交互确认）
bin/pulsar-daemon start bookie
```

验证：`bin/bookkeeper shell bookiesanity` 返回 "Bookie sanity test succeeded"。

> `advertisedAddress` 必须设置，否则多网卡会注册错误 IP（见《03》§2.1）。

### 5.4 部署 Broker（broker1-broker3）

编辑 `conf/broker.conf`（完整参数见《03》§1、《07》§1）：

```properties
metadataStoreUrl=zk:zk1:2181,zk2:2181,zk3:2181
configurationMetadataStoreUrl=zk:zk1:2181,zk2:2181,zk3:2181
brokerServicePort=6650
webServicePort=8080
clusterName=pulsar-cluster-1
advertisedAddress=broker1
```

> **两个必须照抄的细节**：① `metadataStoreUrl` 的值要带 **`zk:` 前缀**（元数据后端类型），漏了会在启动时报无法解析 store 类型；② 逗号后的第 2、3 个地址只写 `host:port`，共用第一个地址的 scheme。
> 3.x 建议直接使用 `metadataStoreUrl` / `configurationMetadataStoreUrl`（替代旧的 `zookeeperServers` / `configurationStoreServers`）。

启动：`bin/pulsar-daemon start broker`

### 5.5 验证

```bash
# 集群状态
bin/pulsar-admin clusters list
bin/pulsar-admin brokers healthcheck

# 冒烟测试
bin/pulsar-client produce persistent://public/default/test -m "hello"
bin/pulsar-client consume persistent://public/default/test -s smoke -n 1
```

这四条分别证明不同的事情，失败时按这个对应关系定位，别笼统地说「集群起不来」：

| 命令 | 证明 | 失败通常意味着 |
|---|---|---|
| `clusters list` | Broker 已连上元数据、能读到 cluster 登记 | `metadataStoreUrl` 写错（含漏 `zk:` 前缀）、或没执行 `initialize-cluster-metadata` |
| `brokers healthcheck` | 每台 broker 认为自己可达且元数据/BookKeeper 客户端正常 | 有 broker 没起来、`advertisedAddress` 指向不可达地址 |
| `produce` | 真的写进了 Bookie（走完整数据链路） | `NoWritableBookiesFound`＝Bookie 没注册成功；`TopicNotFound`＝自动建 topic 被关 |
| `consume` | 游标与投递链路正常 | 订阅名/位置问题；消费者被 `maxUnacked` 卡住 |

> `produce` 是唯一能证伪「存储层可用」的命令——前两条只验证元数据。只看 healthcheck 通过就上线，是新集群最常见的事故来源。

### 5.6（可选）部署 Proxy

`conf/proxy.conf` 关键项：

```properties
metadataStoreUrl=zk:zk1:2181,zk2:2181,zk3:2181
configurationMetadataStoreUrl=zk:zk1:2181,zk2:2181,zk3:2181
clusterName=pulsar-cluster-1
```

启动：`bin/pulsar-daemon start proxy`。客户端统一连 Proxy 6650/8080。**Proxy 永不直接暴露公网**，置于 LB/防火墙后（见《08》防护建议）。

> Proxy 与 Broker 的区别在于它自己不承载 topic：它靠元数据发现集群里的 broker，再把请求转发过去。
> 因此排障时「Proxy 报连不上 broker」多半是 `advertisedAddress` 通告的 IP/hostname 在 Proxy 所在网段不可达，而不是 Proxy 配置写错。
> 不想让 Proxy 直连 ZK 时，可改用 `brokerServiceURL` / `brokerWebServiceURL` 静态指向（见《03》§4），或启用 message broker tunnel 模式。

## 6. TLS 安全部署（要点）

1. 用 cert-manager 或 openssl 生成 CA、Broker/Bookie/客户端证书。
2. Broker：`broker.conf` 中启用 `tlsEnabled=true`，配置 `tlsCertificateFilePath/tlsKeyFilePath/tlsTrustCertFilePath`，并把 `brokerServicePortTls=6651`、`webServicePortTls=8443` 显式设出来（**这两个端口在 conf 里默认是空的，不会因为开了 TLS 就自动监听**）。
3. Bookie：`bookkeeper.conf` 启用 `tlsProvider=OpenSSL` 等并配置证书。
4. 客户端使用 `pulsar+ssl://` 与信任证书。
5. 启用认证授权：`authenticationEnabled=true` + `authorizationEnabled=true`。用 Token（JWT）时，Apache Pulsar 的 `pulsar-admin` **没有 `tokens create` 子命令**（那是 Pulsar Manager/发行版提供的图形化能力）；官方做法是用密钥对自行签发：

```bash
# 1) 生成密钥对（生产用 private/pub 两份，别用默认 secret.key 上线）
openssl genrsa -out private.key 2048
openssl rsa -in private.key -pubout -out public.key

# 2) broker.conf / proxy.conf
#    authenticationEnabled=true
#    authenticationProviders=org.apache.pulsar.broker.authentication.AuthenticationProviderToken
#    tokenSecretKey=file:///opt/pulsar/cert/private.key     # 或 file: 指向 public.key（HTTP 认证用对称/非对称皆可）
#    brokerClientAuthenticationParameters=file:///opt/pulsar/cert/private.key
#    superUserRoles=admin                                    # 漏配则管理操作全被拒

# 3) 签一个客户端用的 token：官方文档用 jwt-cli / 各语言 SDK 生成，
#    内容就是 {"sub": "<角色名>"} 的 HS256/RS256 签名
bin/pulsar-admin --auth-plugin org.apache.pulsar.client.impl.auth.AuthenticationToken \
  --auth-params "token:<你的 token>" clusters list           # 带着 token 验证一次
```

> 启用 TLS 后注意：证书轮换需规划（broker 有 `tlsCertRefreshCheckDurationSec=300`）；启用认证后务必配置 `superUserRoles`，否则管理操作全被拒。

## 7. systemd 托管（推荐替代 pulsar-daemon）

编写 `/etc/systemd/system/pulsar-broker.service`（bookie/zk/proxy 同理，仅改 ExecStart 组件名与 Description）：

```ini
[Unit]
Description=Pulsar Broker
After=network.target

[Service]
Type=forking
User=pulsar
Environment=JAVA_HOME=/usr/lib/jvm/temurin-17
ExecStart=/opt/pulsar/bin/pulsar-daemon start broker
ExecStop=/opt/pulsar/bin/pulsar-daemon stop broker
LimitNOFILE=1048576
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

启用：`systemctl daemon-reload && systemctl enable --now pulsar-broker`。ZK、Bookie、Proxy 各建一个 unit 即可。

> **Auditor 不用单独起进程**。它是 AutoRecovery 的一部分：只要各 Bookie 的 `bookkeeper.conf` 里 `autoRecoveryDaemonEnabled=true`，多台 recovery 节点会自己协调出谁当 Auditor。
> 也就是说，「副本不自动修复」通常不是没起某个进程，而是这个开关没开或恢复节点都挂了——排查用 `bin/bookkeeper shell listunderreplicated`。

## 8. 监控

- Prometheus 抓取：Broker `http://broker:8080/metrics`、Bookie `http://bookie:8000/metrics`。
  Bookie 这个端点由 `statsProviderClass=PrometheusMetricsProvider` + `prometheusStatsHttpPort=8000` 提供，**与 `httpServerEnabled` 无关**（后者官方 conf 默认 false，只影响 Bookie 自己的 Admin API）。
- 关键指标（名字以《官方 reference-metrics》为准，抄 PromQL 前先用 `curl :8080/metrics | grep <名字>` 确认本版本确实导出）：
  - 吞吐与连接：`pulsar_broker_rate_in` / `pulsar_broker_rate_out`、`pulsar_broker_producers_count` / `pulsar_broker_consumers_count`、`pulsar_broker_topics_count`
  - 存储写延迟：`pulsar_storage_write_latency_le_1 / _le_10 / _le_100 / _le_1000`（**是分桶直方图，没有裸的 `pulsar_storage_write_latency`**）
  - 积压：`pulsar_broker_msg_backlog`（broker 汇总）、`pulsar_subscription_back_log`（订阅级，注意是 `back_log` 带下划线）
  - 负载均衡：`pulsar_lb_unload_bundle_total`、`pulsar_broker_lookup_failures`
  - Bookie 侧：journal 队列与写延迟相关指标（`bookie_journal_` 前缀），以及 `pulsar_broker_storage_write_rate`
- 部署 Grafana + 官方 Pulsar/BookKeeper dashboard 模板。
- 建议告警项：订阅积压持续增长、Bookie 磁盘水位、ZK 会话超时（详见《06》§8）。

## 9. 滚动升级流程

1. **Broker**：逐台 `pulsar-daemon stop broker` → 升级包（**备份 conf**，diff 保留自定义项）→ `pulsar-daemon start broker`。Broker 无状态，先升 Broker 无数据风险。
2. **Bookie**：升级前确保其他 bookie 有足够容量，`bookkeeper shell listunderreplicated` 为空再逐台滚动；先停再升再起，逐台确认 `bookiesanity`。
3. **ZK**：逐台滚动升级，保证 quorum 存活（一次只停一台）。
4. 顺序建议：先 Broker（可回退），再 Bookie，最后 ZK；升级后对比压测基线（p99 无回退）。

## 10. 常见问题

| 现象 | 排查 |
|---|---|
| Broker 起不来，连不上 ZK | 检查 2181 端口、myid、`initialize-cluster-metadata` 是否执行 |
| Bookie 注册失败 | `bookkeeper.conf` 的 zkServers、`advertisedAddress` 与 journal 目录权限 |
| Topic 无法创建 | 检查 `clusterName` 与 metadata 中集群名一致 |
| 消息积压 | 查看 `pulsar_broker_msg_backlog` / `pulsar_subscription_back_log`，确认消费者存活、`maxUnacked` 是否打满、配额是否触发 |
| 元数据 session 过期 | 检查 `zookeeperSessionExpiredPolicy`（3.x 默认 `reconnect`）与 GC 停顿 |

## 11. 新手第一次部署最容易卡住的六件事

按「踩中概率」排序，每条给出自查命令。前四条几乎都是配置问题，不用改代码、不用重装。

**① `advertisedAddress` 没设，多网卡机器通告了错的 IP。** 症状：客户端第一次 lookup 成功，之后 `Connection refused` 或超时——因为它拿到了一个内网/容器网段的地址。

```bash
# 看 broker 实际通告了什么（不是看你 conf 写了什么）
bin/pulsar-admin brokers list <你的 clusterName>
# 每一台都必须写自己的 hostname 或业务网 IP，不能是 127.0.0.1
```

**② `initialize-cluster-metadata` 重复执行或参数与 broker.conf 不一致。** 它只允许成功执行一次；`--cluster` 的值和 `broker.conf` 的 `clusterName` 必须逐字符相同。

```bash
bin/pulsar-admin clusters list            # 这里出现的名字就是元数据里登记的 clusterName
```

**③ Bookie 起来了但没进集群。** 常见于 `zkServers` 指向了另一套 ZK（比如指到了配置存储 ZK 的端口），或 `journalDirectory` 目录权限属于别的用户。

```bash
bin/bookkeeper shell listbookies -rw      # 可写 bookie 列表应包含全部节点
bin/bookkeeper shell bookiesanity         # 端到端读写一次
```

**④ 三个 `diskUsage*` 水位与 `lostBookieRecoveryDelay` 用了出厂值就上生产。** 磁盘 95% 才只读、故障 0 秒就触发全量重复制，这两条在小集群上会造成雪崩式抖动。见《03》§2.2、§2.3 的建议值。

**⑤ ZK 只在 `bin/pulsar-daemon start zookeeper` 之后就算「部署好了」，没验证 quorum。** 三台 ZK 里有两台没互相连上时，Pulsar 侧一切正常，直到任意一台挂掉才发现没有多数派。

```bash
# 每台都要返回 mode: leader 或 follower（standalone 才算没组集群）
echo ruok | nc <zk-host> 2181             # 期望 imok（需 4lw.commands.whitelist 放行 ruok）
echo mntr | nc <zk-host> 2181 | grep zk_serverState
```

**⑥ 防火墙只放了 8080，忘了 6650。** 6650 才是消息进出的口，8080 只是 Admin/HTTP。典型症状：`pulsar-admin` 一切正常，客户端连不上或生产超时。跨机部署时还要放行 Bookie 3181 与 ZK 2181/2888/3888。

> 六条都过了再去看性能与调优。顺序建议：《04》§12 单体练手 → 本文件 §5 集群部署 → §11 自查 → 《07》套生产模板 → 《05》调优。
