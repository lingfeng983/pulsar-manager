/**
 * 跨集群巡检汇总自测：不连集群、不开窗口，把「先处理哪台」「这份数字还能不能用」
 * 「整份汇总导出成文件之后别人怎么读」这三件事逐条证伪。
 *
 * 汇总页最容易害人的读法是「这一屏就是此刻整个 fleet 的状态」，而它其实是每台集群各自
 * 最近的一份报告——可能差好几天。所以新鲜度、排序与导出文案里的这几句提醒都算判定逻辑，
 * 和阈值一样得能在没有集群的机器上被验证。
 */
const assert = require('node:assert');
const F = require('../dist/src/shared/inspection-summary.js');

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

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const HOUR = 3_600_000;

function totalsOf(overrides) {
    return {ok: 6, warn: 0, crit: 0, skip: 1, ...overrides};
}

function latestOf(overrides) {
    return {
        id: 'r-1',
        clusterId: 'c-1',
        clusterName: '生产簇',
        generatedAt: '2026-10-17T11:00:00.000Z',
        version: '3.0.4',
        totals: totalsOf({}),
        scope: {
            tenants: 1,
            namespacesSeen: 2,
            topicsSeen: 9,
            topicsSampled: 9,
            maxNamespaces: 50,
            maxTopics: 200,
            truncated: false,
        },
        source: 'manual',
        ...overrides,
    };
}

function clusterOf(overrides) {
    return {
        clusterId: 'c-1',
        clusterName: '生产簇',
        latest: latestOf({}),
        checks: [],
        schedule: null,
        freshness: 'fresh',
        ...overrides,
    };
}

function scheduleOf(overrides) {
    return {
        clusterId: 'c-1',
        enabled: true,
        intervalMinutes: 360,
        notifyOnCrit: true,
        lastRunAt: null,
        lastError: null,
        lastNotifiedCrit: 0,
        updatedAt: '2026-10-17T00:00:00.000Z',
        ...overrides,
    };
}

function summaryOf(overrides) {
    const clusters = [clusterOf({})];
    return {
        generatedAt: '2026-10-17T12:00:00.000Z',
        clusters,
        critGroups: F.groupFleetChecks(clusters),
        totals: F.summarizeFleet(clusters, NOW),
        failures: [],
        skipped: [],
        ...overrides,
    };
}

// ---------------------------------------------------------------- 新鲜度窗口

check('没开定时的用 24 小时窗口，开着的用这台集群自己的间隔', () => {
    eq(F.fleetWindowMs(null), F.FLEET_DEFAULT_WINDOW_MS, '没配调度');
    eq(F.fleetWindowMs(scheduleOf({enabled: false, intervalMinutes: 10080})), F.FLEET_DEFAULT_WINDOW_MS, '配了但关着');
    eq(F.fleetWindowMs(scheduleOf({enabled: true, intervalMinutes: 360})), 6 * HOUR, '6 小时一轮');
    eq(F.fleetWindowMs(scheduleOf({enabled: true, intervalMinutes: 10080})), 7 * 24 * HOUR, '7 天一轮');
});

check('间隔小于下限时窗口按一小时算，不让快节奏时时判成过期', () => {
    eq(F.fleetWindowMs(scheduleOf({enabled: true, intervalMinutes: 30})), HOUR, '30 分钟一轮也有一小时窗口');
});

check('同一份报告在不同节奏下结论不同', () => {
    // 十小时前的那一份：没开定时（24 小时窗口）还算新鲜，6 小时一轮的已经偏旧，
    // 一小时窗口的早就不能当现在用。全局写死一个数就说不出这件事
    const latest = latestOf({generatedAt: new Date(NOW - 10 * HOUR).toISOString()});
    eq(F.fleetFreshness(latest, NOW, null), 'fresh', '24 小时窗口下还新鲜');
    eq(F.fleetFreshness(latest, NOW, scheduleOf({intervalMinutes: 360})), 'aging', '6 小时节奏下偏旧');
    eq(F.fleetFreshness(latest, NOW, scheduleOf({intervalMinutes: 30})), 'stale', '一小时窗口下已经过期');
});

// ---------------------------------------------------------------- 有多旧

check('没有报告是 never，不是 quiet', () => {
    // 「没人看过」与「看过且没事」必须是两句话：后者可以放心翻过去
    eq(F.fleetFreshness(null, NOW, null), 'never', '没有报告');
});

