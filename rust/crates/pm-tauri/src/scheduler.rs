//! 后台定时任务：告警评估与定时巡检。
//!
//! 两条循环共用 5 秒一次的扫描节拍，各自按自己的间隔判断「这一轮该不该跑」：
//! 配置写完就生效，不需要重启应用，也不会出现「改了间隔得重挂定时器」这类看不出来的毛病。
//!
//! 一轮没跑完就跳过这一轮——巡检一次可能几十秒，排队会让两轮叠成双倍请求量，
//! 表现得像应用在攻击自己的 broker。

use std::collections::HashMap;
use std::time::{Duration, Instant};

use pm_core::{AlertRule, AppError, AppResult, InspectionReport};
use serde_json::{json, Value};

use crate::bridge::Shared;

/// 扫描节拍：比最短间隔（告警 10 秒、巡检 1 分钟）小得多，抖动可以忽略
const TICK_MS: u64 = 5_000;
pub const ALERT_EVENT: &str = "alert:event";
pub const INSPECTION_SCHEDULED: &str = "inspection:scheduled";

pub fn start(context: Shared) {
    tauri::async_runtime::spawn(async move {
        let mut state = State::default();
        // 首次评估延几秒：给隧道建立与首帧渲染让路
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            alert_tick(&context, &mut state).await;
            inspection_tick(&context, &mut state).await;
            tokio::time::sleep(Duration::from_millis(TICK_MS)).await;
        }
    });
}

/// 规则 id -> 连续越线次数。放在进程级而不是循环的局部状态里：
/// 保存/删除规则的那条 RPC 要把旧计数清掉，否则「连续 N 轮」在新阈值下会少数几轮。
fn hits() -> &'static std::sync::Mutex<HashMap<String, i64>> {
    static HITS: std::sync::OnceLock<std::sync::Mutex<HashMap<String, i64>>> =
        std::sync::OnceLock::new();
    HITS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// 规则改了阈值/口径/连续次数，或规则被删掉时调用。
pub fn reset_hits(rule_id: Option<&str>) {
    let mut map = hits().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match rule_id {
        Some(id) => {
            map.remove(id);
        }
        None => map.clear(),
    }
}

#[derive(Default)]
struct State {
    evaluating_alerts: bool,
    evaluating_inspection: bool,
    last_alert_at: Option<Instant>,
    last_inspection_at: Option<Instant>,
}

fn setting_i64(context: &Shared, key: &str, fallback: i64) -> i64 {
    pm_store::settings::get(&context.store, key)
        .ok()
        .flatten()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(fallback)
}

fn setting_flag(context: &Shared, key: &str) -> bool {
    pm_store::settings::get(&context.store, key)
        .ok()
        .flatten()
        .map(|value| value == "true")
        .unwrap_or(false)
}

// ========== 告警引擎 ==========

async fn alert_tick(context: &Shared, state: &mut State) {
    if state.evaluating_alerts || !setting_flag(context, "alertEnabled") {
        return;
    }
    // 间隔下限 10 秒：命名空间与集群口径一次要发几十到上千个请求
    let interval = setting_i64(context, "alertCheckSeconds", 60).max(10);
    let due = state
        .last_alert_at
        .map(|last| last.elapsed() >= Duration::from_secs(interval as u64))
        .unwrap_or(true);
    if !due {
        return;
    }
    state.last_alert_at = Some(Instant::now());
    state.evaluating_alerts = true;

    let outcome = evaluate_all(context).await;
    if let Err(error) = outcome {
        pm_core::pm_warn!("[alert] 评估失败：{error}");
    }
    let retention = setting_i64(context, "alertRetentionDays", 30);
    let _ = prune_events(context, retention);

    state.evaluating_alerts = false;
}

async fn evaluate_all(context: &Shared) -> AppResult<()> {
    let mut by_cluster: HashMap<String, Vec<AlertRule>> = HashMap::new();
    for cluster in context.list_clusters()? {
        let rules: Vec<AlertRule> = pm_store::alerts::list_rules(&context.store, &cluster.id)?
            .into_iter()
            .filter(|rule| rule.enabled)
            .collect();
        if !rules.is_empty() {
            by_cluster.insert(cluster.id, rules);
        }
    }

    for (cluster_id, rules) in by_cluster {
        let owned = context.clone();
        let id = cluster_id.clone();
        // 取客户端要读库与解密钥，放到阻塞线程池
        let client = tokio::task::spawn_blocking(move || owned.admin_for(&id))
            .await
            .map_err(|error| AppError::Other(format!("任务失败：{error}")))?;
        let client = match client {
            Ok(client) => client,
            Err(error) => {
                // 连不上就断掉连续计数：拿不到数的这一轮不该推进判定
                for rule in &rules {
                    remove_hit(&rule.id);
                }
                pm_core::pm_warn!("[alert] 集群 {cluster_id} 不可用：{error}");
                continue;
            }
        };

        for rule in rules {
            let evaluation = match pm_services::alerts::evaluate(&client, &rule).await {
                Ok(evaluation) => evaluation,
                Err(error) => {
                    // 读不到数绝不改判定：连续计数断掉，未恢复的事件保持原状
                    remove_hit(&rule.id);
                    pm_core::pm_warn!("[alert] 规则 {} 取数失败：{error}", rule.name);
                    continue;
                }
            };
            let Some(observation) = evaluation.observation else {
                continue;
            };
            apply_sample(context, &rule, observation.value);
        }
    }
    Ok(())
}

