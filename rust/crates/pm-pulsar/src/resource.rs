use std::collections::{BTreeMap, HashMap};

use pm_core::{namespace_admin_base, seg, AppError, AppResult, Tenant, Topic, TopicStats};
use serde_json::Value;

use crate::client::AdminClient;

impl AdminClient {
    // ========== 集群与租户 ==========

    pub async fn pulsar_clusters(&self) -> AppResult<Vec<String>> {
        self.get_json("/admin/v2/clusters").await
    }

    pub async fn tenants(&self) -> AppResult<Vec<Tenant>> {
        let names: Vec<String> = self.get_json("/admin/v2/tenants").await?;
        let mut tenants = Vec::with_capacity(names.len());
        for name in names {
            // 详情端点单独失败不该让整个租户列表消失
            let detail = self.tenant_info(&name).await.ok().flatten();
            tenants.push(detail.unwrap_or(Tenant {
                name,
                ..Default::default()
            }));
        }
        tenants.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(tenants)
    }

    pub async fn tenant_info(&self, name: &str) -> AppResult<Option<Tenant>> {
        self.get_opt_json(&format!("/admin/v2/tenants/{}", seg(name)))
            .await
    }

    pub async fn create_tenant(&self, tenant: &Tenant) -> AppResult<()> {
        self.put_json(
            &format!("/admin/v2/tenants/{}", seg(&tenant.name)),
            serde_json::json!({
                "adminRoles": tenant.admin_roles,
                "allowedClusters": tenant.allowed_clusters,
            }),
        )
        .await
    }

    pub async fn delete_tenant(&self, name: &str) -> AppResult<()> {
        self.delete(&format!("/admin/v2/tenants/{}", seg(name)))
            .await
    }

    // ========== 命名空间 ==========

    pub async fn namespaces(&self, tenant: &str) -> AppResult<Vec<String>> {
        let names: Vec<String> = self
            .get_json(&format!("/admin/v2/namespaces/{}", seg(tenant)))
            .await?;
        Ok(short_namespace_names(tenant, names))
    }

    pub async fn create_namespace(&self, tenant: &str, namespace: &str) -> AppResult<()> {
        // 创建命名空间需要集群列表；先读集群，读不到就让 broker 用自己的默认
        let clusters = self.pulsar_clusters().await.unwrap_or_default();
        if clusters.is_empty() {
            return self
                .put_empty(&namespace_admin_base(tenant, namespace))
                .await;
        }
        self.put_json(
            &namespace_admin_base(tenant, namespace),
            serde_json::json!({
                "replication_clusters": clusters,
                "bundles": {"boundaries": ["0x00000000", "0xffffffff"], "numBundles": 1},
            }),
        )
        .await
    }

    pub async fn delete_namespace(&self, tenant: &str, namespace: &str) -> AppResult<()> {
        self.delete(&namespace_admin_base(tenant, namespace)).await
    }

    // ========== Topic ==========

    /// 持久 + 非持久两条路径都要问：`/namespaces/{t}/{ns}/topics` 只列 persistent，
    /// 少了第二条，非持久 topic 在界面上完全不可见。
    pub async fn topics(&self, tenant: &str, namespace: &str) -> AppResult<Vec<Topic>> {
        let persistent = self
            .get_opt_json::<Vec<String>>(&format!(
                "/admin/v2/namespaces/{}/{}/topics",
                seg(tenant),
                seg(namespace)
            ))
            .await?
            .unwrap_or_default();
        let non_persistent = self
            .get_opt_json::<Vec<String>>(&format!(
                "/admin/v2/non-persistent/{}/{}",
                seg(tenant),
                seg(namespace)
            ))
            .await?
            .unwrap_or_default();
        let mut all = persistent;
        all.extend(non_persistent);
        Ok(collapse_topic_uris(&all))
    }

    pub async fn create_topic(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        persistent: bool,
        partitions: Option<i64>,
    ) -> AppResult<()> {
        let kind = if persistent {
            "persistent"
        } else {
            "non-persistent"
        };
        let base = format!(
            "/admin/v2/{kind}/{}/{}/{}",
            seg(tenant),
            seg(namespace),
            seg(topic)
        );
        let count = partitions.unwrap_or(0);
        if count > 1 {
            self.put_json(&format!("{base}/partitions"), serde_json::json!(count))
                .await
        } else {
            self.put_empty(&base).await
        }
    }

