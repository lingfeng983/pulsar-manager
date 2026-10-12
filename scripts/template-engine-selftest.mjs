#!/usr/bin/env node
// 模板占位符引擎的自测。跑法：node scripts/template-engine-selftest.mjs
// 单独一个脚本而不是接进某个测试框架：仓库没有测试框架，而这套用例要钉的是
// 「预览与实发同源」这件事——渲染层与主进程 import 的是同一份 template-engine.ts，
// 只要这里全绿，两边对同一段模板、同一个 seed 的输出必然逐字节一致。
//
// Node 直接 import .ts 靠的是内置的类型剥离（要求模块内无 enum/namespace 等
// 需要转写的语法），src/shared/ 正好满足。跑起来会有一句
// MODULE_TYPELESS_PACKAGE_JSON 警告：package.json 的 type 不能设成 module，
// 主进程的产物是按 CommonJS 编译的，警告本身无害。

import assert from 'node:assert/strict';
import {
    DEFAULT_MAX_BYTES,
    KNOWN_FUNCTIONS,
    referencedVariables,
    resolveTemplate,
    validateTemplate,
} from '../src/shared/template-engine.ts';

let passed = 0;
const failures = [];

function check(name, run) {
    try {
        run();
        passed += 1;
    } catch (error) {
        failures.push(`${name}：${error instanceof Error ? error.message : String(error)}`);
    }
}

function resolve(body, variables = [], options = {}) {
    const result = resolveTemplate(body, variables, options);
    assert.equal(result.ok, true, `解析失败：${result.error}`);
    return JSON.parse(result.text);
}

// ---------- 类型保持 ----------

check('整值占位符替换整个值，类型随函数结果', () => {
    const out = resolve('{"n":"${int(1,50)}","f":"${float(1,9,2)}","b":"${bool()}","s":"${string(6)}"}');
    assert.equal(typeof out.n, 'number');
    assert.equal(typeof out.f, 'number');
    assert.equal(typeof out.b, 'boolean');
    assert.equal(typeof out.s, 'string');
    assert.equal(out.s.length, 6);
});

check('字符串里插值结果是字符串（哪怕只有一段）', () => {
    const out = resolve('{"sku":"SKU${int(100,999)}"}');
    assert.equal(typeof out.sku, 'string');
    assert.match(out.sku, /^SKU\d{3}$/);
});

check('键名不支持占位符：键原样保留', () => {
    const out = resolve('{"${int(1,2)}":"v"}');
    assert.deepEqual(Object.keys(out), ['${int(1,2)}']);
});

check('非字符串的 JSON 值一律原样透传', () => {
    const out = resolve('{"n":12,"b":true,"z":null,"arr":[1,"x"]}');
    assert.deepEqual(out, {n: 12, b: true, z: null, arr: [1, 'x']});
});

// ---------- 具名变量 ----------

check('具名变量每条消息只解析一次，多处引用同值', () => {
    const body = '{"a":"${order}","b":"${order}","c":"前缀${order}后缀"}';
    const out = resolve(body, [{name: 'order', expr: '${uuid()}'}]);
    assert.equal(out.a, out.b);
    assert.equal(out.c, `前缀${out.a}后缀`);
});

check('后面的变量可以引用前面已解析的值', () => {
    const out = resolve('{"u":"${user}"}', [
        {name: 'seqNo', expr: '${seq(1000,1)}'},
        {name: 'user', expr: 'user${seqNo}'},
    ]);
    assert.equal(out.u, 'user1000');
});

check('具名变量整体引用时保留数字类型', () => {
    const out = resolve('{"age":"${age}"}', [{name: 'age', expr: '${int(18,60)}'}]);
    assert.equal(typeof out.age, 'number');
});

check('未定义的具名变量：解析与校验都报错', () => {
    const failure = resolveTemplate('{"a":"${nope}"}', []);
    assert.equal(failure.ok, false);
    assert.match(failure.error, /未定义的具名变量/);
    const invalid = validateTemplate('{"a":"${nope}"}', []);
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /未定义变量/);
});

// ---------- $each ----------

