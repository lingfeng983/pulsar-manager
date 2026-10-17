// namespace-policy-api 的端点形状与折叠自测。本机没有可对照的 broker，
// 「哪个字段用 POST 还是 PUT、backlog 配额类型走查询参数还是请求体、
// Policies 里哪些键是下划线哪些是驼峰」这类事情只能靠这份假路由钉住。
// 跑法：npm run selftest:policies（先编译主进程，再跑这一份）。
const {
    NamespacePolicyAPI,
} = require('../dist/src/main/services/namespace-policy-api.js');
const {
    NAMESPACE_SYNC_MAX_TARGETS,
    applyNamespacePolicySync,
    planNamespacePolicySync,
    planPolicySync,
} = require('../dist/src/main/services/namespace-policy-sync.js');
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

// ========== 批量同步用的假客户端与假视图 ==========

// 折叠视图的骨架：全部字段按「未设置」起，用例只覆盖自己关心的那几个键。
// 手写整份视图比从真实 Policies 折出来更容易加字段，也更难被折叠层的改动悄悄带跑。
const BASE_VIEW = {
    messageTtlSeconds: null,
    subscriptionExpirationTimeMinutes: null,
    retentionTimeInMinutes: null,
    retentionSizeInMB: null,
    deduplicationEnabled: null,
    deduplicationSnapshotIntervalSeconds: null,
    backlogQuotas: [],
    maxProducersPerTopic: null,
    maxConsumersPerTopic: null,
    maxConsumersPerSubscription: null,
    maxUnackedMessagesPerConsumer: null,
    maxUnackedMessagesPerSubscription: null,
    maxSubscriptionsPerTopic: null,
    maxTopicsPerNamespace: null,
    compactionThreshold: null,
    schemaValidationEnforced: null,
    schemaCompatibilityStrategy: null,
    schemaAutoUpdateStrategy: null,
    allowAutoUpdateSchema: null,
    encryptionRequired: null,
    subscriptionTypesEnabled: [],
    subscriptionAuthMode: null,
    replicationClusters: [],
    allowedClusters: [],
    resourceGroupName: null,
    dispatchRate: null,
    subscriptionDispatchRate: null,
    subscribeRate: null,
    publishRate: null,
    replicatorDispatchRate: null,
    clearableFields: [],
    raw: {},
};

const view = extra => ({...BASE_VIEW, ...extra});

// 记录每一次写入：批量同步最容易出的错是「写到了别的命名空间」和「该中止时继续写」，
// 这两件事都只能从写入序列里看出来。
function fakeClient(views, options = {}) {
    const writes = [];
    const fail = (kind, key, field) => {
        const list = options[kind] || [];
        return list.some(item => item.key === key && (item.field === undefined || item.field === field));
    };
    return {
        writes,
        async getPolicies(tenant, namespace) {
            const key = `${tenant}/${namespace}`;
            if (!views[key]) {
                throw new Error(`读不到 ${key}`);
            }
            if (fail('failRead', key)) {
                throw new Error(`读取失败：${key}`);
            }
            return views[key];
        },
        async setNamespacePolicy(tenant, namespace, field, value) {
            const key = `${tenant}/${namespace}`;
            if (fail('failWrite', key, field)) {
                throw new Error(`broker 拒绝：${field}`);
            }
            writes.push({kind: 'set', key, field, value});
        },
        async clearNamespacePolicy(tenant, namespace, field, quotaType) {
            const key = `${tenant}/${namespace}`;
            if (fail('failWrite', key, field)) {
                throw new Error(`broker 拒绝：${field}`);
            }
            writes.push({kind: 'clear', key, field, quotaType});
        },
    };
}

