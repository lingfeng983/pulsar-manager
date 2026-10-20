//! 消息会话：消费与回溯读取两条长连接的生命周期管理。
//!
//! 会话登记表按 sessionId 认领：多个页签指向同一个 topic 时，各自的批次只该进各自的界面，
//! 所以每条会话自带 mpsc 命令通道，停止/确认都发到它自己的任务里执行。

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pm_core::{
    AdminConfig, AppError, AppResult, ConsumeOptions, Message, MessageBatch, SessionEndEvent,
};
use pm_pulsar::native::NativeClient;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

/// 批次窗口：50 条 / 300ms / 8MB，与 Electron 版同一套阈值。
const BATCH_SIZE: usize = 50;
const BATCH_FLUSH_MS: u64 = 300;
const BATCH_MAX_BYTES: i64 = 8 * 1024 * 1024;
/// 回溯扫描的护栏：recent / timestamp / messageId 都没有锚点，只能从 earliest 扫过去
const SCAN_MAX_MESSAGES: i64 = 200_000;
const SCAN_TIMEOUT_MS: u64 = 30_000;

pub const CONSUME_BATCH: &str = "msg:consume-batch";
pub const READ_BATCH: &str = "msg:read-batch";
pub const SESSION_END: &str = "msg:session-end";

/// 事件推送句柄：由 RPC 层注入（Tauri 的 AppHandle 在服务层不出现）。
pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

#[derive(Debug, Clone, Serialize)]
pub struct ConsumeSessionView {
    pub session_id: String,
    pub cluster_id: String,
    pub topic_uri: String,
    pub subscription: String,
    pub consumer_name: String,
    pub subscription_type: String,
    pub auto_ack: bool,
    pub received: i64,
    pub pending_acks: i64,
    pub max_messages: i64,
    pub owner_id: String,
    pub started_at: i64,
}

enum Command {
    Stop,
    Ack {
        seqs: Vec<u64>,
        cumulative: bool,
        done: oneshot::Sender<AppResult<()>>,
    },
    Nack {
        seqs: Vec<u64>,
        done: oneshot::Sender<AppResult<()>>,
    },
}

struct Entry {
    #[allow(dead_code)]
    kind: &'static str,
    cluster_id: String,
    topic_uri: String,
    subscription: String,
    consumer_name: String,
    subscription_type: String,
    auto_ack: bool,
    max_messages: i64,
    owner_id: String,
    started_at: i64,
    received: Arc<AtomicI64>,
    pending: Arc<AtomicI64>,
    tx: mpsc::Sender<Command>,
}

