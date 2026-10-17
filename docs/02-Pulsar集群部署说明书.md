# Pulsar 集群部署说明书

> 适用版本：Apache Pulsar 3.x（含 2.x 兼容说明）。生产环境部署参考，配合《03-集群配置清单》《07-生产环境参数模板》使用。
> 参数名以 branch-3.3 发行包为准。

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
metadataStoreUrl=zk1:2181,zk2:2181,zk3:2181
configurationMetadataStoreUrl=zk1:2181,zk2:2181,zk3:2181
brokerServicePort=6650
webServicePort=8080
clusterName=pulsar-cluster-1
advertisedAddress=broker1
```

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

### 5.6（可选）部署 Proxy

`conf/proxy.conf` 关键项：

```properties
metadataStoreUrl=zk1:2181,...
configurationMetadataStoreUrl=zk1:2181,...
clusterName=pulsar-cluster-1
```

启动：`bin/pulsar-daemon start proxy`。客户端统一连 Proxy 6650/8080。**Proxy 永不直接暴露公网**，置于 LB/防火墙后（见《08》防护建议）。

## 6. TLS 安全部署（要点）

1. 用 cert-manager 或 openssl 生成 CA、Broker/Bookie/客户端证书。
2. Broker：`broker.conf` 中启用 `tlsEnabled=true`，配置 `tlsCertificateFilePath/tlsKeyFilePath/tlsTrustCertFilePath`。
3. Bookie：`bookkeeper.conf` 启用 `tlsProvider=OpenSSL` 等并配置证书。
4. 客户端使用 `pulsar+ssl://` 与信任证书。
5. 可启用认证授权：`authenticationEnabled=true`，Provider 用 Token 时创建 `pulsar-admin tokens create`。

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

启用：`systemctl daemon-reload && systemctl enable --now pulsar-broker`。Bookie/Bookie-AutoRecovery/ZK/Proxy 各建一个 unit；Auditor 需单独运行。

## 8. 监控

- Prometheus 抓取：Broker `http://broker:8080/metrics`、Bookie `http://bookie:8000/metrics`。
- 关键指标：`pulsar_broker_*`（吞吐、连接）、`pulsar_storage_write_latency`、`bookie_journal_*`、`pulsar_subscription_backlog`。
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
| 消息积压 | 查看 `pulsar_subscription_backlog`，确认消费者存活与配额 |
| 元数据 session 过期 | 检查 `zookeeperSessionExpiredPolicy`（3.x 默认 `reconnect`）与 GC 停顿 |
