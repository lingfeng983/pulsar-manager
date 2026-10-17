/**
 * 集群巡检自测：不连 broker，用假 client 把判定规则的边界跑一遍。
 * 这些断言存在的意义是「阈值改动会立刻在这里暴露」，而不是重复实现一遍服务。
 */
const assert = require('node:assert');
const S = require('../dist/src/main/services/cluster-inspection.js');
const D = require('../dist/src/main/services/inspection-diff.js');
const P = require('../dist/src/main/services/inspection-profile.js');
const C = require('../dist/src/shared/inspection-caliber.js');

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

async function checkAsync(name, fn) {
    try {
        await fn();
        passed += 1;
    } catch (error) {
        failures.push(`${name}：${error && error.message ? error.message : String(error)}`);
    }
}

function eq(actual, expected, label) {
    assert.strictEqual(actual, expected, `${label || ''} 期望 ${expected}，实际 ${actual}`);
}

function row(overrides) {
    return {
        name: 'public/default/t',
        persistent: true,
        msgRateIn: 0,
        msgRateOut: 0,
        backlog: 0,
        backlogSize: 0,
        producerCount: 0,
        subscriptionCount: 0,
        consumerCount: 0,
        maxSubBacklog: 0,
        maxSubBacklogName: '',
        maxUnacked: 0,
        maxUnackedName: '',
        blockedSubscriptions: [],
        ...overrides,
    };
}

const T = C.INSPECTION_THRESHOLDS;

// ---------------------------------------------------------------- 采样行的折叠口径

check('订阅积压自己加总（顶层 backlogSize 是字节不是条数）', () => {
    const r = S.toInspectionTopicRow('public/default/a', true, {
        msgRateIn: 1.5,
        msgRateOut: 0.5,
        backlogSize: 999999,
        producers: [{producerId: 'p1'}, {producerId: 'p2'}],
        subscriptions: {
            s1: {name: 's1', msgBacklog: 30, unackedMessages: 5, consumerCount: 2},
            s2: {name: 's2', msgBacklog: 70, unackedMessages: 1, consumerCount: 1},
        },
    });
    eq(r.backlog, 100, '积压条数');
    eq(r.backlogSize, 999999, '字节数原样保留');
    eq(r.producerCount, 2, '生产者数');
    eq(r.subscriptionCount, 2, '订阅数');
    eq(r.consumerCount, 3, '消费者数');
    eq(r.maxSubBacklogName, 's2', '最大积压订阅');
    eq(r.maxSubBacklog, 70, '最大积压值');
    eq(r.maxUnackedName, 's1', '最大未 ack 订阅');
    eq(r.msgRateIn, 1.5, '入向速率');
});

check('字段缺失的老 broker 不会算出 NaN', () => {
    const r = S.toInspectionTopicRow('public/default/a', false, {
        subscriptions: {s1: {name: 's1'}, s2: {name: 's2', msgBacklog: null}},
    });
    eq(r.backlog, 0, '缺 msgBacklog');
    eq(r.consumerCount, 0, '缺 consumerCount');
    eq(r.maxUnacked, 0, '缺 unackedMessages');
    eq(r.persistent, false, '非持久化标记');
});

check('stats 整个为空也不炸', () => {
    const r = S.toInspectionTopicRow('public/default/a', true, undefined);
    eq(r.subscriptionCount, 0, '订阅数');
    eq(r.blockedSubscriptions.length, 0, '阻塞列表');
});

check('只有 broker 明确 true 才算阻塞订阅', () => {
    const r = S.toInspectionTopicRow('public/default/a', true, {
        subscriptions: {
            s1: {name: 's1', blockedSubscriptionOnUnackedMsgs: true},
            s2: {name: 's2', blockedSubscriptionOnUnackedMsgs: false},
            s3: {name: 's3'},
            s4: {name: 's4', blockedSubscriptionOnUnackedMsgs: null},
        },
    });
    eq(r.blockedSubscriptions.length, 1, '阻塞数量');
    eq(r.blockedSubscriptions[0], 's1', '阻塞的订阅名');
});

// ---------------------------------------------------------------- broker 侧判定

check('健康检查失败是 crit 并带处置建议', () => {
    eq(S.buildConnectivityCheck(true).level, 'ok', '通过时');
    const bad = S.buildConnectivityCheck(false);
    eq(bad.level, 'crit', '失败时');
    assert.ok(bad.suggestion, '要有建议');
});

check('active 为 0 时区分「一个都没登记」与「全部掉线」', () => {
    const none = S.buildBrokerCheck({activeBrokers: [], allBrokers: []});
    eq(none.level, 'crit', '空集群');
    eq(none.detail, undefined, '没有登记数就不写 detail');
    const offline = S.buildBrokerCheck({activeBrokers: [], allBrokers: ['b1', 'b2']});
    eq(offline.detail[0], '已登记 2 个，全部不在列表', '掉线说明');
});

check('active 少于 all 判 crit，相等判 ok', () => {
    eq(S.buildBrokerCheck({activeBrokers: ['b1'], allBrokers: ['b1', 'b2']}).level, 'crit', '有 broker 掉线');
    eq(S.buildBrokerCheck({activeBrokers: ['b1', 'b2'], allBrokers: ['b1', 'b2']}).level, 'ok', '全活跃');
});

// ---------------------------------------------------------------- topic 侧判定

check('没有采样到 topic 时四项都判 skip 而不是 ok', () => {
    eq(S.buildConsumerCheck([]).level, 'skip', '消费端');
    eq(S.buildBacklogCheck([]).level, 'skip', '积压');
    eq(S.buildUnackedCheck([]).level, 'skip', '未 ack');
    eq(S.buildThroughputCheck([]).level, 'skip', '速率');
    eq(S.buildBacklogCheck([]).summary, '没有采样到 topic，无法判断积压', 'skip 文案');
});

