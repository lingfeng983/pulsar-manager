use std::time::Duration;

use pm_core::{AdminConfig, AppError, AppResult, ClusterInfo, ConnectionTest};
use reqwest::{Method, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::Semaphore;

use pm_core::resolve_base_url;

/// 错误体里常带完整 Java 堆栈，界面只有一行位置，原样透传既撑坏提示也没人看得懂。
const MAX_ERROR_CHARS: usize = 300;

/// Admin REST 客户端。一个集群一个实例，配置变了就换实例（与 TS 侧的
/// fingerprint 缓存同一个理由：隧道重连后本地端口会变）。
#[derive(Clone)]
pub struct AdminClient {
    pub(crate) http: reqwest::Client,
    pub(crate) base: String,
    pub(crate) auth_params: Option<String>,
    limit: std::sync::Arc<Semaphore>,
    timeout: Duration,
}

impl AdminClient {
    pub fn new(config: &AdminConfig) -> AppResult<Self> {
        let base = resolve_base_url(config)?;
        let timeout = Duration::from_millis(config.timeout_ms.max(500));
        let mut builder = reqwest::Client::builder()
            .timeout(timeout)
            .connect_timeout(Duration::from_secs(5))
            .user_agent(concat!("pulsar-manager-rust/", env!("CARGO_PKG_VERSION")));

        if let Some(ca) = config
            .trust_certs
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            // 自定义 CA 是「多信任一张证书」，不是关掉校验
            let pem = read_pem(ca)?;
            let cert = reqwest::Certificate::from_pem(&pem)
                .map_err(|e| AppError::config(format!("无法解析 CA 证书: {e}")))?;
            builder = builder.add_root_certificate(cert);
        }

        let http = builder
            .build()
            .map_err(|e| AppError::Network(format!("初始化 HTTP 客户端失败: {e}")))?;
        // 每个 RPC 会新建一次客户端；这一行回答"到底在连哪台 broker"，
        // 地址先脱敏（userinfo / query 不进日志）。
        pm_core::pm_log!(
            "[admin] 客户端就绪 base={} timeout={}ms auth={}",
            pm_core::redact_endpoint(&base),
            timeout.as_millis(),
            if config
                .auth_params
                .as_deref()
                .is_some_and(|value| !value.is_empty())
            {
                "yes"
            } else {
                "no"
            }
        );
        Ok(Self {
            http,
            base,
            auth_params: config.auth_params.clone().filter(|s| !s.is_empty()),
            limit: std::sync::Arc::new(Semaphore::new(8)),
            timeout,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    fn url(&self, path: &str) -> String {
        if path.starts_with("http://") || path.starts_with("https://") {
            path.to_string()
        } else if path.starts_with('/') {
            format!("{}{}", self.base, path)
        } else {
            format!("{}/{}", self.base, path)
        }
    }

    async fn execute(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        query: Option<&[(String, String)]>,
    ) -> AppResult<Response> {
        let mut attempts = 0;
        let label = format!("{} {}", method.as_str(), path);
        // 只有幂等请求能安全重发。POST/PATCH 在 broker 已执行但响应丢失时会
        // 变成「创建两次」或「trigger 两次」；这类请求只在连接尚未建立时重试。
        let idempotent = method == Method::GET
            || method == Method::HEAD
            || method == Method::OPTIONS
            || method == Method::PUT
            || method == Method::DELETE;
        loop {
            let started = std::time::Instant::now();
            pm_core::pm_log!("[admin] -> {label}");
            let _permit = self
                .limit
                .acquire()
                .await
                .map_err(|_| AppError::Other("请求队列已关闭".into()))?;

            let mut request = self.http.request(method.clone(), self.url(path));
            if let Some(token) = &self.auth_params {
                request = request.header("Authorization", format!("Bearer {token}"));
            }
            if let Some(query) = query {
                request = request.query(query);
            }
            if let Some(body) = &body {
                request = request.json(body);
            }

            let outcome = request.send().await;
            match outcome {
                Ok(response) => {
                    let status = response.status();
                    let elapsed = started.elapsed().as_millis();
                    if status.is_success() {
                        pm_core::pm_log!("[admin] <- {label} {} {elapsed}ms", status.as_u16());
                        return Ok(response);
                    }
                    let text = response.text().await.unwrap_or_default();
                    let message = condense_error(&text);
                    let retryable = status == StatusCode::SERVICE_UNAVAILABLE
                        || status == StatusCode::BAD_GATEWAY;
                    if retryable && idempotent && attempts < 2 {
                        attempts += 1;
                        pm_core::pm_warn!(
                            "[admin] <- {label} {} {elapsed}ms，第 {attempts}/2 次重试",
                            status.as_u16()
                        );
                        tokio::time::sleep(Duration::from_millis(400 * attempts as u64)).await;
                        continue;
                    }
                    pm_core::pm_warn!(
                        "[admin] !! {label} {} {elapsed}ms：{}",
                        status.as_u16(),
                        message_or_path(&message, path)
                    );
                    return Err(match status.as_u16() {
                        404 => AppError::NotFound(message_or_path(&message, path)),
                        401 | 403 => AppError::Auth(if message.is_empty() {
                            format!("认证被拒绝（{}）", status.as_u16())
                        } else {
                            format!("{}（{}）", message, status.as_u16())
                        }),
                        _ => AppError::Http {
                            status: status.as_u16(),
                            message: message_or_path(&message, path),
                        },
                    });
                }
                Err(error) => {
                    let elapsed = started.elapsed().as_millis();
                    let reason = condense_error(&error.to_string());
                    if attempts < 2
                        && ((idempotent
                            && (error.is_connect() || error.is_timeout() || error.is_request()))
                            || error.is_connect())
                    {
                        attempts += 1;
                        pm_core::pm_warn!(
                            "[admin] !! {label} 连接失败（{elapsed}ms），第 {attempts}/2 次重试：{reason}"
                        );
                        tokio::time::sleep(Duration::from_millis(400 * attempts as u64)).await;
                        continue;
                    }
                    pm_core::pm_warn!("[admin] !! {label} 连接失败（{elapsed}ms）：{reason}");
                    return Err(AppError::Network(format!(
                        "无法连接 {}：{}",
                        self.base,
                        condense_error(&error.to_string())
                    )));
                }
            }
        }
    }

    pub async fn get_json<T: DeserializeOwned>(&self, path: &str) -> AppResult<T> {
        let response = self.execute(Method::GET, path, None, None).await?;
        self.decode(response).await
    }

    pub async fn get_json_or_none<T: DeserializeOwned>(&self, path: &str) -> AppResult<Option<T>> {
        match self.get_json::<T>(path).await {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.is_not_found() => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub async fn get_opt_json<T: DeserializeOwned>(&self, path: &str) -> AppResult<Option<T>> {
        match self.execute(Method::GET, path, None, None).await {
            Ok(response) => Ok(Some(self.decode(response).await?)),
            Err(error) if error.is_not_found() => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub async fn get_raw(&self, path: &str) -> AppResult<String> {
        let response = self.execute(Method::GET, path, None, None).await?;
        Ok(response.text().await.unwrap_or_default())
    }

    pub async fn post_json<T: DeserializeOwned>(&self, path: &str, body: Value) -> AppResult<T> {
        let response = self.execute(Method::POST, path, Some(body), None).await?;
        self.decode(response).await
    }

    pub async fn post_empty(&self, path: &str) -> AppResult<()> {
        self.execute(Method::POST, path, None, None).await?;
        Ok(())
    }

    pub async fn post_with_query(
        &self,
        path: &str,
        body: Option<Value>,
        query: &[(String, String)],
    ) -> AppResult<()> {
        self.execute(Method::POST, path, body, Some(query)).await?;
        Ok(())
    }

    pub async fn put_json(&self, path: &str, body: Value) -> AppResult<()> {
        self.execute(Method::PUT, path, Some(body), None).await?;
        Ok(())
    }

    pub async fn put_empty(&self, path: &str) -> AppResult<()> {
        self.execute(Method::PUT, path, None, None).await?;
        Ok(())
    }

    pub async fn put_with_query(&self, path: &str, query: &[(String, String)]) -> AppResult<()> {
        self.execute(Method::PUT, path, None, Some(query)).await?;
        Ok(())
    }

    pub async fn delete(&self, path: &str) -> AppResult<()> {
        self.execute(Method::DELETE, path, None, None).await?;
        Ok(())
    }

    /// 带查询参数的 PUT（例如 topic 级策略里个别端点要同时收 body 与 query）。
    pub async fn execute_put(
        &self,
        path: &str,
        body: Value,
        query: &[(String, String)],
    ) -> AppResult<()> {
        self.execute(Method::PUT, path, Some(body), Some(query))
            .await?;
        Ok(())
    }

    /// 带查询参数的 DELETE：backlogQuota 必须点名删哪一条配额。
    pub async fn delete_with_query(&self, path: &str, query: &[(String, String)]) -> AppResult<()> {
        if query.is_empty() {
            self.execute(Method::DELETE, path, None, None).await?;
        } else {
            self.execute(Method::DELETE, path, None, Some(query))
                .await?;
        }
        Ok(())
    }

    /// multipart 提交（函数/连接器注册）：`fields` 是普通文本段，`file` 是可选的数据文件段。
    /// 文件段必须带 filename，worker 落包取的就是它；没文件名的分段在它那边等于没上传。
    pub async fn post_multipart(
        &self,
        path: &str,
        fields: &[(String, String)],
        file: Option<(&std::path::Path, String)>,
    ) -> AppResult<String> {
        let mut form = reqwest::multipart::Form::new();
        for (key, value) in fields {
            form = form.text(key.clone(), value.clone());
        }
        if let Some((file_path, file_name)) = file {
            let meta = tokio::fs::metadata(file_path).await.map_err(|e| {
                AppError::config(format!("本地包读不到：{}（{e}）", file_path.display()))
            })?;
            if meta.len() == 0 {
                return Err(AppError::config(format!(
                    "本地包是空的：{}",
                    file_path.display()
                )));
            }
            let bytes = tokio::fs::read(file_path).await.map_err(|e| {
                AppError::config(format!("本地包读不到：{}（{e}）", file_path.display()))
            })?;
            let part = reqwest::multipart::Part::bytes(bytes)
                .file_name(file_name)
                .mime_str("application/octet-stream")
                .map_err(|e| AppError::config(format!("构造上传分段失败：{e}")))?;
            form = form.part("data", part);
        }

        let started = std::time::Instant::now();
        pm_core::pm_log!("[admin] -> POST {path} (multipart)");
        let mut builder = self.http.post(self.url(path)).multipart(form);
        if let Some(token) = &self.auth_params {
            builder = builder.header("Authorization", format!("Bearer {token}"));
        }
        let response = match builder.send().await {
            Ok(response) => response,
            Err(error) => {
                pm_core::pm_warn!(
                    "[admin] !! POST {path} 上传失败（{}ms）：{}",
                    started.elapsed().as_millis(),
                    condense_error(&error.to_string())
                );
                return Err(AppError::Network(format!("上传 {path} 失败：{error}")));
            }
        };
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let elapsed = started.elapsed().as_millis();
        if status.is_success() {
            pm_core::pm_log!("[admin] <- POST {path} {} {elapsed}ms", status.as_u16());
            return Ok(text);
        }
        let message = condense_error(&text);
        pm_core::pm_warn!(
            "[admin] !! POST {path} {} {elapsed}ms：{}",
            status.as_u16(),
            message_or_path(&message, path)
        );
        Err(match status.as_u16() {
            404 => AppError::NotFound(message_or_path(&message, path)),
            401 | 403 => AppError::Auth(format!(
                "{}（{}）",
                message_or_path(&message, path),
                status.as_u16()
            )),
            _ => AppError::Http {
                status: status.as_u16(),
                message: message_or_path(&message, path),
            },
        })
    }

    /// 原样返回响应体文本（函数 trigger 的输出不是 JSON）。
    pub async fn post_form_raw(&self, path: &str, form: &[(&str, &str)]) -> AppResult<String> {
        let mut attempts = 0;
        let label = format!("POST {path}");
        loop {
            let started = std::time::Instant::now();
            pm_core::pm_log!("[admin] -> {label}");
            let _permit = self
                .limit
                .acquire()
                .await
                .map_err(|_| AppError::Other("请求队列已关闭".into()))?;
            let mut builder = self.http.post(self.url(path));
            if let Some(token) = &self.auth_params {
                builder = builder.header("Authorization", format!("Bearer {token}"));
            }
            let mut multipart = reqwest::multipart::Form::new();
            for (key, value) in form {
                multipart = multipart.text(key.to_string(), value.to_string());
            }
            let outcome = builder.multipart(multipart).send().await;
            match outcome {
                Ok(response) => {
                    let status = response.status();
                    let elapsed = started.elapsed().as_millis();
                    if status.is_success() {
                        pm_core::pm_log!("[admin] <- {label} {} {elapsed}ms", status.as_u16());
                        return Ok(response.text().await.unwrap_or_default());
                    }
                    let text = response.text().await.unwrap_or_default();
                    let message = condense_error(&text);
                    if attempts < 2 && matches!(status.as_u16(), 503 | 502) {
                        attempts += 1;
                        tokio::time::sleep(Duration::from_millis(400 * attempts as u64)).await;
                        continue;
                    }
                    pm_core::pm_warn!(
                        "[admin] !! {label} {} {elapsed}ms：{}",
                        status.as_u16(),
                        message_or_path(&message, path)
                    );
                    return Err(match status.as_u16() {
                        404 => AppError::NotFound(message_or_path(&message, path)),
                        401 | 403 => AppError::Auth(if message.is_empty() {
                            format!("认证被拒绝（{}）", status.as_u16())
                        } else {
                            format!("{}（{}）", message, status.as_u16())
                        }),
                        _ => AppError::Http {
                            status: status.as_u16(),
                            message: message_or_path(&message, path),
                        },
                    });
                }
                Err(error) => {
                    pm_core::pm_warn!(
                        "[admin] !! {label} 连接失败（{}ms）：{}",
                        started.elapsed().as_millis(),
                        condense_error(&error.to_string())
                    );
                    return Err(AppError::Network(format!(
                        "无法连接 {}：{}",
                        self.base,
                        condense_error(&error.to_string())
                    )));
                }
            }
        }
    }

    async fn decode<T: DeserializeOwned>(&self, response: Response) -> AppResult<T> {
        let bytes = response
            .bytes()
            .await
            .map_err(|e| AppError::Network(format!("读取响应失败: {e}")))?;
        if bytes.is_empty() {
            return serde_json::from_str("null")
                .map_err(|e| AppError::Other(format!("响应为空且无法按期望类型解析: {e}")));
        }
        serde_json::from_slice(&bytes).map_err(|e| {
            pm_core::pm_warn!("[admin] 响应解析失败：{e}");
            AppError::Other(format!(
                "解析 broker 响应失败: {e}；响应前 200 字节：{}",
                String::from_utf8_lossy(&bytes[..bytes.len().min(200)])
            ))
        })
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    /// 探活：按「最不可能被权限拦住」的顺序试多个端点，任意一个 2xx/3xx 即视为连通。
    pub async fn health_check(&self) -> bool {
        const ENDPOINTS: [&str; 4] = [
            "/admin/v2/clusters",
            "/admin/v2/tenants",
            "/admin/v2/brokers/health",
            "/admin/healthcheck",
        ];
        for endpoint in ENDPOINTS {
            let probe = async { self.execute(Method::GET, endpoint, None, None).await };
            if let Ok(Ok(response)) = tokio::time::timeout(Duration::from_secs(3), probe).await {
                if response.status().is_success() || response.status().is_redirection() {
                    return true;
                }
            }
        }
        pm_core::pm_warn!(
            "[admin] 健康检查失败 base={}（已尝试 {} 个端点）",
            pm_core::redact_endpoint(&self.base),
            ENDPOINTS.len()
        );
        false
    }

    /// broker 版本：`/metrics` 里的 `pulsar_version_info` 标签最可靠；
    /// `/clusters/{name}` 的 version 在不少部署里根本不出现。
    pub async fn version(&self) -> Option<String> {
        if let Ok(Ok(text)) =
            tokio::time::timeout(Duration::from_secs(5), self.get_raw("/metrics")).await
        {
            if let Some(version) = parse_version_metric(&text) {
                return Some(version);
            }
        }
        let clusters: Option<Vec<String>> = self
            .get_json_or_none("/admin/v2/clusters")
            .await
            .ok()
            .flatten();
        for name in clusters.unwrap_or_default().into_iter().take(1) {
            if let Ok(Some(info)) = self
                .get_opt_json::<ClusterInfo>(&format!("/admin/v2/clusters/{name}"))
                .await
            {
                if let Some(version) = info.version {
                    return Some(version);
                }
            }
        }
        None
    }

    /// 版本探测的快速路径：只读 `/clusters` 与集群详情，不碰 `/metrics`。
    /// 删除 topic 只需要区分 2.10 的 deleteSchema 参数，不值得为一个可选参数
    /// 在没开 metrics 的集群上等满 5 秒。
    pub async fn version_quick(&self) -> Option<String> {
        let clusters: Option<Vec<String>> = self
            .get_json_or_none("/admin/v2/clusters")
            .await
            .ok()
            .flatten();
        for name in clusters.unwrap_or_default().into_iter().take(1) {
            if let Ok(Some(info)) = self
                .get_opt_json::<ClusterInfo>(&format!("/admin/v2/clusters/{name}"))
                .await
            {
                if let Some(version) = info.version {
                    return Some(version);
                }
            }
        }
        None
    }

    pub async fn test_connection(&self) -> ConnectionTest {
        if !self.health_check().await {
            return ConnectionTest {
                connected: false,
                version: None,
                error: Some(format!(
                    "无法连接 Admin REST（{}）：/clusters、/tenants、/brokers/health、/admin/healthcheck 四个探测端点均失败。请检查 webServiceUrl 端口、TLS 证书与 Token；每次请求的状态码与耗时见「设置 → 日志」。",
                    pm_core::redact_endpoint(&self.base)
                )),
            };
        }
        ConnectionTest {
            connected: true,
            version: self.version().await,
            error: None,
        }
    }
}

fn message_or_path(message: &str, path: &str) -> String {
    if message.is_empty() {
        path.to_string()
    } else {
        message.to_string()
    }
}

/// 只保留可读的首行/首段，去掉 Java 堆栈。
pub fn condense_error(raw: &str) -> String {
    let head = raw
        .split("Stacktrace:")
        .next()
        .unwrap_or(raw)
        .lines()
        .take(3)
        .collect::<Vec<_>>()
        .join(" ");
    let single = head.split_whitespace().collect::<Vec<_>>().join(" ");
    if single.chars().count() <= MAX_ERROR_CHARS {
        single
    } else {
        let truncated: String = single.chars().take(MAX_ERROR_CHARS - 1).collect();
        format!("{truncated}…")
    }
}

fn read_pem(value: &str) -> AppResult<Vec<u8>> {
    if value.contains("-----BEGIN") {
        return Ok(value.as_bytes().to_vec());
    }
    std::fs::read(value).map_err(|e| AppError::config(format!("无法读取证书文件 {value}: {e}")))
}

/// 从 Prometheus 文本里抠 `pulsar_version_info{...version="3.3.9"...}` 的 version 标签。
pub fn parse_version_metric(text: &str) -> Option<String> {
    let mut rest = text;
    while let Some(index) = rest.find("pulsar_version_info{") {
        let after = &rest[index + "pulsar_version_info{".len()..];
        let end = after.find('}')?;
        let labels = &after[..end];
        for part in labels.split(',') {
            if let Some(value) = part.trim().strip_prefix("version=\"") {
                return Some(value.trim_end_matches('"').to_string());
            }
        }
        rest = &after[end..];
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn condenses_java_stack() {
        let raw = "HTTP 404 Not Found\nReason: Policies not found\nStacktrace:\norg.apache.pulsar.broker.admin.impl.PersistentTopicsBase.getPartitionedTopicMetadata(PersistentTopicsBase.java:123)\n\tat java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke0(Native Method)";
        assert_eq!(
            condense_error(raw),
            "HTTP 404 Not Found Reason: Policies not found"
        );
    }

    #[test]
    fn parses_version_label() {
        let text = "# HELP pulsar_version_info\npulsar_version_info{cluster=\"pulsar\",version=\"3.0.1\"} 1\n";
        assert_eq!(parse_version_metric(text).as_deref(), Some("3.0.1"));
    }
}