fn apply_sample(context: &Shared, rule: &AlertRule, value: f64) {
    let breached = pm_services::alerts::compare(value, &rule.comparator, rule.threshold);

    if breached {
        let hits = bump_hit(&rule.id);

        if let Ok(Some(open)) = pm_store::alerts::open_event(&context.store, &rule.id) {
            // 已经立案：只把观测值刷上去，不再弹第二次通知
            let _ = pm_store::alerts::update_open_event(&context.store, open.id, value, "");
            return;
        }
        if hits < rule.consecutive.max(1) {
            return;
        }
        let observation = pm_services::alerts::Observation {
            value,
            label: scope_label(rule),
        };
        let event = pm_services::alerts::build_event(rule, &observation);
        match pm_store::alerts::insert_event(&context.store, &event) {
            Ok(id) => {
                if let Ok(Some(saved)) = find_event(context, id) {
                    publish(context, &saved, "fired");
                    notify_alert(context, rule, &saved, "fired");
                }
            }
            Err(error) => pm_core::pm_warn!("[alert] 事件落库失败：{error}"),
        }
        return;
    }

    remove_hit(&rule.id);
    if let Ok(Some(open)) = pm_store::alerts::open_event(&context.store, &rule.id) {
        let _ = pm_store::alerts::resolve_event(&context.store, open.id, value);
        if let Ok(Some(saved)) = find_event(context, open.id) {
            publish(context, &saved, "recovered");
            notify_alert(context, rule, &saved, "recovered");
        }
    }
}

fn bump_hit(rule_id: &str) -> i64 {
    let mut map = hits().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let counter = map.entry(rule_id.to_string()).or_insert(0);
    *counter += 1;
    *counter
}

fn remove_hit(rule_id: &str) {
    hits()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(rule_id);
}

fn find_event(context: &Shared, id: i64) -> AppResult<Option<pm_core::AlertEvent>> {
    Ok(pm_store::alerts::list_events(&context.store, None, 500)?
        .into_iter()
        .find(|event| event.id == id))
}

fn scope_label(rule: &AlertRule) -> String {
    match rule.scope.as_str() {
        "topic" => format!(
            "{}://{}/{}/{}",
            if rule.persistent { "persistent" } else { "non-persistent" },
            rule.tenant,
            rule.namespace,
            rule.topic
        ),
        "namespace" => format!("命名空间 {}/{}", rule.tenant, rule.namespace),
        _ => "整个集群".to_string(),
    }
}

fn publish(context: &Shared, event: &pm_core::AlertEvent, kind: &str) {
    if let Ok(payload) = serde_json::to_value(event) {
        crate::bridge::emit(ALERT_EVENT, json!({"kind": kind, "event": payload}));
    }
    let _ = context;
}

/// 外部渠道不看规则自己的 notify 开关：那个开关管的是「这台机器上的人要不要被打扰」，
/// 渠道收不收由它自己的订阅清单与级别线决定。
fn notify_alert(context: &Shared, rule: &AlertRule, event: &pm_core::AlertEvent, kind: &str) {
    let cluster_name = context
        .get_cluster(&rule.cluster_id)
        .map(|cluster| cluster.name)
        .unwrap_or_else(|_| rule.cluster_id.clone());
    let (title, text, level) = if kind == "fired" {
        (
            format!("告警：{}", event.rule_name),
            event.message.clone(),
            "crit",
        )
    } else {
        (
            format!("告警恢复：{}", event.rule_name),
            format!(
                "{} 已恢复，当前 {}",
                event.scope_label,
                pm_services::alerts::format_alert_value(&event.metric, event.last_value)
            ),
            "info",
        )
    };
    let input = pm_services::notify_center::NotifyInput::new(
        if kind == "fired" { "alertFired" } else { "alertRecovered" },
        level,
        title,
        text,
        cluster_name,
        if kind == "fired" {
            event.fired_at
        } else {
            event.resolved_at.unwrap_or(event.last_seen_at)
        },
    );
    let context = context.clone();
    tauri::async_runtime::spawn(async move {
        let store = context.store.clone();
        let secrets = context.secrets.clone();
        let _ = pm_services::notify_center::dispatch_event(&store, &secrets, &input).await;
    });
}

