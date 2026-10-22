//! 检查更新 → 下载安装包 → 拉起安装器。
//!
//! 分发源是公开仓库的发行版附件：检查与下载都匿名可读，唯一的门槛是发行说明里那行
//! `SHA256：<64 位十六进制>`——没有它就不许下载，下载完对不上就不许安装。
//!
//! 三处刻意的取舍，都在对应函数上写明了理由，这里先给结论：
//! - **检查与下载用两个不同的 client。** 检查的响应很小，给一个短总超时；下载只能用
//!   “读超时”——reqwest 的 timeout 覆盖整个响应体，7 MB 的包在慢网下必然被打断。
//! - **检查走条件请求（ETag）。** GitHub 对 304 不计入限流额度，而匿名额度只有每小时
//!   60 次：公司出口 IP 后面几台机器同时开着，或者用户多点了两次“检查更新”，就会撞墙。
//! - **下载失败保留 .part 并续传。** 从国内访问这个更新源时抖动很常见，一次断流就从头再来
//!   是纯粹的浪费；同时懒得上大文件分片，`Range` 足够。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use pm_core::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::messaging::Emit;

const API_BASE: &str = "https://api.github.com";
const OWNER: &str = "lingfeng983";
const REPO: &str = "pulsar-manager";
/// 安装包上限 512MB：谎报 Content-Length 的响应不能把磁盘写满
const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
/// 一次检查取多少个发行版。只需要“最近若干个里版本号最大的那个”，取 100 会把每一份
/// 说明正文都拉下来（我们每份 4~6KB），白白多占几百 KB 与一次限流额度。
const RELEASES_PER_PAGE: usize = 30;
const DOWNLOAD_ATTEMPTS: usize = 3;
const CACHE_FILE: &str = "release-cache.json";
const USER_AGENT: &str = concat!("pulsar-manager-rust/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Clone, Serialize, Default)]
pub struct UpdateCheck {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub release_name: Option<String>,
    pub release_notes: Option<String>,
    pub download_url: Option<String>,
    pub file_name: Option<String>,
    pub size: Option<i64>,
}

/// 检查更新独有的失败分类。rpc 层要按类别给不同的提示：限流和“仓库没了”是两回事，
/// 混成一句“更新源不可读”会把用户引到完全错误的排查方向上去。
#[derive(Debug, Clone)]
pub enum UpdateError {
    /// GitHub 接口限流（匿名每小时 60 次）
    RateLimited { wait_seconds: u64 },
    /// 更新源本身不可读：仓库/发行版不存在、被改私有
    SourceUnavailable(String),
    /// 网络层失败：DNS、TLS、超时
    Network(String),
    /// 数据或校验层面的问题（说明里没有 SHA256、附件不是 GitHub 域名…）
    Invalid(String),
}

impl UpdateError {
    pub fn message(&self) -> String {
        match self {
            Self::RateLimited { wait_seconds } => {
                let minutes = (*wait_seconds).div_ceil(60).max(1);
                format!(
                    "GitHub 接口调用过于频繁（匿名额度每小时 60 次），约 {minutes} 分钟后才能再查。\
                     急着升级的话，直接到发行页手动下载安装包。"
                )
            }
            Self::SourceUnavailable(detail) => format!("更新源不可读：{detail}"),
            Self::Network(detail) => format!("检查更新失败：{detail}"),
            Self::Invalid(detail) => detail.clone(),
        }
    }
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message())
    }
}

impl From<UpdateError> for AppError {
    fn from(error: UpdateError) -> Self {
        AppError::Other(error.message())
    }
}

#[derive(Debug, Clone)]
struct Pending {
    url: String,
    file_name: String,
    sha256: String,
    /// 发行版声明的大小，服务端不报 Content-Length 时用它当进度分母
    size: u64,
}

/// 条件请求用的缓存：ETag 与上一次的响应体。GitHub 命中 304 时不计入限流额度，
/// 所以“用户多点两次检查更新”不该消耗额度。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CachedReleases {
    etag: String,
    body: String,
}

