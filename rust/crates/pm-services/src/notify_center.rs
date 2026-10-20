//! 通知中心的「配置面」：渠道与邮件服务器的增删改查、列表视图、以及手工测试发送。
//!
//! 与 `notify` 模块的分工：那边只回答「该不该发」并拼请求体，这边管「存什么、显示什么」。
//! 地址与密码出库前一律打码——列表页是会被截图发进值班群的。

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use lettre::message::header::ContentType;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message as MailMessage, Tokio1Executor};
use pm_core::{AppError, AppResult, MailProfile, NotifyChannel, NotifyDelivery};
use pm_store::notify as store;
use pm_store::Store;
use serde::Serialize;
use serde_json::Value;

use crate::crypto::SecretBox;

pub const DEFAULT_TIMEOUT_MS: i64 = 5_000;
pub const DEFAULT_RATE: i64 = 20;

const EVENT_LABELS: [(&str, &str); 6] = [
    ("alertFired", "告警触发"),
    ("alertRecovered", "告警恢复"),
    ("inspectionCrit", "巡检严重项"),
    ("inspectionRecovered", "巡检严重项恢复"),
    ("inspectionFailed", "巡检跑不起来"),
    ("test", "测试消息"),
];

const CHANNEL_KINDS: [&str; 6] = ["generic", "dingtalk", "feishu", "wecom", "slack", "email"];

/// 路由动词：`/cgi-bin/webhook/send?key=…` 里 `send` 是接口名，不是凭据
const ROUTE_WORDS: [&str; 8] = [
    "send", "receive", "push", "post", "update", "create", "delete", "notify",
];

const CREDENTIAL_ANCHORS: [&str; 7] = ["hook", "token", "tokens", "key", "keys", "secret", "webhook"];

fn level_label(level: &str) -> &'static str {
    match level {
        "crit" => "严重",
        "warn" => "关注",
        _ => "提示",
    }
}

fn event_label(kind: &str) -> &'static str {
    EVENT_LABELS
        .iter()
        .find(|(key, _)| *key == kind)
        .map(|(_, label)| *label)
        .unwrap_or("通知")
}

// ========== 列表视图 ==========

