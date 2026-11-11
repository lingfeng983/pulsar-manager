/**
 * 展示层格式化工具。
 *
 * 单位约定：Pulsar Admin API 的 msgThroughputIn/Out 单位是 **字节/秒**，
 * msgRateIn/Out 单位是 **条/秒**。此前各页面各自内联换算，导致同一指标在
 * 不同页面被标成不同单位（有的除了 1024，有的没除），这里统一口径。
 */

// 进制与单位必须对得上：这里一律按 1024 换算，单位就写 IEC 的 KiB/MiB/GiB。
// 写成 KB/MB/GB 的话，「1 KB 是 1000 还是 1024 字节」这件事就跟着文案一起漂——
// 同一个数在不同页面被标成不同单位，正是这个文件当初要解决的问题。
const KiB = 1024;
const MiB = KiB * 1024;
const GiB = MiB * 1024;

/** 字节数 → 人类可读体积 */
export function formatBytes(bytes: number | undefined | null, fractionDigits = 2): string {
    const value = bytes || 0;
    if (value >= GiB) {
        return `${(value / GiB).toFixed(fractionDigits)} GiB`;
    }
    if (value >= MiB) {
        return `${(value / MiB).toFixed(fractionDigits)} MiB`;
    }
    if (value >= KiB) {
        return `${(value / KiB).toFixed(fractionDigits)} KiB`;
    }
    return `${value.toFixed(0)} B`;
}

/** 字节/秒 → KiB/s（图表轴与数值展示统一使用） */
export function toKibibytesPerSecond(bytesPerSecond: number | undefined | null): number {
    return (bytesPerSecond || 0) / KiB;
}

/** 字节/秒 → 带单位的吞吐量文本 */
export function formatThroughput(bytesPerSecond: number | undefined | null, fractionDigits = 2): string {
    return `${toKibibytesPerSecond(bytesPerSecond).toFixed(fractionDigits)} KiB/s`;
}

/**
 * 字节/秒 → 自动选档位的吞吐文本（达到 1 MiB/s 才换成 MiB/s）。
 * 与 formatBytes 同一套 1024 进制，避免同一个量在不同页面被标成不同单位。
 */
export function formatThroughputAuto(bytesPerSecond: number | undefined | null, fractionDigits = 2): string {
    const value = bytesPerSecond || 0;
    return value >= MiB
        ? `${(value / MiB).toFixed(fractionDigits)} MiB/s`
        : `${(value / KiB).toFixed(fractionDigits)} KiB/s`;
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