check('窗口边界：刚好到窗口算新鲜，过一格算偏旧', () => {
    const window = F.FLEET_DEFAULT_WINDOW_MS;
    eq(F.fleetFreshness(latestOf({generatedAt: new Date(NOW - window).toISOString()}), NOW, null), 'fresh', '整窗口');
    eq(
        F.fleetFreshness(latestOf({generatedAt: new Date(NOW - window - 1).toISOString()}), NOW, null),
        'aging',
        '超出一毫秒',
    );
});

check('三倍窗口之内只算偏旧，超出才算太久没看', () => {
    const window = F.FLEET_DEFAULT_WINDOW_MS;
    eq(
        F.fleetFreshness(latestOf({generatedAt: new Date(NOW - window * F.FLEET_STALE_FACTOR).toISOString()}), NOW, null),
        'aging',
        '刚好三倍',
    );
    eq(
        F.fleetFreshness(latestOf({generatedAt: new Date(NOW - window * F.FLEET_STALE_FACTOR - 1).toISOString()}), NOW, null),
        'stale',
        '三倍出头',
    );
});

check('时间戳读不出来判 stale 而不是 never', () => {
    // 库里确实有这一行，说「从没看过」是假话；但年龄算不出来就不能让它排进干净那堆
    eq(F.fleetFreshness(latestOf({generatedAt: '昨天下午'}), NOW, null), 'stale', '坏时间戳');
    eq(F.fleetFreshness(latestOf({generatedAt: ''}), NOW, null), 'stale', '空串');
});

check('时间戳在将来判新鲜（时钟倒挂不是巡检的故障）', () => {
    eq(F.fleetFreshness(latestOf({generatedAt: new Date(NOW + 5 * HOUR).toISOString()}), NOW, null), 'fresh', '未来五小时');
});

// ---------------------------------------------------------------- 分堆

check('四档分堆：严重、关注、没看过、干净', () => {
    eq(F.fleetSectionOf(clusterOf({latest: latestOf({totals: totalsOf({crit: 1})})})), 'crit', '有严重项');
    eq(F.fleetSectionOf(clusterOf({latest: latestOf({totals: totalsOf({crit: 0, warn: 2})})})), 'warn', '只有关注');
    eq(F.fleetSectionOf(clusterOf({latest: latestOf({})})), 'quiet', '都没看出');
    eq(F.fleetSectionOf(clusterOf({latest: null})), 'never', '没跑过');
});

check('堆的标签都念得出口', () => {
    for (const key of ['crit', 'warn', 'never', 'quiet']) {
        assert.ok(F.FLEET_SECTION_LABEL[key], `缺少 ${key} 的标签`);
    }
    eq(F.FLEET_SECTION_LABEL.never, '还没巡检过', '没看过这一档');
});

// ---------------------------------------------------------------- 排序

check('排序先按堆：严重在最上，没看过的排在干净之前', () => {
    const rows = [
        clusterOf({clusterId: 'q', clusterName: '干净簇', latest: latestOf({})}),
        clusterOf({clusterId: 'n', clusterName: '没跑簇', latest: null}),
        clusterOf({clusterId: 'w', clusterName: '关注簇', latest: latestOf({totals: totalsOf({warn: 3})})}),
        clusterOf({clusterId: 'c', clusterName: '严重簇', latest: latestOf({totals: totalsOf({crit: 2})})}),
    ];
    rows.sort((a, b) => F.compareFleetClusters(a, b, NOW));
    eq(
        rows.map(row => row.clusterId).join(','),
        'c,w,n,q',
        '严重 → 关注 → 没看过 → 干净',
    );
});

check('同堆里严重项多的在前，再看关注项', () => {
    const rows = [
        clusterOf({clusterId: 'a', clusterName: 'A', latest: latestOf({totals: totalsOf({crit: 1, warn: 9})})}),
        clusterOf({clusterId: 'b', clusterName: 'B', latest: latestOf({totals: totalsOf({crit: 3, warn: 0})})}),
        clusterOf({clusterId: 'c', clusterName: 'C', latest: latestOf({totals: totalsOf({crit: 1, warn: 2})})}),
    ];
    rows.sort((a, b) => F.compareFleetClusters(a, b, NOW));
    eq(rows.map(row => row.clusterId).join(','), 'b,a,c', 'crit 优先于 warn');
});

