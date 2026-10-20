use pm_core::{AppError, AppResult, Cluster};
use rusqlite::{params, OptionalExtension, Row};

use crate::db::{flag, Store};

const COLUMNS: &str = "id, name, service_url, web_service_url, auth_plugin, auth_params, tls_enabled, \
     tls_trust_certs, use_ssh_tunnel, ssh_config_id, use_k8s_forward, k8s_config_id, \
     admin_api_timeout, status, version, created_at, updated_at";

fn map(row: &Row<'_>) -> rusqlite::Result<Cluster> {
    Ok(Cluster {
        id: row.get(0)?,
        name: row.get(1)?,
        service_url: row.get(2)?,
        web_service_url: row.get(3)?,
        auth_plugin: row.get(4)?,
        auth_params_enc: row.get(5)?,
        tls_enabled: row.get::<_, i64>(6)? != 0,
        tls_trust_certs_enc: row.get(7)?,
        use_ssh_tunnel: row.get::<_, i64>(8)? != 0,
        ssh_config_id: row.get(9)?,
        use_k8s_forward: row.get::<_, i64>(10)? != 0,
        k8s_config_id: row.get(11)?,
        admin_api_timeout: row.get(12)?,
        status: row.get(13)?,
        version: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

pub fn list(store: &Store) -> AppResult<Vec<Cluster>> {
    store.with(|conn| {
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM clusters ORDER BY name COLLATE NOCASE"
        ))?;
        let rows = stmt.query_map([], map)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

pub fn get(store: &Store, id: &str) -> AppResult<Option<Cluster>> {
    store.with(|conn| {
        Ok(conn
            .query_row(&format!("SELECT {COLUMNS} FROM clusters WHERE id = ?1"), [id], map)
            .optional()?)
    })
}

pub fn insert(store: &Store, cluster: &Cluster) -> AppResult<()> {
    store.with(|conn| {
        conn.execute(
            "INSERT INTO clusters (id, name, service_url, web_service_url, auth_plugin, auth_params, \
             tls_enabled, tls_trust_certs, use_ssh_tunnel, ssh_config_id, use_k8s_forward, \
             k8s_config_id, admin_api_timeout, status, version, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                cluster.id,
                cluster.name,
                cluster.service_url,
                cluster.web_service_url,
                cluster.auth_plugin,
                cluster.auth_params_enc,
                flag(cluster.tls_enabled),
                cluster.tls_trust_certs_enc,
                flag(cluster.use_ssh_tunnel),
                cluster.ssh_config_id,
                flag(cluster.use_k8s_forward),
                cluster.k8s_config_id,
                cluster.admin_api_timeout,
                cluster.status,
                cluster.version,
                cluster.created_at,
                cluster.updated_at,
            ],
        )?;
        Ok(())
    })
}

pub fn update(store: &Store, cluster: &Cluster) -> AppResult<()> {
    store.with(|conn| {
        let changed = conn.execute(
            "UPDATE clusters SET name = ?2, service_url = ?3, web_service_url = ?4, \
             auth_plugin = ?5, auth_params = ?6, tls_enabled = ?7, tls_trust_certs = ?8, \
             use_ssh_tunnel = ?9, ssh_config_id = ?10, use_k8s_forward = ?11, k8s_config_id = ?12, \
             admin_api_timeout = ?13, status = ?14, version = ?15, updated_at = ?16 WHERE id = ?1",
            params![
                cluster.id,
                cluster.name,
                cluster.service_url,
                cluster.web_service_url,
                cluster.auth_plugin,
                cluster.auth_params_enc,
                flag(cluster.tls_enabled),
                cluster.tls_trust_certs_enc,
                flag(cluster.use_ssh_tunnel),
                cluster.ssh_config_id,
                flag(cluster.use_k8s_forward),
                cluster.k8s_config_id,
                cluster.admin_api_timeout,
                cluster.status,
                cluster.version,
                cluster.updated_at,
            ],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound(format!("集群 {}", cluster.id)));
        }
        Ok(())
    })
}

pub fn delete(store: &Store, id: &str) -> AppResult<()> {
    store.with(|conn| {
        conn.execute("DELETE FROM clusters WHERE id = ?1", [id])?;
        Ok(())
    })
}

pub fn set_status(store: &Store, id: &str, status: &str, version: Option<&str>) -> AppResult<()> {
    store.with(|conn| {
        conn.execute(
            "UPDATE clusters SET status = ?2, version = COALESCE(?3, version), updated_at = ?4 WHERE id = ?1",
            params![id, status, version, pm_core::now_iso()],
        )?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str) -> Cluster {
        Cluster {
            id: id.into(),
            name: "local".into(),
            service_url: "pulsar://127.0.0.1:6650".into(),
            admin_api_timeout: 5000,
            status: "disconnected".into(),
            created_at: pm_core::now_iso(),
            updated_at: pm_core::now_iso(),
            ..Default::default()
        }
    }

    #[test]
    fn round_trips_cluster() {
        let store = Store::open_in_memory().unwrap();
        insert(&store, &sample("c1")).unwrap();
        let loaded = get(&store, "c1").unwrap().unwrap();
        assert_eq!(loaded.name, "local");
        assert!(!loaded.tls_enabled);
        assert_eq!(list(&store).unwrap().len(), 1);
        delete(&store, "c1").unwrap();
        assert!(get(&store, "c1").unwrap().is_none());
    }
}
