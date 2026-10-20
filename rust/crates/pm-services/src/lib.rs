//! 业务服务层：集群装配、加密、模板、巡检、告警、通知。
//! 这一层不依赖任何 GUI 类型，自测可以不启动窗口。

pub mod alerts;
pub mod cluster;
pub mod crypto;
pub mod inspection;
pub mod inspection_fleet;
pub mod messaging;
pub mod notify;
pub mod notify_center;
pub mod plugins;
pub mod producer;
pub mod template;
pub mod tunnel;
pub mod update;

pub use cluster::AppContext;
