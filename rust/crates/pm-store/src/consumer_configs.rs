//! 消费者会话配置：纯本地 SQLite，集群离线也能翻出上次调好的消费参数。
//!
//! `config_json` 整段存草稿（订阅类型、初始位置、批量大小、确认策略……），
//! 行上只保留「作用域与名称」这几列——唯一性约束建在列上，改名与改作用域才查得出来。

use pm_core::{AppError, AppResult};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::Store;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerSessionConfig {
    pub id: String,
    pub cluster_id: String,
    pub topic_uri: String,
    pub subscription: String,
    pub name: String,
    pub config: Value,
    pub created_at: String,
    pub updated_at: String,
}

fn map(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConsumerSessionConfig> {
    let config_json: String = row.get(5)?;
    Ok(ConsumerSessionConfig {
        id: row.get(0)?,
        cluster_id: row.get(1)?,
        topic_uri: row.get(2)?,
        subscription: row.get(3)?,
        name: row.get(4)?,
        config: serde_json::from_str(&config_json).unwrap_or(Value::Null),
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

const COLUMNS: &str =
    "id, cluster_id, topic_uri, subscription, name, config_json, created_at, updated_at";

/// `topic_uri` 为空表示「该集群全部」；传了 topic 则取「这个 topic 能用的」，
/// 即该 topic 自己的加上通用条目（topic_uri = ''）。
pub fn list(store: &Store, cluster_id: &str, topic_uri: Option<&str>) -> AppResult<Vec<ConsumerSessionConfig>> {
    store.with(|conn| {
        let base = format!("SELECT {COLUMNS} FROM consumer_session_configs");
        match topic_uri {
            Some(topic) => {
                let mut stmt = conn.prepare(&format!(
                    "{base} WHERE cluster_id = ?1 AND (topic_uri = ?2 OR topic_uri = '') \
                     ORDER BY name COLLATE NOCASE"
                ))?;
                let rows = stmt.query_map(params![cluster_id, topic], map)?;
                Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
            }
            None => {
                let mut stmt = conn.prepare(&format!(
                    "{base} WHERE cluster_id = ?1 ORDER BY topic_uri, name COLLATE NOCASE"
                ))?;
                let rows = stmt.query_map([cluster_id], map)?;
                Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
            }
        }
    })
}

pub fn get(store: &Store, id: &str) -> AppResult<Option<ConsumerSessionConfig>> {
    store.with(|conn| {
        Ok(conn
            .query_row(
                &format!("SELECT {COLUMNS} FROM consumer_session_configs WHERE id = ?1"),
                [id],
                map,
            )
            .optional()?)
    })
}

pub fn require(store: &Store, id: &str) -> AppResult<ConsumerSessionConfig> {
    get(store, id)?.ok_or_else(|| AppError::NotFound(format!("消费配置 {id}")))
}

pub fn save(store: &Store, config: &ConsumerSessionConfig) -> AppResult<String> {
    let id = if config.id.is_empty() {
        pm_core::new_id()
    } else {
        config.id.clone()
    };
    let now = pm_core::now_iso();
    let created = if config.created_at.is_empty() {
        now.clone()
    } else {
        config.created_at.clone()
    };
    let payload = serde_json::to_string(&config.config)?;

    store.with(|conn| {
        let conflict: Option<String> = conn
            .query_row(
                "SELECT id FROM consumer_session_configs \
                 WHERE cluster_id = ?1 AND topic_uri = ?2 AND subscription = ?3 AND name = ?4",
                params![config.cluster_id, config.topic_uri, config.subscription, config.name],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing) = conflict {
            if existing != id {
                return Err(AppError::config(format!(
                    "同一作用域下已存在同名消费配置「{}」",
                    config.name
                )));
            }
        }
        conn.execute(
            "INSERT INTO consumer_session_configs \
             (id, cluster_id, topic_uri, subscription, name, config_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
             ON CONFLICT(id) DO UPDATE SET cluster_id = excluded.cluster_id, \
             topic_uri = excluded.topic_uri, subscription = excluded.subscription, \
             name = excluded.name, config_json = excluded.config_json, updated_at = excluded.updated_at",
            params![
                id,
                config.cluster_id,
                config.topic_uri,
                config.subscription,
                config.name,
                payload,
                created,
                now,
            ],
        )?;
        Ok(())
    })?;
    Ok(id)
}

pub fn delete(store: &Store, id: &str) -> AppResult<()> {
    store.with(|conn| {
        conn.execute("DELETE FROM consumer_session_configs WHERE id = ?1", [id])?;
        Ok(())
    })
}

/// 复制：同名副本按「原名 副本」「原名 副本 2」递增，不覆盖已有配置。
pub fn duplicate(
    store: &Store,
    id: &str,
    name: Option<&str>,
    topic_uri: Option<&str>,
    subscription: Option<&str>,
) -> AppResult<String> {
    let source = require(store, id)?;
    let mut copy = ConsumerSessionConfig {
        id: String::new(),
        cluster_id: source.cluster_id.clone(),
        topic_uri: topic_uri.map(str::to_string).unwrap_or(source.topic_uri.clone()),
        subscription: subscription
            .map(str::to_string)
            .unwrap_or(source.subscription.clone()),
        name: source.name.clone(),
        config: source.config.clone(),
        created_at: String::new(),
        updated_at: String::new(),
    };

    match name {
        Some(name) if !name.trim().is_empty() => copy.name = name.trim().to_string(),
        _ => {
            let base = format!("{} 副本", source.name);
            let mut candidate = base.clone();
            let mut index = 2;
            while exists_name(store, &copy.cluster_id, &copy.topic_uri, &copy.subscription, &candidate)? {
                candidate = format!("{base} {index}");
                index += 1;
            }
            copy.name = candidate;
        }
    }
    save(store, &copy)
}

fn exists_name(
    store: &Store,
    cluster_id: &str,
    topic_uri: &str,
    subscription: &str,
    name: &str,
) -> AppResult<bool> {
    store.with(|conn| {
        let found: Option<String> = conn
            .query_row(
                "SELECT id FROM consumer_session_configs \
                 WHERE cluster_id = ?1 AND topic_uri = ?2 AND subscription = ?3 AND name = ?4",
                params![cluster_id, topic_uri, subscription, name],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        let store = Store::open_in_memory().unwrap();
        // 会话配置对 cluster_id 有外键：没有这条集群行，落库会被约束挡下
        crate::clusters::insert(
            &store,
            &pm_core::Cluster {
                id: "c1".into(),
                name: "c1".into(),
                service_url: "pulsar://127.0.0.1:6650".into(),
                admin_api_timeout: 5000,
                status: "unknown".into(),
                ..Default::default()
            },
        )
        .unwrap();
        store
    }

    fn draft(name: &str) -> ConsumerSessionConfig {
        ConsumerSessionConfig {
            cluster_id: "c1".into(),
            topic_uri: "persistent://public/default/t".into(),
            subscription: "sub".into(),
            name: name.into(),
            config: serde_json::json!({"subscriptionType": "Shared"}),
            ..Default::default()
        }
    }

    #[test]
    fn rejects_duplicate_name_in_same_scope() {
        let store = store();
        save(&store, &draft("a")).unwrap();
        let error = save(&store, &draft("a")).unwrap_err();
        assert!(error.to_string().contains("同名"));
    }

    #[test]
    fn duplicate_counts_up() {
        let store = store();
        let id = save(&store, &draft("a")).unwrap();
        let first = duplicate(&store, &id, None, None, None).unwrap();
        let second = duplicate(&store, &id, None, None, None).unwrap();
        assert_eq!(require(&store, &first).unwrap().name, "a 副本");
        assert_eq!(require(&store, &second).unwrap().name, "a 副本 2");
    }
}
