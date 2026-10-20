use pm_core::{AppResult, MailProfile, NotifyChannel, NotifyDelivery};
use rusqlite::{params, OptionalExtension};

use crate::db::{flag, Store};

fn map_channel(row: &rusqlite::Row<'_>) -> rusqlite::Result<NotifyChannel> {
    let events_json: String = row.get(9)?;
    Ok(NotifyChannel {
        id: row.get(0)?,
        name: row.get(1)?,
        kind: row.get(2)?,
        url_enc: row.get(3)?,
        secret_enc: row.get(4)?,
        mail_profile_id: row.get(5)?,
        recipients: row.get(6)?,
        enabled: row.get::<_, i64>(7)? != 0,
        events: serde_json::from_str(&events_json).unwrap_or_default(),
        min_level: row.get(8)?,
        timeout_ms: row.get(10)?,
        rate_per_minute: row.get(11)?,
        last_sent_at: row.get(12)?,
        last_error: row.get(13)?,
        fail_count: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

const CHANNEL_COLUMNS: &str = "id, name, kind, url_enc, secret_enc, mail_profile_id, recipients, enabled, \
     min_level, events_json, timeout_ms, rate_per_minute, last_sent_at, last_error, fail_count, \
     created_at, updated_at";

pub fn list_channels(store: &Store) -> AppResult<Vec<NotifyChannel>> {
    store.with(|conn| {
        let mut stmt = conn.prepare(&format!(
            "SELECT {CHANNEL_COLUMNS} FROM notify_channels ORDER BY name COLLATE NOCASE"
        ))?;
        let rows = stmt.query_map([], map_channel)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

pub fn get_channel(store: &Store, id: &str) -> AppResult<Option<NotifyChannel>> {
    store.with(|conn| {
        Ok(conn
            .query_row(
                &format!("SELECT {CHANNEL_COLUMNS} FROM notify_channels WHERE id = ?1"),
                [id],
                map_channel,
            )
            .optional()?)
    })
}

pub fn save_channel(store: &Store, channel: &NotifyChannel) -> AppResult<String> {
    let id = if channel.id.is_empty() {
        pm_core::new_id()
    } else {
        channel.id.clone()
    };
    let events = serde_json::to_string(&channel.events)?;
    let now = pm_core::now_iso();
    store.with(|conn| {
        conn.execute(
            "INSERT INTO notify_channels (id, name, kind, url_enc, secret_enc, mail_profile_id, recipients, \
             enabled, min_level, events_json, timeout_ms, rate_per_minute, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14) \
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, \
             url_enc = excluded.url_enc, secret_enc = excluded.secret_enc, \
             mail_profile_id = excluded.mail_profile_id, recipients = excluded.recipients, \
             enabled = excluded.enabled, min_level = excluded.min_level, events_json = excluded.events_json, \
             timeout_ms = excluded.timeout_ms, rate_per_minute = excluded.rate_per_minute, \
             updated_at = excluded.updated_at",
            params![
                id,
                channel.name,
                channel.kind,
                channel.url_enc,
                channel.secret_enc,
                channel.mail_profile_id,
                channel.recipients,
                flag(channel.enabled),
                channel.min_level,
                events,
                channel.timeout_ms,
                channel.rate_per_minute,
                if channel.created_at.is_empty() {
                    now.clone()
                } else {
                    channel.created_at.clone()
                },
                now,
            ],
        )?;
        Ok(())
    })?;
    Ok(id)
}

pub fn delete_channel(store: &Store, id: &str) -> AppResult<()> {
    store.with(|conn| {
        conn.execute("DELETE FROM notify_channels WHERE id = ?1", [id])?;
        Ok(())
    })
}

pub fn record_delivery(store: &Store, delivery: &NotifyDelivery) -> AppResult<()> {
    store.with(|conn| {
        conn.execute(
            "INSERT INTO notify_deliveries (channel_id, channel_name, event_kind, level, ok, skipped, \
             message, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                delivery.channel_id,
                delivery.channel_name,
                delivery.event_kind,
                delivery.level,
                flag(delivery.ok),
                flag(delivery.skipped),
                delivery.message,
                delivery.created_at,
            ],
        )?;
        // 只留最近 5 条 per channel：这张表是唯一随告警频率一直长的表
        conn.execute(
            "DELETE FROM notify_deliveries WHERE channel_id = ?1 AND id NOT IN \
             (SELECT id FROM notify_deliveries WHERE channel_id = ?1 ORDER BY id DESC LIMIT 5)",
            [delivery.channel_id.as_str()],
        )?;
        Ok(())
    })
}

pub fn deliveries(store: &Store, limit: i64) -> AppResult<Vec<NotifyDelivery>> {
    store.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, channel_id, channel_name, event_kind, level, ok, skipped, message, created_at \
             FROM notify_deliveries ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit.max(1)], |row| {
            Ok(NotifyDelivery {
                id: row.get(0)?,
                channel_id: row.get(1)?,
                channel_name: row.get(2)?,
                event_kind: row.get(3)?,
                level: row.get(4)?,
                ok: row.get::<_, i64>(5)? != 0,
                skipped: row.get::<_, i64>(6)? != 0,
                message: row.get(7)?,
                created_at: row.get(8)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

fn map_mail(row: &rusqlite::Row<'_>) -> rusqlite::Result<MailProfile> {
    Ok(MailProfile {
        id: row.get(0)?,
        name: row.get(1)?,
        host: row.get(2)?,
        port: row.get(3)?,
        security: row.get(4)?,
        username: row.get(5)?,
        password_enc: row.get(6)?,
        from_address: row.get(7)?,
        from_name: row.get(8)?,
        allow_self_signed: row.get::<_, i64>(9)? != 0,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

pub fn list_mail_profiles(store: &Store) -> AppResult<Vec<MailProfile>> {
    store.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, host, port, security, username, password_enc, from_address, from_name, \
             allow_self_signed, created_at, updated_at FROM notify_mail_profiles ORDER BY name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], map_mail)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

pub fn save_mail_profile(store: &Store, profile: &MailProfile) -> AppResult<String> {
    let id = if profile.id.is_empty() {
        pm_core::new_id()
    } else {
        profile.id.clone()
    };
    let now = pm_core::now_iso();
    store.with(|conn| {
        conn.execute(
            "INSERT INTO notify_mail_profiles (id, name, host, port, security, username, password_enc, \
             from_address, from_name, allow_self_signed, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, host = excluded.host, port = excluded.port, \
             security = excluded.security, username = excluded.username, password_enc = excluded.password_enc, \
             from_address = excluded.from_address, from_name = excluded.from_name, \
             allow_self_signed = excluded.allow_self_signed, updated_at = excluded.updated_at",
            params![
                id,
                profile.name,
                profile.host,
                profile.port,
                profile.security,
                profile.username,
                profile.password_enc,
                profile.from_address,
                profile.from_name,
                flag(profile.allow_self_signed),
                if profile.created_at.is_empty() {
                    now.clone()
                } else {
                    profile.created_at.clone()
                },
                now,
            ],
        )?;
        Ok(())
    })?;
    Ok(id)
}

pub fn delete_mail_profile(store: &Store, id: &str) -> AppResult<()> {
    store.with(|conn| {
        conn.execute("DELETE FROM notify_mail_profiles WHERE id = ?1", [id])?;
        Ok(())
    })
}
