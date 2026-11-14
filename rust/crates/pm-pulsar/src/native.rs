use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use futures::TryStreamExt;
use pm_core::{AdminConfig, AppError, AppResult, ConsumeOptions, Message, SendOptions, TopicPath};
use pulsar::compression::{Compression, CompressionLz4, CompressionZlib, CompressionZstd};
use pulsar::consumer::{ConsumerOptions, InitialPosition};
use pulsar::{producer, Authentication, Consumer, Pulsar, SubType, TokioExecutor};

use crate::AdminClient;

/// 手动确认窗口：超过这个数量后最旧的 id 被淘汰，界面再确认会得到
/// 「已超出可确认窗口」，而不是让向量随会话无限增长。
const ACK_WINDOW: usize = 10_000;

/// `ledger:entry:partition[:batchIndex]`：同一 entry 里的批消息只靠 batchIndex 区分，
/// 丢掉它会让界面按 ID 去重时把同批后续消息吞掉。
pub fn format_message_id(id: &pulsar::message::proto::MessageIdData) -> String {
    let base = format!(
        "{}:{}:{}",
        id.ledger_id,
        id.entry_id,
        id.partition.unwrap_or(-1)
    );
    match id.batch_index.filter(|index| *index >= 0) {
        Some(index) => format!("{base}:{index}"),
        None => base,
    }
}

/// 按 ID 定位：三段的旧 ID（历史记录里存的）命中该 entry 的第一条批消息。
pub fn message_id_matches(wanted: &str, actual: &str) -> bool {
    let wanted = wanted.trim();
    if wanted.is_empty() {
        return false;
    }
    if wanted == actual {
        return true;
    }
    wanted.split(':').count() == 3
        && actual
            .strip_prefix(wanted)
            .is_some_and(|rest| rest.starts_with(':'))
}

const OUT_OF_WINDOW: &str = "该消息已超出可确认窗口，将由 broker 重投";

/// 手动确认窗口：按递增序号保存条目，并记住哪些已确认 / 已重投。
/// 「全部确认」和待确认计数都以它为准，而不是以界面上的批次长度为准。
pub struct AckWindow<T> {
    entries: VecDeque<(T, bool)>,
    base: u64,
    capacity: usize,
}

impl<T: Clone> AckWindow<T> {
    pub fn new(capacity: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            base: 0,
            capacity: capacity.max(1),
        }
    }

    pub fn push(&mut self, item: T) -> u64 {
        self.entries.push_back((item, false));
        if self.entries.len() > self.capacity {
            self.entries.pop_front();
            self.base += 1;
        }
        self.base + self.entries.len() as u64 - 1
    }

    pub fn get(&self, seq: u64) -> AppResult<T> {
        seq.checked_sub(self.base)
            .and_then(|index| self.entries.get(index as usize))
            .map(|(item, _)| item.clone())
            .ok_or_else(|| AppError::Other(OUT_OF_WINDOW.into()))
    }

    pub fn resolve(&mut self, seq: u64) {
        if let Some(entry) = seq
            .checked_sub(self.base)
            .and_then(|index| self.entries.get_mut(index as usize))
        {
            entry.1 = true;
        }
    }

    pub fn resolve_through(&mut self, seq: u64) {
        let Some(last) = seq.checked_sub(self.base) else {
            return;
        };
        for entry in self.entries.iter_mut().take(last as usize + 1) {
            entry.1 = true;
        }
    }

    pub fn pending_count(&self) -> i64 {
        self.entries
            .iter()
            .filter(|(_, resolved)| !resolved)
            .count() as i64
    }

    fn pending_seqs(&self) -> impl Iterator<Item = u64> + '_ {
        self.entries
            .iter()
            .enumerate()
            .filter(|(_, (_, resolved))| !resolved)
            .map(|(index, _)| self.base + index as u64)
    }

    /// 空 seqs 表示「窗口里全部待确认」；累计确认只需要最后一条。
    pub fn targets(&self, seqs: Vec<u64>, cumulative: bool) -> Vec<u64> {
        if !seqs.is_empty() {
            return seqs;
        }
        if cumulative {
            self.pending_seqs().last().into_iter().collect()
        } else {
            self.pending_seqs().collect()
        }
    }
}