check('有积压但零消费者才报 crit', () => {
    const ok = S.buildConsumerCheck([row({name: 'a', backlog: 500, consumerCount: 1})]);
    eq(ok.level, 'ok', '有人在消费');
    const bad = S.buildConsumerCheck([
        row({name: 'big', backlog: 2000, consumerCount: 0, subscriptionCount: 2}),
        row({name: 'small', backlog: 10, consumerCount: 0}),
        row({name: 'fine', backlog: 9000, consumerCount: 3}),
    ]);
    eq(bad.level, 'crit', '无人消费');
    assert.ok(bad.summary.includes('2 个 topic'), '数量写进结论');
    assert.ok(bad.summary.includes('共 2010 条'), '总量写进结论');
    eq(bad.detail[0].startsWith('big：'), true, '按积压降序');
});

check('积压分级按单 topic 最大值而不是总量', () => {
    const manySmall = Array.from({length: 200}, (_, i) => row({name: `t${i}`, backlog: 9000}));
    eq(S.buildBacklogCheck(manySmall).level, 'ok', '总量上百万但单条都不过阈值');
    eq(S.buildBacklogCheck([row({backlog: T.backlogWarn - 1})]).level, 'ok', '阈值之下');
    eq(S.buildBacklogCheck([row({backlog: T.backlogWarn})]).level, 'warn', '正好等于 warn 阈值');
    eq(S.buildBacklogCheck([row({backlog: T.backlogCrit})]).level, 'crit', '正好等于 crit 阈值');
});

check('积压明细点出积压集中在哪个订阅', () => {
    const c = S.buildBacklogCheck([
        row({name: 't1', backlog: 20, maxSubBacklogName: 'slow', maxSubBacklog: 20}),
        row({name: 't2', backlog: 10}),
    ]);
    eq(c.detail[0], 't1：20 条（最大订阅 slow 20）', '带订阅名');
    eq(c.detail[1], 't2：10 条', '没有订阅名就不带括号');
});

check('积压明细只留前 N 条', () => {
    const rows = Array.from({length: 30}, (_, i) => row({name: `t${i}`, backlog: 100000 - i}));
    eq(S.buildBacklogCheck(rows).detail.length, T.detailTopN, 'detail 条数');
});

check('阻塞订阅优先于未 ack 数量', () => {
    const blocked = S.buildUnackedCheck([row({name: 't1', blockedSubscriptions: ['s1', 's2'], maxUnacked: 1})]);
    eq(blocked.level, 'crit', '有阻塞');
    eq(blocked.detail[0], 't1：s1、s2', '阻塞订阅名列出');
    assert.ok(blocked.suggestion.includes('maxUnackedMessagesPerConsumer'), '建议点到可调的闸门');
    eq(S.buildUnackedCheck([row({maxUnacked: T.unackedWarn})]).level, 'warn', '未 ack 合计达阈值');
    eq(S.buildUnackedCheck([row({maxUnacked: T.unackedWarn - 1})]).level, 'ok', '未 ack 合计未达阈值');
});

check('速率判定有绝对量下限，避免低频 topic 被除出来', () => {
    const quiet = S.buildThroughputCheck([row({name: 'q', msgRateIn: 0.01, msgRateOut: 0})]);
    eq(quiet.level, 'ok', '入向不足 rateMinIn');
    eq(S.buildThroughputCheck([row({msgRateIn: T.rateMinIn - 1, msgRateOut: 0})]).level, 'ok', '下限之下');
    eq(S.buildThroughputCheck([row({msgRateIn: T.rateMinIn, msgRateOut: T.rateMinIn / T.rateRatio})]).level, 'warn', '正好到比例');
    eq(S.buildThroughputCheck([row({msgRateIn: 30, msgRateOut: 11})]).level, 'ok', '比例未达');
    const w = S.buildThroughputCheck([row({name: 'x', msgRateIn: 100, msgRateOut: 2})]);
    assert.ok(w.detail[0].includes('入 100.0/s'), '明细带一位小数');
});

// ---------------------------------------------------------------- worker 与告警

check('worker 读不到与未启用都判 skip（不是 crit）', () => {
    eq(S.buildWorkerCheck(null).level, 'skip', '未采集');
    eq(S.buildWorkerCheck(null).summary, 'worker 状态未采集', '未采集不带错误');
    const err = S.buildWorkerCheck(null, '连接被拒');
    eq(err.level, 'skip', '报错');
    eq(err.detail[0], '连接被拒', '错误进 detail');
    const off = S.buildWorkerCheck({enabled: false, nodes: [], notice: 'worker 未开启'});
    eq(off.level, 'skip', '未启用');
    eq(off.detail[0], 'worker 未开启', '带上 broker 的原文提示');
});

check('worker 启用但零节点是 crit', () => {
    eq(S.buildWorkerCheck({enabled: true, nodes: []}).level, 'crit', '零节点');
    assert.ok(S.buildWorkerCheck({enabled: true, nodes: []}).suggestion, '零节点要给建议');
    eq(S.buildWorkerCheck({enabled: true, nodes: [{},{},{}]}).level, 'ok', '三节点');
});

check('未恢复告警只判 warn 不进 crit', () => {
    eq(S.buildAlertCheck([]).level, 'ok', '没有事件');
    const c = S.buildAlertCheck([
        {ruleName: '积压高', scopeLabel: 'public/default/x', message: 'backlog 12000'},
    ]);
    eq(c.level, 'warn', '一条事件');
    eq(c.detail[0], '积压高｜public/default/x｜backlog 12000', '明细拼法');
});

check('totals 覆盖四个级别', () => {
    const totals = S.sumTotals([
        S.buildConnectivityCheck(true),
        S.buildConnectivityCheck(false),
        S.buildBacklogCheck([]),
        S.buildAlertCheck([]),
    ]);
    eq(totals.ok, 2, 'ok');
    eq(totals.crit, 1, 'crit');
    eq(totals.skip, 1, 'skip');
    eq(totals.warn, 0, 'warn');
});

// ---------------------------------------------------------------- 编排

