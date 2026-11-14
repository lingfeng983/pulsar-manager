//! 告警判定。判定本身是纯函数，取数与事件落库分开：
//! `evaluate` 只负责「这条规则的当前观测值是多少、是否越线」，
//! 事件立案/恢复的持久化由调用方（GUI 的轮询任务）按 `AlertEngine` 的状态完成。

use std::collections::HashMap;

use pm_core::{AlertEvent, AlertRule, AppResult, TopicStats};
use pm_pulsar::AdminClient;

#[derive(Debug, Clone)]
pub struct Observation {
    pub value: f64,
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct RuleEvaluation {
    pub rule_id: String,
    pub rule_name: String,
    pub cluster_id: String,
    pub observation: Option<Observation>,
}

pub fn compare(value: f64, comparator: &str, threshold: f64) -> bool {
    match comparator {
        "gt" | ">" => value > threshold,
        "gte" | ">=" => value >= threshold,
        "lt" | "<" => value < threshold,
        "lte" | "<=" => value <= threshold,
        _ => false,
    }
}

/// 连续 N 次越线才立案：单次抖动不该把人叫起来。
#[derive(Default)]
pub struct AlertEngine {
    counters: HashMap<String, i64>,
}

impl AlertEngine {
    pub fn observe(&mut self, rule: &AlertRule, value: f64) -> bool {
        if !rule.enabled {
            self.counters.remove(&rule.id);
            return false;
        }
        let breached = compare(value, &rule.comparator, rule.threshold);
        let counter = self.counters.entry(rule.id.clone()).or_insert(0);
        if breached {
            *counter += 1;
        } else {
            *counter = 0;
        }
        let required = rule.consecutive.max(1);
        breached && *counter >= required
    }