#[derive(Debug, Clone, Serialize)]
pub struct ChannelView {
    pub id: String,
    pub name: String,
    pub kind: String,
    /// 打码后的地址，回复里永远不带原文
    pub url: String,
    pub has_secret: bool,
    pub mail_profile_id: Option<String>,
    pub recipients: Vec<String>,
    pub enabled: bool,
    pub events: Vec<String>,
    pub min_level: String,
    pub timeout_ms: i64,
    pub rate_per_minute: i64,
    pub last_sent_at: Option<String>,
    pub last_error: Option<String>,
    pub fail_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MailView {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub security: String,
    pub username: String,
    pub has_password: bool,
    pub from_address: String,
    pub from_name: String,
    pub allow_self_signed: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeliveryOutcome {
    pub channel_id: String,
    pub channel_name: String,
    pub ok: bool,
    pub skipped: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DispatchView {
    pub event: EventSummary,
    pub deliveries: Vec<DeliveryOutcome>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EventSummary {
    pub kind: String,
    pub title: String,
}

pub fn channel_view(record: &NotifyChannel, secrets: &SecretBox) -> ChannelView {
    let plain = secrets
        .decrypt_opt(Some(&record.url_enc))
        .ok()
        .flatten()
        .unwrap_or_default();
    ChannelView {
        id: record.id.clone(),
        name: record.name.clone(),
        kind: record.kind.clone(),
        url: if plain.trim().is_empty() {
            String::new()
        } else {
            mask_notify_url(&plain)
        },
        has_secret: record.secret_enc.as_deref().map(|value| !value.is_empty()).unwrap_or(false),
        mail_profile_id: record.mail_profile_id.clone(),
        recipients: parse_recipients(&record.recipients).0,
        enabled: record.enabled,
        events: record.events.clone(),
        min_level: record.min_level.clone(),
        timeout_ms: record.timeout_ms,
        rate_per_minute: record.rate_per_minute,
        last_sent_at: record.last_sent_at.clone(),
        last_error: record.last_error.clone(),
        fail_count: record.fail_count,
        created_at: record.created_at.clone(),
        updated_at: record.updated_at.clone(),
    }
}

pub fn mail_view(record: &MailProfile) -> MailView {
    MailView {
        id: record.id.clone(),
        name: record.name.clone(),
        host: record.host.clone(),
        port: record.port,
        security: record.security.clone(),
        username: mask_mail_user(&record.username),
        has_password: record.password_enc.as_deref().map(|value| !value.is_empty()).unwrap_or(false),
        from_address: record.from_address.clone(),
        from_name: record.from_name.clone(),
        allow_self_signed: record.allow_self_signed,
        created_at: record.created_at.clone(),
        updated_at: record.updated_at.clone(),
    }
}

pub fn list_channels_view(store_handle: &Store, secrets: &SecretBox) -> AppResult<Vec<ChannelView>> {
    Ok(store::list_channels(store_handle)?
        .iter()
        .map(|record| channel_view(record, secrets))
        .collect())
}

pub fn list_mail_view(store_handle: &Store) -> AppResult<Vec<MailView>> {
    Ok(store::list_mail_profiles(store_handle)?
        .iter()
        .map(mail_view)
        .collect())
}

// ========== 地址与邮箱的打码 / 校验 ==========

fn looks_like_credential(segment: &str) -> bool {
    segment.chars().count() >= 16
        && !segment.contains('.')
        && segment
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn mask_segment(segment: &str) -> String {
    let head: String = segment.chars().take(3).collect();
    format!("{head}***")
}

/// 列表页显示用的地址：凭据打码，其余留着——人得认得出这是哪一条。
pub fn mask_notify_url(url: &str) -> String {
    let (head, query) = match url.split_once('?') {
        Some((head, query)) => (head, Some(query)),
        None => (url, None),
    };
    let mut segments: Vec<String> = head.split('/').map(str::to_string).collect();
    let total = segments.len();
    for index in (0..total).rev() {
        let segment = segments[index].clone();
        if segment.is_empty() {
            continue;
        }
        let anchor = if index > 0 {
            segments[index - 1].to_lowercase()
        } else {
            String::new()
        };
        let after_anchor = CREDENTIAL_ANCHORS.contains(&anchor.as_str())
            && !ROUTE_WORDS.contains(&segment.to_lowercase().as_str());
        if after_anchor || (index == total - 1 && looks_like_credential(&segment)) {
            segments[index] = mask_segment(&segment);
        }
    }
    let path = segments.join("/");
    let Some(query) = query else {
        return path;
    };
    let masked: Vec<String> = query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let key = part.split('=').next().unwrap_or("").to_lowercase();
            let sensitive = ["token", "key", "secret", "sig", "password"]
                .iter()
                .any(|needle| key.contains(needle));
            if sensitive {
                format!("{}=***", part.split('=').next().unwrap_or(""))
            } else {
                part.to_string()
            }
        })
        .collect();
    if masked.is_empty() {
        path
    } else {
        format!("{path}?{}", masked.join("&"))
    }
}

/// 账号打码：邮件地址留前三字符与域名，纯账号名只留两字符。
pub fn mask_mail_user(username: &str) -> String {
    let user = username.trim();
    if user.is_empty() {
        return String::new();
    }
    // 不是邮件地址的用户名（有些企业 SMTP 就填个账号名）按长度打码
    if validate_mail_address(user).is_some() {
        let chars: Vec<char> = user.chars().collect();
        return if chars.len() <= 2 {
            "***".to_string()
        } else {
            format!("{}***", chars[..2].iter().collect::<String>())
        };
    }
    match user.rfind('@') {
        Some(at) => {
            let (name, domain) = user.split_at(at);
            let keep: String = name.chars().take(3.min(name.chars().count())).collect();
            format!("{keep}***{domain}")
        }
        None => user.to_string(),
    }
}

/// 只放 http/https：这类地址将来是直接被发出去的，`file://` 进来的后果与界面提示完全不符。
pub fn validate_notify_url(raw: &str) -> Option<String> {
    let url = raw.trim();
    if url.is_empty() {
        return Some("通知地址不能为空".into());
    }
    if url.chars().count() > 2048 {
        return Some("通知地址过长（上限 2048 字符）".into());
    }
    // 界面能复制到的只有打码后的地址，粘回去会把库里那份真地址覆盖掉
    if url.contains("***") {
        return Some(
            "这里带着打码标记（***）：那是列表页显示用的样子，请填完整地址，否则库里那一份会被覆盖"
                .into(),
        );
    }
    if url.chars().any(char::is_whitespace) {
        return Some("通知地址里不能有空格或换行".into());
    }
    let lower = url.to_lowercase();
    if !lower.starts_with("https://") && !lower.starts_with("http://") {
        return Some("通知地址必须是 http:// 或 https:// 开头".into());
    }
    let without_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or_default();
    let authority = without_scheme.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return Some("通知地址里不要写用户名密码，凭据请放进「签名密钥」或路径里".into());
    }
    if authority.starts_with('[') {
        return None;
    }
    let host = authority.split(':').next().unwrap_or("");
    if !host.contains('.') && !host.eq_ignore_ascii_case("localhost") {
        return Some("通知地址里的主机名看着不完整".into());
    }
    None
}

pub fn resolve_timeout_ms(input: Option<i64>) -> AppResult<i64> {
    match input {
        None => Ok(DEFAULT_TIMEOUT_MS),
        Some(value) if (1000..=30_000).contains(&value) => Ok(value),
        Some(_) => Err(AppError::Other(
            "超时时间必须是 1000～30000 之间的整数毫秒".into(),
        )),
    }
}

pub fn resolve_rate(input: Option<i64>) -> AppResult<i64> {
    match input {
        None => Ok(DEFAULT_RATE),
        Some(value) if (1..=60).contains(&value) => Ok(value),
        Some(_) => Err(AppError::Other("每分钟条数必须是 1～60 之间的整数".into())),
    }
}

pub fn validate_mail_address(raw: &str) -> Option<String> {
    let address = raw.trim();
    if address.is_empty() {
        return Some("邮件地址不能为空".into());
    }
    if address.chars().any(char::is_whitespace) {
        return Some("邮件地址里不能有空格".into());
    }
    let (name, domain) = match address.rsplit_once('@') {
        Some(parts) => parts,
        None => return Some("邮件地址缺少 @".into()),
    };
    if name.is_empty() {
        return Some("邮件地址缺少用户名".into());
    }
    if domain.is_empty() || !domain.contains('.') || domain.starts_with('.') || domain.ends_with('.') {
        return Some("邮件地址的域名看着不完整".into());
    }
    None
}

/// 收件人清单：逗号/分号/空白分隔，去重按小写比较但保留第一次出现的写法。
pub fn parse_recipients(raw: &str) -> (Vec<String>, Vec<String>) {
    let mut valid: Vec<String> = Vec::new();
    let mut invalid: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for part in raw.split([',', ';', ' ', '\t', '\n', '\r']) {
        let address = part.trim();
        if address.is_empty() {
            continue;
        }
        if validate_mail_address(address).is_some() {
            invalid.push(address.to_string());
            continue;
        }
        let key = address.to_lowercase();
        if seen.insert(key) {
            valid.push(address.to_string());
        }
    }
    (valid, invalid)
}

fn recipients_problem(raw: &str) -> Option<String> {
    let (valid, invalid) = parse_recipients(raw);
    if !invalid.is_empty() {
        let head: Vec<&str> = invalid.iter().take(3).map(String::as_str).collect();
        let extra = if invalid.len() > 3 {
            format!(" 等 {} 个", invalid.len())
        } else {
            String::new()
        };
        return Some(format!("这些收件人不像邮件地址：{}{extra}", head.join("、")));
    }
    if valid.is_empty() {
        return Some("邮件渠道至少要填一个收件人".into());
    }
    Some(None).flatten()
}

// ========== 渠道写操作 ==========

pub fn save_channel(store_handle: &Store, secrets: &SecretBox, draft: &Value) -> AppResult<ChannelView> {
    let id = draft.get("id").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let existing = if id.is_empty() {
        None
    } else {
        store::get_channel(store_handle, &id)?
    };
    if !id.is_empty() && existing.is_none() {
        return Err(AppError::Other("这条渠道已经不在了，请刷新列表".into()));
    }

    let name = draft.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err(AppError::Other("渠道名字不能是空的".into()));
    }
    let kind = draft.get("kind").and_then(Value::as_str).unwrap_or("").to_string();
    if !CHANNEL_KINDS.contains(&kind.as_str()) {
        return Err(AppError::Other(format!("未知的通知渠道类型 {kind}")));
    }
    let is_email = kind == "email";

    let url = draft.get("url").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if !url.is_empty() {
        if let Some(problem) = validate_notify_url(&url) {
            return Err(AppError::Other(problem));
        }
    }
    if existing.is_none() && url.is_empty() && !is_email {
        return Err(AppError::Other("新建渠道必须填写通知地址".into()));
    }

    let mut recipients = String::new();
    let mail_profile_id = if is_email {
        let from_draft = draft
            .get("mailProfileId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let profile_id = from_draft.or_else(|| existing.as_ref().and_then(|item| item.mail_profile_id.clone()));
        let Some(profile_id) = profile_id else {
            return Err(AppError::Other("新建邮件渠道要先选一台邮件服务器".into()));
        };
        let profiles = store::list_mail_profiles(store_handle)?;
        if !profiles.iter().any(|profile| profile.id == profile_id) {
            return Err(AppError::Other("这台邮件服务器已经不在了，请重新选一台".into()));
        }
        let raw = draft
            .get("recipients")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| existing.as_ref().map(|item| item.recipients.clone()))
            .unwrap_or_default();
        if let Some(problem) = recipients_problem(&raw) {
            return Err(AppError::Other(problem));
        }
        recipients = raw.trim().to_string();
        Some(profile_id)
    } else {
        None
    };

    let events = match draft.get("events").and_then(Value::as_array) {
        Some(items) => items
            .iter()
            .filter_map(Value::as_str)
            .filter(|value| EVENT_LABELS.iter().any(|(key, _)| key == value))
            .map(str::to_string)
            .collect(),
        None => existing.as_ref().map(|item| item.events.clone()).unwrap_or_default(),
    };

    let secret = draft.get("secret").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let keeps_secret = matches!(kind.as_str(), "dingtalk" | "feishu" | "wecom" | "slack" | "generic");
    let secret_enc = if keeps_secret {
        if secret.is_empty() {
            existing.as_ref().and_then(|item| item.secret_enc.clone())
        } else {
            Some(secrets.encrypt(&secret)?)
        }
    } else {
        None
    };

    let timeout_ms = resolve_timeout_ms(draft.get("timeoutMs").and_then(Value::as_i64))?;
    let rate_per_minute = resolve_rate(draft.get("ratePerMinute").and_then(Value::as_i64))?;
    let min_level = draft
        .get("minLevel")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| matches!(value.as_str(), "info" | "warn" | "crit"))
        .or_else(|| existing.as_ref().map(|item| item.min_level.clone()))
        .unwrap_or_else(|| "warn".to_string());