function fakeClient(overrides) {
    return {
        healthCheck: async () => true,
        getVersion: async () => '3.0.4',
        getBrokers: async () => ({activeBrokers: ['b1'], allBrokers: ['b1']}),
        getTenants: async () => [{name: 'public'}],
        getNamespaces: async () => ['public/default'],
        getTopics: async () => [
            {name: 'public/default/t1', persistent: true},
            {name: 'public/default/t2', persistent: true},
        ],
        getTopicStats: async (tenant, ns, topic) => ({
            msgRateIn: topic.endsWith('t1') ? 50 : 1,
            msgRateOut: 1,
            backlogSize: 10,
            producers: [{producerId: 'p'}],
            subscriptions: {s: {name: 's', msgBacklog: topic.endsWith('t1') ? 400 : 5, consumerCount: 1}},
        }),
        getWorkerState: async () => ({enabled: true, nodes: [{id: 'n1'}, {id: 'n2'}]}),
        ...overrides,
    };
}

const BASE_INPUT = {clusterId: 'c1', clusterName: '生产簇', alerts: []};

// ---------------------------------------------------------------- 巡检口径（可配置的判定线）

check('口径缺省时逐字段等于默认表', () => {
    eq(JSON.stringify(P.resolveThresholds(undefined)), JSON.stringify(C.INSPECTION_THRESHOLDS), '默认口径');
});

check('只改一项时其余项仍按默认', () => {
    const th = P.resolveThresholds({backlogWarn: 500});
    eq(th.backlogWarn, 500, '改过的那项');
    eq(th.backlogCrit, T.backlogCrit, '没改的不动');
});

check('严重线低于关注线被拒（否则红字永远出不来）', () => {
    assert.throws(() => P.resolveThresholds({backlogWarn: 2000, backlogCrit: 1000}), /严重线/);
});

check('越界报错而不是静默钳到上限', () => {
    assert.throws(() => P.resolveThresholds({backlogWarn: 500000000}), /只能在/);
});

check('整数字段拒绝小数', () => {
    assert.throws(() => P.resolveThresholds({detailTopN: 2.5}), /整数/);
});

check('NaN 与字符串被拒', () => {
    assert.throws(() => P.resolveThresholds({rateRatio: NaN}), /有限的数字/);
    assert.throws(() => P.resolveThresholds({rateRatio: '3'}), /有限的数字/);
});

check('比例线低于 1 倍被拒（那样任何 topic 都算消费跟不上）', () => {
    assert.throws(() => P.resolveThresholds({rateRatio: 0.5}), /倍数/);
});

check('浮点输入抹掉噪声，避免导出文件里出现 1.1000000000000001', () => {
    eq(P.resolveThresholds({rateMinIn: 0.125}).rateMinIn, 0.13, '按两位收');
    eq(P.resolveThresholds({rateRatio: 1.5}).rateRatio, 1.5, '本来就是两位的不动');
});

check('overrides 只列出与默认不同的字段', () => {
    eq(P.thresholdOverrides(T).length, 0, '默认口径没有改动');
    eq(P.thresholdOverrides({...T, unackedWarn: 1, detailTopN: 3}).join(','), 'unackedWarn,detailTopN', '按字段表顺序');
});

check('两次口径的逐字段差别', () => {
    const changes = P.diffThresholds(T, {...T, backlogCrit: 500000});
    eq(changes.length, 1, '只有一条');
    eq(changes[0].label, '积压严重线', '带中文名');
    eq(changes[0].previous, T.backlogCrit, '从多少');
    eq(changes[0].current, 500000, '到多少');
    eq(P.diffThresholds(T, T).length, 0, '同一份口径没有差别');
});

check('采样上限：缺省用默认，越界与非整数被拒', () => {
    eq(P.resolveSampling({}).maxTopics, C.INSPECTION_DEFAULTS.maxTopics, '默认值');
    eq(P.resolveSampling({maxNamespaces: 30}).maxNamespaces, 30, '传了就按传的');
    assert.throws(() => P.resolveSampling({maxTopics: 0}), /topic 采样上限/);
    assert.throws(() => P.resolveSampling({maxTopics: 1001}), /topic 采样上限/);
    assert.throws(() => P.resolveSampling({maxTopics: 1.5}), /topic 采样上限/);
});

check('判定线一动，同一批数据的级别就跟着动', () => {
    const rows = [row({name: 'public/default/a', backlog: 600, consumerCount: 1})];
    eq(S.buildBacklogCheck(rows).level, 'ok', '默认口径下 600 条不算事');
    eq(S.buildBacklogCheck(rows, {...T, backlogWarn: 500}).level, 'warn', '关注线降到 500 就报关注');
    eq(S.buildBacklogCheck(rows, {...T, backlogWarn: 500, backlogCrit: 600}).level, 'crit', '严重线降到 600 就报严重');
});

check('未 ack 关注线降到 100 时 200 条就报关注', () => {
    const rows = [row({name: 'public/default/a', maxUnacked: 200, consumerCount: 1})];
    eq(S.buildUnackedCheck(rows).level, 'ok', '默认 5 千以下不报');
    eq(S.buildUnackedCheck(rows, {...T, unackedWarn: 100}).level, 'warn', '降线之后报关注');
});

check('速率判定同时受比例线与入向下限约束', () => {
    const rows = [row({name: 'public/default/a', msgRateIn: 20, msgRateOut: 8, consumerCount: 1})];
    eq(S.buildThroughputCheck(rows).level, 'ok', '默认 3 倍线以下不算跟不上');
    eq(S.buildThroughputCheck(rows, {...T, rateRatio: 2}).level, 'warn', '降到 2 倍就命中');
    eq(S.buildThroughputCheck(rows, {...T, rateRatio: 2, rateMinIn: 50}).level, 'ok', '下限提到 50 之后这点流量不报');
});

check('明细条数按口径裁剪而不是写死', () => {
    const rows = [];
    for (let i = 0; i < 12; i += 1) {
        rows.push(row({name: `public/default/t${i}`, blockedSubscriptions: ['s'], consumerCount: 1}));
    }
    eq(S.buildUnackedCheck(rows, {...T, detailTopN: 3}).detail.length, 3, '只列 3 条');
    eq(S.buildUnackedCheck(rows).detail.length, T.detailTopN, '默认按默认条数');
});

// ---------------------------------------------------------------- 环比（inspection-diff）

