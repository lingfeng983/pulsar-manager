#!/usr/bin/env node
// 本地标准 Pulsar 客户端测试台：建主题 / 生产 / 消费 / Reader / 状态巡检 / 清理。
// 用途是给 pulsar-manager 提供可对比的真实流量，不依赖应用代码。
//
//   node scripts/pulsar-live/pm-live.mjs smoke
//   node scripts/pulsar-live/pm-live.mjs create
//   node scripts/pulsar-live/pm-live.mjs produce --topic standalone --n 0 --interval 300
//   node scripts/pulsar-live/pm-live.mjs consume --topic standalone --sub pm-live-consumer --n 0
//   node scripts/pulsar-live/pm-live.mjs read --topic standalone --n 20
//   node scripts/pulsar-live/pm-live.mjs inspect
//   node scripts/pulsar-live/pm-live.mjs cleanup
import {
  ADMIN_URL,
  BROKER_URL,
  CONSUMER_TAG,
  NAMESPACE,
  PRODUCER_TAG,
  READER_TAG,
  TENANT,
  TOPIC_PARTITIONED,
  TOPIC_STANDALONE,
  MessageId,
  admin,
  fullName,
  newClient,
  parseArgs,
  shortName,
} from './config.mjs';

const nsPath = `${TENANT}/${NAMESPACE}`;
const argv = process.argv.slice(2);
const args = parseArgs(argv);

let client = null;
const running = [];

function log(...parts) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);
}

function getClient() {
  if (!client) client = newClient();
  return client;
}

// 载荷可能是任意文本（界面手发的就不是 JSON），取 seq 失败时原样回显
function payloadSeq(message) {
  const body = message.getData().toString('utf8');
  try {
    const parsed = JSON.parse(body);
    return String(parsed.seq ?? parsed.text ?? body);
  } catch {
    return `${body.slice(0, 60)} (${Buffer.byteLength(body)} 字节, 非 JSON)`;
  }
}

async function shutdown(code = 0) {
  for (const stop of running.splice(0)) {
    await stop().catch(() => undefined);
  }
  if (client) await client.close().catch(() => undefined);
  // 原生 addon 的 libuv 句柄需要时间回收，立即 process.exit 会触发
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"。
  await new Promise((r) => setTimeout(r, 800));
  process.exit(code);
}

process.on('SIGINT', () => {
  log('SIGINT，正在优雅停止…');
  void shutdown(0);
});

// ---------------------------------------------------------------- 主题管理

async function createTopics() {
  log(`broker=${BROKER_URL}  admin=${ADMIN_URL}`);
  await admin(`persistent/${nsPath}/${TOPIC_STANDALONE}`, { method: 'PUT' });
  log(`已创建非分区主题 ${TOPIC_STANDALONE}`);
  await admin(`persistent/${nsPath}/${TOPIC_PARTITIONED}/partitions`, {
    method: 'PUT',
    body: args.partitions,
  });
  log(`已创建分区主题 ${TOPIC_PARTITIONED}（${args.partitions} 个分区）`);
}

async function listTopics() {
  const topics = await admin(`persistent/${nsPath}`);
  return topics.filter((t) => {
    const local = shortName(t);
    return local.startsWith('pm-live-') && !/-partition-\d+$/.test(local);
  });
}

async function cleanup() {
  const targets = (await listTopics()).map((t) => t.split('/').pop());
  for (const topic of targets) {
    // 该 broker 的 /partitions 返回 {"partitions":4,"deleted":false}，与标准 {partitioned,numPartitions} 拼写不同
    const meta = await admin(`persistent/${nsPath}/${topic}/partitions`).catch(() => null);
    const isPartitioned = meta?.partitioned === true || (typeof meta?.partitions === 'number' && meta.partitions > 0);
    if (isPartitioned) {
      await admin(`persistent/${nsPath}/${topic}/partitions`, { method: 'DELETE' });
    } else {
      await admin(`persistent/${nsPath}/${topic}?force=true`, { method: 'DELETE' });
    }
    log(`已删除测试主题 ${topic}`);
  }
  log(`清理完成，共 ${targets.length} 个（用户原有主题如 t1 不受影响）`);
}

// ---------------------------------------------------------------- 生产端

