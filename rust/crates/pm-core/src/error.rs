use serde::{Deserialize, Serialize};

/// 应用统一错误。IPC/命令层的 `code` 用于让界面对特定失败做出反应，
/// 而不是靠匹配文案（如冲突时让人重试没有意义，要先看清冲突在哪）。
#[derive(Debug, Clone, thiserror::Error, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AppError {
    #[error("资源不存在: {0}")]
    NotFound(String),
    #[error("HTTP {status}: {message}")]
    Http { status: u16, message: String },
    #[error("网络错误: {0}")]
    Network(String),
    #[error("数据库错误: {0}")]
    Storage(String),
    #[error("配置错误: {0}")]
    Config(String),
    #[error("认证失败: {0}")]
    Auth(String),
    #[error("尚未实现: {0}")]
    Unsupported(String),
    #[error("{0}")]
    Other(String),
}

impl AppError {
    pub fn other(message: impl Into<String>) -> Self {
        Self::Other(message.into())
    }

    pub fn config(message: impl Into<String>) -> Self {
        Self::Config(message.into())
    }

    /// 机器可读的错误标识，对应 TS 侧 `APIResponse.code`。
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "NOT_FOUND",
            Self::Auth(_) => "AUTH_FAILED",
            Self::Unsupported(_) => "UNSUPPORTED",
            Self::Http { status, .. } => match status {
                401 | 403 => "AUTH_FAILED",
                404 => "NOT_FOUND",
                409 => "CONFLICT",
                _ => "HTTP_ERROR",
            },
            _ => "ERROR",
        }
    }

    pub fn is_not_found(&self) -> bool {
        matches!(self, Self::NotFound(_)) || matches!(self, Self::Http { status: 404, .. })
    }
}

#[cfg(feature = "sqlite")]
impl From<rusqlite::Error> for AppError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Storage(value.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        Self::Other(format!("JSON 解析失败: {value}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        Self::Other(format!("IO 错误: {value}"))
    }
}

pub type AppResult<T> = Result<T, AppError>;
