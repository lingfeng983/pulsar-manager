use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use futures::TryStreamExt;
use pm_core::{AdminConfig, AppError, AppResult, ConsumeOptions, Message, SendOptions, TopicPath};
use pulsar::compression::{Compression, CompressionLz4, CompressionZlib, CompressionZstd};
use pulsar::consumer::{ConsumerOptions, InitialPosition};
use pulsar::producer::ProducerOptions;
use pulsar::{producer, Authentication, Consumer, Pulsar, SubType, TokioExecutor};

use crate::AdminClient;

/// 手动确认窗口：超过这个数量后最旧的 id 被淘汰，界面再确认会得到
/// 「已超出可确认窗口」，而不是让向量随会话无限增长。
const ACK_WINDOW: usize = 10_000;

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
            .map(|id| {
                format!(
                    "{}:{}:{}",
                    id.ledger_id,
                    id.entry_id,
                    id.partition.unwrap_or(-1)
                )
            })
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
            ackable: VecDeque::new(),
            ack_base: 0,
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
    /// `ack_base` 是最旧一条的序号，窗口淘汰后序号不会整体前移造成错位。
    ackable: VecDeque<pulsar::message::proto::MessageIdData>,
    ack_base: u64,
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
                    self.ackable.push_back(id_data.clone());
                    if self.ackable.len() > ACK_WINDOW {
                        self.ackable.pop_front();
                        self.ack_base += 1;
                    }
                    Some(self.ack_base + self.ackable.len() as u64 - 1)
                };

                let properties = metadata
                    .properties
                    .iter()
                    .map(|kv| (kv.key.clone(), kv.value.clone()))
                    .collect();

                self.received += 1;
                Some(Ok(Message {
                    message_id: format!(
                        "{}:{}:{}",
                        id_data.ledger_id,
                        id_data.entry_id,
                        id_data.partition.unwrap_or(-1)
                    ),
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

    fn ackable_id(&self, seq: u64) -> AppResult<pulsar::message::proto::MessageIdData> {
        let index = seq
            .checked_sub(self.ack_base)
            .ok_or_else(|| AppError::Other("该消息已超出可确认窗口，将由 broker 重投".into()))?;
        self.ackable
            .get(index as usize)
            .cloned()
            .ok_or_else(|| AppError::Other("该消息已超出可确认窗口，将由 broker 重投".into()))
    }

    pub async fn ack(&mut self, seq: u64) -> AppResult<()> {
        let id = self.ackable_id(seq)?;
        self.consumer
            .ack_with_id(&self.topic, id)
            .await
            .map_err(|e| AppError::Other(format!("确认失败: {e}")))
    }

    /// 累积确认：把某条之前（含）的全部消息一并确认，只对流式可累计的订阅类型有意义。
    pub async fn ack_cumulative(&mut self, seq: u64) -> AppResult<()> {
        let id = self.ackable_id(seq)?;
        self.consumer
            .cumulative_ack_with_id(&self.topic, id)
            .await
            .map_err(|e| AppError::Other(format!("累计确认失败: {e}")))
    }

    /// 主动重投：把这条放回队列，别的消费者（或本轮之后）会再收到它。
    pub async fn nack(&mut self, seq: u64) -> AppResult<()> {
        let id = self.ackable_id(seq)?;
        self.consumer
            .nack_with_id(&self.topic, id)
            .await
            .map_err(|e| AppError::Other(format!("重投失败: {e}")))
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
        message_id: format!(
            "{}:{}:{}",
            id_data.ledger_id,
            id_data.entry_id,
            id_data.partition.unwrap_or(-1)
        ),
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
    /// 长连接生产者：工作台的一条会话对应这里的一个 producer。
    pub async fn open_producer(&self, topic: &str) -> AppResult<pulsar::Producer<TokioExecutor>> {
        self.open_producer_with(topic, ProducerOptions::default())
            .await
    }

    /// 带 producer 选项的版本：压测要按界面选择开压缩/批量/允许队列满时阻塞。
    pub async fn open_producer_with(
        &self,
        topic: &str,
        options: ProducerOptions,
    ) -> AppResult<pulsar::Producer<TokioExecutor>> {
        self.pulsar
            .producer()
            .with_topic(topic.to_string())
            .with_name(format!("pulsar-manager-{}", &pm_core::new_id()[..8]))
            .with_options(options)
            .build()
            .await
            .map_err(|e| AppError::Network(format!("创建 producer 失败: {e}")))
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