function item(key, level, summary) {
    return {key, title: `检查项 ${key}`, level, summary: summary || `${key} 的结论`};
}

function kindOf(items, key) {
    const found = items.find(entry => entry.key === key);
    return found ? found.kind : '(缺)';
}

check('级别移动判定：恶化 / 好转 / 不变', () => {
    const prev = [item('backlog', 'warn'), item('consumers', 'crit'), item('alerts', 'ok'), item('workers', 'skip')];
    const cur = [item('backlog', 'crit'), item('consumers', 'ok'), item('alerts', 'ok'), item('workers', 'warn')];
    const items = D.diffInspectionChecks(prev, cur);
    eq(kindOf(items, 'backlog'), 'worsened', 'warn → crit');
    eq(kindOf(items, 'consumers'), 'improved', 'crit → ok');
    eq(kindOf(items, 'alerts'), 'unchanged', 'ok → ok');
    eq(kindOf(items, 'workers'), 'worsened', 'skip → warn 是变坏');
});

check('读不到了（ok → skip）算恶化而不是不变', () => {
    const items = D.diffInspectionChecks([item('brokers', 'ok')], [item('brokers', 'skip')]);
    eq(kindOf(items, 'brokers'), 'worsened', 'ok → skip');
    eq(D.diffInspectionChecks([item('brokers', 'skip')], [item('brokers', 'ok')])[0].kind, 'improved', 'skip → ok');
});

check('新增只报 crit / warn：正常项新出现不是新闻', () => {
    const items = D.diffInspectionChecks([], [item('collect', 'warn'), item('backlog', 'ok')]);
    eq(items.length, 1, '只留一条');
    eq(items[0].key, 'collect', 'warn 那条');
    eq(items[0].previousLevel, null, '新增没有前值');
});

check('消失的高级别项报「本次未出现」而不是「已恢复」', () => {
    const items = D.diffInspectionChecks([item('backlog', 'crit'), item('alerts', 'ok')], []);
    eq(items.length, 1, 'ok 项消失不列');
    eq(items[0].kind, 'resolved', '消失');
    eq(items[0].level, null, '本次没有读数');
    eq(items[0].previousLevel, 'crit', '前值保留');
    eq(items[0].summary, 'backlog 的结论', '沿用上次那句话说清是什么');
});

check('环比排序：需要人处理的在前，同 kind 内按严重度倒序', () => {
    const prev = [item('a', 'ok'), item('b', 'warn'), item('c', 'warn'), item('d', 'warn'), item('f', 'ok')];
    const cur = [item('a', 'crit'), item('c', 'ok'), item('d', 'warn'), item('e', 'warn'), item('f', 'warn')];
    const items = D.diffInspectionChecks(prev, cur);
    eq(items.map(entry => entry.kind).join(','), 'worsened,worsened,new,resolved,improved,unchanged', '按 kind 分组');
    // 同为恶化，crit 排在 warn 前面
    eq(items.map(entry => entry.key).join(','), 'a,f,e,b,c,d', '组内按级别倒序');
    eq(items.length, 6, '不变的那项也在表里，只是排在最后');
});

check('changedCount 只数移动过的项', () => {
    const diff = D.buildInspectionDiff('p-1', '2026-10-17T00:00:00.000Z', [item('a', 'ok')], [item('a', 'ok'), item('b', 'crit')]);
    eq(diff.changedCount, 1, '一条新增');
    eq(diff.previousId, 'p-1', '带上前一份的 id');
    eq(diff.items.length, 2, '含不变项');
    eq(D.buildInspectionDiff('p', 't', [item('a', 'ok')], [item('a', 'ok')]).changedCount, 0, '全一致时为 0');
});

check('环比文案：本次未出现不等于已恢复', () => {
    eq(D.diffChangeLabel('resolved'), '本次未出现', '文案口径');
    eq(D.diffChangeLabel('worsened'), '恶化', '恶化');
});

// ---------------------------------------------------------------- 巡检历史与口径（SQL 口径）
//
// 这几条语句与 src/main/database/sqlite.ts 里的 helper 是同一段 SQL 的两份抄本：
// helper 本身在纯 node 下起不来（node_modules 里的 better-sqlite3 编的是 Electron 的
// ABI），所以这里用 node 自带的 sqlite 驱动按同样的语句验一遍列名、排序与删除条件。
// 表结构从编译好的基线 DDL 里拿，不在测试里重抄一份建表语句——基线与 helper 谁改了
// 忘了对方，这里就会炸。

const {DatabaseSync} = require('node:sqlite');
const {SCHEMA_SQL} = require('../dist/src/main/database/schema.js');

const INSERT_INSPECTION = `INSERT INTO inspections (
   id, cluster_id, cluster_name, version, generated_at, crit, warn, ok, skip,
   scope_json, checks_json, thresholds_json, markdown
 ) VALUES (
   @id, @cluster_id, @cluster_name, @version, @generated_at, @crit, @warn, @ok, @skip,
   @scope_json, @checks_json, @thresholds_json, @markdown
 )`;

const UPSERT_PROFILE = `INSERT INTO inspection_profiles (
   cluster_id, thresholds_json, max_namespaces, max_topics, updated_at
 ) VALUES (
   @cluster_id, @thresholds_json, @max_namespaces, @max_topics, @updated_at
 )
 ON CONFLICT(cluster_id) DO UPDATE SET
   thresholds_json = excluded.thresholds_json,
   max_namespaces = excluded.max_namespaces,
   max_topics = excluded.max_topics,
   updated_at = excluded.updated_at`;

const LIST_INSPECTIONS = `SELECT id, cluster_id, cluster_name, version, generated_at, crit, warn, ok, skip, scope_json
 FROM inspections WHERE cluster_id = ? ORDER BY generated_at DESC LIMIT ?`;

const PREVIOUS_INSPECTION = `SELECT * FROM inspections
 WHERE cluster_id = ? AND id <> ? AND generated_at < ?
 ORDER BY generated_at DESC LIMIT 1`;

