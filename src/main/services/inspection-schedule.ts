import {Notification} from 'electron';
import {getMainWindow} from '../index';
import {
    getClusterById,
    getInspectionSchedule,
    listEnabledInspectionSchedules,
    markInspectionScheduleRun,
    upsertInspectionSchedule,
    type InspectionScheduleRecord,
} from '../database/sqlite';
import {executeInspection} from './inspection-run';
import {
    buildScheduledPush,
    isInspectionDue,
    resolveIntervalMinutes,
    scheduleNoticeText,
    scheduleNoticeTitle,
    scheduledInspectionNotice,
} from '../../shared/inspection-schedule';
import type {InspectionSchedule, InspectionScheduleDraft, InspectionScheduledPush} from '../../shared/types';
import type {PulsarAdminClient} from './pulsar-admin';
import {createLogger} from '../utils/logger';

const log = createLogger('InspectionScheduler');

// 定时巡检引擎只在主进程跑：窗口收进托盘时它照样得按间隔巡检，所以不能挂在巡检页的点击上。
//
// 与告警引擎一样不 import ipc/_shared：取 admin 客户端与下行推送这两个能力由
// registerInspectionHandlers() 注入进来（见 bindInspectionSchedulerDeps）。
// getMainWindow 是唯一的例外，理由与 alert-engine 相同——调用发生在运行期，循环 require 拿到的是已导出。

/**
 * 扫描间隔固定 60 秒，而不是「每台集群各挂一个自己的定时器」。
 *
 * 按到期判定扫一遍的好处是配置写完就生效：改了间隔不必重新挂定时器，也不会出现
 * 「改了间隔要重启应用才生效」这类只在界面里看不出来的毛病。60 秒相对最短间隔 30 分钟
 * 是 0.06% 的抖动，而一轮 tick 只做一条 SELECT。
 */
const TICK_MS = 60_000;

export interface InspectionSchedulerDeps {
    /** clusterId → admin 客户端；返回 null 表示集群已不存在 */
    getClient: (clusterId: string) => Promise<PulsarAdminClient | null>;
    /** 主进程 → 渲染进程的下行推送 */
    publish: (push: InspectionScheduledPush) => void;
}

let deps: InspectionSchedulerDeps | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
// 上一轮没跑完就跳过这一轮：巡检一次可能几十秒，排队会让两轮叠成双倍请求量，
// 表现得像应用在攻击自己的 broker。
let ticking = false;

export function bindInspectionSchedulerDeps(next: InspectionSchedulerDeps): void {
    deps = next;
}

export function toInspectionSchedule(record: InspectionScheduleRecord): InspectionSchedule {
    return {
        clusterId: record.cluster_id,
        enabled: record.enabled === 1,
        intervalMinutes: record.interval_minutes,
        notifyOnCrit: record.notify_on_crit === 1,
        lastRunAt: record.last_run_at,
        lastError: record.last_error,
        lastNotifiedCrit: record.last_notified_crit,
        updatedAt: record.updated_at,
    };
}

/**
 * 保存一台集群的调度。没写过的字段落回现值，全新的行落回默认（关着 + 默认间隔 + 通知开）。
 *
 * 开着的那一列默认关：调度是一次巡检之外的第二个「应用会自己打 broker」的来源，
 * 打开它的动作必须是显式的，不能是「填了个间隔顺便就开了」。
 */
export function saveInspectionSchedule(input: InspectionScheduleDraft): InspectionSchedule {
    const existing = getInspectionSchedule(input.clusterId);
    if (!existing && !getClusterById(input.clusterId)) {
        // 外键也会挡，但「FOREIGN KEY constraint failed」没人读得懂
        throw new Error('集群不存在，请先在集群配置里添加');
    }
    const record: InspectionScheduleRecord = {
        cluster_id: input.clusterId,
        enabled: (input.enabled ?? existing?.enabled === 1) ? 1 : 0,
        interval_minutes: resolveIntervalMinutes(input.intervalMinutes ?? existing?.interval_minutes),
        notify_on_crit: (input.notifyOnCrit ?? (existing ? existing.notify_on_crit === 1 : true)) ? 1 : 0,
        // 这三列在 upsert 的更新分支里不写，所以这里的值只对「第一次插入」有意义
        last_run_at: existing?.last_run_at ?? null,
        last_error: existing?.last_error ?? null,
        last_notified_crit: existing?.last_notified_crit ?? 0,
        updated_at: new Date().toISOString(),
    };
    upsertInspectionSchedule(record);
    log.info(`schedule ${input.clusterId}: enabled=${record.enabled} interval=${record.interval_minutes}m`);
    return toInspectionSchedule(record);
}