    let record = NotifyChannel {
        id,
        name,
        kind,
        // 地址留空 = 沿用库里那一份；邮件渠道本来就只存服务器与收件人
        url_enc: if url.is_empty() {
            existing.as_ref().map(|item| item.url_enc.clone()).unwrap_or_default()
        } else {
            secrets.encrypt(&url)?
        },
        secret_enc,
        mail_profile_id,
        recipients,
        enabled: draft
            .get("enabled")
            .and_then(Value::as_bool)
            .or_else(|| existing.as_ref().map(|item| item.enabled))
            .unwrap_or(true),
        events,
        min_level,
        timeout_ms,
        rate_per_minute,
        // 这四格是运行结果，保存配置不该动它们
        last_sent_at: existing.as_ref().and_then(|item| item.last_sent_at.clone()),
        last_error: existing.as_ref().and_then(|item| item.last_error.clone()),
        fail_count: existing.as_ref().map(|item| item.fail_count).unwrap_or(0),
        created_at: existing.as_ref().map(|item| item.created_at.clone()).unwrap_or_default(),
        updated_at: String::new(),
    };

    let saved_id = store::save_channel(store_handle, &record)?;
    let saved = store::get_channel(store_handle, &saved_id)?
        .ok_or_else(|| AppError::Other("保存后读不回这条渠道".into()))?;
    Ok(channel_view(&saved, secrets))
}

