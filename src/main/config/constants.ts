export const API_ENDPOINTS = {
    CLUSTERS: '/admin/v2/clusters',
    TENANTS: '/admin/v2/tenants',
    NAMESPACES: '/admin/v2/namespaces',
    TOPICS: '/admin/v2/topics',
    TOPICS_STATS: '/admin/v2/persistent',
    SUBSCRIPTIONS: '/admin/v2/subscriptions',
    HEALTH: '/admin/v2/health',
    HEALTH_ALT: '/health',
};

export const REQUEST_CONFIG = {
    TIMEOUT: 5000,
    MAX_CONCURRENT: 5,
    // 聚合类任务使用独立信号量，避免与叶子请求共用许可造成死锁
    MAX_CONCURRENT_AGGREGATE: 2,
    // 等待请求许可的上限，超时后报错而不是无限挂起
    ACQUIRE_TIMEOUT: 30000,
    // 聚合任务本身可能跑好几十秒，后一个聚合排队时用叶子请求的 30s 超时会误报，
    // 这里给聚合信号量一个更宽的等待上限。
    ACQUIRE_TIMEOUT_AGGREGATE: 120000,
    // 聚合内部扇出（如 getTenants 逐个取租户详情）的并发窗口。
    // 外层已持有许可、内部不能再 acquire，这里用本地上限兜住扇出规模。
    FANOUT_CONCURRENCY: 4,
    REQUEST_DELAY: 50,
    MAX_RETRIES: 3,
    RETRY_DELAY: 1000,
};

// 聚合遍历的规模上限：避免在大集群上产生数千次请求
export const AGGREGATION_LIMITS = {
    MAX_TENANTS: 50,
    MAX_NAMESPACES_PER_TENANT: 50,
    MAX_TOPICS_PER_NAMESPACE: 200,
    MAX_TOPICS: 500,
};