const PRUNE_INSPECTIONS = `DELETE FROM inspections
 WHERE cluster_id = ?
   AND id NOT IN (SELECT id FROM inspections WHERE cluster_id = ? ORDER BY generated_at DESC LIMIT ?)`;

function inspectionRecord(overrides) {
    return {
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        cluster_id: '11111111-0000-4000-8000-000000000001',
        cluster_name: '生产簇',
        version: '3.0.4',
        generated_at: '2026-10-17T02:00:00.000Z',
        crit: 1,
        warn: 2,
        ok: 5,
        skip: 1,
        scope_json: '{"topicsSeen":9,"topicsSampled":5}',
        checks_json: '[{"key":"backlog","title":"消息积压","level":"warn","summary":"x"}]',
        thresholds_json: '{"backlogWarn":10000,"backlogCrit":1000000,"unackedWarn":5000,"rateRatio":3,"rateMinIn":10,"detailTopN":8}',
        markdown: '# 报告',
        ...overrides,
    };
}

function openHistoryDb() {
    const database = new DatabaseSync(':memory:');
    // 与主进程同一个设置：SQLite 的 foreign_keys 默认关着，不打开的话
    // cluster_id 那条外键就是一行装饰，测不出列名写错
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(SCHEMA_SQL);
    database
        .prepare("INSERT INTO clusters (id, name, service_url, web_service_url, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))")
        .run('11111111-0000-4000-8000-000000000001', '生产簇', 'pulsar://h:6650', 'http://h:8080');
    database
        .prepare("INSERT INTO clusters (id, name, service_url, web_service_url, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))")
        .run('22222222-0000-4000-8000-000000000002', '测试簇', 'pulsar://h:6650', 'http://h:8080');
    return database;
}

check('基线 DDL 连跑两次不炸（每次启动都会重跑一遍）', () => {
    const database = openHistoryDb();
    database.exec(SCHEMA_SQL);
    const columns = database.prepare('PRAGMA table_info(inspections)').all().map(column => column.name);
    eq(
        columns.join(','),
        'id,cluster_id,cluster_name,version,generated_at,crit,warn,ok,skip,scope_json,checks_json,thresholds_json,markdown',
        'inspections 列清单',
    );
    database.close();
});

check('插入与读取：version 缺省落 null，列表不带大字段', () => {
    const database = openHistoryDb();
    database.prepare(INSERT_INSPECTION).run(inspectionRecord({version: null}));
    const rows = database.prepare(LIST_INSPECTIONS).all('11111111-0000-4000-8000-000000000001', 50);
    eq(rows.length, 1, '一条');
    eq(rows[0].version, null, '未取到版本');
    assert.ok(!('checks_json' in rows[0]) && !('markdown' in rows[0]), '列表不解析整份报告');
    eq(JSON.parse(rows[0].scope_json).topicsSeen, 9, 'scope 取回来');
    const full = database.prepare('SELECT * FROM inspections WHERE id = ?').get('aaaaaaaa-0000-4000-8000-000000000001');
    assert.ok(full.checks_json.includes('消息积压'), '整份检查项在 detail 里');
    database.close();
});

check('历史列表按时间倒序且只给这一台集群', () => {
    const database = openHistoryDb();
    // id 的字典序与时间序刻意相反：证明排序走的是 generated_at 而不是主键
    database.prepare(INSERT_INSPECTION).run(inspectionRecord({id: 'z-1', generated_at: '2026-10-17T01:00:00.000Z'}));
    database.prepare(INSERT_INSPECTION).run(inspectionRecord({id: 'a-1', generated_at: '2026-10-17T03:00:00.000Z'}));
    database.prepare(INSERT_INSPECTION).run(inspectionRecord({id: 'a-2', generated_at: '2026-10-17T02:00:00.000Z'}));
    database.prepare(INSERT_INSPECTION).run(
        inspectionRecord({id: 'other', cluster_id: '22222222-0000-4000-8000-000000000002', generated_at: '2026-10-17T09:00:00.000Z'}),
    );
    const rows = database.prepare(LIST_INSPECTIONS).all('11111111-0000-4000-8000-000000000001', 50);
    eq(rows.map(row => row.id).join(','), 'a-1,a-2,z-1', '倒序且不含别的集群');
    const limited = database.prepare(LIST_INSPECTIONS).all('11111111-0000-4000-8000-000000000001', 2);
    eq(limited.map(row => row.id).join(','), 'a-1,a-2', 'limit 截的是最新的那几条');
    database.close();
});

check('环比取前一份：排除本次自己、只看更早的', () => {
    const database = openHistoryDb();
    database.prepare(INSERT_INSPECTION).run(inspectionRecord({id: 'p1', generated_at: '2026-10-16T01:00:00.000Z'}));
    database.prepare(INSERT_INSPECTION).run(inspectionRecord({id: 'p2', generated_at: '2026-10-17T01:00:00.000Z'}));
    database.prepare(INSERT_INSPECTION).run(inspectionRecord({id: 'cur', generated_at: '2026-10-17T05:00:00.000Z'}));
    const previous = database
        .prepare(PREVIOUS_INSPECTION)
        .get('11111111-0000-4000-8000-000000000001', 'cur', '2026-10-17T05:00:00.000Z');
    eq(previous.id, 'p2', '紧邻的前一份');
    const first = database
        .prepare(PREVIOUS_INSPECTION)
        .get('11111111-0000-4000-8000-000000000001', 'p1', '2026-10-16T01:00:00.000Z');
    eq(first, undefined, '最早的一份没有前值');
    const notInOtherCluster = database
        .prepare(PREVIOUS_INSPECTION)
        .get('22222222-0000-4000-8000-000000000002', 'x', '2026-10-17T05:00:00.000Z');
    eq(notInOtherCluster, undefined, '不会跨集群抓到前一份');
    database.close();
});

