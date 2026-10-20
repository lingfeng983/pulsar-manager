//! 跨集群巡检汇总：把「每台集群自己最近的一份报告」摆成一屏，再把同一类严重项合并。
//!
//! 读的那一半只查库、不碰 broker，所以打开页面是瞬时的；代价是数字可能已经几小时前，
//! 因此每行都带「最近一次」与新鲜度。编排（逐台跑 + 推进度）在 rpc 层。

use std::collections::BTreeMap;

use pm_core::{AppResult, InspectionReport, InspectionSchedule};
use pm_store::Store;
use serde_json::{json, Value};

const DEFAULT_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
const STALE_FACTOR: i64 = 3;

fn window_ms(schedule: Option<&InspectionSchedule>) -> i64 {
    match schedule {
        Some(schedule) if schedule.enabled => schedule.interval_minutes.max(60) * 60_000,
        _ => DEFAULT_WINDOW_MS,
    }
}

/// 时间戳解析不出来判 stale 而不是 never：库里确实有这一行，说「从没看过」是假话。
fn parse_iso(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|value| value.timestamp_millis())
}

fn freshness(report: Option<&InspectionReport>, now_ms: i64, schedule: Option<&InspectionSchedule>) -> &'static str {
    let Some(report) = report else {
        return "never";
    };
    let Some(generated_at) = parse_iso(&report.generated_at) else {
        return "stale";
    };
    let window = window_ms(schedule);
    let age = now_ms - generated_at;
    if age <= window {
        "fresh"
    } else if age <= window * STALE_FACTOR {
        "aging"
    } else {
        "stale"
    }
}

fn section_of(totals: Option<&pm_core::InspectionTotals>) -> &'static str {
    match totals {
        None => "never",
        Some(totals) if totals.crit > 0 => "crit",
        Some(totals) if totals.warn > 0 => "warn",
        _ => "quiet",
    }
}

fn section_order(section: &str) -> i32 {
    match section {
        "crit" => 0,
        "warn" => 1,
        "never" => 2,
        _ => 3,
    }
}

fn age_ms(report: Option<&InspectionReport>, now_ms: i64) -> i64 {
    report
        .and_then(|report| parse_iso(&report.generated_at))
        .map(|generated_at| (now_ms - generated_at).max(0))
        .unwrap_or(i64::MAX)
}

/// 列表行结构（与 `InspectionHistoryRow` 对齐）：checks 不进这一格。
fn history_row(report: &InspectionReport) -> Value {
    json!({
        "id": report.id,
        "clusterId": report.cluster_id,
        "clusterName": report.cluster_name,
        "generatedAt": report.generated_at,
        "version": report.version,
        "totals": report.totals,
        "scope": report.scope,
        "source": report.source,
    })
}

