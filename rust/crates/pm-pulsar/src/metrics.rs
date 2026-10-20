use futures::stream::{self, StreamExt};
use pm_core::{
    AggregatedStats, BrokerInfo, ClusterTopology, TopologyEdge, TopologyLimits, TopologyNode,
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

    /// 拓扑：broker 节点 + topic 节点，边表示承载关系。
    /// 归属来源不可得时绝不编造映射——单 broker 集群下所有 topic 必然在它上面，
    /// 这是事实；多 broker 且无归属就标 `none` 让界面明确降级。
    pub async fn cluster_topology(
        &self,
        limits: Option<&TopologyLimits>,
    ) -> AppResult<ClusterTopology> {
        let max_namespaces = clamp(limits.and_then(|l| l.max_namespaces), MAX_NAMESPACES);
        let max_topics = clamp(limits.and_then(|l| l.max_topics), MAX_TOPICS);

        let brokers = self.brokers().await?;
        let mut topology = ClusterTopology {
            nodes: brokers
                .active_brokers
                .iter()
                .map(|name| TopologyNode {
                    id: format!("broker:{name}"),
                    label: name.clone(),
                    kind: "broker".into(),
                    ..Default::default()
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
        topology.truncated = collected.len() > max_topics;
        collected.truncate(max_topics);

        let mut has_owner = false;
        for (tenant, namespace, topic) in collected {
            let stats = self
                .topic_stats(&tenant, &namespace, &topic.name, topic.persistent)
                .await
                .ok();
            let owners = stats
                .as_ref()
                .map(|s| s.owner_brokers.clone())
                .unwrap_or_default();
            if !owners.is_empty() {
                has_owner = true;
            }
            let id = format!(
                "topic:{}://{}",
                if topic.persistent {
                    "persistent"
                } else {
                    "non-persistent"
                },
                topic.name
            );
            topology.nodes.push(TopologyNode {
                id: id.clone(),
                label: topic.short_name().to_string(),
                kind: "topic".into(),
                value: stats
                    .as_ref()
                    .map(|s| s.msg_rate_in + s.msg_rate_out)
                    .unwrap_or(0.0),
                detail: format!("{tenant}/{namespace}"),
            });
            for owner in owners {
                if let Some(broker) = topology
                    .nodes
                    .iter()
                    .find(|node| node.kind == "broker" && broker_matches(&node.label, &owner))
                {
                    topology.edges.push(TopologyEdge {
                        source: broker.id.clone(),
                        target: id.clone(),
                        ..Default::default()
                    });
                }
            }
        }

        if !has_owner {
            let broker_ids: Vec<String> = topology
                .nodes
                .iter()
                .filter(|node| node.kind == "broker")
                .map(|node| node.id.clone())
                .collect();
            if broker_ids.len() == 1 {
                let topic_ids: Vec<String> = topology
                    .nodes
                    .iter()
                    .filter(|node| node.kind == "topic")
                    .map(|node| node.id.clone())
                    .collect();
                for topic_id in topic_ids {
                    topology.edges.push(TopologyEdge {
                        source: broker_ids[0].clone(),
                        target: topic_id,
                        label: "single-broker".into(),
                        ..Default::default()
                    });
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
