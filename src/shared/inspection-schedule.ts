/**
 * 定时巡检的纯逻辑：间隔的合法区间、到期判定、通知去重与文案。
 *
 * 放在 shared 而不是 services 里，和 inspection-caliber.ts 同一个理由：这几个函数决定了
 * 「什么时候会自动跑一次」和「跑完要不要打扰你」，它们必须在没有集群、没有窗口的机器上
 * 被 scripts/inspection-schedule-selftest.cjs 逐条证伪——这两件事一旦只能靠等一个间隔来验证，
 * 实际就等于没验证过。
 */
import type {InspectionScheduledPush, InspectionSource, InspectionTotals} from './types';

/** 每簇滚动保留的报告份数。手动与自动共用同一个上限：定时一开就是每天好几份，不设上限没人来收。 */
export const INSPECTION_HISTORY_KEEP = 30;

/**
 * 间隔区间取 30 分钟～7 天。
 *
 * 下限不是随手写的：一次巡检会按采样上限打几百个 REST 请求，5 分钟一轮在慢 broker 上
 * 会变成「巡检把自己压垮」，而巡检本身看不出这件事。上限给到 7 天是因为再长就不叫巡检、
 * 叫「你多久想起来看一眼」。
 */
export const INTERVAL_LIMITS = {min: 30, max: 10_080};

/** 默认 6 小时：一天四份，30 份滚动下来大约能回看一周。 */
export const DEFAULT_INTERVAL_MINUTES = 360;

/**
 * 间隔只认「这几个名字、这个区间」，越界一律拒而不是夹到边界。
 *
 * 与 v2.9 的阈值同一口径：夹一下看起来宽容，实际是把「填了 5 分钟却跑成 30 分钟」
 * 这种静默不一致留给用户自己去发现。未知字段由调用方的 zod .strict() 挡。
 */
export function resolveIntervalMinutes(input?: number): number {
    if (input === undefined || input === null) {
        return DEFAULT_INTERVAL_MINUTES;
    }
    if (typeof input !== 'number' || !Number.isFinite(input) || !Number.isInteger(input)) {
        throw new Error('巡检间隔必须是整数分钟');
    }
    if (input < INTERVAL_LIMITS.min || input > INTERVAL_LIMITS.max) {
        throw new Error(`巡检间隔只能在 ${INTERVAL_LIMITS.min}～${INTERVAL_LIMITS.max} 分钟之间`);
    }
    return input;
}

/** 整小时就报小时、整天就报天，剩下的才说分钟：「360 分钟」没人能一眼读成「6 小时」。 */
export function formatIntervalMinutes(minutes: number): string {
    if (minutes % 1440 === 0) {
        const days = minutes / 1440;
        return days === 1 ? '1 天' : `${days} 天`;
    }
    if (minutes % 60 === 0) {
        return `${minutes / 60} 小时`;
    }
    return `${minutes} 分钟`;
}

/**
 * 该不该在现在这一轮跑。
 *
 * 从来没跑过（lastRunAt 为 null）算到期：应用启动后第一轮就把这台集群补上一次，
 * 而不是等满一个间隔——「开了定时但今天没动静」是最容易被当成故障的观感。
 * 时间戳解析不出来同样算到期，坏掉的一次落库时间不该让这台集群从此不再被巡检。
 */
export function isInspectionDue(args: {nowMs: number; lastRunAt: string | null; intervalMinutes: number}): boolean {
    if (!args.lastRunAt) {
        return true;
    }
    const last = Date.parse(args.lastRunAt);
    if (!Number.isFinite(last)) {
        return true;
    }
    return args.nowMs - last >= args.intervalMinutes * 60_000;
}

/**
 * 下一次大约什么时候跑；没有上次运行时间时返回 null（界面说「待首次」而不是造一个时间）。
 * 传了 nowMs 时，已过期的那一轮按「现在」算——否则界面会把一个几小时前的时间
 * 显示成「下次大约」。
 */
export function nextInspectionRunAt(lastRunAt: string | null, intervalMinutes: number, nowMs?: number): number | null {
    if (!lastRunAt) {
        return null;
    }
    const last = Date.parse(lastRunAt);
    if (!Number.isFinite(last)) {
        return null;
    }
    const next = last + intervalMinutes * 60_000;
    return nowMs === undefined ? next : Math.max(next, nowMs);
}

/**
 * 这一轮该发哪种通知，null 表示不发。
 *
 * 比的是「这次判出的严重项数」与「上次发通知时那份的严重项数」：数字没动就不重复打扰，
 * 因为定时巡检一天可能跑好几轮，同一条积压烧着的时候，第二、三轮通知不带任何新信息。
 * 归零单独说一句——只在出现时报警的机制会让人一直以为还在烧。
 */
export function scheduledInspectionNotice(
    crit: number,
    lastNotifiedCrit: number,
): 'fired' | 'worsened' | 'improved' | 'recovered' | null {
    if (crit > 0 && lastNotifiedCrit === 0) {
        return 'fired';
    }
    if (crit > lastNotifiedCrit && lastNotifiedCrit > 0) {
        return 'worsened';
    }
    if (crit > 0 && crit < lastNotifiedCrit) {
        return 'improved';
    }
    if (crit === 0 && lastNotifiedCrit > 0) {
        return 'recovered';
    }
    return null;
}

/** 通知正文：把「几项严重」说成可比对的两句，而不是把报告里的数字再抄一遍。 */
export function scheduleNoticeText(
    kind: 'fired' | 'worsened' | 'improved' | 'recovered',
    clusterName: string,
    crit: number,
    lastNotifiedCrit: number,
    totals: InspectionTotals,
): string {
    switch (kind) {
        case 'fired':
            return `${clusterName}：巡检判出 ${crit} 项严重（关注 ${totals.warn} 项）`;
        case 'worsened':
            return `${clusterName}：严重项从 ${lastNotifiedCrit} 增加到 ${crit}（关注 ${totals.warn} 项）`;
        case 'improved':
            return `${clusterName}：严重项从 ${lastNotifiedCrit} 降到 ${crit}，还没归零`;
        case 'recovered':
            return `${clusterName}：巡检严重项已归零（关注 ${totals.warn} 项）`;
    }
}

/** 桌面通知的标题。恢复用另一种语气，别让「告警：xx」把一条好消息读成坏消息。 */
export function scheduleNoticeTitle(kind: 'fired' | 'worsened' | 'improved' | 'recovered'): string {
    return kind === 'recovered' ? '巡检：严重项已恢复' : '巡检：需要处理';
}

/** 定时跑完之后往渲染层推的那一条。 */
export function buildScheduledPush(args: {
    clusterId: string;
    clusterName: string;
    totals: InspectionTotals;
    generatedAt: string;
    message: string;
}): InspectionScheduledPush {
    return {
        kind: 'completed',
        clusterId: args.clusterId,
        clusterName: args.clusterName,
        totals: args.totals,
        generatedAt: args.generatedAt,
        message: args.message,
    };
}

/** 历史列表与报告标题里的来源标记。 */
export function inspectionSourceLabel(source: InspectionSource): string {
    return source === 'scheduled' ? '自动' : '手动';
}
