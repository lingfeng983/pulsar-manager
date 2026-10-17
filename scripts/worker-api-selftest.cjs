// worker-api 的路径与折叠自测：本机没有可对照的 Function Worker，
// 「哪个端点用什么动词、状态字段摊在哪一层」这类事情只能靠这份假路由钉住——
// 它已经在写下时抓出一个把整个列表读成空的错（把 axios 响应体当名字数组）。
// 跑法：npm run selftest:worker（先编译主进程，再跑这一份）。
const {WorkerAPI, WorkerUnavailableError} = require('../dist/src/main/services/worker-api.js');
const {Semaphore, NotFoundError} = require('../dist/src/main/services/http-client.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {PassThrough} = require('node:stream');

let failures = 0;
function check(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`ok   ${name}`))
        .catch(error => {
            failures += 1;
            console.log(`FAIL ${name}: ${error.message}`);
        });
}

function assert(cond, message) {
    if (!cond) {
        throw new Error(message);
    }
}

// 抽干一个（惰性）可读流并拼成字符串：只看分段头不足以证明字节真的在请求体里。
function collect(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const sink = new PassThrough();
        sink.on('data', chunk => chunks.push(chunk));
        sink.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
        sink.on('error', reject);
        stream.on('error', reject);
        stream.pipe(sink);
    });
}

// routes: url -> {data} 或 {error}；同时记录所有调用供断言。
// 只做精确匹配：路由表里没写全就是没写全，前缀兜底会把「这条 URL 根本不该出现」
// 伪装成一次正常响应（假路由最容易自己骗自己）。
function fakeHttp(routes) {
    const calls = [];
    const find = url => routes[url];
    const act = (method, url, body, config) => {
        calls.push({method, url, body, config});
        const route = find(url);
        if (!route) {
            return Promise.reject(new NotFoundError(url));
        }
        if (route.error) {
            return Promise.reject(route.error);
        }
        return Promise.resolve({data: route.data});
    };
    return {
        calls,
        get: (url, config) => act('get', url, undefined, config),
        post: (url, body, config) => act('post', url, body, config),
        delete: url => act('delete', url),
    };
}

function apiWith(routes) {
    const http = fakeHttp(routes);
    return {api: new WorkerAPI(http, new Semaphore(5)), http};
}

const NESTED_STATUS = {
    numInstances: 2,
    instances: {
        'public-default-x-1': {instanceId: 1, status: {running: false, error: 'boom', numRestarts: 3, workerId: 'w2'}},
        'public-default-x-0': {instanceId: 0, status: {running: true, numRestarts: 0, workerId: 'w1'}},
    },
};

const FLAT_STATUS = {
    numInstances: 1,
    instances: {'public-default-y-0': {instanceId: 0, running: false, error: null, workerId: 'w1'}},
};

