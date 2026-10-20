//! Pulsar 访问层：Admin REST + 原生二进制协议。
//!
//! 分层与 TS 版一致：`AdminClient` 是薄门面，资源 / 指标 / 策略各自一组端点；
//! 服务层不直接拼 URL，也不接触 reqwest。

pub mod client;
pub mod metrics;
pub mod native;
pub mod policies;
pub mod resource;

pub use client::{condense_error, AdminClient};
pub use native::{NativeClient, NativeConsumer};
pub use resource::{collapse_topic_uris, short_topic_name, topic_base};
