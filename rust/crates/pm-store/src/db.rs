use std::path::{Path, PathBuf};
use std::sync::Mutex;

use pm_core::{AppError, AppResult};
use rusqlite::Connection;

use crate::schema::{COLUMN_PATCHES, SCHEMA_SQL, SCHEMA_VERSION};

/// SQLite 句柄。`Connection` 是 Send 但不是 Sync，用 Mutex 串行化后即可在
/// 多线程命令处理里共享——管理工具的写入频率远低于「连接建立」的成本。
pub struct Store {
    conn: Mutex<Connection>,
    path: PathBuf,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> AppResult<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(&path).map_err(|e| AppError::Storage(format!("打开数据库失败: {e}")))?;
        Self::configure(&conn)?;
        Self::init(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path,
        })
    }

    /// 自测用：内存库跑同一套 DDL。
    pub fn open_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        Self::configure(&conn)?;
        Self::init(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: PathBuf::from(":memory:"),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn configure(conn: &Connection) -> AppResult<()> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        // WAL 让读写不互相阻塞；内存库上设置失败无妨
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Ok(())
    }

    fn init(conn: &Connection) -> AppResult<()> {
        conn.execute_batch(SCHEMA_SQL)
            .map_err(|e| AppError::Storage(format!("初始化数据库结构失败: {e}")))?;

        for (table, column, decl) in COLUMN_PATCHES {
            if !column_exists(conn, table, column)? {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"))
                    .map_err(|e| AppError::Storage(format!("升级列 {table}.{column} 失败: {e}")))?;
            }
        }

        let current: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if current != SCHEMA_VERSION {
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        Ok(())
    }

    pub(crate) fn with<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let guard = self
            .conn
            .lock()
            .map_err(|_| AppError::Storage("数据库锁被污染".into()))?;
        f(&guard)
    }
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> AppResult<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 默认库路径：`%APPDATA%\pulsar-manager\pulsar-manager.db`，与 Electron 版
/// `app.getPath('userData')` 同目录，切换版本后能直接读到原来的集群与模板。
pub fn default_db_path() -> PathBuf {
    if let Ok(explicit) = std::env::var("PULSAR_MANAGER_DB") {
        return PathBuf::from(explicit);
    }
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("HOME").map(|home| PathBuf::from(home).join(".config")))
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("pulsar-manager").join("pulsar-manager.db")
}

pub(crate) fn flag(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_is_idempotent() {
        let store = Store::open_in_memory().unwrap();
        // 再跑一遍基线不该报错（这是每次启动都会发生的事）
        store
            .with(|conn| {
                conn.execute_batch(SCHEMA_SQL)?;
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn defaults_are_seeded_once() {
        let store = Store::open_in_memory().unwrap();
        let theme = crate::settings::get(&store, "theme").unwrap();
        assert_eq!(theme.as_deref(), Some("light"));
    }
}
