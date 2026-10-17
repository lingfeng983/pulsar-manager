import {z} from 'zod';
import {randomUUID} from 'crypto';
import {registerHandler} from './_shared';
import {
    countNotifyChannelsUsingMailProfile,
    deleteMailProfile,
    deleteNotifyChannel,
    getMailProfileById,
    getNotifyChannelById,
    insertMailProfile,
    insertNotifyChannel,
    listMailProfiles,
    listNotifyChannels,
    setNotifyChannelEnabled,
    updateMailProfile,
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
    MAIL_SECURITY_KINDS,
    buildMailBody,
    buildMailSubject,
    mailRecipientsProblem,
    validateMailAddress,
    validateMailHost,
    validateMailPort,
} from '../../shared/notify-mail';
import {
    NOTIFIABLE_EVENT_KINDS,
    resolveNotifyRate,
    resolveNotifyTimeoutMs,
    validateNotifyUrl,
} from '../../shared/notify-channels';
import {buildMailProfileRecord, resolveMailServer, sendMailMessage, toMailProfile} from '../services/notify-mail';
import {createLogger} from '../utils/logger';
import type {MailProfile, MailProfileDraft, NotifyChannel, NotifyChannelDraft} from '../../shared/types';

const log = createLogger('NotifyIpc');

// 这一层只认「字段在不在、类型对不对」；区间（超时毫秒、每分钟条数、端口）与语义
// （地址协议、主机名形状、事件名认不认得）都在 shared/notify-channels 与 shared/notify-mail 里判
// ——那套规则要能被假数据自测覆盖，也要在这条通道上用，分成两处写迟早一处松一处紧。
const EventSchema = z.enum(NOTIFIABLE_EVENT_KINDS);
const KindSchema = z.enum(['generic', 'dingtalk', 'feishu', 'wecom', 'slack', 'email']);

const ChannelSchema = z
    .object({
        id: z.string().uuid().optional(),
        // 全空格的名字过不了 min(1)，但会被 trim 成空串——列表里那一格变成空白，
        // 而投递记录里的 channel_name 也跟着空，所以这里判的是 trim 之后
        name: z
            .string()
            .max(80)
            .refine(value => value.trim().length > 0, '渠道名字不能是空的'),
        kind: KindSchema,
        // 可以留空：留空是「沿用库里那一份」，不是「把地址清掉」（见 saveChannel）；
        // 邮件渠道根本没有地址，这一格干脆由 zod 补成空串而不是让渲染层每次带着它
        url: z.string().max(2048).default(''),
        secret: z.string().max(512).optional().nullable(),
        mailProfileId: z.string().uuid().optional().nullable(),
        recipients: z.string().max(4000).optional(),
        enabled: z.boolean().optional(),
        events: z.array(EventSchema).max(NOTIFIABLE_EVENT_KINDS.length).optional(),
        minLevel: z.enum(['info', 'warn', 'crit']).optional(),
        timeoutMs: z.number().optional(),
        ratePerMinute: z.number().optional(),
    })
    .strict();

const MailProfileSchema = z
    .object({
        id: z.string().uuid().optional(),
        name: z
            .string()
            .max(80)
            .refine(value => value.trim().length > 0, '服务器名字不能是空的'),
        host: z.string().min(1).max(253),
        port: z.number(),
        security: z.enum(MAIL_SECURITY_KINDS),
        username: z.string().max(254).optional().nullable(),
        // 留空是「沿用库里那一份密码」，与渠道的地址/密钥同一口径；用户名清空则连密码一起丢
        password: z.string().max(512).optional().nullable(),
        fromAddress: z.string().min(1).max(254),
        fromName: z.string().max(120).optional().nullable(),
        allowSelfSigned: z.boolean().optional(),
    })
    .strict();

const IdSchema = z.object({id: z.string().uuid()}).strict();
const EnabledSchema = z.object({id: z.string().uuid(), enabled: z.boolean()}).strict();
const DeliverySchema = z.object({limit: z.number().int().min(1).max(200).optional()}).strict();
const MailTestSchema = z.object({id: z.string().uuid(), to: z.string().max(254).optional().nullable()}).strict();

/**
 * 保存一条渠道（新建与编辑共用）。
 *
 * 列表页拿到的是打码地址、密钥从不回填，所以地址与密钥都按「留空表示不改」处理；
 * 新建时没有可沿用的东西，地址留空直接拒绝。
 *
 * 邮件渠道反过来：它没有地址，「新建时必须填的那一格」是那台 SMTP 服务器与收件人清单。
 * 两样都在保存前判掉，因为一条没选服务器的邮件渠道落库之后只会以一句 skip 投递记录的形式
 * 出现在群里看不见的地方。
 */
