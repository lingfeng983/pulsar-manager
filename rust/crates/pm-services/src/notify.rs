//! 通知派发：先做「该不该发」的纯判定，再按渠道类型拼请求体。
//!
//! 判定与派发分开是为了让「没订阅 / 低于级别线 / 渠道关着」这三种情况
//! 能被界面解释清楚，而不是只看到一个 0 字节的 200。

use std::time::Duration;

use base64::Engine;
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

    let mut payload = build_payload(kind, notification)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms.clamp(500, 60_000) as u64))
        .build()
        .map_err(|e| AppError::Network(format!("初始化通知客户端失败: {e}")))?;
    let secret = secret.filter(|value| !value.is_empty());
    let now_ms = pm_core::now_ms();
    let mut request = client.post(url);
    match (kind, secret) {
        ("dingtalk", Some(secret)) => {
            request = request.query(&[
                ("timestamp", now_ms.to_string()),
                ("sign", dingtalk_sign(secret, now_ms)),
            ]);
        }
        ("feishu" | "lark", Some(secret)) => {
            let seconds = now_ms / 1000;
            payload["timestamp"] = serde_json::Value::String(seconds.to_string());
            payload["sign"] = serde_json::Value::String(feishu_sign(secret, seconds));
        }
        (_, Some(secret)) => request = request.header("X-Webhook-Secret", secret),
        (_, None) => {}
    }
    // reqwest 的错误文本带完整 URL，而机器人的 access_token / hook key 就在 URL 里
    let response = request
        .json(&payload)
        .send()
        .await
        .map_err(|e| AppError::Network(format!("通知发送失败: {}", e.without_url())))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AppError::Http {
            status: status.as_u16(),
            message: pm_pulsar::condense_error(&text),
        });
    }
    check_reply(kind, &text).map_err(AppError::Other)
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    const BLOCK: usize = 64;
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|byte| byte ^ 0x36));
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(block.map(|byte| byte ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

/// 钉钉加签：key=secret，message=`毫秒时间戳\nsecret`，放在 URL 的 timestamp/sign 参数里。
fn dingtalk_sign(secret: &str, timestamp_ms: i64) -> String {
    let message = format!("{timestamp_ms}\n{secret}");
    base64::engine::general_purpose::STANDARD
        .encode(hmac_sha256(secret.as_bytes(), message.as_bytes()))
}

/// 飞书加签：key=`秒级时间戳\nsecret`，message 为空，放在请求体的 timestamp/sign 字段里。
fn feishu_sign(secret: &str, timestamp_s: i64) -> String {
    let key = format!("{timestamp_s}\n{secret}");
    base64::engine::general_purpose::STANDARD.encode(hmac_sha256(key.as_bytes(), b""))
}

/// 机器人接口把「关键词不符 / 签名不对 / 地址失效」放在 HTTP 200 的响应体里。
fn check_reply(kind: &str, body: &str) -> Result<(), String> {
    let fields: &[(&str, &str)] = match kind {
        "dingtalk" | "wecom" | "wechat" => &[("errcode", "errmsg")],
        "feishu" | "lark" => &[("code", "msg"), ("StatusCode", "StatusMessage")],
        _ => return Ok(()),
    };
    let Ok(reply) = serde_json::from_str::<serde_json::Value>(body) else {
        return Ok(());
    };
    for (code_key, message_key) in fields {
        if let Some(code) = reply.get(*code_key).and_then(serde_json::Value::as_i64) {
            if code == 0 {
                return Ok(());
            }
            let message = reply
                .get(*message_key)
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            return Err(format!("机器人拒收（{code_key} {code}）：{message}"));
        }
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
        "slack" => serde_json::json!({
            "text": format!("*{}*\n{}", notification.title, notification.body),
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

    fn sample() -> Notification {
        Notification {
            title: "告警：x".into(),
            level: "crit".into(),
            body: "b".into(),
            event_kind: "alertFired".into(),
        }
    }

    #[test]
    fn hmac_matches_rfc4231_case_2() {
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            hex::encode(mac),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    /// 参考值由 Node `crypto.createHmac` 按两家文档的算法独立算出
    #[test]
    fn signatures_match_vendor_algorithms() {
        assert_eq!(
            dingtalk_sign("SECtest", 1_700_000_000_000),
            "aZLLrriXgn05YbwaGR7knYsLeJADjr9NwLaNNKpxh4g="
        );
        assert_eq!(
            feishu_sign("SECtest", 1_700_000_000),
            "G7XpBpG8NgG02fJOAhX6FRAObIljmFoxVReo8I62pEk="
        );
    }

    /// 机器人接口对关键词不符、签名不对都回 HTTP 200，真正的结果在响应体里
    #[test]
    fn business_errors_inside_http_200_are_failures() {
        assert!(check_reply("dingtalk", r#"{"errcode":0,"errmsg":"ok"}"#).is_ok());
        let error = check_reply(
            "dingtalk",
            r#"{"errcode":310000,"errmsg":"keywords not in content"}"#,
        )
        .unwrap_err();
        assert!(
            error.contains("310000") && error.contains("keywords"),
            "{error}"
        );
        assert!(check_reply(
            "wecom",
            r#"{"errcode":93000,"errmsg":"invalid webhook url"}"#
        )
        .is_err());
        assert!(check_reply("feishu", r#"{"code":0,"msg":"success"}"#).is_ok());
        assert!(check_reply("feishu", r#"{"StatusCode":0,"StatusMessage":"success"}"#).is_ok());
        assert!(check_reply("feishu", r#"{"code":19021,"msg":"sign match fail"}"#).is_err());
        // 通用 webhook 的响应体格式不归我们管
        assert!(check_reply("generic", r#"{"errcode":1}"#).is_ok());
    }

    /// reqwest 的错误文本自带完整 URL，而机器人的 access_token 就在 URL 里
    #[tokio::test]
    async fn network_errors_do_not_leak_the_webhook_token() {
        let url = "http://127.0.0.1:1/robot/send?access_token=TOPSECRETTOKEN";
        let error = dispatch("dingtalk", url, None, 1000, &sample())
            .await
            .unwrap_err()
            .to_string();
        assert!(!error.contains("TOPSECRETTOKEN"), "{error}");
    }

    async fn capture_one(reply: &'static str) -> (String, tokio::sync::oneshot::Receiver<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut raw = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = socket.read(&mut chunk).await.unwrap();
                raw.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&raw).to_string();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().to_string())
                        })
                        .and_then(|v| v.parse::<usize>().ok())
                        .unwrap_or(0);
                    if body.len() >= length || n == 0 {
                        let _ = tx.send(text);
                        break;
                    }
                }
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                reply.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        });
        (format!("http://{addr}"), rx)
    }

    #[tokio::test]
    async fn dingtalk_signs_in_query_and_reports_errcode() {
        let (base, request) = capture_one(r#"{"errcode":310000,"errmsg":"sign not match"}"#).await;
        let url = format!("{base}/robot/send?access_token=abc");
        let outcome = dispatch("dingtalk", &url, Some("SECtest"), 2000, &sample()).await;
        let request = request.await.unwrap();
        let line = request.lines().next().unwrap();
        assert!(line.contains("access_token=abc"), "{line}");
        assert!(
            line.contains("&timestamp=") && line.contains("&sign="),
            "{line}"
        );
        assert!(outcome.unwrap_err().to_string().contains("310000"));
    }

    #[tokio::test]
    async fn feishu_signs_in_body() {
        let (base, request) = capture_one(r#"{"code":0,"msg":"success"}"#).await;
        let url = format!("{base}/open-apis/bot/v2/hook/abc");
        dispatch("feishu", &url, Some("SECtest"), 2000, &sample())
            .await
            .unwrap();
        let request = request.await.unwrap();
        let body: serde_json::Value =
            serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert!(
            body["timestamp"].as_str().is_some_and(|v| v.len() == 10),
            "{body}"
        );
        assert!(
            body["sign"].as_str().is_some_and(|v| !v.is_empty()),
            "{body}"
        );
    }

    #[test]
    fn slack_has_a_payload_shape() {
        let payload = build_payload("slack", &sample()).unwrap();
        assert!(payload["text"].as_str().unwrap().contains("告警：x"));
    }
}
