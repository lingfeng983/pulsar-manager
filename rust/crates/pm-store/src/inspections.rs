use pm_core::{AppResult, InspectionReport, InspectionSchedule, InspectionThresholds};
use rusqlite::{params, OptionalExtension};

use crate::db::{flag, Store};

pub fn save(store: &Store, report: &InspectionReport) -> AppResult<()> {
    let scope = serde_json::to_string(&report.scope)?;
    let checks = serde_json::to_string(&report.checks)?;
    let thresholds = match &report.thresholds {
        Some(value) => Some(serde_json::to_string(value)?),
        None => None,
    };
    store.with(|conn| {
        conn.execute(
            "INSERT INTO inspections (id, cluster_id, cluster_name, version, generated_at, crit, warn, ok, \
             skip, scope_json, checks_json, thresholds_json, source, markdown) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14) \
             ON CONFLICT(id) DO UPDATE SET crit = excluded.crit, warn = excluded.warn, ok = excluded.ok, \
             skip = excluded.skip, checks_json = excluded.checks_json, markdown = excluded.markdown",
            params![
                report.id,
                report.cluster_id,
                report.cluster_name,
                report.version,
                report.generated_at,
                report.totals.crit,
                report.totals.warn,
                report.totals.ok,
                report.totals.skip,
                scope,
                checks,
                thresholds,
                report.source,
                report.markdown,
            ],
        )?;
        Ok(())
    })
}

pub fn list(store: &Store, cluster_id: Option<&str>, limit: i64) -> AppResult<Vec<InspectionReport>> {
    store.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, cluster_id, cluster_name, version, generated_at, crit, warn, ok, skip, \
             scope_json, checks_json, thresholds_json, source, markdown FROM inspections \
             WHERE (?1 IS NULL OR cluster_id = ?1) ORDER BY generated_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![cluster_id, limit.max(1)], map_report)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

fn map_report(row: &rusqlite::Row<'_>) -> rusqlite::Result<InspectionReport> {
    let scope_json: String = row.get(9)?;
    let checks_json: String = row.get(10)?;
    let thresholds_json: Option<String> = row.get(11)?;
    Ok(InspectionReport {
        id: row.get(0)?,
        cluster_id: row.get(1)?,
        cluster_name: row.get(2)?,
        version: row.get(3)?,
        generated_at: row.get(4)?,
        totals: pm_core::InspectionTotals {
            crit: row.get(5)?,
            warn: row.get(6)?,
            ok: row.get(7)?,
            skip: row.get(8)?,
        },
        scope: serde_json::from_str(&scope_json).unwrap_or_default(),
        checks: serde_json::from_str(&checks_json).unwrap_or_default(),
        thresholds: thresholds_json.and_then(|raw| serde_json::from_str(&raw).ok()),
        source: row.get(12)?,
        markdown: row.get(13)?,
    })
}

pub fn get(store: &Store, id: &str) -> AppResult<Option<InspectionReport>> {
    store.with(|conn| {
        Ok(conn
            .query_row(
                "SELECT id, cluster_id, cluster_name, version, generated_at, crit, warn, ok, skip, \
                 scope_json, checks_json, thresholds_json, source, markdown FROM inspections WHERE id = ?1",
                [id],
                map_report,
            )
            .optional()?)
    })
}

pub fn delete(store: &Store, id: &str) -> AppResult<()> {
    store.with(|conn| {
        conn.execute("DELETE FROM inspections WHERE id = ?1", [id])?;
        Ok(())
    })
}

