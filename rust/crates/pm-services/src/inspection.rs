//! 集群巡检：一次只读采集 + 一组判定规则，产出一份能直接发给别人的报告。
//!
//! 判定全部是纯函数，可以不连集群单测；口径与文案严格对齐
//! `src/main/services/cluster-inspection.ts` 与 `inspection-diff.ts`：
//! 报告要能脱离应用被读懂，所以「采样范围」「截断」「口径是否被改过」都要写在里面。

use futures::stream::{self, StreamExt};
use pm_core::{
    AppError, AppResult, CheckLevel, InspectionCheck, InspectionReport, InspectionScope,
    InspectionThresholds, InspectionTotals, TopicStats,
};
use pm_pulsar::AdminClient;

// ========== 口径 ==========

pub const DEFAULT_MAX_NAMESPACES: i64 = 20;
pub const DEFAULT_MAX_TOPICS: i64 = 60;

const THRESHOLD_FIELDS: [(&str, &str, f64, f64, bool); 6] = [
    ("backlogWarn", "积压关注线", 0.0, 100_000_000.0, true),
    ("backlogCrit", "积压严重线", 0.0, 1_000_000_000.0, true),
    ("unackedWarn", "未 ack 关注线", 0.0, 100_000_000.0, true),
    ("rateRatio", "入向/出向倍数", 1.0, 1000.0, false),
    ("rateMinIn", "速率判定的入向下限", 0.0, 1_000_000.0, false),
    ("detailTopN", "明细最多列几条", 1.0, 50.0, true),
];

fn field_label(field: &str) -> &'static str {
    match field {
        "backlogWarn" => "积压关注线",
        "backlogCrit" => "积压严重线",
        "unackedWarn" => "未 ack 关注线",
        "rateRatio" => "入向/出向倍数",
        "rateMinIn" => "速率判定的入向下限",
        _ => "明细最多列几条",
    }
}

/// 草稿 → 完整口径：没填的落回默认，填了的逐个校验。
/// 越界一律报错而不是静默钳制：把 500 万悄悄按 100 万存下来，
/// 报告就会用他以为没配过的口径判红。
pub fn resolve_thresholds(draft: Option<&serde_json::Value>) -> AppResult<InspectionThresholds> {
    let mut next = InspectionThresholds::default();
    let Some(draft) = draft.filter(|value| value.is_object()) else {
        return Ok(next);
    };

    for (field, _label, min, max, integer) in THRESHOLD_FIELDS {
        let Some(value) = draft.get(field).and_then(serde_json::Value::as_f64) else {
            continue;
        };
        if !value.is_finite() {
            return Err(invalid(&format!("{} 必须是一个有限的数字", field_label(field))));
        }
        if integer && value.fract() != 0.0 {
            return Err(invalid(&format!("{} 只能是整数", field_label(field))));
        }
        if value < min || value > max {
            return Err(invalid(&format!(
                "{} 只能在 {min} 到 {max} 之间",
                field_label(field)
            )));
        }
        let value = if integer { value } else { (value * 100.0).round() / 100.0 };
        match field {
            "backlogWarn" => next.backlog_warn = value,
            "backlogCrit" => next.backlog_crit = value,
            "unackedWarn" => next.unacked_warn = value,
            "rateRatio" => next.rate_ratio = value,
            "rateMinIn" => next.rate_min_in = value,
            _ => next.detail_top_n = value,
        }
    }

    // 两个数各自合法，合起来却让分级反过来：超过关注线却永远到不了严重线
    if next.backlog_crit < next.backlog_warn {
        return Err(invalid("积压严重线不能低于关注线，否则积压只会报到「关注」就停住"));
    }
    Ok(next)
}

fn invalid(message: &str) -> AppError {
    AppError::config(format!("巡检口径不合法：{message}"))
}

pub struct Sampling {
    pub max_namespaces: i64,
    pub max_topics: i64,
}

pub fn resolve_sampling(max_namespaces: Option<i64>, max_topics: Option<i64>) -> AppResult<Sampling> {
    let out = Sampling {
        max_namespaces: max_namespaces.unwrap_or(DEFAULT_MAX_NAMESPACES),
        max_topics: max_topics.unwrap_or(DEFAULT_MAX_TOPICS),
    };
    if !(1..=200).contains(&out.max_namespaces) {
        return Err(invalid("命名空间采样上限只能在 1 到 200 之间"));
    }
    if !(1..=1000).contains(&out.max_topics) {
        return Err(invalid("topic 采样上限只能在 1 到 1000 之间"));
    }
    Ok(out)
}

