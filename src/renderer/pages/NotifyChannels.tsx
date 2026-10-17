import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
    Alert,
    Button,
    Checkbox,
    Col,
    Form,
    Input,
    InputNumber,
    Modal,
    Row,
    Select,
    Space,
    Switch,
    Table,
    Tag,
    Tooltip,
    Typography,
    message,
} from 'antd';
import {DeleteOutlined, MailOutlined, PlusOutlined, ReloadOutlined, SendOutlined} from '@ant-design/icons';
import PageShell from '../components/common/PageShell';
import StateBlock from '../components/common/StateBlock';
import {
    NOTIFY_DEFAULT_RATE,
    NOTIFY_DEFAULT_TIMEOUT_MS,
    NOTIFY_EVENT_LABEL,
    NOTIFY_KIND_LABEL,
    NOTIFY_LEVEL_LABEL,
    NOTIFY_LEVEL_RANK,
    NOTIFIABLE_EVENT_KINDS,
    notifyKindIsWebhook,
    notifyKindSupportsSecret,
    validateNotifyUrl,
} from '../../shared/notify-channels';
import {
    MAIL_DEFAULT_PORT,
    MAIL_RECIPIENT_MAX,
    MAIL_SECURITY_KINDS,
    MAIL_SECURITY_LABEL,
    mailRecipientsProblem,
    parseMailRecipients,
    validateMailAddress,
    validateMailHost,
    validateMailPort,
} from '../../shared/notify-mail';
import type {
    MailProfile,
    MailSecurity,
    NotifyChannel,
    NotifyChannelKind,
    NotifyDelivery,
    NotifyDispatchResult,
    NotifyEventKind,
    NotifyLevel,
} from '../types';

interface Props {
    /** 渠道与集群无关，这个 prop 只是页签体系留下的口子，页面不用它 */
    clusterId?: string;
}

/** 表单值：与 draft 的差别只在 url/secret 允许空串，空串的含义见 handleSave。 */
interface ChannelForm {
    name: string;
    kind: NotifyChannelKind;
    url: string;
    secret?: string;
    mailProfileId?: string;
    recipients?: string;
    enabled: boolean;
    events: NotifyEventKind[];
    minLevel: NotifyLevel;
    timeoutMs: number;
    ratePerMinute: number;
}

/** 邮件的默认单次超时：SMTP 要过 DNS、握手、登录三段，webhook 那 5 秒对它是「必失败」。 */
const MAIL_DEFAULT_TIMEOUT_MS = 15_000;

/** 事件默认级别：界面上把级别标在订选项后面，免得用户订了一个永远过不了级别线的组合。 */
const EVENT_DEFAULT_LEVEL: Record<NotifyEventKind, NotifyLevel> = {
    alertFired: 'crit',
    alertRecovered: 'info',
    inspectionCrit: 'crit',
    inspectionRecovered: 'info',
    inspectionFailed: 'warn',
    test: 'info',
};

const LEVEL_OPTIONS: NotifyLevel[] = ['info', 'warn', 'crit'];

/** 新建时的默认订阅：只收「需要人处理」的那三类，别一上来就把恢复消息也推给人。 */
const DEFAULT_EVENTS: NotifyEventKind[] = ['alertFired', 'inspectionCrit', 'inspectionFailed'];

function emptyForm(): ChannelForm {
    return {
        name: '',
        kind: 'generic',
        url: '',
        secret: '',
        mailProfileId: undefined,
        recipients: '',
        enabled: true,
        events: DEFAULT_EVENTS,
        minLevel: 'warn',
        timeoutMs: NOTIFY_DEFAULT_TIMEOUT_MS,
        ratePerMinute: NOTIFY_DEFAULT_RATE,
    };
}

function formOf(channel: NotifyChannel): ChannelForm {
    return {
        name: channel.name,
        kind: channel.kind,
        // 地址不回显：列表里拿到的是打码后的串，填回去等于把打码串当新地址存下来
        url: '',
        secret: '',
        mailProfileId: channel.mailProfileId ?? undefined,
        // 收件人不是凭据，可以照原样回填（重新排成逗号分隔只是把库里的原文显示出来）
        recipients: channel.recipients.join(', '),
        enabled: channel.enabled,
        events: channel.events,
        minLevel: channel.minLevel,
        timeoutMs: channel.timeoutMs,
        ratePerMinute: channel.ratePerMinute,
    };
}

/** 每次投递结论都要显示成一句人话：ok/skipped 两个布尔有三种组合，第四种不存在。 */
function deliveryTone(row: Pick<NotifyDelivery, 'ok' | 'skipped'>): {color: string; text: string} {
    if (row.ok) {
        return {color: 'success', text: '已送达'};
    }
    if (row.skipped) {
        return {color: 'default', text: '没发'};
    }
    return {color: 'error', text: '失败'};
}