    /// 删除 topic。这里有三处跨版本差异，都不能靠"按一个版本写死"处理：
    ///
    /// 1. 分区元数据：3.x 及以前只有分区 topic 才返回 `{"partitions":N}`（非分区
    ///    404 或数组），4.0 起非分区 topic 也会返回 200 + `{"partitions":0}`；
    /// 2. 端点：分区 topic 必须走 `DELETE {base}/partitions`，3.3+/4.0 的基名端点
    ///    会明确回 409 让人改走 delete-partitioned-topic；
    /// 3. 2.10 的基名端点多一个 `deleteSchema` 开关，2.11+ 由 broker 自己清理。
    ///
    /// 因此先按实际探测到的元数据选端点，失败再按 broker 的提示换另一个端点；
    /// 版本只用于决定是否补 `deleteSchema`，探测不到版本也照样能删。
    pub async fn delete_topic(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        persistent: bool,
        force: bool,
    ) -> AppResult<()> {
        let name = short_topic_name(topic);
        let base = topic_base(tenant, namespace, name, persistent);
        let raw = match self.get_opt_json::<Value>(&format!("{base}/partitions")).await {
            Ok(raw) => raw,
            // 端点被网关/旧版本挡掉时按"非分区"处理，删除本身仍然继续
            Err(error) if method_rejected(&error) => None,
            Err(error) => return Err(error),
        };
        let meta = raw
            .as_ref()
            .map(|value| parse_partitions_meta(value, tenant, namespace, name, persistent))
            .unwrap_or_default();

        let mut query: Vec<(String, String)> = Vec::new();
        if force {
            query.push(("force".to_string(), "true".to_string()));
        }
        // 2.10 的 `?deleteSchema=true` 在更高版本会被忽略，但只在确认是 2.10
        // 时才发：避免把"清 schema"这种有副作用的参数发给行为未知的私有分支。
        if self
            .version_quick()
            .await
            .and_then(|raw| PulsarVersion::parse(&raw))
            .is_some_and(|version| version.needs_delete_schema_param())
        {
            query.push(("deleteSchema".to_string(), "true".to_string()));
        }

        if meta.partitions.is_empty() {
            match self.delete_with_query(&base, &query).await {
                // 元数据探测被挡住、但 broker 认得出这是分区 topic：按它的提示重试
                Err(error) if is_partitioned_conflict(&error) => {
                    self.delete_with_query(&format!("{base}/partitions"), &query)
                        .await
                }
                other => other.map_err(busy_hint),
            }
        } else {
            match self
                .delete_with_query(&format!("{base}/partitions"), &query)
                .await
            {
                // 极旧的 broker（或代理只放行基名端点）没有 /partitions 删除路由
                Err(error) if method_rejected(&error) => self
                    .delete_with_query(&base, &query)
                    .await
                    .map_err(busy_hint),
                other => other.map_err(busy_hint),
            }
        }
    }