pub fn threshold_overrides(thresholds: &InspectionThresholds) -> Vec<String> {
    let defaults = InspectionThresholds::default();
    let mut out = Vec::new();
    if thresholds.backlog_warn != defaults.backlog_warn {
        out.push(format!("积压关注线 {} 条", thresholds.backlog_warn));
    }
    if thresholds.backlog_crit != defaults.backlog_crit {
        out.push(format!("积压严重线 {} 条", thresholds.backlog_crit));
    }
    if thresholds.unacked_warn != defaults.unacked_warn {
        out.push(format!("未 ack 关注线 {} 条", thresholds.unacked_warn));
    }
    if thresholds.rate_ratio != defaults.rate_ratio {
        out.push(format!("入向/出向倍数 {} 倍", thresholds.rate_ratio));
    }
    if thresholds.rate_min_in != defaults.rate_min_in {
        out.push(format!("速率判定的入向下限 {} 条/秒", thresholds.rate_min_in));
    }
    if thresholds.detail_top_n != defaults.detail_top_n {
        out.push(format!("明细最多列几条 {} 条", thresholds.detail_top_n));
    }
    out
}

// ========== 采样行 ==========

/// topic 采样后的扁平行。订阅的 msgBacklog 要自己加总：
/// Admin 的 topic stats 顶层只有 backlogSize（字节），条数挂在每个订阅下。
#[derive(Debug, Clone, Default)]
pub struct TopicRow {
    pub name: String,
    pub persistent: bool,
    pub msg_rate_in: f64,
    pub msg_rate_out: f64,
    pub backlog: f64,
    pub producer_count: usize,
    pub subscription_count: usize,
    pub consumer_count: usize,
    pub max_sub_backlog: f64,
    pub max_sub_backlog_name: String,
    pub max_unacked: f64,
    pub blocked_subscriptions: Vec<String>,
}

pub fn to_topic_row(name: &str, persistent: bool, stats: &TopicStats) -> TopicRow {
    let mut row = TopicRow {
        name: name.to_string(),
        persistent,
        msg_rate_in: stats.msg_rate_in,
        msg_rate_out: stats.msg_rate_out,
        producer_count: stats.producers.len(),
        subscription_count: stats.subscriptions.len(),
        ..Default::default()
    };
    for (sub_name, sub) in &stats.subscriptions {
        row.backlog += sub.msg_backlog as f64;
        row.consumer_count += sub.consumers.len();
        if sub.msg_backlog as f64 > row.max_sub_backlog {
            row.max_sub_backlog = sub.msg_backlog as f64;
            row.max_sub_backlog_name = sub_name.clone();
        }
        let unacked = sub.unacked_messages as f64;
        if unacked > row.max_unacked {
            row.max_unacked = unacked;
        }
        // 只有 broker 明确说 true 才算阻塞：字段缺失的老 broker 不能判成故障
        if sub.blocked_subscription_on_unacked_msgs {
            row.blocked_subscriptions.push(sub_name.clone());
        }
    }
    row
}

// ========== 判定 ==========

pub fn build_connectivity_check(healthy: bool) -> InspectionCheck {
    if healthy {
        InspectionCheck::new("connectivity", "Broker 健康检查", CheckLevel::Ok, "通过")
    } else {
        InspectionCheck::new("connectivity", "Broker 健康检查", CheckLevel::Crit, "未通过").suggestion(
            "确认 webServiceUrl 指向的是 broker 而不是其它 HTTP 服务，并检查认证是否仍然有效",
        )
    }
}

pub fn build_broker_check(active: usize, all: usize) -> InspectionCheck {
    if active == 0 {
        return InspectionCheck::new("brokers", "Broker 存活", CheckLevel::Crit, "集群里没有活跃 broker")
            .detail(if all > 0 {
                vec![format!("已登记 {all} 个，全部不在列表")]
            } else {
                Vec::new()
            });
    }
    if all > active {
        return InspectionCheck::new(
            "brokers",
            "Broker 存活",
            CheckLevel::Crit,
            format!("{active} 个活跃 / {all} 个已登记"),
        )
        .suggestion("有 broker 掉线：负载与函数分配都落不到它身上，先把它拉起来再看待积压归属");
    }
    InspectionCheck::new(
        "brokers",
        "Broker 存活",
        CheckLevel::Ok,
        format!("{active} 个 broker 全部活跃"),
    )
}

