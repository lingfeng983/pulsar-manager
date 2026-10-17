/**
 * 邮件这一条路：把库里的服务器配置变成一次真实的 SMTP 发送。
 *
 * 分成三层是本批最关键的一件事：判定（shared/notify-mail.ts）不算网络、不碰数据库，
 * 所以「465 选错加密会怎样」「550 那句回话该说成什么」能在没有邮件服务器的机器上被自测证伪；
 * 这一层只负责拿 nodemailer 真发一次、把结论写成 shared 那套分类。派发（notify-dispatch.ts）
 * 负责把库里的行变成上面两者要的那几格。
 *
 * 密码只在真要发信的那一刻解出来，且只活在这一次调用里；出界的表面（列表页、日志、投递记录）
 * 一律只有用户名打码后的样子与收件人。
 */
import nodemailer from 'nodemailer';
import {getMailProfileById, type MailProfileRecord} from '../database/sqlite';
import {classifyMailFailure, formatMailFrom, maskMailUser} from '../../shared/notify-mail';
import {decrypt, encrypt} from './encryption';
import {createLogger} from '../utils/logger';
import type {MailProfile, MailProfileDraft, MailSecurity} from '../../shared/types';

const log = createLogger('NotifyMail');

/**
 * 解密失败与「这一格本来就是空的」必须分开。
 *
 * 混起来的后果很具体：keyring 不可用的机器上，密码读不出来 = 没有密码 = 匿名发信，
 * 而那台服务器多半会回一句 535，于是渠道显示成「密码不对」，改多少次都没用。
 */
interface Decrypted {
    value: string | null;
    failed: boolean;
}

function tryDecrypt(ciphertext: string | null): Decrypted {
    if (!ciphertext) {
        return {value: null, failed: false};
    }
    try {
        return {value: decrypt(ciphertext), failed: false};
    } catch (error) {
        log.warn(`mail password decrypt failed: ${error instanceof Error ? error.message : String(error)}`);
        return {value: null, failed: true};
    }
}

/** 库里 → 渲染层：用户名按长度打码、密码只留「存过东西」这一个布尔值。 */
export function toMailProfile(record: MailProfileRecord): MailProfile {
    return {
        id: record.id,
        name: record.name,
        host: record.host,
        port: record.port,
        security: record.security as MailSecurity,
        username: maskMailUser(record.username),
        hasPassword: !!record.password_enc,
        fromAddress: record.from_address,
        fromName: record.from_name,
        allowSelfSigned: record.allow_self_signed === 1,
        createdAt: record.created_at,
        updatedAt: record.updated_at,
    };
}

/**
 * draft + 现值 → 落库行。
 *
 * 密码留空是「沿用库里那一份」，与渠道的地址/密钥同一口径（渲染层永远拿不到明文，回填只能回填
 * 打码串）。用户名同理：渲染层拿到的是打码串，所以留空（undefined）表示沿用，而不是清空——
 * 否则「只想改个端口」保存一次就会把登录账号与密码一起抹掉。要换账号就填新的；
 * 显式传空串才表示「这台不要登录」，此时库里那个密码一起丢掉——留着它，下一次填回用户名
 * 就会拿一个没人记得的旧密码去试。
 */
export function buildMailProfileRecord(
    draft: MailProfileDraft,
    existing: MailProfileRecord | null,
    id: string,
    at: string,
): MailProfileRecord {
    const username = draft.username === undefined ? (existing?.username ?? '') : draft.username.trim();
    const password = (draft.password ?? '').trim();
    let passwordEnc: string | null;
    if (password) {
        passwordEnc = encrypt(password);
    } else if (draft.username !== undefined && !username) {
        passwordEnc = null;
    } else {
        passwordEnc = existing?.password_enc ?? null;
    }
    return {
        id,
        name: draft.name.trim(),
        host: draft.host.trim().toLowerCase(),
        port: draft.port,
        security: draft.security,
        username,
        password_enc: passwordEnc,
        from_address: draft.fromAddress.trim(),
        from_name: (draft.fromName ?? '').trim(),
        allow_self_signed:
            draft.allowSelfSigned === undefined ? (existing?.allow_self_signed ?? 0) : draft.allowSelfSigned ? 1 : 0,
        created_at: existing?.created_at ?? at,
        updated_at: at,
    };
}

/** 一次发送真正要用的那几格（已经解密、已经校验过形状）。 */
export interface ResolvedMailServer {
    record: MailProfileRecord | null;
    password: string | null;
    /** null 表示这台现在发得出去；否则是「为什么发不出去」，会原样落进投递记录。 */
    problem: string | null;
}

