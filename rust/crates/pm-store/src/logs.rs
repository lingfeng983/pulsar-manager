use pm_core::{AppResult, OperationLog};
use rusqlite::params;

use crate::db::Store;

/// 凭据不进 details（日志会被导出与查看，全部明文）。
pub fn insert(store: &Store, log: &OperationLog) -> AppResult<i64> {
    store.with(|conn| {
        conn.execute(
            "INSERT INTO operation_logs (cluster_id, action, resource_type, resource_id, resource_name, \
             details, result, error_message, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                log.cluster_id,
                log.action,
                log.resource_type,
                log.resource_id,
                log.resource_name,
                log.details,
                log.result,
                log.error_message,
                log.created_at,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    })
}

pub fn list(store: &Store, limit: i64) -> AppResult<Vec<OperationLog>> {
    store.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, cluster_id, action, resource_type, resource_id, resource_name, details, \
             result, error_message, created_at FROM operation_logs ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit.max(1)], |row| {
            Ok(OperationLog {
                id: row.get(0)?,
                cluster_id: row.get(1)?,
                action: row.get(2)?,
                resource_type: row.get(3)?,
                resource_id: row.get(4)?,
                resource_name: row.get(5)?,
                details: row.get(6)?,
                result: row.get(7)?,
                error_message: row.get(8)?,
                created_at: row.get(9)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

pub fn clear(store: &Store) -> AppResult<()> {
    store.with(|conn| {
        conn.execute("DELETE FROM operation_logs", [])?;
        Ok(())
    })
}
