// topic-policy-api 的端点形状与折叠自测。本机没有可对照的 broker，
// 「TTL 的值到底在查询参数还是请求体、去重回的是裸布尔还是对象、
// 405 该说成 broker 没开关还是版本太旧」这类事情只能靠这份假路由钉住。
// 跑法：npm run selftest:topic（先编译主进程，再跑这一份）。
const {
    TopicPolicyAPI,
    TOPIC_POLICY_FIELDS,
    CLEARABLE_TOPIC_POLICY_FIELDS,
    topicPolicyValueOf,
} = require('../dist/src/main/services/topic-policy-api.js');
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

const BASE = '/admin/v2/persistent/public/default/my-topic';
const NB_BASE = '/admin/v2/non-persistent/public/default/my-topic';

// 只做精确匹配：前缀兜底会把「这条 URL 根本不该出现」伪装成一次正常响应。
// 路由值二选一：data 是正常响应，status 模拟 broker 的 HTTP 错误
// （错误文案按主进程的样子带上 "(状态码)"，405 那条口径全靠它辨认）。
function fakeHttp(routes) {
    const calls = [];
    const act = (method, url, body, config) => {
        calls.push({method, url, body, params: config && config.params});
        const route = routes[`${method} ${url}`];
        if (!route) {
            return Promise.reject(new NotFoundError(url));
        }
        if (route.status) {
            return Promise.reject(new Error(`${route.message || 'broker 拒绝'} (${route.status})`));
        }
        return Promise.resolve({data: route.data});
    };
    return {
        calls,
        get: (url, config) => act('get', url, undefined, config),
        post: (url, body, config) => act('post', url, body, config),
        delete: (url, config) => act('delete', url, undefined, config),
    };
}

function apiWith(routes) {
    const http = fakeHttp(routes);
    return {api: new TopicPolicyAPI(http, new Semaphore(5)), http};
}

// 写入侧只关心「发出去的请求长什么样」，响应体没有读者，所以任何请求都算成功。
// 代价是路径写错不会再报 404，因此每条用例必须自己断言完整 URL——
// 只断言 endsWith 的话，这一段就变成自证。
function okHttp() {
    const calls = [];
    const act = (method, url, body, config) => {
        calls.push({method, url, body, params: config && config.params});
        return Promise.resolve({data: null});
    };
    return {
        calls,
        get: (url, config) => act('get', url, undefined, config),
        post: (url, body, config) => act('post', url, body, config),
        delete: (url, config) => act('delete', url, undefined, config),
    };
}

function writeApi() {
    const http = okHttp();
    return {api: new TopicPolicyAPI(http, new Semaphore(5)), http};
}

const PROBE = {[`get ${BASE}/permissions`]: {data: {producer: ['admin']}}};

const READ_ROUTES = {
    ...PROBE,
    [`get ${BASE}/retention`]: {data: {retentionTimeInMinutes: -1, retentionSizeInMB: 512}},
    [`get ${BASE}/messageTTL`]: {data: 3600},
    [`get ${BASE}/deduplicationEnabled`]: {data: false},
    [`get ${BASE}/maxUnackedMessagesOnConsumer`]: {data: 0},
    // maxUnackedMessagesOnSubscription 故意不写路由：老 broker 没有这一条，
    // 缺它不能让整页失败
};

const reasonOf = (view, field) => {
    const entry = view.unavailable.find(item => item.field === field);
    return entry ? entry.reason : '';
};

