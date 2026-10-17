import type {TopicPolicyField, TopicPolicyView} from '../../types';

// Topic 级策略的展示与编辑口径。端点与取值范围在主进程的字段表里
// （topic-policy-api.ts），这一份只管「人怎么看、怎么填」，
// 面板、编辑弹窗与后面的对比/同步都从这里取文案，避免同一个字段两套单位。

export const NOT_SET = '未设置（沿用命名空间）';

// broker 用 -1 表示「该维度不限」，0 表示「一条都不留」，读不到才是「没设过」。
// 三个值含义不同，塌缩成任意一个都会把下一步操作带偏。
export const UNLIMITED_HINT = '-1 = 不限，0 = 不留';

export type TopicEditorKind = 'seconds' | 'count' | 'boolean' | 'retention';

export interface TopicPolicyEditor {
    kind: TopicEditorKind;
    min?: number;
    max?: number;
    unit?: string;
    options?: {label: string; value: string}[];
}

export interface TopicPolicyRow {
    key: string;
    label: string;
    field: TopicPolicyField;
    editor: TopicPolicyEditor;
    hint?: string;
    render: (view: TopicPolicyView) => string;
}

const INT_MAX = 2147483647;

const BOOL_OPTIONS = [
    {label: '启用', value: 'true'},
    {label: '停用', value: 'false'},
];

function intText(value: number | null, unit: string): string {
    if (value === null) {
        return NOT_SET;
    }
    return `${value.toLocaleString('en-US')}${unit}`;
}

function boolText(value: boolean | null): string {
    return value === null ? NOT_SET : value ? '已启用' : '已停用';
}

// 保留策略整体替换：broker 的 POST 收的是两键对象，所以这里必须两维都显示，
// 只说其中一维会让人以为另一维保持原样。
function retentionText(view: TopicPolicyView): string {
    if (view.retentionTimeInMinutes === null && view.retentionSizeInMB === null) {
        return NOT_SET;
    }
    const time = view.retentionTimeInMinutes;
    const size = view.retentionSizeInMB;
    return [
        time === null ? '时长按上层' : time < 0 ? '时长无限' : `时长 ${time} 分钟`,
        size === null ? '容量按上层' : size < 0 ? '容量无限' : `容量 ${size}MB`,
    ].join('，');
}

export const TOPIC_POLICY_GROUPS: {title: string; rows: TopicPolicyRow[]}[] = [
    {
        title: '保留与过期',
        rows: [
            {
                key: 'retention',
                label: '保留策略',
                field: 'retention',
                editor: {kind: 'retention'},
                hint: `两个维度一起整对象写入，${UNLIMITED_HINT}。`,
                render: retentionText,
            },
            {
                key: 'messageTtlSeconds',
                label: '消息 TTL',
                field: 'messageTtlSeconds',
                editor: {kind: 'seconds', min: 0, max: INT_MAX, unit: '秒'},
                // 0 在这里是合法值（消息一进 topic 就过期），不是"没填"
                hint: '秒。0 = 立刻过期；broker 拒绝负数。与保留策略取更严的一侧生效。',
                render: view => intText(view.messageTtlSeconds, ' 秒'),
            },
        ],
    },
    {
        title: '未确认上限',
        rows: [
            {
                key: 'maxUnackedMessagesPerConsumer',
                label: '每消费者未确认上限',
                field: 'maxUnackedMessagesPerConsumer',
                editor: {kind: 'count', min: 0, max: INT_MAX, unit: '条'},
                hint: '条。0 = 不限。超过后该消费者暂停收新消息。',
                render: view => intText(view.maxUnackedMessagesPerConsumer, ' 条'),
            },
            {
                key: 'maxUnackedMessagesPerSubscription',
                label: '每订阅未确认上限',
                field: 'maxUnackedMessagesPerSubscription',
                editor: {kind: 'count', min: 0, max: INT_MAX, unit: '条'},
                hint: '条。0 = 不限。整条订阅共享这份额度。',
                render: view => intText(view.maxUnackedMessagesPerSubscription, ' 条'),
            },
        ],
    },
    {
        title: '去重',
        rows: [
            {
                key: 'deduplicationEnabled',
                label: '服务端去重',
                field: 'deduplicationEnabled',
                editor: {kind: 'boolean', options: BOOL_OPTIONS},
                hint: '开启后按 producer 序列号去重，代价是每条消息都要写一份状态。',
                render: view => boolText(view.deduplicationEnabled),
            },
        ],
    },
];

export const TOPIC_POLICY_ROW_BY_FIELD: Map<TopicPolicyField, TopicPolicyRow> = new Map(
    TOPIC_POLICY_GROUPS.flatMap(group => group.rows).map(row => [row.field, row]),
);

export function topicPolicyFieldLabel(field: TopicPolicyField): string {
    return TOPIC_POLICY_ROW_BY_FIELD.get(field)?.label ?? field;
}