const ROUTES = {
    '/admin/v2/worker/cluster': {data: [{workerId: 'w1', workerHostname: 'h1', port: 6650}]},
    '/admin/v3/functions/public/default': {data: ['x', 'y', 'z']},
    '/admin/v3/functions/public/default/x': {
        data: {
            className: 'org.apache.pulsar.functions.builtins.FilterFunction',
            jar: 'function://builtin-filter',
            inputs: ['persistent://public/default/in'],
            output: 'persistent://public/default/out',
            parallelism: 2,
            processingGuarantees: 'ATLEAST_ONCE',
            // broker 的 resources 用字节：1 核 / 2GB / 10GB
            resources: {cpu: 2, ram: 2147483648, disk: 10737418240},
        },
    },
    '/admin/v3/functions/public/default/x/status': {data: NESTED_STATUS},
    '/admin/v3/functions/public/default/x/stats': {
        data: {receivedTotalCount: 10, processedTotalCount: 9, successfullyProcessedTotalCount: 8, unsuccessfullyProcessedTotalCount: 1, emittedToSinkTotalCount: 7, exceptionsTotalCount: 4},
    },
    '/admin/v3/functions/public/default/y': {data: {className: 'SomeFn'}},
    '/admin/v3/functions/public/default/y/status': {data: FLAT_STATUS},
    // z 的详情整个取不到：这一行只剩名字，但列表必须照常出来
    '/admin/v3/sinks/public/default': {data: ['jdbc']},
    '/admin/v3/sinks/public/default/jdbc': {
        data: {
            className: 'org.apache.pulsar.io.jdbc.JdbcSink',
            archive: 'builtin://jdbc-connector',
            resources: {cpu: 1, ram: 1073741824, disk: 10485760},
        },
    },
    '/admin/v3/sinks/public/default/jdbc/status': {data: NESTED_STATUS},
    '/admin/v3/sources/public/default': {data: ['kafka']},
    // 来源的产出字段叫 topicName，与函数的 output 不是一个键
    '/admin/v3/sources/public/default/kafka': {
        data: {className: 'io.example.KafkaSource', archive: 'builtin://kafka', topicName: 'persistent://public/default/out'},
    },
    '/admin/v3/sources/public/default/kafka/status': {data: FLAT_STATUS},
    '/admin/v3/functions/builtins': {data: [{name: 'filter', className: 'org.apache.pulsar.functions.builtins.FilterFunction'}]},
    '/admin/v3/sinks/builtinsinks': {data: [{name: 'jdbc', className: 'org.apache.pulsar.io.jdbc.JdbcSink', type: 'sink'}]},
    '/admin/v3/sinks/builtinsinks/jdbc/configdefinition': {data: {name: 'jdbc', description: 'JDBC sink'}},
    // 写操作的落点：假路由只认这里列出来的 URL，多打一个就是失败
    '/admin/v3/functions/public/default/x/stop': {data: ''},
    '/admin/v3/functions/public/default/x/1/restart': {data: ''},
    '/admin/v3/functions/public/default/newfn': {data: 'created-function'},
    '/admin/v3/sinks/public/default/newsink': {data: 'created-sink'},
    '/admin/v3/functions/public/default/pyfn': {data: 'py-created'},
    '/admin/v3/functions/public/default/localfn': {data: ''},
};