/// 原生协议客户端（纯 Rust 的 `pulsar` crate，不依赖 pulsar-client-cpp）。
/// Admin REST 只能改资源，收发消息必须走 broker 的二进制口。
pub struct NativeClient {
    pulsar: Pulsar<TokioExecutor>,
    /// 定位分区数要用 Admin REST；Reader 只允许单分区 topic。
    config: AdminConfig,
}

impl NativeClient {
    pub async fn connect(config: &AdminConfig) -> AppResult<Self> {
        let endpoint = pm_core::redact_endpoint(&config.service_url);
        pm_core::pm_log!("[pulsar] 连接 {endpoint}");
        let mut builder = Pulsar::builder(config.service_url.clone(), TokioExecutor);
        if let Some(token) = config.auth_params.clone().filter(|token| !token.is_empty()) {
            builder = builder.with_auth(Authentication {
                name: config.auth_plugin.clone().unwrap_or_else(|| "token".into()),
                data: token.into_bytes(),
            });
        }
        let pulsar = match builder.build().await {
            Ok(pulsar) => pulsar,
            Err(error) => {
                pm_core::pm_warn!("[pulsar] 连接 {endpoint} 失败：{error}");
                return Err(AppError::Network(format!(
                    "连接 broker 二进制口失败: {error}"
                )));
            }
        };
        pm_core::pm_log!("[pulsar] 已连接 {endpoint}");
        Ok(Self {
            pulsar,
            config: config.clone(),
        })
    }

    pub async fn send(&self, options: &SendOptions) -> AppResult<String> {
        pm_core::pm_log!(
            "[pulsar] 发送 topic={} bytes={}",
            options.topic,
            options.message.len()
        );
        let mut producer = match self
            .pulsar
            .producer()
            .with_topic(options.topic.clone())
            .build()
            .await
        {
            Ok(producer) => producer,
            Err(error) => {
                pm_core::pm_warn!(
                    "[pulsar] 创建 producer 失败 topic={}：{error}",
                    options.topic
                );
                return Err(AppError::Network(format!("创建 producer 失败: {error}")));
            }
        };

        let mut properties = HashMap::new();
        for (key, value) in &options.properties {
            properties.insert(key.clone(), value.clone());
        }
        let message = producer::Message {
            payload: options.message.as_bytes().to_vec(),
            properties,
            partition_key: options
                .partition_key
                .clone()
                .or_else(|| options.key.clone()),
            event_time: options.event_time.map(|value| value as u64),
            deliver_at_time: options
                .deliver_after_ms
                .filter(|delay| *delay > 0)
                .map(|delay| pm_core::now_ms() + delay),
            ..Default::default()
        };

        let receipt = producer
            .send_non_blocking(message)
            .await
            .map_err(|e| AppError::Other(format!("发送失败: {e}")))?
            .await
            .map_err(|e| AppError::Other(format!("broker 未确认消息: {e}")))?;

        let id = receipt
            .message_id
            .as_ref()
            .map(format_message_id)
            .unwrap_or_else(|| "sent".to_string());

        let _ = producer.close().await;
        pm_core::pm_log!("[pulsar] 发送成功 topic={} messageId={id}", options.topic);
        Ok(id)
    }

