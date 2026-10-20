//! 集群巡检的 RPC：跑、历史、详情、清空、口径、定时、跨集群汇总。
//!
//! 手动与定时走同一条执行序列（`execute`），否则定时那份报告会少掉环比、导出文本
//! 或抄进去的口径。

use std::collections::BTreeSet;

use pm_core::{AppResult, InspectionSchedule};
use pm_services::inspection::{self, AlertRow, InspectionRequest};
use serde_json::{json, Value};

use crate::bridge::{blocking, fail, emit, ok, Shared};

const HISTORY_LIST_LIMIT: i64 = 50;
const HISTORY_KEEP: i64 = 30;
const FLEET_RUN_MAX_CLUSTERS: i64 = 20;
const DEFAULT_INTERVAL_MINUTES: i64 = 360;
const MIN_INTERVAL: i64 = 30;
const MAX_INTERVAL: i64 = 10_080;

pub async fn dispatch(context: Shared, method: &str, args: Vec<Value>) -> Option<Value> {
    let params = args.first().cloned().unwrap_or_else(|| json!({}));
    Some(match method {
        "inspection:run" => run_once(context, &params, "manual").await,
        "inspection:history" => {
            let cluster = text(&params, "clusterId");
            let limit = params.get("limit").and_then(Value::as_i64).unwrap_or(HISTORY_LIST_LIMIT);
            let context = context.clone();
            blocking(move || {
                let rows = pm_store::inspections::list(&context.store, Some(&cluster), limit)?;
                Ok::<_, pm_core::AppError>(
                    rows.iter()
                        .map(|report| {
                            json!({
                                "id": report.id,
                                "clusterId": report.cluster_id,
                                "clusterName": report.cluster_name,
                                "generatedAt": report.generated_at,
                                "version": report.version,
                                "totals": report.totals,
                                "scope": report.scope,
                                "source": report.source,
                            })
                        })
                        .collect::<Vec<_>>(),
                )
            })
            .await
        }
        "inspection:detail" => detail(context, &params).await,
        "inspection:clear" => {
            let cluster = text(&params, "clusterId");
            let context = context.clone();
            blocking(move || pm_store::inspections::delete_cluster(&context.store, &cluster)).await
        }
        "inspection:profile:get" => {
            let cluster = text(&params, "clusterId");
            let context = context.clone();
            blocking(move || {
                Ok::<_, pm_core::AppError>(
                    pm_store::inspections::profile(&context.store, &cluster)?.map(
                        |(thresholds, max_namespaces, max_topics, updated_at)| {
                            json!({
                                "clusterId": cluster,
                                "thresholds": thresholds,
                                "maxNamespaces": max_namespaces,
                                "maxTopics": max_topics,
                                "updatedAt": updated_at,
                            })
                        },
                    ),
                )
            })
            .await
        }
        "inspection:profile:save" => profile_save(context, &params).await,
        "inspection:schedule:get" => {
            let cluster = text(&params, "clusterId");
            let context = context.clone();
            blocking(move || pm_store::inspections::schedule(&context.store, &cluster)).await
        }
        "inspection:schedule:save" => schedule_save(context, &params).await,
        "inspection:summary" => {
            let context = context.clone();
            blocking(move || pm_services::inspection_fleet::build_summary(&context.store, pm_core::now_ms())).await
        }
        "inspection:summary:run" => fleet_run(context, &params).await,
        _ => return None,
    })
}

/// 定时调度的入口：与手动跑同一条执行序列，只是来源标成 scheduled。
/// 少走任何一步都会让定时那份报告缺环比或导出文本。
pub(crate) async fn execute_scheduled(context: &Shared, cluster_id: &str) -> AppResult<Value> {
    execute(context, cluster_id, "scheduled", None, None).await
}