async function produce() {
  const topic = fullName(args.topic || TOPIC_STANDALONE);
  const producer = await getClient().createProducer({
    topic,
    producerName: PRODUCER_TAG,
    sendTimeoutMs: 10000,
    batchingEnabled: true,
  });
  running.push(() => producer.close());
  log(`生产者已连接 ${topic}（--n 0 表示持续生产，Ctrl+C 停止）`);

  let sent = 0;
  for (;;) {
    if (args.n > 0 && sent >= args.n) break;
    const seq = sent + 1;
    const payload = {
      seq,
      source: 'pm-live',
      topic: shortName(topic),
      sentAt: new Date().toISOString(),
      text: `pulsar-manager 功能验证消息 #${seq}`,
    };
    const id = await producer.send({
      data: Buffer.from(JSON.stringify(payload), 'utf8'),
      partitionKey: `key-${seq % 3}`,
      properties: { 'pm-seq': String(seq), 'pm-source': 'pm-live' },
    });
    sent += 1;
    log(`已发送 #${seq} messageId=${id.toString()}`);
    if (args.n > 0 && sent >= args.n) break;
    await new Promise((r) => setTimeout(r, args.interval));
  }
  log(`生产结束，共 ${sent} 条`);
  await shutdown(0);
}

// ---------------------------------------------------------------- 消费端

async function consume() {
  const topic = fullName(args.topic || TOPIC_STANDALONE);
  const subscription = args.sub || CONSUMER_TAG;
  const consumer = await getClient().subscribe({
    topic,
    subscription,
    subscriptionType: args.type === 'Key_Shared' ? 'KeyShared' : args.type,
    consumerName: `${CONSUMER_TAG}-node`,
    subscriptionInitialPosition: 'Earliest',
  });
  running.push(() => consumer.close());
  const ack = String(args.ack) !== 'false';
  log(`消费者已订阅 ${topic} / ${subscription}（${args.type}，autoAck=${ack}，--n 0 表示持续消费）`);

  let received = 0;
  for (;;) {
    if (args.n > 0 && received >= args.n) break;
    let message;
    try {
      message = await consumer.receive(2000);
    } catch (err) {
      if (/timeout/i.test(err.message)) continue;
      throw err;
    }
    received += 1;
    log(
      `#${received} 收到 seq=${payloadSeq(message)} from=${message.getProducerName()} key=${message.getPartitionKey()} props=${JSON.stringify({ ...message.getProperties() })}`,
    );
    if (ack) await consumer.acknowledge(message);
    if (args.n > 0 && received >= args.n) break;
  }
  log(`消费结束，共 ${received} 条${ack ? '（已 ack）' : '（未 ack，形成积压）'}`);
  await shutdown(0);
}

// ---------------------------------------------------------------- Reader

async function read() {
  const topic = fullName(args.topic || TOPIC_STANDALONE);
  const reader = await getClient().createReader({
    topic,
    startMessageId: args.from === 'latest' ? MessageId.latest() : MessageId.earliest(),
    readerName: READER_TAG,
    readerStartMessageInclusive: true,
  });
  running.push(() => reader.close());
  log(`Reader 已打开 ${topic}（起点=${args.from}）`);

  let count = 0;
  while (count < args.n) {
    if (!reader.hasNext()) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    const message = await reader.readNext();
    count += 1;
    log(`#${count} 读到 seq=${payloadSeq(message)} publishTime=${new Date(message.getPublishTimestamp()).toISOString()}`);
  }
  log(`Reader 结束，共 ${count} 条`);
  await shutdown(0);
}

// ---------------------------------------------------------------- 巡检

async function topicStats(local) {
  try {
    return await admin(`persistent/${nsPath}/${local}/stats`);
  } catch (err) {
    // 分区主题在 /stats 上是 404，只有 /partitioned-stats 存在
    if (/-> 404/.test(err.message)) return admin(`persistent/${nsPath}/${local}/partitioned-stats`);
    throw err;
  }
}

