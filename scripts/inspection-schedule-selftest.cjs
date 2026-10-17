/**
 * 定时巡检自测：不连集群、不开窗口，把「什么时候该自动跑一次」和「跑完要不要打扰人」这两件事
 * 逐条证伪。
 *
 * 这两类判定一旦只能靠等满一个间隔来验证，实际就等于没验证过——间隔是 6 小时的话，
 * 一天最多暴露一次错误，而错误的内容是「这台集群今天没人看过」。所以纯逻辑全部来自
 * dist/src/shared/inspection-schedule.js，SQL 部分用 node 自带的 sqlite 驱动按同样的语句跑。
 */
const assert = require('node:assert');
const K = require('../dist/src/shared/inspection-schedule.js');

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

const MINUTE = 60_000;

// ---------------------------------------------------------------- 间隔的合法区间

check('间隔缺省落默认值而不是 0 或 NaN', () => {
    eq(K.resolveIntervalMinutes(undefined), K.DEFAULT_INTERVAL_MINUTES, 'undefined');
    eq(K.resolveIntervalMinutes(null), K.DEFAULT_INTERVAL_MINUTES, 'null');
    eq(K.DEFAULT_INTERVAL_MINUTES, 360, '默认 6 小时');
    eq(K.resolveIntervalMinutes(360), 360, '区间内原样');
});

check('区间边界按端点闭合', () => {
    eq(K.resolveIntervalMinutes(K.INTERVAL_LIMITS.min), 30, '下限');
    eq(K.resolveIntervalMinutes(K.INTERVAL_LIMITS.max), 10_080, '上限');
});

check('越界是拒绝而不是夹到边界', () => {
    // 夹一下看着宽容，实际留下「填了 5 分钟却跑成 30 分钟」这种只能自己发现的静默不一致
    throwsWith(() => K.resolveIntervalMinutes(5), /30～10080/, '太短');
    throwsWith(() => K.resolveIntervalMinutes(29), /30～10080/, '下限前一格');
    throwsWith(() => K.resolveIntervalMinutes(10_081), /30～10080/, '上限后一格');
    throwsWith(() => K.resolveIntervalMinutes(-60), /30～10080/, '负数');
});

check('非整数与非法数值一律拒绝', () => {
    throwsWith(() => K.resolveIntervalMinutes(30.5), /整数/, '小数');
    throwsWith(() => K.resolveIntervalMinutes(Number.NaN), /整数/, 'NaN');
    throwsWith(() => K.resolveIntervalMinutes(Infinity), /整数/, 'Infinity');
    // 类型这一层是给绕过 zod 的直接调用兜底的：TS 编译期挡不住 JS 侧传进来的字符串
    throwsWith(() => K.resolveIntervalMinutes('60'), /整数/, '字符串');
});

// ---------------------------------------------------------------- 间隔怎么念给人听

check('间隔文案：能整除小时就说小时，能整除天就说天', () => {
    eq(K.formatIntervalMinutes(30), '30 分钟', '不足一小时');
    eq(K.formatIntervalMinutes(90), '90 分钟', '一小时半不能整除小时');
    eq(K.formatIntervalMinutes(60), '1 小时', '一小时');
    eq(K.formatIntervalMinutes(360), '6 小时', '六小时');
    eq(K.formatIntervalMinutes(720), '12 小时', '十二小时仍算小时');
    eq(K.formatIntervalMinutes(1440), '1 天', '一天不说 24 小时');
    eq(K.formatIntervalMinutes(2880), '2 天', '两天');
    eq(K.formatIntervalMinutes(10_080), '7 天', '上限');
});

// ---------------------------------------------------------------- 到期判定

check('从没跑过算到期：启动后第一轮就补一次', () => {
    // 「开了定时但今天没动静」是最容易被当成故障的观感，等满一个间隔才跑第一次说不通
    eq(K.isInspectionDue({nowMs: 1_000, lastRunAt: null, intervalMinutes: 360}), true, '首次');
    eq(K.isInspectionDue({nowMs: 1_000, lastRunAt: '', intervalMinutes: 360}), true, '空串');
});

check('时间戳读不出来也算到期：一次坏落库不该让这台集群从此不再被巡检', () => {
    eq(K.isInspectionDue({nowMs: Date.parse('2026-10-17T00:00:00.000Z'), lastRunAt: '0', intervalMinutes: 360}), true, '无法解析');
    eq(
        K.isInspectionDue({nowMs: Date.parse('2026-10-17T00:00:00.000Z'), lastRunAt: '昨天下午', intervalMinutes: 360}),
        true,
        '不是时间',
    );
});

