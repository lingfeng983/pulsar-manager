//! 检查更新 → 下载安装包 → 拉起安装器。
//!
//! 分发源是公开仓库的发行版附件：检查与下载都匿名可读，唯一的门槛是发行说明里那行
//! `SHA256：<64 位十六进制>`——没有它就不许下载，下载完对不上就不许安装。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use pm_core::{AppError, AppResult};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::messaging::Emit;

const API_BASE: &str = "https://api.github.com";
const OWNER: &str = "lingfeng983";
const REPO: &str = "pulsar-manager";
/// 安装包上限 512MB：谎报 Content-Length 的响应不能把磁盘写满
const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;

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

#[derive(Debug, Clone)]
struct Pending {
    url: String,
    file_name: String,
    sha256: String,
}

fn pending() -> &'static Mutex<Option<Pending>> {
    static PENDING: OnceLock<Mutex<Option<Pending>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(None))
}

fn last_file() -> &'static Mutex<Option<PathBuf>> {
    static FILE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    FILE.get_or_init(|| Mutex::new(None))
}

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

fn sha256_from_notes(notes: &str) -> Option<String> {
    // 发行说明里固定带一行 `- SHA256：\`<64 位>\``
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

/// 只信任 GitHub 的附件地址：不能拿发行说明里的任意 URL 去下载并执行。
/// 下载会跟随 302 跳到 `*.githubusercontent.com`，这里把两类域名都放行。
fn allowed_asset(url: &str) -> bool {
    match url::Url::parse(url) {
        Ok(parsed) => match parsed.host_str() {
            Some(host) => {
                let host = host.to_lowercase();
                host == "github.com"
                    || host.ends_with(".github.com")
                    || host == "githubusercontent.com"
                    || host.ends_with(".githubusercontent.com")
            }
            None => false,
        },
        Err(_) => false,
    }
}

fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(concat!("pulsar-manager-rust/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| AppError::Network(format!("初始化更新客户端失败: {e}")))
}

pub async fn check(current_version: &str, watermark: &str) -> AppResult<UpdateCheck> {
    let client = client()?;
    let releases: serde_json::Value = client
        .get(format!("{API_BASE}/repos/{OWNER}/{REPO}/releases?per_page=100"))
        .header("X-PM-Client", watermark)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| AppError::Network(format!("检查更新失败: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::Network(format!("更新源不可读: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Other(format!("解析发行版列表失败: {e}")))?;

    let items = releases.as_array().cloned().unwrap_or_default();
    if items.is_empty() {
        return Err(AppError::Other("仓库里还没有任何发行版".into()));
    }
    // 不依赖 API 的排序约定：直接取版本号最大的 tag
    let latest = items
        .iter()
        .filter(|item| item.get("tag_name").and_then(serde_json::Value::as_str).is_some())
        .max_by(|a, b| {
            let left = a.get("tag_name").and_then(serde_json::Value::as_str).unwrap_or("0");
            let right = b.get("tag_name").and_then(serde_json::Value::as_str).unwrap_or("0");
            compare_versions(left, right).cmp(&0)
        })
        .ok_or_else(|| AppError::Other("最新发行版缺少 tag".into()))?;

    let tag = latest
        .get("tag_name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let latest_version = tag.trim_start_matches('v').to_string();
    let notes = latest
        .get("body")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let release_name = latest
        .get("name")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(tag)
        .to_string();

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
    let attachments = latest
        .get("assets")
        .cloned()
        .unwrap_or(serde_json::Value::Array(Vec::new()));

    let mut candidates: Vec<(String, i64, String, bool)> = attachments
        .as_array()
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
    let (file_name, size, url, _) = candidates
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Other(format!("最新版本 {latest_version} 没有可下载的 exe 安装包附件")))?;
    if !allowed_asset(&url) {
        return Err(AppError::Other("发行版附件地址不是受信任的 GitHub 域名".into()));
    }
    let sha256 = sha256_from_notes(&notes).ok_or_else(|| {
        AppError::Other("该发行版的说明里没有 SHA256，无法校验安装包，请让发布方补上 SHA256 行后重新发布".into())
    })?;

    *pending().lock().unwrap() = Some(Pending {
        url: url.clone(),
        file_name: file_name.clone(),
        sha256,
    });
    result.download_url = Some(url);
    result.file_name = Some(file_name);
    result.size = Some(size);
    Ok(result)
}

/// 下载：进度按 `update:progress` 推，落盘前校验 SHA256，对不上就不改名。
pub async fn download(url: &str, dir: &Path, emit: Emit) -> AppResult<String> {
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

    let client = client()?;
    let mut response = client
        .get(&target_info.url)
        .send()
        .await
        .map_err(|e| AppError::Network(format!("下载安装包失败: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::Network(format!("下载安装包失败: {e}")))?;
    let total = response.content_length().unwrap_or(0);
    if total > MAX_DOWNLOAD_BYTES {
        return Err(AppError::Other("安装包超过 512MB 上限，已中止下载".into()));
    }

    let mut file = tokio::fs::File::create(&part_path)
        .await
        .map_err(|e| AppError::Other(format!("无法写入安装包：{e}")))?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(error) => {
                let _ = tokio::fs::remove_file(&part_path).await;
                emit(
                    "update:progress",
                    serde_json::json!({"received": received, "total": total, "error": error.to_string()}),
                );
                return Err(AppError::Network(format!("下载中断: {error}")));
            }
        };
        received += chunk.len() as u64;
        if received > MAX_DOWNLOAD_BYTES {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(AppError::Other("安装包超过 512MB 上限，已中止下载".into()));
        }
        hasher.update(&chunk);
        use tokio::io::AsyncWriteExt;
        if let Err(error) = file.write_all(&chunk).await {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(AppError::Other(format!("写入安装包失败：{error}")));
        }
        if last_emit.elapsed() >= Duration::from_millis(200) {
            last_emit = std::time::Instant::now();
            emit(
                "update:progress",
                serde_json::json!({"received": received, "total": total}),
            );
        }
    }
    use tokio::io::AsyncWriteExt;
    let _ = file.flush().await;
    drop(file);

    if total > 0 && received != total {
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(AppError::Other(format!("下载不完整（{received}/{total} 字节）")));
    }
    let actual = hex::encode(hasher.finalize());
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
        serde_json::json!({"received": received, "total": total, "done": true}),
    );
    Ok(final_path.to_string_lossy().to_string())
}

/// 拉起安装器：NSIS 支持 /SILENT，静默覆盖安装。
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
    std::process::Command::new(&file)
        .arg("/SILENT")
        .spawn()
        .map_err(|e| AppError::Other(format!("拉起安装器失败：{e}")))?;
    Ok(file.to_string_lossy().to_string())
}

pub fn updates_dir(root: &Path) -> PathBuf {
    root.join("updates")
}
