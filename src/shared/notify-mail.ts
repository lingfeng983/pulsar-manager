/**
 * 邮件渠道的纯逻辑：主机/端口/地址校验、收件人清单解析、主题与正文拼装、SMTP 失败分类。
 *
 * 这里不 import nodemailer、不碰数据库、不连网络，所以「465 该选哪种加密」「收件人里混进一个
 * 少了 @ 的地址会怎样」这些问题都能在没装邮件服务器的机器上被 scripts/notify-selftest.cjs
 * 逐条证伪。真正发信在 services/notify-mail.ts。
 *
 * 邮件与那几家群机器人最大的不同：一次发送要过一台**服务器**，而一台服务器可以给多条渠道用
 * （同一条 SMTP、值班群 A 与值班群 B 各自的收件人）。所以主机、账号与密码放在渠道之外的一张
 * 配置表里，渠道只带「用哪台服务器」和「发给谁」。密码按凭据处理：库里只有密文，出界的表面
 * 一律看不到它。
 */
import {NOTIFY_LEVEL_LABEL, renderNotifyText} from './notify-channels';
import type {MailSecurity, NotifyEvent} from './types';

/** 收件人上限：一条渠道挂几百个地址，等于把「群里发一条」变成「群发一封」，出事时没人拦得住。 */
export const MAIL_RECIPIENT_MAX = 20;

/** 邮件正文的字节上限：比群消息宽，一封邮件读得下更长的排查线索。 */
export const MAIL_BODY_MAX_BYTES = 16_384;

/** 主题长度上限（多数 MTA 不拦，但一屏看不完的主题没有意义）。 */
export const MAIL_SUBJECT_MAX_CHARS = 200;

/** 各家默认端口：25 明文、587 STARTTLS、465 隐式 TLS。选了加密方式就照它给默认值。 */
export const MAIL_DEFAULT_PORT: Record<MailSecurity, number> = {
    plain: 25,
    starttls: 587,
    tls: 465,
};

export const MAIL_SECURITY_LABEL: Record<MailSecurity, string> = {
    plain: '不加密',
    starttls: 'STARTTLS',
    tls: 'SSL/TLS（隐式）',
};

/** 界面与校验都认这三种；写成数组是为了让 zod 的枚举取值表只有这一个出处。 */
export const MAIL_SECURITY_KINDS = ['plain', 'starttls', 'tls'] as const satisfies readonly MailSecurity[];

export function isKnownMailSecurity(input: string): input is MailSecurity {
    return (MAIL_SECURITY_KINDS as readonly string[]).includes(input);
}

/**
 * 主机只填名字，不带协议前缀。
 *
 * 这里拒绝 `smtp://` 与 `smtp.gmail.com:465`：前者 nodemailer 的 host 字段不认，后者会让人
 * 以为端口已经设好——两样都在报错里说过该填哪儿，比让配置以「已保存」的样子存下来有用。
 */
export function validateMailHost(raw: string | undefined | null): string | null {
    const host = (raw ?? '').trim();
    if (!host) {
        return 'SMTP 服务器地址不能为空';
    }
    if (/\s/.test(host)) {
        return '服务器地址里不能有空格';
    }
    if (/^[a-z]+:\/\//i.test(host)) {
        return '服务器地址只填主机名，不要带 smtp:// 或 https:// 前缀';
    }
    if (host.includes('@')) {
        return '服务器地址里不要写用户名，账号请填在「用户名」那一格';
    }
    if (host.includes(':')) {
        return '端口是单独的一格，服务器地址里不要写 :465 这样的尾巴';
    }
    if (!host.includes('.') && host.toLowerCase() !== 'localhost') {
        return '服务器地址看着不完整（没有点，也不是 localhost）';
    }
    if (host.length > 253) {
        return '服务器地址过长（上限 253 字符）';
    }
    return null;
}

/** 端口只接受区间内的整数，越界是拒绝而不是夹住（与巡检采样上限、通知超时同一口径）。 */
export function validateMailPort(port: unknown): string | null {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
        return '端口必须是 1～65535 之间的整数';
    }
    return null;
}

/**
 * 一个邮件地址长什么样才算数。
 *
 * 只做结构判定，不查 DNS 也不发信——RFC 5322 允许的写法比这个宽得多，但那些写法在这里的
 * 价值只有一个：让一个手滑的地址存进库、然后每一次告警都静默地少收一个人。@ 前后都非空、
 * 域名含点、整串没有空格或逗号，能挡住实际里几乎所有的配错。
 */