pub fn build_consumer_check(rows: &[TopicRow], th: &InspectionThresholds) -> InspectionCheck {
    if rows.is_empty() {
        return InspectionCheck::new("consumers", "消费端在读", CheckLevel::Skip, "没有采样到 topic，无法判断");
    }
    let mut stalled: Vec<&TopicRow> = rows
        .iter()
        .filter(|row| row.backlog > 0.0 && row.consumer_count == 0)
        .collect();
    if stalled.is_empty() {
        return InspectionCheck::new(
            "consumers",
            "消费端在读",
            CheckLevel::Ok,
            "采样范围内没有「有积压但无消费者」的 topic",
        );
    }
    stalled.sort_by(|a, b| b.backlog.partial_cmp(&a.backlog).unwrap_or(std::cmp::Ordering::Equal));
    let total: f64 = stalled.iter().map(|row| row.backlog).sum();
    InspectionCheck::new(
        "consumers",
        "消费端在读",
        CheckLevel::Crit,
        format!(
            "{} 个 topic 有积压但没有连接的消费者（共 {} 条）",
            stalled.len(),
            total as i64
        ),
    )
    .detail(
        stalled
            .iter()
            .take(th.top_n())
            .map(|row| {
                format!(
                    "{}：积压 {} 条，订阅 {} 个",
                    row.name, row.backlog as i64, row.subscription_count
                )
            })
            .collect(),
    )
    .suggestion("这些 topic 的积压只会随生产继续增长：确认消费者是否崩溃、订阅是否被删，或先把生产端停掉")
}

pub fn build_backlog_check(rows: &[TopicRow], th: &InspectionThresholds) -> InspectionCheck {
    if rows.is_empty() {
        return InspectionCheck::new("backlog", "消息积压", CheckLevel::Skip, "没有采样到 topic，无法判断积压");
    }
    let total: f64 = rows.iter().map(|row| row.backlog).sum();
    let worst = rows
        .iter()
        .fold(&rows[0], |max, row| if row.backlog > max.backlog { row } else { max });
    let level = if worst.backlog >= th.backlog_crit {
        CheckLevel::Crit
    } else if worst.backlog >= th.backlog_warn {
        CheckLevel::Warn
    } else {
        CheckLevel::Ok
    };
    let mut sorted: Vec<&TopicRow> = rows.iter().collect();
    sorted.sort_by(|a, b| b.backlog.partial_cmp(&a.backlog).unwrap_or(std::cmp::Ordering::Equal));
    InspectionCheck::new(
        "backlog",
        "消息积压",
        level,
        format!(
            "采样范围内共 {} 条积压，单 topic 最高 {} 条",
            total as i64, worst.backlog as i64
        ),
    )
    .detail(
        sorted
            .iter()
            .take(th.top_n())
            .map(|row| {
                let top = if row.max_sub_backlog_name.is_empty() {
                    String::new()
                } else {
                    format!(
                        "（最大订阅 {} {}）",
                        row.max_sub_backlog_name, row.max_sub_backlog as i64
                    )
                };
                format!("{}：{} 条{top}", row.name, row.backlog as i64)
            })
            .collect(),
    )
}

pub fn build_unacked_check(rows: &[TopicRow], th: &InspectionThresholds) -> InspectionCheck {
    if rows.is_empty() {
        return InspectionCheck::new(
            "unacked",
            "未 ack / 阻塞订阅",
            CheckLevel::Skip,
            "没有采样到 topic，无法判断未 ack",
        );
    }
    let total: f64 = rows.iter().map(|row| row.max_unacked).sum();
    let blocked: Vec<&TopicRow> = rows.iter().filter(|row| !row.blocked_subscriptions.is_empty()).collect();
    if !blocked.is_empty() {
        return InspectionCheck::new(
            "unacked",
            "未 ack / 阻塞订阅",
            CheckLevel::Crit,
            format!(
                "{} 个 topic 上有被阻塞的订阅（未 ack 上限已满）",
                blocked.len()
            ),
        )
        .detail(
            blocked
                .iter()
                .take(th.top_n())
                .map(|row| format!("{}：{}", row.name, row.blocked_subscriptions.join("、")))
                .collect(),
        )
        .suggestion("被阻塞的订阅不会收新消息：检查消费者是否只拉不 ack，或把 maxUnackedMessagesPerConsumer 调大");
    }
    let level = if total >= th.unacked_warn {
        CheckLevel::Warn
    } else {
        CheckLevel::Ok
    };
    InspectionCheck::new(
        "unacked",
        "未 ack / 阻塞订阅",
        level,
        format!("没有阻塞订阅，未 ack 合计 {} 条", total as i64),
    )
}