/// 跑一次并落成一份历史报告。手动与逐台汇总共用。
async fn execute(
    context: &Shared,
    cluster_id: &str,
    source: &str,
    max_namespaces: Option<i64>,
    max_topics: Option<i64>,
) -> AppResult<Value> {
    let cluster = context.get_cluster(cluster_id)?;
    let profile = pm_store::inspections::profile(&context.store, cluster_id)?;
    let thresholds = profile.as_ref().map(|(thresholds, _, _, _)| thresholds.clone());
    let sampling = profile
        .as_ref()
        .map(|(_, namespaces, topics, _)| (*namespaces, *topics));

    let alerts: Vec<AlertRow> = pm_store::alerts::list_events(&context.store, Some(cluster_id), 50)?
        .into_iter()
        .filter(|event| event.state == "firing")
        .map(|event| AlertRow {
            rule_name: event.rule_name,
            scope_label: event.scope_label,
            message: event.message,
        })
        .collect();

    let client = context.admin_for(cluster_id)?;
    let mut report = inspection::run(InspectionRequest {
        client: &client,
        cluster_id,
        cluster_name: &cluster.name,
        alerts,
        thresholds,
        max_namespaces: max_namespaces.or(sampling.map(|(namespaces, _)| namespaces)),
        max_topics: max_topics.or(sampling.map(|(_, topics)| topics)),
    })
    .await?;
    report.source = source.to_string();

    // 环比要与上一份比：先取上一份，再渲染导出文本，最后落库
    let previous = pm_store::inspections::previous(
        &context.store,
        cluster_id,
        &report.generated_at,
        &report.id,
    )?;
    let diff = previous.as_ref().map(|previous| {
        pm_services::inspection::build_inspection_diff(
            &previous.id,
            &previous.generated_at,
            &previous.checks,
            &report.checks,
            previous.thresholds.as_ref(),
            report.thresholds.as_ref(),
        )
    });
    report.markdown = inspection::render_markdown(&report, diff.as_ref());
    pm_store::inspections::save(&context.store, &report)?;
    let _ = pm_store::inspections::prune(&context.store, cluster_id, HISTORY_KEEP);

    Ok(json!({
        "report": report,
        "markdown": report.markdown,
        "diff": diff,
        "source": report.source,
    }))
}

async fn run_once(context: Shared, params: &Value, source: &str) -> Value {
    let cluster = text(params, "clusterId");
    let max_namespaces = params.get("maxNamespaces").and_then(Value::as_i64);
    let max_topics = params.get("maxTopics").and_then(Value::as_i64);
    match execute(&context, &cluster, source, max_namespaces, max_topics).await {
        Ok(value) => ok(value),
        Err(error) => fail(error),
    }
}

async fn detail(context: Shared, params: &Value) -> Value {
    let id = text(params, "id");
    let result = blocking({
        let context = context.clone();
        move || -> AppResult<Value> {
            let report = pm_store::inspections::get(&context.store, &id)?
                .ok_or_else(|| pm_core::AppError::NotFound("这份巡检报告不存在，可能已被清理".into()))?;
            // markdown 取库里那份原文而不是重新渲染：重渲染会换掉当时的文案
            let markdown = report.markdown.clone();
            let previous = pm_store::inspections::previous(
                &context.store,
                &report.cluster_id,
                &report.generated_at,
                &report.id,
            )?;
            let diff = previous.as_ref().map(|previous| {
                pm_services::inspection::build_inspection_diff(
                    &previous.id,
                    &previous.generated_at,
                    &previous.checks,
                    &report.checks,
                    previous.thresholds.as_ref(),
                    report.thresholds.as_ref(),
                )
            });
            Ok(json!({
                "report": report,
                "markdown": markdown,
                "diff": diff,
                "source": report.source,
            }))
        }
    })
    .await;
    result
}

async fn profile_save(context: Shared, params: &Value) -> Value {
    let cluster_id = text(params, "clusterId");
    let draft = params.get("thresholds").cloned();
    let max_namespaces = params.get("maxNamespaces").and_then(Value::as_i64);
    let max_topics = params.get("maxTopics").and_then(Value::as_i64);
    let result = blocking({
        let context = context.clone();
        move || -> AppResult<Value> {
            if context.get_cluster(&cluster_id).is_err() {
                return Err(pm_core::AppError::NotFound("集群不存在，请先在集群配置里添加".into()));
            }
            // 先判口径合不合法，再落库：严重线低于关注线这类组合要在写库前拒掉
            let thresholds = inspection::resolve_thresholds(draft.as_ref())?;
            let existing = pm_store::inspections::profile(&context.store, &cluster_id)?;
            let sampling = inspection::resolve_sampling(
                max_namespaces.or(existing.as_ref().map(|(_, namespaces, _, _)| *namespaces)),
                max_topics.or(existing.as_ref().map(|(_, _, topics, _)| *topics)),
            )?;
            pm_store::inspections::save_profile(
                &context.store,
                &cluster_id,
                &thresholds,
                sampling.max_namespaces,
                sampling.max_topics,
            )?;
            Ok(json!({
                "clusterId": cluster_id,
                "thresholds": thresholds,
                "maxNamespaces": sampling.max_namespaces,
                "maxTopics": sampling.max_topics,
                "updatedAt": pm_core::now_iso(),
            }))
        }
    })
    .await;
    result
}

