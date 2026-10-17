// namespace-policy-api 的端点形状与折叠自测。本机没有可对照的 broker，
// 「哪个字段用 POST 还是 PUT、backlog 配额类型走查询参数还是请求体、
// Policies 里哪些键是下划线哪些是驼峰」这类事情只能靠这份假路由钉住。
// 跑法：npm run selftest:policies（先编译主进程，再跑这一份）。
const {
    NamespacePolicyAPI,
} = require('../dist/src/main/services/namespace-policy-api.js');
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

// 只做精确匹配：前缀兜底会把「这条 URL 根本不该出现」伪装成一次正常响应。
// 查询参数单独记在 config.params 里断言——broker 侧的配额类型就走那里，
// 拼进 URL 或塞进请求体都是错的。
function fakeHttp(routes) {
    const calls = [];
    const act = (method, url, body, config) => {
        calls.push({method, url, body, params: config && config.params});
        const route = routes[`${method} ${url}`];
        if (!route) {
            return Promise.reject(new NotFoundError(url));
        }
        return Promise.resolve({data: route.data});
    };
    return {
        calls,
        get: (url, config) => act('get', url, undefined, config),
        post: (url, body, config) => act('post', url, body, config),
        put: (url, body, config) => act('put', url, body, config),
        delete: (url, config) => act('delete', url, undefined, config),
    };
}

function apiWith(routes) {
    const http = fakeHttp(routes);
    return {api: new NamespacePolicyAPI(http, new Semaphore(5)), http};
}

// 写入侧只关心「发出去的请求长什么样」，响应体没有读者，所以这里任何请求都算成功。
// 代价是路径写错不会再报 404，因此每条用例必须自己断言完整 URL——
// 只断言 method 或 endsWith 的话，这一段就变成自证。
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
        put: (url, body, config) => act('put', url, body, config),
        delete: (url, config) => act('delete', url, undefined, config),
    };
}

function writeApi() {
    const http = okHttp();
    return {api: new NamespacePolicyAPI(http, new Semaphore(5)), http};
}

// 一份尽量像真实 broker 响应的 Policies：下划线与驼峰混用，
// 0 与 null 都得有，retention 用 -1 表示无限。
const POLICIES = {
    // broker 实际发的是下划线这一族
    message_ttl_in_seconds: 0,
    subscription_expiration_time_minutes: 10080,
    retention_policies: {retentionTimeInMinutes: -1, retentionSizeInMB: 512},
    replication_clusters: ['cluster-b', 'cluster-a'],
    allowed_clusters: ['use'],
    max_producers_per_topic: null,
    max_consumers_per_topic: 2,
    backlog_quota_map: {
        message_age: {limitSize: 0, limitTime: 3600, policy: 'consumer_backlog_eviction'},
        destination_storage: {limit: 1073741824, limitTime: 0, policy: 'producer_exception'},
        some_future_type: {limitSize: 10, limitTime: 0, policy: 'unknown_policy'},
    },
    // 这一族是驼峰
    deduplicationEnabled: true,
    deduplicationSnapshotIntervalSeconds: 900,
    schemaValidationEnforced: false,
    isAllowAutoUpdateSchema: true,
    encryption_required: false,
    schema_compatibility_strategy: 'BACKWARD',
    subscription_types_enabled: ['Shared', 'Key_Shared'],
    compaction_threshold: 50000,
    resource_group_name: null,
};

const RATE_ROUTES = {
    'get /admin/v2/namespaces/public/default/dispatchRate': {
        data: {dispatchThrottlingRateInMsg: 1000, dispatchThrottlingRateInByte: 1048576, ratePeriodInSecond: 1},
    },
    'get /admin/v2/namespaces/public/default/subscriptionDispatchRate': {
        data: {dispatchThrottlingRateInMsg: -1, dispatchThrottlingRateInByte: -1, ratePeriodInSecond: 1},
    },
    'get /admin/v2/namespaces/public/default/subscribeRate': {
        data: {subscribeThrottlingRatePerConsumer: 30, ratePeriodInSecond: 30},
    },
    'get /admin/v2/namespaces/public/default/publishRate': {
        data: {publishThrottlingRateInMsg: 100, publishThrottlingRateInByte: 2097152},
    },
    // replicatorDispatchRate 故意不写路由：老 broker 没有这个端点，
    // 缺它不能让整页失败
};

const READ_ROUTES = {
    'get /admin/v2/namespaces/public/default': {data: POLICIES},
    ...RATE_ROUTES,
};