fn pending() -> &'static Mutex<Option<Pending>> {
    static PENDING: OnceLock<Mutex<Option<Pending>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(None))
}

fn last_file() -> &'static Mutex<Option<PathBuf>> {
    static FILE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    FILE.get_or_init(|| Mutex::new(None))
}

/// 取消标记。下载是流式的，每一块之间检查一次，取消了就把 .part 删掉——
/// 半截文件留在盘上，下次续传会从一个不该续的位置接着写。
fn cancel_flag() -> &'static AtomicBool {
    static CANCEL: OnceLock<AtomicBool> = OnceLock::new();
    CANCEL.get_or_init(|| AtomicBool::new(false))
}

/// 取消当前下载。没有下载在跑时调用是无害的（标记会被下一次下载开头清掉）。
pub fn cancel_download() {
    cancel_flag().store(true, Ordering::SeqCst);
}

/// 只比较稳定版号：`1.6.10` > `1.6.9`。
///
/// 解析不出来的段按 0 处理（与旧实现一致，避免把 `1.6.3+build` 之类判成“比 1.6.3 小”）。
pub fn compare_versions(a: &str, b: &str) -> i32 {
    let parse = |value: &str| -> Vec<i64> {
        value
            .trim_start_matches('v')
            .split('.')
            .map(|part| part.parse::<i64>().unwrap_or(0))
            .collect()
    };
    let left = parse(a);
    let right = parse(b);
    for index in 0..left.len().max(right.len()) {
        let one = *left.get(index).unwrap_or(&0);
        let two = *right.get(index).unwrap_or(&0);
        if one != two {
            return if one > two { 1 } else { -1 };
        }
    }
    0
}

/// 从 tag 里取稳定版号：`v1.6.3` → Some("1.6.3")，`v1.7.0-rc1` / `nightly` → None。
///
/// 这条是“预发布不许当正式版推给所有人”的第一道闸：`compare_versions` 会把
/// `1.7.0-rc1` 里的 `0-rc1` 解析成 0，于是 RC 被当成 1.7.0 推下去，装完就是回退版本。
fn stable_version(tag: &str) -> Option<String> {
    let trimmed = tag.trim().trim_start_matches(['v', 'V']);
    if trimmed.is_empty() {
        return None;
    }
    let mut parts = 0;
    for part in trimmed.split('.') {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        parts += 1;
    }
    if parts < 2 {
        return None;
    }
    Some(trimmed.to_string())
}

fn sha256_from_notes(notes: &str) -> Option<String> {
    // 发行说明里固定带一行 `- SHA256：`<64 位>``
    let mut rest = notes;
    while let Some(index) = rest.to_uppercase().find("SHA256") {
        let tail = &rest[index..];
        let hex: String = tail
            .chars()
            .skip(6)
            .filter(|ch| ch.is_ascii_hexdigit())
            .take(64)
            .collect();
        if hex.len() == 64 {
            return Some(hex.to_lowercase());
        }
        if tail.len() < 7 {
            break;
        }
        rest = &tail[6..];
    }
    None
}

/// 只信任 GitHub 的附件地址，且必须是 https：不能拿发行说明里的任意 URL 去下载并执行。
/// 下载会跟随 302 跳到 `*.githubusercontent.com`，这里把两类域名都放行。
fn allowed_asset(url: &str) -> bool {
    match url::Url::parse(url) {
        Ok(parsed) => {
            if parsed.scheme() != "https" {
                return false;
            }
            match parsed.host_str() {
                Some(host) => {
                    let host = host.to_lowercase();
                    host == "github.com"
                        || host.ends_with(".github.com")
                        || host == "githubusercontent.com"
                        || host.ends_with(".githubusercontent.com")
                }
                None => false,
            }
        }
        Err(_) => false,
    }
}

