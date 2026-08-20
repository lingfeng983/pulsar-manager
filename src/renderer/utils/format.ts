/**
 * 展示层格式化工具。
 *
 * 单位约定：Pulsar Admin API 的 msgThroughputIn/Out 单位是 **字节/秒**，
 * msgRateIn/Out 单位是 **条/秒**。此前各页面各自内联换算，导致同一指标在
 * 不同页面被标成不同单位（有的除了 1024，有的没除），这里统一口径。
 */

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** 字节数 → 人类可读体积 */
export function formatBytes(bytes: number | undefined | null, fractionDigits = 2): string {
    const value = bytes || 0;
    if (value >= GB) {
        return `${(value / GB).toFixed(fractionDigits)} GB`;
    }
    if (value >= MB) {
        return `${(value / MB).toFixed(fractionDigits)} MB`;
    }
    if (value >= KB) {
        return `${(value / KB).toFixed(fractionDigits)} KB`;
    }
    return `${value.toFixed(0)} B`;
}

/** 字节/秒 → KB/s（图表轴与数值展示统一使用） */
export function toKilobytesPerSecond(bytesPerSecond: number | undefined | null): number {
    return (bytesPerSecond || 0) / KB;
}

/** 字节/秒 → 带单位的吞吐量文本 */
export function formatThroughput(bytesPerSecond: number | undefined | null, fractionDigits = 2): string {
    return `${toKilobytesPerSecond(bytesPerSecond).toFixed(fractionDigits)} KB/s`;
}

/** 条/秒 → 带单位的速率文本 */
export function formatMessageRate(messagesPerSecond: number | undefined | null, fractionDigits = 2): string {
    return `${(messagesPerSecond || 0).toFixed(fractionDigits)} msg/s`;
}

/**
 * 取路径式资源名的最后一段，例如 "tenant/namespace" → "namespace"、
 * "persistent://t/ns/topic" → "topic"。
 */
export function shortName(path: string): string {
    return path.split('/').pop() || path;
}
