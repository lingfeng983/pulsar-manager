/**
 * 官方插件目录。随应用打包，界面上以"可安装"的形式出现，
 * 点安装才落到 userData/plugins 里——和第三方插件走同一套校验与加载路径。
 */
import type {PluginManifest} from '../../shared/types';

export const OFFICIAL_PLUGINS: PluginManifest[] = [
    {
        id: 'pm-smoke-benchmarks',
        name: '冒烟与吞吐预设',
        version: '1.0.0',
        author: 'Pulsar Manager',
        description: '从"链路通不通"到"能打多快"的四档压测预设',
        contributions: {
            benchmarkPresets: [
                {
                    name: '快速冒烟',
                    description: '1000 条小消息全速发完，验证集群可用',
                    params: {
                        producers: 1,
                        totalMessages: 1000,
                        messageSizeBytes: 128,
                        ratePerSecond: 0,
                        maxInFlightPerProducer: 100,
                        batchingEnabled: true,
                        compression: 'None',
                        consumeBacklog: false,
                    },
                },
                {
                    name: '吞吐洪峰',
                    description: '8 生产者各 1000 条在途，LZ4 压缩，看峰值吞吐',
                    params: {
                        producers: 8,
                        totalMessages: 200000,
                        messageSizeBytes: 1024,
                        ratePerSecond: 0,
                        maxInFlightPerProducer: 1000,
                        batchingEnabled: true,
                        compression: 'LZ4',
                        consumeBacklog: false,
                    },
                },
                {
                    name: '延迟探测',
                    description: '单在途 + 关批，测到的基本就是真实 RTT',
                    params: {
                        producers: 1,
                        totalMessages: 20000,
                        messageSizeBytes: 256,
                        ratePerSecond: 1000,
                        maxInFlightPerProducer: 1,
                        batchingEnabled: false,
                        compression: 'None',
                        consumeBacklog: false,
                    },
                },
                {
                    name: '大消息',
                    description: '1 MB 消息体，观察大包下的带宽与确认延迟',
                    params: {
                        producers: 2,
                        totalMessages: 2000,
                        messageSizeBytes: 1048576,
                        ratePerSecond: 0,
                        maxInFlightPerProducer: 10,
                        batchingEnabled: false,
                        compression: 'ZSTD',
                        consumeBacklog: false,
                    },
                },
            ],
        },
    },
    {
        id: 'pm-end-to-end-benchmarks',
        name: '端到端读写预设',
        version: '1.0.0',
        author: 'Pulsar Manager',
        description: '边压边消费，跑完整的写入—积压—消费链路',
        contributions: {
            benchmarkPresets: [
                {
                    name: '恒定速率读写',
                    description: '限速 5000 msg/s 写入并同时消费，看稳态',
                    params: {
                        producers: 4,
                        totalMessages: 100000,
                        messageSizeBytes: 512,
                        ratePerSecond: 5000,
                        maxInFlightPerProducer: 200,
                        batchingEnabled: true,
                        compression: 'None',
                        consumeBacklog: true,
                    },
                },
                {
                    name: '积压追赶',
                    description: '先全速灌 30 万条再消费，看积压追赶速率',
                    params: {
                        producers: 6,
                        totalMessages: 300000,
                        messageSizeBytes: 2048,
                        ratePerSecond: 0,
                        maxInFlightPerProducer: 500,
                        batchingEnabled: true,
                        compression: 'ZSTD',
                        consumeBacklog: true,
                    },
                },
            ],
        },
    },
    {
        id: 'pm-topic-templates',
        name: '常用 Topic 模板',
        version: '1.0.0',
        author: 'Pulsar Manager',
        description: '新建 Topic 时一键套用分区数与持久化选择',
        contributions: {
            topicTemplates: [
                {
                    name: '标准分区',
                    description: '持久 + 4 分区，多数业务 topic 的默认选择',
                    persistent: true,
                    partitions: 4,
                },
                {
                    name: '单分区持久',
                    description: '持久 + 0 分区，需要严格顺序时用它',
                    persistent: true,
                    partitions: 0,
                },
                {
                    name: '非持久事件流',
                    description: '丢得起的埋点/日志类流量',
                    persistent: false,
                    partitions: 8,
                    namePrefix: 'evt-',
                },
                {
                    name: '高分区',
                    description: '持久 + 16 分区，多消费者横向扩',
                    persistent: true,
                    partitions: 16,
                },
            ],
        },
    },
    {
        id: 'pm-batch-tuning',
        name: '批量化对比预设',
        version: '1.0.0',
        author: 'Pulsar Manager',
        description: '同一份流量下开关批量与压缩，用于对照',
        contributions: {
            benchmarkPresets: [
                {
                    name: '关批量',
                    description: 'batching 关闭，逐条发送',
                    params: {
                        producers: 4,
                        totalMessages: 50000,
                        messageSizeBytes: 256,
                        ratePerSecond: 0,
                        maxInFlightPerProducer: 300,
                        batchingEnabled: false,
                        compression: 'None',
                        consumeBacklog: false,
                    },
                },
                {
                    name: '开批量',
                    description: '其余参数与"关批量"完全一致，只开批',
                    params: {
                        producers: 4,
                        totalMessages: 50000,
                        messageSizeBytes: 256,
                        ratePerSecond: 0,
                        maxInFlightPerProducer: 300,
                        batchingEnabled: true,
                        compression: 'None',
                        consumeBacklog: false,
                    },
                },
                {
                    name: '开批量 + Snappy',
                    description: '再叠一层压缩，看 CPU 换带宽的收益',
                    params: {
                        producers: 4,
                        totalMessages: 50000,
                        messageSizeBytes: 256,
                        ratePerSecond: 0,
                        maxInFlightPerProducer: 300,
                        batchingEnabled: true,
                        compression: 'SNAPPY',
                        consumeBacklog: false,
                    },
                },
            ],
        },
    },
];
