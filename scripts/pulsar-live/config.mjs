import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pulsar = require('pulsar-client');

export const BROKER_URL = process.env.PM_BROKER_URL || 'pulsar://192.168.222.121:6650';
export const ADMIN_URL = process.env.PM_ADMIN_URL || 'http://192.168.222.121:8080';
export const TENANT = process.env.PM_TENANT || 'public';
export const NAMESPACE = process.env.PM_NAMESPACE || 'default';

// 全部带 pm-live- 前缀，便于收尾时精确清理；用户原有 t1 不属于本测试台。
export const TOPIC_STANDALONE = 'pm-live-standalone';
export const TOPIC_PARTITIONED = 'pm-live-partitioned';
export const PRODUCER_TAG = 'pm-live-producer';
export const CONSUMER_TAG = 'pm-live-consumer';
export const READER_TAG = 'pm-live-reader';

const ALIASES = {
  standalone: TOPIC_STANDALONE,
  part: TOPIC_PARTITIONED,
  partitioned: TOPIC_PARTITIONED,
};

export function fullName(name) {
  const plain = ALIASES[name] || name;
  return plain.includes('://') ? plain : `persistent://${TENANT}/${NAMESPACE}/${plain}`;
}

export function shortName(name) {
  return fullName(name).split('/').pop();
}

export function newClient() {
  return new pulsar.Client({
    serviceUrl: BROKER_URL,
    operationTimeoutSeconds: 10,
    logLevel: pulsar.LogLevel.WARN,
  });
}

export const MessageId = pulsar.MessageId;

export async function admin(path, options = {}) {
  const url = `${ADMIN_URL}/admin/v2/${path}`;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) {
    const isHtml = text.trimStart().startsWith('<');
    throw new Error(
      `admin ${options.method || 'GET'} ${path} -> ${res.status}${isHtml ? ' (路由不存在，返回 HTML 404)' : `: ${text.slice(0, 200)}`}`,
    );
  }
  return text ? JSON.parse(text) : null;
}

const flag = (argv, name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) return true;
  return next;
};

export function parseArgs(argv) {
  return {
    command: argv[0] || 'smoke',
    topic: flag(argv, 'topic', undefined),
    sub: flag(argv, 'sub', undefined),
    n: Number(flag(argv, 'n', '10')),
    interval: Number(flag(argv, 'interval', '500')),
    partitions: Number(flag(argv, 'partitions', '4')),
    type: flag(argv, 'type', 'Shared'),
    from: flag(argv, 'from', 'earliest'),
    ack: flag(argv, 'ack', 'true') !== 'false',
  };
}