    /// 分区 topic 的基名没有 `/stats` 路由（实测 404），只有 `/partitioned-stats`。
    /// 因此先问 `/stats`，404 再降级；反过来把分区统计当普遍情况会让非分区 topic 慢一拍。
    pub async fn topic_stats(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        persistent: bool,
    ) -> AppResult<TopicStats> {
        let name = format!("{tenant}/{namespace}/{}", short_topic_name(topic));
        let base = topic_base(tenant, namespace, short_topic_name(topic), persistent);

        if let Some(raw) = self.get_opt_json::<Value>(&format!("{base}/stats")).await? {
            return parse_stats(raw, name, persistent, Vec::new());
        }
        if let Some(raw) = self
            .get_opt_json::<Value>(&format!("{base}/partitioned-stats"))
            .await?
        {
            let partition_uris = raw
                .get("partitions")
                .and_then(Value::as_object)
                .map(|map| map.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            return parse_stats(raw, name, persistent, partition_uris);
        }
        Ok(TopicStats {
            name,
            persistent,
            ..Default::default()
        })
    }

    /// 分区 URI 列表。实测两种响应形态：`["...-partition-0", ...]` 与
    /// `{"partitions": 2, "deleted": false}`；只有数量时按固定命名规则还原。
    pub async fn topic_partitions(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        persistent: bool,
    ) -> AppResult<Vec<String>> {
        let short = short_topic_name(topic);
        let base = topic_base(tenant, namespace, short, persistent);
        let Some(raw) = self
            .get_opt_json::<Value>(&format!("{base}/partitions"))
            .await?
        else {
            return Ok(Vec::new());
        };
        Ok(parse_partitions_meta(&raw, tenant, namespace, short, persistent).partitions)
    }

    pub async fn topic_permissions(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        persistent: bool,
    ) -> AppResult<HashMap<String, Vec<String>>> {
        let base = topic_base(tenant, namespace, short_topic_name(topic), persistent);
        Ok(self
            .get_opt_json::<HashMap<String, Vec<String>>>(&format!("{base}/permissions"))
            .await?
            .unwrap_or_default())
    }

    pub async fn namespace_permissions(
        &self,
        tenant: &str,
        namespace: &str,
    ) -> AppResult<HashMap<String, Vec<String>>> {
        Ok(self
            .get_opt_json::<HashMap<String, Vec<String>>>(&format!(
                "{}/permissions",
                namespace_admin_base(tenant, namespace)
            ))
            .await?
            .unwrap_or_default())
    }

    // ========== 订阅 ==========

    pub async fn subscriptions(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        persistent: bool,
    ) -> AppResult<Vec<String>> {
        let base = topic_base(tenant, namespace, short_topic_name(topic), persistent);
        Ok(self
            .get_opt_json::<Vec<String>>(&format!("{base}/subscriptions"))
            .await?
            .unwrap_or_default())
    }

    pub async fn create_subscription(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        subscription: &str,
        persistent: bool,
        initial_position: &str,
    ) -> AppResult<()> {
        let base = topic_base(tenant, namespace, short_topic_name(topic), persistent);
        self.put_with_query(
            &format!("{base}/subscription/{}", seg(subscription)),
            &[("initialPosition".into(), initial_position.into())],
        )
        .await
    }

    pub async fn delete_subscription(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        subscription: &str,
        persistent: bool,
    ) -> AppResult<()> {
        let base = topic_base(tenant, namespace, short_topic_name(topic), persistent);
        self.delete(&format!("{base}/subscription/{}", seg(subscription)))
            .await
    }

    pub async fn skip_messages(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        subscription: &str,
        count: i64,
        persistent: bool,
    ) -> AppResult<()> {
        let base = topic_base(tenant, namespace, short_topic_name(topic), persistent);
        self.post_empty(&format!(
            "{base}/subscription/{}/skip/{count}",
            seg(subscription)
        ))
        .await
    }

    pub async fn reset_cursor(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        subscription: &str,
        timestamp_ms: i64,
        persistent: bool,
    ) -> AppResult<()> {
        let base = topic_base(tenant, namespace, short_topic_name(topic), persistent);
        self.post_empty(&format!(
            "{base}/subscription/{}/resetcursor/{timestamp_ms}",
            seg(subscription)
        ))
        .await
    }

    pub async fn reset_cursor_to(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        subscription: &str,
        position: &str,
        persistent: bool,
    ) -> AppResult<()> {
        let base = topic_base(tenant, namespace, short_topic_name(topic), persistent);
        self.post_with_query(
            &format!("{base}/subscription/{}/resetcursor", seg(subscription)),
            None,
            &[("messageId".into(), position.into())],
        )
        .await
    }

    // ========== Topic 配置 ==========
    //
    // topic 路径下只有 partitions / permissions / stats 三条稳定端点；retention、TTL、
    // 去重这些策略挂在 topic 级策略端点上，由 `policies` 模块负责。生效值只能从 stats 里拿
    // （`backlogQuotaLimitSize` / `deduplicationStatus`），它通常是命名空间或 broker 默认值。

    pub async fn topic_config(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        persistent: bool,
    ) -> AppResult<Value> {
        let name = short_topic_name(topic);
        let base = topic_base(tenant, namespace, name, persistent);

        // 三条端点各自降级：任何一条缺失都不该让整份配置读不出来
        let partitions = self
            .topic_partitions(tenant, namespace, name, persistent)
            .await
            .unwrap_or_default();
        let permissions = self
            .get_opt_json::<Value>(&format!("{base}/permissions"))
            .await
            .ok()
            .flatten();
        let stats = self
            .get_opt_json::<Value>(&format!("{base}/stats"))
            .await
            .ok()
            .flatten();

        let mut owner_brokers: Vec<String> = Vec::new();
        let mut backlog_size: Option<f64> = None;
        let mut backlog_time: Option<f64> = None;
        let mut dedup_enabled: Option<bool> = None;

        if let Some(stats) = stats.as_ref() {
            push_owner(&mut owner_brokers, stats.get("ownerBroker"));
            if let Some(groups) = stats.get("partitions").and_then(Value::as_object) {
                for partition in groups.values() {
                    push_owner(&mut owner_brokers, partition.get("ownerBroker"));
                }
            }
            backlog_size = stats.get("backlogQuotaLimitSize").and_then(Value::as_f64);
            backlog_time = stats.get("backlogQuotaLimitTime").and_then(Value::as_f64);
            dedup_enabled = stats
                .get("deduplicationStatus")
                .and_then(Value::as_str)
                .map(|status| status.eq_ignore_ascii_case("enabled"));
        }

        let mut config = serde_json::json!({
            "topic_name": format!("{tenant}/{namespace}/{name}"),
            "persistent": persistent,
            "partitions": partitions,
            "owner_brokers": owner_brokers,
        });
        // 未登记的 ACL 与缺失的 stats 都不写字段：界面按 undefined 显示「跟随命名空间」
        if let Some(permissions) = permissions.filter(Value::is_object) {
            config["permissions"] = permissions;
        }
        if let Some(value) = backlog_size {
            config["backlog_quota_limit_size"] = serde_json::json!(value);
        }
        if let Some(value) = backlog_time {
            config["backlog_quota_limit_time"] = serde_json::json!(value);
        }
        if let Some(value) = dedup_enabled {
            config["deduplication_enabled"] = serde_json::json!(value);
        }
        Ok(config)
    }

    /// topic 本体只允许改分区数：`PUT /partitions` 是「创建分区 topic」，对已存在的分区 topic
    /// 返回 409；更新分区数要走 POST，body 是裸数字。
    pub async fn update_topic_config(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        patch: &Value,
        persistent: bool,
    ) -> AppResult<()> {
        let keys: Vec<String> = patch
            .as_object()
            .map(|map| {
                map.iter()
                    .filter(|(_, value)| !value.is_null())
                    .map(|(key, _)| key.clone())
                    .collect()
            })
            .unwrap_or_default();

        let unsupported: Vec<&str> = keys
            .iter()
            .map(String::as_str)
            .filter(|key| *key != "numPartitions")
            .collect();
        if !unsupported.is_empty() {
            return Err(AppError::Other(format!(
                "以下策略不支持在 topic 级别设置：{}。本 broker 没有对应的 topic 级 Admin 端点，请在命名空间级别修改。",
                unsupported.join("、")
            )));
        }
        if keys.is_empty() {
            return Err(AppError::Other("没有需要更新的配置项".into()));
        }

        let count = patch
            .get("numPartitions")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let base = topic_base(tenant, namespace, short_topic_name(topic), persistent);
        self.post_with_query(
            &format!("{base}/partitions"),
            Some(serde_json::json!(count)),
            &[],
        )
        .await
    }

    // ========== 权限（ACL）==========
    //
    // 新版 broker 认 `{role, authPolicies:[{action}]}` 的 POST；老 broker 只认动作数组的 PUT，
    // 所以按「被拒就换动词」处理，而不是拿版本号猜。

    async fn grant_on_base(&self, base: &str, role: &str, actions: &[String]) -> AppResult<()> {
        let path = format!("{base}/permissions/{}", seg(role));
        let body = serde_json::json!({
            "role": role,
            "authPolicies": actions
                .iter()
                .map(|action| serde_json::json!({"action": action}))
                .collect::<Vec<_>>(),
        });
        match self.post_json::<Value>(&path, body).await {
            Ok(_) => Ok(()),
            Err(error) if method_rejected(&error) => {
                self.put_json(&path, serde_json::json!(actions)).await
            }
            Err(error) => Err(error),
        }
    }

    pub async fn grant_namespace_permission(
        &self,
        tenant: &str,
        namespace: &str,
        role: &str,
        actions: &[String],
    ) -> AppResult<()> {
        self.grant_on_base(&namespace_admin_base(tenant, namespace), role, actions)
            .await
    }

    pub async fn revoke_namespace_permission(
        &self,
        tenant: &str,
        namespace: &str,
        role: &str,
    ) -> AppResult<()> {
        self.delete(&format!(
            "{}/permissions/{}",
            namespace_admin_base(tenant, namespace),
            seg(role)
        ))
        .await
    }

    pub async fn grant_topic_permission(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        role: &str,
        actions: &[String],
        persistent: bool,
    ) -> AppResult<()> {
        let base = topic_base(tenant, namespace, short_topic_name(topic), persistent);
        self.grant_on_base(&base, role, actions).await
    }

    pub async fn revoke_topic_permission(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        role: &str,
        persistent: bool,
    ) -> AppResult<()> {
        let base = topic_base(tenant, namespace, short_topic_name(topic), persistent);
        self.delete(&format!("{base}/permissions/{}", seg(role)))
            .await
    }

    // ========== Schema 注册表 ==========
    //
    // `/schemas/{tenant}/{ns}/{topic}` 的路径不带 persistent/non-persistent 前缀（与 topic/
    // 订阅的资源路径不同）；分区 topic 的 schema 挂在 `{基名}-partition-0` 上，基名路径是 404。
    // 先探一次 /partitions 决定用哪个名字，而不是两条路径盲试两遍。

    async fn schema_path(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        persistent: bool,
    ) -> String {
        let name = short_topic_name(topic);
        let count = self
            .topic_partitions(tenant, namespace, name, persistent)
            .await
            .map(|partitions| partitions.len())
            .unwrap_or(0);
        let schema_name = if count > 0 {
            format!("{name}-partition-0")
        } else {
            name.to_string()
        };
        format!(
            "/admin/v2/schemas/{}/{}/{}",
            seg(tenant),
            seg(namespace),
            seg(&schema_name)
        )
    }

    /// 未注册（404）返回 None——那是常态，不是错误。
    pub async fn schema_info(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        persistent: bool,
    ) -> AppResult<Option<Value>> {
        let base = self.schema_path(tenant, namespace, topic, persistent).await;
        self.get_opt_json(&base).await
    }

    /// 注册新版本。broker 会按当前兼容性策略校验，拒绝时 422 带原因，原样抛给界面。
    pub async fn create_schema(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        schema_type: &str,
        schema: &str,
        persistent: bool,
    ) -> AppResult<Value> {
        let base = self.schema_path(tenant, namespace, topic, persistent).await;
        self.post_json(
            &format!("{base}/versions"),
            serde_json::json!({"type": schema_type, "schema": schema}),
        )
        .await
    }

    pub async fn delete_schema(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        persistent: bool,
    ) -> AppResult<()> {
        let base = self.schema_path(tenant, namespace, topic, persistent).await;
        self.delete(&base).await
    }

    /// topic 级兼容性策略。老 broker（3.0 之前）没有 topic 级端点，`UNDEFINED` 表示「沿用命名
    /// 空间」：两种情况都退到命名空间级，并把生效范围如实标出来，界面不能说「这是 topic 级设置」。
    pub async fn compatibility_strategy(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        persistent: bool,
    ) -> AppResult<Value> {
        let base = topic_base(tenant, namespace, short_topic_name(topic), persistent);
        let topic_level = self
            .get_raw(&format!("{base}/schemaCompatibilityStrategy"))
            .await
            .ok()
            .and_then(|text| bare_string(&text))
            .filter(|strategy| strategy != "UNDEFINED");
        if let Some(strategy) = topic_level {
            return Ok(serde_json::json!({"strategy": strategy, "scope": "topic"}));
        }

        let namespace_level = self
            .get_raw(&format!(
                "{}/schemaCompatibilityStrategy",
                namespace_admin_base(tenant, namespace)
            ))
            .await
            .ok()
            .and_then(|text| bare_string(&text));
        Ok(serde_json::json!({"strategy": namespace_level, "scope": "namespace"}))
    }

    /// 策略走 query 参数、无请求体（`TopicsBaseResource` 的 `@QueryParam("strategy")`）。
    pub async fn set_schema_strategy(
        &self,
        tenant: &str,
        namespace: &str,
        topic: &str,
        strategy: &str,
        persistent: bool,
    ) -> AppResult<()> {
        let base = topic_base(tenant, namespace, short_topic_name(topic), persistent);
        match self
            .put_with_query(
                &format!("{base}/schemaCompatibilityStrategy"),
                &[("strategy".to_string(), strategy.to_string())],
            )
            .await
        {
            Ok(()) => Ok(()),
            Err(error) if error.is_not_found() => Err(AppError::Unsupported(
                "该 broker 不支持 topic 级 schema 兼容性策略（需要 Pulsar 3.0 及以上）".into(),
            )),
            Err(error) => Err(error),
        }
    }

    // ========== 内部访问器 ==========
}

/// 405/501/404 是「这个动词或端点不行」，与参数错误要分开处理：前者退回另一种写法，
/// 后者应当原样报错。
fn method_rejected(error: &AppError) -> bool {
    error.is_not_found()
        || matches!(error, AppError::Http { status, .. } if matches!(status, 405 | 501))
}

/// 裸字符串端点（`"BACKWARD"`）与纯文本端点（`BACKWARD`）都要能读。
fn bare_string(raw: &str) -> Option<String> {
    let value = raw.trim().trim_matches('"').trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// ownerBroker 逐层收集，同一台 broker 承载多个分区时只留一条。
fn push_owner(brokers: &mut Vec<String>, owner: Option<&Value>) {
    if let Some(owner) = owner.and_then(Value::as_str) {
        let owner = owner.trim();
        if !owner.is_empty() && !brokers.iter().any(|item| item == owner) {
            brokers.push(owner.to_string());
        }
    }
}

pub fn topic_base(tenant: &str, namespace: &str, topic: &str, persistent: bool) -> String {
    let kind = if persistent {
        "persistent"
    } else {
        "non-persistent"
    };
    format!(
        "/admin/v2/{kind}/{}/{}/{}",
        seg(tenant),
        seg(namespace),
        seg(topic)
    )
}

/// broker 版本只保留 major/minor：删除 topic 的 API 只需要区分
/// 2.10（多一个 deleteSchema 参数）与之后的版本。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PulsarVersion {
    pub major: u64,
    pub minor: u64,
}

impl PulsarVersion {
    pub fn parse(raw: &str) -> Option<Self> {
        let core = raw.trim().trim_start_matches('v');
        let mut parts = core
            .split(|ch: char| !ch.is_ascii_digit())
            .filter(|part| !part.is_empty());
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
        Some(Self { major, minor })
    }

