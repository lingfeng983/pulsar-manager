use pm_core::{AppError, AppResult, AppSettings};
use rusqlite::params;

use crate::db::Store;

pub fn get(store: &Store, key: &str) -> AppResult<Option<String>> {
    store.with(|conn| {
        let mut stmt = conn.prepare("SELECT value FROM user_settings WHERE key = ?1")?;
        let value = stmt.query_row([key], |row| row.get::<_, String>(0)).ok();
        Ok(value)
    })
}

pub fn set(store: &Store, key: &str, value: &str) -> AppResult<()> {
    store.with(|conn| {
        conn.execute(
            "INSERT INTO user_settings (key, value, updated_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, pm_core::now_iso()],
        )?;
        Ok(())
    })
}

pub fn all(store: &Store) -> AppResult<AppSettings> {
    let mut settings = AppSettings::default();
    store.with(|conn| {
        let mut stmt = conn.prepare("SELECT key, value FROM user_settings")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let key: String = row.get(0)?;
            let value: String = row.get(1)?;
            match key.as_str() {
                "theme" => settings.theme = value,
                "truncateLength" => settings.truncate_length = value.parse().unwrap_or(50),
                "autoRefresh" => settings.auto_refresh = value != "false",
                "refreshIntervalSeconds" => settings.refresh_interval_seconds = value.parse().unwrap_or(30),
                "fontSize" => settings.font_size = value,
                _ => {}
            }
        }
        Ok(())
    })?;
    if settings.refresh_interval_seconds <= 0 {
        return Err(AppError::config("刷新间隔必须大于 0 秒"));
    }
    Ok(settings)
}

/// 快捷键方案以 `key='shortcuts'` 的原始 JSON 存在设置表里（与 TS 版一致）。
pub fn get_raw(store: &Store, key: &str) -> AppResult<Option<String>> {
    get(store, key)
}

/// 原样读出整张设置表。TS 版的 `config:getAll` 是按「默认值 + 库里的覆盖」拼的，
/// 这里需要拿到全部原始键值才能做同样的合并。
pub fn raw_all(store: &Store) -> AppResult<std::collections::BTreeMap<String, String>> {
    store.with(|conn| {
        let mut stmt = conn.prepare("SELECT key, value FROM user_settings")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut map = std::collections::BTreeMap::new();
        for row in rows {
            let (key, value) = row?;
            map.insert(key, value);
        }
        Ok(map)
    })
}