check('刚好到点算到期，差一分钟不算', () => {
    const last = Date.parse('2026-10-17T00:00:00.000Z');
    eq(K.isInspectionDue({nowMs: last + 360 * MINUTE, lastRunAt: '2026-10-17T00:00:00.000Z', intervalMinutes: 360}), true, '整间隔');
    eq(
        K.isInspectionDue({nowMs: last + 360 * MINUTE - 1, lastRunAt: '2026-10-17T00:00:00.000Z', intervalMinutes: 360}),
        false,
        '差 1 毫秒',
    );
    eq(
        K.isInspectionDue({nowMs: last + 359 * MINUTE, lastRunAt: '2026-10-17T00:00:00.000Z', intervalMinutes: 360}),
        false,
        '差一分钟',
    );
    eq(
        K.isInspectionDue({nowMs: last + 361 * MINUTE, lastRunAt: '2026-10-17T00:00:00.000Z', intervalMinutes: 360}),
        true,
        '已过点',
    );
});

check('上次运行时间在将来时不跑（改系统时间不会变成连环巡检）', () => {
    eq(
        K.isInspectionDue({nowMs: Date.parse('2026-10-17T00:00:00.000Z'), lastRunAt: '2026-10-18T00:00:00.000Z', intervalMinutes: 30}),
        false,
        '未来',
    );
});

check('下次大约什么时候跑：没有上次运行时间就说待首次而不是造一个', () => {
    eq(K.nextInspectionRunAt(null, 360), null, '未跑过');
    eq(K.nextInspectionRunAt('不是时间', 360), null, '坏时间戳');
    eq(
        K.nextInspectionRunAt('2026-10-17T00:00:00.000Z', 360),
        Date.parse('2026-10-17T06:00:00.000Z'),
        '上次 + 间隔',
    );
    eq(
        K.nextInspectionRunAt('2026-10-17T00:00:00.000Z', 360, Date.parse('2026-10-17T09:00:00.000Z')),
        Date.parse('2026-10-17T09:00:00.000Z'),
        '已过期时按现在算，不把过去的时间当成下次',
    );
});

// ---------------------------------------------------------------- 通知去重

check('严重项数没动就不再打扰第二次', () => {
    // 一天好几轮，同一条积压烧着的时候，第二轮通知不带任何新信息
    eq(K.scheduledInspectionNotice(0, 0), null, '一直干净');
    eq(K.scheduledInspectionNotice(2, 2), null, '持平');
    eq(K.scheduledInspectionNotice(5, 5), null, '持平（多项）');
});

check('首次出现 / 变多 / 变少 / 归零各说一句', () => {
    eq(K.scheduledInspectionNotice(1, 0), 'fired', '首次判出');
    eq(K.scheduledInspectionNotice(5, 0), 'fired', '首次就多项');
    eq(K.scheduledInspectionNotice(3, 2), 'worsened', '变多');
    eq(K.scheduledInspectionNotice(1, 2), 'improved', '变少但还没归零');
    eq(K.scheduledInspectionNotice(0, 2), 'recovered', '归零');
    eq(K.scheduledInspectionNotice(0, 1), 'recovered', '归零（一项）');
});

check('归零之后再来一轮干净的仍然是「不发」', () => {
    // recovered 之后 last_notified_crit 被写回 0，下一轮 0/0 不能把恢复再说一遍
    eq(K.scheduledInspectionNotice(0, 0), null, '恢复后的下一轮');
});

check('通知文案带上从多少到多少，而不是把数字再抄一遍', () => {
    const totals = {ok: 6, warn: 3, crit: 4, skip: 1};
    eq(
        K.scheduleNoticeText('fired', '生产簇', 4, 0, totals),
        '生产簇：巡检判出 4 项严重（关注 3 项）',
        '首次',
    );
    eq(K.scheduleNoticeText('worsened', '生产簇', 4, 2, totals), '生产簇：严重项从 2 增加到 4（关注 3 项）', '变多');
    eq(K.scheduleNoticeText('improved', '生产簇', 4, 9, totals), '生产簇：严重项从 9 降到 4，还没归零', '变少');
    eq(K.scheduleNoticeText('recovered', '生产簇', 0, 9, totals), '生产簇：巡检严重项已归零（关注 3 项）', '归零');
});

