/**
 * 文档中心自测：锚点规则、目录抽取与跨篇检索。
 *
 * 这一批最有价值的断言不来自假数据，而是拿仓库里真实的 8 篇文档跑：
 * 「文档里手写的目录链接必须能落到某个标题上」这条，只有对真内容跑一遍才证得了伪。
 * 渲染那半边（marked + DOMPurify）要浏览器环境，这里覆盖不到，如实披露。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const K = require('../dist/src/shared/doc-kb.js');

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
    assert.strictEqual(actual, expected, `${label || ''} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function deepEq(actual, expected, label) {
    assert.deepStrictEqual(actual, expected, `${label || ''} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

const SAMPLE = `# 生产环境 Broker/Bookie 参数模板

> 适用 Apache Pulsar 3.x。所有值需按实际环境微调。
> 每段注释给出「作用 / 影响 / 建议值」。

## 目录

- [1. Broker — conf/broker.conf](#1-broker--confbrokerconf)

## 1. Broker — conf/broker.conf

### 1.1 基础连接

\`\`\`properties
# 这一行是 conf 文件里的注释，不是标题
clusterName=pulsar-cluster-1
\`\`\`

普通段落，提到 managedLedgerDefaultEnsembleSize 与积压。

## 1. Broker — conf/broker.conf

重名小节，用来验证 slug 加后缀。
`;

/** 真实文档目录：与页面里 import.meta.glob('docs/pulsar/0*.md') 同一套选取口径。 */
function realDocs() {
    const dir = path.join(__dirname, '..', 'docs', 'pulsar');
    return fs
        .readdirSync(dir)
        .filter(file => /^0[^/]*\.md$/.test(file))
        .sort()
        .map(file => {
            const markdown = fs.readFileSync(path.join(dir, file), 'utf8');
            return {key: file.replace(/\.md$/, ''), file, markdown, meta: K.parseDocMeta(markdown)};
        });
}

check('slug：中文与英文混排、点号与斜杠丢弃、空格逐个换成连字符', () => {
    eq(K.headingSlug('1. 消息模型'), '1-消息模型', '小节标题');
    eq(K.headingSlug('1. broker.conf'), '1-brokerconf', '文件名里的点被丢掉');
    eq(
        K.headingSlug('3. 计算/IO（Pulsar Functions / IO / Connectors）'),
        '3-计算iopulsar-functions--io--connectors',
        '「 / 」留下两个空格，必须生成两个连字符',
    );
    eq(
        K.headingSlug('2. Broker — conf/pulsar_env.sh（JVM）'),
        '2-broker--confpulsar_envshjvm',
        '长破折号被删、「 / 」两侧各留一个空格',
    );
});

check('slug：下划线是文件名的一部分，不能被当成强调符号吃掉', () => {
    eq(K.headingSlug('9. JVM（conf/pulsar_env.sh）'), '9-jvmconfpulsar_envsh', '保留 pulsar_env 里的下划线');
    assert.ok(!K.headingSlug('a_b_c').includes('-'), '下划线之间不该被拆成多个词');
});

check('slug：成对强调与链接取文字，图片整段丢弃', () => {
    eq(K.headingSlug('**加粗** 标题 *斜体*'), '加粗-标题-斜体', '强调符号');
    eq(K.headingSlug('[Pulsar 官网](https://pulsar.apache.org) 介绍'), 'pulsar-官网-介绍', '链接取文字');
    eq(K.headingSlug('![](a.png) 图注'), '图注', '图片不留痕迹');
});

check('slug：只认字母数字与 - _ ，其余标点一律先删', () => {
    eq(K.headingSlug('4. 生产防护建议（Checklist）'), '4-生产防护建议checklist', '全角括号');
    eq(K.headingSlug('Q: 为什么?'), 'q-为什么', '半角冒号与问号');
});

check('标题行：闭合的 # 与前置空格都不影响文字', () => {
    const sections = K.splitSections('   ## 标题收尾 ##\n正文\n');
    eq(sections[0].heading.text, '标题收尾', '去掉尾部 #');
    eq(sections[0].heading.slug, '标题收尾', '锚点取干净文字');
});

check('代码块里的 # 不是标题', () => {
    const sections = K.splitSections(SAMPLE);
    const headings = sections.filter(section => section.heading).map(section => section.heading.text);
    assert.ok(!headings.includes('这一行是 conf 文件里的注释，不是标题'), 'conf 注释被当成了标题');
    deepEq(headings, [
        '生产环境 Broker/Bookie 参数模板',
        '目录',
        '1. Broker — conf/broker.conf',
        '1.1 基础连接',
        '1. Broker — conf/broker.conf',
    ]);
});