    /// 2.10 的 `DELETE {base}?deleteSchema=true` 用于连带删除 schema；
    /// 2.11 起 broker 自己清理，再带这个参数只会被忽略。
    pub fn needs_delete_schema_param(&self) -> bool {
        self.major == 2 && self.minor == 10
    }
}

/// `/partitions` 的归一化结果。`deleted` 是 Pulsar 4.0 新增的元数据字段，
/// 目前删除流程用不到，但保留它让调用方不必再猜响应形状。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PartitionsMeta {
    pub partitions: Vec<String>,
    pub deleted: bool,
}

/// 解析 `/partitions` 响应：分区 URI 数组与 `{"partitions":N,"deleted":false}`
/// 都要能落回 URI 列表，只有数量时按 Pulsar 固定的 `-partition-N` 规则还原。
/// Pulsar 4.0 起非分区 topic 也会返回 200 + `{"partitions":0}`，所以不能把
/// "能反序列化成 Vec" 当作"是分区 topic"。
pub fn parse_partitions_meta(
    raw: &Value,
    tenant: &str,
    namespace: &str,
    topic: &str,
    persistent: bool,
) -> PartitionsMeta {
    if let Some(array) = raw.as_array() {
        return PartitionsMeta {
            partitions: array
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
            deleted: false,
        };
    }
    let Some(object) = raw.as_object() else {
        return PartitionsMeta::default();
    };
    let deleted = object
        .get("deleted")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let scheme = if persistent {
        "persistent"
    } else {
        "non-persistent"
    };
    let base = format!("{scheme}://{tenant}/{namespace}/{topic}");
    match object.get("partitions") {
        Some(Value::Array(items)) => PartitionsMeta {
            partitions: items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
            deleted,
        },
        Some(Value::Number(count)) => PartitionsMeta {
            partitions: (0..count.as_i64().unwrap_or(0).max(0))
                .map(|index| format!("{base}-partition-{index}"))
                .collect(),
            deleted,
        },
        _ => PartitionsMeta {
            partitions: Vec::new(),
            deleted,
        },
    }
}

