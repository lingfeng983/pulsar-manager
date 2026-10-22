//! 生产者会话：工作台的一条长连接 producer + 持续发送（flow）。
//!
//! 原生 producer 是 `&mut self` 的：发送必须串行，所以每条会话由一个任务独占持有，
//! 外部只通过命令通道排队。流量控制也在同一个任务里按 tick 推进，这样停止时能保证
//! 「不再发出新的、在飞的等它落地」。

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pm_core::{AdminConfig, AppError, AppResult, ConsumeOptions, TemplateVariable, TopicPath};
use pm_pulsar::native::NativeClient;
use pm_pulsar::AdminClient;
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
#[serde(rename_all = "camelCase")]
pub struct ProducerSessionView {
    pub session_id: String,
    pub cluster_id: String,
    pub topic_uri: String,
    pub producer_name: String,
    /// 是否在线：由最近一次真实发送的结果决定，不再是写死的 true。
    pub connected: bool,
    pub flow_running: bool,
    pub owner_id: String,
    pub sent: i64,
    pub failed: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
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

/// 一条会话的在线状态。
///
/// pulsar crate 不对外暴露 producer 的底层连接状态，能拿到的可观测事实只有「最近一次
/// 真实发送（手动发送或 flow）的结果」，在线与否就以它为准：建连失败根本建不出会话，
/// 所以新会话按在线起步；某次发送失败（broker 未确认消息、连接已断）就置为已断开；
/// 之后若又发送成功，说明底层已经重连，再回到在线。
///
/// 之前这里写死 `connected: true`，于是「发送失败、broker 早就断了」的会话在界面上
/// 依然显示「已连接」，用户据此继续点发送只会一直失败。
#[derive(Debug)]
struct Liveness(AtomicBool);

impl Liveness {
    fn new() -> Self {
        Self(AtomicBool::new(true))
    }

    fn is_connected(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }

