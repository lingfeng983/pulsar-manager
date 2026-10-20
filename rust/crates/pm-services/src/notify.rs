//! 通知派发：先做「该不该发」的纯判定，再按渠道类型拼请求体。
//!
//! 判定与派发分开是为了让「没订阅 / 低于级别线 / 渠道关着」这三种情况
//! 能被界面解释清楚，而不是只看到一个 0 字节的 200。

use std::time::Duration;

use pm_core::{AppError, AppResult, NotifyChannel};

#[derive(Debug, Clone)]
pub struct Notification {
    pub title: String,
    pub level: String,
    pub body: String,
    pub event_kind: String,
}

/// 渠道 -> 是否投递。返回 `Err(理由)` 表示「按规则不该发」，调用方据此写投递记录。
pub fn decide(channel: &NotifyChannel, level: &str, event_kind: &str) -> Result<(), String> {
    if !channel.enabled {
        return Err("渠道已关闭".into());
    }
    if !channel.events.is_empty() && !channel.events.iter().any(|event| event == event_kind) {
        return Err(format!("未订阅事件 {event_kind}"));
    }
    let threshold = level_rank(&channel.min_level);
    if level_rank(level) < threshold {
        return Err(format!("级别 {level} 低于渠道门槛 {}", channel.min_level));
    }
    Ok(())
}

fn level_rank(level: &str) -> u8 {
    match level {
        "crit" | "critical" => 2,
        "warn" | "warning" => 1,
        _ => 0,
    }
}

pub async fn dispatch(
    kind: &str,
    url: &str,
    secret: Option<&str>,
    timeout_ms: i64,
    notification: &Notification,
) -> AppResult<()> {
    if matches!(kind, "email" | "mail") {
        return Err(AppError::Unsupported(
            "邮件渠道需要 SMTP 服务器配置，当前 Rust 版尚未接入（可用 Webhook 渠道代替）".into(),
        ));
    }
    if url.trim().is_empty() {
        return Err(AppError::config("渠道地址为空"));
    }

    let payload = build_payload(kind, notification)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms.clamp(500, 60_000) as u64))
        .build()
        .map_err(|e| AppError::Network(format!("初始化通知客户端失败: {e}")))?;
    let mut request = client.post(url).json(&payload);
    if let Some(secret) = secret.filter(|value| !value.is_empty()) {
        request = request.header("X-Webhook-Secret", secret);
    }
    let response = request
        .send()
        .await
        .map_err(|e| AppError::Network(format!("通知发送失败: {e}")))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(AppError::Http {
            status: status.as_u16(),
            message: pm_pulsar::condense_error(&text),
        });
    }
    Ok(())
}

fn build_payload(kind: &str, notification: &Notification) -> AppResult<serde_json::Value> {
    let markdown = format!(
        "### {}\n\n**级别**：{}\n\n{}\n",
        notification.title, notification.level, notification.body
    );
    Ok(match kind {
        "wecom" | "wechat" => serde_json::json!({
            "msgtype": "markdown",
            "markdown": {"content": markdown},
        }),
        "dingtalk" => serde_json::json!({
            "msgtype": "markdown",
            "markdown": {"title": notification.title, "text": markdown},
        }),
        "feishu" | "lark" => serde_json::json!({
            "msg_type": "text",
            "content": {"text": format!("{}\n{}", notification.title, notification.body)},
        }),
        "webhook" | "generic" | "" => serde_json::json!({
            "title": notification.title,
            "level": notification.level,
            "body": notification.body,
            "event": notification.event_kind,
        }),
        other => return Err(AppError::Unsupported(format!("未知通知渠道类型 {other}"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_gate_blocks_lower_levels() {
        let channel = NotifyChannel {
            enabled: true,
            min_level: "crit".into(),
            ..Default::default()
        };
        assert!(decide(&channel, "crit", "alert").is_ok());
        assert!(decide(&channel, "warn", "alert").is_err());
    }

    #[test]
    fn disabled_channel_is_explained() {
        let channel = NotifyChannel {
            enabled: false,
            ..Default::default()
        };
        assert_eq!(decide(&channel, "crit", "alert").unwrap_err(), "渠道已关闭");
    }

    #[test]
    fn wecom_uses_markdown_shape() {
        let payload = build_payload(
            "wecom",
            &Notification {
                title: "t".into(),
                level: "crit".into(),
                body: "b".into(),
                event_kind: "alert".into(),
            },
        )
        .unwrap();
        assert_eq!(payload["msgtype"], "markdown");
    }
}
