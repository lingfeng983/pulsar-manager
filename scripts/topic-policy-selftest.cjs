// topic-policy-api 与 topic-policy-sync 的自测。本机没有可对照的 broker，
// 「TTL 的值到底在查询参数还是请求体、去重回的是裸布尔还是对象、
// 405 该说成 broker 没开关还是版本太旧、读不出来的字段能不能被当成没配过」
// 这类事情只能靠这份假路由与假客户端钉住。
// 跑法：npm run selftest:topic（先编译主进程，再跑这一份）。
const {
    TopicPolicyAPI,
    TOPIC_POLICY_FIELDS,
    CLEARABLE_TOPIC_POLICY_FIELDS,
    topicPolicyValueOf,
} = require('../dist/src/main/services/topic-policy-api.js');
const {Semaphore, NotFoundError} = require('../dist/src/main/services/http-client.js');
const {
    TOPIC_SYNC_MAX_TARGETS,
    applyTopicPolicySync,
    planTopicPolicyDiff,
    planTopicPolicySync,
} = require('../dist/src/main/services/topic-policy-sync.js');

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

// ========== 批量同步用的假客户端 ==========

const keyOf = scope =>
    `${scope.persistent ? 'p' : 'n'}/${scope.tenant}/${scope.namespace}/${scope.topic}`;

const syncView = extra => ({...blankTopicView(), ...extra});

// 记录每一次写入：批量同步最容易出的错是「写到了别的 topic」和「该中止时继续写」，
// 这两件事都只能从写入序列里看出来。
function fakeClient(views, options = {}) {
    const writes = [];
    const fail = (kind, key, field) => {
        const list = options[kind] || [];
        return list.some(item => item.key === key && (item.field === undefined || item.field === field));
    };
    return {
        writes,
        async getTopicPolicies(tenant, namespace, topic, persistent = true) {
            const key = keyOf({tenant, namespace, topic, persistent});
            if (!views[key]) {
                throw new Error(`读不到 ${key}`);
            }
            if (fail('failRead', key)) {
                throw new Error(`读取失败：${key}`);
            }
            return views[key];
        },
        async setTopicPolicy(tenant, namespace, topic, field, value, persistent = true) {
            const key = keyOf({tenant, namespace, topic, persistent});
            if (fail('failWrite', key, field)) {
                throw new Error(`broker 拒绝：${field}`);
            }
            writes.push({kind: 'set', key, field, value});
        },
        async clearTopicPolicy(tenant, namespace, topic, field, persistent = true) {
            const key = keyOf({tenant, namespace, topic, persistent});
            if (fail('failWrite', key, field)) {
                throw new Error(`broker 拒绝：${field}`);
            }
            writes.push({kind: 'clear', key, field});
        },
    };
}