/// 代理串 → reqwest 代理。空串表示直连（也接受系统环境变量里配好的代理，reqwest 默认行为）。
fn proxy_from(proxy: &str) -> Result<Option<reqwest::Proxy>, UpdateError> {
    let trimmed = proxy.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| {
        UpdateError::Invalid(format!(
            "代理地址「{trimmed}」格式不对，应形如 http://127.0.0.1:7890（留空表示直连）"
        ))
    })?;
    match parsed.scheme() {
        "http" | "https" => reqwest::Proxy::all(trimmed)
            .map(Some)
            .map_err(|error| UpdateError::Invalid(format!("代理设置不可用：{error}"))),
        other => Err(UpdateError::Invalid(format!(
            "暂不支持 {other} 代理，请填 http:// 或 https:// 开头的地址"
        ))),
    }
}

/// 检查用的 client：响应只有几十 KB，给一个短总超时就够，卡住要尽快失败。
fn api_client(proxy: &str) -> Result<reqwest::Client, UpdateError> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .user_agent(USER_AGENT);
    if let Some(proxy) = proxy_from(proxy)? {
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|error| UpdateError::Network(format!("初始化更新客户端失败: {error}")))
}

/// 下载用的 client：**不设总超时**，只设连接超时与读超时。
///
/// reqwest 的 `timeout` 是从建立连接一直算到响应体读完的，7 MB 的安装包在 375 KB/s 以下的
/// 链路上必然超过 20 秒——那正是网络最差、最需要更新的时候，反而一定失败。
fn download_client(proxy: &str) -> Result<reqwest::Client, UpdateError> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .user_agent(USER_AGENT);
    if let Some(proxy) = proxy_from(proxy)? {
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|error| UpdateError::Network(format!("初始化下载客户端失败: {error}")))
}

fn read_cache(path: &Path) -> CachedReleases {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_cache(path: &Path, cache: &CachedReleases) {
    // 缓存写失败不影响检查结果，最多是下一次多花一次额度。
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(cache) {
        let _ = std::fs::write(path, text);
    }
}

fn header_u64(headers: &reqwest::header::HeaderMap, name: &str) -> Option<u64> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
}

/// 把剩下的秒数算出来：`X-RateLimit-Reset` 是重置时刻的 unix 秒。
fn rate_limit_wait(headers: &reqwest::header::HeaderMap) -> u64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0);
    header_u64(headers, "x-ratelimit-reset")
        .map(|reset| reset.saturating_sub(now))
        .unwrap_or(60)
}