async fn schedule_save(context: Shared, params: &Value) -> Value {
    let cluster_id = text(params, "clusterId");
    let enabled = params.get("enabled").and_then(Value::as_bool);
    let interval = params.get("intervalMinutes").and_then(Value::as_i64);
    let notify = params.get("notifyOnCrit").and_then(Value::as_bool);
    let result = blocking({
        let context = context.clone();
        move || -> AppResult<Value> {
            let existing = pm_store::inspections::schedule(&context.store, &cluster_id)?;
            let interval_minutes = match interval {
                Some(value) => {
                    if !(MIN_INTERVAL..=MAX_INTERVAL).contains(&value) {
                        return Err(pm_core::AppError::config(format!(
                            "巡检间隔只能在 {MIN_INTERVAL}～{MAX_INTERVAL} 分钟之间"
                        )));
                    }
                    value
                }
                None => existing
                    .as_ref()
                    .map(|schedule| schedule.interval_minutes)
                    .unwrap_or(DEFAULT_INTERVAL_MINUTES),
            };
            let schedule = InspectionSchedule {
                cluster_id: cluster_id.clone(),
                enabled: enabled.unwrap_or_else(|| existing.as_ref().is_some_and(|s| s.enabled)),
                interval_minutes,
                notify_on_crit: notify.unwrap_or_else(|| {
                    existing.as_ref().map(|s| s.notify_on_crit).unwrap_or(true)
                }),
                last_run_at: existing.as_ref().and_then(|s| s.last_run_at.clone()),
                last_error: existing.as_ref().and_then(|s| s.last_error.clone()),
                last_notified_crit: existing.as_ref().map(|s| s.last_notified_crit).unwrap_or(0),
                updated_at: pm_core::now_iso(),
            };
            pm_store::inspections::save_schedule(&context.store, &schedule)?;
            Ok(json!(schedule))
        }
    })
    .await;
    result
}

/// 逐台串行跑：一次巡检本身会按采样上限打几百个请求，并发跑等于把请求量乘以集群数。
async fn fleet_run(context: Shared, params: &Value) -> Value {
    let limit = match params.get("limit").and_then(Value::as_i64) {
        Some(value) if value < 1 => {
            return fail(pm_core::AppError::config("一次巡检的集群数必须是正整数"))
        }
        Some(value) if value > FLEET_RUN_MAX_CLUSTERS => {
            return fail(pm_core::AppError::config(format!(
                "一次最多巡检 {FLEET_RUN_MAX_CLUSTERS} 台集群，请分几轮跑"
            )))
        }
        Some(value) => value,
        None => FLEET_RUN_MAX_CLUSTERS,
    };
    let max_namespaces = params.get("maxNamespaces").and_then(Value::as_i64);
    let max_topics = params.get("maxTopics").and_then(Value::as_i64);

    let clusters = match context.list_clusters() {
        Ok(clusters) => clusters,
        Err(error) => return fail(error),
    };
    let targets: Vec<_> = clusters.iter().take(limit as usize).cloned().collect();
    let skipped: Vec<Value> = clusters
        .iter()
        .skip(limit as usize)
        .map(|cluster| json!({"clusterId": cluster.id, "clusterName": cluster.name}))
        .collect();

    let mut failures: Vec<Value> = Vec::new();
    let mut ran = 0i64;
    let total = targets.len();

    for (index, cluster) in targets.iter().enumerate() {
        emit(
            "inspection:fleet-progress",
            json!({
                "clusterId": cluster.id,
                "clusterName": cluster.name,
                "index": index,
                "total": total,
                "status": "started",
                "totals": null,
                "message": format!("正在巡检 {}", cluster.name),
            }),
        );
        match execute(&context, &cluster.id, "manual", max_namespaces, max_topics).await {
            Ok(value) => {
                ran += 1;
                let totals = value["report"]["totals"].clone();
                emit(
                    "inspection:fleet-progress",
                    json!({
                        "clusterId": cluster.id,
                        "clusterName": cluster.name,
                        "index": index,
                        "total": total,
                        "status": "done",
                        "totals": totals,
                        "message": format!(
                            "{}：严重 {} 项、关注 {} 项、未覆盖 {} 项",
                            cluster.name,
                            totals["crit"].as_i64().unwrap_or(0),
                            totals["warn"].as_i64().unwrap_or(0),
                            totals["skip"].as_i64().unwrap_or(0)
                        ),
                    }),
                );
            }
            Err(error) => {
                let message = error.to_string();
                failures.push(json!({
                    "clusterId": cluster.id,
                    "clusterName": cluster.name,
                    "message": message,
                }));
                emit(
                    "inspection:fleet-progress",
                    json!({
                        "clusterId": cluster.id,
                        "clusterName": cluster.name,
                        "index": index,
                        "total": total,
                        "status": "failed",
                        "totals": null,
                        "message": format!("{}：{}", cluster.name, message),
                    }),
                );
            }
        }
    }

    // 跑完按新的库重算：否则界面要自己再拼一遍，口径会和单集群那份报告对不上
    let summary = match pm_services::inspection_fleet::build_summary(&context.store, pm_core::now_ms()) {
        Ok(mut summary) => {
            summary["failures"] = json!(failures);
            summary["skipped"] = json!(skipped);
            summary
        }
        Err(error) => return fail(error),
    };

    let _ = BTreeSet::<u8>::new();
    ok(json!({
        "summary": summary,
        "ran": ran,
        "failed": failures.len(),
    }))
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}