check('同堆同级里，越久没人看的越靠前', () => {
    // 两台都判出 1 项严重，上周那份与十分钟前的那份需要的注意力不一样：
    // 旧的那份可能已经自己好了，先看它才不会拿着过期的结论去动生产
    const rows = [
        clusterOf({
            clusterId: 'new',
            clusterName: '新',
            latest: latestOf({totals: totalsOf({crit: 1}), generatedAt: new Date(NOW - 10 * 60_000).toISOString()}),
        }),
        clusterOf({
            clusterId: 'old',
            clusterName: '旧',
            latest: latestOf({totals: totalsOf({crit: 1}), generatedAt: new Date(NOW - 5 * 24 * HOUR).toISOString()}),
        }),
        clusterOf({clusterId: 'none', clusterName: '无报告', latest: null}),
    ];
    rows.sort((a, b) => F.compareFleetClusters(a, b, NOW));
    eq(rows.map(row => row.clusterId).join(','), 'old,new,none', '同级里旧的在前，没跑过的仍排在干净那堆之前');

    const quiet = [
        clusterOf({clusterId: 'q2', clusterName: 'B', latest: latestOf({generatedAt: new Date(NOW - 2 * HOUR).toISOString()})}),
        clusterOf({clusterId: 'q1', clusterName: 'A', latest: latestOf({generatedAt: new Date(NOW - 20 * HOUR).toISOString()})}),
    ];
    quiet.sort((a, b) => F.compareFleetClusters(a, b, NOW));
    eq(quiet.map(row => row.clusterId).join(','), 'q1,q2', '干净那堆也是越旧越靠前');
});

check('时间戳坏掉与没有报告都算无穷旧时，按名字稳定收口', () => {
    const rows = [
        clusterOf({clusterId: 'x', clusterName: '乙', latest: latestOf({generatedAt: '不是时间'})}),
        clusterOf({clusterId: 'y', clusterName: '甲', latest: null}),
    ];
    rows.sort((a, b) => F.compareFleetClusters(a, b, NOW));
    // 一个有报告（warn 堆之外，这里 totals 干净）一个没有：没跑过的堆本身在前
    eq(rows.map(row => row.clusterId).join(','), 'y,x', '没看过的排在干净之前');

    const sameSection = [
        clusterOf({clusterId: 'b', clusterName: 'B', latest: latestOf({generatedAt: '坏'})}),
        clusterOf({clusterId: 'a', clusterName: 'A', latest: latestOf({generatedAt: '坏'})}),
    ];
    sameSection.sort((x, y) => F.compareFleetClusters(x, y, NOW));
    eq(sameSection.map(row => row.clusterId).join(','), 'a,b', '两个都读不出时间时按名字，顺序不能随机跳');
});

// ---------------------------------------------------------------- 跨集群分组

function critOf(key, title, summary, suggestion) {
    return {key, title, level: 'crit', summary, ...(suggestion ? {suggestion} : {})};
}

check('只有 crit 参与跨集群分组', () => {
    const groups = F.groupFleetChecks([
        clusterOf({
            clusterId: 'c-1',
            clusterName: 'A',
            checks: [
                {key: 'backlog', title: '消息积压', level: 'warn', summary: 'w'},
                critOf('workers', 'Worker 集群', 'worker 掉线'),
            ],
        }),
        clusterOf({clusterId: 'c-2', clusterName: 'B', checks: [{key: 'backlog', title: '消息积压', level: 'ok', summary: 'o'}]}),
    ]);
    eq(groups.length, 1, '一组');
    eq(groups[0].key, 'workers', '就是那条 crit');
    eq(groups[0].items.length, 1, '一台');
});

check('同一件事在多台集群上一起亮时合成一组，按台数多的在前', () => {
    const groups = F.groupFleetChecks([
        clusterOf({clusterId: 'c-1', clusterName: 'A', checks: [critOf('backlog', '消息积压', '高积压'), critOf('blocked', '订阅阻塞', '阻塞')]}),
        clusterOf({clusterId: 'c-2', clusterName: 'B', checks: [critOf('backlog', '消息积压', '高积压')]}),
        clusterOf({clusterId: 'c-3', clusterName: 'C', checks: [critOf('backlog', '消息积压', '高积压')]}),
    ]);
    eq(groups.length, 2, '两件事');
    eq(groups[0].key, 'backlog', '三台的那件在前');
    eq(groups[0].items.map(item => item.clusterName).join(','), 'A,B,C', '按输入顺序列出');
    eq(groups[1].items.length, 1, '另一件只有一台');
});