check('恢复用另一种标题，别让「需要处理」盖住一条好消息', () => {
    eq(K.scheduleNoticeTitle('recovered'), '巡检：严重项已恢复', '恢复');
    eq(K.scheduleNoticeTitle('fired'), '巡检：需要处理', '首次');
    eq(K.scheduleNoticeTitle('improved'), '巡检：需要处理', '变少仍是需要处理');
});

// ---------------------------------------------------------------- 推送与来源

check('定时跑完推给渲染层的那一条带齐 totals 与时间', () => {
    const totals = {ok: 8, warn: 1, crit: 0, skip: 0};
    const push = K.buildScheduledPush({
        clusterId: 'c-1',
        clusterName: '生产簇',
        totals,
        generatedAt: '2026-10-17T06:00:00.000Z',
        message: '生产簇：定时巡检完成',
    });
    eq(push.kind, 'completed', '完成而不是失败');
    eq(push.clusterId, 'c-1', '集群');
    eq(push.totals, totals, 'totals 原样');
    eq(push.generatedAt, '2026-10-17T06:00:00.000Z', '报告自己的时间');
    assert.ok(!('source' in push), '推送里不重复带来源（kind 已经说明是定时）');
});

check('来源只有自动与手动两种念法', () => {
    eq(K.inspectionSourceLabel('manual'), '手动', '手动');
    eq(K.inspectionSourceLabel('scheduled'), '自动', '自动');
    // 老报告没有这个字段时按 manual 落库，读回来不该显示成空白
    eq(K.inspectionSourceLabel(undefined), '手动', '缺省当手动');
});

check('滚动保留份数是个位数十几，不是无限', () => {
    eq(K.INSPECTION_HISTORY_KEEP, 30, '每簇留 30 份');
});

// ---------------------------------------------------------------- SQL 口径
//
// 这几段语句与 src/main/database/sqlite.ts 里的 helper 是同一段 SQL 的两份抄本：
// helper 本身在纯 node 下起不来（node_modules 里的 better-sqlite3 编的是 Electron 的 ABI），
// 所以这里用 node 自带的 sqlite 驱动按同样的语句验列名、默认值与更新分支到底动了哪几格。
// 表结构从编译好的基线 DDL 里拿，不在测试里重抄一份建表语句。

const {DatabaseSync} = require('node:sqlite');
const {SCHEMA_SQL} = require('../dist/src/main/database/schema.js');

const CLUSTER_A = '11111111-0000-4000-8000-000000000001';
const CLUSTER_B = '22222222-0000-4000-8000-000000000002';

const UPSERT_SCHEDULE = `INSERT INTO inspection_schedules (
   cluster_id, enabled, interval_minutes, notify_on_crit,
   last_run_at, last_error, last_notified_crit, updated_at
 ) VALUES (
   @cluster_id, @enabled, @interval_minutes, @notify_on_crit,
   @last_run_at, @last_error, @last_notified_crit, @updated_at
 )
 ON CONFLICT(cluster_id) DO UPDATE SET
   enabled = excluded.enabled,
   interval_minutes = excluded.interval_minutes,
   notify_on_crit = excluded.notify_on_crit,
   updated_at = excluded.updated_at`;

const MARK_RUN = `UPDATE inspection_schedules
 SET last_run_at = @ranAt,
     last_error = @error,
     last_notified_crit = COALESCE(@notifiedCrit, last_notified_crit)
 WHERE cluster_id = @clusterId`;

const LIST_ENABLED = 'SELECT * FROM inspection_schedules WHERE enabled = 1 ORDER BY cluster_id';

const INSERT_INSPECTION = `INSERT INTO inspections (
   id, cluster_id, cluster_name, version, generated_at, crit, warn, ok, skip,
   scope_json, checks_json, thresholds_json, source, markdown
 ) VALUES (
   @id, @cluster_id, @cluster_name, @version, @generated_at, @crit, @warn, @ok, @skip,
   @scope_json, @checks_json, @thresholds_json, @source, @markdown
 )`;

