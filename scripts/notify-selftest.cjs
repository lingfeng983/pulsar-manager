/**
 * v3.3 外部通知渠道自测：不连任何对端、不开窗口，把「这一条到底该不该发、发出去没有」
 * 这两件事逐条证伪。
 *
 * 这一层的失败方式全都是「安静地什么都没发生」：地址配错、级别线卡住、机器人没命中关键词、
 * 限流用完——用户在群里看不到消息，在应用里也看不到任何痕迹。所以判定必须能在没有网络的
 * 机器上被跑坏并指出来，而不是等一次真实告警去撞。
 *
 * 跑法：npm run selftest:notify（先编译主进程，再跑这一份）。
 * 披露：axios 那一次真实的 POST 不在本自测覆盖之内（对端不可用），但状态码与响应体怎么折成
 * 一句结论、签名怎么算，全部在这里按各家文档口径钉死了。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const K = require('../dist/src/shared/notify-channels.js');
const M = require('../dist/src/shared/notify-mail.js');
const P = require('../dist/src/main/services/notify-payload.js');
const {SCHEMA_SQL} = require('../dist/src/main/database/schema.js');

let passed = 0;
const failures = [];

function check(name, fn) {
    try {
        fn();
        passed += 1;
    } catch (error) {
        failures.push(`${name}：${error && error.message ? error.message : String(error)}`);
    }
}

function eq(actual, expected, label) {
    assert.strictEqual(actual, expected, `${label || ''} 期望 ${expected}，实际 ${actual}`);
}

function deepEq(actual, expected, label) {
    assert.deepStrictEqual(
        actual,
        expected,
        `${label || ''} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
    );
}

function contains(text, needle, label) {
    assert.ok(String(text).includes(needle), `${label}：「${text}」里没有「${needle}」`);
}

function throwsWith(fn, pattern, label) {
    let message = null;
    try {
        fn();
    } catch (error) {
        message = error && error.message ? error.message : String(error);
    }
    assert.ok(message !== null, `${label}：应当抛错，结果正常返回了`);
    assert.ok(pattern.test(message), `${label}：报错文案是「${message}」，不含期望的关键字`);
}

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 17, 1, 2, 3);

function eventOf(overrides) {
    return {
        kind: 'alertFired',
        level: 'crit',
        title: '告警：积压超阈值',
        text: 'consumer-backlog 1280000 条',
        clusterId: 'c1',
        clusterName: 'prod-a',
        atMs: NOW,
        ...overrides,
    };
}

function factsOf(overrides) {
    return {
        enabled: true,
        targetProblem: null,
        events: ['alertFired', 'inspectionCrit'],
        minLevel: 'warn',
        ratePerMinute: 20,
        recentSendAtMs: [],
        ...overrides,
    };
}

// ---------------------------------------------------------------- 地址：什么算一个发得出去的地址

check('https/http 都收，缺协议与非 http 协议一律拒绝', () => {
    eq(K.validateNotifyUrl('https://oapi.dingtalk.com/robot/send?access_token=x'), null, '钉钉地址');
    eq(K.validateNotifyUrl('http://localhost:8080/hook'), null, '本机 http 测试地址');
    eq(K.validateNotifyUrl('http://[::1]:18080/hook'), null, '本机 IPv6 字面量');
    contains(K.validateNotifyUrl('ftp://host/hook'), 'http://', '非 http 协议');
    contains(K.validateNotifyUrl('file:///etc/passwd'), 'http://', 'file 协议');
    contains(K.validateNotifyUrl(''), '不能为空', '空地址');
    contains(K.validateNotifyUrl(null), '不能为空', 'null');
});

check('地址里的空格、超长与不完整主机名都被挡', () => {
    contains(K.validateNotifyUrl('https://host/a b'), '空格', '带空格');
    contains(K.validateNotifyUrl(`https://host/${'a'.repeat(2100)}`), '2048', '超长');
    eq(K.validateNotifyUrl('https://pulsar-broker.internal/hook'), null, '含点的内网名');
    eq(K.validateNotifyUrl('https://127.0.0.1:18080/hook'), null, 'IP 形式');
    // 没有点又没有写 localhost 的一定敲错了：发出去只会得到一句 DNS 失败
    contains(K.validateNotifyUrl('https://pulsar/hook'), '主机名', '无点主机名');
});

check('带 @ 的地址按凭据风险拒绝，但只在 authority 段判', () => {
    contains(K.validateNotifyUrl('https://user:pass@hooks.slack.com/services/T/B/X'), '用户名密码', 'basic auth');
    // 路径里出现 @ 是合法的（Slack 的 webhook 路径就允许），不能因为一个字符整条拒掉
    eq(K.validateNotifyUrl('https://hooks.slack.com/services/EXAMPLE/EXAMPLE/EXAMPLE@here'), null, '路径含 @');
});

check('列表页复制回来的打码地址被拒绝，不会被当成新地址存下去', () => {
    // "***" 本身是合法主机名字符：不拦的话，「复制列表里的打码串粘回表单」会把密文覆盖掉
    contains(K.validateNotifyUrl('https://oapi.dingtalk.com/robot/send?access_token=***'), '打码标记', '查询串打码');
    contains(K.validateNotifyUrl('https://open.feishu.cn/open-apis/bot/v2/hook/abc***'), '打码标记', '路径打码');
});

// ---------------------------------------------------------------- 超时与限流条数

check('超时与每分钟条数：缺省落默认值，越界拒绝而不是夹住', () => {
    eq(K.resolveNotifyTimeoutMs(undefined), 5000, '缺省超时');
    eq(K.resolveNotifyRate(null), 20, '缺省条数');
    eq(K.resolveNotifyTimeoutMs(1000), 1000, '下边界');
    eq(K.resolveNotifyTimeoutMs(30000), 30000, '上边界');
    eq(K.resolveNotifyRate(1), 1, '一条');
    eq(K.resolveNotifyRate(60), 60, '六十条');
    throwsWith(() => K.resolveNotifyTimeoutMs(999), /1000～30000/, '太短');
    throwsWith(() => K.resolveNotifyTimeoutMs(30001), /1000～30000/, '太长');
    throwsWith(() => K.resolveNotifyTimeoutMs(2500.5), /整数/, '小数');
    throwsWith(() => K.resolveNotifyRate(0), /1～60/, '零条');
    throwsWith(() => K.resolveNotifyRate(61), /1～60/, '超上限');
});

// ---------------------------------------------------------------- 订阅与级别线

check('订阅清单先判，级别线后判，相等算过', () => {
    eq(K.channelWantsEvent({events: ['alertFired'], minLevel: 'warn'}, eventOf()), true, '订了且过线');
    eq(K.channelWantsEvent({events: ['alertRecovered'], minLevel: 'warn'}, eventOf()), false, '没订这个事件');
    eq(K.channelWantsEvent({events: ['alertFired'], minLevel: 'crit'}, eventOf({level: 'crit'})), true, '正好压线');
    eq(K.channelWantsEvent({events: ['alertFired'], minLevel: 'crit'}, eventOf({level: 'warn'})), false, '低于线');
    eq(K.channelWantsEvent({events: [], minLevel: 'info'}, eventOf()), false, '一条都没订');
});

check('级别的高低是序数而不是字符串：info<warn<crit', () => {
    eq(K.NOTIFY_LEVEL_RANK.info < K.NOTIFY_LEVEL_RANK.warn, true, 'info 低于 warn');
    eq(K.NOTIFY_LEVEL_RANK.warn < K.NOTIFY_LEVEL_RANK.crit, true, 'warn 低于 crit');
    // 测试事件不能出现在可订阅清单里：它不是「会发生的事」，是一次人为尝试
    eq(K.NOTIFIABLE_EVENT_KINDS.includes('test'), false, 'test 不可订阅');
    eq(K.NOTIFIABLE_EVENT_KINDS.length, 5, '可订阅事件条数');
    eq(K.isKnownNotifyEventKind('test'), true, 'test 是已知事件');
    eq(K.isKnownNotifyEventKind('alertFired'), true, '告警触发');
    eq(K.isKnownNotifyEventKind('madeUpKind'), false, '未知事件名');
});

// ---------------------------------------------------------------- 限流窗口

check('限流按窗口内已发出的条数判，边界只算窗口内，未来的戳记也计入', () => {
    eq(K.isRateLimited([NOW - 1000], NOW, 1), true, '上限 1 且刚发过');
    eq(K.isRateLimited([NOW - 1000], NOW, 2), false, '还有一条额度');
    eq(K.isRateLimited([NOW - MINUTE], NOW, 1), false, '正好一分钟前的那条已出窗');
    eq(K.isRateLimited([NOW - (MINUTE - 1)], NOW, 1), true, '窗口内最后一毫秒');
    eq(K.isRateLimited([NOW + 1000], NOW, 1), true, '时钟回拨后跑到未来的戳记仍然占额度');
    // 上限 0 由区间校验在外面挡住，这里说的是万一漏进来也不会变成「随便发」
    eq(K.isRateLimited([], NOW, 0), true, '上限 0 是一条都不发');
});

// ---------------------------------------------------------------- 派发判定：发、不归我、还是被挡

check('干净的渠道判成 send，三种「不归它管」判成 ignore 且不落记录', () => {
    eq(K.decideNotifyDelivery(factsOf(), eventOf(), NOW).action, 'send', '正常');
    eq(K.decideNotifyDelivery(factsOf({enabled: false}), eventOf(), NOW).action, 'ignore', '渠道关着');
    eq(K.decideNotifyDelivery(factsOf({events: []}), eventOf(), NOW).action, 'ignore', '没订阅');
    eq(K.decideNotifyDelivery(factsOf({minLevel: 'crit'}), eventOf({level: 'warn'}), NOW).action, 'ignore', '低于级别线');
});

check('订阅命中而地址坏了是 skip：一条本来该发却没发，必须落成渠道自己的问题', () => {
    const broken = K.decideNotifyDelivery(factsOf({targetProblem: '地址不合法：主机名看着不完整'}), eventOf(), NOW);
    eq(broken.action, 'skip', '落一行');
    contains(broken.reason, '地址不合法', '原因原样带出');
    contains(broken.reason, '本来要发给它', '说清这条本来该发');
    eq(broken.configProblem, true, '派发层据此把原因写回渠道 last_error');
    // 顺序的另一半：本来就不收这个事件的坏渠道仍旧什么都不落，否则表里全是「不归我管」的噪声
    eq(
        K.decideNotifyDelivery(factsOf({targetProblem: '地址不合法：x', events: []}), eventOf(), NOW).action,
        'ignore',
        '没订阅 + 地址坏',
    );
    eq(
        K.decideNotifyDelivery(factsOf({targetProblem: '地址不合法：x', enabled: false}), eventOf(), NOW).action,
        'ignore',
        '渠道关着 + 地址坏',
    );
});

check('限流用满是 skip，并写明是谁挡的、没有排队补发', () => {
    const decision = K.decideNotifyDelivery(
        factsOf({ratePerMinute: 3, recentSendAtMs: [NOW - 100, NOW - 200, NOW - 300]}),
        eventOf(),
        NOW,
    );
    eq(decision.action, 'skip', '判定');
    contains(decision.reason, '3', '带上限条数');
    contains(decision.reason, '没有排队补发', '说明不会补发');
    // 限流是这台应用主动收着发，不是这条渠道坏了：写成 configProblem 会把一次告警风暴显示成连败
    eq(decision.configProblem, false, '不写回渠道');
});

check('窗口外的旧时间戳不会把这一条挡下', () => {
    const decision = K.decideNotifyDelivery(
        factsOf({ratePerMinute: 1, recentSendAtMs: [NOW - 2 * MINUTE, NOW - 3 * MINUTE]}),
        eventOf(),
        NOW,
    );
    eq(decision.action, 'send', '两条都已出窗');
});

check('手动测试绕开订阅、级别线、开关与限流，但地址不行仍要说出来', () => {
    const test = eventOf({kind: 'test', level: 'info', title: 'pulsar-manager 测试通知', clusterName: '', test: true});
    const busy = factsOf({enabled: false, events: [], minLevel: 'crit', ratePerMinute: 1, recentSendAtMs: [NOW - 1]});
    eq(K.decideNotifyDelivery(busy, test, NOW).action, 'send', '测试不看那四道');
    const blocked = K.decideNotifyDelivery(factsOf({targetProblem: '地址读不出来：x'}), test, NOW);
    eq(blocked.action, 'skip', '地址读不出来要落一条');
    contains(blocked.reason, '地址读不出来', '原因原样带出');
    eq(blocked.configProblem, true, '测试配坏的渠道也要写回 last_error');
});

// ---------------------------------------------------------------- 正文：字节上限与排版

check('按 UTF-8 字节截断，中文一个字三字节，且不在字节中间切断', () => {
    eq(K.truncateToBytes('abc', 10), 'abc', '没超就不动');
    eq(K.truncateToBytes('中文', 10), '中文', '六个字节没超');
    eq(K.truncateToBytes('abcdef', 0), '', '上限 0');
    // 预算比省略提示还小时硬截：宁可少一个字也不能吐出一个坏字符
    eq(K.truncateToBytes('中中中', 7), '中中', '两字六字节');
    eq(K.truncateToBytes('abcdef', 3), 'abc', '纯 ASCII 也按码点走');
    const cut = K.truncateToBytes('积压'.repeat(5000), 4096);
    eq(Buffer.byteLength(cut, 'utf8') <= 4096, true, '截完不超字节');
    contains(cut, '已截断', '带省略说明');
    eq(cut.includes('\uFFFD'), false, '没有半截字符');
});

check('正文四段：标题、正文、事件｜级别｜集群、时间；标题与正文重复时不写两遍', () => {
    const text = K.renderNotifyText(eventOf());
    const lines = text.split('\n\n');
    eq(lines[0], '告警：积压超阈值', '首行是标题');
    eq(lines[1], 'consumer-backlog 1280000 条', '第二行是正文');
    eq(lines[2], '告警触发｜严重｜集群：prod-a', '第三行是归属');
    contains(lines[3], '时间：', '末行是时间');
    eq(text, K.truncateToBytes(text, K.NOTIFY_TEXT_MAX_BYTES), '默认长度不该被截');
    eq(K.renderNotifyText(eventOf({text: '告警：积压超阈值'})).split('\n\n').length, 3, '正文与标题相同就省一行');
});

check('测试消息没有集群，就不写「集群：」那一格', () => {
    const text = K.renderNotifyText(eventOf({kind: 'test', clusterName: ''}));
    eq(text.includes('集群：'), false, '不含集群字样');
    contains(text, '测试消息', '事件名用中文标签');
});

check('超长正文在渲染层就压到上限内，各家 payload 不用再各截一遍', () => {
    const text = K.renderNotifyText(eventOf({text: '长'.repeat(9000)}));
    eq(Buffer.byteLength(text, 'utf8') <= K.NOTIFY_TEXT_MAX_BYTES, true, '字节数');
});

check('时间写成带 Z 的 UTC，非法时间戳说一句未知', () => {
    eq(K.formatNotifyTime(NOW), '2026-10-17 01:02:03Z', '常规');
    eq(K.formatNotifyTime(Number.NaN), '时间未知', 'NaN');
});

// ---------------------------------------------------------------- 对端响应：200 不等于送达到

check('2xx 之外的状态码折成人话，重定向单列一类', () => {
    eq(K.isNotifySuccessStatus(200), true, '200');
    eq(K.isNotifySuccessStatus(299), true, '299');
    eq(K.isNotifySuccessStatus(300), false, '300');
    eq(K.isNotifySuccessStatus(199), false, '199');
    const tooMany = K.classifyNotifyResponse(429, 'rate limited');
    eq(tooMany.ok, false, '429 不是成功');
    contains(tooMany.message, '429', '带上状态码');
    const redirect = K.classifyNotifyResponse(302, '', 'http://other-host/hook');
    eq(redirect.ok, false, '302 不算送达');
    contains(redirect.message, '重定向', '说明是重定向');
});

check('钉钉/企微的 200+errcode、飞书的 200+code、Slack 的 200+ok:false 都算被拒', () => {
    const keyword = K.classifyNotifyResponse(200, {errcode: 310000, errmsg: 'keyword not match'});
    eq(keyword.ok, false, 'errcode 非 0');
    contains(keyword.message, '310000', '带上 errcode');
    contains(keyword.message, 'keyword not match', '带上对端原文');
    eq(K.classifyNotifyResponse(200, {errcode: 0, errmsg: 'ok'}).ok, true, 'errcode 0 是成功');
    const feishu = K.classifyNotifyResponse(200, '{"code":19001,"msg":"param invalid"}');
    eq(feishu.ok, false, '飞书 code 非 0（响应体是字符串）');
    contains(feishu.message, '19001', '带上 code');
    contains(feishu.message, 'param invalid', '带上 msg');
    const slack = K.classifyNotifyResponse(200, {ok: false, error: 'invalid_auth'});
    eq(slack.ok, false, 'Slack ok:false');
    contains(slack.message, 'invalid_auth', '带上 error');
    eq(K.classifyNotifyResponse(200, 'no json here').ok, true, '非 JSON 的 200 按送达');
});

check('非 2xx 也带出对端原文：Slack 的 403 不能只报一个状态码', () => {
    const forbidden = K.classifyNotifyResponse(403, {ok: false, error: 'invalid_auth'});
    eq(forbidden.ok, false, '403 不是成功');
    contains(forbidden.message, '403', '带状态码');
    contains(forbidden.message, 'invalid_auth', '带对端原文');
    const gateway = K.classifyNotifyResponse(502, '<html>Bad Gateway</html>');
    contains(gateway.message, '502', '非 JSON 也带状态码');
});

check('网络失败按签名分类成照着能做的句子', () => {
    eq(K.classifyNotifyFailure(new Error('timeout of 5000ms exceeded')).category, 'timeout', '超时');
    eq(K.classifyNotifyFailure(new Error('connect ETIMEDOUT 1.2.3.4:443')).category, 'timeout', '连接超时');
    eq(K.classifyNotifyFailure(new Error('getaddrinfo ENOTFOUND hooks.slack.com')).category, 'dns', '解析失败');
    eq(K.classifyNotifyFailure(new Error('connect ECONNREFUSED 127.0.0.1:18080')).category, 'refused', '没人监听');
    eq(K.classifyNotifyFailure(new Error('unable to verify the first certificate')).category, 'tls', '证书');
    eq(K.classifyNotifyFailure(new Error('self-signed certificate')).category, 'tls', '自签');
    const other = K.classifyNotifyFailure(new Error('socket hang up'));
    eq(other.category, 'network', '未命中的网络错误');
    eq(other.message, 'socket hang up', '原文留着');
    eq(K.classifyNotifyFailure(new Error('')).category, 'unknown', '什么都没有');
});

// ---------------------------------------------------------------- 打码：列表页可以截图发群里

check('查询串里的 token/key/secret/sign/password 打码，其余参数留着方便核对', () => {
    eq(
        K.maskNotifyUrl('https://oapi.dingtalk.com/robot/send?access_token=SECRET&x=1'),
        'https://oapi.dingtalk.com/robot/send?access_token=***&x=1',
        'access_token',
    );
    eq(
        K.maskNotifyUrl('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=ABC'),
        'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=***',
        'key',
    );
    eq(K.maskNotifyUrl('https://host/hook?state=keep'), 'https://host/hook?state=keep', '非凭据参数');
    eq(K.maskNotifyUrl('https://host/hook'), 'https://host/hook', '没有查询串原样');
});

check('只有 webhook 类渠道走 HTTP；邮件是另一条路', () => {
    eq(K.notifyKindIsWebhook('generic'), true, '通用');
    eq(K.notifyKindIsWebhook('dingtalk'), true, '钉钉');
    eq(K.notifyKindIsWebhook('feishu'), true, '飞书');
    eq(K.notifyKindIsWebhook('wecom'), true, '企微');
    eq(K.notifyKindIsWebhook('slack'), true, 'Slack');
    eq(K.notifyKindIsWebhook('email'), false, '邮件不走 axios');
    eq(K.NOTIFY_KIND_LABEL.email, '邮件（SMTP）', '邮件有中文显示名');
});

check('路径里的凭据也打码：飞书 hook token 与 Slack 的 key 都不能原样到渲染层', () => {
    eq(
        K.maskNotifyUrl('https://open.feishu.cn/open-apis/bot/v2/hook/9f2c1a4e-7b3d-4c55-8e21-0a1b2c3d4e5f'),
        'https://open.feishu.cn/open-apis/bot/v2/hook/9f2***',
        '飞书 hook 段',
    );
    eq(
        K.maskNotifyUrl('https://hooks.slack.com/services/EXAMPLE/EXAMPLE/EXAMPLE'),
        'https://hooks.slack.com/services/EXAMPLE/EXAMPLE/EXAMPLE***',
        'Slack 最后一段',
    );
    // 普通路径不该被误伤：段太短、带扩展名（像个文件名）都原样留着
    eq(K.maskNotifyUrl('https://host/api/v2/send'), 'https://host/api/v2/send', '普通路径');
    eq(K.maskNotifyUrl('https://host/files/report.json'), 'https://host/files/report.json', '带扩展名的段');
    // 锚点后面是接口动词时不算凭据：企微真正要打码的 key 在查询串里
    eq(
        K.maskNotifyUrl('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=ABC'),
        'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=***',
        'webhook/send 是路由不是凭据',
    );
    // 路径与查询串同时存在时两边都要打
    eq(
        K.maskNotifyUrl('https://host/hook/abcdefghijklmnop?token=SECRET&x=1'),
        'https://host/hook/abc***?token=***&x=1',
        '段落与查询串都打码',
    );
});

check('只有钉钉与飞书有「签名密钥」这一格可填，邮件没有', () => {
    eq(K.notifyKindSupportsSecret('dingtalk'), true, '钉钉');
    eq(K.notifyKindSupportsSecret('feishu'), true, '飞书');
    eq(K.notifyKindSupportsSecret('wecom'), false, '企微');
    eq(K.notifyKindSupportsSecret('slack'), false, 'Slack');
    eq(K.notifyKindSupportsSecret('generic'), false, '通用');
    eq(K.notifyKindSupportsSecret('email'), false, '邮件的密码在服务器配置里');
});

// ---------------------------------------------------------------- 邮件：服务器、收件人与失败分类

check('SMTP 主机只收主机名：协议前缀、端口尾巴、用户名与无点主机都拒绝', () => {
    eq(M.validateMailHost('smtp.example.com'), null, '正常');
    eq(M.validateMailHost(' localhost '), null, '本机');
    contains(M.validateMailHost(''), '不能为空', '空');
    contains(M.validateMailHost(null), '不能为空', 'null');
    contains(M.validateMailHost('smtp://smtp.example.com'), '前缀', '带协议');
    contains(M.validateMailHost('smtp.example.com:465'), '端口', '带端口');
    contains(M.validateMailHost('user@smtp.example.com'), '用户名', '带用户名');
    contains(M.validateMailHost('smtp'), '不完整', '无点');
    contains(M.validateMailHost('a b.com'), '空格', '空格');
    eq(M.validateMailHost(`${'a'.repeat(249)}.com`), null, '253 字符');
    contains(M.validateMailHost(`${'a'.repeat(250)}.com`), '过长', '254 字符');
});

check('端口是 1～65535 的整数，越界是拒绝而不是夹住', () => {
    eq(M.validateMailPort(25), null, '25');
    eq(M.validateMailPort(587), null, '587');
    eq(M.validateMailPort(465), null, '465');
    eq(M.validateMailPort(65535), null, '上边界');
    contains(M.validateMailPort(0), '1～65535', '0');
    contains(M.validateMailPort(65536), '1～65535', '超上限');
    contains(M.validateMailPort(587.5), '整数', '小数');
    contains(M.validateMailPort('587'), '整数', '字符串');
    contains(M.validateMailPort(undefined), '整数', '缺省');
});

check('邮件地址挡住实际里最常见的配错：少 @、域名没点、双点、空格', () => {
    eq(M.validateMailAddress('ops@corp.com'), null, '正常');
    eq(M.validateMailAddress('ops+alerts@sub.corp.com'), null, '加号与子域');
    eq(M.validateMailAddress(' OPS@corp.com '), null, '前后空白会被裁掉');
    contains(M.validateMailAddress('ops.corp.com'), '@', '少 @');
    contains(M.validateMailAddress('ops@localhost'), '缺少点', '本机域收不到信');
    contains(M.validateMailAddress('ops@corp..com'), '域名', '连续的点');
    contains(M.validateMailAddress('ops@.corp.com'), '域名', '以点开头');
    contains(M.validateMailAddress('op s@corp.com'), '空格', '中间空格');
    contains(M.validateMailAddress('a@b@corp.com'), '不像', '两个 @');
    contains(M.validateMailAddress(`${'a'.repeat(60)}@${'b'.repeat(200)}.com`), '过长', '254 字符以上');
});

check('收件人清单：逗号/分号/空白/换行都认，按小写去重并保留第一次的写法', () => {
    const parsed = M.parseMailRecipients('A@corp.com, b@corp.com; c@corp.com\nA@CORP.COM');
    deepEq(parsed.to, ['A@corp.com', 'b@corp.com', 'c@corp.com'], '去重');
    deepEq(parsed.invalid, [], '没有坏地址');
    const mixed = M.parseMailRecipients('good@corp.com not-an-address');
    deepEq(mixed.to, ['good@corp.com'], '好的那个留下');
    deepEq(mixed.invalid, ['not-an-address'], '坏的那个单列');
    eq(M.parseMailRecipients('').to.length, 0, '空串');
    eq(M.parseMailRecipients(null).to.length, 0, 'null');
});

check('渠道的收件人这一格：空、坏地址、超过 20 个都给出具体那句话', () => {
    eq(M.mailRecipientsProblem('ops@corp.com'), null, '一个就够');
    contains(M.mailRecipientsProblem(''), '至少填一个', '空');
    const bad = M.mailRecipientsProblem('nope');
    contains(bad, '不像邮件地址', '坏地址');
    contains(bad, 'nope', '把坏的那几个说出来');
    const many = Array.from({length: M.MAIL_RECIPIENT_MAX + 1}, (_, index) => `u${index}@corp.com`).join(' ');
    contains(M.mailRecipientsProblem(many), `最多 ${M.MAIL_RECIPIENT_MAX} 个`, '上限');
});

check('邮件渠道的三格事实折成一句原因，与地址坏掉落在同一格', () => {
    eq(M.mailTargetProblem({profileProblem: null, recipients: ['a@corp.com']}), null, '能用');
    contains(M.mailTargetProblem({profileProblem: '这台邮件服务器已经不在了', recipients: []}), '已经不在了', '服务器问题优先');
    contains(M.mailTargetProblem({profileProblem: null, recipients: []}), '收件人是空的', '收件人为空');
});

check('邮件主题先写级别，空标题兜底，过长截到 200 字符', () => {
    eq(M.buildMailSubject(eventOf()), '[pulsar-manager·严重] 告警：积压超阈值', '严重');
    eq(M.buildMailSubject(eventOf({level: 'info'})), '[pulsar-manager·提示] 告警：积压超阈值', '提示');
    eq(M.buildMailSubject(eventOf({title: '  '})), '[pulsar-manager·严重] Pulsar 通知', '空标题兜底');
    const long = M.buildMailSubject(eventOf({title: '长'.repeat(500)}));
    eq(long.length, M.MAIL_SUBJECT_MAX_CHARS, '截到上限');
    eq(long.endsWith('…'), true, '带省略号');
});

check('邮件正文与群消息同一套排版，但字节预算更宽（16KB）', () => {
    eq(M.buildMailBody(eventOf()), K.renderNotifyText(eventOf(), M.MAIL_BODY_MAX_BYTES), '与渲染一致');
    const long = M.buildMailBody(eventOf({text: '积压'.repeat(20000)}));
    eq(Buffer.byteLength(long, 'utf8') <= M.MAIL_BODY_MAX_BYTES, true, '不超字节');
    eq(long.includes('\uFFFD'), false, '没有半截字符');
    // 群消息 4KB 就截了；同样 5KB 的正文在邮件里应该完整保留
    eq(M.buildMailBody(eventOf({text: 'x'.repeat(5000)})).includes('已截断'), false, '比群消息宽');
});

check('SMTP 失败按回话码分类，别只丢一句「发送失败」', () => {
    eq(M.classifyMailFailure({code: 'EAUTH', message: 'Invalid login'}).category, 'auth', 'EAUTH');
    eq(M.classifyMailFailure({message: '535 5.7.8 authentication failed'}).category, 'auth', '535');
    eq(M.classifyMailFailure({message: '550 5.7.1 Relay access denied'}).category, 'relay', '550 relay');
    eq(M.classifyMailFailure({message: '550 5.1.1 user unknown'}).category, 'recipient', '550 mailbox');
    eq(M.classifyMailFailure({message: 'self-signed certificate in chain'}).category, 'tls', '自签');
    eq(M.classifyMailFailure({message: 'getaddrinfo ENOTFOUND smtp.example.com'}).category, 'dns', 'DNS');
    eq(M.classifyMailFailure({code: 'ECONNREFUSED', message: 'connect ECONNREFUSED'}).category, 'refused', '拒绝连接');
    eq(M.classifyMailFailure({message: 'Connection timeout'}).category, 'timeout', '超时');
    eq(M.classifyMailFailure({message: 'wrong version number'}).category, 'config', '加密方式不对');
    eq(M.classifyMailFailure({message: '451 4.3.2 try again later'}).category, 'network', '临时错误');
    eq(M.classifyMailFailure({message: 'something odd'}).category, 'network', '未命中');
    eq(M.classifyMailFailure(null).category, 'unknown', '什么都没有');
    contains(M.classifyMailFailure({code: 'EAUTH'}).message, '授权码', '说清该改哪一格');
    contains(M.classifyMailFailure({message: 'self-signed certificate'}).message, '自签证书', '给出勾选项');
});

check('发件人显示串去掉名字里的尖括号与引号；用户名出界打码', () => {
    eq(M.formatMailFrom('ops@corp.com', '值班'), '值班 <ops@corp.com>', '名字 + 地址');
    eq(M.formatMailFrom('ops@corp.com', ''), 'ops@corp.com', '只要地址');
    eq(M.formatMailFrom('ops@corp.com', '<>'), 'ops@corp.com', '名字被清空就只剩地址');
    eq(M.formatMailFrom('ops@corp.com', '<evil> "x"'), 'evil x <ops@corp.com>', '不拼出假地址');
    eq(M.maskMailUser('alice@corp.com'), 'ali***@corp.com', '邮件用户名留域名');
    eq(M.maskMailUser('a@corp.com'), 'a***@corp.com', '短用户名');
    eq(M.maskMailUser('ab'), '***', '两个字以内');
    eq(M.maskMailUser('alice'), 'al***', '账号名不是邮件地址');
    eq(M.maskMailUser(''), '', '空');
});

check('三种加密方式与默认端口只有一个出处', () => {
    deepEq([...M.MAIL_SECURITY_KINDS], ['plain', 'starttls', 'tls'], '枚举');
    eq(M.MAIL_DEFAULT_PORT.plain, 25, '明文');
    eq(M.MAIL_DEFAULT_PORT.starttls, 587, 'STARTTLS');
    eq(M.MAIL_DEFAULT_PORT.tls, 465, '隐式 TLS');
    eq(M.isKnownMailSecurity('starttls'), true, '认识');
    eq(M.isKnownMailSecurity('ssl'), false, '不认识');
    eq(M.MAIL_SECURITY_LABEL.tls, 'SSL/TLS（隐式）', '界面文案');
});

// ---------------------------------------------------------------- payload 形状与签名

function bodyTextOf(kind, body) {
    if (kind === 'wecom' || kind === 'dingtalk') {
        return kind === 'wecom' ? body.markdown.content : body.markdown.text;
    }
    if (kind === 'feishu') {
        return body.content.text;
    }
    return body.text;
}

check('通用 JSON 留全字段，标题为空时落回默认标题', () => {
    const request = P.buildNotifyRequest({
        kind: 'generic',
        url: 'https://host/hook',
        secret: null,
        event: eventOf(),
        nowMs: NOW,
    });
    eq(request.url, 'https://host/hook', '地址不动');
    eq(request.headers['content-type'], 'application/json', '内容类型');
    eq(request.body.source, 'pulsar-manager', '来源标识');
    eq(request.body.kind, 'alertFired', '事件');
    eq(request.body.level, 'crit', '级别');
    eq(request.body.clusterId, 'c1', '集群 id');
    eq(request.body.clusterName, 'prod-a', '集群名');
    eq(request.body.at, new Date(NOW).toISOString(), '时间是 ISO');
    eq(request.body.text, K.renderNotifyText(eventOf()), 'text 与渲染一致');
    const blankTitle = P.buildNotifyRequest({
        kind: 'generic',
        url: 'https://h',
        secret: null,
        event: eventOf({title: '  '}),
        nowMs: NOW,
    });
    eq(blankTitle.body.title, 'Pulsar 通知', '空标题兜底');
});

check('Slack 只要 text，企微的 markdown 用的是 content 而不是 text', () => {
    const slack = P.buildNotifyRequest({
        kind: 'slack',
        url: 'https://hooks.slack.com/services/EXAMPLE/EXAMPLE/EXAMPLE',
        secret: null,
        event: eventOf(),
        nowMs: NOW,
    });
    deepEq(Object.keys(slack.body), ['text'], 'Slack 只有这一个键');
    const wecom = P.buildNotifyRequest({
        kind: 'wecom',
        url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc',
        secret: null,
        event: eventOf(),
        nowMs: NOW,
    });
    eq(wecom.body.msgtype, 'markdown', '企微 msgtype');
    eq(wecom.body.markdown.content, K.renderNotifyText(eventOf()), '企微正文在 markdown.content');
    eq(wecom.body.markdown.title, undefined, '企微的 markdown 没有标题字段');
});

check('钉钉加签把 timestamp 与 sign 拼在地址上，而不是塞进 body', () => {
    const secret = 'SECabc123';
    const request = P.buildNotifyRequest({
        kind: 'dingtalk',
        url: 'https://oapi.dingtalk.com/robot/send?access_token=***',
        secret,
        event: eventOf(),
        nowMs: NOW,
    });
    contains(request.url, 'access_token=***', '原查询串保留');
    contains(request.url, `timestamp=${NOW}`, '时间戳');
    // 独立实现比对：签名串是 `${ts}\n${secret}`，结果 base64 再 urlencode
    const rawSign = crypto.createHmac('sha256', secret).update(`${NOW}\n${secret}`).digest('base64');
    const query = new URL(request.url).searchParams;
    eq(query.get('sign'), rawSign, 'sign 解出来与独立实现一致');
    contains(request.url, encodeURIComponent(rawSign), '地址上放的是 urlencode 过的那一份');
    eq(request.body.msgtype, 'markdown', 'msgtype');
    eq(request.body.markdown.title, '告警：积压超阈值', '钉钉的标题单独给');
    eq(request.body.timestamp, undefined, '签名不进 body');
    eq(request.body.sign, undefined, '签名不进 body');
});

check('钉钉没配密钥就不签名：地址原样、body 里没有 sign', () => {
    const request = P.buildNotifyRequest({
        kind: 'dingtalk',
        url: 'https://oapi.dingtalk.com/robot/send?access_token=***',
        secret: null,
        event: eventOf(),
        nowMs: NOW,
    });
    eq(request.url, 'https://oapi.dingtalk.com/robot/send?access_token=***', '地址未被改写');
    eq(request.body.sign, undefined, '无 sign');
});

check('飞书把 timestamp（秒）与 sign 放进 body，签名用空串作消息', () => {
    const secret = 'feishu-secret';
    const request = P.buildNotifyRequest({
        kind: 'feishu',
        url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x',
        secret,
        event: eventOf(),
        nowMs: NOW,
    });
    const body = request.body;
    eq(body.msg_type, 'text', 'msg_type');
    eq(body.content.text, K.renderNotifyText(eventOf()), '正文位置');
    eq(body.timestamp, String(Math.floor(NOW / 1000)), '秒级时间戳且是字符串');
    // 独立实现：HMAC 的 key 是 `${ts}\n${secret}`，被签的是空串
    const expected = crypto.createHmac('sha256', `${body.timestamp}\n${secret}`).update('').digest('base64');
    eq(body.sign, expected, 'sign 与按 body 里那格时间戳独立算出来的一致');
});

check('飞书没配密钥时不带 timestamp/sign；五家渠道的正文都不超过 4096 字节', () => {
    const plain = P.buildNotifyRequest({kind: 'feishu', url: 'https://h', secret: null, event: eventOf(), nowMs: NOW}).body;
    eq(plain.timestamp, undefined, '无 timestamp');
    eq(plain.sign, undefined, '无 sign');
    const long = eventOf({text: '积压'.repeat(6000)});
    for (const kind of ['generic', 'wecom', 'slack', 'dingtalk', 'feishu']) {
        const request = P.buildNotifyRequest({kind, url: 'https://h', secret: null, event: long, nowMs: NOW});
        const text = bodyTextOf(kind, request.body);
        eq(Buffer.byteLength(text, 'utf8') <= K.NOTIFY_TEXT_MAX_BYTES, true, `${kind} 正文字节数`);
    }
});

// ---------------------------------------------------------------- 落库：两张表的形状与那几条语句

const CHANNEL_COLUMNS =
    'id, name, kind, url_enc, secret_enc, mail_profile_id, recipients, enabled, events_json, min_level, ' +
    'timeout_ms, rate_per_minute, last_sent_at, last_error, fail_count, created_at, updated_at';

function channelRow(overrides) {
    return {
        id: 'ch-1',
        name: '值班群',
        kind: 'dingtalk',
        url_enc: 'gAAAAQ-cipher',
        secret_enc: null,
        mail_profile_id: null,
        recipients: '',
        enabled: 1,
        events_json: JSON.stringify(['alertFired']),
        min_level: 'warn',
        timeout_ms: 5000,
        rate_per_minute: 20,
        last_sent_at: null,
        last_error: null,
        fail_count: 0,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
        ...overrides,
    };
}

const MAIL_PROFILE_COLUMNS =
    'id, name, host, port, security, username, password_enc, from_address, from_name, ' +
    'allow_self_signed, created_at, updated_at';

function mailProfileRow(overrides) {
    return {
        id: 'mp-1',
        name: '公司 SMTP',
        host: 'smtp.corp.com',
        port: 587,
        security: 'starttls',
        username: 'alerts@corp.com',
        password_enc: 'gAAAAQ-mail',
        from_address: 'alerts@corp.com',
        from_name: 'Pulsar',
        allow_self_signed: 0,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
        ...overrides,
    };
}

function deliveryRow(overrides) {
    return {
        channel_id: 'ch-1',
        channel_name: '值班群',
        event_kind: 'alertFired',
        level: 'crit',
        ok: 1,
        skipped: 0,
        message: '已送达（HTTP 200）',
        created_at: '2026-10-02T00:00:00.000Z',
        ...overrides,
    };
}

function openDatabase() {
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(SCHEMA_SQL);
    return database;
}

function insertChannel(database, row) {
    database
        .prepare(
            `INSERT INTO notify_channels (${CHANNEL_COLUMNS})
             VALUES (@id, @name, @kind, @url_enc, @secret_enc, @mail_profile_id, @recipients,
                     @enabled, @events_json, @min_level, @timeout_ms, @rate_per_minute,
                     @last_sent_at, @last_error, @fail_count, @created_at, @updated_at)`,
        )
        .run(row);
}

function insertMailProfile(database, row) {
    database
        .prepare(
            `INSERT INTO notify_mail_profiles (${MAIL_PROFILE_COLUMNS})
             VALUES (@id, @name, @host, @port, @security, @username, @password_enc, @from_address,
                     @from_name, @allow_self_signed, @created_at, @updated_at)`,
        )
        .run(row);
}

function insertDelivery(database, row) {
    const result = database
        .prepare(
            `INSERT INTO notify_deliveries
             (channel_id, channel_name, event_kind, level, ok, skipped, message, created_at)
             VALUES (@channel_id, @channel_name, @event_kind, @level, @ok, @skipped, @message, @created_at)`,
        )
        .run(row);
    return Number(result.lastInsertRowid);
}

check('基线建出两张表，默认值就是服务层假设的那几个', () => {
    const database = openDatabase();
    const one = database
        .prepare(
            `INSERT INTO notify_channels (id, name, kind, url_enc, events_json, created_at, updated_at)
             VALUES ('a', 'n', 'generic', 'x', '[]', '2026-10-01', '2026-10-01')`,
        )
        .run();
    eq(Number(one.changes), 1, '只填必填列就能落库');
    const row = database.prepare('SELECT * FROM notify_channels WHERE id = ?').get('a');
    eq(row.enabled, 1, '默认开着');
    eq(row.min_level, 'warn', '默认级别线');
    eq(row.timeout_ms, 5000, '默认超时');
    eq(row.rate_per_minute, 20, '默认条数');
    eq(row.fail_count, 0, '默认连败 0');
    eq(row.secret_enc, null, '默认没有密钥');
    eq(row.mail_profile_id, null, '默认不指向任何邮件服务器');
    eq(row.recipients, '', '默认没有收件人');
    eq(row.last_error, null, '默认没有失败原因');
    database.close();
});

check('邮件服务器表：默认 STARTTLS、不收自签证书，名字唯一', () => {
    const database = openDatabase();
    // 只填必填列，其余吃默认值
    database
        .prepare(
            `INSERT INTO notify_mail_profiles (id, name, host, port, from_address, created_at, updated_at)
             VALUES ('mp-min', '内网 SMTP', 'mail.corp.com', 25, 'a@corp.com', '2026-10-01', '2026-10-01')`,
        )
        .run();
    const row = database.prepare('SELECT * FROM notify_mail_profiles WHERE id = ?').get('mp-min');
    eq(row.security, 'starttls', '默认加密方式');
    eq(row.username, '', '默认无用户名');
    eq(row.password_enc, null, '默认无密码');
    eq(row.from_name, '', '默认无显示名');
    eq(row.allow_self_signed, 0, '默认校验证书');
    insertMailProfile(database, mailProfileRow());
    let duplicate = null;
    try {
        insertMailProfile(database, mailProfileRow({id: 'mp-2'}));
    } catch (error) {
        duplicate = error;
    }
    assert.ok(duplicate, '同名服务器应当被 UNIQUE 挡住');
    database.close();
});

check('投递记录的 skipped 默认 0，id 自增可直接当行 key', () => {
    const database = openDatabase();
    insertChannel(database, channelRow());
    const first = insertDelivery(database, deliveryRow());
    const second = insertDelivery(database, deliveryRow({message: '第二条'}));
    eq(second > first, true, '自增');
    eq(database.prepare('SELECT skipped FROM notify_deliveries WHERE id = ?').get(first).skipped, 0, '默认不算跳过');
    database.close();
});

check('整行覆盖不碰 created_at，也不碰那四格运行结果', () => {
    const database = openDatabase();
    insertChannel(database, channelRow({last_sent_at: '2026-10-05T00:00:00.000Z', last_error: '旧错误', fail_count: 3}));
    database
        .prepare(
            `UPDATE notify_channels
             SET name = @name, kind = @kind, url_enc = @url_enc, secret_enc = @secret_enc,
                 mail_profile_id = @mail_profile_id, recipients = @recipients,
                 enabled = @enabled, events_json = @events_json, min_level = @min_level,
                 timeout_ms = @timeout_ms, rate_per_minute = @rate_per_minute, updated_at = @updated_at
             WHERE id = @id`,
        )
        .run(
            // 只带上 SET 里出现的那几格：node:sqlite 对未知的具名参数直接报错
            // （better-sqlite3 会忽略，所以这一份抄本不能整行丢进去）
            {
                id: 'ch-1',
                name: '改名了',
                kind: 'email',
                url_enc: '',
                secret_enc: 'cipher-secret',
                mail_profile_id: 'mp-1',
                recipients: 'ops@corp.com',
                enabled: 1,
                events_json: JSON.stringify(['alertFired']),
                min_level: 'warn',
                timeout_ms: 5000,
                rate_per_minute: 20,
                updated_at: '2026-10-09T00:00:00.000Z',
            },
        );
    const row = database.prepare('SELECT * FROM notify_channels WHERE id = ?').get('ch-1');
    eq(row.name, '改名了', '名字改了');
    eq(row.kind, 'email', '类型改了');
    eq(row.mail_profile_id, 'mp-1', '服务器指向改了');
    eq(row.recipients, 'ops@corp.com', '收件人改了');
    eq(row.secret_enc, 'cipher-secret', '密钥补上了');
    eq(row.created_at, '2026-10-01T00:00:00.000Z', '创建时间没动');
    eq(row.last_sent_at, '2026-10-05T00:00:00.000Z', '最近成功时间没动');
    eq(row.last_error, '旧错误', '失败原因没被配置保存清掉');
    eq(row.fail_count, 3, '连败计数没被配置保存清掉');
    database.close();
});

check('成功清连败并盖时间，失败累加并留原因（原因截到 500）', () => {
    const database = openDatabase();
    insertChannel(database, channelRow());
    const fail = message => {
        database
            .prepare(
                `UPDATE notify_channels
                 SET last_error = ?, fail_count = fail_count + 1, updated_at = ?
                 WHERE id = ?`,
            )
            .run(message.slice(0, 500), '2026-10-06T00:00:00.000Z', 'ch-1');
    };
    fail('对端返回 500');
    fail('对端返回 502');
    let row = database.prepare('SELECT * FROM notify_channels WHERE id = ?').get('ch-1');
    eq(row.fail_count, 2, '连败两次');
    eq(row.last_error, '对端返回 502', '留最后一次的原因');
    eq(row.last_sent_at, null, '失败不动成功时间');
    fail(`超长的原因-${'x'.repeat(600)}`);
    eq(database.prepare('SELECT length(last_error) AS n FROM notify_channels WHERE id = ?').get('ch-1').n, 500, '原因入库前截断');
    database
        .prepare(
            `UPDATE notify_channels
             SET last_sent_at = ?, last_error = NULL, fail_count = 0, updated_at = ?
             WHERE id = ?`,
        )
        .run('2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z', 'ch-1');
    row = database.prepare('SELECT * FROM notify_channels WHERE id = ?').get('ch-1');
    eq(row.fail_count, 0, '成功清零');
    eq(row.last_error, null, '成功清空原因');
    eq(row.last_sent_at, '2026-10-07T00:00:00.000Z', '成功盖时间');
    database.close();
});

check('开关只改 enabled 与 updated_at，不给清空地址的机会', () => {
    const database = openDatabase();
    insertChannel(database, channelRow({secret_enc: 'cipher-secret'}));
    database.prepare('UPDATE notify_channels SET enabled = ?, updated_at = ? WHERE id = ?').run(0, '2026-10-08T00:00:00.000Z', 'ch-1');
    const row = database.prepare('SELECT * FROM notify_channels WHERE id = ?').get('ch-1');
    eq(row.enabled, 0, '关了');
    eq(row.url_enc, 'gAAAAQ-cipher', '密文地址还在');
    eq(row.secret_enc, 'cipher-secret', '密文密钥还在');
    eq(row.updated_at, '2026-10-08T00:00:00.000Z', '更新时间改了');
    database.close();
});

check('列表按 id 倒序取最近 N 条，渠道那段读最新一条', () => {
    const database = openDatabase();
    insertChannel(database, channelRow());
    insertChannel(database, channelRow({id: 'ch-2', name: '另一个群'}));
    insertDelivery(database, deliveryRow({created_at: '2026-10-01T00:00:00.000Z'}));
    const newest = insertDelivery(database, deliveryRow({channel_id: 'ch-2', message: '最新一条'}));
    const rows = database
        .prepare(
            `SELECT id, channel_id, message FROM notify_deliveries
             ORDER BY id DESC
             LIMIT ?`,
        )
        .all(1);
    eq(rows.length, 1, 'limit 生效');
    eq(rows[0].id, newest, '最新那条在前');
    const one = database
        .prepare(
            `SELECT id, message FROM notify_deliveries
             WHERE channel_id = ?
             ORDER BY id DESC
             LIMIT 1`,
        )
        .get('ch-2');
    eq(one.message, '最新一条', '按渠道读最近一次');
    database.close();
});

check('按 id 倒序而不是按 created_at：时钟被往回调时派发顺序不乱', () => {
    const database = openDatabase();
    insertChannel(database, channelRow());
    insertDelivery(database, deliveryRow({created_at: '2026-10-09T00:00:00.000Z', message: '先派发的'}));
    insertDelivery(database, deliveryRow({created_at: '2026-10-01T00:00:00.000Z', message: '后派发但时间戳更早'}));
    const rows = database.prepare('SELECT message FROM notify_deliveries ORDER BY id DESC').all();
    eq(rows[0].message, '后派发但时间戳更早', '最新一次派发仍在最前');
    const byTime = database.prepare('SELECT message FROM notify_deliveries ORDER BY created_at DESC').all();
    eq(byTime[0].message, '先派发的', '按时间排会把旧一次当成最新');
    database.close();
});

check('裁剪只留最近 keep 条，且留的是 id 最大的那几条', () => {
    const database = openDatabase();
    insertChannel(database, channelRow());
    for (let index = 0; index < 10; index += 1) {
        insertDelivery(database, deliveryRow({message: `第 ${index} 条`}));
    }
    const removed = database
        .prepare(
            `DELETE FROM notify_deliveries
             WHERE id NOT IN (SELECT id FROM notify_deliveries ORDER BY id DESC LIMIT ?)`,
        )
        .run(4);
    eq(Number(removed.changes), 6, '删掉 6 条');
    const rows = database.prepare('SELECT message FROM notify_deliveries ORDER BY id DESC').all();
    eq(rows.length, 4, '剩 4 条');
    eq(rows[rows.length - 1].message, '第 6 条', '留下的是最近的四条');
    database.close();
});

check('删渠道会连带删掉它的投递记录（外键 CASCADE）', () => {
    const database = openDatabase();
    insertChannel(database, channelRow());
    insertChannel(database, channelRow({id: 'ch-2', name: '另一个群'}));
    insertDelivery(database, deliveryRow());
    insertDelivery(database, deliveryRow({channel_id: 'ch-2', message: '另一个渠道的'}));
    const deleted = database.prepare('DELETE FROM notify_channels WHERE id = ?').run('ch-1');
    eq(Number(deleted.changes), 1, '删掉一条渠道');
    const rows = database.prepare('SELECT channel_id, message FROM notify_deliveries').all();
    eq(rows.length, 1, '只留另一个渠道的');
    eq(rows[0].channel_id, 'ch-2', '归属正确');
    database.close();
});

check('CASCADE 靠 foreign_keys 开关：显式关掉就留孤行，所以主进程那句 pragma 不能少', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'database', 'sqlite.ts'), 'utf8');
    assert.ok(/foreign_keys\s*=\s*ON/i.test(source), 'sqlite.ts 里没有把 foreign_keys 打开的语句');
    const off = new DatabaseSync(':memory:');
    off.exec('PRAGMA foreign_keys = OFF');
    off.exec(SCHEMA_SQL);
    insertChannel(off, channelRow());
    insertDelivery(off, deliveryRow());
    off.prepare('DELETE FROM notify_channels WHERE id = ?').run('ch-1');
    eq(off.prepare('SELECT COUNT(*) AS n FROM notify_deliveries').get().n, 1, '开关关掉时投递记录留下孤行');
    off.close();
});

check('删邮件服务器不连带删渠道：mail_profile_id 刻意没有外键', () => {
    const database = openDatabase();
    insertMailProfile(database, mailProfileRow());
    insertChannel(database, channelRow({kind: 'email', url_enc: '', mail_profile_id: 'mp-1', recipients: 'ops@corp.com'}));
    database.prepare('DELETE FROM notify_mail_profiles WHERE id = ?').run('mp-1');
    const row = database.prepare('SELECT * FROM notify_channels WHERE id = ?').get('ch-1');
    assert.ok(row, '渠道还在');
    eq(row.mail_profile_id, 'mp-1', '渠道仍指着那个已经不在了的服务器');
    eq(row.recipients, 'ops@corp.com', '收件人没被动');
    database.close();
});

check('v15 迁移：老库靠 PRAGMA 守卫补两列，新库基线已带时不会再 ALTER', () => {
    // 模拟 v14 老库：从基线里抹掉这两列，基线重跑补不出来（CREATE TABLE IF NOT EXISTS）
    const oldSchema = SCHEMA_SQL.replace(/^\s*mail_profile_id TEXT,\s*$/m, '').replace(
        /^\s*recipients TEXT NOT NULL DEFAULT '',\s*$/m,
        '',
    );
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(oldSchema);
    let missing = null;
    try {
        database.prepare('SELECT mail_profile_id, recipients FROM notify_channels LIMIT 1').all();
    } catch (error) {
        missing = error;
    }
    assert.ok(missing, '抹掉两列之后查询应当 no such column');
    const addMissing = () => {
        const columns = database.prepare('PRAGMA table_info(notify_channels)').all().map(column => column.name);
        if (!columns.includes('mail_profile_id')) {
            database.prepare('ALTER TABLE notify_channels ADD COLUMN mail_profile_id TEXT').run();
        }
        if (!columns.includes('recipients')) {
            database.prepare("ALTER TABLE notify_channels ADD COLUMN recipients TEXT NOT NULL DEFAULT ''").run();
        }
    };
    addMissing();
    eq(
        database
            .prepare('PRAGMA table_info(notify_channels)')
            .all()
            .filter(column => column.name === 'mail_profile_id' || column.name === 'recipients').length,
        2,
        '两列都补上了',
    );
    // 第二次跑（等价于新库上基线已带这两列）不能 duplicate column
    addMissing();
    database.close();

    // 真正会执行的那段迁移必须带同样的守卫，不能裸 ALTER
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'database', 'sqlite.ts'), 'utf8');
    const block = source.slice(source.indexOf('if (from < 15)'), source.indexOf('// 每次启动都执行基线'));
    contains(block, 'PRAGMA table_info(notify_channels)', '先查表结构');
    contains(block, 'ADD COLUMN mail_profile_id', '补服务器列');
    contains(block, 'ADD COLUMN recipients', '补收件人列');
});

check('基线 DDL 每次启动都重跑：再跑一遍不报错也不重复建表', () => {
    const database = openDatabase();
    insertChannel(database, channelRow());
    database.exec(SCHEMA_SQL);
    eq(database.prepare('SELECT COUNT(*) AS n FROM notify_channels').get().n, 1, '已有行没被清掉');
    const names = database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'notify_%'")
        .all()
        .map(row => row.name)
        .sort();
    deepEq(names, ['notify_channels', 'notify_deliveries', 'notify_mail_profiles'], '三张表');
    database.close();
});

check('投递记录留的是写入时的渠道名，改名不追溯历史', () => {
    const database = openDatabase();
    insertChannel(database, channelRow());
    insertDelivery(database, deliveryRow({channel_name: '旧名字'}));
    database.prepare('UPDATE notify_channels SET name = ? WHERE id = ?').run('新名字', 'ch-1');
    eq(database.prepare('SELECT channel_name FROM notify_deliveries').get().channel_name, '旧名字', '记录里是当时的名字');
    database.close();
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) {
    console.log(`FAIL ${failure}`);
}
console.log(failures.length ? 'SELFTEST FAILED' : 'ALL PASS');
process.exitCode = failures.length ? 1 : 0;
