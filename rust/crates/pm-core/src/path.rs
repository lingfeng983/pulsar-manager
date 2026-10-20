use url::Url;

use crate::error::{AppError, AppResult};
use crate::model::AdminConfig;

const HTTP_PORTS: (u16, u16) = (6650, 8080);
const HTTPS_PORTS: (u16, u16) = (6651, 8443);

/// 解码 Admin API 基地址。
///
/// 两条规则与 TS 版逐字对齐：
/// 1. 显式 `webServiceUrl` 永远优先，但 TLS 开启时它必须是 https——否则 Bearer 凭据
///    会明文出网；
/// 2. 否则把二进制口映射到 HTTP 口（6650→8080 / 6651→8443），不能把 6650 原样当
///    Admin 地址用——那是「地址明明填对了，测试连接就是失败」的根因。
pub fn resolve_base_url(config: &AdminConfig) -> AppResult<String> {
    if let Some(web) = config.web_service_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if config.tls_enabled && !web.to_ascii_lowercase().starts_with("https://") {
            return Err(AppError::config(format!(
                "TLS 已开启，但 Admin API 地址不是 HTTPS（{web}）。请改用 https:// 地址或关闭 TLS。"
            )));
        }
        return Ok(web.trim_end_matches('/').to_string());
    }

    let raw = config.service_url.trim();
    let mapped = raw
        .replacen("pulsar+ssl://", "https://", 1)
        .replacen("ssl://", "https://", 1)
        .replacen("pulsar://", "http://", 1);

    let is_https = mapped.starts_with("https://");
    if !is_https && !mapped.starts_with("http://") {
        // 不是 http(s)，端口无从谈起：交回给调用方，让请求自然失败并保留原始地址
        return Ok(mapped.trim_end_matches('/').to_string());
    }
    if config.tls_enabled && !is_https {
        return Err(AppError::config(format!(
            "TLS 已开启，但解析出的 Admin API 地址不是 HTTPS（{mapped}）。\
             请把 Admin API 地址填成 https:// 或把 serviceUrl 写成 pulsar+ssl://。"
        )));
    }

    let (broker_port, admin_port) = if is_https { HTTPS_PORTS } else { HTTP_PORTS };
    let Ok(mut url) = Url::parse(&mapped) else {
        return Ok(mapped.trim_end_matches('/').to_string());
    };
    let port = url.port();
    if port.is_none() || port == Some(broker_port) {
        let _ = url.set_port(Some(admin_port));
    }
    Ok(url.to_string().trim_end_matches('/').to_string())
}

/// 把单个路径段编码成不可越界的形态（`/`、`..`、空格、`#` 都必须被转义）。
pub fn seg(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TopicPath {
    pub tenant: String,
    pub namespace: String,
    pub topic: String,
    pub persistent: bool,
}

impl TopicPath {
    /// 解析 `persistent://t/ns/topic`、`non-persistent://t/ns/topic` 或 `t/ns/topic`。
    /// topic 段允许再含 `/`，所以只切前两段。
    pub fn parse(input: &str) -> AppResult<Self> {
        let trimmed = input.trim();
        let (persistent, rest) = if let Some(rest) = trimmed.strip_prefix("persistent://") {
            (true, rest)
        } else if let Some(rest) = trimmed.strip_prefix("non-persistent://") {
            (false, rest)
        } else {
            (true, trimmed)
        };
        let mut parts = rest.splitn(3, '/');
        let tenant = parts.next().unwrap_or_default();
        let namespace = parts.next().unwrap_or_default();
        let topic = parts.next().unwrap_or_default();
        if tenant.is_empty() || namespace.is_empty() || topic.is_empty() {
            return Err(AppError::config(format!(
                "topic 路径不合法：{input}（应形如 tenant/namespace/topic）"
            )));
        }
        Ok(Self {
            tenant: tenant.to_string(),
            namespace: namespace.to_string(),
            topic: topic.to_string(),
            persistent,
        })
    }

    pub fn kind(&self) -> &'static str {
        if self.persistent {
            "persistent"
        } else {
            "non-persistent"
        }
    }

    pub fn short_name(&self) -> &str {
        self.topic.rsplit('/').next().unwrap_or(&self.topic)
    }

    /// `/admin/v2/persistent/t/ns/topic`
    pub fn admin_base(&self) -> String {
        format!(
            "/admin/v2/{}/{}/{}/{}",
            self.kind(),
            seg(&self.tenant),
            seg(&self.namespace),
            seg(&self.topic)
        )
    }

    /// `tenant/ns/topic`
    pub fn name(&self) -> String {
        format!("{}/{}/{}", self.tenant, self.namespace, self.topic)
    }

    pub fn uri(&self) -> String {
        format!("{}://{}", self.kind(), self.name())
    }
}

/// 命名空间路径的编码与折叠。
pub fn namespace_admin_base(tenant: &str, namespace: &str) -> String {
    format!("/admin/v2/namespaces/{}/{}", seg(tenant), seg(namespace))
}

/// `tenant/ns` -> `(tenant, ns)`；ns 可能本身就带 `/`（Pulsar 允许 v2 命名空间分段）。
pub fn split_namespace(full: &str) -> (String, String) {
    let mut parts = full.splitn(2, '/');
    let tenant = parts.next().unwrap_or_default().to_string();
    let namespace = parts.next().unwrap_or_default().to_string();
    (tenant, namespace)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(service: &str, web: Option<&str>, tls: bool) -> AdminConfig {
        AdminConfig {
            service_url: service.into(),
            web_service_url: web.map(str::to_string),
            tls_enabled: tls,
            ..Default::default()
        }
    }

    #[test]
    fn maps_broker_port_to_admin_port() {
        let base = resolve_base_url(&cfg("pulsar://host:6650", None, false)).unwrap();
        assert_eq!(base, "http://host:8080");
    }

    #[test]
    fn maps_ssl_service_url_to_https() {
        let base = resolve_base_url(&cfg("pulsar+ssl://host:6651", None, true)).unwrap();
        assert_eq!(base, "https://host:8443");
    }

    #[test]
    fn explicit_web_url_wins() {
        let base = resolve_base_url(&cfg("pulsar://host:6650", Some("http://admin:8080/"), false)).unwrap();
        assert_eq!(base, "http://admin:8080");
    }

    #[test]
    fn tls_rejects_plain_http_web_url() {
        assert!(resolve_base_url(&cfg("pulsar://host:6650", Some("http://admin:8080"), true)).is_err());
    }

    #[test]
    fn parses_topic_path() {
        let path = TopicPath::parse("persistent://public/default/my-topic").unwrap();
        assert_eq!(path.tenant, "public");
        assert_eq!(path.short_name(), "my-topic");
        assert_eq!(path.admin_base(), "/admin/v2/persistent/public/default/my-topic");
    }

    #[test]
    fn encodes_reserved_segment_chars() {
        assert_eq!(seg("a/b c"), "a%2Fb%20c");
    }
}