// v3.1 之前存报告的那条语句：不列 source，靠列默认值落 manual
const INSERT_INSPECTION_LEGACY = `INSERT INTO inspections (
   id, cluster_id, cluster_name, version, generated_at, crit, warn, ok, skip,
   scope_json, checks_json, thresholds_json, markdown
 ) VALUES (
   @id, @cluster_id, @cluster_name, @version, @generated_at, @crit, @warn, @ok, @skip,
   @scope_json, @checks_json, @thresholds_json, @markdown
 )`;

const LIST_INSPECTION_COLUMNS = `SELECT id, cluster_id, cluster_name, version, generated_at, crit, warn, ok, skip, scope_json, source
 FROM inspections WHERE cluster_id = ? ORDER BY generated_at DESC LIMIT ?`;

function scheduleRow(overrides) {
    return {
        cluster_id: CLUSTER_A,
        enabled: 1,
        interval_minutes: 360,
        notify_on_crit: 1,
        last_run_at: null,
        last_error: null,
        last_notified_crit: 0,
        updated_at: '2026-10-17T00:00:00.000Z',
        ...overrides,
    };
}

function inspectionRow(overrides) {
    return {
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        cluster_id: CLUSTER_A,
        cluster_name: '生产簇',
        version: '3.0.4',
        generated_at: '2026-10-17T02:00:00.000Z',
        crit: 1,
        warn: 2,
        ok: 5,
        skip: 1,
        scope_json: '{"topicsSeen":9,"topicsSampled":5}',
        checks_json: '[{"key":"backlog","title":"消息积压","level":"warn","summary":"x"}]',
        thresholds_json: '{"backlogWarn":10000}',
        source: 'manual',
        markdown: '# 报告',
        ...overrides,
    };
}

function openDb() {
    const database = new DatabaseSync(':memory:');
    // 与主进程同一个设置：foreign_keys 默认关着，不打开的话 cluster_id 那条外键就是一行装饰
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(SCHEMA_SQL);
    const insert = database.prepare(
        "INSERT INTO clusters (id, name, service_url, web_service_url, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
    );
    insert.run(CLUSTER_A, '生产簇', 'pulsar://h:6650', 'http://h:8080');
    insert.run(CLUSTER_B, '测试簇', 'pulsar://h:6650', 'http://h:8080');
    return database;
}

/** migrate() 里 v13 那一段的同一套动作：先查表结构，缺列才 ALTER。 */
function migrateSourceColumn(database) {
    const columns = database.prepare('PRAGMA table_info(inspections)').all();
    if (!columns.some(column => column.name === 'source')) {
        database.prepare("ALTER TABLE inspections ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'").run();
        return true;
    }
    return false;
}

check('调度表按基线建出来，列名与顺序和 helper 写的一致', () => {
    const database = openDb();
    const columns = database.prepare('PRAGMA table_info(inspection_schedules)').all().map(column => column.name);
    eq(
        columns.join(','),
        'cluster_id,enabled,interval_minutes,notify_on_crit,last_run_at,last_error,last_notified_crit,updated_at',
        '列清单',
    );
    database.close();
});

check('调度行默认关着、通知开着、严重项计数 0', () => {
    const database = openDb();
    // 打开调度必须是显式动作：默认开着等于装上应用就开始自己打 broker
    database
        .prepare(
            'INSERT INTO inspection_schedules (cluster_id, interval_minutes, updated_at) VALUES (?, ?, ?)',
        )
        .run(CLUSTER_A, 360, '2026-10-17T00:00:00.000Z');
    const row = database.prepare('SELECT * FROM inspection_schedules WHERE cluster_id = ?').get(CLUSTER_A);
    eq(Number(row.enabled), 0, '默认关');
    eq(Number(row.notify_on_crit), 1, '默认通知');
    eq(Number(row.last_notified_crit), 0, '没发过通知');
    eq(row.last_run_at, null, '没跑过');
    eq(row.last_error, null, '没有失败记录');
    database.close();
});

check('间隔没有默认值：漏写就建不出行', () => {
    const database = openDb();
    let rejected = false;
    try {
        database
            .prepare('INSERT INTO inspection_schedules (cluster_id, updated_at) VALUES (?, ?)')
            .run(CLUSTER_A, '2026-10-17T00:00:00.000Z');
    } catch (error) {
        rejected = true;
        assert.ok(/NOT NULL/i.test(String(error.message)), `报的是非空约束：${error.message}`);
    }
    assert.ok(rejected, 'interval_minutes 必须显式给');
    database.close();
});