/// 巡检口径：没有行就是「没改过判定线」，返回 None 让调用方用默认值，
/// 不要在这里补一份默认口径落库。
pub fn profile(store: &Store, cluster_id: &str) -> AppResult<Option<(InspectionThresholds, i64, i64, String)>> {
    store.with(|conn| {
        let row = conn
            .query_row(
                "SELECT thresholds_json, max_namespaces, max_topics, updated_at FROM inspection_profiles WHERE cluster_id = ?1",
                [cluster_id],
                |row| {
                    let raw: String = row.get(0)?;
                    let max_namespaces: i64 = row.get(1)?;
                    let max_topics: i64 = row.get(2)?;
                    let updated_at: String = row.get(3)?;
                    Ok((raw, max_namespaces, max_topics, updated_at))
                },
            )
            .optional()?;
        Ok(row.and_then(|(raw, max_namespaces, max_topics, updated_at)| {
            let thresholds: InspectionThresholds = serde_json::from_str(&raw).ok()?;
            Some((thresholds, max_namespaces, max_topics, updated_at))
        }))
    })
}

pub fn save_profile(
    store: &Store,
    cluster_id: &str,
    thresholds: &InspectionThresholds,
    max_namespaces: i64,
    max_topics: i64,
) -> AppResult<()> {
    let raw = serde_json::to_string(thresholds)?;
    store.with(|conn| {
        conn.execute(
            "INSERT INTO inspection_profiles (cluster_id, thresholds_json, max_namespaces, max_topics, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(cluster_id) DO UPDATE SET \
             thresholds_json = excluded.thresholds_json, max_namespaces = excluded.max_namespaces, \
             max_topics = excluded.max_topics, updated_at = excluded.updated_at",
            params![cluster_id, raw, max_namespaces, max_topics, pm_core::now_iso()],
        )?;
        Ok(())
    })
}

pub fn schedule(store: &Store, cluster_id: &str) -> AppResult<Option<InspectionSchedule>> {
    store.with(|conn| {
        Ok(conn
            .query_row(
                "SELECT cluster_id, enabled, interval_minutes, notify_on_crit, last_run_at, last_error, \
                 last_notified_crit, updated_at FROM inspection_schedules WHERE cluster_id = ?1",
                [cluster_id],
                |row| {
                    Ok(InspectionSchedule {
                        cluster_id: row.get(0)?,
                        enabled: row.get::<_, i64>(1)? != 0,
                        interval_minutes: row.get(2)?,
                        notify_on_crit: row.get::<_, i64>(3)? != 0,
                        last_run_at: row.get(4)?,
                        last_error: row.get(5)?,
                        last_notified_crit: row.get(6)?,
                        updated_at: row.get(7)?,
                    })
                },
            )
            .optional()?)
    })
}

