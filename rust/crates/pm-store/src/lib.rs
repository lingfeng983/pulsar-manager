//! SQLite 持久层。DDL 与既有 Electron 版逐表对齐，老库可直接打开。

pub mod alerts;
pub mod clusters;
pub mod consumer_configs;
pub mod db;
pub mod history;
pub mod inspections;
pub mod logs;
pub mod metrics;
pub mod notify;
pub mod schema;
pub mod settings;
pub mod templates;

pub use db::{default_db_path, default_log_dir, Store};
