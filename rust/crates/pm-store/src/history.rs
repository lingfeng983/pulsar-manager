use pm_core::{AppResult, SendHistory};
use rusqlite::{params, OptionalExtension};

use crate::db::Store;

pub fn insert(store: &Store, history: &SendHistory) -> AppResult<i64> {
    store.with(|conn| {
        conn.execute(
            "INSERT INTO send_history (cluster_id, topic_uri, template_id, template_name, body_preview, \
             body_full, body_bytes, message_count, message_id, status, error_message, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                history.cluster_id,
                history.topic_uri,
                history.template_id,
                history.template_name,
                history.body_preview,
                history.body_full,
                history.body_bytes,
                history.message_count,
                history.message_id,
                history.status,
                history.error_message,
                history.created_at,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    })
}

pub fn list(store: &Store, cluster_id: Option<&str>, limit: i64) -> AppResult<Vec<SendHistory>> {
    store.with(|conn| {
        let sql = "SELECT id, cluster_id, topic_uri, template_id, template_name, body_preview, body_bytes, \
             message_count, message_id, status, error_message, created_at FROM send_history \
             WHERE (?1 IS NULL OR cluster_id = ?1) ORDER BY id DESC LIMIT ?2";
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![cluster_id, limit.max(1)], |row| {
            Ok(SendHistory {
                id: row.get(0)?,
                cluster_id: row.get(1)?,
                topic_uri: row.get(2)?,
                template_id: row.get(3)?,
                template_name: row.get(4)?,
                body_preview: row.get(5)?,
                body_bytes: row.get(6)?,
                message_count: row.get(7)?,
                message_id: row.get(8)?,
                status: row.get(9)?,
                error_message: row.get(10)?,
                created_at: row.get(11)?,
                ..Default::default()
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

/// 单条取全文：列表不带 body_full（几十 KB × 200 行会把界面拖死），
/// 只有「原样重发」这一条路径需要它。
pub fn get(store: &Store, id: i64) -> AppResult<Option<SendHistory>> {
    store.with(|conn| {
        Ok(conn
            .query_row(
                "SELECT id, cluster_id, topic_uri, template_id, template_name, body_preview, body_bytes,                  message_count, message_id, status, error_message, created_at, body_full                  FROM send_history WHERE id = ?1",
                [id],
                |row| {
                    Ok(SendHistory {
                        id: row.get(0)?,
                        cluster_id: row.get(1)?,
                        topic_uri: row.get(2)?,
                        template_id: row.get(3)?,
                        template_name: row.get(4)?,
                        body_preview: row.get(5)?,
                        body_bytes: row.get(6)?,
                        message_count: row.get(7)?,
                        message_id: row.get(8)?,
                        status: row.get(9)?,
                        error_message: row.get(10)?,
                        created_at: row.get(11)?,
                        body_full: row.get(12)?,
                    })
                },
            )
            .optional()?)
    })
}

/// 工作台的发送历史按「集群 + topic」取，最近的在最前。
pub fn list_for_topic(
    store: &Store,
    cluster_id: &str,
    topic_uri: &str,
    limit: i64,
) -> AppResult<Vec<SendHistory>> {
    store.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, cluster_id, topic_uri, template_id, template_name, body_preview, body_bytes,              message_count, message_id, status, error_message, created_at FROM send_history              WHERE cluster_id = ?1 AND topic_uri = ?2 ORDER BY id DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![cluster_id, topic_uri, limit.max(1)], |row| {
            Ok(SendHistory {
                id: row.get(0)?,
                cluster_id: row.get(1)?,
                topic_uri: row.get(2)?,
                template_id: row.get(3)?,
                template_name: row.get(4)?,
                body_preview: row.get(5)?,
                body_bytes: row.get(6)?,
                message_count: row.get(7)?,
                message_id: row.get(8)?,
                status: row.get(9)?,
                error_message: row.get(10)?,
                created_at: row.get(11)?,
                ..Default::default()
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}