pub fn remove_channel(store_handle: &Store, id: &str) -> AppResult<bool> {
    if id.trim().is_empty() {
        return Err(AppError::Other("缺少渠道 id".into()));
    }
    store::delete_channel(store_handle, id)?;
    Ok(true)
}

pub fn set_enabled(store_handle: &Store, id: &str, enabled: bool) -> AppResult<bool> {
    let Some(mut record) = store::get_channel(store_handle, id)? else {
        return Err(AppError::Other("这条渠道已经不在了，请刷新列表".into()));
    };
    record.enabled = enabled;
    store::save_channel(store_handle, &record)?;
    Ok(true)
}

// ========== 邮件服务器写操作 ==========

pub fn save_mail(store_handle: &Store, secrets: &SecretBox, draft: &Value) -> AppResult<MailView> {
    let id = draft.get("id").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let existing = if id.is_empty() {
        None
    } else {
        store::list_mail_profiles(store_handle)?
            .into_iter()
            .find(|profile| profile.id == id)
    };
    if !id.is_empty() && existing.is_none() {
        return Err(AppError::Other("这台邮件服务器已经不在了，请刷新列表".into()));
    }

    let name = draft.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err(AppError::Other("服务器名字不能是空的".into()));
    }
    let clash = store::list_mail_profiles(store_handle)?
        .into_iter()
        .any(|profile| profile.name == name && profile.id != id);
    if clash {
        return Err(AppError::Other(format!("已经有同名的一台邮件服务器了：{name}")));
    }

    let host = draft.get("host").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if host.is_empty() {
        return Err(AppError::Other("邮件服务器地址不能为空".into()));
    }
    let port = draft.get("port").and_then(Value::as_i64).unwrap_or(0);
    if !(1..=65_535).contains(&port) {
        return Err(AppError::Other("端口必须是 1～65535 之间的整数".into()));
    }
    let security = draft
        .get("security")
        .and_then(Value::as_str)
        .unwrap_or("starttls")
        .to_string();
    if !matches!(security.as_str(), "plain" | "starttls" | "tls") {
        return Err(AppError::Other(format!("未知的加密方式 {security}")));
    }
    let from_address = draft
        .get("fromAddress")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if let Some(problem) = validate_mail_address(&from_address) {
        return Err(AppError::Other(format!("发件地址：{problem}")));
    }

    // undefined 与空串含义不同：前者是「沿用」，后者才是明确的「不登录」
    let username = match draft.get("username") {
        Some(Value::Null) | None => existing.as_ref().map(|item| item.username.clone()).unwrap_or_default(),
        Some(value) => value.as_str().unwrap_or("").trim().to_string(),
    };
    if username.chars().any(char::is_whitespace) || username.contains(',') {
        return Err(AppError::Other("用户名里不能有空格或逗号".into()));
    }
    let password = draft.get("password").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let password_enc = if password.is_empty() {
        if username.is_empty() {
            // 账号清空就把密码一起丢：留着它下次填回用户名会拿一个没人记得的旧密码去试
            None
        } else {
            existing.as_ref().and_then(|item| item.password_enc.clone())
        }
    } else {
        Some(secrets.encrypt(&password)?)
    };

    let record = MailProfile {
        id,
        name,
        host,
        port,
        security,
        username,
        password_enc,
        from_address,
        from_name: draft
            .get("fromName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        allow_self_signed: draft
            .get("allowSelfSigned")
            .and_then(Value::as_bool)
            .or_else(|| existing.as_ref().map(|item| item.allow_self_signed))
            .unwrap_or(false),
        created_at: existing.as_ref().map(|item| item.created_at.clone()).unwrap_or_default(),
        updated_at: String::new(),
    };
    let saved_id = store::save_mail_profile(store_handle, &record)?;
    let saved = store::list_mail_profiles(store_handle)?
        .into_iter()
        .find(|profile| profile.id == saved_id)
        .ok_or_else(|| AppError::Other("保存后读不回这台服务器".into()))?;
    Ok(mail_view(&saved))
}