/// 3.3+/4.0 的基名删除端点对分区 topic 返回 409，并明确要求改走
/// delete-partitioned-topic。只认这一种冲突，别的 409（并发修改）原样上报。
fn is_partitioned_conflict(error: &AppError) -> bool {
    matches!(
        error,
        AppError::Http { status: 409, message }
            if message.contains("partitioned topic") || message.contains("delete-partitioned-topic")
    )
}

/// broker 的 412 原文只有一句 "Topic has active producers/subscriptions"，
/// 补一句可执行的下一步，界面才知道该勾"强制删除"。
fn busy_hint(error: AppError) -> AppError {
    match error {
        AppError::Http { status: 412, message } if !message.contains("强制删除") => AppError::Http {
            status: 412,
            message: format!("{message}（Topic 仍有生产/消费者或订阅，勾选「强制删除」后重试）"),
        },
        other => other,
    }
}

/// 列表接口返回的 name 已是 `tenant/ns/topic`，再拼一次前缀会得到双重路径。
pub fn short_topic_name(topic: &str) -> &str {
    let without_scheme = topic.rsplit("://").next().unwrap_or(topic);
    without_scheme.rsplit('/').next().unwrap_or(without_scheme)
}

fn partition_index(uri: &str) -> i64 {
    uri.rsplit_once("-partition-")
        .and_then(|(_, index)| index.parse::<i64>().ok())
        .unwrap_or(-1)
}

