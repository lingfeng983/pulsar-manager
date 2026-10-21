use pm_core::{AlertEvent, AlertRule, AppError, AppResult};
use rusqlite::{params, OptionalExtension};

use crate::db::{flag, Store};

fn map_rule(row: &rusqlite::Row<'_>) -> rusqlite::Result<AlertRule> {
    Ok(AlertRule {
        id: row.get(0)?,
        cluster_id: row.get(1)?,
        name: row.get(2)?,
        enabled: row.get::<_, i64>(3)? != 0,
        scope: row.get(4)?,
        tenant: row.get(5)?,
        namespace: row.get(6)?,
        topic: row.get(7)?,
        persistent: row.get::<_, i64>(8)? != 0,
        metric: row.get(9)?,
        comparator: row.get(10)?,
        threshold: row.get(11)?,
        consecutive: row.get(12)?,
        notify: row.get::<_, i64>(13)? != 0,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

pub fn list_rules(store: &Store, cluster_id: &str) -> AppResult<Vec<AlertRule>> {
    store.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, cluster_id, name, enabled, scope, tenant, namespace, topic, persistent, metric, \
             comparator, threshold, consecutive, notify, created_at, updated_at \
             FROM alert_rules WHERE cluster_id = ?1 ORDER BY name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([cluster_id], map_rule)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

pub fn save_rule(store: &Store, rule: &AlertRule) -> AppResult<String> {
    let id = if rule.id.is_empty() {
        pm_core::new_id()
    } else {
        rule.id.clone()
    };
    let now = pm_core::now_iso();
    store.with(|conn| {
        let conflict: Option<String> = conn
            .query_row(
                "SELECT id FROM alert_rules WHERE cluster_id = ?1 AND name = ?2",
                params![rule.cluster_id, rule.name],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing) = conflict {
            if existing != id {
                return Err(AppError::config(format!("同一集群下已存在同名规则「{}」", rule.name)));
            }
        }
        conn.execute(
            "INSERT INTO alert_rules (id, cluster_id, name, enabled, scope, tenant, namespace, topic, \
             persistent, metric, comparator, threshold, consecutive, notify, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16) \
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, enabled = excluded.enabled, \
             scope = excluded.scope, tenant = excluded.tenant, namespace = excluded.namespace, \
             topic = excluded.topic, persistent = excluded.persistent, metric = excluded.metric, \
             comparator = excluded.comparator, threshold = excluded.threshold, \
             consecutive = excluded.consecutive, notify = excluded.notify, updated_at = excluded.updated_at",
            params![
                id,
                rule.cluster_id,
                rule.name,
                flag(rule.enabled),
                rule.scope,
                rule.tenant,
                rule.namespace,
                rule.topic,
                flag(rule.persistent),
                rule.metric,
                rule.comparator,
                rule.threshold,
                rule.consecutive,
                flag(rule.notify),
                if rule.created_at.is_empty() {
                    now.clone()
                } else {
                    rule.created_at.clone()
                },
                now,
            ],
        )?;
        Ok(())
    })?;
    Ok(id)
}

pub fn delete_rule(store: &Store, id: &str) -> AppResult<()> {
    store.with(|conn| {
        conn.execute("DELETE FROM alert_rules WHERE id = ?1", [id])?;
        Ok(())
    })
}

pub fn open_event(store: &Store, rule_id: &str) -> AppResult<Option<AlertEvent>> {
    store.with(|conn| {
        Ok(conn
            .query_row(
                "SELECT id, rule_id, cluster_id, rule_name, scope_label, metric, comparator, threshold, \
                 value, last_value, state, message, fired_at, last_seen_at, resolved_at, acked_at \
                 FROM alert_events WHERE rule_id = ?1 AND resolved_at IS NULL LIMIT 1",
                [rule_id],
                map_event,
            )
            .optional()?)
    })
}

fn map_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<AlertEvent> {
    Ok(AlertEvent {
        id: row.get(0)?,
        rule_id: row.get(1)?,
        cluster_id: row.get(2)?,
        rule_name: row.get(3)?,
        scope_label: row.get(4)?,
        metric: row.get(5)?,
        comparator: row.get(6)?,
        threshold: row.get(7)?,
        value: row.get(8)?,
        last_value: row.get(9)?,
        state: row.get(10)?,
        message: row.get(11)?,
        fired_at: row.get(12)?,
        last_seen_at: row.get(13)?,
        resolved_at: row.get(14)?,
        acked_at: row.get(15)?,
    })
}

pub fn insert_event(store: &Store, event: &AlertEvent) -> AppResult<i64> {
    store.with(|conn| {
        conn.execute(
            "INSERT INTO alert_events (rule_id, cluster_id, rule_name, scope_label, metric, comparator, \
             threshold, value, last_value, state, message, fired_at, last_seen_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                event.rule_id,
                event.cluster_id,
                event.rule_name,
                event.scope_label,
                event.metric,
                event.comparator,
                event.threshold,
                event.value,
                event.last_value,
                event.state,
                event.message,
                event.fired_at,
                event.last_seen_at,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    })
}

pub fn update_open_event(store: &Store, id: i64, value: f64, message: &str) -> AppResult<()> {
    store.with(|conn| {
        // 空串表示「这次没有新说明」，保留首次立案时的 message；否则第二轮评估
        // 会把告警中心的说明列刷成空白。
        conn.execute(
            "UPDATE alert_events SET last_value = ?2, value = ?2, \
             message = CASE WHEN ?3 = '' THEN message ELSE ?3 END, last_seen_at = ?4 WHERE id = ?1",
            params![id, value, message, pm_core::now_ms()],
        )?;
        Ok(())
    })
}

pub fn resolve_event(store: &Store, id: i64, last_value: f64) -> AppResult<()> {
    store.with(|conn| {
        conn.execute(
            "UPDATE alert_events SET state = 'resolved', resolved_at = ?2, last_seen_at = ?2, \
             last_value = ?3 WHERE id = ?1",
            params![id, pm_core::now_ms(), last_value],
        )?;
        Ok(())
    })
}

pub fn get_rule(store: &Store, id: &str) -> AppResult<Option<AlertRule>> {
    store.with(|conn| {
        Ok(conn
            .query_row(
                "SELECT id, cluster_id, name, enabled, scope, tenant, namespace, topic, persistent, metric, \
                 comparator, threshold, consecutive, notify, created_at, updated_at \
                 FROM alert_rules WHERE id = ?1",
                [id],
                map_rule,
            )
            .optional()?)
    })
}

pub fn delete_events(store: &Store, ids: &[i64]) -> AppResult<i64> {
    if ids.is_empty() {
        return Ok(0);
    }
    store.with(|conn| {
        let mut removed = 0;
        for id in ids {
            removed += conn.execute("DELETE FROM alert_events WHERE id = ?1", [id])? as i64;
        }
        Ok(removed)
    })
}

pub fn ack_event(store: &Store, id: i64) -> AppResult<()> {
    store.with(|conn| {
        conn.execute(
            "UPDATE alert_events SET acked_at = ?2 WHERE id = ?1",
            params![id, pm_core::now_ms()],
        )?;
        Ok(())
    })
}

pub fn list_events(
    store: &Store,
    cluster_id: Option<&str>,
    limit: i64,
) -> AppResult<Vec<AlertEvent>> {
    store.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, rule_id, cluster_id, rule_name, scope_label, metric, comparator, threshold, \
             value, last_value, state, message, fired_at, last_seen_at, resolved_at, acked_at \
             FROM alert_events WHERE (?1 IS NULL OR cluster_id = ?1) ORDER BY fired_at DESC, id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![cluster_id, limit.max(1)], map_event)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}
