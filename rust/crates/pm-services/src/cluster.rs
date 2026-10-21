//! 集群配置与客户端装配：GUI 只需要 `AppContext`，不直接碰加密与 SQL。

use std::sync::Arc;

use pm_core::{
    AdminConfig, AppError, AppResult, Cluster, ClusterDraft, ClusterView, ConnectionTest,
    OperationLog,
};
use pm_pulsar::AdminClient;
use pm_store::{clusters, logs, Store};

use crate::crypto::SecretBox;

pub struct AppContext {
    pub store: Arc<Store>,
    pub secrets: Arc<SecretBox>,
    /// 启动期的非致命问题（例如凭据密钥被迫轮换），由界面提示用户重新填写凭据。
    pub warning: Option<String>,
}

impl AppContext {
    pub fn open(
        db_path: impl AsRef<std::path::Path>,
        secret_dir: impl AsRef<std::path::Path>,
    ) -> AppResult<Self> {
        let store = Arc::new(Store::open(db_path)?);
        let secrets = Arc::new(SecretBox::load_or_create(secret_dir)?);
        let warning = secrets.warning().map(str::to_string);
        Ok(Self {
            store,
            secrets,
            warning,
        })
    }

    pub fn list_clusters(&self) -> AppResult<Vec<ClusterView>> {
        Ok(clusters::list(&self.store)?
            .into_iter()
            .map(|cluster| self.to_view(&cluster))
            .collect())
    }

    pub fn get_cluster(&self, id: &str) -> AppResult<Cluster> {
        clusters::get(&self.store, id)?.ok_or_else(|| AppError::NotFound(format!("集群 {id}")))
    }

    /// 单集群的界面形态：保存后把落库结果回给前端，避免只返回 id、
    /// 前端再猜 status/version（新增后显示离线就是那么来的）。
    pub fn view_cluster(&self, id: &str) -> AppResult<ClusterView> {
        Ok(self.to_view(&self.get_cluster(id)?))
    }

    fn to_view(&self, cluster: &Cluster) -> ClusterView {
        ClusterView {
            id: cluster.id.clone(),
            name: cluster.name.clone(),
            service_url: cluster.service_url.clone(),
            web_service_url: cluster.web_service_url.clone(),
            auth_plugin: cluster.auth_plugin.clone(),
            tls_enabled: cluster.tls_enabled,
            has_auth_params: cluster
                .auth_params_enc
                .as_deref()
                .is_some_and(|v| !v.is_empty()),
            has_tls_trust_certs: cluster
                .tls_trust_certs_enc
                .as_deref()
                .is_some_and(|v| !v.is_empty()),
            use_ssh_tunnel: cluster.use_ssh_tunnel,
            ssh_config_id: cluster.ssh_config_id.clone(),
            use_k8s_forward: cluster.use_k8s_forward,
            k8s_config_id: cluster.k8s_config_id.clone(),
            admin_api_timeout: cluster.admin_api_timeout,
            status: cluster.status.clone(),
            version: cluster.version.clone(),
            created_at: cluster.created_at.clone(),
            updated_at: cluster.updated_at.clone(),
        }
    }