function notify(args: {title: string; body: string; urgent: boolean}): void {
    try {
        if (!Notification.isSupported()) {
            return;
        }
        const notification = new Notification({
            title: args.title,
            body: args.body,
            urgency: args.urgent ? 'critical' : 'normal',
        });
        notification.on('click', () => {
            const window = getMainWindow();
            if (window && !window.isDestroyed()) {
                if (window.isMinimized()) {
                    window.restore();
                }
                window.show();
                window.focus();
            }
        });
        notification.show();
    } catch (error) {
        // 桌面通知失败不影响报告落库：某些 Linux 桌面压根没有通知服务，这是常态不是故障
        log.warn(`desktop notification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function runDue(record: InspectionScheduleRecord, nowMs: number): Promise<void> {
    if (!isInspectionDue({nowMs, lastRunAt: record.last_run_at, intervalMinutes: record.interval_minutes})) {
        return;
    }
    const cluster = getClusterById(record.cluster_id);
    if (!cluster) {
        return;
    }
    const ranAt = new Date(nowMs).toISOString();
    let client: PulsarAdminClient | null;
    try {
        // 经 SSH 隧道 / K8s 转发的集群会在这里把本地转发建起来
        client = await deps!.getClient(record.cluster_id);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.warn(`cluster ${record.cluster_id} client unavailable: ${reason}`);
        // 连不上也要把 last_run_at 写下去：不写的话下一轮 60 秒后又试一次，
        // 一台关着的集群会被应用每分钟敲一次门。失败原因落库，界面上看得见
        markInspectionScheduleRun(record.cluster_id, {ranAt, error: reason, notifiedCrit: null});
        deps!.publish({
            kind: 'failed',
            clusterId: record.cluster_id,
            clusterName: cluster.name,
            totals: null,
            message: `定时巡检没能开始：${reason}`,
            generatedAt: ranAt,
        });
        return;
    }
    if (!client) {
        markInspectionScheduleRun(record.cluster_id, {ranAt, error: '集群已不存在', notifiedCrit: null});
        return;
    }

    let result: Awaited<ReturnType<typeof executeInspection>>;
    try {
        result = await executeInspection({
            client,
            clusterId: record.cluster_id,
            clusterName: cluster.name,
            source: 'scheduled',
        });
    } catch (error) {
        // 手动那一轮正占着这台集群时也会走到这里：跳过而不是报错，下一个周期照样会跑
        const reason = error instanceof Error ? error.message : String(error);
        log.warn(`scheduled inspection for ${record.cluster_id} failed: ${reason}`);
        markInspectionScheduleRun(record.cluster_id, {ranAt, error: reason, notifiedCrit: null});
        deps!.publish({
            kind: 'failed',
            clusterId: record.cluster_id,
            clusterName: cluster.name,
            totals: null,
            message: `定时巡检失败：${reason}`,
            generatedAt: ranAt,
        });
        return;
    }

    const {report} = result;
    const kind = scheduledInspectionNotice(report.totals.crit, record.last_notified_crit);
    const message = kind
        ? scheduleNoticeText(kind, cluster.name, report.totals.crit, record.last_notified_crit, report.totals)
        : `${cluster.name}：定时巡检完成，严重 ${report.totals.crit} 项、关注 ${report.totals.warn} 项`;
    markInspectionScheduleRun(record.cluster_id, {
        // 用报告自己的时间而不是 tick 的时间：历史列表里那份报告和这一格说的是同一次
        ranAt: report.generatedAt,
        error: null,
        notifiedCrit: kind ? report.totals.crit : null,
    });
    deps!.publish(
        buildScheduledPush({
            clusterId: record.cluster_id,
            clusterName: cluster.name,
            totals: report.totals,
            generatedAt: report.generatedAt,
            message,
        }),
    );
    if (kind && record.notify_on_crit === 1) {
        notify({title: scheduleNoticeTitle(kind), body: message, urgent: kind !== 'recovered'});
    }
    log.info(`scheduled inspection ${record.cluster_id}: crit=${report.totals.crit} notice=${kind ?? 'none'}`);
}

async function tick(nowMs: number): Promise<void> {
    if (!deps || ticking) {
        return;
    }
    ticking = true;
    try {
        // 一轮里逐台串行：并发跑两台集群本身没问题，但一轮打出去的请求量会变成
        // 「采样上限 × 集群数」，界面上没人能预期这件事
        for (const record of listEnabledInspectionSchedules()) {
            await runDue(record, nowMs);
        }
    } catch (error) {
        log.error('inspection scheduler tick failed', error instanceof Error ? error.message : String(error));
    } finally {
        ticking = false;
    }
}

export function startInspectionScheduler(): void {
    if (timer) {
        return;
    }
    timer = setInterval(() => void tick(Date.now()), TICK_MS);
    log.info(`inspection scheduler ticking every ${TICK_MS / 1000}s`);
}

export function stopInspectionScheduler(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