    pub fn reset(&mut self, rule_id: &str) {
        self.counters.remove(rule_id);
    }
}

pub async fn evaluate(client: &AdminClient, rule: &AlertRule) -> AppResult<RuleEvaluation> {
    let observation = match rule.scope.as_str() {
        "topic" => {
            let stats = client
                .topic_stats(&rule.tenant, &rule.namespace, &rule.topic, rule.persistent)
                .await?;
            Some(Observation {
                value: topic_metric(&stats, &rule.metric),
                label: format!("{}/{}/{}", rule.tenant, rule.namespace, rule.topic),
            })
        }
        "namespace" => {
            let topics = client.topics(&rule.tenant, &rule.namespace).await?;
            let mut total = 0.0;
            for topic in topics {
                // 少一个 topic 的数，合计就偏小，可能把仍在越线的规则判成「已恢复」
                let stats = client
                    .topic_stats(&rule.tenant, &rule.namespace, &topic.name, topic.persistent)
                    .await
                    .map_err(|error| {
                        pm_core::AppError::Other(format!(
                            "采样不完整：topic {} 统计读取失败（{error}）",
                            topic.name
                        ))
                    })?;
                total += topic_metric(&stats, &rule.metric);
            }
            Some(Observation {
                value: total,
                label: format!("{}/{}", rule.tenant, rule.namespace),
            })
        }
        _ => {
            let stats = client.aggregated_stats().await?;
            if stats.failed_samples > 0 {
                return Err(pm_core::AppError::Other(format!(
                    "采样不完整：{} 个命名空间或 topic 读取失败",
                    stats.failed_samples
                )));
            }
            let value = match rule.metric.as_str() {
                "msgRateIn" => stats.total_msg_rate_in,
                "msgRateOut" => stats.total_msg_rate_out,
                // 界面存的键是 throughputIn/throughputOut，aggregated_stats 的字段名带 msg 前缀
                "throughputIn" | "msgThroughputIn" => stats.total_throughput_in,
                "throughputOut" | "msgThroughputOut" => stats.total_throughput_out,
                "backlog" => stats.total_backlog as f64,
                "producers" => stats.total_producers as f64,
                "consumers" => stats.total_consumers as f64,
                "subscriptions" => stats.total_subscriptions as f64,
                "topics" => stats.total_topics as f64,
                "partitions" => stats.total_partitions as f64,
                other => {
                    return Err(pm_core::AppError::Unsupported(format!(
                        "未知告警指标 {other}"
                    )))
                }
            };
            Some(Observation {
                value,
                label: "集群总体".into(),
            })
        }
    };
    Ok(RuleEvaluation {
        rule_id: rule.id.clone(),
        rule_name: rule.name.clone(),
        cluster_id: rule.cluster_id.clone(),
        observation,
    })
}

fn topic_metric(stats: &TopicStats, metric: &str) -> f64 {
    match metric {
        "msgRateIn" => stats.msg_rate_in,
        "msgRateOut" => stats.msg_rate_out,
        "throughputIn" | "msgThroughputIn" => stats.msg_throughput_in,
        "throughputOut" | "msgThroughputOut" => stats.msg_throughput_out,
        "backlog" => stats
            .subscriptions
            .values()
            .map(|subscription| subscription.msg_backlog as f64)
            .sum(),
        "backlogSize" => stats.backlog_size,
        "storageSize" => stats.storage_size,
        "producers" => stats.producers.len() as f64,
        "consumers" => stats.all_consumers().len() as f64,
        "subscriptions" => stats.subscriptions.len() as f64,
        "partitions" => stats.partition_list.len() as f64,
        _ => 0.0,
    }
}

// ========== 指标口径与显示 ==========
//
// 阈值与观测值一律存原生单位（条、条/秒、字节/秒、字节），只有显示时才换算：
// 「用户填的 5 到底是 5 字节还是 5MB」不该跟着界面改动一起漂。

pub struct MetricMeta {
    pub label: String,
    pub unit: &'static str,
    pub scale: f64,
    pub integer: bool,
    pub cluster_supported: bool,
}

pub fn metric_meta(key: &str) -> MetricMeta {
    let build =
        |label: &str, unit: &'static str, scale: f64, integer: bool, cluster_supported: bool| {
            MetricMeta {
                label: label.to_string(),
                unit,
                scale,
                integer,
                cluster_supported,
            }
        };
    match key {
        "backlog" => build("积压消息数", "条", 1.0, true, true),
        "msgRateIn" => build("入向速率", "条/秒", 1.0, false, true),
        "msgRateOut" => build("出向速率", "条/秒", 1.0, false, true),
        // 换算按 1024，单位就写 IEC 的 KiB/MiB，与 shared/alert-metrics.ts 逐字一致：
        // 这两份是同一张表的双写，单位文案漂了就会出现「后台通知说 KB、界面说 KiB」。
        "throughputIn" => build("入向吞吐", "KiB/秒", 1024.0, false, true),
        "throughputOut" => build("出向吞吐", "KiB/秒", 1024.0, false, true),
        "storageSize" => build("存储大小", "MiB", 1024.0 * 1024.0, false, false),
        "producers" => build("生产者数", "个", 1.0, true, true),
        "consumers" => build("消费者数", "个", 1.0, true, true),
        // 认不出的键（手工改过的库）不能把整张表带崩，退回键名本身
        other => build(other, "", 1.0, false, true),
    }
}

/// 千分位 + 最多两位小数，与界面上的 `toLocaleString('zh-CN')` 同一读法。
pub fn format_alert_value(key: &str, value: f64) -> String {
    let meta = metric_meta(key);
    let display = if meta.scale == 0.0 {
        value
    } else {
        value / meta.scale
    };
    if !display.is_finite() {
        return "-".to_string();
    }
    let text = if meta.integer {
        thousands(&format!("{:.0}", display.round()))
    } else {
        thousands(&format!("{:.2}", display))
    };
    if meta.unit.is_empty() {
        text
    } else {
        format!("{text} {}", meta.unit)
    }
}