/// 检查更新。`proxy` 为空串时直连；`cache_dir` 用来放 ETag 缓存。
pub async fn check(
    current_version: &str,
    cache_dir: &Path,
    proxy: &str,
) -> Result<UpdateCheck, UpdateError> {
    let client = api_client(proxy)?;
    let cache_path = cache_dir.join(CACHE_FILE);
    let cached = read_cache(&cache_path);

    let mut request = client
        .get(format!("{API_BASE}/repos/{OWNER}/{REPO}/releases?per_page={RELEASES_PER_PAGE}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if !cached.etag.is_empty() {
        request = request.header("If-None-Match", cached.etag.clone());
    }

    let response = request
        .send()
        .await
        .map_err(|error| UpdateError::Network(error.to_string()))?;
    let status = response.status();
    let headers = response.headers().clone();

    let body = if status == reqwest::StatusCode::NOT_MODIFIED {
        // 304 不计入限流额度，这是“多开几次检查更新也不吃额度”的关键。
        if cached.body.is_empty() {
            return Err(UpdateError::Invalid(
                "更新源返回 304，但本地没有缓存内容，请重新检查".into(),
            ));
        }
        cached.body
    } else if status.is_success() {
        let etag = headers
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let text = response
            .text()
            .await
            .map_err(|error| UpdateError::Network(error.to_string()))?;
        if !etag.is_empty() {
            write_cache(
                &cache_path,
                &CachedReleases {
                    etag,
                    body: text.clone(),
                },
            );
        }
        text
    } else if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::TOO_MANY_REQUESTS
    {
        // 403 有两种：限流，或者仓库真的读不到。用剩余额度区分，别把限流说成“仓库没了”。
        let remaining = header_u64(&headers, "x-ratelimit-remaining").unwrap_or(0);
        if remaining == 0 {
            return Err(UpdateError::RateLimited {
                wait_seconds: rate_limit_wait(&headers),
            });
        }
        return Err(UpdateError::SourceUnavailable(format!(
            "GitHub 返回 HTTP {status}"
        )));
    } else if status == reqwest::StatusCode::NOT_FOUND {
        return Err(UpdateError::SourceUnavailable(format!(
            "仓库 {OWNER}/{REPO} 或它的发行版不存在（HTTP 404）"
        )));
    } else {
        return Err(UpdateError::Network(format!("更新源返回 HTTP {status}")));
    };

    let items: Vec<serde_json::Value> = serde_json::from_str::<Vec<serde_json::Value>>(&body)
        .map_err(|error| UpdateError::Invalid(format!("解析发行版列表失败: {error}")))?;
    if items.is_empty() {
        return Err(UpdateError::SourceUnavailable("仓库里还没有任何发行版".into()));
    }

    // 只认稳定版：草稿与预发布直接跳过，tag 带 -rc/-beta 后缀的一并跳过。
    let mut best: Option<(String, &serde_json::Value)> = None;
    for item in &items {
        if item.get("draft").and_then(serde_json::Value::as_bool).unwrap_or(false) {
            continue;
        }
        if item
            .get("prerelease")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        let Some(tag) = item.get("tag_name").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(version) = stable_version(tag) else {
            continue;
        };
        let replace = match &best {
            None => true,
            Some((current, _)) => compare_versions(&version, current) > 0,
        };
        if replace {
            best = Some((version, item));
        }
    }
    let (latest_version, latest) = best.ok_or_else(|| {
        UpdateError::SourceUnavailable("仓库里没有任何稳定版发行版（只有草稿或预发布）".into())
    })?;

    let notes = latest
        .get("body")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let release_name = latest
        .get("name")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("v{latest_version}"));

    let mut result = UpdateCheck {
        current_version: current_version.to_string(),
        latest_version: latest_version.clone(),
        has_update: compare_versions(&latest_version, current_version) > 0,
        release_name: Some(release_name),
        release_notes: Some(notes.clone()),
        ..Default::default()
    };
    if !result.has_update {
        return Ok(result);
    }

    // GitHub 的发行版对象里直接带 assets，不用再单独请求附件列表。
    let mut candidates: Vec<(String, i64, String, bool)> = latest
        .get("assets")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let name = item.get("name").and_then(serde_json::Value::as_str)?.to_string();
            if !name.to_lowercase().ends_with(".exe") {
                return None;
            }
            let url = item
                .get("browser_download_url")
                .and_then(serde_json::Value::as_str)?
                .to_string();
            let size = item.get("size").and_then(serde_json::Value::as_i64).unwrap_or(0);
            Some((name.clone(), size, url, name.contains("安装包")))
        })
        .collect();
    // 同版本可能有多个 exe：优先名字含「安装包」的，再退化为最大的那个
    candidates.sort_by(|a, b| b.3.cmp(&a.3).then(b.1.cmp(&a.1)));
    let (file_name, size, url, _) = candidates.into_iter().next().ok_or_else(|| {
        UpdateError::Invalid(format!("最新版本 {latest_version} 没有可下载的 exe 安装包附件"))
    })?;
    if !allowed_asset(&url) {
        return Err(UpdateError::Invalid(
            "发行版附件地址不是受信任的 GitHub https 地址".into(),
        ));
    }
    let sha256 = sha256_from_notes(&notes).ok_or_else(|| {
        UpdateError::Invalid(
            "该发行版的说明里没有 SHA256，无法校验安装包，请让发布方补上 SHA256 行后重新发布".into(),
        )
    })?;

    *pending().lock().unwrap() = Some(Pending {
        url: url.clone(),
        file_name: file_name.clone(),
        sha256,
        size: size.max(0) as u64,
    });
    result.download_url = Some(url);
    result.file_name = Some(file_name);
    result.size = Some(size);
    Ok(result)
}