export function validateMailAddress(raw: string): string | null {
    const address = raw.trim();
    if (!address) {
        return '地址不能为空';
    }
    if (address.length > 254) {
        return '地址过长（上限 254 字符）';
    }
    if (address.length > 64 && address.indexOf('@') > 64) {
        return '@ 之前的部分过长（上限 64 字符）';
    }
    if (!/^[^\s@,;<>"']+@[^\s@,;<>"']+$/.test(address)) {
        return '不像一个邮件地址（要有一个 @，且不含空格或逗号）';
    }
    const domain = address.slice(address.lastIndexOf('@') + 1);
    if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
        return '邮件地址里的域名部分写法不对';
    }
    if (!domain.includes('.')) {
        return '邮件地址里的域名缺少点（`mail@localhost` 这类地址收不到信）';
    }
    return null;
}

/**
 * 收件人清单：逗号、分号、空白或换行分隔都认，逐个校验并按原样去重。
 *
 * 去重按小写比较而保留第一次出现的那种写法：`Ops@corp.com` 与 `ops@corp.com` 在 MTA 那里是
 * 同一个信箱，留两份等于同一封邮件发两遍，而人只会以为自己配了两个人。
 */
export function parseMailRecipients(raw: string | undefined | null): {to: string[]; invalid: string[]} {
    const to: string[] = [];
    const invalid: string[] = [];
    const seen = new Set<string>();
    for (const part of (raw ?? '').split(/[,;\s]+/)) {
        const address = part.trim();
        if (!address) {
            continue;
        }
        if (validateMailAddress(address)) {
            invalid.push(address);
            continue;
        }
        const key = address.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        to.push(address);
    }
    return {to, invalid};
}

/** 渠道的收件人这一格到底行不行：返回要写给用户的那句话，null 表示能用。 */
export function mailRecipientsProblem(raw: string | undefined | null): string | null {
    const {to, invalid} = parseMailRecipients(raw);
    if (invalid.length) {
        return `这些收件人不像邮件地址：${invalid.slice(0, 3).join('、')}${invalid.length > 3 ? ` 等 ${invalid.length} 个` : ''}`;
    }
    if (!to.length) {
        return '至少填一个收件人，否则这条渠道永远不会开口';
    }
    if (to.length > MAIL_RECIPIENT_MAX) {
        return `收件人最多 ${MAIL_RECIPIENT_MAX} 个，现在是 ${to.length} 个`;
    }
    return null;
}

/**
 * 一次邮件发送的全部可判事实（在派发层从库里凑齐，判定全部在这里）。
 *
 * 与 urlProblem 那一格同一角色：邮件渠道的「地址能不能用」由这三件事决定——服务器在不在、
 * 收件人是不是空的、用户名密码配没配得起来。
 */
export interface MailTargetFacts {
    /** null 表示服务器配置读出来了 */
    profileProblem: string | null;
    recipients: string[];
}

/** 把上面这几格合成一句能落进投递记录的原因；null 表示这条现在发得出去。 */
export function mailTargetProblem(facts: MailTargetFacts): string | null {
    if (facts.profileProblem) {
        return facts.profileProblem;
    }
    if (!facts.recipients.length) {
        return '收件人是空的：这条邮件渠道没填收件人';
    }
    return null;
}

/** 主题：级别 + 标题。收件人在收件箱里先看到的只有这一行，所以级别必须在这里而不是只在正文里。 */
export function buildMailSubject(event: NotifyEvent): string {
    const head = event.title.trim() || 'Pulsar 通知';
    const subject = `[pulsar-manager·${NOTIFY_LEVEL_LABEL[event.level]}] ${head}`;
    // 按码点而不是 UTF-16 单元截断：标题里有 emoji 时，slice 可能正好劈开代理对，
    // 收件箱里会显示成一个替换字符。
    const chars = Array.from(subject);
    return chars.length > MAIL_SUBJECT_MAX_CHARS ? `${chars.slice(0, MAIL_SUBJECT_MAX_CHARS - 1).join('')}…` : subject;
}

/** 正文：与群消息同一套排版（标题、正文、来源、时间），只是字节预算更宽。 */
export function buildMailBody(event: NotifyEvent): string {
    return renderNotifyText(event, MAIL_BODY_MAX_BYTES);
}

export interface MailFailureInfo {
    message: string;
    category: 'auth' | 'relay' | 'recipient' | 'tls' | 'timeout' | 'dns' | 'refused' | 'config' | 'network' | 'unknown';
}

/**
 * 把一次 SMTP 失败写成照得做的句子。
 *
 * 「发送失败」在这件事上尤其没用：邮件的失败原因几乎全在服务器的那句回话里，而 nodemailer
 * 把它塞在 error.message / response / responseCode 三个地方。按签名分类，未命中才退回原文。
 * 文案以 SMTP 回话码为准（4.x 临时、5.x 永久），各家服务器措辞差异只在末尾那段原文里体现。
 */
