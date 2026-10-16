// worker-api 的路径与折叠自测：本机没有可对照的 Function Worker，
// 「哪个端点用什么动词、状态字段摊在哪一层」这类事情只能靠这份假路由钉住——
// 它已经在写下时抓出一个把整个列表读成空的错（把 axios 响应体当名字数组）。
// 跑法：npm run selftest:worker（先编译主进程，再跑这一份）。
const {WorkerAPI, WorkerUnavailableError} = require('../dist/src/main/services/worker-api.js');
const {Semaphore, NotFoundError} = require('../dist/src/main/services/http-client.js');

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
            jarPath: 'function://builtin-filter',
            inputs: ['persistent://public/default/in'],
            output: 'persistent://public/default/out',
            parallelism: 2,
            processingGuarantees: 'ATLEAST_ONCE',
            resources: {cpu: 2, ramDisk: 2048, disk: 10240},
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
        data: {className: 'org.apache.pulsar.io.jdbc.JdbcSink', archive: 'builtin://jdbc-connector', topic: 'out', cpu: 1, ramMb: 1024, diskMb: 10240},
    },
    '/admin/v3/sinks/public/default/jdbc/status': {data: NESTED_STATUS},
    '/admin/v3/functions/builtins': {data: [{name: 'filter', className: 'org.apache.pulsar.functions.builtins.FilterFunction'}]},
    '/admin/v3/sinks/builtinsinks': {data: [{name: 'jdbc', className: 'org.apache.pulsar.io.jdbc.JdbcSink', type: 'sink'}]},
    '/admin/v3/sinks/builtinsinks/jdbc/configdefinition': {data: {name: 'jdbc', description: 'JDBC sink'}},
    // 写操作的落点：假路由只认这里列出来的 URL，多打一个就是失败
    '/admin/v3/functions/public/default/x/stop': {data: ''},
    '/admin/v3/functions/public/default/x/1/restart': {data: ''},
    '/admin/v3/functions/public/default/newfn': {data: 'created-function'},
    '/admin/v3/sinks/public/default/newsink': {data: 'created-sink'},
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
        assert(x.config.archive === 'function://builtin-filter', 'jarPath 应折成 archive');
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

    await check('连接器列表不请求 /stats，字段按 archive/topic/平铺资源折', async () => {
        const {api, http} = apiWith(ROUTES);
        const items = await api.listItems('sink', 'public', 'default');
        assert(items.length === 1, `应有 1 行，实际 ${items.length}`);
        const jdbc = items[0];
        assert(jdbc.config.archive === 'builtin://jdbc-connector', 'archive 没折出来');
        assert(jdbc.config.output === 'out', '连接器的 topic 应折成 output');
        assert(jdbc.config.ramMb === 1024 && jdbc.config.cpu === 1, '平铺资源字段没读到');
        assert(!http.calls.some(call => call.method === 'get' && /\/stats$/.test(call.url)), 'sink 不该打 /stats');
        assert(!http.calls.some(call => call.url.includes('/admin/v3/functions')), 'sink 列表不该碰函数路径');
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

    await check('新建：函数用 jarPath + functionConfig，连接器用 archive + sinkConfig', async () => {
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
            userConfig: {k: 'v'},
        });
        await api.create({
            clusterId: 'c',
            kind: 'sink',
            tenant: 'public',
            namespace: 'default',
            name: 'newsink',
            className: 'com.example.Sink',
            archive: 'builtin://x',
            userConfig: {k: 'v'},
        });
        const posts = http.calls.filter(call => call.method === 'post');
        assert(posts.length === 2, `应有 2 次 POST，实际 ${posts.length}`);
        const form = [...posts[0].body.entries()];
        assert(posts[0].url === '/admin/v3/functions/public/default/newfn', `函数创建路径错: ${posts[0].url}`);
        const config = JSON.parse(form.find(([key]) => key === 'functionConfig')[1]);
        assert(config.jarPath === 'http://host/pkg.jar' && config.inputs.length === 1 && config.output === 'persistent://public/default/b', `函数体错: ${JSON.stringify(config)}`);
        assert(config.userConfig.k === 'v' && config.parallelism === 3, '参数与并行度没带上');
        assert(form.some(([key]) => key === 'url'), '包坐标应作为 url 表单字段发出');
        const sinkForm = [...posts[1].body.entries()];
        assert(sinkForm.some(([key]) => key === 'sinkConfig'), '连接器应发 sinkConfig');
        const sinkConfig = JSON.parse(sinkForm.find(([key]) => key === 'sinkConfig')[1]);
        assert(sinkConfig.archive === 'builtin://x' && sinkConfig.configs.k === 'v' && !sinkConfig.jarPath, `连接器体错: ${JSON.stringify(sinkConfig)}`);
        assert(sinkConfig.topic === undefined, '没填输出时不该发 topic');
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

    await check('内置清单：函数走 builtins，连接器走 configdefinition', async () => {
        const {api} = apiWith(ROUTES);
        const fns = await api.listBuiltins('function');
        assert(fns.length === 1 && fns[0].className.includes('FilterFunction'), '内置函数清单没读出来');
        const sinks = await api.listBuiltins('sink');
        assert(sinks.length === 1 && sinks[0].name === 'jdbc', '内置连接器清单没读出来');
        const definition = await api.getBuiltinConfigDefinition('sink', 'jdbc');
        assert(definition.description === 'JDBC sink', `configdefinition 没读到: ${JSON.stringify(definition)}`);
        const fnDefinition = await api.getBuiltinConfigDefinition('function', 'filter');
        assert(fnDefinition.className && String(fnDefinition.className).includes('FilterFunction'), '内置函数参数应从 builtins 条目里取');
    });

    await check('state 读写取的是 value 字段', async () => {
        const {api, http} = apiWith({
            '/admin/v2/worker/cluster': ROUTES['/admin/v2/worker/cluster'],
            '/admin/v3/functions/public/default/x/state/counter': {data: {key: 'counter', value: '7'}},
        });
        assert((await api.getFunctionState('public', 'default', 'x', 'counter')) === '7', 'state 值没读出来');
        await api.setFunctionState('public', 'default', 'x', 'counter', '9');
        const post = http.calls.find(call => call.method === 'post' && call.url.endsWith('/state/counter'));
        const state = JSON.parse([...post.body.entries()].find(([key]) => key === 'state')[1]);
        assert(state.key === 'counter' && state.value === '9' && state.string === '9', `state 体错: ${JSON.stringify(state)}`);
    });

    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();
