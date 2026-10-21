use futures::stream::{self, StreamExt};
use pm_core::{
    AggregatedStats, BrokerInfo, ClusterTopology, TopologyBroker, TopologyLimits, TopologyTopic,
};
use pm_core::{AppResult, Topic};

use crate::client::AdminClient;

const MAX_TENANTS: usize = 50;
const MAX_NAMESPACES: usize = 50;
const MAX_TOPICS_PER_NAMESPACE: usize = 200;
const MAX_TOPICS: usize = 500;
const FANOUT: usize = 6;

impl AdminClient {
    /// broker 列表。不可达必须向上抛：连接状态判定依赖这条链路，
    /// 静默返回空列表会把不可达的集群显示成「在线」。
    pub async fn brokers(&self) -> AppResult<BrokerInfo> {
        let active: Vec<String> = self.get_json("/admin/v2/brokers").await?;
        let all = match self
            .get_opt_json::<Vec<String>>("/admin/v2/brokers/all")
            .await
        {
            Ok(Some(list)) => list,
            _ => active.clone(),
        };
        Ok(BrokerInfo {
            active_brokers: active,
            all_brokers: all,
        })
    }

    /// 全集群聚合：逐层下钻并统计，单 topic / 单命名空间失败只丢它自己的数，
    /// 租户列表拉不动才向上抛（那说明集群不可达）。
    pub async fn aggregated_stats(&self) -> AppResult<AggregatedStats> {
        let mut stats = AggregatedStats::default();
        let tenants = self.tenants().await?;

        for tenant in tenants.into_iter().take(MAX_TENANTS) {
            let namespaces = match self.namespaces(&tenant.name).await {
                Ok(list) => list,
                Err(_) => continue,
            };
            for namespace in namespaces.into_iter().take(MAX_NAMESPACES) {
                let topics = match self.topics(&tenant.name, &namespace).await {
                    Ok(list) => list,
                    Err(_) => continue,
                };
                let count = topics.len();
                let tenant_name = tenant.name.clone();
                let namespace_name = namespace.clone();
                let results: Vec<Option<pm_core::TopicStats>> = stream::iter(
                    topics
                        .into_iter()
                        .take(MAX_TOPICS_PER_NAMESPACE)
                        .map(|topic| {
                            let tenant_name = tenant_name.clone();
                            let namespace_name = namespace_name.clone();
                            async move {
                                self.topic_stats(
                                    &tenant_name,
                                    &namespace_name,
                                    &topic.name,
                                    topic.persistent,
                                )
                                .await
                                .ok()
                            }
                        }),
                )
                .buffer_unordered(FANOUT)
                .collect()
                .await;

                stats.total_topics += count as i64;
                for topic in results.into_iter().flatten() {
                    stats.total_subscriptions += topic.subscriptions.len() as i64;
                    stats.total_producers += topic.producers.len() as i64;
                    stats.total_consumers += topic.all_consumers().len() as i64;
                    stats.total_msg_rate_in += topic.msg_rate_in;
                    stats.total_msg_rate_out += topic.msg_rate_out;
                    stats.total_throughput_in += topic.msg_throughput_in;
                    stats.total_throughput_out += topic.msg_throughput_out;
                    stats.total_partitions += topic.partition_list.len() as i64;
                    stats.total_backlog += topic
                        .subscriptions
                        .values()
                        .map(|subscription| subscription.msg_backlog)
                        .sum::<i64>();
                }
            }
        }
        Ok(stats)
    }