check('建议跟着分组走，导出与界面都用同一句话', () => {
    const groups = F.groupFleetChecks([
        clusterOf({clusterId: 'c-1', clusterName: 'A', checks: [critOf('backlog', '消息积压', '最高 320 万条', '先看订阅 s1 是否停摆')]}),
    ]);
    eq(groups[0].items[0].suggestion, '先看订阅 s1 是否停摆', '建议带上');
    const noSuggestion = F.groupFleetChecks([
        clusterOf({clusterId: 'c-1', clusterName: 'A', checks: [critOf('backlog', '消息积压', 'x')]}),
    ]);
    eq(noSuggestion[0].items[0].suggestion, undefined, '没有建议就是 undefined，不造空串');
});

// ---------------------------------------------------------------- 头上的数

check('汇总计数把「没跑过」与「有报告」分开算', () => {
    const clusters = [
        clusterOf({clusterId: 'a', latest: latestOf({totals: totalsOf({crit: 2, warn: 1})})}),
        clusterOf({clusterId: 'b', latest: latestOf({totals: totalsOf({crit: 0, warn: 3})})}),
        clusterOf({clusterId: 'c', latest: null}),
        clusterOf({
            clusterId: 'd',
            latest: latestOf({generatedAt: new Date(NOW - 100 * HOUR).toISOString()}),
            schedule: scheduleOf({intervalMinutes: 60}),
        }),
    ];
    const totals = F.summarizeFleet(clusters, NOW);
    eq(totals.clusters, 4, '总台数');
    eq(totals.inspected, 3, '有报告的台数');
    eq(totals.never, 1, '没跑过');
    eq(totals.crit, 2, '严重合计');
    eq(totals.warn, 4, '关注合计（1 + 3 + 没有报告的 c 不计）');
    eq(totals.stale, 1, '只有一台过期（d 的窗口是一小时）');
    eq(totals.scheduled, 1, '开定时的台数');
    eq(totals.inspected + totals.never, totals.clusters, '两个数加起来就是总台数');
});

// ---------------------------------------------------------------- 一次跑几台

check('一次最多 20 台，越界是拒绝而不是夹住', () => {
    eq(F.resolveFleetLimit(undefined), F.FLEET_RUN_MAX_CLUSTERS, '缺省给上限');
    eq(F.resolveFleetLimit(1), 1, '一台');
    eq(F.resolveFleetLimit(20), 20, '刚好上限');
    throwsWith(() => F.resolveFleetLimit(21), /20/, '超一台');
    throwsWith(() => F.resolveFleetLimit(0), /正整数/, '零台');
    throwsWith(() => F.resolveFleetLimit(-3), /正整数/, '负数');
    throwsWith(() => F.resolveFleetLimit(2.5), /正整数/, '小数');
    throwsWith(() => F.resolveFleetLimit(Number.NaN), /正整数/, 'NaN');
    throwsWith(() => F.resolveFleetLimit('5'), /正整数/, '字符串');
});

check('采样范围那一格把截断写出来', () => {
    eq(F.fleetSamplingNote(null), '没有报告', '没有报告');
    eq(F.fleetSamplingNote(latestOf({}).scope), '采到 9 个 topic', '未截断');
    eq(
        F.fleetSamplingNote({...latestOf({}).scope, topicsSeen: 460, topicsSampled: 60, truncated: true}),
        '共 460 个 topic、只采了 60 个',
        '截断',
    );
});

// ---------------------------------------------------------------- 导出文本

check('导出顶部就写明「不是同一时刻的快照」', () => {
    const md = F.renderFleetMarkdown(summaryOf({}));
    assert.ok(md.startsWith('# Pulsar 集群巡检汇总：1 台'), '标题带台数');
    assert.ok(md.includes('不是同一时刻的快照'), '第一句就是它');
    assert.ok(md.includes('跨集群直接比数值大小没有意义'), '判定线可能各调过');
    assert.ok(md.includes('开着定时的'), '定时开了几台要能看见');
    assert.ok(!md.includes('undefined'), '不能把 undefined 渲染出去');
    assert.ok(md.includes('| 集群 | 最近一次 | 来源 | 严重 | 关注 | 未覆盖 | 采样 | 新鲜度 |'), '表头');
    assert.ok(md.includes('| 生产簇 | 2026-10-17T11:00:00.000Z | 手动 | 0 | 0 | 1 | 采到 9 个 topic | 新鲜 |'), '整行');
});