pub fn build_throughput_check(rows: &[TopicRow], th: &InspectionThresholds) -> InspectionCheck {
    if rows.is_empty() {
        return InspectionCheck::new(
            "throughput",
            "生产与消费速率",
            CheckLevel::Skip,
            "没有采样到 topic，无法判断速率",
        );
    }
    let mut lagging: Vec<&TopicRow> = rows
        .iter()
        .filter(|row| row.msg_rate_in >= th.rate_min_in && row.msg_rate_in >= row.msg_rate_out * th.rate_ratio)
        .collect();
    if lagging.is_empty() {
        return InspectionCheck::new(
            "throughput",
            "生产与消费速率",
            CheckLevel::Ok,
            "采样范围内没有持续入大于出的 topic",
        );
    }
    lagging.sort_by(|a, b| b.msg_rate_in.partial_cmp(&a.msg_rate_in).unwrap_or(std::cmp::Ordering::Equal));
    InspectionCheck::new(
        "throughput",
        "生产与消费速率",
        CheckLevel::Warn,
        format!("{} 个 topic 的入向速率明显高于出向", lagging.len()),
    )
    .detail(
        lagging
            .iter()
            .take(th.top_n())
            .map(|row| format!("{}：入 {:.1}/s，出 {:.1}/s", row.name, row.msg_rate_in, row.msg_rate_out))
            .collect(),
    )
    .suggestion("要么加消费者，要么在生产端限流；这个比例维持下去积压会一直增长")
}

pub fn build_worker_check(state: Option<&serde_json::Value>, error: Option<&str>) -> InspectionCheck {
    if let Some(error) = error {
        return InspectionCheck::new("workers", "函数 / 连接器 worker", CheckLevel::Skip, "worker 状态读不到")
            .detail(vec![error.to_string()]);
    }
    let Some(state) = state else {
        return InspectionCheck::new("workers", "函数 / 连接器 worker", CheckLevel::Skip, "worker 状态未采集");
    };
    if state["enabled"] != true {
        let notice = state["notice"].as_str().map(str::to_string);
        return InspectionCheck::new(
            "workers",
            "函数 / 连接器 worker",
            CheckLevel::Skip,
            "该集群没有启用 worker 服务",
        )
        .detail(notice.into_iter().collect());
    }
    let nodes = state["nodes"].as_array().map(Vec::len).unwrap_or(0);
    if nodes == 0 {
        return InspectionCheck::new(
            "workers",
            "函数 / 连接器 worker",
            CheckLevel::Crit,
            "worker 已启用但没有在线节点",
        )
        .suggestion("函数与连接器不会被调度：先看 broker 启动日志里的 worker 配置");
    }
    InspectionCheck::new(
        "workers",
        "函数 / 连接器 worker",
        CheckLevel::Ok,
        format!("worker 在线节点 {nodes} 个"),
    )
}

pub fn build_alert_check(alerts: &[AlertRow], th: &InspectionThresholds) -> InspectionCheck {
    if alerts.is_empty() {
        return InspectionCheck::new("alerts", "未恢复的本地告警", CheckLevel::Ok, "没有未恢复的告警事件");
    }
    InspectionCheck::new(
        "alerts",
        "未恢复的本地告警",
        CheckLevel::Warn,
        format!("{} 条告警仍未恢复", alerts.len()),
    )
    .detail(
        alerts
            .iter()
            .take(th.top_n())
            .map(|item| format!("{}｜{}｜{}", item.rule_name, item.scope_label, item.message))
            .collect(),
    )
    .suggestion("这些是应用内告警规则判出来的，处置完在告警中心确认或恢复，别让它们一直挂着")
}

#[derive(Debug, Clone, Default)]
pub struct AlertRow {
    pub rule_name: String,
    pub scope_label: String,
    pub message: String,
}

// ========== 采集 ==========

pub struct InspectionRequest<'a> {
    pub client: &'a AdminClient,
    pub cluster_id: &'a str,
    pub cluster_name: &'a str,
    pub alerts: Vec<AlertRow>,
    pub thresholds: Option<InspectionThresholds>,
    pub max_namespaces: Option<i64>,
    pub max_topics: Option<i64>,
}

