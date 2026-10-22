use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use pm_core::{AdminConfig, AppError, AppResult, ClusterInfo, ConnectionTest};
use reqwest::{Method, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::Notify;

use pm_core::resolve_base_url;

/// 错误体里常带完整 Java 堆栈，界面只有一行位置，原样透传既撑坏提示也没人看得懂。
const MAX_ERROR_CHARS: usize = 300;

/// 同时在途的 Admin REST 请求上限的出厂值（设置里可改，见 `set_admin_concurrency`）。
pub const DEFAULT_ADMIN_CONCURRENCY: usize = 8;

/// 上限的硬边界。下限 1：设成 0 等于让所有 Admin 请求都排不进来，页面会全空，
/// 这种值只能是误输入；上限 64：再多也不会更快，只会把 broker 的连接与线程打满。
pub const MAX_ADMIN_CONCURRENCY: usize = 64;

/// 进程级并发闸门：所有 `AdminClient` 实例共享同一份在途计数。
///
/// 用计数 + `Notify` 而不是 `tokio::sync::Semaphore`，是因为信号量的许可数固定，
/// 而这一项用户可以随时在设置里改；计数式闸门能在运行中升降上限，调小后已发出的
/// 请求照常跑完，只是不再放新的进来。
struct ConcurrencyGate {
    state: Mutex<GateState>,
    notify: Notify,
}

struct GateState {
    limit: usize,
    in_flight: usize,
}

/// 闸门被释放时用的凭据：作用域结束（含提前 return / panic）即归还一个名额。
struct AdminPermit {
    gate: Arc<ConcurrencyGate>,
}

/// 份额是**进程级**的：每个 RPC 都会 `AdminClient::new` 一次，若把闸门放进实例里，
/// 「最多 N 个在途请求」就变成「每个实例最多 N 个」——多集群一起刷新时上限随实例数
/// 线性放大，等于没有上限。放成 static 后所有集群共享同一份计数。
static ADMIN_CONCURRENCY: LazyLock<Arc<ConcurrencyGate>> =
    LazyLock::new(|| Arc::new(ConcurrencyGate::new(DEFAULT_ADMIN_CONCURRENCY)));

/// 把上限夹到合法区间（`set_admin_concurrency` 与设置写入两侧共用一套边界）。
pub fn clamp_admin_concurrency(limit: usize) -> usize {
    limit.clamp(1, MAX_ADMIN_CONCURRENCY)
}

/// 设置 Admin 并发上限，返回实际生效的值（越界已夹到 `1..=MAX_ADMIN_CONCURRENCY`）。
///
/// 只改闸门，不落库：持久化由设置层负责，这里是运行时的那一半。
pub fn set_admin_concurrency(limit: usize) -> usize {
    ADMIN_CONCURRENCY.set_limit(limit)
}

/// 当前生效的并发上限。
pub fn admin_concurrency() -> usize {
    ADMIN_CONCURRENCY.limit()
}

impl ConcurrencyGate {
    fn new(limit: usize) -> Self {
        Self {
            state: Mutex::new(GateState {
                limit: clamp_admin_concurrency(limit),
                in_flight: 0,
            }),
            notify: Notify::new(),
        }
    }

    /// 取锁：被投毒也继续用——这里只保护两个 usize，没有"写了一半"的不变量，
    /// 一次 panic 不该让后续所有 Admin 请求都拿不到名额。
    fn lock(&self) -> std::sync::MutexGuard<'_, GateState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn limit(&self) -> usize {
        self.lock().limit
    }

    /// 改上限，返回夹过的实际值。调小不回撤在途请求。
    fn set_limit(&self, limit: usize) -> usize {
        let limit = clamp_admin_concurrency(limit);
        {
            let mut state = self.lock();
            state.limit = limit;
        }
        // 调大后可能有请求正卡在通知上等名额，唤醒它们重试一次判断。
        self.notify.notify_waiters();
        limit
    }

    /// 等到一个名额。名额只由 `AdminPermit::drop` 归还。
    async fn acquire(self: &Arc<Self>) -> AdminPermit {
        loop {
            // 先登记等待、再判断名额：`notify_waiters` 只唤醒登记过的等待者，
            // 顺序反过来的话，"判断完发现满员、还没开始等"这中间发生的归还会丢掉。
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut state = self.lock();
                if state.in_flight < state.limit {
                    state.in_flight += 1;
                    return AdminPermit {
                        gate: Arc::clone(self),
                    };
                }
            }
            notified.await;
        }
    }
}

impl Drop for AdminPermit {
    fn drop(&mut self) {
        {
            let mut state = self.gate.lock();
            state.in_flight = state.in_flight.saturating_sub(1);
        }
        self.gate.notify.notify_waiters();
    }
}

/// Admin REST 客户端。一个集群一个实例，配置变了就换实例（与 TS 侧的
/// fingerprint 缓存同一个理由：隧道重连后本地端口会变）。
#[derive(Clone)]
pub struct AdminClient {
    pub(crate) http: reqwest::Client,
    pub(crate) base: String,
    pub(crate) auth_params: Option<String>,
    limit: Arc<ConcurrencyGate>,
    timeout: Duration,
}