(async () => {
    await check('五个端点各回自己的形状，摊成一份视图', async () => {
        const {api, http} = apiWith(READ_ROUTES);
        const view = await api.getPolicies('public', 'default', 'my-topic');
        assert(view.topicName === 'public/default/my-topic', `topicName 不对：${view.topicName}`);
        assert(view.persistent === true, '默认应按持久 topic 读');
        assert(view.messageTtlSeconds === 3600, 'TTL 端点回的就是裸数字（秒）');
        assert(view.deduplicationEnabled === false, '裸布尔 false 是有效值，不能塌成未设置');
        assert(view.maxUnackedMessagesPerConsumer === 0, '0 表示「不限制」，同样不能塌成未设置');
        assert(view.retentionTimeInMinutes === -1 && view.retentionSizeInMB === 512, 'retention 是两键对象');
        assert(view.maxUnackedMessagesPerSubscription === null, '缺端点的字段应折叠成未设置');
        assert(/版本过旧/.test(reasonOf(view, 'maxUnackedMessagesPerSubscription')), `缺端点要带原因：${JSON.stringify(view.unavailable)}`);
        assert(http.calls.length === 6, `探针一条 + 五个字段，实际 ${http.calls.length}`);
        assert(JSON.stringify(view.raw.messageTtlSeconds) === '3600', 'raw 按字段名留端点原始返回给抽屉展示');
        assert(view.raw.retention.retentionSizeInMB === 512, 'raw 里 retention 存的是整份原始对象');
    });

    await check('完整 topic URI 进来只用短名，不拼成 tenant/ns/tenant/ns/topic', async () => {
        const {api, http} = apiWith(READ_ROUTES);
        await api.getPolicies('public', 'default', 'persistent://public/default/my-topic');
        assert(
            http.calls.every(call => call.url.startsWith(`${BASE}/`)),
            `URL 拼错了：${http.calls.map(call => call.url).join(' | ')}`,
        );
    });

    await check('找不到 topic 时说清原因，而不是五句「没有 topic 级端点」', async () => {
        const {api, http} = apiWith({});
        let message = '';
        try {
            await api.getPolicies('public', 'default', 'my-topic');
        } catch (error) {
            message = error.message;
        }
        assert(/topic 或所属命名空间不存在/.test(message), `实际：${message}`);
        assert(http.calls.length === 1, `探针失败就该停住，实际发了 ${http.calls.length} 条`);
    });

    await check('broker 未开启 topic 级策略：405 换成能照着改的话', async () => {
        const routes = {...PROBE};
        for (const path of ['retention', 'messageTTL', 'deduplicationEnabled', 'maxUnackedMessagesOnConsumer', 'maxUnackedMessagesOnSubscription']) {
            routes[`get ${BASE}/${path}`] = {status: 405, message: 'Topic level policy is disabled'};
        }
        const {api} = apiWith(routes);
        const view = await api.getPolicies('public', 'default', 'my-topic');
        assert(view.unavailable.length === 5, `五项都该标不可写，实际 ${JSON.stringify(view.unavailable)}`);
        assert(
            view.unavailable.every(item => /topicLevelPoliciesEnabled/.test(item.reason)),
            `原因要说清开关名：${JSON.stringify(view.unavailable.map(item => item.reason))}`,
        );
        assert(view.messageTtlSeconds === null && view.deduplicationEnabled === null, '不可写的字段不该顺手填成 0 / false');
    });

    await check('501 与「整片开关」同义，500 仍然照抛', async () => {
        const routes = {...PROBE, [`get ${BASE}/messageTTL`]: {status: 501, message: 'Not implemented'}};
        const {api} = apiWith(routes);
        const view = await api.getPolicies('public', 'default', 'my-topic');
        assert(/topicLevelPoliciesEnabled/.test(reasonOf(view, 'messageTtlSeconds')), `501 应归到开关未开：${JSON.stringify(view.unavailable)}`);

        const broken = {...PROBE, [`get ${BASE}/messageTTL`]: {status: 500, message: 'Internal server error'}};
        const other = apiWith(broken);
        let message = '';
        try {
            await other.api.getPolicies('public', 'default', 'my-topic');
        } catch (error) {
            message = error.message;
        }
        assert(/Internal server error/.test(message), `非开关类错误要原样抛给上层，实际：${message}`);
    });

    await check('retention 空 body 是没设过，不是「保留 0 分钟」', async () => {
        const routes = {...PROBE, [`get ${BASE}/retention`]: {data: undefined}};
        const {api} = apiWith(routes);
        const view = await api.getPolicies('public', 'default', 'my-topic');
        assert(view.retentionTimeInMinutes === null && view.retentionSizeInMB === null, '认不出的形状按未设置处理');
        assert(view.unavailable.length === 4, `retention 读到了只是没值，不该算不可写：${JSON.stringify(view.unavailable)}`);
    });

    await check('只读出一半的保留策略不参与还原', () => {
        const half = topicPolicyValueOf(
            {...blankTopicView(), retentionTimeInMinutes: -1},
            'retention',
        );
        assert(half === null, `POST 是整对象替换，缺维度不能补 0：${JSON.stringify(half)}`);
        const both = topicPolicyValueOf(
            {...blankTopicView(), retentionTimeInMinutes: -1, retentionSizeInMB: 512},
            'retention',
        );
        assert(
            JSON.stringify(both) === JSON.stringify({timeInMinutes: -1, sizeInMB: 512}),
            `还原出来的应是 setPolicy 的入参形状：${JSON.stringify(both)}`,
        );
        assert(topicPolicyValueOf(blankTopicView(), 'messageTtlSeconds') === null, '未设置还原成 null');
    });

    await check('全部字段都可清除（每条端点都有 DELETE）', () => {
        assert(
            TOPIC_POLICY_FIELDS.length === 5 && CLEARABLE_TOPIC_POLICY_FIELDS.length === 5,
            `字段表与清除名单应一致：${JSON.stringify(TOPIC_POLICY_FIELDS)}`,
        );
    });

    await check('TTL 的值在查询参数里，请求体留空', async () => {
        const {api, http} = writeApi();
        await api.setPolicy('public', 'default', 'my-topic', 'messageTtlSeconds', 60);
        const call = http.calls[0];
        assert(call.method === 'post' && call.url === `${BASE}/messageTTL`, `方法或路径不对：${JSON.stringify(call)}`);
        assert(call.params && call.params.messageTTL === '60', `值应进查询参数：${JSON.stringify(call.params)}`);
        // 把 60 放进请求体 broker 收不到参数，回 204 却什么都没改
        assert(call.body === '', `请求体应是空串，实际 ${JSON.stringify(call.body)}`);
    });

    await check('去重与未确认上限发裸标量请求体，不带查询参数', async () => {
        const {api, http} = writeApi();
        await api.setPolicy('public', 'default', 'my-topic', 'deduplicationEnabled', true);
        await api.setPolicy('public', 'default', 'my-topic', 'maxUnackedMessagesPerConsumer', 0);
        await api.setPolicy('public', 'default', 'my-topic', 'maxUnackedMessagesPerSubscription', 1000);
        assert(http.calls[0].url === `${BASE}/deduplicationEnabled`, `路径不对：${http.calls[0].url}`);
        assert(http.calls[1].url === `${BASE}/maxUnackedMessagesOnConsumer`, `端点名不是字段名：${http.calls[1].url}`);
        assert(http.calls[2].url === `${BASE}/maxUnackedMessagesOnSubscription`, `路径不对：${http.calls[2].url}`);
        assert(http.calls[0].body === true, `去重要发裸布尔：${JSON.stringify(http.calls[0].body)}`);
        assert(http.calls[1].body === 0, `0 是「不限制」，必须原样下发：${JSON.stringify(http.calls[1].body)}`);
        assert(http.calls[1].params === undefined, `这三个端点没有查询参数：${JSON.stringify(http.calls[1].params)}`);
    });

    await check('保留策略整对象替换：两个维度一起发，-1 原样', async () => {
        const {api, http} = writeApi();
        await api.setPolicy('public', 'default', 'my-topic', 'retention', {timeInMinutes: -1, sizeInMB: 512});
        const call = http.calls[0];
        assert(call.url === `${BASE}/retention`, `路径不对：${call.url}`);
        assert(
            call.body.retentionTimeInMinutes === -1 && call.body.retentionSizeInMB === 512,
            `请求体形状不对：${JSON.stringify(call.body)}`,
        );
        assert(http.calls[0].params === undefined, 'retention 的值全在请求体里');
    });

    await check('非持久 topic 走 non-persistent 段', async () => {
        const {api, http} = writeApi();
        await api.setPolicy('public', 'default', 'my-topic', 'messageTtlSeconds', 30, false);
        await api.clearPolicy('public', 'default', 'my-topic', 'retention', false);
        assert(http.calls[0].url === `${NB_BASE}/messageTTL`, `路径不对：${http.calls[0].url}`);
        assert(http.calls[1].url === `${NB_BASE}/retention`, `清除路径不对：${http.calls[1].url}`);
        assert(http.calls[1].method === 'delete', `清除应是 DELETE，实际 ${http.calls[1].method}`);
    });

    await check('清除按字段拼出与写入一致的 URL', async () => {
        const {api, http} = writeApi();
        await api.clearPolicy('public', 'default', 'my-topic', 'deduplicationEnabled');
        assert(
            http.calls[0].method === 'delete' && http.calls[0].url === `${BASE}/deduplicationEnabled`,
            `实际：${JSON.stringify(http.calls[0])}`,
        );
    });

    await check('字段级校验在发请求前拦下字符串、负数与缺维度', async () => {
        // 这一条继续用严格路由：校验没生效时请求会落到空路由表变成 404，
        // 下面按「不是 404」判定，比只看"有没有报错"更能区分校验拦截和路由缺失。
        const {api, http} = apiWith({});
        const cases = [
            ['messageTtlSeconds', '60', '字符串'],
            ['messageTtlSeconds', -1, '负数 TTL（broker 会回 412）'],
            ['messageTtlSeconds', 1.5, '小数'],
            ['deduplicationEnabled', 'true', '布尔写成字符串'],
            ['maxUnackedMessagesPerConsumer', -1, '负数上限'],
            ['retention', {timeInMinutes: -1}, '少一个维度'],
            ['retention', 512, '对象写成数字'],
        ];
        for (const [field, value, why] of cases) {
            let message = '';
            try {
                await api.setPolicy('public', 'default', 'my-topic', field, value);
            } catch (error) {
                message = error.message;
            }
            assert(
                message !== '' && !message.startsWith('Resource not found'),
                `${field}（${why}）应被拦下，实际：${message || '没有报错'}`,
            );
            assert(http.calls.length === 0, `${field}（${why}）应在发请求前就拦下`);
        }
    });

    await check('未知字段名直接拒绝，不拼出奇怪的 URL', async () => {
        const {api, http} = apiWith({});
        let message = '';
        try {
            await api.setPolicy('public', 'default', 'my-topic', 'notAField', 1);
        } catch (error) {
            message = error.message;
        }
        assert(/不支持在 topic 级设置/.test(message), `实际：${message}`);
        assert(http.calls.length === 0, '不该发出任何请求');
    });

    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();

// 折叠视图骨架：topic 级只有六个值字段，手写比从假路由折出来更稳。
function blankTopicView() {
    return {
        topicName: 'public/default/my-topic',
        persistent: true,
        retentionTimeInMinutes: null,
        retentionSizeInMB: null,
        messageTtlSeconds: null,
        deduplicationEnabled: null,
        maxUnackedMessagesPerConsumer: null,
        maxUnackedMessagesPerSubscription: null,
        clearableFields: [],
        unavailable: [],
        raw: {},
    };
}