/// 逐段采集：任何一段失败都变成一条 skip/warn 检查，而不是让整份报告消失。
pub async fn run(request: InspectionRequest<'_>) -> AppResult<InspectionReport> {
    // 口径在这里一次算定并抄进报告：判定过程中不再回头读配置表
    let thresholds = request.thresholds.clone().unwrap_or_default();
    let sampling = resolve_sampling(request.max_namespaces, request.max_topics)?;
    let client = request.client;
    let mut checks: Vec<InspectionCheck> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    let healthy = client.health_check().await;
    checks.push(build_connectivity_check(healthy));
    if !healthy {
        errors.push("健康检查未通过".to_string());
    }

    let version = client.version().await;
    if version.is_none() {
        errors.push("版本读取异常".to_string());
    }

    match client.brokers().await {
        Ok(brokers) => checks.push(build_broker_check(
            brokers.active_brokers.len(),
            brokers.all_brokers.len(),
        )),
        Err(error) => checks.push(
            InspectionCheck::new("brokers", "Broker 存活", CheckLevel::Skip, "broker 列表读取失败")
                .detail(vec![error.to_string()]),
        ),
    }

    let tenants = match client.tenants().await {
        Ok(tenants) => tenants,
        Err(error) => {
            errors.push(format!("租户列表读取失败：{error}"));
            Vec::new()
        }
    };

    // 命名空间与 topic 都按上限收紧后再采样：一次巡检发几千个请求等于 DDoS 自己的 broker
    let mut sampled: Vec<(String, String)> = Vec::new();
    let mut namespaces_truncated = false;
    'tenants: for tenant in &tenants {
        if sampled.len() as i64 >= sampling.max_namespaces {
            namespaces_truncated = true;
            break;
        }
        let namespaces = match client.namespaces(&tenant.name).await {
            Ok(list) => list,
            Err(error) => {
                errors.push(format!("租户 {} 的命名空间读取失败：{error}", tenant.name));
                continue;
            }
        };
        for namespace in namespaces {
            if sampled.len() as i64 >= sampling.max_namespaces {
                namespaces_truncated = true;
                break 'tenants;
            }
            sampled.push((tenant.name.clone(), namespace));
        }
    }

    let mut rows: Vec<TopicRow> = Vec::new();
    let mut topics_seen = 0i64;
    let mut topics_truncated = false;
    for (tenant, namespace) in &sampled {
        let topics = match client.topics(tenant, namespace).await {
            Ok(list) => list,
            Err(error) => {
                errors.push(format!("命名空间 {namespace} 的 topic 列表读取失败：{error}"));
                continue;
            }
        };
        // 计数按全量、采样按截断后的子集：只有这样才能把「看了 60 个、漏了 400 个」说清楚
        topics_seen += topics.len() as i64;
        let remaining = sampling.max_topics - rows.len() as i64;
        if topics.len() as i64 > remaining {
            topics_truncated = true;
        }
        let picked: Vec<_> = topics.into_iter().take(remaining.max(0) as usize).collect();

        let stats: Vec<Result<TopicRow, String>> = stream::iter(picked.into_iter().map(|topic| {
            let name = topic.name.clone();
            let persistent = topic.persistent;
            async move {
                match client.topic_stats(tenant, namespace, &name, persistent).await {
                    Ok(stats) => Ok(to_topic_row(&name, persistent, &stats)),
                    Err(error) => Err(format!("topic {name} 的统计读取失败：{error}")),
                }
            }
        }))
        .buffer_unordered(4)
        .collect()
        .await;
        for outcome in stats {
            match outcome {
                Ok(row) => rows.push(row),
                Err(message) => errors.push(message),
            }
        }
        if rows.len() as i64 >= sampling.max_topics {
            break;
        }
    }

    checks.push(build_backlog_check(&rows, &thresholds));
    checks.push(build_consumer_check(&rows, &thresholds));
    checks.push(build_unacked_check(&rows, &thresholds));
    checks.push(build_throughput_check(&rows, &thresholds));

    match client.worker_state().await {
        Ok(state) => checks.push(build_worker_check(Some(&state), None)),
        Err(error) => checks.push(build_worker_check(None, Some(&error.to_string()))),
    }
    checks.push(build_alert_check(&request.alerts, &thresholds));

    if !errors.is_empty() {
        checks.push(
            InspectionCheck::new(
                "collect",
                "采集过程中的局部失败",
                CheckLevel::Warn,
                format!("{} 次请求没有拿到数据", errors.len()),
            )
            .detail(errors.iter().take(thresholds.top_n()).cloned().collect())
            .suggestion("局部失败不影响其余判定，但报告覆盖范围比看上去小：老 broker 缺少端点时会集中出现"),
        );
    }

    let mut report = InspectionReport {
        id: pm_core::new_id(),
        cluster_id: request.cluster_id.to_string(),
        cluster_name: request.cluster_name.to_string(),
        generated_at: pm_core::now_iso(),
        version,
        scope: InspectionScope {
            tenants: tenants.len() as i64,
            namespaces_seen: sampled.len() as i64,
            topics_seen,
            topics_sampled: rows.len() as i64,
            max_namespaces: sampling.max_namespaces,
            max_topics: sampling.max_topics,
            truncated: namespaces_truncated || topics_truncated,
        },
        checks,
        totals: InspectionTotals::default(),
        thresholds: Some(thresholds),
        source: "manual".into(),
        markdown: String::new(),
    };
    report.recompute_totals();
    Ok(report)
}