check('波浪号围栏同样屏蔽标题', () => {
    const sections = K.splitSections('# A\n~~~\n## 不是标题\n~~~\n## 是标题\n');
    const list = sections.filter(section => section.heading).map(section => section.heading.text);
    deepEq(list, ['A', '是标题']);
});

check('同一篇里 fence 未闭合时，后面的标题仍按正文处理', () => {
    const sections = K.splitSections('# A\n```\n## 还在代码块里\n');
    deepEq(
        sections.filter(section => section.heading).map(section => section.heading.text),
        ['A'],
        '未闭合围栏把后文都吃进去是 markdown 的既有口径',
    );
});

check('parseDocMeta：篇名取首个 H1，摘要取引用块首行', () => {
    const meta = K.parseDocMeta(SAMPLE);
    eq(meta.title, '生产环境 Broker/Bookie 参数模板', '篇名');
    eq(meta.summary, '适用 Apache Pulsar 3.x。所有值需按实际环境微调。', '摘要只要第一行');
});

check('parseDocMeta：同名标题的 slug 依次加 -1 后缀', () => {
    const meta = K.parseDocMeta(SAMPLE);
    const repeated = meta.headings.filter(heading => heading.text === '1. Broker — conf/broker.conf');
    eq(repeated.length, 2, '两个同名标题');
    assert.ok(
        repeated[1].slug !== repeated[0].slug && repeated[1].slug === `${repeated[0].slug}-1`,
        `第二个应带 -1 后缀，实际 ${repeated[0].slug} / ${repeated[1].slug}`,
    );
    eq(new Set(meta.headings.map(heading => heading.slug)).size, meta.headings.length, '整表 slug 唯一');
});

check('parseDocMeta：没有 H1 时给出可读的兜底篇名而不是空串', () => {
    eq(K.parseDocMeta('## 只有一级以下的标题\n正文\n').title, '未命名文档', '兜底');
});

check('tokenizeQuery：拉丁按词、中文按 2-gram 展开', () => {
    deepEq(K.tokenizeQuery('managedLedger'), ['managedledger'], '拉丁串整体作为一个小写词');
    const grams = K.tokenizeQuery('积压');
    assert.ok(grams.includes('积压'), '两字词原样保留');
    const long = K.tokenizeQuery('消息丢失');
    deepEq(long.filter(t => /[\u4e00-\u9fa5]/.test(t)), ['消息', '息丢', '丢失', '消息丢失'], '三字以上切 2-gram 并带上整串');
    deepEq(K.tokenizeQuery('   '), [], '空白没有检索词');
});

check('searchDocs：标题命中排在正文命中前面', () => {
    const docs = [
        {key: 'a', title: 'A 篇', markdown: '# A 篇\n\n## 积压与告警\n\n这一节讲积压。\n'},
        {key: 'b', title: 'B 篇', markdown: '# B 篇\n\n## 其他\n\n正文里提到了积压两次：积压、积压。\n'},
    ];
    const hits = K.searchDocs(docs, '积压');
    assert.ok(hits.length >= 2, '两篇都该有命中');
    eq(hits[0].docKey, 'a', '标题里就有「积压」的那篇在前');
    eq(hits[0].slug, '积压与告警', '命中带回可跳转的锚点');
});

check('searchDocs：全部词命中优先于部分命中', () => {
    const docs = [{key: 'a', title: 'A 篇', markdown: '# A 篇\n\n## 队列\n\n只讲队列。\n\n## 队列与积压\n\n队列与积压都在。\n'}];
    const hits = K.searchDocs(docs, '队列 积压');
    eq(hits[0].heading, '队列与积压', '两个词都在的那节排第一');
});

check('searchDocs：空查询不给结果而不是全文', () => {
    deepEq(K.searchDocs([{key: 'a', title: 'A 篇', markdown: '# A 篇\n内容\n'}], '  '), []);
});

check('searchDocs：命中数上限 40，防止一个常用词刷屏', () => {
    const body = Array.from({length: 60}, (unused, index) => `## 第${index}节\n\n这里讲积压。\n`).join('\n');
    const hits = K.searchDocs([{key: 'a', title: 'A 篇', markdown: `# A 篇\n${body}`}], '积压');
    eq(hits.length, 40, '截断到 40 条');
});