    /// 保存（新增或更新）。`auth_params = None` 或空串表示沿用已保存的凭据——
    /// 界面不显示明文时每次保存都会提交空值，不能把它当成「清除」。
    pub fn save_cluster(&self, draft: &ClusterDraft) -> AppResult<String> {
        if draft.name.trim().is_empty() {
            return Err(AppError::config("集群名称不能为空"));
        }
        if draft.service_url.trim().is_empty() {
            return Err(AppError::config("Service URL 不能为空"));
        }

        let existing = match draft.id.as_deref() {
            Some(id) if !id.is_empty() => clusters::get(&self.store, id)?,
            _ => None,
        };
        let now = pm_core::now_iso();

        let auth_params_enc = match draft.auth_params.as_deref() {
            // 空串与未填同义：界面上的「留空表示沿用」必须和测试连接保持一致，
            // 否则测试通过后保存反而把凭据删掉。
            None | Some("") => existing
                .as_ref()
                .and_then(|cluster| cluster.auth_params_enc.clone()),
            Some(value) => Some(self.secrets.encrypt(value)?),
        };
        let trust_certs_enc = match draft.tls_trust_certs.as_deref() {
            None | Some("") => existing
                .as_ref()
                .and_then(|cluster| cluster.tls_trust_certs_enc.clone()),
            Some(value) => Some(self.secrets.encrypt(value)?),
        };

        let cluster = Cluster {
            id: existing
                .as_ref()
                .map(|cluster| cluster.id.clone())
                .or_else(|| draft.id.clone().filter(|id| !id.is_empty()))
                .unwrap_or_else(pm_core::new_id),
            name: draft.name.trim().to_string(),
            service_url: draft.service_url.trim().to_string(),
            web_service_url: draft
                .web_service_url
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            auth_plugin: draft
                .auth_plugin
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            auth_params_enc,
            tls_enabled: draft.tls_enabled,
            tls_trust_certs_enc: trust_certs_enc,
            use_ssh_tunnel: draft.use_ssh_tunnel,
            ssh_config_id: draft.ssh_config_id.clone(),
            use_k8s_forward: draft.use_k8s_forward,
            k8s_config_id: draft.k8s_config_id.clone(),
            admin_api_timeout: draft.admin_api_timeout.unwrap_or(5000).clamp(500, 120_000),
            status: existing
                .as_ref()
                .map(|cluster| cluster.status.clone())
                .unwrap_or_else(|| "disconnected".into()),
            version: existing.and_then(|cluster| cluster.version),
            created_at: existing_created(&self.store, draft.id.as_deref())
                .unwrap_or_else(|| now.clone()),
            updated_at: now,
        };

        if clusters::get(&self.store, &cluster.id)?.is_some() {
            clusters::update(&self.store, &cluster)?;
        } else {
            clusters::insert(&self.store, &cluster)?;
        }
        pm_core::pm_log!(
            "[cluster] 保存 {} serviceUrl={} webServiceUrl={}",
            cluster.name,
            pm_core::redact_endpoint(&cluster.service_url),
            cluster
                .web_service_url
                .as_deref()
                .map(pm_core::redact_endpoint)
                .unwrap_or_else(|| "-".into())
        );
        self.log(
            Some(&cluster.id),
            "cluster.save",
            "cluster",
            Some(&cluster.id),
            Some(&cluster.name),
            "success",
            None,
        )?;
        Ok(cluster.id)
    }

    pub fn delete_cluster(&self, id: &str) -> AppResult<()> {
        let cluster = self.get_cluster(id)?;
        clusters::delete(&self.store, id)?;
        pm_core::pm_log!("[cluster] 删除 {} ({})", cluster.name, id);
        // 审计行必须在删除之后写，此时 cluster_id 已不能指向该行：
        // operation_logs 的外键是 ON DELETE SET NULL，那只处理"删除时已存在"
        // 的日志；再插入一条指向已删集群的日志会违反外键，导致删除明明成功、
        // RPC 却报失败，界面于是弹一堆错误。用 NULL + resource_id 保留归属。
        if let Err(error) = self.log(
            None,
            "cluster.delete",
            "cluster",
            Some(id),
            Some(&cluster.name),
            "success",
            None,
        ) {
            pm_core::pm_warn!("[cluster] 删除审计日志写入失败 id={id}：{error}");
        }
        Ok(())
    }

    pub fn set_status(&self, id: &str, status: &str, version: Option<&str>) -> AppResult<()> {
        clusters::set_status(&self.store, id, status, version)
    }

    fn admin_config(
        &self,
        cluster: &Cluster,
        auth_params: Option<String>,
    ) -> AppResult<AdminConfig> {
        let auth_params = match auth_params {
            Some(value) => Some(value),
            None => self
                .secrets
                .decrypt_opt(cluster.auth_params_enc.as_deref())?,
        };
        let trust_certs = self
            .secrets
            .decrypt_opt(cluster.tls_trust_certs_enc.as_deref())?;
        Ok(cluster.admin_config(auth_params, trust_certs))
    }