pub fn remove_mail(store_handle: &Store, id: &str) -> AppResult<(bool, i64)> {
    let using = store::list_channels(store_handle)?
        .iter()
        .filter(|channel| channel.mail_profile_id.as_deref() == Some(id))
        .count() as i64;
    store::delete_mail_profile(store_handle, id)?;
    Ok((true, using))
}

// ========== 手工测试 ==========

fn test_event() -> (String, String, String, String) {
    (
        "test".to_string(),
        "info".to_string(),
        "pulsar-manager 测试通知".to_string(),
        "这是一条测试消息。收到它就说明这个地址现在通、这个机器人愿意收。".to_string(),
    )
}

fn format_notify_time(at_ms: i64) -> String {
    match chrono::DateTime::from_timestamp_millis(at_ms) {
        Some(moment) => moment.format("%Y-%m-%d %H:%M:%SZ").to_string(),
        None => "时间未知".to_string(),
    }
}

fn truncate_to_bytes(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let suffix = "\n…（正文过长，已截断）";
    let budget = max_bytes.saturating_sub(suffix.len());
    let mut out = String::new();
    for ch in text.chars() {
        if out.len() + ch.len_utf8() > budget {
            break;
        }
        out.push(ch);
    }
    if budget == 0 {
        out
    } else {
        format!("{out}{suffix}")
    }
}

fn render_text(kind: &str, level: &str, title: &str, body: &str, cluster: &str, at_ms: i64) -> String {
    let head = if title.trim().is_empty() {
        event_label(kind)
    } else {
        title.trim()
    };
    let mut lines = vec![head.to_string()];
    if !body.trim().is_empty() && body.trim() != head {
        lines.push(body.trim().to_string());
    }
    let scope = if cluster.trim().is_empty() {
        String::new()
    } else {
        format!("｜集群：{}", cluster.trim())
    };
    lines.push(format!(
        "{}｜{}{scope}",
        event_label(kind),
        level_label(level)
    ));
    lines.push(format!("时间：{}", format_notify_time(at_ms)));
    truncate_to_bytes(&lines.join("\n\n"), 4096)
}

fn build_subject(level: &str, title: &str) -> String {
    let head = if title.trim().is_empty() {
        "Pulsar 通知"
    } else {
        title.trim()
    };
    let subject = format!("[pulsar-manager·{}] {head}", level_label(level));
    if subject.chars().count() > 200 {
        let clamped: String = subject.chars().take(199).collect();
        format!("{clamped}…")
    } else {
        subject
    }
}

struct MailTarget {
    record: MailProfile,
    password: Option<String>,
}

fn resolve_mail(store_handle: &Store, secrets: &SecretBox, profile_id: Option<&str>) -> Result<MailTarget, String> {
    let Some(profile_id) = profile_id.filter(|value| !value.is_empty()) else {
        return Err("这条邮件渠道还没选邮件服务器".into());
    };
    let record = store::list_mail_profiles(store_handle)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "这台邮件服务器已经不在了（渠道还指着它）".to_string())?;
    let password = match record.password_enc.as_deref() {
        Some(cipher) => match secrets.decrypt(cipher) {
            Ok(plain) => Some(plain),
            Err(_) => {
                return Err("密码读不出来：本机密钥库可能不可用，重新填一次密码即可恢复".into());
            }
        },
        None => None,
    };
    Ok(MailTarget { record, password })
}

fn mail_from(record: &MailProfile) -> String {
    let name = record.from_name.replace(['<', '>', '"', '\\'], "");
    let name = name.trim();
    if name.is_empty() {
        record.from_address.trim().to_string()
    } else {
        format!("{name} <{}>", record.from_address.trim())
    }
}