    pub async fn open_consumer(&self, options: &ConsumeOptions) -> AppResult<NativeConsumer> {
        pm_core::pm_log!(
            "[pulsar] 订阅 topic={} subscription={} type={}",
            options.topic,
            options.subscription,
            options.subscription_type
        );
        let subscription_type = match options.subscription_type.as_str() {
            "Exclusive" | "exclusive" => SubType::Exclusive,
            "Failover" | "failover" => SubType::Failover,
            "Key_Shared" | "KeyShared" | "key_shared" => SubType::KeyShared,
            _ => SubType::Shared,
        };
        let initial_position = if options.initial_position.eq_ignore_ascii_case("earliest") {
            InitialPosition::Earliest
        } else {
            InitialPosition::Latest
        };
        let consumer_options = ConsumerOptions {
            initial_position,
            receiver_queue_size: options
                .receiver_queue_size
                .map(|size| size.clamp(1, 10_000) as u32),
            ..Default::default()
        };
        // 界面上填的名字要真的交给 broker，否则 broker 侧永远只有随机名。
        let consumer_name = options
            .consumer_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("pulsar-manager-{}", &pm_core::new_id()[..8]));
        // pulsar crate 只提供「未确认消息重投延迟」，把 ackTimeout 作为没有单独
        // nAckRedeliver 时的兜底，两者都不再静默失效。
        let resend_delay = options
            .n_ack_redeliver_timeout_ms
            .or(options.ack_timeout_ms)
            .filter(|value| *value > 0)
            .map(|value| Duration::from_millis(value as u64));

        let mut builder = self
            .pulsar
            .consumer()
            .with_topic(options.topic.clone())
            .with_consumer_name(consumer_name)
            .with_subscription(options.subscription.clone())
            .with_subscription_type(subscription_type)
            .with_options(consumer_options);
        if let Some(delay) = resend_delay {
            builder = builder.with_unacked_message_resend_delay(Some(delay));
        }
        let consumer: Consumer<Vec<u8>, TokioExecutor> = builder.build().await.map_err(|e| {
            pm_core::pm_warn!(
                "[pulsar] 订阅失败 topic={} subscription={}：{e}",
                options.topic,
                options.subscription
            );
            AppError::Network(format!("订阅失败: {e}"))
        })?;

        pm_core::pm_log!(
            "[pulsar] 订阅成功 topic={} subscription={}",
            options.topic,
            options.subscription
        );
        Ok(NativeConsumer {
            consumer,
            topic: options.topic.clone(),
            auto_ack: options.auto_ack,
            max_messages: options.max_messages,
            received: 0,
            ackable: AckWindow::new(ACK_WINDOW),
        })
    }
}

pub struct NativeConsumer {
    consumer: Consumer<Vec<u8>, TokioExecutor>,
    topic: String,
    auto_ack: bool,
    max_messages: i64,
    received: i64,
    /// 手动确认模式下保留最近一批消息 id：界面按 ackSeq 回调确认。
    /// 同时记下消息来自的实际 topic：分区 topic 的多消费者按分区 URI 找连接。
    ackable: AckWindow<(String, pulsar::message::proto::MessageIdData)>,
}

impl NativeConsumer {
    pub fn finished(&self) -> bool {
        self.max_messages > 0 && self.received >= self.max_messages
    }

    /// 收一条消息。返回 None 表示流结束（broker 关闭或到达条数上限）。
    pub async fn next(&mut self) -> Option<AppResult<Message>> {
        if self.finished() {
            return None;
        }
        match self.consumer.try_next().await {
            Ok(None) => None,
            Err(error) => {
                pm_core::pm_warn!(
                    "[pulsar] 消费失败 topic={} subscription 读取中断：{error}",
                    self.topic
                );
                Some(Err(AppError::Network(format!("消费失败: {error}"))))
            }
            Ok(Some(message)) => {
                let metadata = message.metadata().clone();
                let id_data = message.message_id().clone();
                let payload = message.deserialize();
                let data_bytes = payload.len() as i64;
                let ack_seq = if self.auto_ack {
                    if let Err(error) = self.consumer.ack(&message).await {
                        return Some(Err(AppError::Other(format!("自动确认失败: {error}"))));
                    }
                    None
                } else {
                    Some(self.ackable.push((message.topic.clone(), id_data.clone())))
                };

                let properties = metadata
                    .properties
                    .iter()
                    .map(|kv| (kv.key.clone(), kv.value.clone()))
                    .collect();

                self.received += 1;
                Some(Ok(Message {
                    message_id: format_message_id(&id_data),
                    topic_name: self.topic.clone(),
                    producer_name: metadata.producer_name.clone(),
                    publish_time: metadata.publish_time as i64,
                    event_time: metadata.event_time.unwrap_or(metadata.publish_time) as i64,
                    properties,
                    data: String::from_utf8_lossy(&payload).to_string(),
                    partition_key: metadata.partition_key.clone(),
                    redelivery_count: 0,
                    ackable: true,
                    ack_seq,
                    data_bytes,
                }))
            }
        }
    }