pub fn enabled_schedules(store: &Store) -> AppResult<Vec<InspectionSchedule>> {
    store.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT cluster_id, enabled, interval_minutes, notify_on_crit, last_run_at, last_error, \
             last_notified_crit, updated_at FROM inspection_schedules WHERE enabled = 1",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(InspectionSchedule {
                cluster_id: row.get(0)?,
                enabled: row.get::<_, i64>(1)? != 0,
                interval_minutes: row.get(2)?,
                notify_on_crit: row.get::<_, i64>(3)? != 0,
                last_run_at: row.get(4)?,
                last_error: row.get(5)?,
                last_notified_crit: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

pub fn save_schedule(store: &Store, schedule: &InspectionSchedule) -> AppResult<()> {
    if schedule.interval_minutes < 1 {
        return Err(pm_core::AppError::config("巡检间隔至少 1 分钟"));
    }
    store.with(|conn| {
        conn.execute(
            "INSERT INTO inspection_schedules (cluster_id, enabled, interval_minutes, notify_on_crit, \
             last_run_at, last_error, last_notified_crit, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
             ON CONFLICT(cluster_id) DO UPDATE SET enabled = excluded.enabled, \
             interval_minutes = excluded.interval_minutes, notify_on_crit = excluded.notify_on_crit, \
             last_run_at = excluded.last_run_at, last_error = excluded.last_error, \
             last_notified_crit = excluded.last_notified_crit, updated_at = excluded.updated_at",
            params![
                schedule.cluster_id,
                flag(schedule.enabled),
                schedule.interval_minutes,
                flag(schedule.notify_on_crit),
                schedule.last_run_at,
                schedule.last_error,
                schedule.last_notified_crit,
                pm_core::now_iso(),
            ],
        )?;
        Ok(())
    })
}

/// 只更新运行结果这三列：调度开关与间隔是用户配置，跑一轮不该把并发改过的设置写回去。
pub fn mark_run(
    store: &Store,
    cluster_id: &str,
    ran_at: &str,
    error: Option<&str>,
    notified_crit: Option<i64>,
) -> AppResult<()> {
    store.with(|conn| {
        conn.execute(
            "UPDATE inspection_schedules SET last_run_at = ?2, last_error = ?3, \
             last_notified_crit = COALESCE(?4, last_notified_crit), updated_at = ?5 WHERE cluster_id = ?1",
            params![cluster_id, ran_at, error, notified_crit, pm_core::now_iso()],
        )?;
        Ok(())
    })
}

/// 清空这台集群的全部历史（界面上「清空历史」就是这一个动作）。
pub fn delete_cluster(store: &Store, cluster_id: &str) -> AppResult<i64> {
    store.with(|conn| {
        let affected = conn.execute("DELETE FROM inspections WHERE cluster_id = ?1", [cluster_id])?;
        Ok(affected as i64)
    })
}

/// 上一份报告：按生成时间倒序，跳过当前这份。
pub fn previous(
    store: &Store,
    cluster_id: &str,
    generated_at: &str,
    current_id: &str,
) -> AppResult<Option<InspectionReport>> {
    store.with(|conn| {
        Ok(conn
            .query_row(
                "SELECT id, cluster_id, cluster_name, version, generated_at, crit, warn, ok, skip,                  scope_json, checks_json, thresholds_json, source, markdown FROM inspections                  WHERE cluster_id = ?1 AND id <> ?2 AND generated_at <= ?3                  ORDER BY generated_at DESC LIMIT 1",
                params![cluster_id, current_id, generated_at],
                map_report,
            )
            .optional()?)
    })
}

/// 每台集群只留最近 N 份：历史的价值在「最近几次怎么变的」，再往前翻该导出而不是留着。
pub fn prune(store: &Store, cluster_id: &str, keep: i64) -> AppResult<i64> {
    store.with(|conn| {
        let affected = conn.execute(
            "DELETE FROM inspections WHERE cluster_id = ?1 AND id NOT IN (             SELECT id FROM inspections WHERE cluster_id = ?1 ORDER BY generated_at DESC LIMIT ?2)",
            params![cluster_id, keep.max(1)],
        )?;
        Ok(affected as i64)
    })
}

/// 每台集群最近的一份（同一毫秒里两行时只留第一行）。
pub fn latest_per_cluster(store: &Store) -> AppResult<Vec<InspectionReport>> {
    store.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, cluster_id, cluster_name, version, generated_at, crit, warn, ok, skip,              scope_json, checks_json, thresholds_json, source, markdown FROM inspections              WHERE id IN (SELECT id FROM inspections i2 WHERE i2.cluster_id = inspections.cluster_id              ORDER BY generated_at DESC LIMIT 1) ORDER BY generated_at DESC",
        )?;
        let rows = stmt.query_map([], map_report)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

/// 全部调度行：汇总页要看「哪几台开着定时」。
pub fn all_schedules(store: &Store) -> AppResult<Vec<InspectionSchedule>> {
    store.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT cluster_id, enabled, interval_minutes, notify_on_crit, last_run_at, last_error,              last_notified_crit, updated_at FROM inspection_schedules",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(InspectionSchedule {
                cluster_id: row.get(0)?,
                enabled: row.get::<_, i64>(1)? != 0,
                interval_minutes: row.get(2)?,
                notify_on_crit: row.get::<_, i64>(3)? != 0,
                last_run_at: row.get(4)?,
                last_error: row.get(5)?,
                last_notified_crit: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}