check('剪枝只留最近 N 份，且按时间而不是主键判定', () => {
    const database = openHistoryDb();
    database.prepare(INSERT_INSPECTION).run(inspectionRecord({id: 'z-old', generated_at: '2026-10-15T01:00:00.000Z'}));
    database.prepare(INSERT_INSPECTION).run(inspectionRecord({id: 'a-mid', generated_at: '2026-10-16T01:00:00.000Z'}));
    database.prepare(INSERT_INSPECTION).run(inspectionRecord({id: 'm-new', generated_at: '2026-10-17T01:00:00.000Z'}));
    database.prepare(INSERT_INSPECTION).run(
        inspectionRecord({id: 'other', cluster_id: '22222222-0000-4000-8000-000000000002'}),
    );
    const removed = database
        .prepare(PRUNE_INSPECTIONS)
        .run('11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', 2).changes;
    eq(removed, 1, '删掉一份');
    const left = database
        .prepare('SELECT id FROM inspections WHERE cluster_id = ? ORDER BY generated_at DESC')
        .all('11111111-0000-4000-8000-000000000001');
    eq(left.map(row => row.id).join(','), 'm-new,a-mid', '留下的必须是最新的那几份');
    eq(database.prepare('SELECT COUNT(*) as c FROM inspections WHERE cluster_id = ?').get('22222222-0000-4000-8000-000000000002').c, 1, '别的集群一份不少');
    database.close();
});

check('清空历史按集群隔离；外键让乱写的 cluster_id 进不来', () => {
    const database = openHistoryDb();
    database.prepare(INSERT_INSPECTION).run(inspectionRecord({id: 'k1'}));
    database.prepare(INSERT_INSPECTION).run(
        inspectionRecord({id: 'k2', cluster_id: '22222222-0000-4000-8000-000000000002'}),
    );
    eq(database.prepare('DELETE FROM inspections WHERE cluster_id = ?').run('11111111-0000-4000-8000-000000000001').changes, 1, '删一条');
    eq(database.prepare('SELECT COUNT(*) as c FROM inspections').get().c, 1, '另一集群还在');
    let rejected = false;
    try {
        database.prepare(INSERT_INSPECTION).run(inspectionRecord({id: 'k3', cluster_id: '不存在的集群'}));
    } catch (error) {
        rejected = true;
        assert.ok(/FOREIGN KEY/i.test(String(error.message)), '报的是外键而不是列名');
    }
    assert.ok(rejected, 'cluster_id 外键真的生效');
    database.close();
});

const CLUSTER_A = '11111111-0000-4000-8000-000000000001';
const CLUSTER_B = '22222222-0000-4000-8000-000000000002';

function profileRow(overrides) {
    return {
        cluster_id: CLUSTER_A,
        thresholds_json: '{"backlogWarn":500}',
        max_namespaces: 10,
        max_topics: 20,
        updated_at: '2026-10-17T00:00:00.000Z',
        ...overrides,
    };
}

check('口径表按基线建出来，列名与 helper 写的一致', () => {
    const database = openHistoryDb();
    const columns = database.prepare('PRAGMA table_info(inspection_profiles)').all().map(column => column.name);
    eq(columns.join(','), 'cluster_id,thresholds_json,max_namespaces,max_topics,updated_at', '列名与顺序');
    database.close();
});

check('一簇一份口径：第二次保存覆盖而不是多出一行', () => {
    const database = openHistoryDb();
    const statement = database.prepare(UPSERT_PROFILE);
    statement.run(profileRow({}));
    statement.run(profileRow({thresholds_json: '{"backlogWarn":900}', max_topics: 21, updated_at: '2026-10-17T01:00:00.000Z'}));
    eq(Number(database.prepare('SELECT COUNT(*) AS c FROM inspection_profiles').get().c), 1, '仍然一行');
    const saved = database.prepare('SELECT * FROM inspection_profiles WHERE cluster_id = ?').get(CLUSTER_A);
    eq(saved.thresholds_json, '{"backlogWarn":900}', '阈值被覆盖');
    eq(Number(saved.max_topics), 21, '采样上限被覆盖');
    eq(saved.updated_at, '2026-10-17T01:00:00.000Z', '更新时间刷新');
    database.close();
});

check('口径不能配到一台不存在的集群上', () => {
    const database = openHistoryDb();
    let rejected = false;
    try {
        database.prepare(UPSERT_PROFILE).run(profileRow({cluster_id: '99999999-9999-4999-9999-999999999999'}));
    } catch (error) {
        rejected = true;
        assert.ok(/FOREIGN KEY/i.test(String(error.message)), '报的是外键');
    }
    assert.ok(rejected, 'cluster_id 外键挡住了');
    database.close();
});

check('删集群时口径行跟着消失，别的集群不受影响', () => {
    const database = openHistoryDb();
    database.prepare(UPSERT_PROFILE).run(profileRow({}));
    database.prepare(UPSERT_PROFILE).run(profileRow({cluster_id: CLUSTER_B}));
    database.prepare(INSERT_INSPECTION).run(inspectionRecord({cluster_id: CLUSTER_A}));
    database.prepare('DELETE FROM clusters WHERE id = ?').run(CLUSTER_A);
    eq(Number(database.prepare('SELECT COUNT(*) AS c FROM inspection_profiles WHERE cluster_id = ?').get(CLUSTER_A).c), 0, '口径级联删除');
    eq(Number(database.prepare('SELECT COUNT(*) AS c FROM inspections WHERE cluster_id = ?').get(CLUSTER_A).c), 0, '报告级联删除');
    eq(Number(database.prepare('SELECT COUNT(*) AS c FROM inspection_profiles WHERE cluster_id = ?').get(CLUSTER_B).c), 1, '另一集群还在');
    database.close();
});

check('报告行允许没有口径这一格（v2.8 之前存的就是这样）', () => {
    const database = openHistoryDb();
    database.prepare(INSERT_INSPECTION).run(inspectionRecord({thresholds_json: null}));
    eq(database.prepare('SELECT thresholds_json FROM inspections').get().thresholds_json, null, '空读回来是 null，不是默认值');
    database.close();
});