function saveChannel(draft: NotifyChannelDraft): NotifyChannel {
    const url = draft.url.trim();
    const isEmail = draft.kind === 'email';
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
    if (!existing && !url && !isEmail) {
        throw new Error('新建渠道必须填写通知地址');
    }
    if (isEmail) {
        const profileId = draft.mailProfileId ?? existing?.mail_profile_id ?? '';
        if (!profileId) {
            throw new Error('新建邮件渠道要先选一台邮件服务器');
        }
        if (!getMailProfileById(profileId)) {
            throw new Error('这台邮件服务器已经不在了，请重新选一台');
        }
        const recipientsProblem = mailRecipientsProblem(draft.recipients ?? existing?.recipients);
        if (recipientsProblem) {
            throw new Error(recipientsProblem);
        }
    }

    const at = new Date().toISOString();
    const record = buildChannelRecord(
        {
            ...draft,
            // 上面判过的那两格才是真正要存的：编辑邮件渠道时如果这一份 draft 没带服务器或
            // 收件人（别的入口发过来的表单少了字段），沿用库里那一版比把它们清成空更安全
            mailProfileId: isEmail ? (draft.mailProfileId ?? existing?.mail_profile_id ?? null) : null,
            recipients: isEmail ? (draft.recipients ?? existing?.recipients ?? '') : '',
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

/**
 * 保存一台邮件服务器（新建与编辑共用）。
 *
 * 名字唯一是库里那条 UNIQUE 约束的口径，但约束本身抛出来的是
 * `SQLITE_CONSTRAINT_UNIQUE`，对运维没有信息量，所以先查一次、说人话。
 */
function saveMailProfile(draft: MailProfileDraft): MailProfile {
    const hostProblem = validateMailHost(draft.host);
    if (hostProblem) {
        throw new Error(hostProblem);
    }
    const portProblem = validateMailPort(draft.port);
    if (portProblem) {
        throw new Error(portProblem);
    }
    const fromProblem = validateMailAddress(draft.fromAddress);
    if (fromProblem) {
        throw new Error(`发件地址：${fromProblem}`);
    }
    // 用户名要么是一个邮件地址、要么是一个纯账号名（有些企业 SMTP 就这样）；
    // 唯一要挡的是带空格或逗号的那一种，因为它会让 nodemailer 拼出一个错误的 AUTH 参数。
    // undefined 与空串含义不同：前者是渲染层拿不到明文时的「沿用」，后者才是明确的「不登录」。
    const username = draft.username === undefined ? undefined : draft.username.trim();
    if (username && /[\s,]/.test(username)) {
        throw new Error('用户名里不能有空格或逗号');
    }
    const existing = draft.id ? getMailProfileById(draft.id) : null;
    if (draft.id && !existing) {
        throw new Error('这台邮件服务器已经不在了，请刷新列表');
    }
    const name = draft.name.trim();
    const clash = listMailProfiles().find(item => item.name === name && item.id !== (draft.id ?? ''));
    if (clash) {
        throw new Error(`已经有同名的一台邮件服务器了：${name}`);
    }

    const at = new Date().toISOString();
    const record = buildMailProfileRecord({...draft, username}, existing, draft.id ?? randomUUID(), at);
    if (existing) {
        updateMailProfile(record);
    } else {
        insertMailProfile(record);
    }
    // 日志里只留主机与端口：账号、密码、发件人都不属于这一行
    log.info(`mail profile ${record.id} (${record.host}:${record.port}) ${draft.id ? 'updated' : 'created'}`);
    return toMailProfile(record);
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

    registerHandler('notify:mail:list', async () => listMailProfiles().map(toMailProfile));

    registerHandler('notify:mail:save', async (params: unknown) =>
        saveMailProfile(MailProfileSchema.parse(params) as MailProfileDraft),
    );

    registerHandler('notify:mail:delete', async (params: unknown) => {
        const {id} = IdSchema.parse(params);
        const using = countNotifyChannelsUsingMailProfile(id);
        return {deleted: deleteMailProfile(id) > 0, channelsUsing: using};
    });

    /**
     * 「测试这台服务器」：登录 + 发一封，落到一个指定收件人（不填就发给自己的发件地址）。
     *
     * 它不走渠道，因为这时候还没有渠道：这一台服务器配得对不对，得能在填收件人之前先被证伪。
     * 也不受渠道那套订阅/级别/限流影响——判的从来就不是「该不该发」。
     */
    registerHandler('notify:mail:test', async (params: unknown) => {
        const input = MailTestSchema.parse(params);
        const server = resolveMailServer(input.id);
        const record = server.record;
        if (server.problem || !record) {
            throw new Error(server.problem ?? '这台邮件服务器已经不在了，请刷新列表');
        }
        const to = (input.to ?? '').trim() || record.from_address;
        const problem = validateMailAddress(to);
        if (problem) {
            throw new Error(`测试收件人：${problem}`);
        }
        const event = buildTestEvent();
        const outcome = await sendMailMessage({
            server,
            to: [to],
            subject: buildMailSubject(event),
            text: buildMailBody(event),
            // 一次手动测试值得多等一会儿：SMTP 要过 DNS、握手、登录三段，
            // 渠道上那个 5 秒是给自动派发用的，不该用来判「这台服务器到底配对了没」
            timeoutMs: 20_000,
        });
        log.info(`mail profile ${input.id} test ${outcome.ok ? 'ok' : 'failed'}`);
        return outcome;
    });
}