/// 一台服务器发一封。不重试、不排队：进程一退队列即丢，「稍后补发」是兑现不了的承诺。
async fn send_mail(
    target: &MailTarget,
    to: &[String],
    subject: &str,
    text: &str,
    timeout_ms: i64,
) -> (bool, String) {
    let record = &target.record;
    let timeout = Duration::from_millis(timeout_ms.clamp(1_000, 60_000) as u64);
    let mut builder = match record.security.as_str() {
        "tls" => match AsyncSmtpTransport::<Tokio1Executor>::relay(&record.host) {
            Ok(builder) => builder,
            Err(error) => return (false, format!("{}服务器地址不可用：{error}", record.host)),
        },
        "starttls" => match AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&record.host) {
            Ok(builder) => builder,
            Err(error) => return (false, format!("{}服务器地址不可用：{error}", record.host)),
        },
        _ => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&record.host),
    };
    builder = builder.port(record.port as u16).timeout(Some(timeout));

    if record.allow_self_signed && record.security != "plain" {
        match lettre::transport::smtp::client::TlsParameters::builder(record.host.clone())
            .dangerous_accept_invalid_certs(true)
            .build()
        {
            Ok(params) => {
                builder = builder.tls(if record.security == "tls" {
                    lettre::transport::smtp::client::Tls::Wrapper(params)
                } else {
                    lettre::transport::smtp::client::Tls::Required(params)
                })
            }
            Err(error) => return (false, format!("自签证书配置不可用：{error}")),
        }
    }
    if !record.username.is_empty() {
        builder = builder.credentials(Credentials::new(
            record.username.clone(),
            target.password.clone().unwrap_or_default(),
        ));
    }
    let transport = builder.build();

    let mut message = MailMessage::builder()
        .header(ContentType::TEXT_PLAIN);
    match mail_from(record).parse() {
        Ok(from) => message = message.from(from),
        Err(error) => return (false, format!("发件地址拼不出来：{error}")),
    }
    for address in to {
        match address.parse() {
            Ok(mailbox) => message = message.to(mailbox),
            Err(error) => return (false, format!("收件人 {address} 不是合法邮箱：{error}")),
        }
    }
    let message = match message.subject(subject).body(text.to_string()) {
        Ok(message) => message,
        Err(error) => return (false, format!("邮件组装失败：{error}")),
    };

    match transport.send(message).await {
        Ok(response) => {
            let note = response.message().collect::<Vec<_>>().join(" ");
            let note = note.trim();
            let note: String = note.chars().take(120).collect();
            let suffix = if note.is_empty() {
                String::new()
            } else {
                format!("，{note}")
            };
            (
                true,
                format!("已送出（{}:{}{suffix}）", record.host, record.port),
            )
        }
        Err(error) => (false, classify_mail_failure(&error.to_string())),
    }
}

/// 把一次 SMTP 失败写成照得做的句子：失败原因几乎全在服务器那句回话里。
fn classify_mail_failure(raw: &str) -> String {
    let text = raw.to_lowercase();
    let hint = if text.contains("535") || text.contains("authentication") || text.contains("auth") {
        "登录被拒：检查用户名与密码（很多邮箱要用「授权码」而不是登录密码）"
    } else if text.contains("550") || text.contains("551") || text.contains("553") {
        "服务器拒收：收件人不存在或被策略拦下"
    } else if text.contains("enotfound") || text.contains("dns") || text.contains("getaddrinfo") {
        "域名解析不了：检查服务器地址是否写错"
    } else if text.contains("refused") {
        "连接被拒绝：这个端口上没在监听"
    } else if text.contains("timed out") || text.contains("timeout") {
        "超时：网络到不了这台服务器，或端口被墙"
    } else if text.contains("cert") || text.contains("self signed") || text.contains("x509") {
        "证书校验没过：内网自签证书需要勾上「允许自签名」"
    } else {
        return format!("发送失败：{}", truncate_to_bytes(raw, 300));
    };
    format!("{hint}（{}）", truncate_to_bytes(raw, 200))
}

fn record_delivery(store_handle: &Store, channel: &NotifyChannel, level: &str, ok: bool, skipped: bool, message: &str) {
    let delivery = NotifyDelivery {
        id: 0,
        channel_id: channel.id.clone(),
        channel_name: channel.name.clone(),
        event_kind: "test".into(),
        level: level.into(),
        ok,
        skipped,
        message: message.into(),
        created_at: pm_core::now_iso(),
    };
    // 投递表少一行比整批渠道不发要好：这一路的失败只影响审计，不影响结论
    let _ = store::record_delivery(store_handle, &delivery);
}

/// 「发送测试」：只发这一条渠道，并绕开订阅、级别与限流——点它要问的是「现在通不通」。
pub async fn test_channel(store_handle: &Store, secrets: &SecretBox, id: &str) -> AppResult<DispatchView> {
    let Some(channel) = store::get_channel(store_handle, id)? else {
        return Err(AppError::Other("这条渠道已经不在了，请刷新列表".into()));
    };
    let (kind, level, title, body) = test_event();
    let outcome = if channel.kind == "email" {
        match resolve_mail(store_handle, secrets, channel.mail_profile_id.as_deref()) {
            Err(problem) => (false, problem),
            Ok(target) => {
                let (valid, invalid) = parse_recipients(&channel.recipients);
                if !invalid.is_empty() || valid.is_empty() {
                    (
                        false,
                        recipients_problem(&channel.recipients).unwrap_or_else(|| "收件人清单为空".into()),
                    )
                } else {
                    let text = render_text(&kind, &level, &title, &body, "", pm_core::now_ms());
                    let subject = build_subject(&level, &title);
                    send_mail(&target, &valid, &subject, &text, channel.timeout_ms).await
                }
            }
        }
    } else {
        let url = secrets
            .decrypt_opt(Some(&channel.url_enc))
            .ok()
            .flatten()
            .unwrap_or_default();
        let secret = channel
            .secret_enc
            .as_deref()
            .and_then(|cipher| secrets.decrypt(cipher).ok());
        let notification = super::notify::Notification {
            title: title.clone(),
            level: level.clone(),
            body: body.clone(),
            event_kind: kind.clone(),
        };
        match super::notify::dispatch(
            &channel.kind,
            &url,
            secret.as_deref(),
            channel.timeout_ms,
            &notification,
        )
        .await
        {
            Ok(()) => (true, format!("已送出（{}）", mask_notify_url(&url))),
            Err(error) => (false, error.to_string()),
        }
    };

    record_delivery(store_handle, &channel, &level, outcome.0, false, &outcome.1);
    Ok(DispatchView {
        event: EventSummary { kind, title },
        deliveries: vec![DeliveryOutcome {
            channel_id: channel.id.clone(),
            channel_name: channel.name.clone(),
            ok: outcome.0,
            skipped: false,
            message: outcome.1,
        }],
    })
}