/// 会话登记表。所有方法都很短，锁只护住 HashMap 本身。
#[derive(Default)]
pub struct SessionRegistry {
    entries: Mutex<HashMap<String, Entry>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list(&self, cluster_id: Option<&str>) -> Vec<ConsumeSessionView> {
        let entries = match self.entries.lock() {
            Ok(entries) => entries,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut views: Vec<ConsumeSessionView> = entries
            .iter()
            .filter(|(_, entry)| match cluster_id {
                Some(cluster) if !cluster.is_empty() => entry.cluster_id == cluster,
                _ => true,
            })
            .map(|(id, entry)| ConsumeSessionView {
                session_id: id.clone(),
                cluster_id: entry.cluster_id.clone(),
                topic_uri: entry.topic_uri.clone(),
                subscription: entry.subscription.clone(),
                consumer_name: entry.consumer_name.clone(),
                subscription_type: entry.subscription_type.clone(),
                auto_ack: entry.auto_ack,
                received: entry.received.load(Ordering::Relaxed),
                pending_acks: entry.pending.load(Ordering::Relaxed),
                max_messages: entry.max_messages,
                owner_id: entry.owner_id.clone(),
                started_at: entry.started_at,
            })
            .collect();
        views.sort_by_key(|view| std::cmp::Reverse(view.started_at));
        views
    }

    pub fn get(&self, session_id: &str) -> Option<i64> {
        let entries = match self.entries.lock() {
            Ok(entries) => entries,
            Err(poisoned) => poisoned.into_inner(),
        };
        entries
            .get(session_id)
            .map(|entry| entry.received.load(Ordering::Relaxed))
    }

    /// 停止一条会话：从登记表摘掉并让它的任务收尾。已经自己结束的会话返回 false。
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

    pub async fn ack(&self, session_id: &str, seqs: Vec<u64>, cumulative: bool) -> AppResult<()> {
        let tx = self.sender(session_id)?;
        let (done, wait) = oneshot::channel();
        tx.send(Command::Ack { seqs, cumulative, done })
            .await
            .map_err(|_| AppError::Other("会话已经结束了".into()))?;
        wait.await
            .map_err(|_| AppError::Other("会话已经结束了".into()))?
    }

    pub async fn nack(&self, session_id: &str, seqs: Vec<u64>) -> AppResult<()> {
        let tx = self.sender(session_id)?;
        let (done, wait) = oneshot::channel();
        tx.send(Command::Nack { seqs, done })
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

// ========== 消费会话 ==========

/// 起一条消费会话：连 broker、订阅、把批次按窗口推给界面。
pub async fn start_consume(
    registry: Arc<SessionRegistry>,
    config: &AdminConfig,
    options: ConsumeOptions,
    emit: Emit,
) -> AppResult<String> {
    let client = NativeClient::connect(config).await?;
    let mut consumer = client.open_consumer(&options).await?;

    let session_id = pm_core::new_id();
    let received = Arc::new(AtomicI64::new(0));
    let pending = Arc::new(AtomicI64::new(0));
    let (tx, mut rx) = mpsc::channel::<Command>(64);

    let consumer_name = format!("pulsar-manager-{}", &session_id[..8]);
    registry.insert(
        session_id.clone(),
        Entry {
            kind: "consume",
            cluster_id: options.cluster_id.clone(),
            topic_uri: options.topic.clone(),
            subscription: options.subscription.clone(),
            consumer_name: consumer_name.clone(),
            subscription_type: options.subscription_type.clone(),
            auto_ack: options.auto_ack,
            max_messages: options.max_messages,
            owner_id: options.owner_id.clone().unwrap_or_default(),
            started_at: pm_core::now_ms(),
            received: received.clone(),
            pending: pending.clone(),
            tx,
        },
    );

    let task_registry = registry.clone();
    let task_emit = emit.clone();
    let task_id = session_id.clone();
    let max_messages = options.max_messages;

    tokio::spawn(async move {
        let mut buffer: Vec<Message> = Vec::new();
        let mut buffer_bytes = 0i64;
        let mut last_flush = Instant::now();
        let mut ticker = tokio::time::interval(Duration::from_millis(100));
        // 每个 break 分支都会先写好原因，初始值只在循环意外结束时兜底
        #[allow(unused_assignments)]
        let mut reason = String::new();
        let mut detail: Option<String> = None;

        fn flush(
            emit: &Emit,
            channel: &str,
            session_id: &str,
            buffer: &mut Vec<Message>,
            buffer_bytes: &mut i64,
            last_flush: &mut Instant,
        ) {
            if buffer.is_empty() {
                return;
            }
            let batch = MessageBatch {
                session_id: session_id.to_string(),
                messages: std::mem::take(buffer),
            };
            if let Ok(payload) = serde_json::to_value(&batch) {
                emit(channel, payload);
            }
            *buffer_bytes = 0;
            *last_flush = Instant::now();
        }

        loop {
            let event = tokio::select! {
                item = consumer.next() => Event::Item(item),
                cmd = rx.recv() => Event::Cmd(cmd),
                _ = ticker.tick() => Event::Tick,
            };

            match event {
                Event::Item(Some(Ok(message))) => {
                    buffer_bytes += message.data_bytes;
                    buffer.push(message);
                    received.fetch_add(1, Ordering::Relaxed);
                    let hit_limit = max_messages > 0 && received.load(Ordering::Relaxed) >= max_messages;
                    if buffer.len() >= BATCH_SIZE
                        || buffer_bytes >= BATCH_MAX_BYTES
                        || last_flush.elapsed() >= Duration::from_millis(BATCH_FLUSH_MS)
                    {
                        // 手动确认模式下未确认条数就是待确认队列长度
                        pending.store(buffer.len() as i64, Ordering::Relaxed);
                        flush(&task_emit, CONSUME_BATCH, &task_id, &mut buffer, &mut buffer_bytes, &mut last_flush);
                    }
                    if hit_limit {
                        flush(&task_emit, CONSUME_BATCH, &task_id, &mut buffer, &mut buffer_bytes, &mut last_flush);
                        reason = "completed".into();
                        break;
                    }
                }
                Event::Item(Some(Err(error))) => {
                    flush(&task_emit, CONSUME_BATCH, &task_id, &mut buffer, &mut buffer_bytes, &mut last_flush);
                    reason = "error".into();
                    detail = Some(error.to_string());
                    break;
                }
                Event::Item(None) => {
                    flush(&task_emit, CONSUME_BATCH, &task_id, &mut buffer, &mut buffer_bytes, &mut last_flush);
                    reason = "completed".into();
                    break;
                }
                Event::Cmd(Some(Command::Stop)) | Event::Cmd(None) => {
                    flush(&task_emit, CONSUME_BATCH, &task_id, &mut buffer, &mut buffer_bytes, &mut last_flush);
                    reason = "stopped".into();
                    break;
                }
                Event::Cmd(Some(Command::Ack { seqs, cumulative, done })) => {
                    let mut result = Ok(());
                    for seq in seqs {
                        let outcome = if cumulative {
                            consumer.ack_cumulative(seq).await
                        } else {
                            consumer.ack(seq).await
                        };
                        if let Err(error) = outcome {
                            result = Err(error);
                            break;
                        }
                    }
                    if result.is_ok() {
                        let left = pending.load(Ordering::Relaxed);
                        pending.store((left - 1).max(0), Ordering::Relaxed);
                    }
                    let _ = done.send(result);
                }
                Event::Cmd(Some(Command::Nack { seqs, done })) => {
                    let mut result = Ok(());
                    for seq in seqs {
                        if let Err(error) = consumer.nack(seq).await {
                            result = Err(error);
                            break;
                        }
                    }
                    let _ = done.send(result);
                }
                Event::Tick => {
                    if !buffer.is_empty() && last_flush.elapsed() >= Duration::from_millis(BATCH_FLUSH_MS)
                    {
                        flush(&task_emit, CONSUME_BATCH, &task_id, &mut buffer, &mut buffer_bytes, &mut last_flush);
                    }
                }
            }
        }

        consumer.close().await;
        task_registry.remove(&task_id);
        let event = SessionEndEvent {
            session_id: task_id,
            // 没走到任何 break 分支就退出循环时按「已停止」收尾
            reason: if reason.is_empty() { "stopped".to_string() } else { reason },
            detail,
        };
        if let Ok(payload) = serde_json::to_value(&event) {
            task_emit(SESSION_END, payload);
        }
    });

    Ok(session_id)
}

// ========== 回溯读取 ==========

#[derive(Debug, Clone, Default)]
pub struct ReadRequest {
    pub cluster_id: String,
    pub topic_uri: String,
    /// earliest / latest / timestamp / recent / messageId
    pub from: String,
    pub timestamp: Option<i64>,
    pub max_messages: i64,
    pub recent_count: i64,
    pub message_id: Option<String>,
    pub owner_id: String,
}

/// 起一条回溯读取：Reader 不建订阅、不确认，读满即撤。
pub async fn start_read(
    registry: Arc<SessionRegistry>,
    config: &AdminConfig,
    request: ReadRequest,
    emit: Emit,
) -> AppResult<String> {
    let scan = !matches!(request.from.as_str(), "earliest" | "latest");
    let client = NativeClient::connect(config).await?;
    let mut reader = client.open_reader(&request.topic_uri, true).await?;

    let session_id = pm_core::new_id();
    let received = Arc::new(AtomicI64::new(0));
    let (tx, mut rx) = mpsc::channel::<Command>(16);
    registry.insert(
        session_id.clone(),
        Entry {
            kind: "read",
            cluster_id: request.cluster_id.clone(),
            topic_uri: request.topic_uri.clone(),
            subscription: String::new(),
            consumer_name: String::new(),
            subscription_type: "Reader".into(),
            auto_ack: true,
            max_messages: request.max_messages,
            owner_id: request.owner_id.clone(),
            started_at: pm_core::now_ms(),
            received: received.clone(),
            pending: Arc::new(AtomicI64::new(0)),
            tx,
        },
    );

    let task_registry = registry.clone();
    let task_emit = emit.clone();
    let task_id = session_id.clone();

    tokio::spawn(async move {
        let mut buffer: Vec<Message> = Vec::new();
        let mut last_flush = Instant::now();
        let mut ticker = tokio::time::interval(Duration::from_millis(250));
        let mut reason = "completed".to_string();
        let mut detail: Option<String> = None;
        let mut scanned = 0i64;
        let mut collecting = !scan;
        // recent：整段扫完再留最后 N 条，所以先攒着
        let mut tail: Vec<Message> = Vec::new();
        let started = Instant::now();

        loop {
            let event = tokio::select! {
                item = reader.next() => Event::Item(item),
                cmd = rx.recv() => Event::Cmd(cmd),
                _ = ticker.tick() => Event::Tick,
            };

            match event {
                Event::Item(Some(Ok(message))) => {
                    scanned += 1;
                    match request.from.as_str() {
                        "recent" => {
                            tail.push(message);
                            if tail.len() as i64 > request.recent_count.max(1) {
                                tail.remove(0);
                            }
                            if scanned >= SCAN_MAX_MESSAGES
                                || started.elapsed() >= Duration::from_millis(SCAN_TIMEOUT_MS)
                            {
                                detail = Some("扫描到护栏上限，只给出已扫到的最后几条".into());
                                break;
                            }
                        }
                        "timestamp" | "messageId" => {
                            if !collecting {
                                collecting = match request.from.as_str() {
                                    "timestamp" => message.publish_time
                                        >= request.timestamp.unwrap_or(0),
                                    _ => request
                                        .message_id
                                        .as_deref()
                                        .map(|id| id == message.message_id)
                                        .unwrap_or(false),
                                };
                                if !collecting {
                                    if scanned >= SCAN_MAX_MESSAGES
                                        || started.elapsed()
                                            >= Duration::from_millis(SCAN_TIMEOUT_MS)
                                    {
                                        detail = Some("没扫到起点（消息可能已过期），请换个起点再试".into());
                                        reason = "error".into();
                                        break;
                                    }
                                    continue;
                                }
                            }
                            buffer.push(message);
                            received.fetch_add(1, Ordering::Relaxed);
                        }
                        _ => {
                            buffer.push(message);
                            received.fetch_add(1, Ordering::Relaxed);
                        }
                    }

                    let hit_limit =
                        request.max_messages > 0 && received.load(Ordering::Relaxed) >= request.max_messages;
                    if buffer.len() >= BATCH_SIZE
                        || last_flush.elapsed() >= Duration::from_millis(BATCH_FLUSH_MS)
                        || hit_limit
                    {
                        flush_read(&task_emit, &task_id, &mut buffer, &mut last_flush);
                    }
                    if hit_limit {
                        break;
                    }
                }
                Event::Item(Some(Err(error))) => {
                    detail = Some(error.to_string());
                    reason = "error".into();
                    break;
                }
                Event::Item(None) => break,
                Event::Cmd(Some(Command::Stop)) | Event::Cmd(None) => {
                    reason = "stopped".into();
                    break;
                }
                Event::Cmd(Some(Command::Ack { done, .. })) | Event::Cmd(Some(Command::Nack { done, .. })) => {
                    // 回溯读取不确认：明确回一句，而不是让界面以为成功了
                    let _ = done.send(Err(AppError::Unsupported(
                        "回溯读取不确认消息：它不建订阅，读完即撤".into(),
                    )));
                }
                Event::Tick => {
                    if !buffer.is_empty() && last_flush.elapsed() >= Duration::from_millis(BATCH_FLUSH_MS) {
                        flush_read(&task_emit, &task_id, &mut buffer, &mut last_flush);
                    }
                }
            }
        }

        // recent：扫完才把最后 N 条一次性推出去
        if request.from == "recent" {
            for message in tail {
                received.fetch_add(1, Ordering::Relaxed);
                buffer.push(message);
            }
            flush_read(&task_emit, &task_id, &mut buffer, &mut last_flush);
        } else {
            flush_read(&task_emit, &task_id, &mut buffer, &mut last_flush);
        }

        reader.close().await;
        task_registry.remove(&task_id);
        let event = SessionEndEvent {
            session_id: task_id,
            reason,
            detail,
        };
        if let Ok(payload) = serde_json::to_value(&event) {
            task_emit(SESSION_END, payload);
        }
    });

    Ok(session_id)
}

fn flush_read(emit: &Emit, session_id: &str, buffer: &mut Vec<Message>, last_flush: &mut Instant) {
    if buffer.is_empty() {
        return;
    }
    let batch = MessageBatch {
        session_id: session_id.to_string(),
        messages: std::mem::take(buffer),
    };
    if let Ok(payload) = serde_json::to_value(&batch) {
        emit(READ_BATCH, payload);
    }
    *last_flush = Instant::now();
}

enum Event {
    Item(Option<AppResult<Message>>),
    Cmd(Option<Command>),
    Tick,
}

// ========== 一次性操作 ==========

/// 发一条消息并返回 messageId。
pub async fn send_once(config: &AdminConfig, options: &pm_core::SendOptions) -> AppResult<String> {
    let client = NativeClient::connect(config).await?;
    client.send(options).await
}

/// 偷看：给目标订阅临时挂一条 Shared 消费者的等效做法——建 Reader 读几条就撤。
///
/// Reader 不碰订阅游标，这是「只是看一眼」的正确语义；调用方已确认订阅存在，
/// 所以这里不会顺手在集群上留下一个从最早位置开始的新订阅。
pub async fn peek(
    config: &AdminConfig,
    topic_uri: &str,
    max_messages: i64,
) -> AppResult<(Vec<Message>, Option<String>)> {
    let client = NativeClient::connect(config).await?;
    let mut reader = client.open_reader(topic_uri, true).await?;
    let want = max_messages.clamp(1, 200);
    let mut messages = Vec::new();
    let mut note = None;
    let deadline = Instant::now() + Duration::from_millis(5_000);
    while (messages.len() as i64) < want {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            note = Some("取数超时：这段时间里没有新消息，已返回取到的部分".to_string());
            break;
        }
        match tokio::time::timeout(remaining, reader.next()).await {
            Err(_) => {
                note = Some("取数超时：这段时间里没有新消息，已返回取到的部分".to_string());
                break;
            }
            Ok(None) => break,
            Ok(Some(Err(error))) => {
                note = Some(format!("读取中断：{error}"));
                break;
            }
            Ok(Some(Ok(message))) => messages.push(message),
        }
    }
    reader.close().await;
    Ok((messages, note))
}