fn prune_events(context: &Shared, retention_days: i64) -> AppResult<()> {
    let cutoff = pm_core::now_ms() - retention_days.max(1) * 24 * 3600 * 1000;
    let events = pm_store::alerts::list_events(&context.store, None, 2000)?;
    let stale: Vec<i64> = events
        .iter()
        // 未恢复的事件不受保留期约束：它还在响，删掉等于把火警灯关了
        .filter(|event| event.state == "resolved" && event.fired_at < cutoff)
        .map(|event| event.id)
        .collect();
    if !stale.is_empty() {
        pm_store::alerts::delete_events(&context.store, &stale)?;
    }
    Ok(())
}

// ========== 定时巡检 ==========

async fn inspection_tick(context: &Shared, state: &mut State) {
    if state.evaluating_inspection {
        return;
    }
    // 调度自己的开关在每台集群那一行上，这里只按 60 秒扫一次到期项
    let due = state
        .last_inspection_at
        .map(|last| last.elapsed() >= Duration::from_secs(60))
        .unwrap_or(true);
    if !due {
        return;
    }
    state.last_inspection_at = Some(Instant::now());
    state.evaluating_inspection = true;

    let schedules = pm_store::inspections::enabled_schedules(&context.store).unwrap_or_default();
    for schedule in schedules {
        let now = pm_core::now_ms();
        if !is_due(schedule.last_run_at.as_deref(), schedule.interval_minutes, now) {
            continue;
        }
        run_scheduled(context, &schedule).await;
    }

    state.evaluating_inspection = false;
}

fn is_due(last_run_at: Option<&str>, interval_minutes: i64, now_ms: i64) -> bool {
    let Some(last) = last_run_at else {
        return true;
    };
    match chrono::DateTime::parse_from_rfc3339(last) {
        Ok(moment) => now_ms - moment.timestamp_millis() >= interval_minutes.max(1) * 60_000,
        // 时间戳解析不出来：当作从没跑过，宁可多跑一轮也不要永远不跑
        Err(_) => true,
    }
}

async fn run_scheduled(context: &Shared, schedule: &pm_core::InspectionSchedule) {
    let cluster = match context.get_cluster(&schedule.cluster_id) {
        Ok(cluster) => cluster,
        Err(_) => return,
    };
    let ran_at = pm_core::now_iso();

    let result = crate::rpc::inspect::execute_scheduled(context, &schedule.cluster_id).await;
    let report: InspectionReport = match result {
        Ok(value) => match serde_json::from_value(
            value.get("report").cloned().unwrap_or(Value::Null),
        ) {
            Ok(report) => report,
            Err(error) => {
                mark_failed(context, schedule, &ran_at, &format!("报告解析失败：{error}"));
                emit_failed(context, &cluster.name, &schedule.cluster_id, "报告解析失败", &ran_at);
                return;
            }
        },
        Err(error) => {
            let reason = error.to_string();
            mark_failed(context, schedule, &ran_at, &reason);
            emit_failed(context, &cluster.name, &schedule.cluster_id, &reason, &ran_at);
            // 同一句失败原因只发一次：一台关着的集群每轮都往群里发，第三天就没人看了
            if schedule.last_error.as_deref() != Some(reason.as_str()) {
                dispatch_inspection_failure(context, &cluster.name, &schedule.cluster_id, &reason);
            }
            return;
        }
    };

    let crit = report.totals.crit;
    let kind = notice_kind(crit, schedule.last_notified_crit);
    let message = match kind {
        Some(kind) => notice_text(kind, &cluster.name, crit, schedule.last_notified_crit, report.totals.warn),
        None => format!(
            "{}：定时巡检完成，严重 {} 项、关注 {} 项",
            cluster.name, crit, report.totals.warn
        ),
    };
    if let Err(error) = pm_store::inspections::mark_run(
        &context.store,
        &schedule.cluster_id,
        &report.generated_at,
        None,
        kind.map(|_| crit),
    ) {
        pm_core::pm_warn!("[inspection] 调度状态写回失败：{error}");
    }

    if let Ok(totals) = serde_json::to_value(&report.totals) {
        crate::bridge::emit(
            INSPECTION_SCHEDULED,
            json!({
                "kind": "completed",
                "clusterId": schedule.cluster_id,
                "clusterName": cluster.name,
                "totals": totals,
                "message": message,
                "generatedAt": report.generated_at,
            }),
        );
    }

    if let Some(kind) = kind {
        let context = context.clone();
        let cluster_name = cluster.name.clone();
        let cluster_id = schedule.cluster_id.clone();
        let title = if kind == "recovered" {
            "巡检：严重项已恢复"
        } else {
            "巡检：需要处理"
        };
        tauri::async_runtime::spawn(async move {
            let store = context.store.clone();
            let secrets = context.secrets.clone();
            let input = pm_services::notify_center::NotifyInput::new(
                if kind == "recovered" {
                    "inspectionRecovered"
                } else {
                    "inspectionCrit"
                },
                if kind == "recovered" { "info" } else { "crit" },
                title,
                message,
                cluster_name,
                pm_core::now_ms(),
            );
            let _ = pm_services::notify_center::dispatch_event(&store, &secrets, &input).await;
            let _ = cluster_id;
        });
    }
}

