import React, {useCallback, useMemo, useState} from 'react';
import {
    Alert,
    Button,
    Card,
    Col,
    Collapse,
    Input,
    Row,
    Select,
    Space,
    Switch,
    Tag,
    Typography,
    Upload,
    message,
} from 'antd';
import {DownloadOutlined, FolderOpenOutlined, ReloadOutlined, DeleteOutlined} from '@ant-design/icons';
import {usePluginStore} from '../store/plugins';
import type {APIResponse, PluginEntry} from '../types';
import PageShell from '../components/common/PageShell';
import StateBlock from '../components/common/StateBlock';
import IconButton from '../components/common/IconButton';
import {useConfirmDanger} from '../components/common/dangerConfirm';

const {Text, Paragraph} = Typography;

type CategoryFilter = 'all' | 'benchmark' | 'topic';
type StatusFilter = 'all' | 'installed' | 'available';

function matchesCategory(plugin: PluginEntry, category: CategoryFilter): boolean {
    if (category === 'all') {
        return true;
    }
    const presets = plugin.contributions.benchmarkPresets?.length ?? 0;
    const templates = plugin.contributions.topicTemplates?.length ?? 0;
    return category === 'benchmark' ? presets > 0 : templates > 0;
}

const PluginMarket: React.FC = () => {
    const confirmDanger = useConfirmDanger();
    const entries = usePluginStore(state => state.entries);
    const errors = usePluginStore(state => state.errors);
    const pluginsDir = usePluginStore(state => state.pluginsDir);
    const ready = usePluginStore(state => state.ready);
    const load = usePluginStore(state => state.load);
    const run = usePluginStore(state => state.run);

    const [keyword, setKeyword] = useState('');
    const [category, setCategory] = useState<CategoryFilter>('all');
    const [status, setStatus] = useState<StatusFilter>('all');
    // 工具栏级忙碌（导入/打开目录/刷新）与单行忙碌分开：
    // 原来用一个 busy 控制所有按钮，点某一行的"安装"会让整页按钮集体变灰。
    const [busy, setBusy] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);

    const visible = useMemo(() => {
        const text = keyword.trim().toLowerCase();
        return entries.filter(plugin => {
            if (!matchesCategory(plugin, category)) {
                return false;
            }
            if (status === 'installed' && !plugin.installed) {
                return false;
            }
            if (status === 'available' && plugin.installed) {
                return false;
            }
            if (!text) {
                return true;
            }
            return `${plugin.name} ${plugin.id} ${plugin.description ?? ''} ${plugin.author ?? ''}`
                .toLowerCase()
                .includes(text);
        });
    }, [entries, keyword, category, status]);

    // 单行操作只锁这一行，其余卡片仍可操作
    const withRowBusy = useCallback(
        async (id: string, action: () => Promise<APIResponse>) => {
            setBusyId(id);
            try {
                return await run(action);
            } finally {
                setBusyId(null);
            }
        },
        [run],
    );

    const install = async (id: string) => {
        const result = await withRowBusy(id, () => window.electronAPI.plugin.installOfficial(id));
        if (result.ok) {
            message.success(`已安装 ${id}`);
        } else {
            message.error(result.error);
        }
    };

    const importFile = async (file: File) => {
        setBusy(true);
        try {
            const text = await file.text();
            const result = await run(() => window.electronAPI.plugin.import(text));
            if (result.ok) {
                message.success('插件已导入并安装');
            } else {
                message.error(result.error);
            }
        } catch (error) {
            message.error(`读取文件失败：${(error as Error).message}`);
        } finally {
            setBusy(false);
        }
    };

    const toggle = async (plugin: PluginEntry, enabled: boolean) => {
        const result = await withRowBusy(plugin.id, () => window.electronAPI.plugin.setEnabled(plugin.id, enabled));
        if (!result.ok) {
            message.error(result.error);
        }
    };

    const uninstall = (plugin: PluginEntry) => {
        confirmDanger({
            title: `卸载插件「${plugin.name}」`,
            description: '删除本机上的插件文件，官方条目可以重新安装。',
            okText: '卸载',
            onOk: async () => {
                const result = await withRowBusy(plugin.id, () => window.electronAPI.plugin.uninstall(plugin.id));
                if (!result.ok) {
                    // 抛错让 antd 保持确认框打开，卸载失败不会被静默关掉
                    throw new Error(result.error);
                }
                message.success(`已卸载 ${plugin.name}`);
            },
        });
    };

    const revealDir = async () => {
        setBusy(true);
        try {
            const response = await window.electronAPI.plugin.revealDir();
            if (!response.success) {
                message.error(response.error || '打开失败');
            } else if (response.data?.failure) {
                message.error(`打开目录失败：${response.data.failure}`);
            }
        } finally {
            setBusy(false);
        }
    };

    const renderContributions = (plugin: PluginEntry) => {
        const items = [];
        const presets = plugin.contributions.benchmarkPresets ?? [];
        const templates = plugin.contributions.topicTemplates ?? [];
        if (presets.length) {
            items.push({
                key: 'presets',
                label: `压测预设 ${presets.length} 条`,
                children: (
                    <Space direction="vertical" size={4}>
                        {presets.map(preset => (
                            <div key={preset.name}>
                                <Text strong>{preset.name}</Text>
                                {preset.description ? <Text type="secondary"> — {preset.description}</Text> : null}
                                <div>
                                    <Text code style={{fontSize: 12}}>
                                        {preset.params.producers} 生产者 / {preset.params.totalMessages} 条 /{' '}
                                        {preset.params.messageSizeBytes} B /{' '}
                                        {preset.params.ratePerSecond > 0
                                            ? `${preset.params.ratePerSecond} msg/s`
                                            : '全速'}{' '}
                                        / 在途 {preset.params.maxInFlightPerProducer} /{' '}
                                        {preset.params.batchingEnabled ? '开批' : '关批'} / {preset.params.compression}
                                        {preset.params.consumeBacklog ? ' / 同时消费' : ''}
                                    </Text>
                                </div>
                            </div>
                        ))}
                    </Space>
                ),
            });
        }
        if (templates.length) {
            items.push({
                key: 'templates',
                label: `Topic 模板 ${templates.length} 个`,
                children: (
                    <Space direction="vertical" size={4}>
                        {templates.map(template => (
                            <div key={template.name}>
                                <Text strong>{template.name}</Text>
                                {template.description ? <Text type="secondary"> — {template.description}</Text> : null}
                                <div>
                                    <Text code style={{fontSize: 12}}>
                                        {template.persistent ? 'persistent' : 'non-persistent'} /{' '}
                                        {template.partitions > 0 ? `${template.partitions} 分区` : '非分区'}
                                        {template.namePrefix ? ` / 前缀 ${template.namePrefix}` : ''}
                                    </Text>
                                </div>
                            </div>
                        ))}
                    </Space>
                ),
            });
        }
        return (
            <Collapse size="small" ghost items={items.map(item => ({...item, children: <div>{item.children}</div>}))} />
        );
    };

    return (
        <PageShell
            title="插件市场"
            subtitle="插件是本地声明式扩展，只贡献数据（压测预设、Topic 创建模板），应用不会加载或执行插件携带的任何代码。"
        >
            {errors.length > 0 && (
                <Alert
                    type="warning"
                    showIcon
                    message={`${errors.length} 个插件文件没能加载`}
                    description={
                        <Space direction="vertical" size={2}>
                            {errors.map(error => (
                                <Text key={error.file} className="hint-text">
                                    {error.file}：{error.reason}
                                </Text>
                            ))}
                        </Space>
                    }
                />
            )}

            <Card size="small">
                <Space wrap size="middle">
                    <Input.Search
                        aria-label="搜索插件"
                        placeholder="搜索插件名 / 描述"
                        allowClear
                        style={{width: 220}}
                        onChange={event => setKeyword(event.target.value)}
                    />
                    <Select
                        aria-label="按类型筛选插件"
                        value={category}
                        onChange={value => setCategory(value)}
                        style={{width: 140}}
                        options={[
                            {label: '全部类型', value: 'all'},
                            {label: '压测预设', value: 'benchmark'},
                            {label: 'Topic 模板', value: 'topic'},
                        ]}
                    />
                    <Select
                        aria-label="按安装状态筛选插件"
                        value={status}
                        onChange={value => setStatus(value)}
                        style={{width: 130}}
                        options={[
                            {label: '全部状态', value: 'all'},
                            {label: '已安装', value: 'installed'},
                            {label: '未安装', value: 'available'},
                        ]}
                    />
                    <Upload
                        accept=".json"
                        showUploadList={false}
                        // 必须显式返回 false：返回 undefined 时 antd 会认为要照常上传，
                        // 于是把文件 POST 到当前页面地址（dev 下 5173，打包后 file://）。
                        beforeUpload={file => {
                            void importFile(file);
                            return false;
                        }}
                    >
                        <Button icon={<DownloadOutlined rotate={180} />} disabled={busy}>
                            导入插件文件
                        </Button>
                    </Upload>
                    <Button icon={<FolderOpenOutlined />} onClick={() => void revealDir()} disabled={busy}>
                        打开插件目录
                    </Button>
                    <Button icon={<ReloadOutlined />} onClick={() => void load()} disabled={busy}>
                        刷新
                    </Button>
                </Space>
            </Card>

            <StateBlock
                loading={!ready && entries.length === 0}
                onRetry={() => void load()}
                empty={visible.length === 0}
                emptyText={entries.length === 0 ? '插件目录里还没有任何插件' : '没有匹配的插件'}
                action={
                    entries.length === 0 ? (
                        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
                            重新读取插件目录
                        </Button>
                    ) : undefined
                }
            >
                <Row gutter={[16, 16]}>
                    {visible.map(plugin => (
                        <Col key={plugin.id} xs={24} lg={12} xxl={8}>
                            <Card
                                size="small"
                                title={
                                    <Space size={6}>
                                        <Text strong>{plugin.name}</Text>
                                        <Tag>v{plugin.version}</Tag>
                                        <Tag color={plugin.source === 'official' ? 'blue' : 'purple'}>
                                            {plugin.source === 'official' ? '官方' : '本地'}
                                        </Tag>
                                    </Space>
                                }
                                extra={
                                    <Space size="small">
                                        {plugin.installed ? (
                                            <>
                                                <Switch
                                                    size="small"
                                                    aria-label={`启用插件 ${plugin.name}`}
                                                    checked={plugin.enabled}
                                                    loading={busyId === plugin.id}
                                                    disabled={busyId === plugin.id}
                                                    onChange={checked => void toggle(plugin, checked)}
                                                />
                                                <IconButton
                                                    size="small"
                                                    type="text"
                                                    danger
                                                    label={`卸载插件 ${plugin.name}`}
                                                    disabled={busyId === plugin.id}
                                                    loading={busyId === plugin.id}
                                                    icon={<DeleteOutlined />}
                                                    onClick={() => uninstall(plugin)}
                                                />
                                            </>
                                        ) : (
                                            <Button
                                                size="small"
                                                type="primary"
                                                loading={busyId === plugin.id}
                                                disabled={busyId === plugin.id}
                                                onClick={() => void install(plugin.id)}
                                            >
                                                安装
                                            </Button>
                                        )}
                                    </Space>
                                }
                            >
                                <Text className="hint-text">
                                    {plugin.id}
                                    {plugin.author ? ` · ${plugin.author}` : ''}
                                </Text>
                                {plugin.description ? (
                                    <Paragraph style={{marginTop: 'var(--spacing-sm)', marginBottom: 0}}>
                                        {plugin.description}
                                    </Paragraph>
                                ) : null}
                                {renderContributions(plugin)}
                            </Card>
                        </Col>
                    ))}
                </Row>
            </StateBlock>

            <Text className="hint-text">插件目录：{pluginsDir || '读取中'}</Text>
        </PageShell>
    );
};

export default PluginMarket;