/** 测试结果按渠道逐条报：一次点测试发的是这一条渠道，但结论要说清是送达还是被挡。 */
function describeResult(result: NotifyDispatchResult): {ok: boolean; text: string} {
    const line = result.deliveries.map(item => `${item.channelName}：${item.message}`).join('\n');
    return {ok: result.deliveries.some(item => item.ok), text: line || '没有任何渠道被选中'};
}

const NotifyChannels: React.FC<Props> = () => {
    const [channels, setChannels] = useState<NotifyChannel[]>([]);
    const [deliveries, setDeliveries] = useState<NotifyDelivery[]>([]);
    const [profiles, setProfiles] = useState<MailProfile[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [testingId, setTestingId] = useState<string | null>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [mailModalOpen, setMailModalOpen] = useState(false);
    const [editing, setEditing] = useState<NotifyChannel | null>(null);
    const [saving, setSaving] = useState(false);
    const [form] = Form.useForm<ChannelForm>();

    /** 服务器 id → 名字：列表那一格要显示人起的名，而不是一个 uuid。 */
    const profileNames = useMemo(
        () => Object.fromEntries(profiles.map(item => [item.id, item.name])) as Record<string, string>,
        [profiles],
    );

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [channelResponse, deliveryResponse, mailResponse] = await Promise.all([
                window.electronAPI.notify.channel.list(),
                window.electronAPI.notify.delivery.list({limit: 100}),
                window.electronAPI.notify.mail.list(),
            ]);
            if (!channelResponse.success) {
                setError(channelResponse.error || '渠道读取失败');
                return;
            }
            setChannels(channelResponse.data ?? []);
            // 投递记录与邮件服务器读失败都不顶掉渠道列表：这一屏的主语是渠道，其余是附带
            setDeliveries(deliveryResponse.success ? (deliveryResponse.data ?? []) : []);
            setProfiles(mailResponse.success ? (mailResponse.data ?? []) : []);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : '通知配置读取失败');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const openCreate = useCallback(() => {
        setEditing(null);
        setModalOpen(true);
    }, []);

    const openEdit = useCallback((channel: NotifyChannel) => {
        setEditing(channel);
        setModalOpen(true);
    }, []);

    // Modal 是 destroyOnClose，Form 每次打开都重新挂载。回填必须走 initialValues：
    // 挂载时它会用默认值整个覆盖 store，所以在打开之前 setFieldsValue 写的值会被抹掉
    // （表现就是「编辑」打开后表单空白、类型回到默认值）。

    const handleSave = useCallback(async () => {
        const values = await form.validateFields();
        setSaving(true);
        try {
            const response = await window.electronAPI.notify.channel.save({
                ...values,
                id: editing?.id,
                // 空串在这里就退化成「不改」：地址与密钥都不回填，逼着用户重打一遍
                // 只会让人拿记事本里那串旧地址重贴，反而更容易贴错
                url: (values.url ?? '').trim(),
                secret: values.secret?.trim() ? values.secret.trim() : undefined,
                recipients: values.recipients?.trim() ?? '',
            });
            if (!response.success || !response.data) {
                message.error(response.error || '保存失败');
                return;
            }
            message.success(editing ? '渠道已更新' : '渠道已添加');
            setModalOpen(false);
            setEditing(null);
            await load();
        } catch (cause) {
            message.error(cause instanceof Error ? cause.message : '保存失败');
        } finally {
            setSaving(false);
        }
    }, [editing, form, load]);

    const handleToggle = useCallback(async (channel: NotifyChannel, enabled: boolean) => {
        try {
            const response = await window.electronAPI.notify.channel.enable({id: channel.id, enabled});
            if (!response.success) {
                message.error(response.error || '开关没改动');
                return;
            }
            setChannels(prev => prev.map(item => (item.id === channel.id ? {...item, enabled} : item)));
        } catch (cause) {
            message.error(cause instanceof Error ? cause.message : '开关没改动');
        }
    }, []);

    const handleTest = useCallback(
        async (channel: NotifyChannel) => {
            setTestingId(channel.id);
            try {
                const response = await window.electronAPI.notify.channel.test({id: channel.id});
                if (!response.success || !response.data) {
                    message.error(response.error || '测试发送失败');
                    return;
                }
                const {ok, text} = describeResult(response.data);
                if (ok) {
                    message.success(text);
                } else {
                    message.warning(text);
                }
                // 测试结果会写 last_error / fail_count，所以发完要把列表读回来
                await load();
            } catch (cause) {
                message.error(cause instanceof Error ? cause.message : '测试发送失败');
            } finally {
                setTestingId(null);
            }
        },
        [load],
    );

    const handleDelete = useCallback(
        (channel: NotifyChannel) => {
            Modal.confirm({
                title: `删除「${channel.name}」？`,
                content:
                    channel.kind === 'email'
                        ? '它的投递记录会一起删掉。那台邮件服务器与别的渠道都不受影响，收件人只是跟着这一条一起没了。'
                        : '它的投递记录会一起删掉。地址与密钥只存在本机，删了就没地方能找回。',
                okText: '删除',
                okButtonProps: {danger: true},
                cancelText: '取消',
                onOk: async () => {
                    const response = await window.electronAPI.notify.channel.delete({id: channel.id});
                    if (!response.success) {
                        message.error(response.error || '删除失败');
                        return;
                    }
                    message.success('渠道已删除');
                    await load();
                },
            });
        },
        [load],
    );

    const kindWatched = Form.useWatch('kind', form);
    const eventsWatched = Form.useWatch('events', form);
    const levelWatched = Form.useWatch('minLevel', form);
    const recipientsWatched = Form.useWatch('recipients', form);

    const channelColumns = useMemo(
        () => [
            {
                title: '渠道',
                dataIndex: 'name',
                width: 170,
                render: (_: unknown, channel: NotifyChannel) => (
                    <Space direction="vertical" size={0}>
                        <Typography.Text strong>{channel.name}</Typography.Text>
                        <Typography.Text type="secondary">{NOTIFY_KIND_LABEL[channel.kind]}</Typography.Text>
                    </Space>
                ),
            },
            {
                title: '发往',
                dataIndex: 'url',
                render: (_: unknown, channel: NotifyChannel) =>
                    channel.kind === 'email' ? (
                        <Space direction="vertical" size={0}>
                            <Typography.Text style={{wordBreak: 'break-all'}}>
                                {channel.recipients.join('、') || '没有收件人'}
                            </Typography.Text>
                            <Typography.Text type="secondary">
                                邮件·
                                {channel.mailProfileId
                                    ? (profileNames[channel.mailProfileId] ?? '服务器已不在')
                                    : '没选服务器'}
                            </Typography.Text>
                        </Space>
                    ) : (
                        <Space direction="vertical" size={0}>
                            <Typography.Text style={{wordBreak: 'break-all'}}>{channel.url}</Typography.Text>
                            <Typography.Text type="secondary">
                                {channel.hasSecret ? '已存签名密钥' : '未配置签名密钥'}
                            </Typography.Text>
                        </Space>
                    ),
            },
            {
                title: '订阅',
                dataIndex: 'events',
                width: 230,
                render: (_: unknown, channel: NotifyChannel) => (
                    <Space direction="vertical" size={2}>
                        <Space size={[4, 4]} wrap>
                            {channel.events.length ? (
                                channel.events.map(kind => <Tag key={kind}>{NOTIFY_EVENT_LABEL[kind]}</Tag>)
                            ) : (
                                <Typography.Text type="warning">一条都没订</Typography.Text>
                            )}
                        </Space>
                        <Typography.Text type="secondary">
                            只发 {NOTIFY_LEVEL_LABEL[channel.minLevel]} 及以上
                        </Typography.Text>
                    </Space>
                ),
            },
            {
                title: '限流',
                dataIndex: 'ratePerMinute',
                width: 110,
                render: (rate: number, channel: NotifyChannel) => (
                    <Space direction="vertical" size={0}>
                        <Typography.Text>{rate} 条/分钟</Typography.Text>
                        <Typography.Text type="secondary">超时 {channel.timeoutMs} 毫秒</Typography.Text>
                    </Space>
                ),
            },
            {
                title: '最近',
                dataIndex: 'lastSentAt',
                width: 190,
                render: (_: unknown, channel: NotifyChannel) => (
                    <Space direction="vertical" size={0}>
                        <Typography.Text>
                            {channel.lastSentAt ? channel.lastSentAt.slice(0, 19).replace('T', ' ') : '还没发过'}
                        </Typography.Text>
                        {channel.lastError ? (
                            <Tooltip title={channel.lastError}>
                                <Typography.Text type="danger">
                                    连续失败 {channel.failCount} 次：{channel.lastError.slice(0, 28)}
                                </Typography.Text>
                            </Tooltip>
                        ) : channel.failCount ? (
                            <Typography.Text type="danger">连续失败 {channel.failCount} 次</Typography.Text>
                        ) : null}
                    </Space>
                ),
            },
            {
                title: '启用',
                dataIndex: 'enabled',
                width: 70,
                render: (enabled: boolean, channel: NotifyChannel) => (
                    <Switch size="small" checked={enabled} onChange={value => void handleToggle(channel, value)} />
                ),
            },
            {
                title: '操作',
                dataIndex: 'actions',
                width: 190,
                render: (_: unknown, channel: NotifyChannel) => (
                    <Space size={4}>
                        <Button
                            size="small"
                            icon={<SendOutlined />}
                            loading={testingId === channel.id}
                            onClick={() => void handleTest(channel)}
                        >
                            测试
                        </Button>
                        <Button size="small" onClick={() => openEdit(channel)}>
                            编辑
                        </Button>
                        <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(channel)} />
                    </Space>
                ),
            },
        ],
        [handleDelete, handleTest, handleToggle, openEdit, profileNames, testingId],
    );

    const deliveryColumns = useMemo(
        () => [
            {
                title: '时间',
                dataIndex: 'createdAt',
                width: 170,
                render: (value: string) => <Typography.Text>{value.slice(0, 19).replace('T', ' ')}</Typography.Text>,
            },
            {title: '渠道', dataIndex: 'channelName', width: 160},
            {
                title: '事件',
                dataIndex: 'eventKind',
                width: 140,
                render: (kind: NotifyEventKind) => NOTIFY_EVENT_LABEL[kind] ?? kind,
            },
            {
                title: '级别',
                dataIndex: 'level',
                width: 80,
                render: (level: NotifyLevel) => (
                    <Tag color={level === 'crit' ? 'error' : level === 'warn' ? 'warning' : 'default'}>
                        {NOTIFY_LEVEL_LABEL[level] ?? level}
                    </Tag>
                ),
            },
            {
                title: '结果',
                dataIndex: 'ok',
                width: 90,
                render: (_: unknown, row: NotifyDelivery) => {
                    const tone = deliveryTone(row);
                    return <Tag color={tone.color}>{tone.text}</Tag>;
                },
            },
            {
                title: '说明',
                dataIndex: 'message',
                render: (value: string) => <Typography.Text style={{wordBreak: 'break-all'}}>{value}</Typography.Text>,
            },
        ],
        [],
    );

    return (
        <PageShell
            actions={
                <Space>
                    <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
                        刷新
                    </Button>
                    <Button icon={<MailOutlined />} onClick={() => setMailModalOpen(true)}>
                        邮件服务器
                    </Button>
                    <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                        添加渠道
                    </Button>
                </Space>
            }
        >
            <Alert
                type="info"
                showIcon
                message="地址、签名密钥与邮件密码加密存在本机，列表里只显示打码后的内容"
                description={
                    <Space direction="vertical" size={2}>
                        <span>
                            告警与巡检结论在落库之后顺手发给这些渠道；发失败不会影响落库，也不会重试排队——
                            应用退出后没有人补发，所以每次投递的结论都记在下面那张表里。
                        </span>
                        <span>「测试」只发这一条渠道，并绕开它的订阅、级别线与限流：它要回答的是「现在通不通」。</span>
                        <span>
                            邮件渠道发往一台 SMTP
                            服务器：服务器（主机、账号、密码）单独配一次，多条渠道各带自己的收件人。
                        </span>
                    </Space>
                }
            />
            <StateBlock loading={loading} error={error} onRetry={() => void load()} height={200}>
                <Table<NotifyChannel>
                    rowKey="id"
                    size="small"
                    columns={channelColumns}
                    dataSource={channels}
                    pagination={false}
                    scroll={{x: 1100}}
                    locale={{
                        emptyText: <NoChannelsHint onCreate={openCreate} />,
                    }}
                />
            </StateBlock>
            <Typography.Title level={5} style={{marginBottom: 8}}>
                最近投递（最多 100 条，库里只留最近 500 条）
            </Typography.Title>
            <Table<NotifyDelivery>
                rowKey="id"
                size="small"
                columns={deliveryColumns}
                dataSource={deliveries}
                pagination={{pageSize: 20, showSizeChanger: false}}
                scroll={{x: 900}}
                locale={{emptyText: '还没有过投递'}}
            />
            <Modal
                title={editing ? `编辑「${editing.name}」` : '添加通知渠道'}
                open={modalOpen}
                onCancel={() => setModalOpen(false)}
                onOk={() => void handleSave()}
                okText="保存"
                cancelText="取消"
                confirmLoading={saving}
                width={640}
                destroyOnClose
            >
                <Form
                    form={form}
                    layout="vertical"
                    initialValues={editing ? formOf(editing) : emptyForm()}
                    preserve={false}
                >
                    <Form.Item
                        name="name"
                        label="名称"
                        rules={[{required: true, message: '给这条渠道起个名字，投递记录里显示的就是它'}]}
                    >
                        <Input placeholder="值班群机器人" maxLength={80} />
                    </Form.Item>
                    <Form.Item name="kind" label="类型">
                        <Select
                            options={(Object.keys(NOTIFY_KIND_LABEL) as NotifyChannelKind[]).map(kind => ({
                                value: kind,
                                label: NOTIFY_KIND_LABEL[kind],
                            }))}
                            onChange={value => {
                                // 邮件要过 DNS、握手、登录三段，webhook 那 5 秒超时对它来说就是「必失败」；
                                // 只在用户没动过这一格时换，改到过 20 秒的没必要被悄悄重置
                                const current = form.getFieldValue('timeoutMs') as number;
                                if (value === 'email' && current === NOTIFY_DEFAULT_TIMEOUT_MS) {
                                    form.setFieldValue('timeoutMs', MAIL_DEFAULT_TIMEOUT_MS);
                                } else if (value !== 'email' && current === MAIL_DEFAULT_TIMEOUT_MS) {
                                    form.setFieldValue('timeoutMs', NOTIFY_DEFAULT_TIMEOUT_MS);
                                }
                            }}
                        />
                    </Form.Item>
                    {notifyKindIsWebhook(kindWatched ?? 'generic') ? (
                        <Form.Item
                            name="url"
                            label="地址"
                            extra={
                                editing
                                    ? `留空表示沿用现在这条：${editing.url}`
                                    : '只收 http/https；地址里的 key 属于凭据，会加密落库'
                            }
                            rules={[
                                {
                                    validator: (_rule, value: string) => {
                                        const text = (value ?? '').trim();
                                        if (!text) {
                                            return editing
                                                ? Promise.resolve()
                                                : Promise.reject(new Error('新建渠道必须填写通知地址'));
                                        }
                                        const invalid = validateNotifyUrl(text);
                                        return invalid ? Promise.reject(new Error(invalid)) : Promise.resolve();
                                    },
                                },
                            ]}
                        >
                            <Input placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxxx" />
                        </Form.Item>
                    ) : (
                        <>
                            <Row gutter={12}>
                                <Col span={14}>
                                    <Form.Item
                                        name="mailProfileId"
                                        label="邮件服务器"
                                        extra={
                                            profiles.length
                                                ? '一台服务器可以给多条邮件渠道用，差别只在收件人'
                                                : '还没有邮件服务器，先在「邮件服务器」那一台配好'
                                        }
                                        rules={[{required: true, message: '选一台邮件服务器'}]}
                                    >
                                        <Select
                                            placeholder="选择已配好的 SMTP"
                                            options={profiles.map(item => ({
                                                value: item.id,
                                                label: `${item.name}（${item.host}:${item.port}）`,
                                            }))}
                                        />
                                    </Form.Item>
                                </Col>
                                <Col span={10}>
                                    <Form.Item label=" " colon={false}>
                                        <Button icon={<MailOutlined />} onClick={() => setMailModalOpen(true)}>
                                            管理邮件服务器
                                        </Button>
                                    </Form.Item>
                                </Col>
                            </Row>
                            <Form.Item
                                name="recipients"
                                label="收件人"
                                extra={`逗号、分号或换行分隔都行，最多 ${MAIL_RECIPIENT_MAX} 个${
                                    recipientsWatched && recipientsWatched.trim()
                                        ? `；现在解析出 ${parseMailRecipients(recipientsWatched).to.length} 个`
                                        : ''
                                }`}
                                rules={[
                                    {
                                        validator: (_rule, value: string) => {
                                            const problem = mailRecipientsProblem(value);
                                            return problem ? Promise.reject(new Error(problem)) : Promise.resolve();
                                        },
                                    },
                                ]}
                            >
                                <Input.TextArea
                                    rows={3}
                                    placeholder={'oncall@corp.com\ndba@corp.com'}
                                    maxLength={4000}
                                />
                            </Form.Item>
                        </>
                    )}
                    {notifyKindSupportsSecret(kindWatched ?? 'generic') ? (
                        <Form.Item
                            name="secret"
                            label="签名密钥"
                            extra={
                                editing
                                    ? '留空表示沿用已存的那一份；填了新值才会替换'
                                    : '只在机器人开了「加签」时才需要，在机器人安全设置里能看到'
                            }
                        >
                            <Input.Password placeholder="SEC 开头的那串（钉钉）/ 加签密钥（飞书）" maxLength={512} />
                        </Form.Item>
                    ) : null}
                    {kindWatched === 'dingtalk' ? (
                        <Typography.Paragraph type="secondary" style={{marginTop: -8, marginBottom: 16}}>
                            如果这个机器人配的是「自定义关键词」而不是加签：每条消息的第一行是事件标题
                            （如「告警：xxx」「巡检：xxx」），把关键词设成这些词的一部分才不会收到 errcode 310000。
                        </Typography.Paragraph>
                    ) : null}
                    <Form.Item
                        name="events"
                        label="订阅事件"
                        extra={
                            <span>
                                没订的事件这条渠道不会收到。级别线（当前 {NOTIFY_LEVEL_LABEL[levelWatched ?? 'warn']}）
                                还会再筛一次，两道都过才发。
                            </span>
                        }
                        rules={[{required: true, message: '至少订一种事件，否则这条渠道永远不会开口'}]}
                    >
                        <Checkbox.Group
                            options={NOTIFIABLE_EVENT_KINDS.map(kind => {
                                const level = NOTIFY_LEVEL_LABEL[EVENT_DEFAULT_LEVEL[kind]];
                                return {value: kind, label: `${NOTIFY_EVENT_LABEL[kind]}（默认${level}）`};
                            })}
                        />
                    </Form.Item>
                    <Form.Item
                        name="minLevel"
                        label="级别线"
                        extra={`低于「${NOTIFY_LEVEL_LABEL[levelWatched ?? 'warn']}」的事件不发，也不占投递记录`}
                    >
                        <Select
                            options={LEVEL_OPTIONS.map(level => ({
                                value: level,
                                label: `${NOTIFY_LEVEL_LABEL[level]}（${NOTIFY_LEVEL_RANK[level]} 级及以上）`,
                            }))}
                        />
                    </Form.Item>
                    <Space size={12} align="start">
                        <Form.Item name="timeoutMs" label="单次超时（毫秒）">
                            <InputNumber min={1000} max={30000} step={1000} style={{width: 160}} />
                        </Form.Item>
                        <Form.Item name="ratePerMinute" label="每分钟上限（条）">
                            <InputNumber min={1} max={60} step={1} style={{width: 160}} />
                        </Form.Item>
                        <Form.Item name="enabled" label="启用" valuePropName="checked">
                            <Switch />
                        </Form.Item>
                    </Space>
                    {eventsWatched && eventsWatched.length === 0 ? (
                        <Alert type="warning" showIcon message="这条渠道一个事件都没订，保存后不会发任何东西" />
                    ) : null}
                </Form>
            </Modal>
            <MailProfilesModal
                open={mailModalOpen}
                onClose={() => setMailModalOpen(false)}
                /** 关掉之后重新读一次渠道列表：删掉的服务器要在「发往」那一格里变成「服务器已不在」 */
                onChanged={() => void load()}
            />
        </PageShell>
    );
};