/// 把分区行并回基名。去重键必须带 scheme：持久与非持久同名是两个资源。
pub fn collapse_topic_uris(uris: &[String]) -> Vec<Topic> {
    let mut by_name: BTreeMap<String, Topic> = BTreeMap::new();
    for uri in uris.iter().filter(|uri| !uri.is_empty()) {
        let persistent = uri.starts_with("persistent://");
        let full = uri.rsplit("://").next().unwrap_or(uri);
        let scheme = if persistent {
            "persistent://"
        } else {
            "non-persistent://"
        };
        let (base, partition) = match full.rsplit_once("-partition-") {
            Some((base, index)) if index.chars().all(|c| c.is_ascii_digit()) => (base, Some(())),
            _ => (full, None),
        };
        let key = format!("{scheme}{base}");
        let entry = by_name.entry(key).or_insert_with(|| Topic {
            name: base.to_string(),
            persistent,
            topic_uri: base.to_string(),
            partitions: Vec::new(),
        });
        if partition.is_some() && !entry.partitions.iter().any(|existing| existing == uri) {
            entry.partitions.push(uri.clone());
        }
    }
    for topic in by_name.values_mut() {
        topic.partitions.sort_by_key(|uri| partition_index(uri));
    }
    by_name.into_values().collect()
}