const scope = (tenant, namespace) => ({tenant, namespace});
const KEYS = list => list.map(item => item.key);

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

    await check('复制集群整表覆盖用 POST + 可重复 clusters 查询参数（不是 JSON 数组请求体）', async () => {
        const {api, http} = writeApi();
        await api.setPolicy('public', 'default', 'replicationClusters', ['cluster-a', 'cluster b']);
        assert(
            http.calls[0].url ===
                '/admin/v2/namespaces/public/default/replication?clusters=cluster-a&clusters=cluster%20b',
            `集群名应逐个放进 clusters 查询参数：${http.calls[0].url}`,
        );
        assert(http.calls[0].method === 'post', `应为 POST，实际 ${http.calls[0].method}`);
        assert(http.calls[0].body === undefined, `请求体应为空，实际 ${JSON.stringify(http.calls[0].body)}`);
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

    // ========== 批量同步：差异计算 ==========

    await check('值相同的字段不产生差异，数组按集合比较', async () => {
        const source = view({
            messageTtlSeconds: 60,
            // 顺序不同不算差异：broker 把 replication_clusters 当集合用
            replicationClusters: ['cluster-b', 'cluster-a'],
            // 周期缺失时按 1 归一，否则每次预览都会报一条"要改"
            dispatchRate: {msgPerPeriod: 1000, bytePerPeriod: -1, periodInSeconds: null, raw: {}},
        });
        const target = view({
            messageTtlSeconds: 60,
            replicationClusters: ['cluster-a', 'cluster-b'],
            dispatchRate: {msgPerPeriod: 1000, bytePerPeriod: -1, periodInSeconds: 1, raw: {}},
        });
        const deltas = planPolicySync(source, target, [
            'messageTtlSeconds',
            'replicationClusters',
            'dispatchRate',
        ]);
        assert(deltas.length === 0, `相同值不该有差异：${JSON.stringify(deltas)}`);
    });

    await check('发布限速没有周期字段，比对时不能凭空补一个', async () => {
        const base = {msgPerPeriod: 100, bytePerPeriod: 2097152, raw: {}};
        const deltas = planPolicySync(
            view({publishRate: {...base, periodInSeconds: 30}}),
            view({publishRate: {...base, periodInSeconds: 1}}),
            ['publishRate'],
        );
        assert(deltas.length === 0, `publishRate 的周期在 broker 侧不存在：${JSON.stringify(deltas)}`);
    });

    await check('源未设置：能清除的清除，不能清除的说清原因', async () => {
        const source = view();
        const target = view({retentionTimeInMinutes: 60, retentionSizeInMB: 128, encryptionRequired: true});
        const deltas = planPolicySync(source, target, ['retention', 'encryptionRequired']);
        // 字段表顺序在前面的排在前面
        assert(deltas.length === 2, `应各出一条，实际 ${JSON.stringify(deltas)}`);
        assert(deltas[0].field === 'retention' && deltas[0].action === 'clear', `retention 应清除：${JSON.stringify(deltas[0])}`);
        assert(deltas[1].field === 'encryptionRequired' && deltas[1].action === 'skip', `无 DELETE 端点应跳过：${JSON.stringify(deltas[1])}`);
        assert(/没有清除端点/.test(deltas[1].reason || ''), `跳过要带原因，实际：${deltas[1].reason}`);
    });

    await check('差异顺序按字段表走，不受调用方传参顺序影响', async () => {
        const source = view({messageTtlSeconds: 60, deduplicationEnabled: true});
        const fields = ['deduplicationEnabled', 'messageTtlSeconds'];
        const one = planPolicySync(source, view(), fields);
        const other = planPolicySync(source, view(), [...fields].reverse());
        assert(
            JSON.stringify(one.map(item => item.field)) === JSON.stringify(['messageTtlSeconds', 'deduplicationEnabled']),
            `字段顺序应稳定：${JSON.stringify(one.map(item => item.field))}`,
        );
        assert(JSON.stringify(one) === JSON.stringify(other), '同一份配置换个传参顺序，预览与日志就该对得上');
    });

    await check('积压配额逐条比对：源有目标无要写，目标多出要清', async () => {
        const source = view({
            backlogQuotas: [{type: 'message_age', limitSizeBytes: 0, limitTimeSeconds: 600, policy: 'consumer_backlog_eviction'}],
        });
        const target = view({
            backlogQuotas: [{type: 'destination_storage', limitSizeBytes: 1024, limitTimeSeconds: 0, policy: 'producer_exception'}],
        });
        const deltas = planPolicySync(source, target, ['backlogQuota']);
        assert(deltas.length === 2, `应一条 set 一条 clear，实际 ${JSON.stringify(deltas)}`);
        assert(
            deltas[0].action === 'set' && deltas[0].quotaType === 'message_age',
            `源上的配额应写入：${JSON.stringify(deltas[0])}`,
        );
        assert(
            deltas[0].value.limitTimeSeconds === 600 && deltas[0].value.type === 'message_age',
            `写入值要能直接喂给 setPolicy：${JSON.stringify(deltas[0].value)}`,
        );
        assert(
            deltas[1].action === 'clear' && deltas[1].quotaType === 'destination_storage',
            `目标上多出的配额应清除（同步语义是等于源）：${JSON.stringify(deltas[1])}`,
        );
    });

    await check('积压配额里我们不认识的枚举跳过写入，但清除照常', async () => {
        // 写入前有本地校验，未知枚举必定被自己拦下；清除不校验枚举，
        // 而且那本来就是 broker 自己报出来的类型，不该由我们判断它存不存在。
        const source = view({
            backlogQuotas: [{type: 'some_future_type', limitSizeBytes: 10, limitTimeSeconds: 0, policy: 'producer_request_hold'}],
        });
        const target = view({
            backlogQuotas: [{type: 'another_future_type', limitSizeBytes: 20, limitTimeSeconds: 0, policy: 'producer_request_hold'}],
        });
        const deltas = planPolicySync(source, target, ['backlogQuota']);
        assert(deltas.length === 2, `实际 ${JSON.stringify(deltas)}`);
        assert(deltas[0].action === 'skip' && /枚举/.test(deltas[0].reason || ''), `未知类型应跳过并说明：${JSON.stringify(deltas[0])}`);
        assert(deltas[1].action === 'clear' && deltas[1].quotaType === 'another_future_type', `未知类型仍应清除：${JSON.stringify(deltas[1])}`);

        const badPolicy = view({
            backlogQuotas: [{type: 'message_age', limitSizeBytes: 0, limitTimeSeconds: 60, policy: 'some_future_policy'}],
        });
        const more = planPolicySync(badPolicy, view(), ['backlogQuota']);
        assert(more[0].action === 'skip' && /超限策略/.test(more[0].reason || ''), `未知策略应跳过：${JSON.stringify(more[0])}`);
    });

    await check('只读出一半的保留策略不参与同步', async () => {
        // POST /retention 是整体替换，缺的那个数字补 0 会把无限保留变成一条不留
        const deltas = planPolicySync(view({retentionTimeInMinutes: -1}), view({retentionSizeInMB: 512}), ['retention']);
        assert(deltas.length === 0, `源上读不全就该什么都不做：${JSON.stringify(deltas)}`);
    });

    // ========== 批量同步：预览与执行 ==========

    const SRC = scope('public', 'src');
    const T1 = scope('public', 't1');
    const T2 = scope('public', 't2');
    const params = (targets, fields) => ({clusterId: 'c', source: SRC, targets, fields});
    const FULL = view({
        messageTtlSeconds: 60,
        retentionTimeInMinutes: -1,
        retentionSizeInMB: 512,
        deduplicationEnabled: true,
    });

    await check('目标清单去重、剔除源本身、上限拦截', async () => {
        const onlySource = fakeClient({'public/src': FULL});
        let message = '';
        try {
            await planNamespacePolicySync(onlySource, params([scope('public', 'src')], ['messageTtlSeconds']));
        } catch (error) {
            message = error.message;
        }
        assert(/不能就是源本身/.test(message), `同步到自己身上应被拦下，实际：${message}`);
        assert(onlySource.writes.length === 0, '拦下后不该有任何写入');

        const dup = fakeClient({'public/src': FULL, 'public/t1': view()});
        const plan = await planNamespacePolicySync(dup, params([T1, T1, scope('public', 'src')], ['messageTtlSeconds']));
        assert(plan.targets.length === 1, `重复目标要去重，实际 ${plan.targets.length}`);

        const many = Array.from({length: NAMESPACE_SYNC_MAX_TARGETS + 1}, (_, index) =>
            scope('public', `n${index}`),
        );
        const capped = fakeClient({'public/src': FULL});
        let capMessage = '';
        try {
            await applyNamespacePolicySync(capped, params(many, ['messageTtlSeconds']));
        } catch (error) {
            capMessage = error.message;
        }
        assert(/一次最多同步/.test(capMessage), `超出上限应拦下，实际：${capMessage}`);
        assert(capped.writes.length === 0, '拦下后不该有任何写入');
    });

    await check('预览：源读不通返回结构化错误，不抛异常', async () => {
        const client = fakeClient({'public/t1': view()});
        const plan = await planNamespacePolicySync(client, params([T1], ['messageTtlSeconds']));
        assert(/读不到 public\/src/.test(plan.sourceError || ''), `应带来源命名空间的读失败：${plan.sourceError}`);
        assert(plan.targets.length === 0, '源读不通时不该给出任何目标差异');
        assert(client.writes.length === 0, '预览不该有任何写入');
    });

    await check('预览：目标读不通只标错自己，不拖累别的目标', async () => {
        const client = fakeClient({'public/src': FULL, 'public/t1': view(), 'public/t2': view()});
        const plan = await planNamespacePolicySync(client, params([T1, scope('public', 'missing')], ['messageTtlSeconds']));
        const failed = plan.targets.find(target => target.tenant === 'public' && target.namespace === 'missing');
        assert(failed && /读不到/.test(failed.error || ''), `读不通的目标应带 error：${JSON.stringify(failed)}`);
        assert(failed.deltas.length === 0, '读不通的目标不该给出差异');
        const ok = plan.targets.find(target => target.namespace === 't1');
        assert(ok.deltas.length === 1 && ok.deltas[0].action === 'set', `别的目标照常算差异：${JSON.stringify(ok)}`);
    });

    await check('预览回来的视图剥掉 raw，整份 Policies 不过 IPC', async () => {
        const client = fakeClient({
            'public/src': view({raw: {huge: 'x'}, dispatchRate: {msgPerPeriod: 1, bytePerPeriod: 1, periodInSeconds: 1, raw: {huge: 'y'}}}),
            'public/t1': view({raw: {huge: 'z'}}),
        });
        const plan = await planNamespacePolicySync(client, params([T1], ['messageTtlSeconds']));
        assert(Object.keys(plan.sourceView.raw).length === 0, '源视图的 raw 应被剥掉');
        assert(Object.keys(plan.sourceView.dispatchRate.raw).length === 0, '限速的 raw 应被剥掉');
        assert(Object.keys(plan.targets[0].view.raw).length === 0, '目标视图的 raw 应被剥掉');
        assert(plan.sourceView.messageTtlSeconds === 1 || plan.sourceView.messageTtlSeconds === null, '折叠字段本身要留着');
    });

    await check('执行：写到正确的命名空间，失败即中止本目标', async () => {
        const client = fakeClient(
            {'public/src': FULL, 'public/t1': view(), 'public/t2': view({retentionTimeInMinutes: -1, retentionSizeInMB: 512})},
            // t1 的第二项（retention）失败，第三项（deduplication）不该再发
            {failWrite: [{key: 'public/t1', field: 'retention'}]},
        );
        const result = await applyNamespacePolicySync(client, params([T1, T2], ['messageTtlSeconds', 'retention', 'deduplicationEnabled']));
        assert(
            result.targets.every(target => ['public/t1', 'public/t2'].includes(`${target.tenant}/${target.namespace}`)),
            `写到了别的命名空间：${JSON.stringify(result.targets.map(t => `${t.tenant}/${t.namespace}`))}`,
        );
        const t1 = result.targets.find(target => target.namespace === 't1');
        assert(
            t1.items.map(item => `${item.field}:${item.ok}`).join(',') === 'messageTtlSeconds:true,retention:false',
            `失败项之后不该继续执行，也不该假装执行过：${JSON.stringify(t1.items)}`,
        );
        assert(/broker 拒绝/.test(t1.items[1].message || ''), `失败项要带上 broker 的话：${JSON.stringify(t1.items[1])}`);
        const t2 = result.targets.find(target => target.namespace === 't2');
        assert(t2.items.length === 2, `t2 的 retention 与源相同，不该有第三项：${JSON.stringify(t2.items)}`);
        assert(
            client.writes.filter(item => item.key === 'public/t2' && item.field === 'retention').length === 0,
            '相同的值不该下发',
        );
        assert(client.writes.every(item => item.key !== 'public/src'), '源命名空间不该被写');
        // 下发的是折叠视图还原出来的值，不是视图本身
        const ttl = client.writes.find(item => item.key === 'public/t2' && item.field === 'messageTtlSeconds');
        assert(ttl.kind === 'set' && ttl.value === 60, `TTL 应写成裸数字 60：${JSON.stringify(ttl)}`);
        const dedup = client.writes.find(item => item.key === 'public/t2' && item.field === 'deduplicationEnabled');
        assert(dedup.value === true, `去重应写成布尔 true：${JSON.stringify(dedup)}`);
        // t1 成功 1 项、失败 1 项；t2 成功 2 项
        assert(result.succeeded === 3 && result.failed === 1, `计数不对：成功 ${result.succeeded}，失败 ${result.failed}`);
    });

    await check('执行：跳过项如实列出且不进成败计数', async () => {
        const client = fakeClient({
            'public/src': view(),
            'public/t1': view({encryptionRequired: true, messageTtlSeconds: 30}),
        });
        const result = await applyNamespacePolicySync(client, params([T1], ['encryptionRequired', 'messageTtlSeconds']));
        const items = result.targets[0].items;
        assert(items.length === 2, `跳过也要让用户看见：${JSON.stringify(items)}`);
        const skipped = items.find(item => item.action === 'skip');
        assert(skipped.field === 'encryptionRequired' && skipped.ok === true, `跳过不是失败：${JSON.stringify(skipped)}`);
        assert(/没有清除端点/.test(skipped.message || ''), `跳过应带原因：${JSON.stringify(skipped)}`);
        assert(result.succeeded === 1 && result.failed === 0, `跳过不该计入成败：${result.succeeded}/${result.failed}`);
        assert(KEYS(client.writes).every(key => key === 'public/t1'), `写入落错地方：${KEYS(client.writes).join(',')}`);
        // 另一项是 messageTtl：源没设过、目标设成 30，同步语义下这是「清除回默认」而不是「写成 0」
        assert(client.writes.length === 1 && client.writes[0].kind === 'clear', `只该有一次清除调用：${JSON.stringify(client.writes)}`);
        assert(client.writes[0].field === 'messageTtlSeconds', `清除的字段不对：${JSON.stringify(client.writes[0])}`);
    });

    await check('执行：清除走 clear，并带上配额类型', async () => {
        const client = fakeClient({
            'public/src': view(),
            'public/t1': view({
                backlogQuotas: [{type: 'message_age', limitSizeBytes: 0, limitTimeSeconds: 600, policy: 'consumer_backlog_eviction'}],
            }),
        });
        const result = await applyNamespacePolicySync(client, params([T1], ['backlogQuota']));
        assert(result.succeeded === 1 && result.failed === 0, JSON.stringify(result.targets[0].items));
        const write = client.writes[0];
        assert(write.kind === 'clear' && write.field === 'backlogQuota' && write.quotaType === 'message_age', `清除配额要点名类型：${JSON.stringify(write)}`);
    });

    await check('执行：目标读不通时一个字段都不动', async () => {
        const client = fakeClient(
            {'public/src': FULL, 'public/t1': view(), 'public/t2': view()},
            {failRead: [{key: 'public/t2'}]},
        );
        const result = await applyNamespacePolicySync(client, params([T1, T2], ['messageTtlSeconds']));
        const t2 = result.targets.find(target => target.namespace === 't2');
        assert(/读取目标命名空间策略失败/.test(t2.error || ''), `读不通的目标应带 error：${t2.error}`);
        assert(t2.items.length === 0, '读不通的目标不该有执行记录');
        assert(KEYS(client.writes).every(key => key === 'public/t1'), `读不通还在写别的命名空间：${KEYS(client.writes).join(',')}`);
        assert(result.succeeded === 1 && result.failed === 0, `计数不对：${result.succeeded}/${result.failed}`);
    });

    await check('执行：源读不通直接抛错（没有可比依据）', async () => {
        const client = fakeClient({'public/t1': view()});
        let message = '';
        try {
            await applyNamespacePolicySync(client, params([T1], ['messageTtlSeconds']));
        } catch (error) {
            message = error.message;
        }
        assert(/读取源命名空间 public\/src 失败/.test(message), `实际：${message}`);
        assert(client.writes.length === 0, '源读不通时不该有任何写入');
    });

    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();