/// 单次下载尝试的失败分类：可重试的（断流、超时）与不可重试的（越界、写盘失败）分开走。
enum DownloadFailure {
    Cancelled,
    Retryable(String),
    Fatal(AppError),
}

fn total_from_content_range(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let raw = headers
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())?;
    // 形如 `bytes 1024-7810074/7810075`
    let total = raw.rsplit('/').next()?.trim();
    total.parse::<u64>().ok()
}

async fn hash_file(path: &Path) -> AppResult<String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| AppError::Other(format!("读取安装包失败：{error}")))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|error| AppError::Other(format!("读取安装包失败：{error}")))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// 下载一次：能从 .part 续传就续，不能就重来。返回已落盘的字节数。
async fn fetch_once(
    client: &reqwest::Client,
    url: &str,
    part_path: &Path,
    declared_size: u64,
    emit: &Emit,
) -> Result<u64, DownloadFailure> {
    let have = tokio::fs::metadata(part_path)
        .await
        .map(|meta| meta.len())
        .unwrap_or(0);

    let mut request = client.get(url);
    if have > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let mut response = request
        .send()
        .await
        .map_err(|error| DownloadFailure::Retryable(format!("建立下载连接失败: {error}")))?;
    let status = response.status();

    // 续传态：206 表示服务端接受了 Range；200 表示它忽略了 Range（或不支持），必须从头写；
    // 416 表示 .part 已经不小于远端文件（上次其实下完了，或文件被替换过）。
    let (mut received, total, append) = if status == reqwest::StatusCode::PARTIAL_CONTENT {
        let total = total_from_content_range(response.headers())
            .or_else(|| response.content_length().map(|length| have + length))
            .unwrap_or(declared_size);
        (have, total, true)
    } else if status.is_success() {
        (0, response.content_length().unwrap_or(declared_size), false)
    } else if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        // 416：.part 已经不小于远端文件。大小正好相等说明上次其实下完了，直接进入校验；
        // 大于远端则是坏文件（版本换了、写坏了），删掉重下一次。
        let total = total_from_content_range(response.headers()).unwrap_or(have);
        if have == total {
            (have, total, true)
        } else {
            let _ = tokio::fs::remove_file(part_path).await;
            return Err(DownloadFailure::Retryable(
                "续传位置超过远端文件大小，丢弃半成品重下".into(),
            ));
        }
    } else {
        return Err(DownloadFailure::Retryable(format!("安装包下载返回 HTTP {status}")));
    };

    if total > MAX_DOWNLOAD_BYTES {
        return Err(DownloadFailure::Fatal(AppError::Other(
            "安装包超过 512MB 上限，已中止下载".into(),
        )));
    }

    let mut file = if append {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(part_path)
            .await
            .map_err(|error| DownloadFailure::Fatal(AppError::Other(format!("无法写入安装包：{error}"))))?
    } else {
        tokio::fs::File::create(part_path)
            .await
            .map_err(|error| DownloadFailure::Fatal(AppError::Other(format!("无法写入安装包：{error}"))))?
    };

    let mut last_emit = std::time::Instant::now();
    loop {
        if cancel_flag().load(Ordering::SeqCst) {
            let _ = file.flush().await;
            drop(file);
            let _ = tokio::fs::remove_file(part_path).await;
            return Err(DownloadFailure::Cancelled);
        }
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(error) => {
                let _ = file.flush().await;
                // 保留 .part：下一次尝试从断点续传
                return Err(DownloadFailure::Retryable(format!("下载中断: {error}")));
            }
        };
        received += chunk.len() as u64;
        if received > MAX_DOWNLOAD_BYTES {
            drop(file);
            let _ = tokio::fs::remove_file(part_path).await;
            return Err(DownloadFailure::Fatal(AppError::Other(
                "安装包超过 512MB 上限，已中止下载".into(),
            )));
        }
        if let Err(error) = file.write_all(&chunk).await {
            drop(file);
            let _ = tokio::fs::remove_file(part_path).await;
            return Err(DownloadFailure::Fatal(AppError::Other(format!(
                "写入安装包失败：{error}"
            ))));
        }
        if last_emit.elapsed() >= Duration::from_millis(200) {
            last_emit = std::time::Instant::now();
            emit(
                "update:progress",
                serde_json::json!({"received": received, "total": total}),
            );
        }
    }
    let _ = file.flush().await;
    drop(file);

    if total > 0 && received != total {
        return Err(DownloadFailure::Retryable(format!(
            "下载不完整（{received}/{total} 字节）"
        )));
    }
    Ok(received)
}