check('$each 按 count 展开，index() 每项独立且从 1 起', () => {
    const out = resolve('{"items":{"$each":{"count":3,"of":{"i":"${index()}","sku":"SKU${int(100,999)}"}}}}');
    assert.equal(out.items.length, 3);
    assert.deepEqual(
        out.items.map(item => item.i),
        [1, 2, 3],
    );
    out.items.forEach(item => assert.match(item.sku, /^SKU\d{3}$/));
});

check('$each 的 count 可以来自函数调用', () => {
    const out = resolve('{"items":{"$each":{"count":"${int(2,2)}","of":{"i":"${index()}"}}}}');
    assert.equal(out.items.length, 2);
});

check('$each 的 count 解析不出整数时报错而不是悄悄取整', () => {
    const failure = resolveTemplate('{"items":{"$each":{"count":"${float(1,3)}","of":{"i":1}}}}', []);
    assert.equal(failure.ok, false);
    assert.match(failure.error, /count/);
});

check('index() 在 $each 之外使用要报错', () => {
    const failure = resolveTemplate('{"i":"${index()}"}', []);
    assert.equal(failure.ok, false);
    assert.match(failure.error, /\$each/);
});

// ---------- 可复现性（预览即所发的根据）----------

check('同一 seed 两次解析逐字节一致', () => {
    const body = '{"a":"${int(1,100000)}","b":"${choice(x|y|z)}","c":"${uuid()}"}';
    const one = resolveTemplate(body, [], {seed: 20261011});
    const two = resolveTemplate(body, [], {seed: 20261011});
    assert.equal(one.ok, true);
    assert.equal(two.ok, true);
    assert.equal(one.text, two.text);
});

check('不同 seed 的输出会变', () => {
    const body = '{"a":"${int(1,100000000)}"}';
    const one = resolveTemplate(body, [], {seed: 1}).text;
    const two = resolveTemplate(body, [], {seed: 2}).text;
    assert.notEqual(one, two);
});

check('不带 seed 时同样字段每次重新随机', () => {
    const body = '{"a":"${int(1,100000000)}"}';
    const seen = new Set();
    for (let i = 0; i < 20; i += 1) {
        seen.add(resolveTemplate(body, [], {}).text);
    }
    assert.ok(seen.size > 15, `20 次只得到 ${seen.size} 个不同结果`);
});

// ---------- 函数取值范围 ----------

check('int 落在闭区间内，且确实会变', () => {
    const values = new Set();
    for (let i = 0; i < 400; i += 1) {
        const v = resolve('{"v":"${int(7,41)}"}').v;
        assert.ok(Number.isInteger(v) && v >= 7 && v <= 41, `越界：${v}`);
        values.add(v);
    }
    assert.ok(values.size > 20);
});

check('int 的上下限写反要报错', () => {
    const failure = resolveTemplate('{"v":"${int(50,1)}"}', []);
    assert.equal(failure.ok, false);
    assert.match(failure.error, /范围反了/);
});

check('float 不超过指定小数位且在区间内', () => {
    for (let i = 0; i < 200; i += 1) {
        const v = resolve('{"v":"${float(1,999,3)}"}').v;
        assert.ok(v >= 1 && v <= 999);
        assert.ok(String(v).split('.')[1]?.length <= 3, `小数位超了：${v}`);
    }
});

check('choice 只从候选里取，候选可含数字并转成数字', () => {
    const words = new Set(['pending', 'paid', 'shipped', 'closed']);
    const picks = new Set();
    for (let i = 0; i < 200; i += 1) {
        const v = resolve('{"v":"${choice(pending|paid|shipped|closed)}"}').v;
        assert.ok(words.has(v), `候选外的值：${v}`);
        picks.add(v);
    }
    assert.equal(picks.size, 4);
    for (let i = 0; i < 50; i += 1) {
        const v = resolve('{"v":"${choice(1|2|3)}"}').v;
        assert.equal(typeof v, 'number', `数字候选应当转成数字：${JSON.stringify(v)}`);
        assert.ok([1, 2, 3].includes(v));
    }
});

check('choice 候选不足两个要报错', () => {
    const failure = resolveTemplate('{"v":"${choice(only)}"}', []);
    assert.equal(failure.ok, false);
    assert.match(failure.error, /至少要两个候选/);
});