pub async fn test_mail(
    store_handle: &Store,
    secrets: &SecretBox,
    id: &str,
    to: Option<&str>,
) -> AppResult<(bool, String)> {
    let target = resolve_mail(store_handle, secrets, Some(id)).map_err(AppError::Other)?;
    let destination = match to.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => {
            if let Some(problem) = validate_mail_address(value) {
                return Err(AppError::Other(format!("测试收件人：{problem}")));
            }
            value.to_string()
        }
        None => target.record.from_address.clone(),
    };
    let (kind, level, title, body) = test_event();
    let text = render_text(&kind, &level, &title, &body, "", pm_core::now_ms());
    let subject = build_subject(&level, &title);
    // 手动测试值得多等一会儿：SMTP 要过 DNS、握手、登录三段
    let (ok, message) = send_mail(&target, &[destination], &subject, &text, 20_000).await;
    Ok((ok, message))
}

// ========== 事件派发 ==========

/// 一条待派发的事件。字段用 String 而不是借用：派发是异步的，
/// 调用方常常在 await 前就把上下文丢掉了。
pub struct NotifyInput {
    /// alertFired / alertRecovered / inspectionCrit / inspectionRecovered / inspectionFailed
    pub kind: String,
    pub level: String,
    pub title: String,
    pub text: String,
    pub cluster_name: String,
    pub at_ms: i64,
}

impl NotifyInput {
    pub fn new(
        kind: impl Into<String>,
        level: impl Into<String>,
        title: impl Into<String>,
        text: impl Into<String>,
        cluster_name: impl Into<String>,
        at_ms: i64,
    ) -> Self {
        Self {
            kind: kind.into(),
            level: level.into(),
            title: title.into(),
            text: text.into(),
            cluster_name: cluster_name.into(),
            at_ms,
        }
    }
}

/// 每条渠道最近一次投递的时间戳（毫秒），用于按分钟限流。
fn recent_sends() -> &'static std::sync::Mutex<HashMap<String, Vec<i64>>> {
    static RECENT: std::sync::OnceLock<std::sync::Mutex<HashMap<String, Vec<i64>>>> =
        std::sync::OnceLock::new();
    RECENT.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn rate_limited(channel_id: &str, per_minute: i64, now_ms: i64) -> bool {
    if per_minute <= 0 {
        return false;
    }
    let mut map = recent_sends()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let stamps = map.entry(channel_id.to_string()).or_default();
    stamps.retain(|at| now_ms - *at < 60_000);
    stamps.len() as i64 >= per_minute
}

fn remember_send(channel_id: &str, now_ms: i64) {
    let mut map = recent_sends()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    map.entry(channel_id.to_string())
        .or_default()
        .push(now_ms);
}

