import {z} from 'zod';
import {randomUUID} from 'crypto';
import {registerHandler} from './_shared';
import {
    deleteNotifyChannel,
    getNotifyChannelById,
    insertNotifyChannel,
    listNotifyChannels,
    setNotifyChannelEnabled,
    updateNotifyChannel,
} from '../database/sqlite';
import {
    buildChannelRecord,
    buildTestEvent,
    dispatchNotifyEvent,
    listRecentDeliveries,
    toNotifyChannel,
} from '../services/notify-dispatch';
import {
    NOTIFIABLE_EVENT_KINDS,
    resolveNotifyRate,
    resolveNotifyTimeoutMs,
    validateNotifyUrl,
} from '../../shared/notify-channels';
import {createLogger} from '../utils/logger';
import type {NotifyChannel, NotifyChannelDraft} from '../../shared/types';

const log = createLogger('NotifyIpc');

// 这一层只认「字段在不在、类型对不对」；区间（超时毫秒、每分钟条数）与语义
// （地址协议、事件名认不认得）都在 shared/notify-channels 里判——那套规则要能被假数据自测覆盖，
// 也要在这条通道上用，分成两处写迟早一处松一处紧。
const EventSchema = z.enum(NOTIFIABLE_EVENT_KINDS);
const KindSchema = z.enum(['generic', 'dingtalk', 'feishu', 'wecom', 'slack']);

const ChannelSchema = z
    .object({
        id: z.string().uuid().optional(),
        name: z.string().min(1).max(80),
        kind: KindSchema,
        // 可以留空：留空是「沿用库里那一份」，不是「把地址清掉」（见 saveChannel）
        url: z.string().max(2048),
        secret: z.string().max(512).optional().nullable(),
        enabled: z.boolean().optional(),
        events: z.array(EventSchema).max(NOTIFIABLE_EVENT_KINDS.length).optional(),
        minLevel: z.enum(['info', 'warn', 'crit']).optional(),
        timeoutMs: z.number().optional(),
        ratePerMinute: z.number().optional(),
    })
    .strict();

const IdSchema = z.object({id: z.string().uuid()}).strict();
const EnabledSchema = z.object({id: z.string().uuid(), enabled: z.boolean()}).strict();
const DeliverySchema = z.object({limit: z.number().int().min(1).max(200).optional()}).strict();

/**
 * 保存一条渠道（新建与编辑共用）。
 *
 * 列表页拿到的是打码地址、密钥从不回填，所以地址与密钥都按「留空表示不改」处理；
 * 新建时没有可沿用的东西，地址留空直接拒绝。
 */
function saveChannel(draft: NotifyChannelDraft): NotifyChannel {
    const url = draft.url.trim();
    const invalid = url ? validateNotifyUrl(url) : null;
    if (invalid) {
        throw new Error(invalid);
    }
    const existing = draft.id ? getNotifyChannelById(draft.id) : null;
    if (draft.id && !existing) {
        // 拿着一个已经不存在的 id 过来不能当新建插入：那是别处删掉的配置，
        // 静默复活会让那个 id 的来源（另一扇窗口、导进来的配置包）改写现有渠道
        throw new Error('这条渠道已经不在了，请刷新列表');
    }
    if (!existing && !url) {
        throw new Error('新建渠道必须填写通知地址');
    }

    const at = new Date().toISOString();
    const record = buildChannelRecord(
        {
            ...draft,
            // 区间在这里落地：抛出去的原话会回到界面上，比悄悄夹住有用
            timeoutMs: resolveNotifyTimeoutMs(draft.timeoutMs),
            ratePerMinute: resolveNotifyRate(draft.ratePerMinute),
        },
        existing,
        draft.id ?? randomUUID(),
        at,
    );

    if (existing) {
        updateNotifyChannel(record);
    } else {
        insertNotifyChannel(record);
    }
    log.info(`notify channel ${record.id} (${record.kind}) ${draft.id ? 'updated' : 'created'}`);
    return toNotifyChannel(record);
}

export function registerNotifyHandlers() {
    registerHandler('notify:channel:list', async () => listNotifyChannels().map(toNotifyChannel));

    registerHandler('notify:channel:save', async (params: unknown) =>
        saveChannel(ChannelSchema.parse(params) as NotifyChannelDraft),
    );

    registerHandler('notify:channel:delete', async (params: unknown) => {
        const {id} = IdSchema.parse(params);
        // 投递记录跟着外键一起删：留着指向不存在渠道的行，界面上只能说「这条没有主人」
        return {deleted: deleteNotifyChannel(id) > 0};
    });

    registerHandler('notify:channel:enable', async (params: unknown) => {
        const input = EnabledSchema.parse(params);
        if (!getNotifyChannelById(input.id)) {
            throw new Error('这条渠道已经不在了，请刷新列表');
        }
        // 开关单独一条 UPDATE，而不是把整行 draft 再拼一遍：开关不该有清空地址的机会
        return {updated: setNotifyChannelEnabled(input.id, input.enabled) > 0};
    });

    // 测试只发这一条渠道，并绕开订阅、级别与限流：点它要问的是「现在通不通」
    registerHandler('notify:channel:test', async (params: unknown) => {
        const {id} = IdSchema.parse(params);
        if (!getNotifyChannelById(id)) {
            throw new Error('这条渠道已经不在了，请刷新列表');
        }
        return dispatchNotifyEvent(buildTestEvent(), Date.now(), id);
    });

    registerHandler('notify:delivery:list', async (params: unknown) => {
        const input = DeliverySchema.parse(params ?? {});
        // 默认 50、上限 200：这一页要说的是「最近这几次发出去了没」，
        // 翻到几百条之前还没找到要看的那条，说明该清库而不是把上限调大
        return listRecentDeliveries(input.limit ?? 50);
    });
}