/// 把 broker 的统计 JSON 归一化成界面形状：分区列表、承载 broker、扁平消费者。
fn parse_stats(
    raw: Value,
    name: String,
    persistent: bool,
    partition_uris: Vec<String>,
) -> AppResult<TopicStats> {
    let mut stats: TopicStats = serde_json::from_value(raw.clone())
        .map_err(|e| AppError::Other(format!("topic 统计解析失败: {e}")))?;
    stats.name = name;
    stats.persistent = persistent;

    let mut owners = Vec::new();
    if let Some(owner) = stats.owner_broker.clone() {
        if !owner.is_empty() {
            owners.push(owner);
        }
    }
    if let Some(partitions) = raw.get("partitions").and_then(Value::as_object) {
        for partition in partitions.values() {
            if let Some(owner) = partition.get("ownerBroker").and_then(Value::as_str) {
                if !owner.is_empty() && !owners.iter().any(|existing| existing == owner) {
                    owners.push(owner.to_string());
                }
            }
        }
    }
    stats.owner_brokers = owners;
    stats.partition_list = partition_uris;
    Ok(stats)
}

/// Admin API 返回的是 `tenant/namespace` 全名，界面与后续请求都只要短名。
fn short_namespace_names(tenant: &str, names: Vec<String>) -> Vec<String> {
    let mut names: Vec<String> = names
        .into_iter()
        .map(|full| {
            let (owner, short) = pm_core::split_namespace(&full);
            if owner == tenant && !short.is_empty() {
                short
            } else {
                full
            }
        })
        .collect();
    names.sort();
    names.dedup();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespace_full_names_are_shortened() {
        let names = short_namespace_names(
            "public",
            vec![
                "public/default".to_string(),
                "public/functions".to_string(),
                "other/keep".to_string(),
            ],
        );
        assert_eq!(names, vec!["default", "functions", "other/keep"]);
    }

    #[test]
    fn collapses_and_orders_partitions_numerically() {
        let uris = vec![
            "persistent://public/default/orders-partition-10".to_string(),
            "persistent://public/default/orders-partition-2".to_string(),
            "persistent://public/default/orders-partition-1".to_string(),
            "non-persistent://public/default/orders".to_string(),
        ];
        let topics = collapse_topic_uris(&uris);
        assert_eq!(topics.len(), 2);
        let persistent = topics.iter().find(|topic| topic.persistent).unwrap();
        assert_eq!(persistent.name, "public/default/orders");
        assert!(persistent.partitions[1].ends_with("-partition-2"));
        assert!(persistent.partitions[2].ends_with("-partition-10"));
    }

    #[test]
    fn short_name_ignores_scheme_and_namespace() {
        assert_eq!(
            short_topic_name("persistent://public/default/my-topic"),
            "my-topic"
        );
        assert_eq!(short_topic_name("public/default/my-topic"), "my-topic");
        assert_eq!(short_topic_name("my-topic"), "my-topic");
    }

    #[test]
    fn parses_both_partition_metadata_shapes() {
        let object = serde_json::json!({"partitions": 2, "deleted": false});
        let meta = parse_partitions_meta(&object, "public", "default", "orders", true);
        assert_eq!(
            meta.partitions,
            vec![
                "persistent://public/default/orders-partition-0",
                "persistent://public/default/orders-partition-1",
            ]
        );
        assert!(!meta.deleted);

        let array = serde_json::json!([
            "non-persistent://public/default/orders-partition-1",
            "non-persistent://public/default/orders-partition-0",
        ]);
        let meta = parse_partitions_meta(&array, "public", "default", "orders", false);
        assert_eq!(meta.partitions.len(), 2);

        // 4.0 对非分区 topic 也会回 200 + partitions=0
        let empty = serde_json::json!({"partitions": 0, "deleted": false});
        let meta = parse_partitions_meta(&empty, "public", "default", "orders", true);
        assert!(meta.partitions.is_empty());
    }

    #[test]
    fn parses_broker_versions() {
        assert_eq!(
            PulsarVersion::parse("4.0.0"),
            Some(PulsarVersion { major: 4, minor: 0 })
        );
        assert_eq!(
            PulsarVersion::parse("v3.3.9-SNAPSHOT"),
            Some(PulsarVersion { major: 3, minor: 3 })
        );
        assert!(PulsarVersion::parse("unknown").is_none());
        assert!(PulsarVersion::parse("2.10.6").unwrap().needs_delete_schema_param());
        assert!(!PulsarVersion::parse("2.11.4").unwrap().needs_delete_schema_param());
        assert!(!PulsarVersion::parse("4.0.0").unwrap().needs_delete_schema_param());
    }
}