/// 把一条事件派给全部渠道：该不该发由渠道自己的订阅清单与级别线决定，
/// 发不出去也要写一条投递记录——「静默没通知」是最难查的故障。
pub async fn dispatch_event(
    store_handle: &Store,
    secrets: &SecretBox,
    input: &NotifyInput,
) -> Vec<DeliveryOutcome> {
    let channels = match store::list_channels(store_handle) {
        Ok(channels) => channels,
        Err(_) => return Vec::new(),
    };
    let body = render_text(
        &input.kind,
        &input.level,
        &input.title,
        &input.text,
        &input.cluster_name,
        input.at_ms,
    );
    let mut outcomes = Vec::new();

    for channel in channels {
        let decision = super::notify::decide(&channel, &input.level, &input.kind);
        if let Err(reason) = decision {
            let delivery = NotifyDelivery {
                id: 0,
                channel_id: channel.id.clone(),
                channel_name: channel.name.clone(),
                event_kind: input.kind.clone(),
                level: input.level.clone(),
                ok: false,
                skipped: true,
                message: reason,
                created_at: pm_core::now_iso(),
            };
            let _ = store::record_delivery(store_handle, &delivery);
            continue;
        }
        if rate_limited(&channel.id, channel.rate_per_minute, input.at_ms) {
            let delivery = NotifyDelivery {
                id: 0,
                channel_id: channel.id.clone(),
                channel_name: channel.name.clone(),
                event_kind: input.kind.clone(),
                level: input.level.clone(),
                ok: false,
                skipped: true,
                message: format!("已限流（每分钟最多 {} 条）", channel.rate_per_minute),
                created_at: pm_core::now_iso(),
            };
            let _ = store::record_delivery(store_handle, &delivery);
            continue;
        }

        let outcome = if channel.kind == "email" {
            send_channel_mail(store_handle, secrets, &channel, &body).await
        } else {
            let url = secrets
                .decrypt_opt(Some(&channel.url_enc))
                .ok()
                .flatten()
                .unwrap_or_default();
            let secret = channel
                .secret_enc
                .as_deref()
                .and_then(|cipher| secrets.decrypt(cipher).ok());
            let notification = super::notify::Notification {
                title: input.title.to_string(),
                level: input.level.to_string(),
                body: body.clone(),
                event_kind: input.kind.to_string(),
            };
            match super::notify::dispatch(
                &channel.kind,
                &url,
                secret.as_deref(),
                channel.timeout_ms,
                &notification,
            )
            .await
            {
                Ok(()) => (true, format!("已送出（{}）", mask_notify_url(&url))),
                Err(error) => (false, error.to_string()),
            }
        };

        if outcome.0 {
            remember_send(&channel.id, input.at_ms);
        }
        // 运行结果回写到渠道行：界面的「上次发送 / 失败次数」靠这三个字段
        let mut updated = channel.clone();
        updated.fail_count = if outcome.0 { 0 } else { channel.fail_count + 1 };
        updated.last_error = if outcome.0 { None } else { Some(outcome.1.clone()) };
        updated.last_sent_at = if outcome.0 {
            Some(iso_from_ms(input.at_ms))
        } else {
            channel.last_sent_at.clone()
        };
        let _ = store::save_channel(store_handle, &updated);

        let delivery = NotifyDelivery {
            id: 0,
            channel_id: channel.id.clone(),
            channel_name: channel.name.clone(),
            event_kind: input.kind.clone(),
            level: input.level.clone(),
            ok: outcome.0,
            skipped: false,
            message: outcome.1.clone(),
            created_at: pm_core::now_iso(),
        };
        let _ = store::record_delivery(store_handle, &delivery);
        outcomes.push(DeliveryOutcome {
            channel_id: channel.id,
            channel_name: channel.name,
            ok: outcome.0,
            skipped: false,
            message: outcome.1,
        });
    }

    outcomes
}

async fn send_channel_mail(
    store_handle: &Store,
    secrets: &SecretBox,
    channel: &NotifyChannel,
    body: &str,
) -> (bool, String) {
    match resolve_mail(store_handle, secrets, channel.mail_profile_id.as_deref()) {
        Err(problem) => (false, problem),
        Ok(target) => {
            let (valid, invalid) = parse_recipients(&channel.recipients);
            if !invalid.is_empty() || valid.is_empty() {
                return (
                    false,
                    recipients_problem(&channel.recipients).unwrap_or_else(|| "收件人清单为空".into()),
                );
            }
            let subject = build_subject(&channel.min_level, &channel.name);
            send_mail(&target, &valid, &subject, body, channel.timeout_ms).await
        }
    }
}

fn iso_from_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(pm_core::now_iso)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_credential_segments_and_query() {
        let url = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef123456";
        assert_eq!(
            mask_notify_url(url),
            "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=***"
        );
        // 路径里的凭据（飞书 hook token）也要挡
        let feishu = "https://open.feishu.cn/open-apis/bot/v2/hook/aaaaaaaa-bbbb";
        assert!(mask_notify_url(feishu).contains("aaa***"));
    }

    #[test]
    fn rejects_untrusted_schemes_and_credentials_in_url() {
        assert!(validate_notify_url("file:///etc/passwd").is_some());
        assert!(validate_notify_url("http://user:pass@host.com/x").is_some());
        assert!(validate_notify_url("http://localhost:8080/x").is_none());
        assert!(validate_notify_url("https://hooks.example.com/a/b").is_none());
        // 列表页复制回来的打码地址不能落库
        assert!(validate_notify_url("https://qyapi.weixin.qq.com/x?key=***").is_some());
    }

    #[test]
    fn masks_and_parses_recipients() {
        assert_eq!(mask_mail_user("ops@corp.com"), "ops***@corp.com");
        assert_eq!(mask_mail_user("ab"), "***");
        let (valid, invalid) = parse_recipients("ops@corp.com, bad, OPS@corp.com");
        assert_eq!(valid, vec!["ops@corp.com".to_string()]);
        assert_eq!(invalid, vec!["bad".to_string()]);
    }

    #[test]
    fn timeouts_and_rates_are_rejected_out_of_range() {
        assert_eq!(resolve_timeout_ms(None).unwrap(), DEFAULT_TIMEOUT_MS);
        assert!(resolve_timeout_ms(Some(999)).is_err());
        assert_eq!(resolve_rate(Some(60)).unwrap(), 60);
        assert!(resolve_rate(Some(61)).is_err());
    }
}