fn mark_failed(context: &Shared, schedule: &pm_core::InspectionSchedule, ran_at: &str, error: &str) {
    // 连不上也要把 last_run_at 写下去：不写的话下一轮又会试一次，
    // 一台关着的集群会被应用每分钟敲一次门
    if let Err(failure) = pm_store::inspections::mark_run(
        &context.store,
        &schedule.cluster_id,
        ran_at,
        Some(error),
        None,
    ) {
        pm_core::pm_warn!("[inspection] 失败状态写回失败：{failure}");
    }
}

fn emit_failed(context: &Shared, cluster_name: &str, cluster_id: &str, reason: &str, ran_at: &str) {
    let _ = context;
    crate::bridge::emit(
        INSPECTION_SCHEDULED,
        json!({
            "kind": "failed",
            "clusterId": cluster_id,
            "clusterName": cluster_name,
            "totals": null,
            "message": format!("定时巡检失败：{reason}"),
            "generatedAt": ran_at,
        }),
    );
}

fn dispatch_inspection_failure(context: &Shared, cluster_name: &str, cluster_id: &str, reason: &str) {
    let context = context.clone();
    let cluster_name = cluster_name.to_string();
    let cluster_id = cluster_id.to_string();
    let text = format!("定时巡检没能开始：{reason}");
    tauri::async_runtime::spawn(async move {
        let store = context.store.clone();
        let secrets = context.secrets.clone();
        let input = pm_services::notify_center::NotifyInput::new(
            "inspectionFailed",
            "warn",
            "巡检：这一轮没跑成",
            text,
            cluster_name,
            pm_core::now_ms(),
        );
        let _ = pm_services::notify_center::dispatch_event(&store, &secrets, &input).await;
        let _ = cluster_id;
    });
}

/// 严重项的变化方向决定这条通知该不该发：只在「从没有到有」「变多」「变少」「归零」时说话。
pub fn notice_kind(crit: i64, last_notified: i64) -> Option<&'static str> {
    if crit > 0 && last_notified == 0 {
        return Some("fired");
    }
    if crit > last_notified && last_notified > 0 {
        return Some("worsened");
    }
    if crit > 0 && crit < last_notified {
        return Some("improved");
    }
    if crit == 0 && last_notified > 0 {
        return Some("recovered");
    }
    None
}

pub fn notice_text(
    kind: &str,
    cluster_name: &str,
    crit: i64,
    last_notified: i64,
    warn: i64,
) -> String {
    match kind {
        "fired" => format!("{cluster_name}：巡检判出 {crit} 项严重（关注 {warn} 项）"),
        "worsened" => format!(
            "{cluster_name}：严重项从 {last_notified} 增加到 {crit}（关注 {warn} 项）"
        ),
        "improved" => format!("{cluster_name}：严重项从 {last_notified} 降到 {crit}，还没归零"),
        _ => format!("{cluster_name}：巡检严重项已归零（关注 {warn} 项）"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notice_only_speaks_when_the_situation_changes() {
        assert_eq!(notice_kind(3, 0), Some("fired"));
        assert_eq!(notice_kind(5, 3), Some("worsened"));
        assert_eq!(notice_kind(2, 5), Some("improved"));
        assert_eq!(notice_kind(0, 5), Some("recovered"));
        // 一直保持同样的严重项数：不重复打扰
        assert_eq!(notice_kind(3, 3), None);
        assert_eq!(notice_kind(0, 0), None);
    }

    #[test]
    fn due_follows_interval_and_tolerates_bad_timestamps() {
        let now = pm_core::now_ms();
        assert!(is_due(None, 60, now));
        let recent = chrono::DateTime::from_timestamp_millis(now - 30_000)
            .map(|moment| moment.to_rfc3339())
            .unwrap();
        assert!(!is_due(Some(&recent), 60, now));
        let old = chrono::DateTime::from_timestamp_millis(now - 61 * 60_000)
            .map(|moment| moment.to_rfc3339())
            .unwrap();
        assert!(is_due(Some(&old), 60, now));
        assert!(is_due(Some("not-a-date"), 60, now));
    }
}