    pub fn pending_count(&self) -> i64 {
        self.ackable.pending_count()
    }

    pub fn ack_targets(&self, seqs: Vec<u64>, cumulative: bool) -> Vec<u64> {
        self.ackable.targets(seqs, cumulative)
    }

    pub async fn ack(&mut self, seq: u64) -> AppResult<()> {
        let (topic, id) = self.ackable.get(seq)?;
        self.consumer
            .ack_with_id(&topic, id)
            .await
            .map_err(|e| AppError::Other(format!("确认失败: {e}")))?;
        self.ackable.resolve(seq);
        Ok(())
    }

    /// 累积确认：把某条之前（含）的全部消息一并确认，只对流式可累计的订阅类型有意义。
    pub async fn ack_cumulative(&mut self, seq: u64) -> AppResult<()> {
        let (topic, id) = self.ackable.get(seq)?;
        self.consumer
            .cumulative_ack_with_id(&topic, id)
            .await
            .map_err(|e| AppError::Other(format!("累计确认失败: {e}")))?;
        self.ackable.resolve_through(seq);
        Ok(())
    }

    /// 主动重投：把这条放回队列，别的消费者（或本轮之后）会再收到它。
    pub async fn nack(&mut self, seq: u64) -> AppResult<()> {
        let (topic, id) = self.ackable.get(seq)?;
        self.consumer
            .nack_with_id(&topic, id)
            .await
            .map_err(|e| AppError::Other(format!("重投失败: {e}")))?;
        self.ackable.resolve(seq);
        Ok(())
    }

    pub async fn close(mut self) {
        let _ = self.consumer.close().await;
    }
}

/// 回溯读取器（Reader）：不建订阅、不确认、读完即撤。
///
/// 原生 Reader 只有「从某个 messageId 开始」这一个锚点，没有「从末尾倒数 N 条」，
/// broker 也没有 lastMessageId 的 REST 路由，所以 recent / timestamp / messageId 这三种
/// 起点的实现都是从 earliest 扫过去再由调用方筛，护栏由调用方给（扫描上限 + 超时）。
pub struct NativeReader {
    /// 每个分区一个 Reader，后台任务把消息汇到同一个通道；分区 0 没消息时
    /// 不会挡住分区 1 的消息。
    rx: tokio::sync::mpsc::Receiver<AppResult<Message>>,
    topic: String,
    /// 关闭时唤醒仍阻塞在 try_next() 的分区任务，避免连接一直挂着。
    stop: tokio::sync::watch::Sender<bool>,
}

impl NativeReader {
    pub fn topic(&self) -> &str {
        &self.topic
    }

    pub async fn next(&mut self) -> Option<AppResult<Message>> {
        self.rx.recv().await
    }

    pub async fn close(self) {
        // 先通知分区任务退出，再丢掉接收端；否则停在 try_next 的任务会一直占着连接。
        let _ = self.stop.send(true);
        drop(self);
    }
}