async function inspect() {
  const wanted = args.topic ? [fullName(args.topic)] : [TOPIC_STANDALONE, TOPIC_PARTITIONED].map(fullName);
  const report = [];
  for (const topic of wanted) {
    const local = shortName(topic);
    const stats = await topicStats(local).catch((err) => {
      log(`${local} stats 失败: ${err.message}`);
      return null;
    });
    // 分区主题的 /partitioned-stats 把数据放在 partitions{真实主题名} 下，逐分区合并
    let normalized = stats;
    if (stats?.partitions) {
      const parts = Object.values(stats.partitions);
      const publishers = parts.flatMap((p) => p.publishers || []);
      const subsByName = new Map();
      for (const p of parts) {
        for (const [name, s] of Object.entries(p.subscriptions || {})) {
          const merged = subsByName.get(name) || { backlogSize: 0, totalUnackedMessages: 0, msgRateOut: 0, consumers: [] };
          merged.backlogSize += s.backlogSize || 0;
          merged.totalUnackedMessages += s.totalUnackedMessages || 0;
          merged.msgRateOut += s.msgRateOut || 0;
          merged.consumers.push(...(s.consumers || []));
          subsByName.set(name, merged);
        }
      }
      normalized = {
        msgRateIn: parts.reduce((a, p) => a + (p.msgRateIn || 0), 0),
        msgRateOut: parts.reduce((a, p) => a + (p.msgRateOut || 0), 0),
        storageSize: parts.reduce((a, p) => a + (p.storageSize || 0), 0),
        publishers,
        subscriptions: Object.fromEntries(subsByName),
      };
    }
    report.push({
      topic: local,
      msgRateIn: normalized?.msgRateIn ?? null,
      msgRateOut: normalized?.msgRateOut ?? null,
      storageSize: normalized?.storageSize ?? null,
      publishers: (normalized?.publishers || []).map((p) => ({ name: p.producerName, msgRateIn: p.msgRateIn })),
      subscriptions: Object.entries(normalized?.subscriptions || {}).map(([name, s]) => ({
        name,
        backlogSize: s.backlogSize,
        unacked: s.totalUnackedMessages,
        msgRateOut: s.msgRateOut,
        consumers: (s.consumers || []).map((c) => c.consumerName),
      })),
    });
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
}

// ---------------------------------------------------------------- 冒烟闭环

async function smoke() {
  const topic = shortName(fullName(TOPIC_STANDALONE));
  const sub = `${CONSUMER_TAG}-smoke`;
  try {
    await admin(`persistent/${nsPath}/${topic}`, { method: 'PUT' });
  } catch (err) {
    log(`主题准备: ${err.message}`);
  }

  const N = 5;
  const producer = await getClient().createProducer({ topic: fullName(topic), producerName: PRODUCER_TAG });
  const ids = [];
  for (let i = 1; i <= N; i += 1) {
    ids.push(
      (
        await producer.send({
          data: Buffer.from(JSON.stringify({ seq: i, source: 'pm-live', text: `smoke-${i}` }), 'utf8'),
          properties: { 'pm-seq': String(i) },
        })
      ).toString(),
    );
  }
  await producer.close();
  log(`生产 ${N} 条，messageId=${ids[0]} … ${ids[ids.length - 1]}`);

  const consumer = await getClient().subscribe({
    topic: fullName(topic),
    subscription: sub,
    subscriptionType: 'Exclusive',
    subscriptionInitialPosition: 'Earliest',
  });
  const seen = [];
  for (;;) {
    try {
      const m = await consumer.receive(3000);
      seen.push(JSON.parse(m.getData().toString('utf8')).seq);
      await consumer.acknowledge(m);
      if (seen.length >= N) break;
    } catch (err) {
      if (/timeout/i.test(err.message)) break;
      throw err;
    }
  }
  await consumer.close();
  log(`消费 ${seen.length} 条并 ack，seq=${seen.join(',')}`);

  const reader = await getClient().createReader({ topic: fullName(topic), startMessageId: MessageId.earliest() });
  let readCount = 0;
  while (reader.hasNext() && readCount < 50) {
    await reader.readNext();
    readCount += 1;
  }
  await reader.close();
  log(`Reader 从头回放看到 ${readCount} 条`);
  await client.close();
  client = null;

  await admin(`persistent/${nsPath}/${topic}/subscription/${sub}`, { method: 'DELETE', body: { force: true } }).catch((e) =>
    log(`清理订阅: ${e.message}`),
  );

  const ok = seen.length === N && readCount >= N;
  log(`闭环${ok ? '通过' : '失败'}：生产 ${N} / 消费 ${seen.length} / 回放 ${readCount}`);
  await inspect();
  await shutdown(ok ? 0 : 1);
}

// ---------------------------------------------------------------- 入口

const commands = { create: createTopics, produce, consume, read, inspect, cleanup, smoke };
const fn = commands[args.command];
if (!fn) {
  console.error(`未知命令 ${args.command}，可用：${Object.keys(commands).join('|')}`);
  process.exit(2);
}
try {
  await fn();
} catch (err) {
  log(`命令 ${args.command} 失败: ${err.message}`);
  await shutdown(1);
}
