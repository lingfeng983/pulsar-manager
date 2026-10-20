use std::collections::HashMap;

use futures::TryStreamExt;
use pm_core::{AdminConfig, AppError, AppResult, ConsumeOptions, Message, SendOptions};
use pulsar::consumer::{ConsumerOptions, InitialPosition};
use pulsar::{producer, Authentication, Consumer, Pulsar, SubType, TokioExecutor};

/// 原生协议客户端（纯 Rust 的 `pulsar` crate，不依赖 pulsar-client-cpp）。
/// Admin REST 只能改资源，收发消息必须走 broker 的二进制口。
pub struct NativeClient {
    pulsar: Pulsar<TokioExecutor>,
}

impl NativeClient {
    pub async fn connect(config: &AdminConfig) -> AppResult<Self> {
        let mut builder = Pulsar::builder(config.service_url.clone(), TokioExecutor);
        if let Some(token) = config.auth_params.clone().filter(|token| !token.is_empty()) {
            builder = builder.with_auth(Authentication {
                name: config.auth_plugin.clone().unwrap_or_else(|| "token".into()),
                data: token.into_bytes(),
            });
        }
        let pulsar = builder
            .build()
            .await
            .map_err(|e| AppError::Network(format!("连接 broker 二进制口失败: {e}")))?;
        Ok(Self { pulsar })
    }

    pub async fn send(&self, options: &SendOptions) -> AppResult<String> {
        let mut producer = self
            .pulsar
            .producer()
            .with_topic(options.topic.clone())
            .build()
            .await
            .map_err(|e| AppError::Network(format!("创建 producer 失败: {e}")))?;

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
        Ok(id)
    }

    pub async fn open_consumer(&self, options: &ConsumeOptions) -> AppResult<NativeConsumer> {
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

        let consumer: Consumer<Vec<u8>, TokioExecutor> = self
            .pulsar
            .consumer()
            .with_topic(options.topic.clone())
            .with_consumer_name(format!("pulsar-manager-{}", &pm_core::new_id()[..8]))
            .with_subscription(options.subscription.clone())
            .with_subscription_type(subscription_type)
            .with_options(consumer_options)
            .build()
            .await
            .map_err(|e| AppError::Network(format!("订阅失败: {e}")))?;

        Ok(NativeConsumer {
            consumer,
            topic: options.topic.clone(),
            auto_ack: options.auto_ack,
            max_messages: options.max_messages,
            received: 0,
            ackable: Vec::new(),
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
    ackable: Vec<pulsar::message::proto::MessageIdData>,
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
            Err(error) => Some(Err(AppError::Network(format!("消费失败: {error}")))),
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
                    self.ackable.push(id_data.clone());
                    Some(self.ackable.len() as u64 - 1)
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

    pub async fn ack(&mut self, seq: u64) -> AppResult<()> {
        let Some(id) = self.ackable.get(seq as usize).cloned() else {
            return Err(AppError::Other(
                "该消息已超出可确认窗口，将由 broker 重投".into(),
            ));
        };
        self.consumer
            .ack_with_id(&self.topic, id)
            .await
            .map_err(|e| AppError::Other(format!("确认失败: {e}")))
    }

    /// 累积确认：把某条之前（含）的全部消息一并确认，只对流式可累计的订阅类型有意义。
    pub async fn ack_cumulative(&mut self, seq: u64) -> AppResult<()> {
        let Some(id) = self.ackable.get(seq as usize).cloned() else {
            return Err(AppError::Other(
                "该消息已超出可确认窗口，将由 broker 重投".into(),
            ));
        };
        self.consumer
            .cumulative_ack_with_id(&self.topic, id)
            .await
            .map_err(|e| AppError::Other(format!("累计确认失败: {e}")))
    }

    /// 主动重投：把这条放回队列，别的消费者（或本轮之后）会再收到它。
    pub async fn nack(&mut self, seq: u64) -> AppResult<()> {
        let Some(id) = self.ackable.get(seq as usize).cloned() else {
            return Err(AppError::Other(
                "该消息已超出可确认窗口，将由 broker 重投".into(),
            ));
        };
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
    reader: pulsar::reader::Reader<Vec<u8>, TokioExecutor>,
    topic: String,
}

impl NativeReader {
    pub fn topic(&self) -> &str {
        &self.topic
    }

    pub async fn next(&mut self) -> Option<AppResult<Message>> {
        match self.reader.try_next().await {
            Ok(None) => None,
            Err(error) => Some(Err(AppError::Network(format!("读取失败: {error}")))),
            Ok(Some(message)) => {
                let metadata = message.metadata().clone();
                let id_data = message.message_id().clone();
                let payload = message.deserialize();
                let data_bytes = payload.len() as i64;
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
                }))
            }
        }
    }

    pub async fn close(self) {
        // Reader 没有显式关闭接口：drop 掉即释放连接，未确认的消息与本读取器无关
        drop(self);
    }
}

impl NativeClient {
    /// 长连接生产者：工作台的一条会话对应这里的一个 producer。
    pub async fn open_producer(&self, topic: &str) -> AppResult<pulsar::Producer<TokioExecutor>> {
        self.pulsar
            .producer()
            .with_topic(topic.to_string())
            .with_name(format!("pulsar-manager-{}", &pm_core::new_id()[..8]))
            .build()
            .await
            .map_err(|e| AppError::Network(format!("创建 producer 失败: {e}")))
    }

    /// `from_earliest` 决定 Reader 的起点：recent / timestamp / messageId 都要从最早开始扫。
    pub async fn open_reader(&self, topic: &str, from_earliest: bool) -> AppResult<NativeReader> {
        let options = ConsumerOptions::default()
            .durable(false)
            .with_initial_position(if from_earliest {
                InitialPosition::Earliest
            } else {
                InitialPosition::Latest
            });
        let reader: pulsar::reader::Reader<Vec<u8>, TokioExecutor> = self
            .pulsar
            .reader()
            .with_topic(topic.to_string())
            .with_consumer_name(format!("pulsar-manager-reader-{}", &pm_core::new_id()[..8]))
            .with_options(options)
            .into_reader()
            .await
            .map_err(|e| AppError::Network(format!("创建回溯读取器失败: {e}")))?;
        Ok(NativeReader {
            reader,
            topic: topic.to_string(),
        })
    }
}