/// 把 pulsar crate 的消费消息转成界面用的 `Message`；Reader 与 Consumer 共用。
fn into_message(topic: &str, message: pulsar::consumer::Message<Vec<u8>>) -> Message {
    let metadata = message.metadata().clone();
    let id_data = message.message_id().clone();
    let payload = message.deserialize();
    let data_bytes = payload.len() as i64;
    Message {
        message_id: format_message_id(&id_data),
        topic_name: topic.to_string(),
        producer_name: metadata.producer_name.clone(),
        publish_time: metadata.publish_time as i64,
        event_time: metadata.event_time.unwrap_or(metadata.publish_time) as i64,
        properties: metadata
            .properties
            .iter()
            .map(|kv| (kv.key.clone(), kv.value.clone()))
            .collect(),
        data: String::from_utf8_lossy(&payload).to_string(),
        partition_key: metadata.partition_key.clone(),
        redelivery_count: 0,
        // 回溯读取不确认，界面上不该出现「确认」按钮
        ackable: false,
        ack_seq: None,
        data_bytes,
    }
}

impl NativeClient {
    /// 长连接生产者：工作台的一条会话对应这里的一个 NativeProducer。
    pub async fn open_producer(&self, topic: &str) -> AppResult<NativeProducer> {
        self.open_producer_with(topic, NativeProducerOptions::default())
            .await
    }

    /// 带生产选项的版本：压测要按界面选择开压缩/批量。选项不暴露 pulsar 类型，
    /// 具体映射在 `NativeProducerOptions::into_pulsar` 里完成。
    pub async fn open_producer_with(
        &self,
        topic: &str,
        options: NativeProducerOptions,
    ) -> AppResult<NativeProducer> {
        let inner = self
            .pulsar
            .producer()
            .with_topic(topic.to_string())
            .with_name(format!("pulsar-manager-{}", &pm_core::new_id()[..8]))
            .with_options(options.into_pulsar())
            .build()
            .await
            .map_err(|e| AppError::Network(format!("创建 producer 失败: {e}")))?;
        Ok(NativeProducer { inner })
    }

    /// 把界面的压缩名映射成 crate 的枚举；未知值保持不压缩。
    pub fn compression_from(name: &str) -> Compression {
        match name.trim().to_ascii_uppercase().as_str() {
            "LZ4" => Compression::Lz4(CompressionLz4::default()),
            "ZLIB" => Compression::Zlib(CompressionZlib::default()),
            "ZSTD" => Compression::Zstd(CompressionZstd::default()),
            _ => Compression::None,
        }
    }