check('resolveAnchor：精确命中优先，唯一前缀才归位，多义就放弃', () => {
    const slugs = ['2-高危可靠性-bug非-cve重灾区消息丢失卡死', '3-版本现状与升级建议截至-2026-10', '4-生产防护建议'];
    eq(K.resolveAnchor('#4-生产防护建议', slugs), '4-生产防护建议', '本来就对');
    eq(K.resolveAnchor('#3-版本现状与升级建议', slugs), '3-版本现状与升级建议截至-2026-10', '目录只写了前半段');
    eq(K.resolveAnchor('#1', slugs), '', '没有任何 slug 以它开头');
    eq(K.resolveAnchor('', slugs), '', '空 href 不跳');
    eq(K.resolveAnchor('#x', ['x-a', 'x-b']), '', '两个候选时宁可不跳');
});

check('buildSnippet：给命中所在的那一行，而不是整个段落', () => {
    const text = '第一行\n第二行里有 managedLedger 这个参数\n第三行';
    eq(K.buildSnippet(text, ['managedledger']), '第二行里有 managedLedger 这个参数', '按行取，且保留原文大小写');
});

check('buildSnippet：长行从命中处向两侧裁，并补省略号', () => {
    const long = `${'前'.repeat(200)}关键词${'后'.repeat(200)}`;
    const snippet = K.buildSnippet(long, ['关键词']);
    assert.ok(snippet.includes('关键词'), '裁完仍要包含命中处');
    assert.ok(snippet.length <= 121, `片段不该超过 120 字，实际 ${snippet.length}`);
});

const REAL = realDocs();

check('真实文档：8 篇都在，内部设计稿不被选中', () => {
    eq(REAL.length, 8, 'docs/pulsar/0*.md 的篇数');
    const names = REAL.map(doc => doc.file);
    assert.ok(!names.includes('DATA_SOURCES.md'), '内部数据源说明不该进应用');
    assert.ok(!names.some(name => name.includes('设计')), '设计稿不该进应用');
    names.forEach((name, index) => eq(name[1], String(index + 1), '按 01..08 顺序排列'));
});

check('真实文档：每篇都有非空摘要与目录，且 slug 不重复', () => {
    for (const doc of REAL) {
        assert.ok(doc.meta.title.length > 0, `${doc.file} 没有篇名`);
        assert.ok(doc.meta.summary.length > 0, `${doc.file} 没有摘要`);
        assert.ok(doc.meta.headings.length > 3, `${doc.file} 目录只有 ${doc.meta.headings.length} 项`);
        const slugs = doc.meta.headings.map(heading => heading.slug);
        eq(new Set(slugs).size, slugs.length, `${doc.file} 的 slug 有重复`);
    }
});

check('真实文档：配置模板那篇不会被 conf 注释灌满标题', () => {
    const template = REAL.find(doc => doc.file.startsWith('07'));
    assert.ok(template, '没找到 07');
    // 全文有 47 行以 # 开头，其中 22 行是真的 ATX 标题，其余都是 conf 注释。
    eq(template.meta.headings.length, 22, '标题数');
    assert.ok(
        !template.meta.headings.some(heading => heading.text.includes('【改】')),
        '参数注释被当成了标题',
    );
});

check('真实文档：正文里每一条手写目录链接都能落到标题上', () => {
    let total = 0;
    for (const doc of REAL) {
        const slugs = doc.meta.headings.map(heading => heading.slug);
        const links = Array.from(doc.markdown.matchAll(/\]\(#([^)]+)\)/g), match => match[1]);
        total += links.length;
        for (const link of links) {
            const resolved = K.resolveAnchor(`#${link}`, slugs);
            assert.ok(resolved, `${doc.file} 的目录链接 #${link} 找不到对应标题`);
        }
    }
    assert.ok(total >= 60, `目录链接只有 ${total} 条被检查，样本可能选错了`);
});

check('真实文档：常用检索词能命中对应那一篇', () => {
    const targets = REAL.map(doc => ({key: doc.key, title: doc.meta.title, markdown: doc.markdown}));
    const cases = [
        ['managedLedgerDefaultEnsembleSize', '07'],
        ['broker.conf', '03'],
        ['CVE', '08'],
        ['订阅模式', '01'],
    ];
    for (const [term, prefix] of cases) {
        const hits = K.searchDocs(targets, term);
        assert.ok(hits.length > 0, `「${term}」没有任何命中`);
        assert.ok(
            hits.some(hit => hit.docKey.startsWith(prefix)),
            `「${term}」最好的结果里不含 ${prefix} 篇，首条是 ${hits[0].docKey}`,
        );
    }
});

console.log(`ALL PASS（${passed} 项）`);
if (failures.length) {
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
}