/// 下载：进度按 `update:progress` 推，落盘前校验 SHA256，对不上就不改名。
pub async fn download(url: &str, dir: &Path, proxy: &str, emit: Emit) -> AppResult<String> {
    let target_info = pending()
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| AppError::Other("请先检查更新，再下载安装包".into()))?;
    // 渲染层只提供它看到的 URL，真正的地址以检查结果为准
    if !url.trim().is_empty() && url != target_info.url {
        return Err(AppError::Other("下载地址与最近一次检查结果不一致，请重新检查更新".into()));
    }

    std::fs::create_dir_all(dir).map_err(AppError::from)?;
    let safe_name: String = target_info
        .file_name
        .chars()
        .map(|ch| if ch.is_alphanumeric() || ch == '.' || ch == '-' || ch == '_' { ch } else { '_' })
        .collect();
    let final_path = dir.join(&safe_name);
    let part_path = dir.join(format!("{safe_name}.part"));

    let client = download_client(proxy).map_err(AppError::from)?;
    cancel_flag().store(false, Ordering::SeqCst);

    let mut attempt = 0;
    loop {
        attempt += 1;
        match fetch_once(&client, &target_info.url, &part_path, target_info.size, &emit).await {
            Ok(_) => break,
            Err(DownloadFailure::Cancelled) => {
                emit(
                    "update:progress",
                    serde_json::json!({"received": 0, "total": 0, "cancelled": true}),
                );
                return Err(AppError::Other("已取消下载".into()));
            }
            Err(DownloadFailure::Fatal(error)) => {
                emit(
                    "update:progress",
                    serde_json::json!({"received": 0, "total": 0, "error": error.to_string()}),
                );
                return Err(error);
            }
            Err(DownloadFailure::Retryable(reason)) => {
                if attempt >= DOWNLOAD_ATTEMPTS {
                    let _ = tokio::fs::remove_file(&part_path).await;
                    emit(
                        "update:progress",
                        serde_json::json!({"received": 0, "total": 0, "error": reason}),
                    );
                    return Err(AppError::Network(format!(
                        "{reason}（已重试 {DOWNLOAD_ATTEMPTS} 次）"
                    )));
                }
                // 断点续传：下一次尝试会读到 .part 的长度并从那里继续
                emit(
                    "update:progress",
                    serde_json::json!({
                        "received": 0,
                        "total": target_info.size,
                        "retrying": attempt,
                        "attempts": DOWNLOAD_ATTEMPTS,
                    }),
                );
                tokio::time::sleep(Duration::from_secs(2 * attempt as u64)).await;
            }
        }
    }

    // 哈希在读回来的完整文件上算：续传时前面那段是上一次写的，滚动的 hasher 状态没法跨尝试。
    let actual = hash_file(&part_path).await?;
    if actual != target_info.sha256 {
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(AppError::Other(
            "安装包 SHA256 校验不通过（下载损坏或发行包被替换），不能安装".into(),
        ));
    }

    let _ = tokio::fs::remove_file(&final_path).await;
    tokio::fs::rename(&part_path, &final_path)
        .await
        .map_err(|e| AppError::Other(format!("安装包落盘失败：{e}")))?;
    *last_file().lock().unwrap() = Some(final_path.clone());
    emit(
        "update:progress",
        serde_json::json!({"received": target_info.size, "total": target_info.size, "done": true}),
    );
    Ok(final_path.to_string_lossy().to_string())
}