check('自动来源与截断范围在表里各占一格', () => {
    const md = F.renderFleetMarkdown(
        summaryOf({
            clusters: [
                clusterOf({
                    latest: latestOf({source: 'scheduled', scope: {...latestOf({}).scope, topicsSeen: 460, topicsSampled: 60, truncated: true}}),
                }),
            ],
        }),
    );
    assert.ok(md.includes('| 自动 |'), '来源');
    assert.ok(md.includes('共 460 个 topic、只采了 60 个'), '截断写进表');
});

check('没有报告的集群单独一段并说明它不在结论之内', () => {
    const clusters = [
        clusterOf({clusterId: 'a', clusterName: '有报告', latest: latestOf({})}),
        clusterOf({clusterId: 'b', clusterName: '没跑过', latest: null, freshness: 'never'}),
    ];
    const md = F.renderFleetMarkdown(
        summaryOf({clusters, critGroups: F.groupFleetChecks(clusters), totals: F.summarizeFleet(clusters, NOW)}),
    );
    assert.ok(md.includes('## 还没巡检过的集群'), '单独一段');
    assert.ok(md.includes('- 没跑过'), '列出名字');
    assert.ok(md.includes('不在上面的结论之内'), '这句话必须有');
    assert.ok(md.includes('| 没跑过 | — | — | — | — | — | — | 从没看过 |'), '表里用破折号而不是 0');
});

check('跨集群的严重项合并成组，一台都严重时也说「几台」', () => {
    const clusters = [
        clusterOf({clusterId: 'a', clusterName: 'A', checks: [critOf('backlog', '消息积压', '最高 320 万条', '看订阅')] }),
        clusterOf({clusterId: 'b', clusterName: 'B', checks: [critOf('backlog', '消息积压', '最高 11 万条')]}),
    ];
    clusters.forEach(row => {
        row.latest = latestOf({totals: totalsOf({crit: 1}), clusterName: row.clusterName});
    });
    const md = F.renderFleetMarkdown(
        summaryOf({clusters, critGroups: F.groupFleetChecks(clusters), totals: F.summarizeFleet(clusters, NOW)}),
    );
    assert.ok(md.includes('## 跨集群的严重项'), '有这一段');
    assert.ok(md.includes('### 消息积压（2 台）'), '按台数');
    assert.ok(md.includes('- A：最高 320 万条'), '逐台结论');
    assert.ok(md.includes('- 建议：看订阅'), '建议带上');
    assert.ok(!md.includes('「没有」只对这些报告成立'), '有严重项时不写那句空结论');
});

check('一个严重项都没有时也要说一句，而不是留一段空白', () => {
    const md = F.renderFleetMarkdown(summaryOf({}));
    assert.ok(md.includes('这些最近一份报告里没有严重项'), '空结论也要有句子');
    assert.ok(md.includes('不等于此刻没问题'), '并且说明它不等于');
});

check('本轮跑坏的与因为上限没跑的分成两段', () => {
    const md = F.renderFleetMarkdown(
        summaryOf({
            failures: [{clusterId: 'c-3', clusterName: '测试簇', message: '连接超时'}],
            skipped: [{clusterId: 'c-4', clusterName: '预发簇'}],
        }),
    );
    assert.ok(md.includes('## 本轮没能跑成的集群'), '坏的那段');
    assert.ok(md.includes('- 测试簇：连接超时'), '带上原因');
    assert.ok(md.includes('本轮没跑的 1 台：预发簇'), '没跑的那段');
    assert.ok(md.includes('一次最多 20 台'), '为什么没跑');
});

check('集群名里的竖线与换行不会把表格撑坏', () => {
    const clusters = [clusterOf({clusterName: '生产|A\n第二行'})];
    const md = F.renderFleetMarkdown(summaryOf({clusters, critGroups: [], totals: F.summarizeFleet(clusters, NOW)}));
    const tableLine = md.split('\n').find(line => line.startsWith('| 生产'));
    assert.ok(tableLine, '这一行还在');
    assert.ok(tableLine.includes('生产\\|A 第二行'), `转义并压成一行：${tableLine}`);
    eq(tableLine.split(' | ').length >= 6, true, '列数没有被撑开');
});