    fn mark_online(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    fn mark_offline(&self) {
        self.0.store(false, Ordering::Relaxed);
    }
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
    connected: Arc<Liveness>,
    tx: mpsc::Sender<Command>,
}

/// 会话收尾守卫：任务退出（正常结束或 panic 展开）时统一停止 flow、标记已断开、
/// 摘掉注册表条目。
struct SessionGuard {
    registry: Arc<ProducerRegistry>,
    session_id: String,
    liveness: Arc<Liveness>,
    flow: Arc<AtomicBool>,
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.flow.store(false, Ordering::Relaxed);
        self.liveness.mark_offline();
        self.registry.remove(&self.session_id);
    }
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
                connected: entry.connected.is_connected(),
                flow_running: entry.flow.load(Ordering::Relaxed),
                owner_id: entry.owner_id.clone(),
                sent: entry.sent.load(Ordering::Relaxed),
                failed: entry.failed.load(Ordering::Relaxed),
            })
            .collect();
        views.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        views
    }

    pub fn view(&self, session_id: &str) -> Option<ProducerSessionView> {
        let entries = match self.entries.lock() {
            Ok(entries) => entries,
            Err(poisoned) => poisoned.into_inner(),
        };
        entries.get(session_id).map(|entry| ProducerSessionView {
            session_id: session_id.to_string(),
            cluster_id: entry.cluster_id.clone(),
            topic_uri: entry.topic_uri.clone(),
            producer_name: entry.producer_name.clone(),
            connected: entry.connected.is_connected(),
            flow_running: entry.flow.load(Ordering::Relaxed),
            owner_id: entry.owner_id.clone(),
            sent: entry.sent.load(Ordering::Relaxed),
            failed: entry.failed.load(Ordering::Relaxed),
        })
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
    // 走到这里说明 broker 二进制口已经连上、producer 也开出来了，按在线起步。
    let liveness = Arc::new(Liveness::new());
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
            connected: liveness.clone(),
            tx,
        },
    );

    // 视图统一从注册表取，`connected` 只有 Liveness 一个来源，避免两处各写一份。
    let view = registry
        .view(&session_id)
        .ok_or_else(|| AppError::Other("会话刚建立就丢了".into()))?;

    let task_registry = registry.clone();
    let task_emit = emit.clone();
    let task_id = session_id.clone();
    let task_liveness = liveness.clone();
    let task_flow = flow_running.clone();

    tokio::spawn(async move {
        // 任务无论正常结束还是 panic 展开，都在这里统一摘掉会话并标记已断开，
        // 免得留下一个永远「已连接」的幽灵条目。
        let _guard = SessionGuard {
            registry: task_registry,
            session_id: task_id.clone(),
            liveness: task_liveness,
            flow: task_flow,
        };
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
                                liveness.mark_online();
                            }
                            Err(failure) => {
                                failed.fetch_add(1, Ordering::Relaxed);
                                last_error = Some(failure.to_string());
                                // broker 没确认或连接已断：如实标成已断开，别让界面继续
                                // 显示「已连接」引用户接着发。
                                liveness.mark_offline();
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
                    let flushed = producer
                        .send_batch()
                        .await
                        .map_err(|e| AppError::Other(format!("flush 失败: {e}")));
                    // 失败说明这一轮推送没走通；成功不做「恢复在线」——队列空时它不发包，
                    // 拿它当在线的证据会误报。
                    if flushed.is_err() {
                        liveness.mark_offline();
                    }
                    let _ = done.send(flushed);
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
                                    liveness.mark_online();
                                }
                                Err(error) => {
                                    failed.fetch_add(1, Ordering::Relaxed);
                                    last_error = Some(error.to_string());
                                    liveness.mark_offline();
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
        // 会话的摘除与「已断开」标记交给 _guard（正常结束与 panic 都覆盖）。

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
        properties: item
            .properties
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
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
        .map(|id| {
            format!(
                "{}:{}:{}",
                id.ledger_id,
                id.entry_id,
                id.partition.unwrap_or(-1)
            )
        })
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

/// 压测参数：与界面 `LoadTestParams` 一一对应。正文按消息大小生成，
/// 不再依赖模板；producers / 压缩 / 批量 / 同轮消费都在这里真正生效。
#[derive(Debug, Clone)]
pub struct BenchmarkSpec {
    pub producers: usize,
    pub total: i64,
    pub rate_per_sec: f64,
    pub message_size_bytes: usize,
    pub max_in_flight: usize,
    pub batching: bool,
    pub compression: String,
    pub consume_backlog: bool,
    pub subscription: String,
    pub unsubscribe_after_run: bool,
}

impl Default for BenchmarkSpec {
    fn default() -> Self {
        Self {
            producers: 1,
            total: 1,
            rate_per_sec: 0.0,
            message_size_bytes: 1024,
            max_in_flight: 1,
            batching: false,
            compression: "None".into(),
            consume_backlog: false,
            subscription: String::new(),
            unsubscribe_after_run: false,
        }
    }
}

/// 跑一轮压测：N 个 producer、全局限速、可选同轮消费与结束后退订。
/// 进度按 200ms 一帧推送，phase 使用前端契约的 running/completed/stopped。
pub async fn run_benchmark(
    config: &AdminConfig,
    topic_uri: &str,
    spec: BenchmarkSpec,
    cancel: Arc<AtomicBool>,
    emit: Emit,
    run_id: &str,
) -> AppResult<()> {
    if spec.total <= 0 {
        return Err(AppError::config("压测总条数必须大于 0"));
    }
    let producers = spec.producers.clamp(1, 64);
    let max_in_flight = spec.max_in_flight.clamp(1, 500);
    let workers = (producers * max_in_flight).min(256);
    let message_size = spec.message_size_bytes.min(10 * 1024 * 1024);
    let total = spec.total;
    let rate = spec.rate_per_sec.max(0.0);

    let client = NativeClient::connect(config).await?;
    let options = producer::ProducerOptions {
        batch_size: spec.batching.then_some(100),
        batch_byte_size: spec.batching.then_some(128 * 1024),
        batch_timeout: spec.batching.then_some(Duration::from_millis(10)),
        compression: Some(NativeClient::compression_from(&spec.compression)),
        ..Default::default()
    };
    let mut slots = Vec::with_capacity(producers);
    for _ in 0..producers {
        slots.push(Arc::new(tokio::sync::Mutex::new(
            client
                .open_producer_with(topic_uri, options.clone())
                .await?,
        )));
    }
    let slots = Arc::new(slots);

    let sent = Arc::new(AtomicI64::new(0));
    let failed = Arc::new(AtomicI64::new(0));
    let bytes_sent = Arc::new(AtomicI64::new(0));
    let consumed = Arc::new(AtomicI64::new(0));
    let next_seq = Arc::new(AtomicI64::new(0));
    let samples = Arc::new(Mutex::new(VecDeque::<f64>::new()));
    let last_error = Arc::new(Mutex::new(None::<String>));
    let stop_consumer = Arc::new(AtomicBool::new(false));
    let started = Instant::now();

    // 同轮消费：在独立连接上开一条 Shared 消费者，不抢生产的连接。
    let consumer_task = if spec.consume_backlog && !spec.subscription.trim().is_empty() {
        let cfg = config.clone();
        let topic = topic_uri.to_string();
        let subscription = spec.subscription.clone();
        let cancel = cancel.clone();
        let stop_consumer = stop_consumer.clone();
        let consumed = consumed.clone();
        Some(tokio::spawn(async move {
            let options = ConsumeOptions {
                cluster_id: String::new(),
                topic,
                subscription,
                subscription_type: "Shared".into(),
                initial_position: "Earliest".into(),
                auto_ack: true,
                max_messages: 0,
                receiver_queue_size: Some(1_000),
                ack_timeout_ms: None,
                n_ack_redeliver_timeout_ms: None,
                consumer_name: None,
                owner_id: None,
            };
            let client = match NativeClient::connect(&cfg).await {
                Ok(client) => client,
                Err(error) => {
                    pm_core::pm_warn!("[benchmark] 同轮消费连接失败：{error}");
                    return;
                }
            };
            let mut consumer = match client.open_consumer(&options).await {
                Ok(consumer) => consumer,
                Err(error) => {
                    pm_core::pm_warn!("[benchmark] 同轮消费订阅失败：{error}");
                    return;
                }
            };
            loop {
                if cancel.load(Ordering::Relaxed) || stop_consumer.load(Ordering::Relaxed) {
                    break;
                }
                match tokio::time::timeout(Duration::from_millis(200), consumer.next()).await {
                    Ok(Some(Ok(_))) => {
                        consumed.fetch_add(1, Ordering::Relaxed);
                    }
                    Ok(Some(Err(_))) | Ok(None) => break,
                    Err(_) => {}
                }
            }
            consumer.close().await;
        }))
    } else {
        None
    };

    let mut tasks = tokio::task::JoinSet::new();
    for worker in 0..workers {
        let slot = slots[worker % producers].clone();
        let cancel = cancel.clone();
        let sent = sent.clone();
        let failed = failed.clone();
        let bytes_sent = bytes_sent.clone();
        let next_seq = next_seq.clone();
        let samples = samples.clone();
        let last_error = last_error.clone();
        tasks.spawn(async move {
            loop {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                let seq = next_seq.fetch_add(1, Ordering::Relaxed);
                if seq >= total {
                    break;
                }
                if rate > 0.0 {
                    let target = started + Duration::from_secs_f64(seq as f64 / rate);
                    let now = Instant::now();
                    if target > now {
                        tokio::time::sleep(target - now).await;
                        if cancel.load(Ordering::Relaxed) {
                            break;
                        }
                    }
                }
                let payload = vec![b'x'; message_size];
                let message = producer::Message {
                    payload: payload.clone(),
                    ..Default::default()
                };
                let at = Instant::now();
                let enqueued = {
                    let mut producer = slot.lock().await;
                    producer.send_non_blocking(message).await
                };
                match enqueued {
                    Ok(receipt) => match receipt.await {
                        Ok(_) => {
                            sent.fetch_add(1, Ordering::Relaxed);
                            bytes_sent.fetch_add(payload.len() as i64, Ordering::Relaxed);
                            if let Ok(mut samples) = samples.lock() {
                                samples.push_back(at.elapsed().as_secs_f64() * 1000.0);
                                while samples.len() > 20_000 {
                                    samples.pop_front();
                                }
                            }
                        }
                        Err(error) => {
                            failed.fetch_add(1, Ordering::Relaxed);
                            if let Ok(mut slot) = last_error.lock() {
                                *slot = Some(format!("broker 未确认消息: {error}"));
                            }
                        }
                    },
                    Err(error) => {
                        failed.fetch_add(1, Ordering::Relaxed);
                        if let Ok(mut slot) = last_error.lock() {
                            *slot = Some(format!("发送失败: {error}"));
                        }
                    }
                }
            }
        });
    }

    let mut ticker = tokio::time::interval(Duration::from_millis(200));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = ticker.tick() => emit_benchmark_progress(
                &emit,
                run_id,
                "running",
                &spec,
                &sent,
                &failed,
                &bytes_sent,
                &consumed,
                &samples,
                &last_error,
                started,
            ),
            joined = tasks.join_next(), if !tasks.is_empty() => {
                let _ = joined;
            }
        }
        if tasks.is_empty() {
            break;
        }
    }

    // 把批量队列最后一段推出去；producer 在 Arc 里，锁住再 flush 即可。
    for slot in slots.iter() {
        let mut producer = slot.lock().await;
        let _ = producer.send_batch().await;
    }

    stop_consumer.store(true, Ordering::Relaxed);
    if let Some(task) = consumer_task {
        let _ = task.await;
    }

    if spec.consume_backlog && spec.unsubscribe_after_run && !spec.subscription.trim().is_empty() {
        if let Ok(path) = TopicPath::parse(topic_uri) {
            if let Ok(admin) = AdminClient::new(config) {
                let _ = admin
                    .delete_subscription(
                        &path.tenant,
                        &path.namespace,
                        &path.topic,
                        &spec.subscription,
                        path.persistent,
                    )
                    .await;
            }
        }
    }

    let phase = if cancel.load(Ordering::Relaxed) {
        "stopped"
    } else {
        "completed"
    };
    emit_benchmark_progress(
        &emit,
        run_id,
        phase,
        &spec,
        &sent,
        &failed,
        &bytes_sent,
        &consumed,
        &samples,
        &last_error,
        started,
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn emit_benchmark_progress(
    emit: &Emit,
    run_id: &str,
    phase: &str,
    spec: &BenchmarkSpec,
    sent: &AtomicI64,
    failed: &AtomicI64,
    bytes_sent: &AtomicI64,
    consumed: &AtomicI64,
    samples: &Mutex<VecDeque<f64>>,
    last_error: &Mutex<Option<String>>,
    started: Instant,
) {
    let elapsed = started.elapsed();
    let snapshot = samples
        .lock()
        .map(|samples| samples.iter().copied().collect::<Vec<_>>())
        .unwrap_or_default();
    let latency = latency_of(&snapshot);
    let sent = sent.load(Ordering::Relaxed);
    let bytes = bytes_sent.load(Ordering::Relaxed);
    emit(
        "benchmark:progress",
        serde_json::json!({
            "runId": run_id,
            "phase": phase,
            "sent": sent,
            "failed": failed.load(Ordering::Relaxed),
            "consumed": consumed.load(Ordering::Relaxed),
            "totalMessages": spec.total,
            "messageSizeBytes": spec.message_size_bytes,
            "producerCount": spec.producers,
            "bytesSent": bytes,
            "elapsedMs": elapsed.as_millis() as i64,
            "msgPerSec": rate_of(sent, elapsed),
            "mbPerSec": rate_of(bytes, elapsed) / (1024.0 * 1024.0),
            "latency": latency,
            "lastError": last_error.lock().ok().and_then(|slot| slot.clone()),
            "done": phase != "running",
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(liveness: Arc<Liveness>, flow: Arc<AtomicBool>) -> Entry {
        let (tx, _rx) = mpsc::channel::<Command>(1);
        Entry {
            cluster_id: "c1".into(),
            topic_uri: "persistent://public/default/t".into(),
            producer_name: "producer-test".into(),
            owner_id: "owner".into(),
            started_at: pm_core::now_ms(),
            sent: Arc::new(AtomicI64::new(0)),
            failed: Arc::new(AtomicI64::new(0)),
            flow,
            connected: liveness,
            tx,
        }
    }

    #[test]
    fn liveness_follows_last_send_result() {
        let live = Liveness::new();
        assert!(live.is_connected(), "新会话按在线起步");
        live.mark_offline();
        assert!(!live.is_connected(), "最近一次发送失败之后就是已断开");
        live.mark_online();
        assert!(live.is_connected(), "再次发送成功说明底层已重连");
    }

    /// 会话视图的 `connected` 必须来自实际发送结果，不能再是写死的 true。
    #[test]
    fn session_view_reports_offline_after_failure() {
        let registry = ProducerRegistry::new();
        let liveness = Arc::new(Liveness::new());
        let flow = Arc::new(AtomicBool::new(false));
        registry.insert("s1".into(), entry(liveness.clone(), flow));

        assert!(registry.view("s1").expect("会话应在").connected);

        liveness.mark_offline();
        assert!(!registry.view("s1").expect("会话仍在").connected);
        let listed = registry.list(None);
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].connected, "列表也必须如实反映离线");

        liveness.mark_online();
        assert!(registry.view("s1").expect("会话仍在").connected);
    }

    /// 任务退出守卫：无论正常结束还是 panic，会话都要被摘掉且标记已断开。
    #[test]
    fn session_guard_clears_entry_and_marks_offline() {
        let registry = Arc::new(ProducerRegistry::new());
        let liveness = Arc::new(Liveness::new());
        let flow = Arc::new(AtomicBool::new(true));
        registry.insert("s1".into(), entry(liveness.clone(), flow.clone()));

        drop(SessionGuard {
            registry: registry.clone(),
            session_id: "s1".into(),
            liveness: liveness.clone(),
            flow: flow.clone(),
        });

        assert!(registry.view("s1").is_none(), "会话必须从注册表摘掉");
        assert!(registry.list(None).is_empty());
        assert!(!liveness.is_connected());
        assert!(!flow.load(Ordering::Relaxed));
    }
}