    /// `from_earliest` 决定 Reader 的起点：recent / timestamp / messageId 都要从最早开始扫。
    ///
    /// pulsar crate 的 Reader 只允许单分区 topic，所以先通过 Admin REST 拿分区列表，
    /// 每个分区起一个 Reader 再把消息汇进同一个通道；分区 topic 不再直接报
    /// 「one topic partition max」。
    pub async fn open_reader(&self, topic: &str, from_earliest: bool) -> AppResult<NativeReader> {
        let mut targets = vec![topic.to_string()];
        if let Ok(path) = TopicPath::parse(topic) {
            if let Ok(admin) = AdminClient::new(&self.config) {
                if let Ok(partitions) = admin
                    .topic_partitions(&path.tenant, &path.namespace, &path.topic, path.persistent)
                    .await
                {
                    if !partitions.is_empty() {
                        targets = partitions;
                    }
                }
            }
        }

        let (tx, rx) = tokio::sync::mpsc::channel::<AppResult<Message>>(64);
        let (stop, stop_rx) = tokio::sync::watch::channel(false);
        for target in targets {
            let options = ConsumerOptions::default()
                .durable(false)
                .with_initial_position(if from_earliest {
                    InitialPosition::Earliest
                } else {
                    InitialPosition::Latest
                });
            let mut reader: pulsar::reader::Reader<Vec<u8>, TokioExecutor> = self
                .pulsar
                .reader()
                .with_topic(target.clone())
                .with_consumer_name(format!("pulsar-manager-reader-{}", &pm_core::new_id()[..8]))
                .with_options(options)
                .into_reader()
                .await
                .map_err(|e| AppError::Network(format!("创建回溯读取器失败（{target}）: {e}")))?;
            let tx = tx.clone();
            let mut stop_rx = stop_rx.clone();
            let topic_name = topic.to_string();
            tokio::spawn(async move {
                loop {
                    let next = tokio::select! {
                        changed = stop_rx.changed() => {
                            let _ = changed;
                            break;
                        }
                        next = reader.try_next() => next,
                    };
                    match next {
                        Ok(Some(message)) => {
                            if tx
                                .send(Ok(into_message(&topic_name, message)))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        Ok(None) => break,
                        Err(error) => {
                            let _ = tx
                                .send(Err(AppError::Network(format!("读取失败: {error}"))))
                                .await;
                            break;
                        }
                    }
                }
            });
        }
        drop(tx);
        drop(stop_rx);
        Ok(NativeReader {
            rx,
            topic: topic.to_string(),
            stop,
        })
    }
}

// ========== 长连接生产者：broker 二进制口 I/O 只留在 pm-pulsar ==========

/// 一条待发消息：只承载界面语义的字段，不暴露 `pulsar::producer::Message`。
/// pm-services 填好它交给 `NativeProducer`，由本层翻译成 crate 的消息类型。
#[derive(Debug, Clone, Default)]
pub struct ProducerMessage {
    pub payload: Vec<u8>,
    pub properties: HashMap<String, String>,
    pub partition_key: Option<String>,
    pub event_time: Option<u64>,
    pub deliver_at_time: Option<i64>,
}

impl ProducerMessage {
    fn into_pulsar(self) -> producer::Message {
        producer::Message {
            payload: self.payload,
            properties: self.properties,
            partition_key: self.partition_key,
            event_time: self.event_time,
            deliver_at_time: self.deliver_at_time,
            ..Default::default()
        }
    }
}

/// 生产选项：同样不暴露 pulsar 的 `ProducerOptions` / `Compression`。
/// 批量的具体阈值与压缩名映射都留在 pm-pulsar，pm-services 只表达「是否批量、用哪种压缩」。
#[derive(Debug, Clone, Default)]
pub struct NativeProducerOptions {
    pub batching: bool,
    pub compression: String,
}

impl NativeProducerOptions {
    fn into_pulsar(self) -> producer::ProducerOptions {
        producer::ProducerOptions {
            batch_size: self.batching.then_some(100),
            batch_byte_size: self.batching.then_some(128 * 1024),
            batch_timeout: self.batching.then_some(Duration::from_millis(10)),
            compression: if self.compression.is_empty() {
                None
            } else {
                Some(NativeClient::compression_from(&self.compression))
            },
            ..Default::default()
        }
    }
}

/// 长连接生产者：把裸 `pulsar::Producer<TokioExecutor>` 包起来，收发相关方法只以
/// pm-core / 基础类型的形式对外暴露，pm-services 因此不必依赖 pulsar crate。
pub struct NativeProducer {
    inner: pulsar::Producer<TokioExecutor>,
}

/// 一次已入队的发送：把 crate 的确认 future 包成不暴露 pulsar 类型的 future。
/// 压测先释放 producer 的锁再 await 它，靠这个维持同一 producer 上多个在途消息
/// （max_in_flight 的并发度），不因封装而被迫串行。
pub struct PendingSend {
    inner: std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<String>> + Send>>,
}

impl std::future::Future for PendingSend {
    type Output = AppResult<String>;

