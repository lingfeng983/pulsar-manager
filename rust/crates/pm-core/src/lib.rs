//! 领域模型的唯一权威定义（对齐 `src/shared/types.ts`）。
//!
//! 约定与 TS 版保持一致：
//! - 与 broker JSON 打交道的结构体一律 `rename_all = "camelCase"`；
//! - 缺失字段用 `Option`，不用 0/空串冒充「已配置」；
//! - 凭据字段只在 `ClusterDraft` 里以明文出现，落库前必须加密。

pub mod format;
pub mod logging;
pub mod model;
pub mod path;

pub use error::{AppError, AppResult};

mod error;

pub use format::*;
pub use model::*;
pub use path::*;