    /// 拓扑：broker 列表 + topic 明细，brokers[].topics 由 topic 的 ownerBrokers 反向聚合。
    /// 归属来源不可得时绝不编造映射——单 broker 集群下所有 topic 必然在它上面，
    /// 这是事实；多 broker 且无归属就标 `none` 让界面明确降级。
    pub async fn cluster_topology(
        &self,
        limits: Option<&TopologyLimits>,
    ) -> AppResult<ClusterTopology> {
        let max_namespaces = clamp(limits.and_then(|l| l.max_namespaces), MAX_NAMESPACES);
        let max_topics = clamp(limits.and_then(|l| l.max_topics), MAX_TOPICS);

        let brokers = self.brokers().await?;
        let single_broker = brokers.active_brokers.len() == 1;
        let mut topology = ClusterTopology {
            brokers: brokers
                .active_brokers
                .iter()
                .map(|name| TopologyBroker {
                    name: name.clone(),
                    topics: Vec::new(),
                })
                .collect(),
            ..Default::default()
        };

        let tenants = self.tenants().await?;
        let mut collected: Vec<(String, String, Topic)> = Vec::new();
        for tenant in tenants.into_iter().take(MAX_TENANTS) {
            let namespaces = self.namespaces(&tenant.name).await.unwrap_or_default();
            for namespace in namespaces.into_iter().take(max_namespaces) {
                let topics = self
                    .topics(&tenant.name, &namespace)
                    .await
                    .unwrap_or_default();
                for topic in topics.into_iter().take(MAX_TOPICS_PER_NAMESPACE) {
                    collected.push((tenant.name.clone(), namespace.clone(), topic));
                }
            }
        }
        let truncated = collected.len() > max_topics;
        collected.truncate(max_topics);

        let mut has_owner = false;
        for (tenant, namespace, topic) in collected {
            let stats = self
                .topic_stats(&tenant, &namespace, &topic.name, topic.persistent)
                .await
                .ok();
            let mut owners = stats
                .as_ref()
                .map(|s| s.owner_brokers.clone())
                .unwrap_or_default();
            if !owners.is_empty() {
                has_owner = true;
            }
            let partition_names = stats
                .as_ref()
                .map(|s| {
                    if s.partition_list.is_empty() {
                        topic.partitions.clone()
                    } else {
                        s.partition_list.clone()
                    }
                })
                .unwrap_or_else(|| topic.partitions.clone());
            let subscriptions = stats
                .as_ref()
                .map(|s| s.subscriptions.keys().cloned().collect())
                .unwrap_or_default();
            let producers = stats
                .as_ref()
                .map(|s| s.producers.len() as i64)
                .unwrap_or(0);
            let consumers = stats
                .as_ref()
                .map(|s| s.all_consumers().len() as i64)
                .unwrap_or(0);
            let msg_rate_in = stats.as_ref().map(|s| s.msg_rate_in).unwrap_or(0.0);
            let msg_rate_out = stats.as_ref().map(|s| s.msg_rate_out).unwrap_or(0.0);
            let backlog_size = stats
                .as_ref()
                .map(|s| s.subscriptions.values().map(|sub| sub.backlog_size).sum())
                .unwrap_or(0);

            // 单 broker 且一条真实归属都没有：所有 topic 必然在它上面，这是事实而不是猜测。
            if owners.is_empty() && single_broker {
                owners.push(brokers.active_brokers[0].clone());
            }

            topology.topics.push(TopologyTopic {
                name: topic.name.clone(),
                tenant: tenant.clone(),
                namespace: namespace.clone(),
                persistent: topic.persistent,
                partition_names,
                owner_brokers: owners,
                subscriptions,
                producers,
                consumers,
                msg_rate_in,
                msg_rate_out,
                backlog_size,
            });
        }

        topology.ownership_source = if has_owner {
            "brokerStats".into()
        } else if single_broker {
            "singleBroker".into()
        } else {
            "none".into()
        };
        if truncated {
            pm_core::pm_warn!(
                "[topology] topic 数量超过上限 {max_topics}，本次只返回前 {max_topics} 个"
            );
        }

        // 反向聚合 broker → topic：只在能匹配上真实归属时才连线。
        for topic in &topology.topics {
            for owner in &topic.owner_brokers {
                if let Some(broker) = topology
                    .brokers
                    .iter_mut()
                    .find(|broker| broker_matches(&broker.name, owner))
                {
                    broker.topics.push(topic.name.clone());
                }
            }
        }
        Ok(topology)
    }
}

fn clamp(value: Option<i64>, max: usize) -> usize {
    match value {
        Some(value) if value > 0 => (value as usize).min(max),
        _ => max,
    }
}

/// `/brokers` 与 `ownerBroker` 可能一个带端口一个不带；对不上就不连线，
/// 不做「看起来差不多算它归属」的猜测。
fn broker_matches(listed: &str, owner: &str) -> bool {
    if listed == owner {
        return true;
    }
    host_part(listed) == host_part(owner)
}

fn host_part(value: &str) -> &str {
    value
        .rsplit_once(':')
        .map(|(host, _)| host)
        .unwrap_or(value)
}