/// 拉起安装器：NSIS 支持 /SILENT，静默覆盖安装。
///
/// 本进程必须立刻退出让出 exe 与 dll，所以“等安装器装完再把应用拉起来”这件事只能交给
/// 一个外部观察者——NSIS 的 /SILENT 不会执行“安装完运行应用”那一步。
pub fn launch_installer() -> AppResult<String> {
    let file = last_file()
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| AppError::Other("尚未下载完成，请先下载安装包".into()))?;
    if !file.exists() {
        return Err(AppError::Other("安装包已被删除，请重新下载".into()));
    }
    if !file
        .extension()
        .map(|ext| ext.eq_ignore_ascii_case("exe"))
        .unwrap_or(false)
    {
        return Err(AppError::Other("安装包文件类型非法".into()));
    }
    let app = std::env::current_exe()
        .map_err(|error| AppError::Other(format!("取应用路径失败：{error}")))?;
    spawn_installer(&file, &app)
        .map_err(|error| AppError::Other(format!("拉起安装器失败：{error}")))?;
    Ok(file.to_string_lossy().to_string())
}

#[cfg(windows)]
fn spawn_installer(installer: &Path, app: &Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // PowerShell 只做两件事：等安装器退出、再把应用拉起来。用 -Wait 而不是轮询，
    // 装多久就等多久；安装失败也照样拉起旧版本，总比留下一个"装完没反应"的黑洞好。
    let escape = |path: &Path| path.display().to_string().replace('\'', "''");
    let script = format!(
        "$ErrorActionPreference='SilentlyContinue'; \
         Start-Process -FilePath '{}' -ArgumentList '/SILENT' -Wait; \
         Start-Process -FilePath '{}'",
        escape(installer),
        escape(app)
    );

    // 先试带重启的包装；PowerShell 不可用（被策略禁用、被裁掉）时退回直接启动安装器，
    // 用户需要自己再打开应用——但安装本身不能因此失败。
    let wrapped = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    if wrapped.is_ok() {
        return Ok(());
    }
    std::process::Command::new(installer)
        .arg("/SILENT")
        .spawn()
        .map(|_| ())
}

#[cfg(not(windows))]
fn spawn_installer(installer: &Path, _app: &Path) -> std::io::Result<()> {
    std::process::Command::new(installer)
        .arg("/SILENT")
        .spawn()
        .map(|_| ())
}