export function classifyMailFailure(error: unknown): MailFailureInfo {
    const err = (error ?? {}) as {message?: string; code?: string; response?: string; responseCode?: number};
    const code = typeof err.code === 'string' ? err.code : '';
    const response = typeof err.response === 'string' ? err.response : '';
    const raw = (err.message ?? String(error ?? '')).trim();
    const text = `${code} ${response} ${raw}`.toLowerCase();

    if (code === 'EAUTH' || /\b53[45]\b/.test(text) || text.includes('authentication failed')) {
        return {
            category: 'auth',
            message: `登录这台 SMTP 服务器没通过：用户名、密码或授权码不对${raw ? `（${raw.slice(0, 200)}）` : ''}`,
        };
    }
    // 550/553 里「不转发」是最常见的一种：账号能登录，但不许你把信发给本域之外的人
    if (/\b55[0-9]\b/.test(text) && /(relay|relaying|not allowed|unable to relay)/.test(text)) {
        return {
            category: 'relay',
            message: `这台服务器拒绝把信转发给这些收件人（通常是没登录、或收件人域不在它的转发范围里）${response ? `（${response.slice(0, 200)}）` : ''}`,
        };
    }
    if (/\b55[0-9]\b/.test(text) && /(user unknown|mailbox|recipient|address rejected|no such)/.test(text)) {
        return {
            category: 'recipient',
            message: `收件人被服务器退回了（地址不存在或拒收）${response ? `（${response.slice(0, 200)}）` : ''}`,
        };
    }
    if (/\b4\d\d\b/.test(text) || /(temporar|try again|service not available)/.test(text)) {
        return {
            category: 'network',
            message: `服务器这一会儿不收件（临时错误，没有排队补发）${response ? `（${response.slice(0, 200)}）` : ''}`,
        };
    }
    if (
        text.includes('self signed') ||
        text.includes('self-signed') ||
        text.includes('unable to verify') ||
        text.includes('certificate') ||
        text.includes('x509') ||
        text.includes('altname')
    ) {
        return {
            category: 'tls',
            message: `证书校验没过：内网自签证书需要在服务器配置里勾「接受自签证书」${raw ? `（${raw.slice(0, 200)}）` : ''}`,
        };
    }
    if (
        text.includes('greeting never received') ||
        text.includes('ssl connect') ||
        text.includes('wrong version number')
    ) {
        return {
            category: 'config',
            message: `加密方式与端口对不上：465 选 SSL/TLS，25 或 587 选不加密 / STARTTLS${raw ? `（${raw.slice(0, 200)}）` : ''}`,
        };
    }
    if (text.includes('enotfound') || text.includes('eai_again') || text.includes('getaddrinfo')) {
        return {category: 'dns', message: `主机名解析不了：检查服务器地址是否写错（${raw}）`};
    }
    if (text.includes('econnrefused')) {
        return {category: 'refused', message: `连接被拒绝：这台服务器或这个端口没在监听（${raw}）`};
    }
    if (
        code === 'ESOCKET' ||
        code === 'ECONNECTION' ||
        text.includes('timeout') ||
        text.includes('timed out') ||
        text.includes('econnreset')
    ) {
        return {category: 'timeout', message: `连不上或连上之后没回应（超时）${raw ? `（${raw.slice(0, 200)}）` : ''}`};
    }
    if (raw) {
        return {category: 'network', message: raw.slice(0, 300)};
    }
    return {category: 'unknown', message: '未知错误，没有可用的失败信息'};
}

/** 发件人显示串：`名字 <地址>`；名字为空就只留地址，不留下尖括号。 */
export function formatMailFrom(address: string, displayName: string): string {
    const name = displayName.trim();
    if (!name) {
        return address.trim();
    }
    // 名字里的引号与尖括号会被 MTA 当成地址语法的一部分，去掉比转义省事也不会拼出一个假地址
    const safe = name.replace(/[<>"\\]/g, '').trim();
    return safe ? `${safe} <${address.trim()}>` : address.trim();
}

/**
 * 出界用的地址：只显示收件人与发件人，绝不显示密码。
 *
 * 邮件地址不是凭据（它本来就写在信头里），但一次配置的截图会发到值班群里，
 * 所以这一格只留「本机要发去的那台服务器」，与渠道地址同一口径。
 */
export function maskMailUser(username: string): string {
    const user = username.trim();
    if (!user) {
        return '';
    }
    const problem = validateMailAddress(user);
    // 不是邮件地址的用户名（有些企业 SMTP 就填个账号名）按长度打码
    if (problem) {
        return user.length <= 2 ? '***' : `${user.slice(0, 2)}***`;
    }
    const at = user.lastIndexOf('@');
    return `${user.slice(0, Math.min(3, at))}***${user.slice(at)}`;
}