fn thousands(raw: &str) -> String {
    let (sign, digits) = match raw.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", raw),
    };
    let (whole, fraction) = match digits.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (digits, None),
    };
    let mut grouped = String::with_capacity(whole.len() + whole.len() / 3);
    for (index, ch) in whole.chars().enumerate() {
        if index > 0 && (whole.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    let mut out = format!("{sign}{grouped}");
    if let Some(fraction) = fraction {
        // 两位小数里末尾的 0 不显示，与人读数字的习惯一致
        let trimmed = fraction.trim_end_matches('0');
        if !trimmed.is_empty() {
            out.push('.');
            out.push_str(trimmed);
        }
    }
    out
}

pub struct AlertProbe {
    pub value: f64,
    pub breached: bool,
    pub message: String,
    pub value_text: String,
    pub threshold_text: String,
    pub metric_label: String,
}

/// 「试跑」：即时评估一次，回答「现在这个值是多少、会不会触发」。
pub async fn probe(client: &AdminClient, rule: &AlertRule) -> AppResult<AlertProbe> {
    let evaluation = evaluate(client, rule).await?;
    let value = evaluation
        .observation
        .as_ref()
        .map(|item| item.value)
        .unwrap_or(0.0);
    let label = evaluation
        .observation
        .as_ref()
        .map(|item| item.label.clone())
        .unwrap_or_default();
    Ok(AlertProbe {
        value,
        breached: compare(value, &rule.comparator, rule.threshold),
        message: format!(
            "{} 的 {} 为 {}，{} 阈值 {}",
            label,
            metric_meta(&rule.metric).label,
            format_alert_value(&rule.metric, value),
            if rule.comparator.starts_with('l') {
                "<"
            } else {
                ">"
            },
            format_alert_value(&rule.metric, rule.threshold)
        ),
        value_text: format_alert_value(&rule.metric, value),
        threshold_text: format_alert_value(&rule.metric, rule.threshold),
        metric_label: metric_meta(&rule.metric).label.to_string(),
    })
}

pub fn build_event(rule: &AlertRule, observation: &Observation) -> AlertEvent {
    let now = pm_core::now_ms();
    AlertEvent {
        rule_id: rule.id.clone(),
        cluster_id: rule.cluster_id.clone(),
        rule_name: rule.name.clone(),
        scope_label: observation.label.clone(),
        metric: rule.metric.clone(),
        comparator: rule.comparator.clone(),
        threshold: rule.threshold,
        value: observation.value,
        last_value: observation.value,
        state: "firing".into(),
        message: format!(
            "{} 的 {} 为 {}，{} 阈值 {}",
            observation.label,
            rule.metric,
            pm_core::format_number(observation.value),
            rule.comparator,
            pm_core::format_number(rule.threshold)
        ),
        fired_at: now,
        last_seen_at: now,
        resolved_at: None,
        acked_at: None,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(consecutive: i64) -> AlertRule {
        AlertRule {
            id: "r1".into(),
            enabled: true,
            comparator: "gt".into(),
            threshold: 100.0,
            consecutive,
            ..Default::default()
        }
    }

    #[test]
    fn requires_consecutive_breaches() {
        let mut engine = AlertEngine::default();
        let rule = rule(3);
        assert!(!engine.observe(&rule, 101.0));
        assert!(!engine.observe(&rule, 101.0));
        assert!(engine.observe(&rule, 101.0));
        // 回落一次即清零，下一次越线重新计数
        assert!(!engine.observe(&rule, 10.0));
        assert!(!engine.observe(&rule, 101.0));
    }

    /// 按路径应答的最小 HTTP 服务：路径不在表里一律 500，模拟单个 topic 统计读失败。
    async fn admin_stub(routes: Vec<(&'static str, &'static str)>) -> AdminClient {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let routes = routes.clone();
                tokio::spawn(async move {
                    let mut buffer = vec![0u8; 8192];
                    let mut read = 0;
                    while !buffer[..read].windows(4).any(|w| w == b"\r\n\r\n") {
                        match socket.read(&mut buffer[read..]).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => read += n,
                        }
                    }
                    let head = String::from_utf8_lossy(&buffer[..read]).to_string();
                    let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                    let (status, body) = routes
                        .iter()
                        .find(|(route, _)| *route == path)
                        .map(|(_, body)| ("200 OK", *body))
                        .unwrap_or(("500 Internal Server Error", "boom"));
                    let response = format!(
                        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        AdminClient::new(&pm_core::AdminConfig {
            service_url: "pulsar://127.0.0.1:6650".into(),
            web_service_url: Some(format!("http://{addr}")),
            timeout_ms: 2000,
            auth_plugin: None,
            auth_params: None,
            tls_enabled: false,
            trust_certs: None,
        })
        .unwrap()
    }

    /// 命名空间里有一个 topic 的统计读不到：观测值少了一块，不能当真值去判「已恢复」。
    #[tokio::test]
    async fn namespace_scope_fails_when_any_topic_sample_is_missing() {
        let client = admin_stub(vec![
            (
                "/admin/v2/namespaces/t/n/topics",
                r#"["persistent://t/n/a","persistent://t/n/b"]"#,
            ),
            ("/admin/v2/non-persistent/t/n", "[]"),
            (
                "/admin/v2/persistent/t/n/a/stats",
                r#"{"subscriptions":{"s":{"msgBacklog":5}}}"#,
            ),
        ])
        .await;
        let rule = AlertRule {
            scope: "namespace".into(),
            tenant: "t".into(),
            namespace: "n".into(),
            metric: "backlog".into(),
            ..rule(1)
        };
        let outcome = evaluate(&client, &rule).await;
        assert!(
            outcome.is_err(),
            "缺样本时必须报错，实际 {:?}",
            outcome.map(|e| e.observation)
        );
    }

    #[tokio::test]
    async fn namespace_scope_sums_when_every_sample_is_read() {
        let client = admin_stub(vec![
            (
                "/admin/v2/namespaces/t/n/topics",
                r#"["persistent://t/n/a"]"#,
            ),
            ("/admin/v2/non-persistent/t/n", "[]"),
            (
                "/admin/v2/persistent/t/n/a/stats",
                r#"{"subscriptions":{"s":{"msgBacklog":5}}}"#,
            ),
        ])
        .await;
        let rule = AlertRule {
            scope: "namespace".into(),
            tenant: "t".into(),
            namespace: "n".into(),
            metric: "backlog".into(),
            ..rule(1)
        };
        let observation = evaluate(&client, &rule).await.unwrap().observation.unwrap();
        assert_eq!(observation.value, 5.0);
    }

    #[tokio::test]
    async fn cluster_scope_fails_when_aggregation_dropped_samples() {
        let client = admin_stub(vec![
            ("/admin/v2/tenants", r#"["t"]"#),
            ("/admin/v2/namespaces/t", r#"["t/n"]"#),
            (
                "/admin/v2/namespaces/t/n/topics",
                r#"["persistent://t/n/a","persistent://t/n/b"]"#,
            ),
            ("/admin/v2/non-persistent/t/n", "[]"),
            (
                "/admin/v2/persistent/t/n/a/stats",
                r#"{"subscriptions":{"s":{"msgBacklog":5}}}"#,
            ),
        ])
        .await;
        let rule = AlertRule {
            scope: "cluster".into(),
            metric: "backlog".into(),
            ..rule(1)
        };
        let outcome = evaluate(&client, &rule).await;
        assert!(
            outcome.is_err(),
            "缺样本时必须报错，实际 {:?}",
            outcome.map(|e| e.observation)
        );
    }

    #[test]
    fn comparators_are_strict_where_asked() {
        assert!(compare(101.0, "gt", 100.0));
        assert!(!compare(100.0, "gt", 100.0));
        // 白名单接受 gte/lte，求值也必须真的是「大于等于 / 小于等于」，不能退化成 gt/lt
        assert!(compare(100.0, "gte", 100.0));
        assert!(!compare(99.0, "gte", 100.0));
        assert!(compare(99.0, "lt", 100.0));
        assert!(!compare(100.0, "lt", 100.0));
        assert!(compare(100.0, "lte", 100.0));
        assert!(!compare(101.0, "lte", 100.0));
    }
}
