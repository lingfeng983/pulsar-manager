//! 生产者会话：工作台的一条长连接 producer + 持续发送（flow）。
//!
//! 原生 producer 是 `&mut self` 的：发送必须串行，所以每条会话由一个任务独占持有，
//! 外部只通过命令通道排队。流量控制也在同一个任务里按 tick 推进，这样停止时能保证
//! 「不再发出新的、在飞的等它落地」。

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pm_core::{AdminConfig, AppError, AppResult, TemplateVariable};
use pm_pulsar::native::NativeClient;
use pulsar::producer;
use serde::Serialize;
use tokio::sync::{mpsc, oneshot};

use crate::messaging::Emit;

pub const PRODUCER_STATS: &str = "msg:producer-stats";
/// 统计推送节奏：界面上的速率与延迟面板按这个频率刷新
const STATS_INTERVAL_MS: u64 = 500;
/// 一个 tick 里最多补发多少条：速率设成 5000/s 时也不能把事件循环一次堵死
const MAX_PER_TICK: i64 = 200;

#[derive(Debug, Clone, Serialize)]
pub struct ProducerSessionView {
    pub session_id: String,
    pub cluster_id: String,
    pub topic_uri: String,
    pub producer_name: String,
    pub connected: bool,
    pub flow_running: bool,
    pub owner_id: String,
    pub sent: i64,
    pub failed: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Latency {
    pub count: i64,
    pub avg_ms: f64,
    pub min_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub max_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunStats {
    pub session_id: String,
    pub sent: i64,
    pub failed: i64,
    pub bytes_sent: i64,
    pub elapsed_ms: i64,
    pub msg_per_sec: f64,
    pub mb_per_sec: f64,
    pub latency: Option<Latency>,
    pub last_error: Option<String>,
    pub flow_running: bool,
    pub error: Option<String>,
}

/// 一条待发报文：正文与逐条参数在 RPC 层解析好后交进来，这里不再碰模板。
#[derive(Debug, Clone, Default)]
pub struct SendItem {
    pub payload: Vec<u8>,
    pub properties: BTreeMap<String, String>,
    pub partition_key: Option<String>,
    pub event_time: Option<i64>,
    pub deliver_at: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct FlowSpec {
    pub body: String,
    pub variables: Vec<TemplateVariable>,
    pub properties: BTreeMap<String, String>,
    pub rate_per_sec: f64,
    /// 0 表示不限条数，收到停止为止
    pub total: i64,
}

enum Command {
    Send {
        items: Vec<SendItem>,
        done: oneshot::Sender<AppResult<Vec<String>>>,
    },
    Flush {
        done: oneshot::Sender<AppResult<()>>,
    },
    StartFlow {
        spec: FlowSpec,
        done: oneshot::Sender<AppResult<()>>,
    },
    StopFlow {
        done: oneshot::Sender<AppResult<()>>,
    },
    SetRate {
        rate: f64,
        done: oneshot::Sender<AppResult<()>>,
    },
    Stop,
}

struct Entry {
    cluster_id: String,
    topic_uri: String,
    producer_name: String,
    owner_id: String,
    #[allow(dead_code)]
    started_at: i64,
    sent: Arc<AtomicI64>,
    failed: Arc<AtomicI64>,
    flow: Arc<AtomicBool>,
    tx: mpsc::Sender<Command>,
}

#[derive(Default)]
pub struct ProducerRegistry {
    entries: Mutex<HashMap<String, Entry>>,
}

impl ProducerRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list(&self, cluster_id: Option<&str>) -> Vec<ProducerSessionView> {
        let entries = match self.entries.lock() {
            Ok(entries) => entries,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut views: Vec<ProducerSessionView> = entries
            .iter()
            .filter(|(_, entry)| match cluster_id {
                Some(cluster) if !cluster.is_empty() => entry.cluster_id == cluster,
                _ => true,
            })
            .map(|(id, entry)| ProducerSessionView {
                session_id: id.clone(),
                cluster_id: entry.cluster_id.clone(),
                topic_uri: entry.topic_uri.clone(),
                producer_name: entry.producer_name.clone(),
                connected: true,
                flow_running: entry.flow.load(Ordering::Relaxed),
                owner_id: entry.owner_id.clone(),
                sent: entry.sent.load(Ordering::Relaxed),
                failed: entry.failed.load(Ordering::Relaxed),
            })
            .collect();
        views.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        views
    }

    pub fn stop(&self, session_id: &str) -> bool {
        let entry = {
            let mut entries = match self.entries.lock() {
                Ok(entries) => entries,
                Err(poisoned) => poisoned.into_inner(),
            };
            entries.remove(session_id)
        };
        match entry {
            Some(entry) => {
                let _ = entry.tx.try_send(Command::Stop);
                true
            }
            None => false,
        }
    }

    pub async fn send(&self, session_id: &str, items: Vec<SendItem>) -> AppResult<Vec<String>> {
        let tx = self.sender(session_id)?;
        let (done, wait) = oneshot::channel();
        tx.send(Command::Send { items, done })
            .await
            .map_err(|_| AppError::Other("会话已经结束了".into()))?;
        wait.await
            .map_err(|_| AppError::Other("会话已经结束了".into()))?
    }

    pub async fn flush(&self, session_id: &str) -> AppResult<()> {
        let tx = self.sender(session_id)?;
        let (done, wait) = oneshot::channel();
        tx.send(Command::Flush { done })
            .await
            .map_err(|_| AppError::Other("会话已经结束了".into()))?;
        wait.await
            .map_err(|_| AppError::Other("会话已经结束了".into()))?
    }

    pub async fn start_flow(&self, session_id: &str, spec: FlowSpec) -> AppResult<()> {
        let tx = self.sender(session_id)?;
        let (done, wait) = oneshot::channel();
        tx.send(Command::StartFlow { spec, done })
            .await
            .map_err(|_| AppError::Other("会话已经结束了".into()))?;
        wait.await
            .map_err(|_| AppError::Other("会话已经结束了".into()))?
    }

    pub async fn stop_flow(&self, session_id: &str) -> AppResult<()> {
        let tx = self.sender(session_id)?;
        let (done, wait) = oneshot::channel();
        tx.send(Command::StopFlow { done })
            .await
            .map_err(|_| AppError::Other("会话已经结束了".into()))?;
        wait.await
            .map_err(|_| AppError::Other("会话已经结束了".into()))?
    }

    pub async fn set_rate(&self, session_id: &str, rate: f64) -> AppResult<()> {
        let tx = self.sender(session_id)?;
        let (done, wait) = oneshot::channel();
        tx.send(Command::SetRate { rate, done })
            .await
            .map_err(|_| AppError::Other("会话已经结束了".into()))?;
        wait.await
            .map_err(|_| AppError::Other("会话已经结束了".into()))?
    }

    fn sender(&self, session_id: &str) -> AppResult<mpsc::Sender<Command>> {
        let entries = match self.entries.lock() {
            Ok(entries) => entries,
            Err(poisoned) => poisoned.into_inner(),
        };
        entries
            .get(session_id)
            .map(|entry| entry.tx.clone())
            .ok_or_else(|| AppError::Other("会话已经结束了".into()))
    }

    fn insert(&self, id: String, entry: Entry) {
        let mut entries = match self.entries.lock() {
            Ok(entries) => entries,
            Err(poisoned) => poisoned.into_inner(),
        };
        entries.insert(id, entry);
    }

    fn remove(&self, id: &str) {
        let mut entries = match self.entries.lock() {
            Ok(entries) => entries,
            Err(poisoned) => poisoned.into_inner(),
        };
        entries.remove(id);
    }
}

struct FlowState {
    spec: FlowSpec,
    rate: f64,
    issued: i64,
    due: f64,
    last_tick: Instant,
}

pub async fn start(
    registry: Arc<ProducerRegistry>,
    config: &AdminConfig,
    cluster_id: &str,
    topic_uri: &str,
    owner_id: &str,
    emit: Emit,
) -> AppResult<ProducerSessionView> {
    let client = NativeClient::connect(config).await?;
    let mut producer = client.open_producer(topic_uri).await?;

    let session_id = pm_core::new_id();
    let sent = Arc::new(AtomicI64::new(0));
    let failed = Arc::new(AtomicI64::new(0));
    let flow_running = Arc::new(AtomicBool::new(false));
    let (tx, mut rx) = mpsc::channel::<Command>(64);

    registry.insert(
        session_id.clone(),
        Entry {
            cluster_id: cluster_id.to_string(),
            topic_uri: topic_uri.to_string(),
            producer_name: format!("producer-{}", &session_id[..8]),
            owner_id: owner_id.to_string(),
            started_at: pm_core::now_ms(),
            sent: sent.clone(),
            failed: failed.clone(),
            flow: flow_running.clone(),
            tx,
        },
    );

    let view = ProducerSessionView {
        session_id: session_id.clone(),
        cluster_id: cluster_id.to_string(),
        topic_uri: topic_uri.to_string(),
        producer_name: format!("producer-{}", &session_id[..8]),
        connected: true,
        flow_running: false,
        owner_id: owner_id.to_string(),
        sent: 0,
        failed: 0,
    };

    let task_registry = registry.clone();
    let task_emit = emit.clone();
    let task_id = session_id.clone();

    tokio::spawn(async move {
        let started = Instant::now();
        let mut flow: Option<FlowState> = None;
        let mut ticker = tokio::time::interval(Duration::from_millis(100));
        let mut stats_at = Instant::now();
        let mut bytes_sent: i64 = 0;
        let mut last_error: Option<String> = None;
        let mut samples: Vec<f64> = Vec::new();
        let mut end_error: Option<String> = None;

        loop {
            let event = tokio::select! {
                cmd = rx.recv() => Event::Cmd(cmd),
                _ = ticker.tick() => Event::Tick,
            };

            match event {
                Event::Cmd(None) | Event::Cmd(Some(Command::Stop)) => break,
                Event::Cmd(Some(Command::Send { items, done })) => {
                    let mut ids = Vec::with_capacity(items.len());
                    let mut error: Option<AppError> = None;
                    for item in items {
                        let started_at = Instant::now();
                        match send_one(&mut producer, &item).await {
                            Ok(id) => {
                                ids.push(id);
                                sent.fetch_add(1, Ordering::Relaxed);
                                bytes_sent += item.payload.len() as i64;
                                samples.push(started_at.elapsed().as_secs_f64() * 1000.0);
                                if samples.len() > 500 {
                                    samples.remove(0);
                                }
                            }
                            Err(failure) => {
                                failed.fetch_add(1, Ordering::Relaxed);
                                last_error = Some(failure.to_string());
                                error = Some(failure);
                                break;
                            }
                        }
                    }
                    let _ = done.send(match error {
                        Some(error) => Err(error),
                        None => Ok(ids),
                    });
                }
                Event::Cmd(Some(Command::Flush { done })) => {
                    let _ = done.send(
                        producer
                            .send_batch()
                            .await
                            .map_err(|e| AppError::Other(format!("flush 失败: {e}"))),
                    );
                }
                Event::Cmd(Some(Command::StartFlow { spec, done })) => {
                    if spec.rate_per_sec <= 0.0 {
                        let _ = done.send(Err(AppError::Other("速率必须大于 0".into())));
                    } else {
                        flow = Some(FlowState {
                            rate: spec.rate_per_sec,
                            issued: 0,
                            due: 0.0,
                            last_tick: Instant::now(),
                            spec,
                        });
                        flow_running.store(true, Ordering::Relaxed);
                        let _ = done.send(Ok(()));
                    }
                }
                Event::Cmd(Some(Command::StopFlow { done })) => {
                    flow = None;
                    flow_running.store(false, Ordering::Relaxed);
                    let _ = producer.send_batch().await;
                    let _ = done.send(Ok(()));
                }
                Event::Cmd(Some(Command::SetRate { rate, done })) => {
                    if rate <= 0.0 {
                        let _ = done.send(Err(AppError::Other("速率必须大于 0".into())));
                    } else {
                        if let Some(state) = flow.as_mut() {
                            state.rate = rate;
                            state.last_tick = Instant::now();
                            state.due = 0.0;
                        }
                        let _ = done.send(Ok(()));
                    }
                }
                Event::Tick => {
                    if let Some(state) = flow.as_mut() {
                        let elapsed = state.last_tick.elapsed().as_secs_f64();
                        state.last_tick = Instant::now();
                        state.due += state.rate * elapsed;
                        let mut budget = state.due.min(MAX_PER_TICK as f64) as i64;
                        while budget > 0 {
                            if state.spec.total > 0 && state.issued >= state.spec.total {
                                break;
                            }
                            let rendered = match crate::template::render(
                                &state.spec.body,
                                &state.spec.variables,
                            ) {
                                Ok(rendered) => rendered.body,
                                Err(error) => {
                                    last_error = Some(error.to_string());
                                    end_error = Some(error.to_string());
                                    break;
                                }
                            };
                            let item = SendItem {
                                payload: rendered.into_bytes(),
                                properties: state.spec.properties.clone(),
                                ..Default::default()
                            };
                            let started_at = Instant::now();
                            match send_one(&mut producer, &item).await {
                                Ok(_) => {
                                    state.issued += 1;
                                    sent.fetch_add(1, Ordering::Relaxed);
                                    bytes_sent += item.payload.len() as i64;
                                    samples.push(started_at.elapsed().as_secs_f64() * 1000.0);
                                    if samples.len() > 500 {
                                        samples.remove(0);
                                    }
                                }
                                Err(error) => {
                                    failed.fetch_add(1, Ordering::Relaxed);
                                    last_error = Some(error.to_string());
                                    end_error = Some(error.to_string());
                                    break;
                                }
                            }
                            budget -= 1;
                            state.due -= 1.0;
                        }
                        if state.due < 0.0 {
                            state.due = 0.0;
                        }
                        if state.spec.total > 0 && state.issued >= state.spec.total {
                            flow = None;
                            flow_running.store(false, Ordering::Relaxed);
                        }
                    }
                }
            }

            if stats_at.elapsed() >= Duration::from_millis(STATS_INTERVAL_MS) {
                stats_at = Instant::now();
                let stats = RunStats {
                    session_id: task_id.clone(),
                    sent: sent.load(Ordering::Relaxed),
                    failed: failed.load(Ordering::Relaxed),
                    bytes_sent,
                    elapsed_ms: started.elapsed().as_millis() as i64,
                    msg_per_sec: rate_of(sent.load(Ordering::Relaxed), started.elapsed()),
                    mb_per_sec: rate_of(bytes_sent, started.elapsed()) / (1024.0 * 1024.0),
                    latency: latency_of(&samples),
                    last_error: last_error.clone(),
                    flow_running: flow_running.load(Ordering::Relaxed),
                    error: end_error.clone(),
                };
                if let Ok(payload) = serde_json::to_value(&stats) {
                    task_emit(PRODUCER_STATS, payload);
                }
            }

            if end_error.is_some() && flow.is_none() {
                break;
            }
        }

        let _ = producer.send_batch().await;
        let _ = producer.close().await;
        flow_running.store(false, Ordering::Relaxed);
        task_registry.remove(&task_id);

        // 终态再推一次：界面靠它把「运行中」改成「已结束」
        let stats = RunStats {
            session_id: task_id.clone(),
            sent: sent.load(Ordering::Relaxed),
            failed: failed.load(Ordering::Relaxed),
            bytes_sent,
            elapsed_ms: started.elapsed().as_millis() as i64,
            msg_per_sec: rate_of(sent.load(Ordering::Relaxed), started.elapsed()),
            mb_per_sec: rate_of(bytes_sent, started.elapsed()) / (1024.0 * 1024.0),
            latency: latency_of(&samples),
            last_error,
            flow_running: false,
            error: end_error,
        };
        if let Ok(payload) = serde_json::to_value(&stats) {
            task_emit(PRODUCER_STATS, payload);
        }
        if let Ok(payload) = serde_json::to_value(pm_core::SessionEndEvent {
            session_id: task_id,
            reason: "stopped".into(),
            detail: None,
        }) {
            task_emit(crate::messaging::SESSION_END, payload);
        }
    });

    Ok(view)
}

async fn send_one(
    producer: &mut pulsar::Producer<pulsar::TokioExecutor>,
    item: &SendItem,
) -> AppResult<String> {
    let message = producer::Message {
        payload: item.payload.clone(),
        properties: item.properties.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        partition_key: item.partition_key.clone(),
        event_time: item.event_time.map(|value| value as u64),
        deliver_at_time: item.deliver_at,
        ..Default::default()
    };
    let receipt = producer
        .send_non_blocking(message)
        .await
        .map_err(|e| AppError::Other(format!("发送失败: {e}")))?
        .await
        .map_err(|e| AppError::Other(format!("broker 未确认消息: {e}")))?;
    Ok(receipt
        .message_id
        .map(|id| format!("{}:{}:{}", id.ledger_id, id.entry_id, id.partition.unwrap_or(-1)))
        .unwrap_or_else(|| "sent".to_string()))
}

fn rate_of(count: i64, elapsed: Duration) -> f64 {
    let seconds = elapsed.as_secs_f64();
    if seconds <= 0.0 {
        0.0
    } else {
        count as f64 / seconds
    }
}

fn latency_of(samples: &[f64]) -> Option<Latency> {
    if samples.is_empty() {
        return None;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let pick = |quantile: f64| -> f64 {
        let index = ((sorted.len() as f64 - 1.0) * quantile).round() as usize;
        sorted[index.min(sorted.len() - 1)]
    };
    let sum: f64 = sorted.iter().sum();
    Some(Latency {
        count: sorted.len() as i64,
        avg_ms: round2(sum / sorted.len() as f64),
        min_ms: round2(sorted[0]),
        p50_ms: round2(pick(0.50)),
        p95_ms: round2(pick(0.95)),
        p99_ms: round2(pick(0.99)),
        max_ms: round2(sorted[sorted.len() - 1]),
    })
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

enum Event {
    Cmd(Option<Command>),
    Tick,
}

/// 供压测复用的单次生产：连一次、发一批、关掉。
pub async fn burst(
    config: &AdminConfig,
    topic_uri: &str,
    items: Vec<SendItem>,
) -> AppResult<Vec<String>> {
    let client = NativeClient::connect(config).await?;
    let mut producer = client.open_producer(topic_uri).await?;
    let mut ids = Vec::with_capacity(items.len());
    for item in items {
        ids.push(send_one(&mut producer, &item).await?);
    }
    let _ = producer.send_batch().await;
    let _ = producer.close().await;
    Ok(ids)
}

/// 供压测复用：把一批消息按速率推进（内部用同一套 tick 逻辑的简化版）。
pub async fn pump(
    config: &AdminConfig,
    topic_uri: &str,
    spec: FlowSpec,
    duration_ms: i64,
    emit: Emit,
    run_id: &str,
) -> AppResult<RunStats> {
    let client = NativeClient::connect(config).await?;
    let mut producer = client.open_producer(topic_uri).await?;
    let started = Instant::now();
    let mut sent = 0i64;
    let mut failed = 0i64;
    let mut bytes_sent = 0i64;
    let mut samples: Vec<f64> = Vec::new();
    let mut last_error: Option<String> = None;
    let mut due = 0.0f64;
    let mut last_tick = Instant::now();
    let mut ticker = tokio::time::interval(Duration::from_millis(100));

    loop {
        ticker.tick().await;
        if duration_ms > 0 && started.elapsed().as_millis() as i64 >= duration_ms {
            break;
        }
        if spec.total > 0 && sent >= spec.total {
            break;
        }
        let elapsed = last_tick.elapsed().as_secs_f64();
        last_tick = Instant::now();
        due += spec.rate_per_sec * elapsed;
        let mut budget = due.min(MAX_PER_TICK as f64) as i64;
        while budget > 0 {
            if spec.total > 0 && sent >= spec.total {
                break;
            }
            let rendered = crate::template::render(&spec.body, &spec.variables)?;
            let item = SendItem {
                payload: rendered.body.into_bytes(),
                properties: spec.properties.clone(),
                ..Default::default()
            };
            let at = Instant::now();
            match send_one(&mut producer, &item).await {
                Ok(_) => {
                    sent += 1;
                    bytes_sent += item.payload.len() as i64;
                    samples.push(at.elapsed().as_secs_f64() * 1000.0);
                    if samples.len() > 500 {
                        samples.remove(0);
                    }
                }
                Err(error) => {
                    failed += 1;
                    last_error = Some(error.to_string());
                    break;
                }
            }
            budget -= 1;
            due -= 1.0;
        }
        if due < 0.0 {
            due = 0.0;
        }
        let progress = serde_json::json!({
            "runId": run_id,
            "phase": "produce",
            "sent": sent,
            "failed": failed,
            "bytesSent": bytes_sent,
            "elapsedMs": started.elapsed().as_millis() as i64,
            "msgPerSec": rate_of(sent, started.elapsed()),
            "mbPerSec": rate_of(bytes_sent, started.elapsed()) / (1024.0 * 1024.0),
            "latency": latency_of(&samples),
            "lastError": last_error,
            "done": false,
        });
        emit("benchmark:progress", progress);
    }

    let _ = producer.send_batch().await;
    let _ = producer.close().await;
    let stats = RunStats {
        session_id: run_id.to_string(),
        sent,
        failed,
        bytes_sent,
        elapsed_ms: started.elapsed().as_millis() as i64,
        msg_per_sec: rate_of(sent, started.elapsed()),
        mb_per_sec: rate_of(bytes_sent, started.elapsed()) / (1024.0 * 1024.0),
        latency: latency_of(&samples),
        last_error,
        flow_running: false,
        error: None,
    };
    Ok(stats)
}