check('集群表为空时导出也不炸，仍然说清范围', () => {
    const clusters = [];
    const md = F.renderFleetMarkdown(
        summaryOf({clusters, critGroups: [], totals: F.summarizeFleet(clusters, NOW)}),
    );
    assert.ok(md.includes('# Pulsar 集群巡检汇总：0 台'), '标题');
    assert.ok(md.includes('（集群表是空的）'), '空态');
    assert.ok(!md.includes('undefined'), '不留 undefined');
});

// ---------------------------------------------------------------- 「最近一份」的 SQL 口径
//
// 与 inspection-selftest 同一个理由：sqlite.ts 里的 helper 在纯 node 下起不来
// （better-sqlite3 编的是 Electron 的 ABI），这里用 node 自带的 sqlite 驱动按同样的语句跑一遍。

const {DatabaseSync} = require('node:sqlite');
const {SCHEMA_SQL} = require('../dist/src/main/database/schema.js');

const LIST_LATEST = `SELECT i.id, i.cluster_id, i.cluster_name, i.version, i.generated_at,
       i.crit, i.warn, i.ok, i.skip, i.scope_json, i.checks_json, i.thresholds_json, i.source
FROM inspections i
JOIN (
  SELECT cluster_id, MAX(generated_at) AS generated_at
  FROM inspections
  GROUP BY cluster_id
) t ON t.cluster_id = i.cluster_id AND t.generated_at = i.generated_at
ORDER BY i.cluster_id`;

const CLUSTER_A = '11111111-0000-4000-8000-000000000001';
const CLUSTER_B = '22222222-0000-4000-8000-000000000002';
const CLUSTER_C = '33333333-0000-4000-8000-000000000003';

const INSERT = `INSERT INTO inspections (
   id, cluster_id, cluster_name, version, generated_at, crit, warn, ok, skip,
   scope_json, checks_json, thresholds_json, source, markdown
 ) VALUES (
   @id, @cluster_id, @cluster_name, @version, @generated_at, @crit, @warn, @ok, @skip,
   @scope_json, @checks_json, @thresholds_json, @source, @markdown
 )`;

function rowOf(overrides) {
    return {
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        cluster_id: CLUSTER_A,
        cluster_name: '生产簇',
        version: '3.0.4',
        generated_at: '2026-10-17T02:00:00.000Z',
        crit: 0,
        warn: 0,
        ok: 9,
        skip: 0,
        scope_json: '{"topicsSeen":9,"topicsSampled":9,"truncated":false}',
        checks_json: '[]',
        thresholds_json: null,
        source: 'manual',
        markdown: '# 报告',
        ...overrides,
    };
}

function openDb() {
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(SCHEMA_SQL);
    const insert = database.prepare(
        "INSERT INTO clusters (id, name, service_url, web_service_url, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
    );
    insert.run(CLUSTER_A, '生产簇', 'pulsar://h:6650', 'http://h:8080');
    insert.run(CLUSTER_B, '测试簇', 'pulsar://h:6650', 'http://h:8080');
    insert.run(CLUSTER_C, '预发簇', 'pulsar://h:6650', 'http://h:8080');
    return database;
}

check('每台集群只取自己最近的一份，别的集群的不混进来', () => {
    const database = openDb();
    database.prepare(INSERT).run(rowOf({id: 'a-old', generated_at: '2026-10-15T02:00:00.000Z'}));
    database.prepare(INSERT).run(rowOf({id: 'a-new', generated_at: '2026-10-17T02:00:00.000Z'}));
    database.prepare(INSERT).run(rowOf({id: 'b-1', cluster_id: CLUSTER_B, cluster_name: '测试簇', generated_at: '2026-10-16T02:00:00.000Z'}));
    const rows = database.prepare(LIST_LATEST).all();
    eq(rows.map(row => row.id).join(','), 'a-new,b-1', '每台一份');
    eq(rows.map(row => row.cluster_id).join(','), `${CLUSTER_A},${CLUSTER_B}`, '顺序稳定（按集群）');
    database.close();
});

check('没有报告的集群不出现（补行是服务层的活，SQL 不替它造一份）', () => {
    const database = openDb();
    database.prepare(INSERT).run(rowOf({}));
    const rows = database.prepare(LIST_LATEST).all();
    eq(rows.length, 1, '只有跑过的那台');
    eq(
        Number(database.prepare('SELECT COUNT(*) AS c FROM clusters').get().c),
        3,
        '集群表里还是三台——汇总要给没跑过的留一行',
    );
    database.close();
});