const SRC = {tenant: 'public', namespace: 'default', topic: 'src', persistent: true};
const T1 = {tenant: 'public', namespace: 'default', topic: 't1', persistent: true};
const T2 = {tenant: 'public', namespace: 'default', topic: 't2', persistent: true};
// 与源同名但非持久：这是另一个 topic，绝不能被当成「同步到自己身上」剔掉
const NP_SRC = {tenant: 'public', namespace: 'default', topic: 'src', persistent: false};
const KEYS = list => list.map(item => item.key);

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

    // ========== 批量同步：差异计划 ==========

    await check('值相同的字段不产生差异；-1 / 0 / 未设置是三种不同事实', () => {
        const same = planTopicPolicyDiff(syncView({messageTtlSeconds: 60}), syncView({messageTtlSeconds: 60}), [
            'messageTtlSeconds',
        ]);
        assert(same.length === 0, `相同值不该有差异：${JSON.stringify(same)}`);

        // 0 是「不限」、未设置是「沿用命名空间」，两者互不相同：
        // 塌成一样的话，同步会把别人配的 0 当成没配而清掉
        const zeroVsUnset = planTopicPolicyDiff(
            syncView({maxUnackedMessagesPerConsumer: 0}),
            syncView(),
            ['maxUnackedMessagesPerConsumer'],
        );
        assert(zeroVsUnset.length === 1 && zeroVsUnset[0].action === 'set', `0 要写成 0：${JSON.stringify(zeroVsUnset)}`);
        assert(zeroVsUnset[0].value === 0, `写入值不对：${JSON.stringify(zeroVsUnset[0])}`);

        const retention = planTopicPolicyDiff(
            syncView({retentionTimeInMinutes: -1, retentionSizeInMB: -1}),
            syncView({retentionTimeInMinutes: 0, retentionSizeInMB: 0}),
            ['retention'],
        );
        assert(
            JSON.stringify(retention[0].value) === JSON.stringify({timeInMinutes: -1, sizeInMB: -1}),
            `下发的是 setPolicy 的入参形状：${JSON.stringify(retention)}`,
        );
    });

    await check('源未设置、目标设过 → 撤销目标上的 topic 级覆盖', () => {
        const deltas = planTopicPolicyDiff(syncView(), syncView({messageTtlSeconds: 30}), ['messageTtlSeconds']);
        assert(deltas.length === 1 && deltas[0].action === 'clear', `应是清除：${JSON.stringify(deltas)}`);
    });

    await check('读不出来的字段整项跳过，绝不发清除或写入', () => {
        const switchOff = {field: 'retention', reason: '该 broker 未开启 topic 级策略（topicLevelPoliciesEnabled=true 才能设置）'};
        const fromSource = planTopicPolicyDiff(
            syncView({unavailable: [switchOff]}),
            syncView({retentionTimeInMinutes: 60, retentionSizeInMB: 128}),
            ['retention'],
        );
        assert(fromSource.length === 1 && fromSource[0].action === 'skip', `实际：${JSON.stringify(fromSource)}`);
        assert(/源 topic 上读不到/.test(fromSource[0].reason), `skip 要说清是哪一侧：${fromSource[0].reason}`);
        assert(/topicLevelPoliciesEnabled/.test(fromSource[0].reason), `原因要带上 broker 的开关名：${fromSource[0].reason}`);

        const fromTarget = planTopicPolicyDiff(
            syncView({messageTtlSeconds: 60}),
            syncView({unavailable: [{field: 'messageTtlSeconds', reason: '该 broker 上没有这个 topic 级端点（Pulsar 版本过旧）'}]}),
            ['messageTtlSeconds'],
        );
        assert(fromTarget.length === 1 && fromTarget[0].action === 'skip', `实际：${JSON.stringify(fromTarget)}`);
        assert(/目标 topic 上读不到/.test(fromTarget[0].reason), `实际：${fromTarget[0].reason}`);
    });

    await check('只读出一半的保留策略不参与同步', () => {
        // POST /retention 是整体替换，缺的那个数字补 0 会把无限保留变成一条不留
        const halfSource = planTopicPolicyDiff(syncView({retentionTimeInMinutes: -1}), syncView({retentionSizeInMB: 512, retentionTimeInMinutes: 10}), ['retention']);
        assert(halfSource.length === 1 && halfSource[0].action === 'skip', `实际：${JSON.stringify(halfSource)}`);
        assert(/只读出一个维度/.test(halfSource[0].reason), `实际：${halfSource[0].reason}`);
    });

    await check('差异顺序按字段表走，不受调用方传参顺序影响', () => {
        const source = syncView({messageTtlSeconds: 60, deduplicationEnabled: true});
        const one = planTopicPolicyDiff(source, syncView(), ['deduplicationEnabled', 'messageTtlSeconds']);
        const other = planTopicPolicyDiff(source, syncView(), ['messageTtlSeconds', 'deduplicationEnabled']);
        assert(
            one.map(item => item.field).join(',') === 'messageTtlSeconds,deduplicationEnabled',
            `字段顺序应稳定（TTL 在字段表里排在去重之前）：${one.map(item => item.field).join(',')}`,
        );
        assert(JSON.stringify(one) === JSON.stringify(other), '同一份配置换个传参顺序，预览与日志就该对得上');
    });

    // ========== 批量同步：预览与执行 ==========

    const syncParams = (targets, fields) => ({clusterId: 'c', source: SRC, targets, fields});
    const FULL = syncView({messageTtlSeconds: 60, deduplicationEnabled: true});

    await check('目标清单去重、剔除源本身、上限拦截', async () => {
        const onlySource = fakeClient({'p/public/default/src': FULL});
        let message = '';
        try {
            await planTopicPolicySync(onlySource, syncParams([SRC], ['messageTtlSeconds']));
        } catch (error) {
            message = error.message;
        }
        assert(/不能就是源本身/.test(message), `同步到自己身上应被拦下，实际：${message}`);
        assert(onlySource.writes.length === 0, '拦下后不该有任何写入');

        const dup = fakeClient({'p/public/default/src': FULL, 'p/public/default/t1': syncView()});
        const plan = await planTopicPolicySync(dup, syncParams([T1, T1, SRC], ['messageTtlSeconds']));
        assert(plan.targets.length === 1, `重复目标要去重，实际 ${plan.targets.length}`);

        // 非持久的同名 topic 是另一个 topic：把它当成源自己剔掉等于少同步一个目标
        const npPlan = await planTopicPolicySync(dup, syncParams([NP_SRC], ['messageTtlSeconds']));
        assert(npPlan.targets.length === 1, `persistent=false 的 p/public/default/src 不该被当成源自己：${npPlan.targets.length}`);

        const many = Array.from({length: TOPIC_SYNC_MAX_TARGETS + 1}, (_, index) => ({
            ...SRC,
            topic: `n${index}`,
        }));
        const capped = fakeClient({'p/public/default/src': FULL});
        let capMessage = '';
        try {
            await applyTopicPolicySync(capped, syncParams(many, ['messageTtlSeconds']));
        } catch (error) {
            capMessage = error.message;
        }
        assert(/一次最多同步/.test(capMessage), `超出上限应拦下，实际：${capMessage}`);
        assert(capped.writes.length === 0, '拦下后不该有任何写入');
    });

    await check('预览：源读不通返回结构化错误，目标读不通只标错自己', async () => {
        const client = fakeClient({'p/public/default/t1': syncView()});
        const plan = await planTopicPolicySync(client, syncParams([T1], ['messageTtlSeconds']));
        assert(/读不到 p\/public\/default\/src/.test(plan.sourceError || ''), `应带源 topic 的读失败：${plan.sourceError}`);
        assert(plan.targets.length === 0, '源读不通时不该给出任何目标差异');
        assert(client.writes.length === 0, '预览不该有任何写入');

        const two = fakeClient({'p/public/default/src': FULL, 'p/public/default/t1': syncView()});
        const mixed = await planTopicPolicySync(two, syncParams([T1, {tenant: 'public', namespace: 'default', topic: 'gone', persistent: true}], ['messageTtlSeconds']));
        const failed = mixed.targets.find(target => target.topic === 'gone');
        assert(failed && /读不到/.test(failed.error || ''), `读不通的目标应带 error：${JSON.stringify(failed)}`);
        assert(failed.deltas.length === 0, '读不通的目标不该给出差异');
        const ok = mixed.targets.find(target => target.topic === 't1');
        assert(ok.deltas.length === 1 && ok.deltas[0].action === 'set', `别的目标照常算差异：${JSON.stringify(ok)}`);
    });

    await check('预览回来的视图剥掉 raw，端点原文不过 IPC', async () => {
        const client = fakeClient({
            'p/public/default/src': syncView({messageTtlSeconds: 60, raw: {messageTtlSeconds: 60}}),
            'p/public/default/t1': syncView({raw: {messageTtlSeconds: 30}}),
        });
        const plan = await planTopicPolicySync(client, syncParams([T1], ['messageTtlSeconds']));
        assert(Object.keys(plan.sourceView.raw).length === 0, '源视图的 raw 应被剥掉');
        assert(Object.keys(plan.targets[0].view.raw).length === 0, '目标视图的 raw 应被剥掉');
        assert(plan.sourceView.messageTtlSeconds === 60, '折叠字段本身要留着');
    });

    await check('执行：写到正确的 topic，非持久目标带 persistent=false', async () => {
        const client = fakeClient({
            'p/public/default/src': FULL,
            'p/public/default/t1': syncView(),
            'n/public/default/src': FULL,
            'n/public/default/t1': syncView(),
        });
        const result = await applyTopicPolicySync(client, syncParams([T1, {...T1, persistent: false}], ['messageTtlSeconds']));
        assert(result.succeeded === 2 && result.failed === 0, `计数不对：${result.succeeded}/${result.failed}`);
        assert(
            KEYS(client.writes).join(',') === 'p/public/default/t1,n/public/default/t1',
            `写到别的 topic 上了：${KEYS(client.writes).join(',')}`,
        );
        assert(client.writes.every(item => item.kind === 'set' && item.value === 60), `TTL 应写成裸数字 60：${JSON.stringify(client.writes)}`);
    });

    await check('执行：某一项失败即中止本目标，别的目标照常', async () => {
        const client = fakeClient(
            {
                'p/public/default/src': FULL,
                'p/public/default/t1': syncView(),
                'p/public/default/t2': syncView({messageTtlSeconds: 60}),
            },
            // 字段表顺序里 messageTtlSeconds 在前、deduplicationEnabled 在后：
            // 前者失败后不该再发第二项
            {failWrite: [{key: 'p/public/default/t1', field: 'messageTtlSeconds'}]},
        );
        const result = await applyTopicPolicySync(client, syncParams([T1, T2], ['messageTtlSeconds', 'deduplicationEnabled']));
        const t1 = result.targets.find(target => target.topic === 't1');
        assert(
            t1.items.map(item => `${item.field}:${item.ok}`).join(',') === 'messageTtlSeconds:false',
            `失败项之后不该继续执行，也不该假装执行过：${JSON.stringify(t1.items)}`,
        );
        assert(/broker 拒绝/.test(t1.items[0].message || ''), `失败项要带上 broker 的话：${JSON.stringify(t1.items[0])}`);
        const t2 = result.targets.find(target => target.topic === 't2');
        assert(t2.items.length === 1, `t2 的 TTL 与源相同，不该有第二项：${JSON.stringify(t2.items)}`);
        assert(t2.items[0].field === 'deduplicationEnabled', `实际：${JSON.stringify(t2.items)}`);
        assert(client.writes.every(item => item.key !== 'p/public/default/src'), '源 topic 不该被写');
        assert(result.succeeded === 1 && result.failed === 1, `计数不对：${result.succeeded}/${result.failed}`);
    });

    await check('执行：跳过项如实列出且不进成败计数', async () => {
        const client = fakeClient({
            'p/public/default/src': syncView({unavailable: [{field: 'retention', reason: '该 broker 未开启 topic 级策略'}], messageTtlSeconds: 60}),
            'p/public/default/t1': syncView({retentionTimeInMinutes: 60, retentionSizeInMB: 128, messageTtlSeconds: 30}),
        });
        const result = await applyTopicPolicySync(client, syncParams([T1], ['retention', 'messageTtlSeconds']));
        const items = result.targets[0].items;
        assert(items.length === 2, `跳过也要让用户看见：${JSON.stringify(items)}`);
        const skipped = items.find(item => item.action === 'skip');
        assert(skipped.field === 'retention' && skipped.ok === true, `跳过不是失败：${JSON.stringify(skipped)}`);
        assert(/未开启 topic 级策略/.test(skipped.message || ''), `跳过应带原因：${JSON.stringify(skipped)}`);
        assert(result.succeeded === 1 && result.failed === 0, `跳过不该计入成败：${result.succeeded}/${result.failed}`);
        // retention 因为源侧读不出来被跳过；messageTtl 两侧都有值且不同 → 按源覆盖
        assert(client.writes.length === 1 && client.writes[0].kind === 'set', `只该有一次写入：${JSON.stringify(client.writes)}`);
        assert(
            client.writes[0].field === 'messageTtlSeconds' && client.writes[0].value === 60,
            `写入的字段与值不对：${JSON.stringify(client.writes[0])}`,
        );
        assert(
            client.writes[0].key === 'p/public/default/t1',
            `写到了别的 topic：${client.writes[0].key}`,
        );
    });

    await check('执行：目标读不通时一个字段都不动', async () => {
        const client = fakeClient(
            {'p/public/default/src': FULL, 'p/public/default/t1': syncView()},
            {failRead: [{key: 'p/public/default/t1'}]},
        );
        const result = await applyTopicPolicySync(client, syncParams([T1], ['messageTtlSeconds']));
        const t1 = result.targets.find(target => target.topic === 't1');
        assert(/读取目标 topic 策略失败/.test(t1.error || ''), `读不通的目标应带 error：${t1.error}`);
        assert(t1.items.length === 0, '读不通的目标不该有执行记录');
        assert(client.writes.length === 0, `读不通还在写：${KEYS(client.writes).join(',')}`);
        assert(result.succeeded === 0 && result.failed === 0, `计数不对：${result.succeeded}/${result.failed}`);
    });

    await check('执行：源读不通直接抛错（没有可比依据）', async () => {
        const client = fakeClient({'p/public/default/t1': syncView()});
        let message = '';
        try {
            await applyTopicPolicySync(client, syncParams([T1], ['messageTtlSeconds']));
        } catch (error) {
            message = error.message;
        }
        assert(/读取源 topic persistent\/public\/default\/src 失败/.test(message), `实际：${message}`);
        assert(client.writes.length === 0, '源读不通时不该有任何写入');
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