// ========== 环比 ==========

const LEVEL_RANK: [(&str, i32); 4] = [("ok", 0), ("skip", 1), ("warn", 2), ("crit", 3)];

fn level_rank(level: Option<&str>) -> i32 {
    level
        .and_then(|level| LEVEL_RANK.iter().find(|(key, _)| *key == level).map(|(_, rank)| *rank))
        .unwrap_or(0)
}

fn is_actionable(level: Option<&str>) -> bool {
    matches!(level, Some("crit") | Some("warn"))
}

fn kind_order(kind: &str) -> i32 {
    match kind {
        "worsened" => 0,
        "new" => 1,
        "resolved" => 2,
        "improved" => 3,
        _ => 4,
    }
}

pub fn diff_inspection_checks(
    previous_checks: &[InspectionCheck],
    current_checks: &[InspectionCheck],
) -> Vec<serde_json::Value> {
    use serde_json::json;
    let mut items: Vec<serde_json::Value> = Vec::new();
    let mut current_keys = std::collections::BTreeSet::new();

    for current in current_checks {
        current_keys.insert(current.key.clone());
        match previous_checks.iter().find(|item| item.key == current.key) {
            None => {
                if is_actionable(Some(&current.level)) {
                    items.push(json!({
                        "key": current.key,
                        "title": current.title,
                        "kind": "new",
                        "level": current.level,
                        "previousLevel": null,
                        "summary": current.summary,
                    }));
                }
            }
            Some(previous) => {
                let delta = level_rank(Some(&current.level)) - level_rank(Some(&previous.level));
                items.push(json!({
                    "key": current.key,
                    "title": current.title,
                    "kind": if delta > 0 { "worsened" } else if delta < 0 { "improved" } else { "unchanged" },
                    "level": current.level,
                    "previousLevel": previous.level,
                    "summary": current.summary,
                }));
            }
        }
    }

    for previous in previous_checks {
        if current_keys.contains(&previous.key) || !is_actionable(Some(&previous.level)) {
            continue;
        }
        // 这一项这次没出现：上次是 crit/warn，现在读不到了。按「问题不在结论之内」报，
        // 但绝不写成「已恢复」——没测到不等于好了。
        items.push(json!({
            "key": previous.key,
            "title": previous.title,
            "kind": "resolved",
            "level": null,
            "previousLevel": previous.level,
            "summary": previous.summary,
        }));
    }

    items.sort_by(|a, b| {
        let by_kind = kind_order(a["kind"].as_str().unwrap_or("unchanged"))
            - kind_order(b["kind"].as_str().unwrap_or("unchanged"));
        if by_kind != 0 {
            return by_kind.cmp(&0);
        }
        let rank_a = a["level"]
            .as_str()
            .or_else(|| a["previousLevel"].as_str())
            .map(|level| level_rank(Some(level)))
            .unwrap_or(0);
        let rank_b = b["level"]
            .as_str()
            .or_else(|| b["previousLevel"].as_str())
            .map(|level| level_rank(Some(level)))
            .unwrap_or(0);
        rank_b.cmp(&rank_a)
    });
    items
}