check('改配置不会把已跑出来的运行状态抹掉', () => {
    const database = openDb();
    database.prepare(UPSERT_SCHEDULE).run(scheduleRow({}));
    database.prepare(MARK_RUN).run({
        ranAt: '2026-10-17T06:00:00.000Z',
        error: null,
        notifiedCrit: 4,
        clusterId: CLUSTER_A,
    });
    // 第二次保存只改间隔：这三格是引擎的运行状态，不该跟着配置的写入回零
    database.prepare(UPSERT_SCHEDULE).run(
        scheduleRow({interval_minutes: 60, updated_at: '2026-10-17T07:00:00.000Z'}),
    );
    const row = database.prepare('SELECT * FROM inspection_schedules WHERE cluster_id = ?').get(CLUSTER_A);
    eq(Number(row.interval_minutes), 60, '间隔改了');
    eq(row.updated_at, '2026-10-17T07:00:00.000Z', '更新时间刷新');
    eq(row.last_run_at, '2026-10-17T06:00:00.000Z', '上次运行时间还在');
    eq(Number(row.last_notified_crit), 4, '上次通知的严重项数还在');
    database.close();
});

check('一簇一行：第二次保存覆盖而不是多出一行', () => {
    const database = openDb();
    const statement = database.prepare(UPSERT_SCHEDULE);
    statement.run(scheduleRow({}));
    statement.run(scheduleRow({enabled: 0, interval_minutes: 30}));
    eq(Number(database.prepare('SELECT COUNT(*) AS c FROM inspection_schedules').get().c), 1, '仍然一行');
    const row = database.prepare('SELECT * FROM inspection_schedules WHERE cluster_id = ?').get(CLUSTER_A);
    eq(Number(row.enabled), 0, '关掉生效');
    eq(Number(row.interval_minutes), 30, '间隔被覆盖');
    database.close();
});

check('一轮 tick 只捞开着的那些，且按集群排', () => {
    const database = openDb();
    database.prepare(UPSERT_SCHEDULE).run(scheduleRow({cluster_id: CLUSTER_B, enabled: 0}));
    database.prepare(UPSERT_SCHEDULE).run(scheduleRow({cluster_id: CLUSTER_A, enabled: 1}));
    const rows = database.prepare(LIST_ENABLED).all();
    eq(rows.length, 1, '只有一行开着');
    eq(rows[0].cluster_id, CLUSTER_A, '就是它');
    // 引擎每 60 秒跑这一条 SELECT：全部集群也就几十行，不建索引是有意的
    const all = database.prepare('SELECT * FROM inspection_schedules ORDER BY cluster_id').all();
    eq(all.length, 2, '配置列表要连关着的一起给');
    eq(all.map(row => row.cluster_id).join(','), `${CLUSTER_A},${CLUSTER_B}`, '顺序稳定');
    database.close();
});

check('跑完一轮的回写：时间与错误总是动，通知计数只在发了通知时动', () => {
    const database = openDb();
    database.prepare(UPSERT_SCHEDULE).run(scheduleRow({}));
    database.prepare(MARK_RUN).run({ranAt: '2026-10-17T06:00:00.000Z', error: null, notifiedCrit: 3, clusterId: CLUSTER_A});
    let row = database.prepare('SELECT * FROM inspection_schedules WHERE cluster_id = ?').get(CLUSTER_A);
    eq(row.last_run_at, '2026-10-17T06:00:00.000Z', '运行时间');
    eq(Number(row.last_notified_crit), 3, '记下这一轮发通知时的严重项数');

    // 这一轮判定没变化（notifiedCrit 传 null）：不能把上一次的计数清掉，
    // 否则下一轮数字又算成「首次出现」，同一条积压会被重复报警
    database.prepare(MARK_RUN).run({ranAt: '2026-10-17T12:00:00.000Z', error: null, notifiedCrit: null, clusterId: CLUSTER_A});
    row = database.prepare('SELECT * FROM inspection_schedules WHERE cluster_id = ?').get(CLUSTER_A);
    eq(row.last_run_at, '2026-10-17T12:00:00.000Z', '运行时间照样推进');
    eq(Number(row.last_notified_crit), 3, '通知计数保持');

    // 失败那轮：错误落库、通知计数仍保持，下轮判定还是接着上次通知的数比
    database.prepare(MARK_RUN).run({ranAt: '2026-10-17T18:00:00.000Z', error: '连接超时', notifiedCrit: null, clusterId: CLUSTER_A});
    row = database.prepare('SELECT * FROM inspection_schedules WHERE cluster_id = ?').get(CLUSTER_A);
    eq(row.last_error, '连接超时', '失败原因看得见');
    eq(row.last_run_at, '2026-10-17T18:00:00.000Z', '失败也推进运行时间，不然一台关着的集群会被每分钟敲一次门');

    // 恢复之后 notifiedCrit 传这次的 0：归零那句发完就该把基准放回 0
    database.prepare(MARK_RUN).run({ranAt: '2026-10-18T00:00:00.000Z', error: null, notifiedCrit: 0, clusterId: CLUSTER_A});
    row = database.prepare('SELECT * FROM inspection_schedules WHERE cluster_id = ?').get(CLUSTER_A);
    eq(row.last_error, null, '成功一轮就把旧的失败清掉');
    eq(Number(row.last_notified_crit), 0, '基准归零');
    database.close();
});