    /// 原生协议连接用的配置（含明文凭据）：收发消息要靠它连 broker 的二进制口。
    /// 与 `admin_for` 不同，这里不做隧道可达性检查——网关/隧道由调用方先准备好。
    pub fn connection_config(&self, cluster_id: &str) -> AppResult<AdminConfig> {
        let cluster = self.get_cluster(cluster_id)?;
        let config = self.admin_config(&cluster, None)?;
        Ok(config)
    }

    pub fn admin_for(&self, cluster_id: &str) -> AppResult<AdminClient> {
        let cluster = self.get_cluster(cluster_id)?;
        // 隧道/端口转发还没移植：宁可给出明确报错，也不要悄悄直连然后卡到超时。
        Self::reject_unported_reachability(&cluster)?;
        let config = self.admin_config(&cluster, None)?;
        AdminClient::new(&config)
    }

    /// Rust 版暂未实现 SSH 隧道与 K8s 端口转发，遇到这类集群直接给出可执行的提示。
    pub fn reject_unported_reachability(cluster: &Cluster) -> AppResult<()> {
        if cluster.use_ssh_tunnel {
            return Err(AppError::Unsupported(
                "该集群配置为走 SSH 隧道，Rust 原生版暂未实现隧道管理。
                 处理方式：在「编辑集群」里关闭 SSH 隧道并直接填写可达地址，或先在本机手动建好隧道。"
                    .into(),
            ));
        }
        if cluster.use_k8s_forward {
            return Err(AppError::Unsupported(
                "该集群配置为走 Kubernetes 端口转发，Rust 原生版暂未实现 kubectl port-forward 管理。
                 处理方式：先手动执行 kubectl port-forward，并在集群配置里直接填写本地转发地址。"
                    .into(),
            ));
        }
        Ok(())
    }

    /// 测试连接：优先用草稿里的明文凭据；没填则回落到已保存的那份。
    pub fn test_config(&self, draft: &ClusterDraft) -> AppResult<AdminConfig> {
        let existing = match draft.id.as_deref() {
            Some(id) if !id.is_empty() => clusters::get(&self.store, id)?,
            _ => None,
        };
        let auth_params = match draft.auth_params.clone() {
            Some(value) if !value.is_empty() => Some(value),
            _ => match existing.as_ref() {
                Some(cluster) => self
                    .secrets
                    .decrypt_opt(cluster.auth_params_enc.as_deref())?,
                None => None,
            },
        };
        let trust_certs = match draft.tls_trust_certs.clone() {
            Some(value) if !value.is_empty() => Some(value),
            _ => match existing.as_ref() {
                Some(cluster) => self
                    .secrets
                    .decrypt_opt(cluster.tls_trust_certs_enc.as_deref())?,
                None => None,
            },
        };
        Ok(AdminConfig {
            service_url: draft.service_url.clone(),
            web_service_url: draft.web_service_url.clone(),
            timeout_ms: draft.admin_api_timeout.unwrap_or(5000).clamp(500, 120_000) as u64,
            auth_plugin: draft.auth_plugin.clone(),
            auth_params,
            tls_enabled: draft.tls_enabled,
            trust_certs,
        })
    }

    pub async fn test_connection(&self, draft: &ClusterDraft) -> AppResult<ConnectionTest> {
        let config = self.test_config(draft)?;
        let endpoint = pm_core::redact_endpoint(&config.service_url);
        pm_core::pm_log!(
            "[cluster] 测试连接 name={} serviceUrl={}",
            draft.name,
            endpoint
        );
        let client = AdminClient::new(&config)?;
        let result = client.test_connection().await;
        if result.connected {
            pm_core::pm_log!(
                "[cluster] 连接成功 name={} serviceUrl={} version={}",
                draft.name,
                endpoint,
                result.version.as_deref().unwrap_or("未知")
            );
        } else {
            pm_core::pm_warn!(
                "[cluster] 连接失败 name={} serviceUrl={}：{}",
                draft.name,
                endpoint,
                result.error.as_deref().unwrap_or("未知原因")
            );
        }
        Ok(result)
    }