pub fn build_summary(store: &Store, now_ms: i64) -> AppResult<Value> {
    let clusters = pm_store::clusters::list(store)?;
    let latest_rows = pm_store::inspections::latest_per_cluster(store)?;
    let schedules = pm_store::inspections::all_schedules(store)?;

    let mut latest: BTreeMap<String, InspectionReport> = BTreeMap::new();
    for report in latest_rows {
        latest.entry(report.cluster_id.clone()).or_insert(report);
    }
    let mut schedule_map: BTreeMap<String, InspectionSchedule> = BTreeMap::new();
    for schedule in schedules {
        schedule_map.insert(schedule.cluster_id.clone(), schedule);
    }

    let mut rows: Vec<Value> = Vec::new();
    let mut index: Vec<(i32, i64, i64, i64, String)> = Vec::new();
    for cluster in &clusters {
        let report = latest.get(&cluster.id);
        let schedule = schedule_map.get(&cluster.id);
        let checks = report.map(|report| report.checks.clone()).unwrap_or_default();
        let row = json!({
            "clusterId": cluster.id,
            "clusterName": cluster.name,
            "latest": report.map(history_row),
            "checks": checks,
            "schedule": schedule,
            "freshness": freshness(report, now_ms, schedule),
        });
        let totals = report.map(|report| &report.totals);
        index.push((
            section_order(section_of(totals)),
            -(totals.map(|totals| totals.crit).unwrap_or(0)),
            -(totals.map(|totals| totals.warn).unwrap_or(0)),
            age_ms(report, now_ms),
            cluster.name.clone(),
        ));
        rows.push(row);
    }

    // 先按堆、再按严重/关注数量、最后按「多久没人看过」；越旧越靠前
    let mut order: Vec<usize> = (0..rows.len()).collect();
    order.sort_by(|a, b| {
        let left = &index[*a];
        let right = &index[*b];
        left.0
            .cmp(&right.0)
            .then(left.1.cmp(&right.1))
            .then(left.2.cmp(&right.2))
            .then(left.3.cmp(&right.3))
            .then(left.4.cmp(&right.4))
    });
    let clusters_sorted: Vec<Value> = order.into_iter().map(|index| rows[index].clone()).collect();

    // 同一类严重项在几台集群上一起亮时合并成一组
    let mut groups: BTreeMap<String, (String, Vec<Value>)> = BTreeMap::new();
    for row in &clusters_sorted {
        let Some(checks) = row["checks"].as_array() else {
            continue;
        };
        for check in checks {
            if check["level"].as_str() != Some("crit") {
                continue;
            }
            let key = check["key"].as_str().unwrap_or_default().to_string();
            let title = check["title"].as_str().unwrap_or_default().to_string();
            let entry = groups
                .entry(key)
                .or_insert_with(|| (title.clone(), Vec::new()));
            if entry.0.is_empty() {
                entry.0 = title;
            }
            entry.1.push(json!({
                "clusterId": row["clusterId"],
                "clusterName": row["clusterName"],
                "summary": check["summary"],
                "suggestion": check["suggestion"],
            }));
        }
    }
    let mut crit_groups: Vec<Value> = groups
        .into_iter()
        .map(|(key, (title, items))| {
            json!({"key": key, "title": title, "items": items})
        })
        .collect();
    crit_groups.sort_by(|a, b| {
        let left = a["items"].as_array().map(Vec::len).unwrap_or(0);
        let right = b["items"].as_array().map(Vec::len).unwrap_or(0);
        right.cmp(&left).then_with(|| {
            a["title"]
                .as_str()
                .unwrap_or_default()
                .cmp(b["title"].as_str().unwrap_or_default())
        })
    });

    let mut never = 0i64;
    let mut crit = 0i64;
    let mut warn = 0i64;
    let mut stale = 0i64;
    let mut scheduled = 0i64;
    for row in &clusters_sorted {
        match row["latest"]["totals"].as_object() {
            Some(totals) => {
                crit += totals.get("crit").and_then(Value::as_i64).unwrap_or(0);
                warn += totals.get("warn").and_then(Value::as_i64).unwrap_or(0);
            }
            None => never += 1,
        }
        let fresh = row["freshness"].as_str().unwrap_or("never");
        if fresh == "stale" || fresh == "aging" {
            stale += 1;
        }
        if row["schedule"]["enabled"] == true {
            scheduled += 1;
        }
    }
    let total = clusters_sorted.len() as i64;

    Ok(json!({
        "generatedAt": iso_from_ms(now_ms),
        "clusters": clusters_sorted,
        "critGroups": crit_groups,
        "totals": {
            "clusters": total,
            "inspected": total - never,
            "never": never,
            "crit": crit,
            "warn": warn,
            "stale": stale,
            "scheduled": scheduled,
        },
        "failures": [],
        "skipped": [],
    }))
}

fn iso_from_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(pm_core::now_iso)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn freshness_follows_schedule_interval() {
        let now = 1_000_000_000_000i64;
        // 四天前：超过 24h 窗口的三倍（72h）才算 stale，正好卡在 72h 上的是 aging
        let report = InspectionReport {
            generated_at: iso_from_ms(now - 4 * 24 * 60 * 60 * 1000),
            ..Default::default()
        };
        // 没开定时按 24 小时 → 四天前是 stale
        assert_eq!(freshness(Some(&report), now, None), "stale");
        // 开着 7 天一轮 → 同一份报告仍然新鲜
        let schedule = InspectionSchedule {
            cluster_id: "c".into(),
            enabled: true,
            interval_minutes: 7 * 24 * 60,
            ..Default::default()
        };
        assert_eq!(freshness(Some(&report), now, Some(&schedule)), "fresh");
        assert_eq!(freshness(None, now, None), "never");
    }

    #[test]
    fn sections_put_never_before_quiet() {
        assert_eq!(section_order(section_of(None)), 2);
        assert_eq!(
            section_order(section_of(Some(&pm_core::InspectionTotals::default()))),
            3
        );
        let crit = pm_core::InspectionTotals { crit: 1, ..Default::default() };
        assert_eq!(section_order(section_of(Some(&crit))), 0);
    }
}