check('回写打在已经不存在的调度行上时什么都不写', () => {
    const database = openDb();
    // 一轮巡检可能跑到一半集群被删：UPDATE 而不是 upsert 就是为了不替不存在的集群复活一行调度
    const result = database.prepare(MARK_RUN).run({
        ranAt: '2026-10-17T06:00:00.000Z',
        error: null,
        notifiedCrit: 1,
        clusterId: '99999999-9999-4999-9999-999999999999',
    });
    eq(Number(result.changes), 0, '改动 0 行');
    eq(Number(database.prepare('SELECT COUNT(*) AS c FROM inspection_schedules').get().c), 0, '没有凭空多出来的行');
    database.close();
});

check('调度配不到一台不存在的集群上', () => {
    const database = openDb();
    let rejected = false;
    try {
        database.prepare(UPSERT_SCHEDULE).run(scheduleRow({cluster_id: '99999999-9999-4999-9999-999999999999'}));
    } catch (error) {
        rejected = true;
        assert.ok(/FOREIGN KEY/i.test(String(error.message)), '报的是外键');
    }
    assert.ok(rejected, 'cluster_id 外键挡住了');
    database.close();
});

check('删集群时调度行跟着消失，别的集群不受影响', () => {
    const database = openDb();
    database.prepare(UPSERT_SCHEDULE).run(scheduleRow({cluster_id: CLUSTER_A}));
    database.prepare(UPSERT_SCHEDULE).run(scheduleRow({cluster_id: CLUSTER_B}));
    database.prepare(INSERT_INSPECTION).run(inspectionRow({cluster_id: CLUSTER_A}));
    database.prepare('DELETE FROM clusters WHERE id = ?').run(CLUSTER_A);
    eq(
        Number(database.prepare('SELECT COUNT(*) AS c FROM inspection_schedules WHERE cluster_id = ?').get(CLUSTER_A).c),
        0,
        '调度级联删除',
    );
    eq(
        Number(database.prepare('SELECT COUNT(*) AS c FROM inspections WHERE cluster_id = ?').get(CLUSTER_A).c),
        0,
        '报告级联删除',
    );
    eq(
        Number(database.prepare('SELECT COUNT(*) AS c FROM inspection_schedules WHERE cluster_id = ?').get(CLUSTER_B).c),
        1,
        '另一台的调度还在',
    );
    database.close();
});

// ---------------------------------------------------------------- 报告来源这一列

check('新写入带 source，历史列表也把它读回来', () => {
    const database = openDb();
    database.prepare(INSERT_INSPECTION).run(inspectionRow({id: 's-1', source: 'scheduled', generated_at: '2026-10-17T06:00:00.000Z'}));
    database.prepare(INSERT_INSPECTION).run(inspectionRow({id: 'm-1', source: 'manual', generated_at: '2026-10-17T07:00:00.000Z'}));
    const rows = database.prepare(LIST_INSPECTION_COLUMNS).all(CLUSTER_A, 50);
    eq(rows.map(row => `${row.id}:${row.source}`).join(','), 'm-1:manual,s-1:scheduled', '倒序且带来源');
    assert.ok(!('markdown' in rows[0]) && !('checks_json' in rows[0]), '列表仍不带大字段');
    database.close();
});

