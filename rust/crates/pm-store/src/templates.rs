use pm_core::{AppError, AppResult, MessageTemplate};
use rusqlite::{params, OptionalExtension};

use crate::db::Store;

fn map(row: &rusqlite::Row<'_>) -> rusqlite::Result<MessageTemplate> {
    let variables_json: String = row.get(5)?;
    let properties_json: String = row.get(6)?;
    let producer_options_json: String = row.get(7)?;
    Ok(MessageTemplate {
        id: row.get(0)?,
        cluster_id: row.get(1)?,
        topic_uri: row.get(2)?,
        name: row.get(3)?,
        body: row.get(4)?,
        variables: serde_json::from_str(&variables_json).unwrap_or_default(),
        properties: serde_json::from_str(&properties_json).unwrap_or_default(),
        producer_options: serde_json::from_str(&producer_options_json).unwrap_or(serde_json::Value::Null),
        schema_mode: row.get(8)?,
        schema_json: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

/// `topic_uri` 为空表示「该集群全部模板」；传了 topic 则取「这个 topic 能用的」，
/// 即该 topic 自己的加上通用条目（topic_uri = ''）。
pub fn list(store: &Store, cluster_id: &str, topic_uri: Option<&str>) -> AppResult<Vec<MessageTemplate>> {
    store.with(|conn| {
        const BASE: &str = "SELECT id, cluster_id, topic_uri, name, body, variables_json, properties_json, \
             producer_options_json, schema_mode, schema_json, created_at, updated_at FROM message_templates";
        match topic_uri {
            Some(topic) => {
                let mut stmt = conn.prepare(&format!(
                    "{BASE} WHERE cluster_id = ?1 AND (topic_uri = ?2 OR topic_uri = '') \
                     ORDER BY name COLLATE NOCASE"
                ))?;
                let rows = stmt.query_map(params![cluster_id, topic], map)?;
                Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
            }
            None => {
                let mut stmt = conn.prepare(&format!(
                    "{BASE} WHERE cluster_id = ?1 ORDER BY topic_uri, name COLLATE NOCASE"
                ))?;
                let rows = stmt.query_map([cluster_id], map)?;
                Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
            }
        }
    })
}

pub fn get(store: &Store, id: &str) -> AppResult<Option<MessageTemplate>> {
    store.with(|conn| {
        Ok(conn
            .query_row(
                "SELECT id, cluster_id, topic_uri, name, body, variables_json, properties_json, \
                 producer_options_json, schema_mode, schema_json, created_at, updated_at \
                 FROM message_templates WHERE id = ?1",
                [id],
                map,
            )
            .optional()?)
    })
}

pub fn save(store: &Store, template: &MessageTemplate) -> AppResult<String> {
    let id = if template.id.is_empty() {
        pm_core::new_id()
    } else {
        template.id.clone()
    };
    let now = pm_core::now_iso();
    let created = if template.created_at.is_empty() {
        now.clone()
    } else {
        template.created_at.clone()
    };
    let variables = serde_json::to_string(&template.variables)?;
    let properties = serde_json::to_string(&template.properties)?;
    let producer_options = serde_json::to_string(&template.producer_options)?;

    store.with(|conn| {
        let conflict: Option<String> = conn
            .query_row(
                "SELECT id FROM message_templates WHERE cluster_id = ?1 AND topic_uri = ?2 AND name = ?3",
                params![template.cluster_id, template.topic_uri, template.name],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing) = conflict {
            if existing != id {
                return Err(AppError::config(format!(
                    "同一作用域下已存在同名模板「{}」",
                    template.name
                )));
            }
        }
        conn.execute(
            "INSERT INTO message_templates (id, cluster_id, topic_uri, name, body, variables_json, \
             properties_json, producer_options_json, schema_mode, schema_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
             ON CONFLICT(id) DO UPDATE SET topic_uri = excluded.topic_uri, name = excluded.name, \
             body = excluded.body, variables_json = excluded.variables_json, \
             properties_json = excluded.properties_json, \
             producer_options_json = excluded.producer_options_json, \
             schema_mode = excluded.schema_mode, schema_json = excluded.schema_json, \
             updated_at = excluded.updated_at",
            params![
                id,
                template.cluster_id,
                template.topic_uri,
                template.name,
                template.body,
                variables,
                properties,
                producer_options,
                template.schema_mode,
                template.schema_json,
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
        conn.execute("DELETE FROM message_templates WHERE id = ?1", [id])?;
        Ok(())
    })
}

/// 复制模板：同名副本按「原名 副本」「原名 副本 2」递增，不覆盖已有模板。
pub fn duplicate(store: &Store, id: &str) -> AppResult<String> {
    let source = get(store, id)?.ok_or_else(|| AppError::NotFound(format!("模板 {id}")))?;
    let base = format!("{} 副本", source.name);
    let mut name = base.clone();
    let mut index = 2;
    loop {
        let taken = store.with(|conn| {
            Ok(conn
                .query_row(
                    "SELECT 1 FROM message_templates WHERE cluster_id = ?1 AND topic_uri = ?2 AND name = ?3",
                    params![source.cluster_id, source.topic_uri, name],
                    |_| Ok(()),
                )
                .optional()?
                .is_some())
        })?;
        if !taken {
            break;
        }
        name = format!("{base} {index}");
        index += 1;
    }
    let mut copy = source;
    copy.id = pm_core::new_id();
    copy.name = name;
    copy.created_at = pm_core::now_iso();
    save(store, &copy)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clusters;

    fn seed(store: &Store) {
        let cluster = pm_core::Cluster {
            id: "c1".into(),
            name: "local".into(),
            service_url: "pulsar://127.0.0.1:6650".into(),
            created_at: pm_core::now_iso(),
            updated_at: pm_core::now_iso(),
            ..Default::default()
        };
        clusters::insert(store, &cluster).unwrap();
    }

    #[test]
    fn duplicate_never_overwrites() {
        let store = Store::open_in_memory().unwrap();
        seed(&store);
        let template = MessageTemplate {
            id: String::new(),
            cluster_id: "c1".into(),
            topic_uri: String::new(),
            name: "订单".into(),
            body: "{\"id\":1}".into(),
            schema_mode: "none".into(),
            ..Default::default()
        };
        let id = save(&store, &template).unwrap();
        let first_copy = duplicate(&store, &id).unwrap();
        let second_copy = duplicate(&store, &id).unwrap();
        assert_ne!(first_copy, second_copy);
        assert_eq!(list(&store, "c1", None).unwrap().len(), 3);
    }

    #[test]
    fn rejects_duplicate_name_in_same_scope() {
        let store = Store::open_in_memory().unwrap();
        seed(&store);
        let template = MessageTemplate {
            id: String::new(),
            cluster_id: "c1".into(),
            name: "同名".into(),
            body: "{}".into(),
            schema_mode: "none".into(),
            ..Default::default()
        };
        save(&store, &template).unwrap();
        assert!(save(&store, &template).is_err());
    }
}
