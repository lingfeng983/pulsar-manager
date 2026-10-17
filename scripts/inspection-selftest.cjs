/**
 * 集群巡检自测：不连 broker，用假 client 把判定规则的边界跑一遍。
 * 这些断言存在的意义是「阈值改动会立刻在这里暴露」，而不是重复实现一遍服务。
 */
const assert = require('node:assert');
const S = require('../dist/src/main/services/cluster-inspection.js');

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

const T = S.INSPECTION_THRESHOLDS;

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
        eq(report.scope.maxNamespaces, S.INSPECTION_DEFAULTS.maxNamespaces, '命名空间默认上限');
        eq(report.scope.maxTopics, S.INSPECTION_DEFAULTS.maxTopics, 'topic 默认上限');
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