check('不带 source 的老式写入落 manual', () => {
    const database = openDb();
    // v3.1 之前的应用根本不知道有定时这条路，任何没写这一列的行都只能是手点的
    database.prepare(INSERT_INSPECTION_LEGACY).run({
        id: 'legacy-1',
        cluster_id: CLUSTER_A,
        cluster_name: '生产簇',
        version: null,
        generated_at: '2026-10-16T02:00:00.000Z',
        crit: 0,
        warn: 1,
        ok: 6,
        skip: 0,
        scope_json: '{}',
        checks_json: '[]',
        thresholds_json: null,
        markdown: '# 报告',
    });
    const row = database.prepare('SELECT source, thresholds_json FROM inspections WHERE id = ?').get('legacy-1');
    eq(row.source, 'manual', '默认 manual');
    eq(row.thresholds_json, null, '口径依旧可以是空');
    database.close();
});

check('老库补 source 列：已有行读回来是 manual，重复跑这一支不炸', () => {
    // 用真实基线 DDL 抠掉 source 那一行造出 v13 之前的表结构，
    // 而不是在测试里重抄一份老 DDL——基线改了这份抄本会跟着报错提醒
    const pattern = /[ \t]*source TEXT NOT NULL DEFAULT 'manual',\r?\n/;
    const preV13 = SCHEMA_SQL.replace(pattern, '');
    assert.ok(preV13 !== SCHEMA_SQL, '基线 DDL 里找不到 source 那一行，这份抄本该更新了');

    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(preV13);
    database
        .prepare(
            "INSERT INTO clusters (id, name, service_url, web_service_url, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
        )
        .run(CLUSTER_A, '生产簇', 'pulsar://h:6650', 'http://h:8080');
    const before = database.prepare('PRAGMA table_info(inspections)').all().map(column => column.name);
    assert.ok(!before.includes('source'), '模拟的是升级前的表结构');

    eq(migrateSourceColumn(database), true, '第一次跑要 ALTER');
    const columns = database.prepare('PRAGMA table_info(inspections)').all().map(column => column.name);
    eq(columns[columns.length - 1], 'source', '补在最后一列，markdown 之前就存在的那些不动');

    // 升级前存的那一份报告，升级之后必须还能按老语句读出来
    database.prepare(INSERT_INSPECTION_LEGACY).run({
        id: 'old-1',
        cluster_id: CLUSTER_A,
        cluster_name: '生产簇',
        version: '3.0.0',
        generated_at: '2026-10-15T02:00:00.000Z',
        crit: 0,
        warn: 0,
        ok: 9,
        skip: 0,
        scope_json: '{}',
        checks_json: '[]',
        thresholds_json: null,
        markdown: '# 旧报告',
    });
    const rows = database.prepare(LIST_INSPECTION_COLUMNS).all(CLUSTER_A, 50);
    eq(rows[0].source, 'manual', '升级前那份算手动');

    // 基线 DDL 每次启动都重跑，这一支也必须能被重复执行
    eq(migrateSourceColumn(database), false, '第二次不再 ALTER');
    eq(Number(database.prepare('SELECT COUNT(*) AS c FROM inspections').get().c), 1, '已有报告一份没丢');
    database.close();
});

check('升级前的表结构里根本没有调度表：靠基线 DDL 补出来就能用', () => {
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(SCHEMA_SQL.replace(/CREATE TABLE IF NOT EXISTS inspection_schedules[\s\S]*?\);/, ''));
    eq(
        database.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='inspection_schedules'").get().c,
        0,
        '模拟的是升级前：这张表不存在',
    );
    // migrate() 里每次启动都重跑的基线，跑第二次就把这张表建出来
    database.exec(SCHEMA_SQL);
    eq(
        database.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='inspection_schedules'").get().c,
        1,
        '基线重跑把表补上了',
    );
    database
        .prepare(
            "INSERT INTO clusters (id, name, service_url, web_service_url, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
        )
        .run(CLUSTER_A, '生产簇', 'pulsar://h:6650', 'http://h:8080');
    database.prepare(UPSERT_SCHEDULE).run(scheduleRow({}));
    eq(Number(database.prepare(LIST_ENABLED).all().length), 1, '老库升级后定时这条路立刻可写');
    database.close();
});

if (!failures.length) {
    console.log(`ALL PASS（${passed} 项）`);
} else {
    console.log(`失败 ${failures.length} 项 / 通过 ${passed} 项：`);
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
}
console.log(`定时巡检自测通过 ${passed} 项：间隔校验、到期判定、通知去重、调度落库与报告来源列`);