    /// 连接探测：返回 (状态, 版本)。失败只更新状态，不把错误当成致命问题。
    pub async fn probe(&self, cluster_id: &str) -> AppResult<ConnectionTest> {
        let client = self.admin_for(cluster_id)?;
        let result = client.test_connection().await;
        let status = if result.connected {
            "connected"
        } else {
            "disconnected"
        };
        self.set_status(cluster_id, status, result.version.as_deref())?;
        Ok(result)
    }

    #[allow(clippy::too_many_arguments)] // 参数就是这几列，拆成结构体只会多一层转发
    pub fn log(
        &self,
        cluster_id: Option<&str>,
        action: &str,
        resource_type: &str,
        resource_id: Option<&str>,
        resource_name: Option<&str>,
        result: &str,
        error: Option<&str>,
    ) -> AppResult<()> {
        logs::insert(
            &self.store,
            &OperationLog {
                id: 0,
                cluster_id: cluster_id.map(str::to_string),
                action: action.into(),
                resource_type: resource_type.into(),
                resource_id: resource_id.map(str::to_string),
                resource_name: resource_name.map(str::to_string),
                details: None,
                result: Some(result.into()),
                error_message: error.map(str::to_string),
                created_at: pm_core::now_iso(),
            },
        )?;
        Ok(())
    }
}

fn existing_created(store: &Store, id: Option<&str>) -> Option<String> {
    let id = id?;
    clusters::get(store, id)
        .ok()
        .flatten()
        .map(|cluster| cluster.created_at)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pm-ctx-{tag}-{}", pm_core::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn deleting_cluster_reports_success_and_keeps_audit_row() {
        let dir = temp_dir("delete");
        let ctx = AppContext::open(dir.join("app.db"), &dir).unwrap();
        let draft = ClusterDraft {
            name: "local".into(),
            service_url: "pulsar://127.0.0.1:6650".into(),
            ..Default::default()
        };
        let id = ctx.save_cluster(&draft).unwrap();
        ctx.delete_cluster(&id).expect("删除成功后不能再报错");
        assert!(ctx.get_cluster(&id).is_err());
        let rows = logs::list(&ctx.store, 20).unwrap();
        assert!(rows
            .iter()
            .any(|row| row.action == "cluster.delete"
                && row.resource_id.as_deref() == Some(id.as_str())));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn saving_without_credentials_keeps_existing_secret() {
        let dir = temp_dir("keep");
        let ctx = AppContext::open(dir.join("app.db"), &dir).unwrap();
        let draft = ClusterDraft {
            name: "local".into(),
            service_url: "pulsar://127.0.0.1:6650".into(),
            auth_plugin: Some("token".into()),
            auth_params: Some("secret-token".into()),
            ..Default::default()
        };
        let id = ctx.save_cluster(&draft).unwrap();
        assert!(ctx.list_clusters().unwrap()[0].has_auth_params);

        // 再保存一次，不带凭据 → 原凭据必须还在
        let mut again = draft.clone();
        again.id = Some(id.clone());
        again.auth_params = None;
        ctx.save_cluster(&again).unwrap();
        assert!(ctx.list_clusters().unwrap()[0].has_auth_params);

        let config = ctx
            .admin_config(&ctx.get_cluster(&id).unwrap(), None)
            .unwrap();
        assert_eq!(config.auth_params.as_deref(), Some("secret-token"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_credentials_keep_the_secret() {
        let dir = temp_dir("clear");
        let ctx = AppContext::open(dir.join("app.db"), &dir).unwrap();
        let draft = ClusterDraft {
            name: "local".into(),
            service_url: "pulsar://127.0.0.1:6650".into(),
            auth_params: Some("token".into()),
            ..Default::default()
        };
        let id = ctx.save_cluster(&draft).unwrap();
        let mut cleared = draft;
        cleared.id = Some(id);
        cleared.auth_params = Some(String::new());
        ctx.save_cluster(&cleared).unwrap();
        assert!(ctx.list_clusters().unwrap()[0].has_auth_params);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