impl AdminClient {
    pub fn new(config: &AdminConfig) -> AppResult<Self> {
        let base = resolve_base_url(config)?;
        let timeout = Duration::from_millis(config.timeout_ms.max(500));
        let mut builder = reqwest::Client::builder()
            .timeout(timeout)
            .connect_timeout(Duration::from_secs(5))
            // 这里**不保留**空闲连接：每个 RPC 新建一次客户端，池子跟着客户端一起丢，
            // 留在池里的连接只会被下次 gc 前的后台任务试探——对端（broker / NAT）此时
            // 若已把连接静默回收，复用它就会拿到 RST/半开连接，表现为「网络正常却连不上」。
            // 置 0 让每条连接用完即关，失败就退回最干净的建连路径。
            .pool_max_idle_per_host(0)
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
            limit: ADMIN_CONCURRENCY.clone(),
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
            // 拿到名额才发请求；名额随本轮作用域结束归还（提前 return / 出错也一样）。
            let _permit = self.limit.acquire().await;

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
            // 与 execute 同一套闸门：表单类请求同样算在在途上限里。
            let _permit = self.limit.acquire().await;
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

    fn test_config() -> AdminConfig {
        AdminConfig {
            service_url: "pulsar://127.0.0.1:6650".into(),
            web_service_url: Some("http://127.0.0.1:8080".into()),
            timeout_ms: 5000,
            auth_plugin: None,
            auth_params: None,
            tls_enabled: false,
            trust_certs: None,
        }
    }

    /// 每个 RPC 都会新建客户端；两个实例必须落到同一道闸门上，
    /// 否则「最多 N 个在途请求」会随实例数线性放大。
    #[test]
    fn concurrency_gate_is_process_wide() {
        let config = test_config();
        let first = AdminClient::new(&config).expect("第一个客户端应能构造");
        let second = AdminClient::new(&config).expect("第二个客户端应能构造");
        assert!(Arc::ptr_eq(&first.limit, &second.limit));
        assert!(Arc::ptr_eq(&first.limit, &ADMIN_CONCURRENCY));
        assert_eq!(ADMIN_CONCURRENCY.limit(), DEFAULT_ADMIN_CONCURRENCY);
    }

    /// 设置页能填的范围就是这里的边界：0 与超大值都被夹住，不再往下传。
    #[test]
    fn limit_bounds_are_clamped() {
        assert_eq!(clamp_admin_concurrency(0), 1);
        assert_eq!(clamp_admin_concurrency(1), 1);
        assert_eq!(clamp_admin_concurrency(16), 16);
        assert_eq!(clamp_admin_concurrency(usize::MAX), MAX_ADMIN_CONCURRENCY);
    }

    /// 名额用完要排队，归还后立刻放行；上限可在运行中升降——
    /// 调大不凭空多出名额（在途数才决定），调小不撤回在途请求、只挡新的。
    /// 用局部闸门，避免几个测试抢同一个 static。
    #[tokio::test]
    async fn gate_queues_when_full_and_follows_runtime_limit() {
        let gate = Arc::new(ConcurrencyGate::new(2));
        let first = gate.acquire().await;
        let second = gate.acquire().await;
        assert_eq!(gate.lock().in_flight, 2);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), gate.acquire())
                .await
                .is_err(),
            "满员时第 3 个请求必须排队"
        );

        drop(first);
        let third = tokio::time::timeout(Duration::from_millis(500), gate.acquire())
            .await
            .expect("归还名额后应立刻拿到");

        assert_eq!(gate.set_limit(4), 4);
        assert_eq!(gate.lock().in_flight, 2, "调大上限不该改变在途数");
        let fourth = gate.acquire().await;
        assert_eq!(gate.lock().in_flight, 3);

        let fifth = gate.acquire().await;
        assert_eq!(gate.lock().in_flight, 4);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), gate.acquire())
                .await
                .is_err(),
            "上限调到 4 后第 5 个仍要排队"
        );

        // 调小到 1（0 也夹到 1）：在途的照常跑完，新的进不来
        assert_eq!(gate.set_limit(0), 1);
        drop(second);
        drop(third);
        drop(fourth);
        drop(fifth);
        assert_eq!(gate.lock().in_flight, 0);

        let last = tokio::time::timeout(Duration::from_millis(500), gate.acquire())
            .await
            .expect("全空后应能拿到名额");
        drop(last);
        assert_eq!(gate.lock().in_flight, 0);
    }

    /// 设置项走的就是这两个函数：写入被夹住、现场能读回生效值。
    #[test]
    fn setting_limit_reports_effective_value() {
        let original = admin_concurrency();
        assert_eq!(set_admin_concurrency(3), 3);
        assert_eq!(admin_concurrency(), 3);
        assert_eq!(set_admin_concurrency(usize::MAX), MAX_ADMIN_CONCURRENCY);
        assert_eq!(admin_concurrency(), MAX_ADMIN_CONCURRENCY);
        assert_eq!(set_admin_concurrency(0), 1);
        // 收尾还原，免得影响同一进程里其它读全局上限的测试
        assert_eq!(set_admin_concurrency(original), original);
        assert_eq!(admin_concurrency(), original);
    }
}