pub fn build_inspection_diff(
    previous_id: &str,
    previous_generated_at: &str,
    previous_checks: &[InspectionCheck],
    current_checks: &[InspectionCheck],
    previous_thresholds: Option<&InspectionThresholds>,
    current_thresholds: Option<&InspectionThresholds>,
) -> serde_json::Value {
    use serde_json::json;
    let items = diff_inspection_checks(previous_checks, current_checks);
    let changed = items
        .iter()
        .filter(|item| item["kind"].as_str() != Some("unchanged"))
        .count();
    let mut changes: Vec<serde_json::Value> = Vec::new();
    // 只有两边口径都记下来时才谈得上「判定线变没变」
    if let (Some(previous), Some(current)) = (previous_thresholds, current_thresholds) {
        let pairs: [(&str, f64, f64); 6] = [
            ("backlogWarn", previous.backlog_warn, current.backlog_warn),
            ("backlogCrit", previous.backlog_crit, current.backlog_crit),
            ("unackedWarn", previous.unacked_warn, current.unacked_warn),
            ("rateRatio", previous.rate_ratio, current.rate_ratio),
            ("rateMinIn", previous.rate_min_in, current.rate_min_in),
            ("detailTopN", previous.detail_top_n, current.detail_top_n),
        ];
        for (field, from, to) in pairs {
            if from != to {
                changes.push(json!({
                    "field": field,
                    "label": field_label(field),
                    "previous": from,
                    "current": to,
                }));
            }
        }
    }
    json!({
        "previousId": previous_id,
        "previousGeneratedAt": previous_generated_at,
        "items": items,
        "changedCount": changed,
        "thresholdChanges": changes,
    })
}

// ========== 导出 ==========

const LEVEL_MARKS: [(&str, &str); 4] = [
    ("crit", "🔴"),
    ("warn", "🟠"),
    ("ok", "🟢"),
    ("skip", "⚪"),
];

const LEVEL_NAMES: [(&str, &str); 4] = [
    ("crit", "严重"),
    ("warn", "关注"),
    ("ok", "正常"),
    ("skip", "未覆盖"),
];

fn mark(level: &str) -> &'static str {
    LEVEL_MARKS
        .iter()
        .find(|(key, _)| *key == level)
        .map(|(_, mark)| *mark)
        .unwrap_or("⚪")
}

fn level_name(level: &str) -> &'static str {
    LEVEL_NAMES
        .iter()
        .find(|(key, _)| *key == level)
        .map(|(_, name)| *name)
        .unwrap_or("未覆盖")
}

fn describe_thresholds(thresholds: &InspectionThresholds) -> String {
    let overrides = threshold_overrides(thresholds);
    if overrides.is_empty() {
        "判定口径：默认阈值".to_string()
    } else {
        format!("判定口径（已按本集群调整）：{}", overrides.join("，"))
    }
}

fn render_diff_markdown(diff: &serde_json::Value, lines: &mut Vec<String>) {
    let previous_at = diff["previousGeneratedAt"].as_str().unwrap_or("-");
    lines.push(format!("## 与上次巡检的差别（上次：{previous_at}）"));
    lines.push(String::new());
    let changes = diff["thresholdChanges"].as_array().cloned().unwrap_or_default();
    if !changes.is_empty() {
        let text: Vec<String> = changes
            .iter()
            .map(|item| {
                format!(
                    "{} {} → {}",
                    item["label"].as_str().unwrap_or("口径"),
                    item["previous"].as_f64().unwrap_or(0.0),
                    item["current"].as_f64().unwrap_or(0.0)
                )
            })
            .collect();
        lines.push(format!("- 判定口径与上次不同：{}", text.join("；")));
        lines.push("  所以下面的级别移动里有一部分是判定线动了，不是集群变了。".to_string());
        lines.push(String::new());
    }
    let changed = diff["changedCount"].as_i64().unwrap_or(0);
    if changed == 0 {
        lines.push(if changes.is_empty() {
            "与上一次结论一致，没有项目的级别发生变化。".to_string()
        } else {
            "按新口径重判，级别与上次完全一致。".to_string()
        });
        lines.push(String::new());
        return;
    }
    let labels = [
        ("new", "新增"),
        ("resolved", "本次未出现"),
        ("worsened", "恶化"),
        ("improved", "好转"),
        ("unchanged", "不变"),
    ];
    for item in diff["items"].as_array().cloned().unwrap_or_default() {
        let kind = item["kind"].as_str().unwrap_or("unchanged");
        if kind == "unchanged" {
            continue;
        }
        let label = labels
            .iter()
            .find(|(key, _)| *key == kind)
            .map(|(_, label)| *label)
            .unwrap_or("变化");
        lines.push(format!(
            "- {label}｜{}：{}",
            item["title"].as_str().unwrap_or(""),
            item["summary"].as_str().unwrap_or("")
        ));
    }
    lines.push(String::new());
}

