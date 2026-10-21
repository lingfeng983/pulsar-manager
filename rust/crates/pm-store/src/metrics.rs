use pm_core::{AppResult, MetricsPoint};
use rusqlite::params;

use crate::db::Store;

/// 同一毫秒同一作用域的重复采样直接丢弃（唯一索引已兜住，这里只是不报错）。
pub fn insert(store: &Store, point: &MetricsPoint) -> AppResult<()> {
    store.with(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO metrics_snapshots (cluster_id, topic_uri, msg_rate_in, msg_rate_out, \
             throughput_in, throughput_out, backlog, producers, consumers, captured_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                point.cluster_id,
                point.topic_uri,
                point.msg_rate_in,
                point.msg_rate_out,
                point.throughput_in,
                point.throughput_out,
                point.backlog,
                point.producers,
                point.consumers,
                point.captured_at,
            ],
        )?;
        Ok(())
    })
}

/// 取时间范围内最近 N 条（升序，便于直接画折线）。
///
/// 先按 DESC 取窗口内最新的 N 条，再反转；直接用 ASC+LIMIT 会拿到窗口最前面
/// 的 N 条，保留 7 天、限 2000 点时当前时段永远画不出来。
pub fn series(
    store: &Store,
    cluster_id: &str,
    topic_uri: &str,
    from_ms: i64,
    limit: i64,
) -> AppResult<Vec<MetricsPoint>> {
    store.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT cluster_id, topic_uri, msg_rate_in, msg_rate_out, throughput_in, throughput_out, \
             backlog, producers, consumers, captured_at FROM metrics_snapshots \
             WHERE cluster_id = ?1 AND topic_uri = ?2 AND captured_at >= ?3 \
             ORDER BY captured_at DESC LIMIT ?4",
        )?;
        let rows = stmt.query_map(params![cluster_id, topic_uri, from_ms, limit.max(1)], |row| {
            Ok(MetricsPoint {
                cluster_id: row.get(0)?,
                topic_uri: row.get(1)?,
                msg_rate_in: row.get(2)?,
                msg_rate_out: row.get(3)?,
                throughput_in: row.get(4)?,
                throughput_out: row.get(5)?,
                backlog: row.get(6)?,
                producers: row.get(7)?,
                consumers: row.get(8)?,
                captured_at: row.get(9)?,
            })
        })?;
        let mut points = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        points.reverse();
        Ok(points)
    })
}

pub fn latest(store: &Store, cluster_id: &str, topic_uri: &str) -> AppResult<Option<MetricsPoint>> {
    store.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT cluster_id, topic_uri, msg_rate_in, msg_rate_out, throughput_in, throughput_out, \
             backlog, producers, consumers, captured_at FROM metrics_snapshots \
             WHERE cluster_id = ?1 AND topic_uri = ?2 ORDER BY captured_at DESC LIMIT 1",
        )?;
        let point = stmt
            .query_row(params![cluster_id, topic_uri], |row| {
                Ok(MetricsPoint {
                    cluster_id: row.get(0)?,
                    topic_uri: row.get(1)?,
                    msg_rate_in: row.get(2)?,
                    msg_rate_out: row.get(3)?,
                    throughput_in: row.get(4)?,
                    throughput_out: row.get(5)?,
                    backlog: row.get(6)?,
                    producers: row.get(7)?,
                    consumers: row.get(8)?,
                    captured_at: row.get(9)?,
                })
            })
            .ok();
        Ok(point)
    })
}

/// 只保留最近 N 天：这张表随轮询一直增长，不裁剪迟早把库撑大。
pub fn prune(store: &Store, keep_days: i64) -> AppResult<usize> {
    let cutoff = pm_core::now_ms() - keep_days.max(1) * 24 * 3600 * 1000;
    store.with(|conn| {
        let removed = conn.execute(
            "DELETE FROM metrics_snapshots WHERE captured_at < ?1",
            [cutoff],
        )?;
        Ok(removed)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn series_keeps_the_latest_points_and_returns_ascending() {
        let store = Store::open_in_memory().unwrap();
        crate::clusters::insert(
            &store,
            &pm_core::Cluster {
                id: "c1".into(),
                name: "local".into(),
                service_url: "pulsar://127.0.0.1:6650".into(),
                admin_api_timeout: 5000,
                status: "connected".into(),
                created_at: pm_core::now_iso(),
                updated_at: pm_core::now_iso(),
                ..Default::default()
            },
        )
        .unwrap();
        for captured_at in 1..=5 {
            insert(
                &store,
                &MetricsPoint {
                    cluster_id: "c1".into(),
                    topic_uri: String::new(),
                    captured_at,
                    ..Default::default()
                },
            )
            .unwrap();
        }
        let points = series(&store, "c1", "", 0, 3).unwrap();
        let captured: Vec<i64> = points.iter().map(|point| point.captured_at).collect();
        assert_eq!(captured, vec![3, 4, 5]);
    }
}