/**
 * 渠道指着的那台服务器到底用不用得上。
 *
 * 这里只回答「配置能不能用」，不管该不该发——「该不该」整条在 decideNotifyDelivery 里，
 * 好让那套规则在没有数据库、没有网络的机器上被自测逐条证伪。
 */
export function resolveMailServer(profileId: string | null): ResolvedMailServer {
    if (!profileId) {
        return {record: null, password: null, problem: '这条邮件渠道还没选邮件服务器'};
    }
    const record = getMailProfileById(profileId);
    if (!record) {
        return {record: null, password: null, problem: '这台邮件服务器已经不在了（渠道还指着它）'};
    }
    const secret = tryDecrypt(record.password_enc);
    if (secret.failed) {
        return {record, password: null, problem: '密码读不出来：本机密钥库可能不可用，重新填一次密码即可恢复'};
    }
    return {record, password: secret.value, problem: null};
}

export interface MailSendOutcome {
    ok: boolean;
    message: string;
}

/**
 * 发一封。只发一次、不重试：与 webhook 那一路同一口径——这是桌面应用，进程一退队列即丢，
 * 「稍后补发」是一个兑现不了的承诺，所以宁可当场写明没有排队。
 *
 * 超时用调用方给的那一个（渠道上的 timeout_ms）：连接、问候与写 socket 三段都按它设上限，
 * 因为一次卡住的 SMTP 会把整条派发链一起卡住。
 */
export async function sendMailMessage(args: {
    server: ResolvedMailServer;
    to: string[];
    subject: string;
    text: string;
    timeoutMs: number;
}): Promise<MailSendOutcome> {
    const record = args.server.record;
    if (!record) {
        // 走到这里说明派发层漏了判定，宁可回一句实话而不是拿 undefined 去建连接
        return {ok: false, message: args.server.problem ?? '邮件服务器配置不可用'};
    }
    const password = args.server.password;
    const transporter = nodemailer.createTransport({
        host: record.host,
        port: record.port,
        // 465 是隐式 TLS（一连上就握手），587/25 是明文起会话再 STARTTLS。
        // requireTLS 只对 starttls 生效：勾了「不加密」还强行升级，内网 25 端口会变成一个
        // 谁也解释不了的失败，所以宁可按用户选的那一种发出去，让失败说真话。
        secure: record.security === 'tls',
        requireTLS: record.security === 'starttls',
        auth: record.username ? {user: record.username, pass: password ?? ''} : undefined,
        tls: {rejectUnauthorized: record.allow_self_signed ? false : true},
        connectionTimeout: args.timeoutMs,
        greetingTimeout: args.timeoutMs,
        socketTimeout: args.timeoutMs,
        // 一台服务器多条渠道 = 多次发送，每次都新建连接而不是攒池子：
        // 应用可能在两条渠道之间被关掉，池里那条连接没人负责收
        pool: false,
        logger: false,
    });

    try {
        const info = await transporter.sendMail({
            from: formatMailFrom(record.from_address, record.from_name),
            to: args.to.join(', '),
            subject: args.subject,
            text: args.text,
            // 通知正文里如果出现 `file://` 或 http 链接，nodemailer 默认会把它当附件/内嵌资源去读。
            // 一封自动生成的邮件不该有读本机文件的能力，这一条与「不跟重定向」是同一件事。
            disableFileAccess: true,
            disableUrlAccess: true,
        });
        // 250 不等于每个人都收到了：nodemailer 会把被退回的收件人放在 info.rejected 里，
        // 而 sendMail 照样 resolve。不看它的话，「地址不存在」会显示成一次成功。
        const rejected = Array.isArray(info?.rejected) ? info.rejected : [];
        if (rejected.length) {
            return {
                ok: false,
                message: `邮件被服务器退回 ${rejected.length} 个收件人：${String(rejected.slice(0, 3).join('、'))}`,
            };
        }
        const response = typeof info?.response === 'string' ? info.response.trim().slice(0, 120) : '';
        return {ok: true, message: `已送出（${record.host}:${record.port}${response ? `，${response}` : ''}）`};
    } catch (error) {
        const info = classifyMailFailure(error);
        // 日志里只留服务器与分类：正文、收件人清单与密码都不属于这一行
        log.warn(`mail send failed for ${record.host}:${record.port}: ${info.message}`);
        return {ok: false, message: info.message};
    } finally {
        transporter.close();
    }
}