(async () => {
    await check('worker 未启用时给出翻译过的说明而不是裸 404', async () => {
        const {api} = apiWith({'/admin/v2/worker/cluster': {error: new NotFoundError('/admin/v2/worker/cluster')}});
        const state = await api.getWorkerState(true);
        assert(state.enabled === false, 'enabled 应为 false');
        assert(/Function Worker/.test(state.notice || ''), `notice 不对: ${state.notice}`);
        let thrown;
        try {
            await api.listItems('function', 'public', 'default');
        } catch (error) {
            thrown = error;
        }
        assert(thrown instanceof WorkerUnavailableError, `列表应抛 WorkerUnavailableError，实际 ${thrown && thrown.name}: ${thrown && thrown.message}`);
        assert(/functionWorkerEnabled/.test(thrown.message), '错误正文要说清怎么启用');
    });

    await check('worker 节点列表被折叠', async () => {
        const {api} = apiWith(ROUTES);
        const state = await api.getWorkerState(true);
        assert(state.enabled && state.nodes.length === 1 && state.nodes[0].workerId === 'w1', '节点折叠错了');
    });

    await check('函数列表：嵌套状态、扁平状态与取不到详情的行', async () => {
        const {api} = apiWith(ROUTES);
        const items = await api.listItems('function', 'public', 'default');
        assert(items.length === 3, `应有 3 行，实际 ${items.length}`);
        const byName = new Map(items.map(item => [item.config.name, item]));

        const x = byName.get('x');
        assert(x.config.className === 'org.apache.pulsar.functions.builtins.FilterFunction', '类名没折出来');
        assert(x.config.archive === 'function://builtin-filter', 'jar 应折成 archive');
        assert(x.config.runtime === 'JAVA', `runtime 应由 jar 反推：${x.config.runtime}`);
        // 字节 → MB：2147483648 = 2048MB
        assert(x.config.cpu === 2 && x.config.ramMb === 2048 && x.config.diskMb === 10240, 'resources 折错');
        assert(x.config.processingGuarantee === 'ATLEAST_ONCE', '投递保证折错');
        assert(x.status.running === 1 && x.status.error === 1 && x.status.numInstances === 2, '嵌套状态折错');
        assert(x.status.instances[0].instanceId === 0, `实例应按 id 升序，第一个是 ${x.status.instances[0].instanceId}`);
        assert(x.stats.received === 10 && x.stats.emitted === 7 && x.stats.exceptions === 4, `统计折错: ${JSON.stringify(x.stats)}`);

        const y = byName.get('y');
        assert(y.status.running === 0 && y.status.stopped === 1, '扁平状态（running:false）应算已停止而不是未知');
        assert(y.stats === undefined, '这个端点在假路由里没有，不该出现 stats');

        const z = byName.get('z');
        assert(Object.keys(z.config.raw).length === 0 && !z.status, '详情取不到的行应退化成只剩名字');
    });

    await check('连接器不请求 /stats，包字段按 archive 折、资源按字节折', async () => {
        const {api, http} = apiWith(ROUTES);
        const items = await api.listItems('sink', 'public', 'default');
        assert(items.length === 1, `应有 1 行，实际 ${items.length}`);
        const jdbc = items[0];
        assert(jdbc.config.archive === 'builtin://jdbc-connector', 'archive 没折出来');
        // SinkConfig 里根本没有单值输出字段，目的地在 configs 里：读不到 topicName 就是没有
        assert(jdbc.config.output === undefined, `连接器不该有 output：${jdbc.config.output}`);
        assert(jdbc.config.ramMb === 1024 && jdbc.config.diskMb === 10 && jdbc.config.cpu === 1, `资源折错: ${JSON.stringify(jdbc.config)}`);
        assert(!http.calls.some(call => call.method === 'get' && /\/stats$/.test(call.url)), 'sink 不该打 /stats');
        assert(!http.calls.some(call => call.url.includes('/admin/v3/functions')), 'sink 列表不该碰函数路径');
    });

    await check('来源的产出按 topicName 折', async () => {
        const {api} = apiWith(ROUTES);
        const items = await api.listItems('source', 'public', 'default');
        assert(items.length === 1, `应有 1 行，实际 ${items.length}`);
        assert(items[0].config.output === 'persistent://public/default/out', `topicName 没折成 output: ${JSON.stringify(items[0].config)}`);
    });

    await check('停止带 force，重启不带', async () => {
        const {api, http} = apiWith(ROUTES);
        await api.control('function', 'public', 'default', 'x', 'stop');
        await api.control('function', 'public', 'default', 'x', 'restart', 1);
        const stop = http.calls.find(call => call.url === '/admin/v3/functions/public/default/x/stop');
        const restart = http.calls.find(call => call.url === '/admin/v3/functions/public/default/x/1/restart');
        assert(stop && stop.config?.params?.force === true, `stop 应带 force=true，实际 ${JSON.stringify(stop && stop.config)}`);
        assert(restart && !restart.config, 'restart 不该带 force');
    });

    await check('新建：函数按运行时发 jar/py，连接器发 archive，资源换算成字节', async () => {
        const {api, http} = apiWith(ROUTES);
        await api.create({
            clusterId: 'c',
            kind: 'function',
            tenant: 'public',
            namespace: 'default',
            name: 'newfn',
            className: 'com.example.Fn',
            archive: 'http://host/pkg.jar',
            inputs: ['persistent://public/default/a'],
            output: 'persistent://public/default/b',
            parallelism: 3,
            ramMb: 2048,
            userConfig: {k: 'v'},
        });
        await api.create({
            clusterId: 'c',
            kind: 'function',
            tenant: 'public',
            namespace: 'default',
            name: 'pyfn',
            className: 'handler.func',
            runtime: 'PYTHON',
            archive: 'http://host/pkg.py',
            inputs: ['persistent://public/default/a'],
        });
        await api.create({
            clusterId: 'c',
            kind: 'sink',
            tenant: 'public',
            namespace: 'default',
            name: 'newsink',
            archive: 'builtin://x',
            userConfig: {k: 'v'},
        });
        const posts = http.calls.filter(call => call.method === 'post');
        assert(posts.length === 3, `应有 3 次 POST，实际 ${posts.length}`);
        const form = [...posts[0].body.entries()];
        assert(posts[0].url === '/admin/v3/functions/public/default/newfn', `函数创建路径错: ${posts[0].url}`);
        const config = JSON.parse(form.find(([key]) => key === 'functionConfig')[1]);
        // 配置段是严格反序列化的：jarPath / ramDisk 这类自造字段名会被 worker 直接 400
        assert(config.jar === 'http://host/pkg.jar', `函数包应发 jar: ${JSON.stringify(config)}`);
        assert(!('jarPath' in config) && !('archive' in config), `不该有自造字段: ${JSON.stringify(config)}`);
        assert(config.inputs.length === 1 && config.output === 'persistent://public/default/b', `函数体错: ${JSON.stringify(config)}`);
        assert(config.userConfig.k === 'v' && config.parallelism === 3, '参数与并行度没带上');
        assert(config.resources.ram === 2147483648, `内存应按字节发: ${JSON.stringify(config.resources)}`);
        assert(form.some(([key]) => key === 'url'), '包坐标应作为 url 表单字段发出');
        const pyForm = [...posts[1].body.entries()];
        const pyConfig = JSON.parse(pyForm.find(([key]) => key === 'functionConfig')[1]);
        assert(pyConfig.py === 'http://host/pkg.py' && !pyConfig.jar, `PYTHON 应发 py 字段: ${JSON.stringify(pyConfig)}`);
        const sinkForm = [...posts[2].body.entries()];
        assert(sinkForm.some(([key]) => key === 'sinkConfig'), '连接器应发 sinkConfig');
        const sinkConfig = JSON.parse(sinkForm.find(([key]) => key === 'sinkConfig')[1]);
        assert(sinkConfig.archive === 'builtin://x' && sinkConfig.configs.k === 'v' && !sinkConfig.jar, `连接器体错: ${JSON.stringify(sinkConfig)}`);
        assert(sinkConfig.topic === undefined && sinkConfig.topicName === undefined, '没填输出时不该发输出字段');
        // 连接器不需要入口类（包里的 META-INF 自带）：留空就别发这个键
        assert(!('className' in sinkConfig), `className 留空时不该发: ${JSON.stringify(sinkConfig)}`);
    });

    await check('本地包：一次注册请求带 data 文件段，不单独上传', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-mgr-'));
        const file = path.join(dir, 'localfn.jar');
        fs.writeFileSync(file, 'not-a-real-jar-but-bytes');
        const {api, http} = apiWith(ROUTES);
        await api.createWithLocalPackage({
            clusterId: 'c',
            kind: 'function',
            tenant: 'public',
            namespace: 'default',
            name: 'localfn',
            className: 'com.example.Fn',
            localPackagePath: file,
            inputs: ['persistent://public/default/a'],
        });
        // 只该有一次 POST：注册端点自己就收文件段，worker 收到后自己落包
        const posts = http.calls.filter(call => call.method === 'post');
        assert(posts.length === 1, `本地包应只发一次请求，实际 ${posts.length}: ${posts.map(p => p.url).join(', ')}`);
        assert(posts[0].url === '/admin/v3/functions/public/default/localfn', `落点错: ${posts[0].url}`);
        const body = posts[0].body;
        // form-data 继承 CombinedStream：字符串分段直接入列，流分段被包成惰性流躺在 _streams 里。
        // getBuffer() 不认后者，所以这里自己把分段头拼出来验结构，再单独把那个流抽干验字节。
        const text = body._streams.filter(item => typeof item === 'string').join('');
        assert(/name="data"/.test(text) && /filename="localfn\.jar"/.test(text), `文件段应带 filename: ${text.slice(0, 200)}`);
        assert(/Content-Type: application\/octet-stream/.test(text), `文件段该按字节流声明: ${text.slice(0, 300)}`);
        assert(/name="functionConfig"/.test(text), `该带配置段: ${text.slice(0, 200)}`);
        assert(!/name="url"/.test(text), '本地包这一档不该同时发 url 坐标');
        assert(/"jar":"localfn\.jar"/.test(text), `包字段应是文件名（字节在 data 段里）: ${text.slice(0, 400)}`);
        assert(/"className":"com\.example\.Fn"/.test(text), '类名没进配置段');
        const lazy = body._streams.filter(item => item && typeof item.pipe === 'function');
        assert(lazy.length === 1, `文件段应是唯一的惰性流，实际 ${lazy.length}`);
        assert((await collect(lazy[0])) === 'not-a-real-jar-but-bytes', '文件字节没进请求体');
        assert(body.hasKnownLength(), '没带 knownLength 时长度算不出来，Content-Length 会缺');
        assert(body.getLengthSync() > 25, `长度该包含那 25 字节文件本体: ${body.getLengthSync()}`);
        const config = posts[0].config || {};
        assert(config.timeout > 5000, `上传该用宽超时，实际 ${config.timeout}`);
        assert(/multipart\/form-data; boundary=/.test(String(config.headers && config.headers['content-type'])), `边界要由 form-data 自己给出: ${JSON.stringify(config.headers)}`);
        fs.rmSync(dir, {recursive: true, force: true});
    });

    await check('本地包读不到时说的是文件而不是请求', async () => {
        const {api, http} = apiWith(ROUTES);
        const missing = path.join(os.tmpdir(), 'pulsar-mgr-不存在的包.jar');
        let thrown;
        try {
            await api.createWithLocalPackage({
                clusterId: 'c',
                kind: 'function',
                tenant: 'public',
                namespace: 'default',
                name: 'localfn',
                localPackagePath: missing,
            });
        } catch (error) {
            thrown = error;
        }
        assert(/本地包读不到/.test(thrown?.message || ''), `错误口径错: ${thrown && thrown.message}`);
        assert(http.calls.filter(call => call.method === 'post').length === 0, '文件都读不到就不该发请求');
    });

    await check('触发用表单字段而不是查询参数', async () => {
        const {api, http} = apiWith({...ROUTES, '/admin/v3/functions/public/default/x/trigger': {data: 'ok-output'}});
        const result = await api.trigger('public', 'default', 'x', 'persistent://public/default/in', '{"a":1}');
        assert(result.output === 'ok-output', `返回值没读出来: ${JSON.stringify(result)}`);
        const call = http.calls.find(item => item.url === '/admin/v3/functions/public/default/x/trigger');
        const form = [...call.body.entries()];
        assert(form.some(([key, value]) => key === 'topic' && value === 'persistent://public/default/in'), 'topic 应在表单里');
        assert(form.some(([key, value]) => key === 'data' && value === '{"a":1}'), 'data 应在表单里');
        assert(!call.url.includes('?'), '不该把参数拼到查询串上');
    });

    await check('内置清单：函数走 builtins，连接器走 builtinsinks', async () => {
        const {api} = apiWith(ROUTES);
        const fns = await api.listBuiltins('function');
        assert(fns.length === 1 && fns[0].className.includes('FilterFunction'), '内置函数清单没读出来');
        const sinks = await api.listBuiltins('sink');
        assert(sinks.length === 1 && sinks[0].name === 'jdbc', '内置连接器清单没读出来');
    });

    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();