/// 报告要能脱离应用被读懂（贴进工单、发到群里），所以采样范围与截断都写全。
pub fn render_markdown(report: &InspectionReport, diff: Option<&serde_json::Value>) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("# Pulsar 集群巡检报告：{}", report.cluster_name));
    lines.push(String::new());
    lines.push(format!("- 生成时间：{}", report.generated_at));
    lines.push(format!("- 集群标识：{}", report.cluster_id));
    lines.push(format!(
        "- broker 版本：{}",
        report.version.as_deref().unwrap_or("未取到")
    ));
    lines.push(format!(
        "- 采样范围：{} 个租户，{}/{} 个命名空间，共见到 {} 个 topic、逐个采集 {} 个（上限 {}）",
        report.scope.tenants,
        report.scope.namespaces_seen,
        report.scope.max_namespaces,
        report.scope.topics_seen,
        report.scope.topics_sampled,
        report.scope.max_topics
    ));
    lines.push(format!(
        "- 结论：{} {} 项、{} {} 项、{} {} 项、{} {} 项",
        level_name("crit"),
        report.totals.crit,
        level_name("warn"),
        report.totals.warn,
        level_name("ok"),
        report.totals.ok,
        level_name("skip"),
        report.totals.skip
    ));
    if let Some(thresholds) = &report.thresholds {
        lines.push(format!("- {}", describe_thresholds(thresholds)));
    }
    if report.scope.truncated {
        lines.push("- 注意：采样在命名空间或 topic 上限处被截断，未采样的部分不在本报告结论之内".to_string());
    }
    lines.push(String::new());
    if let Some(diff) = diff {
        render_diff_markdown(diff, &mut lines);
    }
    for item in &report.checks {
        lines.push(format!("## {} {}（{}）", mark(&item.level), item.title, level_name(&item.level)));
        lines.push(String::new());
        lines.push(item.summary.clone());
        if !item.detail.is_empty() {
            lines.push(String::new());
            for line in &item.detail {
                lines.push(format!("- {line}"));
            }
        }
        if let Some(suggestion) = &item.suggestion {
            lines.push(String::new());
            lines.push(format!("建议：{suggestion}"));
        }
        lines.push(String::new());
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn thresholds_reject_inverted_backlog_lines() {
        let draft = json!({"backlogWarn": 100_000, "backlogCrit": 1_000});
        assert!(resolve_thresholds(Some(&draft)).is_err());
    }

    #[test]
    fn thresholds_round_float_noise() {
        let draft = json!({"rateRatio": 1.23456});
        let thresholds = resolve_thresholds(Some(&draft)).unwrap();
        assert_eq!(thresholds.rate_ratio, 1.23);
    }

    #[test]
    fn sampling_rejects_out_of_range() {
        assert!(resolve_sampling(Some(0), None).is_err());
        assert!(resolve_sampling(None, Some(5_000)).is_err());
    }

    #[test]
    fn backlog_level_follows_worst_topic() {
        let thresholds = InspectionThresholds::default();
        let rows = vec![TopicRow {
            name: "t".into(),
            backlog: thresholds.backlog_crit,
            ..Default::default()
        }];
        assert_eq!(build_backlog_check(&rows, &thresholds).level, "crit");
    }

    #[test]
    fn diff_marks_worsened_and_resolved() {
        let previous = vec![
            InspectionCheck::new("backlog", "积压", CheckLevel::Ok, "还好"),
            InspectionCheck::new("alerts", "告警", CheckLevel::Warn, "两条"),
        ];
        let current = vec![InspectionCheck::new("backlog", "积压", CheckLevel::Crit, "炸了")];
        let items = diff_inspection_checks(&previous, &current);
        let kinds: Vec<&str> = items.iter().filter_map(|item| item["kind"].as_str()).collect();
        assert!(kinds.contains(&"worsened"));
        assert!(kinds.contains(&"resolved"));
        // 排序按「需要人处理的排前面」：恶化第一，本次未出现第二
        assert_eq!(kinds[0], "worsened");
    }
}