async function main() {
    await checkAsync('一次正常巡检把九类检查都排进报告', async () => {
        const report = await S.runInspection(fakeClient(), BASE_INPUT);
        const keys = report.checks.map(item => item.key);
        for (const key of ['connectivity', 'brokers', 'backlog', 'consumers', 'unacked', 'throughput', 'workers', 'alerts']) {
            assert.ok(keys.includes(key), `缺少检查项 ${key}`);
        }
        eq(report.version, '3.0.4', '版本');
        eq(report.scope.tenants, 1, '租户数');
        eq(report.scope.namespacesSeen, 1, '命名空间数');
        eq(report.scope.topicsSeen, 2, '见到的 topic 数');
        eq(report.scope.topicsSampled, 2, '采到的 topic 数');
        eq(report.scope.truncated, false, '未截断');
        eq(report.totals.crit, 0, '没有严重项');
        eq(report.checks.length, report.totals.ok + report.totals.warn + report.totals.crit + report.totals.skip, 'totals 对齐');
    });

    await checkAsync('健康检查抛错时降级成 crit 并留下局部失败', async () => {
        const report = await S.runInspection(
            fakeClient({healthCheck: async () => { throw new Error('证书已过期'); }}),
            BASE_INPUT,
        );
        const connectivity = report.checks.find(item => item.key === 'connectivity');
        eq(connectivity.level, 'crit', '异常也算未通过');
        const collect = report.checks.find(item => item.key === 'collect');
        assert.ok(collect, '要有局部失败这一项');
        eq(collect.level, 'warn', '局部失败判 warn');
        assert.ok(collect.detail[0].includes('证书已过期'), '错误原文进 detail');
    });

    await checkAsync('broker 列表读取失败只让这一项变 skip', async () => {
        const report = await S.runInspection(
            fakeClient({getBrokers: async () => { throw new Error('404 /admin/v2/brokers'); }}),
            BASE_INPUT,
        );
        eq(report.checks.find(i => i.key === 'brokers').level, 'skip', 'broker 项');
        eq(report.checks.find(i => i.key === 'connectivity').level, 'ok', '连通性不受牵连');
    });

    await checkAsync('命名空间超上限时记 truncated 并停止翻页', async () => {
        let namespaceCalls = 0;
        const report = await S.runInspection(
            fakeClient({
                getTenants: async () => [{name: 'a'}, {name: 'b'}, {name: 'c'}],
                getNamespaces: async () => {
                    namespaceCalls += 1;
                    return ['ns1', 'ns2', 'ns3'];
                },
            }),
            {...BASE_INPUT, options: {maxNamespaces: 2}},
        );
        eq(namespaceCalls, 1, '到上限就不再请求下一个租户');
        eq(report.scope.namespacesSeen, 2, '采样数不超过上限');
        eq(report.scope.truncated, true, '标记截断');
        eq(report.scope.tenants, 3, '租户总数仍按全量报');
    });

    await checkAsync('topic 超上限时按剩余配额取样并标记截断', async () => {
        const many = Array.from({length: 10}, (_, i) => ({name: `public/default/t${i}`, persistent: true}));
        const report = await S.runInspection(
            fakeClient({getTopics: async () => many}),
            {...BASE_INPUT, options: {maxTopics: 4}},
        );
        eq(report.scope.topicsSeen, 10, '见到的仍按全量');
        eq(report.scope.topicsSampled, 4, '采样的不超过上限');
        eq(report.scope.truncated, true, '标记截断');
        assert.ok(report.scope.maxTopics === 4, '上限回写进 scope');
    });

    await checkAsync('单个 topic 统计失败不会毁掉整份报告', async () => {
        // getTopicStats 拿到的是 tenant/ns/topic 形式的名字（列表已经折成基名），断言按这个口径写
        const seenNames = [];
        const report = await S.runInspection(
            fakeClient({
                getTopicStats: async (tenant, ns, topic) => {
                    seenNames.push(topic);
                    if (topic.endsWith('t1')) {
                        throw new Error('Topic not found');
                    }
                    return {msgRateIn: 0, msgRateOut: 0, subscriptions: {}};
                },
            }),
            BASE_INPUT,
        );
        eq(report.scope.topicsSampled, 1, '坏掉的那条不计入');
        eq(report.scope.topicsSeen, 2, '但见过的计数不动');
        eq(seenNames.join(','), 'public/default/t1,public/default/t2', '统计按基名请求');
        assert.ok(report.checks.find(i => i.key === 'collect'), '局部失败要列出来');
    });

    await checkAsync('命名空间读取失败的租户被跳过但报告继续', async () => {
        const report = await S.runInspection(
            fakeClient({
                getTenants: async () => [{name: 'good'}, {name: 'bad'}],
                getNamespaces: async tenant => {
                    if (tenant === 'bad') {
                        throw new Error('Namespace not found');
                    }
                    return ['good/ns'];
                },
                getTopics: async () => [],
            }),
            BASE_INPUT,
        );
        eq(report.scope.namespacesSeen, 1, '只留下读得到的');
        assert.ok(report.checks.find(i => i.key === 'collect'), '失败要记录');
    });

    await checkAsync('worker 抛错转成 skip 而不是中断', async () => {
        const report = await S.runInspection(
            fakeClient({getWorkerState: async () => { throw new Error('worker 未启用'); }}),
            BASE_INPUT,
        );
        const workers = report.checks.find(i => i.key === 'workers');
        eq(workers.level, 'skip', 'worker 项');
        eq(workers.detail[0], 'worker 未启用', '错误原文');
    });

    await checkAsync('默认上限与 options 缺省时一致', async () => {
        const report = await S.runInspection(fakeClient(), BASE_INPUT);
        eq(report.scope.maxNamespaces, C.INSPECTION_DEFAULTS.maxNamespaces, '命名空间默认上限');
        eq(report.scope.maxTopics, C.INSPECTION_DEFAULTS.maxTopics, 'topic 默认上限');
    });

    await checkAsync('告警事件被带进报告', async () => {
        const report = await S.runInspection(fakeClient(), {
            ...BASE_INPUT,
            alerts: [{ruleName: 'r', scopeLabel: 's', message: 'm'}],
        });
        const alerts = report.checks.find(i => i.key === 'alerts');
        eq(alerts.level, 'warn', '有未恢复事件');
        assert.ok(report.totals.warn >= 1, 'totals 计入');
    });

    await checkAsync('Markdown 写清范围、截断与每项证据', async () => {
        const report = await S.runInspection(
            fakeClient({getTopics: async () => Array.from({length: 9}, (_, i) => ({name: `public/default/t${i}`, persistent: true}))}),
            {...BASE_INPUT, alerts: [{ruleName: '积压', scopeLabel: 'public/default/t1', message: '高'}], options: {maxTopics: 5}},
        );
        const md = S.renderInspectionMarkdown(report);
        assert.ok(md.startsWith('# Pulsar 集群巡检报告：生产簇'), '标题带集群名');
        assert.ok(md.includes('采样范围'), '范围行必须存在');
        assert.ok(md.includes('共见到 9 个 topic、逐个采集 5 个'), '见/采两个数都要写');
        assert.ok(md.includes('未采样的部分不在本报告结论之内'), '截断提醒');
        assert.ok(md.includes('## 🔴') || md.includes('## 🟠'), '级别标记');
        assert.ok(md.includes('建议：'), '处置建议');
        assert.ok(md.includes('积压｜public/default/t1｜高'), '告警明细');
        assert.ok(!md.includes('undefined'), '不能把 undefined 渲染出去');
        eq(report.generatedAt.length >= 20, true, '时间戳是 ISO');
    });

    await checkAsync('干净报告的 Markdown 也不留空范围', async () => {
        const report = await S.runInspection(
            fakeClient({
                getTenants: async () => [],
                getTopics: async () => [],
            }),
            BASE_INPUT,
        );
        const md = S.renderInspectionMarkdown(report);
        assert.ok(md.includes('0 个租户'), '空集群也给出范围');
        assert.ok(md.includes('未取到') || md.includes('broker 版本'), '版本缺省有兜底文案');
        assert.ok(!md.includes('未采样的部分不在本报告结论之内'), '没截断就不写截断提醒');
    });

    await checkAsync('Markdown 带上环比段（发出去的文件要说清比上次涨跌）', async () => {
        const report = await S.runInspection(fakeClient(), BASE_INPUT);
        // 造假一份"上次"：把本次判为 ok 的积压写成 crit，环比里就该出现一条好转
        const previousChecks = report.checks.map(check =>
            check.key === 'backlog' ? {...check, level: 'crit'} : {...check},
        );
        const diff = D.buildInspectionDiff('p-9', '2026-10-16T09:00:00.000Z', previousChecks, report.checks);
        assert.ok(diff.changedCount >= 1, '样例至少动一项');
        const md = S.renderInspectionMarkdown(report, diff);
        assert.ok(md.includes('## 与上次巡检的差别（上次：2026-10-16T09:00:00.000Z）'), '环比小标题带上前一份时间');
        assert.ok(md.includes('好转｜消息积压'), '移动项按「变化｜检查项：结论」列出');
        // 差分段插在范围/结论之后、逐项清单之前：拿到文件的人先判断涨跌，再看逐项证据
        assert.ok(md.indexOf('与上次巡检的差别') > md.indexOf('- 结论：'), '在总览之后');
        assert.ok(md.indexOf('与上次巡检的差别') < md.indexOf('Broker 健康检查'), '在逐项清单之前');
        const plain = S.renderInspectionMarkdown(report);
        assert.ok(!plain.includes('与上次巡检的差别'), '没有前一份时不写空段');
    });

    await checkAsync('报告把当次生效的口径抄进去，导出文件说得出这是调过的线', async () => {
        const report = await S.runInspection(fakeClient(), {...BASE_INPUT, thresholds: {backlogWarn: 500}});
        eq(report.thresholds.backlogWarn, 500, '用的就是传进来的');
        eq(report.thresholds.backlogCrit, T.backlogCrit, '没改的仍是默认');
        const md = S.renderInspectionMarkdown(report);
        assert.ok(md.includes('已按本集群调整'), '写明口径调过');
        assert.ok(md.includes('积压关注线 500 条'), '带上数值与单位');
    });

    await checkAsync('没调过线的报告写明默认阈值', async () => {
        const report = await S.runInspection(fakeClient(), BASE_INPUT);
        const md = S.renderInspectionMarkdown(report);
        assert.ok(md.includes('判定口径：默认阈值'), '一句话说明没动过线');
        assert.ok(!md.includes('已按本集群调整'), '不该出现「调整」字样');
    });

    await checkAsync('口径变过之后，环比要把这部分差别单独摘出来', async () => {
        const current = await S.runInspection(fakeClient(), {...BASE_INPUT, thresholds: {backlogWarn: 500}});
        const diff = D.buildInspectionDiff('p-9', '2026-10-16T09:00:00.000Z', current.checks, current.checks, {
            previous: T,
            current: current.thresholds,
        });
        eq(diff.thresholdChanges.length, 1, '一条口径变化');
        const md = S.renderInspectionMarkdown(current, diff);
        assert.ok(md.includes('判定口径与上次不同'), 'Markdown 里有这句');
        assert.ok(md.includes('积压关注线 10000 条 → 500 条'), '写清从多少到多少');
        // 级别一项没动，但口径动了：不能只丢一句「结论一致」，那会让人以为线没变
        assert.ok(md.includes('按新口径重判，级别与上次完全一致'), '结论一致也要说明是重判过的');
    });

    await checkAsync('前一份报告口径未知时不编造口径变化', async () => {
        const current = await S.runInspection(fakeClient(), {...BASE_INPUT, thresholds: {backlogWarn: 500}});
        const diff = D.buildInspectionDiff('p-9', '2026-10-16T09:00:00.000Z', current.checks, current.checks, {
            previous: null,
            current: current.thresholds,
        });
        eq(diff.thresholdChanges.length, 0, '未知就当未知');
        assert.ok(!S.renderInspectionMarkdown(current, diff).includes('判定口径与上次不同'), '不写口径段');
    });

    console.log(`ALL PASS（${passed} 项）`);
    if (failures.length) {
        console.log(`失败 ${failures.length} 项：`);
        failures.forEach(f => console.log('  - ' + f));
        process.exit(1);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