(async () => {
    await check('折叠混用的下划线与驼峰键，并区分 0 / null / -1', async () => {
        const {api} = apiWith(READ_ROUTES);
        const view = await api.getPolicies('public', 'default');
        assert(view.messageTtlSeconds === 0, `TTL 应为 0，实际 ${view.messageTtlSeconds}`);
        assert(view.maxProducersPerTopic === null, '未设置的字段应折叠成 null');
        assert(view.maxConsumersPerTopic === 2, '下划线驼峰都要取到');
        assert(view.retentionTimeInMinutes === -1, '无限保留要保留 -1，不能塌成 0');
        assert(view.retentionSizeInMB === 512, 'retention_policies 嵌套对象没取到');
        assert(view.deduplicationEnabled === true, '驼峰的 deduplicationEnabled 没读到');
        assert(view.encryptionRequired === false, 'encryption_required=false 应照原值返回，不是未设置');
        assert(view.schemaValidationEnforced === false, 'schema_validation_enforced 没读到');
        assert(view.allowAutoUpdateSchema === true, 'is_allow_auto_update_schema 没读到');
        assert(view.compactionThreshold === 50000, 'compaction_threshold 没读到');
        assert(
            JSON.stringify(view.replicationClusters) === JSON.stringify(['cluster-b', 'cluster-a']),
            `复制集群原样返回即可：${JSON.stringify(view.replicationClusters)}`,
        );
        assert(JSON.stringify(view.allowedClusters) === JSON.stringify(['use']), 'allowed_clusters 没读到');
        assert(JSON.stringify(view.subscriptionTypesEnabled) === JSON.stringify(['Shared', 'Key_Shared']), '订阅类型没读到');
        assert(view.raw.message_ttl_in_seconds === 0, 'raw 要留整份原始 Policies');
    });

    await check('积压配额逐条折叠：legacy limit 兜底、未知类型不丢', async () => {
        const {api} = apiWith(READ_ROUTES);
        const view = await api.getPolicies('public', 'default');
        assert(view.backlogQuotas.length === 3, `三条配额应全部列出，实际 ${view.backlogQuotas.length}`);
        // 已知类型排在前面：destination_storage 在 message_age 之前
        assert(view.backlogQuotas[0].type === 'destination_storage', `顺序不对：${view.backlogQuotas.map(q => q.type).join(',')}`);
        assert(view.backlogQuotas[0].limitSizeBytes === 1073741824, '老 broker 只发 limit，折叠要兜住');
        assert(view.backlogQuotas[0].policy === 'producer_exception', '超限策略没读到');
        assert(view.backlogQuotas[1].limitTimeSeconds === 3600, 'message_age 的时限没读到');
        assert(view.backlogQuotas[2].type === 'some_future_type', '未知配额类型不能被丢掉');
        assert(view.backlogQuotas[2].policy === 'unknown_policy', '未知策略要显示原文而不是换成认识的值');
    });

    await check('限速各用专用端点，缺端点不影响整页', async () => {
        const {api} = apiWith(READ_ROUTES);
        const view = await api.getPolicies('public', 'default');
        assert(view.dispatchRate.msgPerPeriod === 1000, '分发限速没折叠');
        assert(view.subscribeRate.msgPerPeriod === 30, 'subscribeRate 的键名是 subscribeThrottlingRatePerConsumer');
        assert(view.subscribeRate.periodInSeconds === 30, '订阅限速周期没读到');
        assert(view.publishRate.bytePerPeriod === 2097152, 'publishRate 的键名是 publishThrottlingRateInByte');
        assert(view.publishRate.periodInSeconds === null, 'publishRate 在 broker 侧没有周期字段');
        assert(view.replicatorDispatchRate === null, '老 broker 缺端点时应折叠成未设置');
    });

    await check('messageTTL 走 /messageTTL 且值是裸数字（秒）', async () => {
        const {api, http} = writeApi();
        await api.setPolicy('public', 'default', 'messageTtlSeconds', 60);
        const call = http.calls[0];
        assert(call.method === 'post', `应为 POST，实际 ${call.method}`);
        assert(call.url === '/admin/v2/namespaces/public/default/messageTTL', `路径不对：${call.url}`);
        assert(call.body === 60, `请求体应为裸数字 60，实际 ${JSON.stringify(call.body)}`);
    });

    await check('订阅过期时间端点名是 subscriptionExpirationTime（不带 Minutes）', async () => {
        const {api, http} = writeApi();
        await api.setPolicy('public', 'default', 'subscriptionExpirationTimeMinutes', 7);
        assert(
            http.calls[0].url === '/admin/v2/namespaces/public/default/subscriptionExpirationTime',
            `路径不对：${http.calls[0].url}`,
        );
        assert(http.calls[0].body === 7, `这个端点的单位就是分钟， body 应为裸数字 7：${JSON.stringify(http.calls[0].body)}`);
    });

    await check('backlogQuota 的类型走查询参数，请求体不带 type', async () => {
        const {api, http} = writeApi();
        await api.setPolicy('public', 'default', 'backlogQuota', {
            type: 'message_age',
            limitSizeBytes: 1024 * 1024 * 64,
            limitTimeSeconds: 600,
            policy: 'consumer_backlog_eviction',
        });
        const call = http.calls[0];
        assert(call.url === '/admin/v2/namespaces/public/default/backlogQuota', `路径不对：${call.url}`);
        assert(call.params && call.params.backlogQuotaType === 'message_age', `类型应在查询参数里：${JSON.stringify(call.params)}`);
        assert(!('type' in call.body), '请求体里的 type 会被 broker 拒成 400');
        assert(call.body.limitSize === 67108864, `limitSize 应为字节：${JSON.stringify(call.body)}`);
        assert(call.body.limitTime === 600 && call.body.policy === 'consumer_backlog_eviction', '请求体字段不全');
    });

    await check('compactionThreshold 用 PUT，max* 用 POST', async () => {
        const {api, http} = writeApi();
        await api.setPolicy('public', 'default', 'compactionThreshold', 0);
        await api.setPolicy('public', 'default', 'maxProducersPerTopic', 0);
        assert(http.calls[0].method === 'put', `compactionThreshold 应为 PUT，实际 ${http.calls[0].method}`);
        assert(
            http.calls[0].url === '/admin/v2/namespaces/public/default/compactionThreshold',
            `路径不对：${http.calls[0].url}`,
        );
        assert(http.calls[1].method === 'post', `maxProducersPerTopic 应为 POST，实际 ${http.calls[1].method}`);
        assert(
            http.calls[1].url === '/admin/v2/namespaces/public/default/maxProducersPerTopic',
            `路径不对：${http.calls[1].url}`,
        );
        // 0 是有效值（关闭压缩 / 不限），不能被当成"没填"丢掉
        assert(http.calls[0].body === 0 && http.calls[1].body === 0, '0 必须原样下发');
    });

    await check('限速请求体按各自键名还原，publish 不发周期', async () => {
        const {api, http} = writeApi();
        await api.setPolicy('public', 'default', 'dispatchRate', {
            msgPerPeriod: 1000,
            bytePerPeriod: 1048576,
            periodInSeconds: 2,
        });
        await api.setPolicy('public', 'default', 'subscribeRate', {
            msgPerPeriod: 30,
            bytePerPeriod: -1,
            periodInSeconds: 30,
        });
        await api.setPolicy('public', 'default', 'publishRate', {msgPerPeriod: 100, bytePerPeriod: 2097152});
        await api.setPolicy('public', 'default', 'subscriptionDispatchRate', {
            msgPerPeriod: 50,
            bytePerPeriod: -1,
            periodInSeconds: 1,
        });
        assert(
            http.calls[0].url === '/admin/v2/namespaces/public/default/dispatchRate' &&
                http.calls[1].url === '/admin/v2/namespaces/public/default/subscribeRate' &&
                http.calls[2].url === '/admin/v2/namespaces/public/default/publishRate' &&
                http.calls[3].url === '/admin/v2/namespaces/public/default/subscriptionDispatchRate',
            `限速端点路径不对：${http.calls.map(c => c.url).join(' | ')}`,
        );
        // dispatchRate 与 subscriptionDispatchRate 只差一个前缀，写错一个字面量
        // 就会把「整个命名空间的分发限速」改成「按订阅的限速」，broker 两边都收。
        assert(
            http.calls[3].body.dispatchThrottlingRateInMsg === 50 &&
                !('subscribeThrottlingRatePerConsumer' in http.calls[3].body),
            `按订阅限速形状不对：${JSON.stringify(http.calls[3].body)}`,
        );
        assert(
            http.calls[0].body.dispatchThrottlingRateInMsg === 1000 &&
                http.calls[0].body.dispatchThrottlingRateInByte === 1048576 &&
                http.calls[0].body.ratePeriodInSecond === 2,
            `分发限速形状不对：${JSON.stringify(http.calls[0].body)}`,
        );
        assert(
            http.calls[1].body.subscribeThrottlingRatePerConsumer === 30 &&
                http.calls[1].body.ratePeriodInSecond === 30 &&
                !('dispatchThrottlingRateInByte' in http.calls[1].body),
            `订阅限速形状不对：${JSON.stringify(http.calls[1].body)}`,
        );
        assert(
            http.calls[2].body.publishThrottlingRateInMsg === 100 &&
                !('ratePeriodInSecond' in http.calls[2].body),
            `发布限速不该带周期字段：${JSON.stringify(http.calls[2].body)}`,
        );
    });

    await check('清除：有 DELETE 的走 DELETE，没有的说人话', async () => {
        const {api, http} = writeApi();
        await api.clearPolicy('public', 'default', 'retention');
        assert(
            http.calls[0].method === 'delete' &&
                http.calls[0].url === '/admin/v2/namespaces/public/default/retention',
            `清除应是 DELETE：${JSON.stringify(http.calls[0])}`,
        );

        let message = '';
        try {
            await api.clearPolicy('public', 'default', 'encryptionRequired');
        } catch (error) {
            message = error.message;
        }
        assert(/没有删除端点/.test(message), `无 DELETE 的字段应解释清楚，实际：${message}`);
        assert(http.calls.length === 1, '不该对没有 DELETE 的端点发请求');
    });

    await check('清除积压配额必须点名类型', async () => {
        const {api, http} = writeApi();
        await api.clearPolicy('public', 'default', 'backlogQuota', 'message_age');
        assert(
            http.calls[0].method === 'delete' &&
                http.calls[0].url === '/admin/v2/namespaces/public/default/backlogQuota',
            `清除配额应是 DELETE：${JSON.stringify(http.calls[0])}`,
        );
        assert(
            http.calls[0].params && http.calls[0].params.backlogQuotaType === 'message_age',
            `DELETE 也要带类型：${JSON.stringify(http.calls[0].params)}`,
        );

        let message = '';
        try {
            await api.clearPolicy('public', 'default', 'backlogQuota');
        } catch (error) {
            message = error.message;
        }
        assert(/必须是/.test(message), `缺类型应被拦下，实际：${message}`);
        assert(http.calls.length === 1, '没点名类型时不该发出第二条 DELETE');
    });

    await check('复制集群整表覆盖用 POST 数组（broker 没有 enable/disable 单集群端点）', async () => {
        const {api, http} = writeApi();
        await api.setPolicy('public', 'default', 'replicationClusters', ['cluster-a', 'cluster-b']);
        assert(
            http.calls[0].url === '/admin/v2/namespaces/public/default/replication',
            `路径不对：${http.calls[0].url}`,
        );
        assert(http.calls[0].method === 'post', `应为 POST，实际 ${http.calls[0].method}`);
        assert(Array.isArray(http.calls[0].body), '请求体应是集群名数组');
    });

    await check('字段级校验拦掉拼错的枚举与越界数字', async () => {
        // 这一条继续用严格路由：校验如果没生效，请求会打到空路由表上变成 404，
        // 下面按「不是 404」判定，比只看"有没有报错"更能区分校验拦截和路由缺失。
        const {api, http} = apiWith({});
        const cases = [
            ['messageTtlSeconds', '60', '字符串'],
            ['messageTtlSeconds', -1, '负数'],
            ['deduplicationEnabled', 'true', '布尔写成字符串'],
            ['schemaCompatibilityStrategy', 'backward', '枚举大小写'],
            ['backlogQuota', {type: 'destination_storage', limitSizeBytes: 1, limitTimeSeconds: 0, policy: 'consumer_backpressure'}, '策略名拼错'],
            ['replicationClusters', 'cluster-a', '数组写成字符串'],
        ];
        for (const [field, value, why] of cases) {
            let message = '';
            try {
                await api.setPolicy('public', 'default', field, value);
            } catch (error) {
                message = error.message;
            }
            // 只要求"有报错"不够：假路由没配全时会漏出 404，那也是报错，
            // 但校验其实根本没生效。
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
            await api.setPolicy('public', 'default', 'notAField', 1);
        } catch (error) {
            message = error.message;
        }
        assert(/不支持修改/.test(message), `实际：${message}`);
        assert(http.calls.length === 0, '不该发出任何请求');
    });

    await check('清除名单随视图返回（界面据此决定清除按钮）', async () => {
        const {api} = apiWith(READ_ROUTES);
        const view = await api.getPolicies('public', 'default');
        assert(view.clearableFields.includes('retention'), 'retention 应可清除');
        assert(!view.clearableFields.includes('encryptionRequired'), 'encryptionRequired 没有 DELETE 端点');
        assert(!view.clearableFields.includes('replicationClusters'), '复制集群没有清除端点');
    });

    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();