pub fn updates_dir(root: &Path) -> PathBuf {
    root.join("updates")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_version_rejects_prerelease_and_noise() {
        assert_eq!(stable_version("v1.6.3").as_deref(), Some("1.6.3"));
        assert_eq!(stable_version("1.6").as_deref(), Some("1.6"));
        assert_eq!(stable_version("v1.7.0-rc1"), None);
        assert_eq!(stable_version("v1.7.0+build5"), None);
        assert_eq!(stable_version("nightly"), None);
        assert_eq!(stable_version("v1"), None);
    }

    #[test]
    fn compare_versions_orders_numerically() {
        assert_eq!(compare_versions("1.6.10", "1.6.9"), 1);
        assert_eq!(compare_versions("v1.6.3", "1.6.3"), 0);
        assert_eq!(compare_versions("1.6", "1.6.0"), 0);
        assert_eq!(compare_versions("1.5.9", "1.6.0"), -1);
    }

    #[test]
    fn only_https_github_assets_are_trusted() {
        assert!(allowed_asset(
            "https://github.com/o/r/releases/download/v1/a.exe"
        ));
        assert!(allowed_asset(
            "https://release-assets.githubusercontent.com/x/a.exe"
        ));
        assert!(!allowed_asset("http://github.com/o/r/a.exe"));
        assert!(!allowed_asset("https://evil.example.com/a.exe"));
        assert!(!allowed_asset("https://notgithub.com/a.exe"));
    }

    #[test]
    fn sha256_is_read_out_of_notes() {
        let notes = "- 附件 a.exe\n- SHA256：`15c18e4444b3f473da67a4b16f7f606ec247a478910a2dc0f3e840b1175fa277`\n";
        assert_eq!(
            sha256_from_notes(notes).as_deref(),
            Some("15c18e4444b3f473da67a4b16f7f606ec247a478910a2dc0f3e840b1175fa277")
        );
        assert_eq!(sha256_from_notes("没有校验值"), None);
    }

    #[test]
    fn proxy_only_accepts_http_and_empty() {
        assert!(proxy_from("").unwrap().is_none());
        assert!(proxy_from("http://127.0.0.1:7890").is_ok());
        assert!(proxy_from("socks5://127.0.0.1:1080").is_err());
        assert!(proxy_from("127.0.0.1:7890").is_err());
    }

    /// 联网冒烟：对着真实仓库走一遍「取列表 → 跳过预发布 → 选附件 → 读 SHA256」。
    /// 默认不跑（会打 GitHub，且依赖已发布的版本）；需要时：
    /// `cargo test -p pm-services -- --ignored check_against_the_real_release`
    #[tokio::test]
    #[ignore = "需要访问 GitHub"]
    async fn check_against_the_real_release() {
        let dir = std::env::temp_dir().join("pm-update-smoke");
        let first = check("0.0.1", &dir, "").await.expect("第一次检查应当成功");
        assert!(first.has_update, "拿 0.0.1 去比应当有更新");
        let url = first.download_url.clone().expect("应当给出下载地址");
        assert!(allowed_asset(&url), "下载地址必须通过域名与协议校验: {url}");
        assert!(
            first.file_name.as_deref().unwrap_or_default().ends_with(".exe"),
            "附件必须是 exe"
        );
        assert!(first.size.unwrap_or(0) > 1024 * 1024, "安装包大小不合理");
        assert!(
            dir.join(CACHE_FILE).exists(),
            "第一次检查应当落下 ETag 缓存"
        );

        // 第二次必须命中缓存（304 或 200 都行），重点是不报错、结果一致
        let second = check("0.0.1", &dir, "").await.expect("第二次检查应当成功");
        assert_eq!(first.latest_version, second.latest_version);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 联网冒烟（下载链路）：真的把安装包下下来，验证续传/校验/落盘整条路。
    /// `cargo test -p pm-services -- --ignored download_against_the_real_release`
    #[tokio::test]
    #[ignore = "需要访问 GitHub 并下载约 7 MB"]
    async fn download_against_the_real_release() {
        let dir = std::env::temp_dir().join("pm-update-download-smoke");
        let _ = std::fs::remove_dir_all(&dir);
        let result = check("0.0.1", &dir, "").await.expect("检查应当成功");
        let url = result.download_url.clone().expect("应当给出下载地址");
        let emit: Emit = std::sync::Arc::new(|_: &str, _: serde_json::Value| {});
        // download 内部会核对 SHA256，走到 Ok 就说明校验通过
        let file = download(&url, &dir, "", emit).await.expect("下载应当成功");
        let size = std::fs::metadata(&file).expect("文件应当存在").len();
        assert_eq!(Some(size as i64), result.size, "落盘大小应与发行版声明一致");
        assert!(
            !std::path::Path::new(&format!("{file}.part")).exists(),
            "成功后不应留下 .part"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