check('seq 随消息序号自增（跨消息计数）', () => {
    const values = [0, 1, 2].map(index => resolve('{"v":"${seq(100,5)}"}', [], {messageIndex: index}).v);
    assert.deepEqual(values, [100, 105, 110]);
});

check('uuid 形状正确', () => {
    const v = resolve('{"v":"${uuid()}"}').v;
    assert.match(v, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

check('now 按给定格式与时钟输出', () => {
    const v = resolve('{"v":"${now(YYYY-MM-DD HH:mm:ss)}"}', [], {now: Date.UTC(2026, 9, 11, 3, 4, 5)}).v;
    assert.match(v, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // 偏移与格式 token 都要生效
    const offset = resolve('{"v":"${now(YYYYMMDD,86400000)}"}', [], {now: Date.UTC(2026, 9, 11, 0, 0, 0)}).v;
    assert.match(offset, /^\d{8}$/);
});

check('date 落在给定区间内', () => {
    for (let i = 0; i < 100; i += 1) {
        const v = resolve('{"v":"${date(2020-01-01,2020-12-31)}"}').v;
        assert.match(v, /^2020-\d{2}-\d{2}$/);
    }
    const bad = resolveTemplate('{"v":"${date(2020-12-31,2020-01-01)}"}', []);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /区间无效/);
});

check('timestamp 支持毫秒与秒两档', () => {
    const fixed = {now: 1_700_000_000_123};
    assert.equal(resolve('{"v":"${timestamp()}"}', [], fixed).v, 1_700_000_000_123);
    assert.equal(resolve('{"v":"${timestamp(s)}"}', [], fixed).v, 1_700_000_000);
});

check('未知函数在解析与校验里都报错，并报出可用清单', () => {
    const failure = resolveTemplate('{"v":"${nope(1)}"}', []);
    assert.equal(failure.ok, false);
    assert.match(failure.error, new RegExp(KNOWN_FUNCTIONS.join('/')));
    assert.equal(validateTemplate('{"v":"${nope(1)}"}', []).ok, false);
});

// ---------- 体积闸门 ----------

check('$each 撑过单条上限时报错而不是产超大载荷', () => {
    const body = '{"items":{"$each":{"count":9000,"of":{"pad":"${string(700)}"}}}}';
    const failure = resolveTemplate(body, []);
    assert.equal(failure.ok, false, '应当拦下超大报文');
    assert.match(failure.error, /上限/);
    assert.ok(DEFAULT_MAX_BYTES === 5 * 1024 * 1024);
});

check('没超限时报出真实字节数', () => {
    const result = resolveTemplate('{"v":"${string(64)}"}', []);
    assert.equal(result.ok, true);
    assert.ok(result.bytes > 64 && result.bytes < 200, `字节数异常：${result.bytes}`);
});

// ---------- 编辑期校验 / 引用收集 ----------

check('合法模板校验通过，且校验不消耗随机', () => {
    const body = '{"a":"${int(1,9)}","b":"${region}"}';
    const variables = [{name: 'region', expr: '${choice(cn|us)}'}];
    assert.equal(validateTemplate(body, variables).ok, true);
    assert.equal(validateTemplate(body, variables).ok, true);
});

check('校验能指出坏掉的 $each 写法', () => {
    const invalid = validateTemplate('{"items":{"$each":{"of":{"i":1}}}}', []);
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /\$each/);
});

check('校验拦下 JSON 语法错误', () => {
    assert.equal(validateTemplate('{"a": }', []).ok, false);
});

check('referencedVariables 收正文字面引用，不含函数与变量表达式自身', () => {
    const body = '{"a":"${region}","b":"${int(1,9)}","c":"${region}"}';
    assert.deepEqual(referencedVariables(body), ['region']);
});

check('坏 JSON 不抛异常：referencedVariables 回空、resolve 回错误文本', () => {
    assert.deepEqual(referencedVariables('{'), []);
    const failure = resolveTemplate('{', []);
    assert.equal(failure.ok, false);
    assert.match(failure.error, /JSON/);
});

// ---------- 汇总 ----------

if (failures.length > 0) {
    console.error(`模板引擎自测失败 ${failures.length} 项（通过 ${passed} 项）：`);
    failures.forEach(item => console.error(' - ' + item));
    process.exit(1);
}
console.log(`模板引擎自测通过：${passed} 项`);