check('取回的行带 checks_json 与 source，但不带 markdown', () => {
    const database = openDb();
    database.prepare(INSERT).run(rowOf({checks_json: '[{"key":"backlog","title":"消息积压","level":"crit","summary":"高"}]', source: 'scheduled'}));
    const row = database.prepare(LIST_LATEST).all()[0];
    assert.ok(Array.isArray(JSON.parse(row.checks_json)), '检查项能解析');
    eq(row.source, 'scheduled', '来源');
    eq('markdown' in row, false, '整份导出文本不在这里');
    eq(row.thresholds_json, null, '口径可以是空（老报告）');
    database.close();
});

check('同一毫秒里的两份会各出一行：去重是调用方的责任（这里把行为钉住）', () => {
    const database = openDb();
    database.prepare(INSERT).run(rowOf({id: 'tie-1', source: 'manual'}));
    database.prepare(INSERT).run(rowOf({id: 'tie-2', source: 'scheduled'}));
    const rows = database.prepare(LIST_LATEST).all();
    eq(rows.length, 2, 'SQL 不去重');
    // 服务层按 cluster_id 收 Map，保留先出现的那行；这条断言说的是「必须去重」这个前提
    const seen = new Map();
    for (const row of rows) {
        if (!seen.has(row.cluster_id)) {
            seen.set(row.cluster_id, row);
        }
    }
    eq(seen.size, 1, '去重之后一台一行');
    eq(seen.get(CLUSTER_A).id, 'tie-1', '留第一行');
    database.close();
});

check('老库没有 source 列：基线重跑补不上，只有迁移那句 ALTER 能补', () => {
    const pattern = /[ \t]*source TEXT NOT NULL DEFAULT 'manual',\r?\n/;
    const pre = SCHEMA_SQL.replace(pattern, '');
    assert.ok(pre !== SCHEMA_SQL, '基线 DDL 里找不到 source 那一行，这份抄本该更新了');
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(pre);
    database
        .prepare(
            "INSERT INTO clusters (id, name, service_url, web_service_url, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
        )
        .run(CLUSTER_A, '生产簇', 'pulsar://h:6650', 'http://h:8080');
    // 这一条语句是 v13 之前那份抄本，参数对象里也不能带 source——node:sqlite 会拒未知参数名
    const legacyRow = rowOf({thresholds_json: null});
    delete legacyRow.source;
    database
        .prepare(
            `INSERT INTO inspections (
               id, cluster_id, cluster_name, version, generated_at, crit, warn, ok, skip,
               scope_json, checks_json, thresholds_json, markdown
             ) VALUES (@id, @cluster_id, @cluster_name, @version, @generated_at, @crit, @warn, @ok, @skip,
               @scope_json, @checks_json, @thresholds_json, @markdown)`,
        )
        .run(legacyRow);
    const hasSource = () =>
        database
            .prepare('PRAGMA table_info(inspections)')
            .all()
            .some(column => column.name === 'source');
    eq(hasSource(), false, '升级前读不到 source');
    // 汇总那条语句 select 了 source：老库上直接跑就是 no such column，这正是迁移必须存在的理由
    throwsWith(() => database.prepare(LIST_LATEST).all(), /no such column/i, '老库上跑汇总查询');
    // 基线 DDL 每次启动都重跑，但它是 CREATE TABLE IF NOT EXISTS——对已经存在的表一个列都不会加
    database.exec(SCHEMA_SQL);
    eq(hasSource(), false, '基线重跑补不出这一列');
    // 迁移里 PRAGMA 守卫后的那句 ALTER 才是补上列的那一步
    database.prepare("ALTER TABLE inspections ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'").run();
    const rows = database.prepare(LIST_LATEST).all();
    eq(rows.length, 1, '补列之后汇总能跑');
    eq(rows[0].source, 'manual', 'v3.1 之前那几份报告读回来算手点的');
    database.close();
});

if (!failures.length) {
    console.log(`ALL PASS（${passed} 项）`);
} else {
    console.log(`失败 ${failures.length} 项 / 通过 ${passed} 项：`);
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
}
console.log(`跨集群汇总自测通过 ${passed} 项：新鲜度窗口、分堆与排序、跨集群分组、逐台上限、导出文本与最近一份的 SQL`);