    fn poll(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        // 字段是 Pin<Box<..>>，整体 Unpin，可直接拿到可变借用再 poll 内部 future
        self.get_mut().inner.as_mut().poll(cx)
    }
}

impl NativeProducer {
    /// 入队一条消息。错误分类与旧的裸调用一致：入队失败是「发送失败」，
    /// broker 没确认是「broker 未确认消息」（后者在 PendingSend 完成时判定）。
    pub async fn enqueue(&mut self, message: ProducerMessage) -> AppResult<PendingSend> {
        let send = self
            .inner
            .send_non_blocking(message.into_pulsar())
            .await
            .map_err(|e| AppError::Other(format!("发送失败: {e}")))?;
        Ok(PendingSend {
            inner: Box::pin(async move {
                let receipt = send
                    .await
                    .map_err(|e| AppError::Other(format!("broker 未确认消息: {e}")))?;
                Ok(receipt
                    .message_id
                    .as_ref()
                    .map(format_message_id)
                    .unwrap_or_else(|| "sent".to_string()))
            }),
        })
    }

    /// 发送并等确认，返回 messageId（`ledger:entry:partition`）；broker 未给 id 时为 "sent"。
    /// 参数承载 payload / properties / partition_key / event_time / deliver_at_time。
    pub async fn send_one(&mut self, message: ProducerMessage) -> AppResult<String> {
        self.enqueue(message).await?.await
    }

    /// 把批量队列最后一段推出去。返回 AppResult 供调用方按需判断（现有调用点忽略它）。
    pub async fn send_batch(&mut self) -> AppResult<()> {
        self.inner
            .send_batch()
            .await
            .map_err(|e| AppError::Other(e.to_string()))
    }

    /// 关闭 producer。现有调用点忽略返回值。
    pub async fn close(&mut self) -> AppResult<()> {
        self.inner
            .close()
            .await
            .map_err(|e| AppError::Other(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pulsar::message::proto::MessageIdData;

    fn id(batch_index: Option<i32>) -> MessageIdData {
        MessageIdData {
            ledger_id: 7,
            entry_id: 3,
            partition: Some(1),
            batch_index,
            ..Default::default()
        }
    }

    #[test]
    fn batched_messages_get_distinct_ids() {
        assert_eq!(format_message_id(&id(Some(0))), "7:3:1:0");
        assert_eq!(format_message_id(&id(Some(2))), "7:3:1:2");
    }

    #[test]
    fn unbatched_message_keeps_three_segments() {
        assert_eq!(format_message_id(&id(None)), "7:3:1");
        assert_eq!(format_message_id(&id(Some(-1))), "7:3:1");
    }

    #[test]
    fn legacy_three_segment_id_still_locates_entry() {
        assert!(message_id_matches("7:3:1", "7:3:1:0"));
        assert!(message_id_matches("7:3:1:2", "7:3:1:2"));
        assert!(!message_id_matches("7:3:1:2", "7:3:1:0"));
        assert!(!message_id_matches("7:3:10", "7:3:1:0"));
        assert!(!message_id_matches(" ", "7:3:1"));
    }

    #[test]
    fn ack_all_targets_every_pending_seq() {
        let mut window = AckWindow::new(10);
        for item in ["a", "b", "c"] {
            window.push(item);
        }
        window.resolve(1);
        assert_eq!(window.targets(Vec::new(), false), vec![0, 2]);
        assert_eq!(window.targets(Vec::new(), true), vec![2]);
        assert_eq!(window.targets(vec![1], false), vec![1]);
    }

    #[test]
    fn pending_count_follows_resolution() {
        let mut window = AckWindow::new(10);
        for item in ["a", "b", "c", "d"] {
            window.push(item);
        }
        assert_eq!(window.pending_count(), 4);
        window.resolve(0);
        assert_eq!(window.pending_count(), 3);
        window.resolve_through(2);
        assert_eq!(window.pending_count(), 1);
        assert_eq!(window.targets(Vec::new(), false), vec![3]);
    }

    #[test]
    fn evicted_seq_is_reported_out_of_window() {
        let mut window = AckWindow::new(2);
        for item in ["a", "b", "c"] {
            window.push(item);
        }
        assert!(window.get(0).is_err());
        assert_eq!(window.get(2).unwrap(), "c");
        assert_eq!(window.pending_count(), 2);
        assert_eq!(window.targets(Vec::new(), false), vec![1, 2]);
    }
}