/** 邮件服务器表单：密码与渠道密钥同一口径——不回填，留空表示沿用库里那一份。 */
interface MailForm {
    name: string;
    host: string;
    port: number;
    security: MailSecurity;
    username?: string;
    password?: string;
    fromAddress: string;
    fromName?: string;
    allowSelfSigned: boolean;
}

function emptyMailForm(): MailForm {
    return {
        name: '',
        host: '',
        port: MAIL_DEFAULT_PORT.starttls,
        security: 'starttls',
        username: '',
        password: '',
        fromAddress: '',
        fromName: '',
        allowSelfSigned: false,
    };
}

function mailFormOf(profile: MailProfile): MailForm {
    return {
        ...emptyMailForm(),
        name: profile.name,
        host: profile.host,
        port: profile.port,
        security: profile.security,
        username: '',
        password: '',
        fromAddress: profile.fromAddress,
        fromName: profile.fromName,
        allowSelfSigned: profile.allowSelfSigned,
    };
}

const MailProfilesModal: React.FC<{open: boolean; onClose: () => void; onChanged: () => void}> = ({
    open,
    onClose,
    onChanged,
}) => {
    const [profiles, setProfiles] = useState<MailProfile[]>([]);
    const [loading, setLoading] = useState(false);
    const [editing, setEditing] = useState<MailProfile | null>(null);
    const [formOpen, setFormOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [testingId, setTestingId] = useState<string | null>(null);
    const [testTo, setTestTo] = useState('');
    const [form] = Form.useForm<MailForm>();

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const response = await window.electronAPI.notify.mail.list();
            setProfiles(response.success ? (response.data ?? []) : []);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (open) {
            void load();
        }
    }, [open, load]);

    const handleSave = useCallback(async () => {
        const values = await form.validateFields();
        setSaving(true);
        try {
            const response = await window.electronAPI.notify.mail.save({
                ...values,
                id: editing?.id,
                host: values.host.trim(),
                name: values.name.trim(),
                fromAddress: values.fromAddress.trim(),
                // 与密码同一条口径：空用户名 = 沿用库里的账号（渲染层只有打码串，回填它等于写坏）
                username: values.username?.trim() ? values.username.trim() : undefined,
                password: values.password?.trim() ? values.password.trim() : undefined,
            });
            if (!response.success || !response.data) {
                message.error(response.error || '保存失败');
                return;
            }
            message.success(editing ? '邮件服务器已更新' : '邮件服务器已添加');
            setFormOpen(false);
            setEditing(null);
            await load();
            // 渠道那一屏也读这份列表（「发往」那一格要显示服务器名）
            onChanged();
        } catch (cause) {
            message.error(cause instanceof Error ? cause.message : '保存失败');
        } finally {
            setSaving(false);
        }
    }, [editing, form, load, onChanged]);

    const handleTest = useCallback(
        async (profile: MailProfile) => {
            const to = testTo.trim();
            if (to) {
                const invalid = validateMailAddress(to);
                if (invalid) {
                    message.error(`测试收件人：${invalid}`);
                    return;
                }
            }
            setTestingId(profile.id);
            try {
                const response = await window.electronAPI.notify.mail.test({id: profile.id, to: to || undefined});
                if (!response.success || !response.data) {
                    message.error(response.error || '测试失败');
                    return;
                }
                if (response.data.ok) {
                    message.success(response.data.message);
                } else {
                    message.warning(response.data.message);
                }
            } catch (cause) {
                message.error(cause instanceof Error ? cause.message : '测试失败');
            } finally {
                setTestingId(null);
            }
        },
        [testTo],
    );

    const handleDelete = useCallback(
        (profile: MailProfile) => {
            Modal.confirm({
                title: `删除「${profile.name}」？`,
                content:
                    '用它的邮件渠道会立刻发不出去，并在投递记录里写明「这台邮件服务器已经不在了」——渠道本身不会被删。',
                okText: '删除',
                okButtonProps: {danger: true},
                cancelText: '取消',
                onOk: async () => {
                    const response = await window.electronAPI.notify.mail.delete({id: profile.id});
                    if (!response.success) {
                        message.error(response.error || '删除失败');
                        return;
                    }
                    message.success('邮件服务器已删除');
                    await load();
                    onChanged();
                },
            });
        },
        [load, onChanged],
    );

    const columns = useMemo(
        () => [
            {
                title: '名称',
                dataIndex: 'name',
                width: 150,
                render: (value: string) => <Typography.Text strong>{value}</Typography.Text>,
            },
            {
                title: '服务器',
                dataIndex: 'host',
                width: 220,
                render: (_: unknown, item: MailProfile) => (
                    <Space direction="vertical" size={0}>
                        <Typography.Text>{`${item.host}:${item.port}`}</Typography.Text>
                        <Typography.Text type="secondary">
                            {MAIL_SECURITY_LABEL[item.security]}
                            {item.allowSelfSigned ? ' · 不校验证书' : ''}
                        </Typography.Text>
                    </Space>
                ),
            },
            {
                title: '登录',
                dataIndex: 'username',
                width: 160,
                render: (value: string, item: MailProfile) => (
                    <Typography.Text type={value ? undefined : 'secondary'}>
                        {value ? `${value}${item.hasPassword ? ' · 已存密码' : ' · 没存密码'}` : '不登录'}
                    </Typography.Text>
                ),
            },
            {
                title: '发件人',
                dataIndex: 'fromAddress',
                width: 200,
                render: (value: string, item: MailProfile) => (
                    <Space direction="vertical" size={0}>
                        <Typography.Text style={{wordBreak: 'break-all'}}>{value}</Typography.Text>
                        {item.fromName ? <Typography.Text type="secondary">{item.fromName}</Typography.Text> : null}
                    </Space>
                ),
            },
            {
                title: '操作',
                dataIndex: 'actions',
                width: 210,
                render: (_: unknown, item: MailProfile) => (
                    <Space size={4}>
                        <Button
                            size="small"
                            icon={<SendOutlined />}
                            loading={testingId === item.id}
                            onClick={() => void handleTest(item)}
                        >
                            测试
                        </Button>
                        <Button
                            size="small"
                            onClick={() => {
                                setEditing(item);
                                setFormOpen(true);
                            }}
                        >
                            编辑
                        </Button>
                        <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(item)} />
                    </Space>
                ),
            },
        ],
        [handleDelete, handleTest, testingId],
    );

    return (
        <>
            <Modal
                title="邮件服务器（SMTP）"
                open={open}
                onCancel={onClose}
                footer={<Button onClick={onClose}>关闭</Button>}
                width={900}
            >
                <Alert
                    type="info"
                    showIcon
                    style={{marginBottom: 12}}
                    message="一台服务器可以给多条邮件渠道用，渠道之间只差收件人"
                    description="密码加密存在本机，界面上只显示「已存密码」。删除服务器不会删掉用它的渠道，那些渠道会开始留一条「这台邮件服务器已经不在了」的投递记录。"
                />
                <Space style={{marginBottom: 12}} align="end">
                    <Button
                        type="primary"
                        icon={<PlusOutlined />}
                        onClick={() => {
                            setEditing(null);
                            setFormOpen(true);
                        }}
                    >
                        添加服务器
                    </Button>
                    <Input
                        style={{width: 260}}
                        value={testTo}
                        onChange={event => setTestTo(event.target.value)}
                        placeholder="测试收件人（留空则发给自己的发件地址）"
                        maxLength={254}
                    />
                    <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} />
                </Space>
                <Table<MailProfile>
                    rowKey="id"
                    size="small"
                    columns={columns}
                    dataSource={profiles}
                    pagination={false}
                    loading={loading}
                    locale={{emptyText: '还没有邮件服务器'}}
                />
            </Modal>
            <Modal
                title={editing ? `编辑「${editing.name}」` : '添加邮件服务器'}
                open={formOpen}
                onCancel={() => setFormOpen(false)}
                onOk={() => void handleSave()}
                okText="保存"
                cancelText="取消"
                confirmLoading={saving}
                width={620}
                destroyOnClose
            >
                <Form
                    form={form}
                    layout="vertical"
                    initialValues={editing ? mailFormOf(editing) : emptyMailForm()}
                    preserve={false}
                >
                    <Row gutter={12}>
                        <Col span={12}>
                            <Form.Item
                                name="name"
                                label="名称"
                                rules={[{required: true, message: '给这台服务器起个名字'}]}
                            >
                                <Input placeholder="公司邮件网关" maxLength={80} />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item
                                name="host"
                                label="服务器地址"
                                extra="只填主机名，端口在下面那一格"
                                rules={[
                                    {
                                        validator: (_rule, value: string) => {
                                            const problem = validateMailHost(value);
                                            return problem ? Promise.reject(new Error(problem)) : Promise.resolve();
                                        },
                                    },
                                ]}
                            >
                                <Input placeholder="smtp.corp.com" maxLength={253} />
                            </Form.Item>
                        </Col>
                    </Row>
                    <Row gutter={12}>
                        <Col span={8}>
                            <Form.Item
                                name="port"
                                label="端口"
                                rules={[
                                    {
                                        validator: (_rule, value: number) => {
                                            const problem = validateMailPort(value);
                                            return problem ? Promise.reject(new Error(problem)) : Promise.resolve();
                                        },
                                    },
                                ]}
                            >
                                <InputNumber min={1} max={65535} style={{width: '100%'}} />
                            </Form.Item>
                        </Col>
                        <Col span={16}>
                            <Form.Item
                                name="security"
                                label="加密方式"
                                extra="465 选 SSL/TLS，587 选 STARTTLS，25 选不加密"
                            >
                                <Select
                                    options={MAIL_SECURITY_KINDS.map(kind => ({
                                        value: kind,
                                        label: `${MAIL_SECURITY_LABEL[kind]}（默认 ${MAIL_DEFAULT_PORT[kind]}）`,
                                    }))}
                                    onChange={value => {
                                        // 端口没被改过才跟着换：用户手动填过 2525 之类的就别覆盖
                                        const current = form.getFieldValue('port') as number;
                                        const known = MAIL_SECURITY_KINDS.some(
                                            kind => MAIL_DEFAULT_PORT[kind] === current,
                                        );
                                        if (known) {
                                            form.setFieldValue('port', MAIL_DEFAULT_PORT[value as MailSecurity]);
                                        }
                                    }}
                                />
                            </Form.Item>
                        </Col>
                    </Row>
                    <Row gutter={12}>
                        <Col span={12}>
                            <Form.Item
                                name="username"
                                label="用户名"
                                extra={editing ? '留空表示沿用已存账号；要换账号就直接填新的' : '不要登录就留空'}
                            >
                                <Input placeholder={editing?.username || 'alert@corp.com'} maxLength={254} />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item
                                name="password"
                                label="密码 / 授权码"
                                extra={
                                    editing ? '留空表示沿用已存的那一份' : '加密落库；有些服务商要填专门的应用授权码'
                                }
                            >
                                <Input.Password maxLength={512} />
                            </Form.Item>
                        </Col>
                    </Row>
                    <Row gutter={12}>
                        <Col span={14}>
                            <Form.Item
                                name="fromAddress"
                                label="发件地址"
                                rules={[
                                    {
                                        validator: (_rule, value: string) => {
                                            const problem = validateMailAddress((value ?? '').trim());
                                            return problem ? Promise.reject(new Error(problem)) : Promise.resolve();
                                        },
                                    },
                                ]}
                            >
                                <Input placeholder="pulsar-alert@corp.com" maxLength={254} />
                            </Form.Item>
                        </Col>
                        <Col span={10}>
                            <Form.Item name="fromName" label="发件人显示名">
                                <Input placeholder="Pulsar 告警" maxLength={120} />
                            </Form.Item>
                        </Col>
                    </Row>
                    <Form.Item
                        name="allowSelfSigned"
                        label="接受自签证书"
                        valuePropName="checked"
                        extra="只给内网邮件服务器用：勾了它这条连接不再校验服务端证书，也就挡不住中间人。"
                    >
                        <Switch />
                    </Form.Item>
                </Form>
            </Modal>
        </>
    );
};

function NoChannelsHint({onCreate}: {onCreate: () => void}) {
    return (
        <Space direction="vertical" size={8}>
            <Typography.Text type="secondary">
                还没有配置外部渠道：告警与巡检的结论目前只会落在这台机器的通知中心里。
            </Typography.Text>
            <Button onClick={onCreate}>添加第一条渠道</Button>
        </Space>
    );
}

export default NotifyChannels;
