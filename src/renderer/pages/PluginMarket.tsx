import React, {useCallback, useMemo, useState} from 'react';
import {
    Alert,
    Button,
    Card,
    Col,
    Collapse,
    Empty,
    Input,
    Popconfirm,
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

const {Text, Title, Paragraph} = Typography;

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
    const entries = usePluginStore(state => state.entries);
    const errors = usePluginStore(state => state.errors);
    const pluginsDir = usePluginStore(state => state.pluginsDir);
    const ready = usePluginStore(state => state.ready);
    const load = usePluginStore(state => state.load);
    const run = usePluginStore(state => state.run);

    const [keyword, setKeyword] = useState('');
    const [category, setCategory] = useState<CategoryFilter>('all');
    const [status, setStatus] = useState<StatusFilter>('all');
    const [busy, setBusy] = useState(false);

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

    const withBusy = useCallback(
        async (action: () => Promise<APIResponse>) => {
            setBusy(true);
            const result = await run(action);
            setBusy(false);
            return result;
        },
        [run],
    );

    const install = async (id: string) => {
        const result = await withBusy(() => window.electronAPI.plugin.installOfficial(id));
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
        const result = await withBusy(() => window.electronAPI.plugin.setEnabled(plugin.id, enabled));
        if (!result.ok) {
            message.error(result.error);
        }
    };

    const uninstall = async (plugin: PluginEntry) => {
        const result = await withBusy(() => window.electronAPI.plugin.uninstall(plugin.id));
        if (result.ok) {
            message.success(`已卸载 ${plugin.name}`);
        } else {
            message.error(result.error);
        }
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
        <div style={{padding: 'var(--spacing-lg)'}}>
            <Title level={4} style={{marginBottom: 4}}>
                插件市场
            </Title>
            <Paragraph type="secondary" style={{marginBottom: 'var(--spacing-md)'}}>
                插件是本地声明式扩展，只贡献数据（压测预设、Topic 创建模板），应用不会加载或执行插件携带的任何代码。
            </Paragraph>

            {errors.length > 0 && (
                <Alert
                    type="warning"
                    showIcon
                    style={{marginBottom: 'var(--spacing-md)'}}
                    message={`${errors.length} 个插件文件没能加载`}
                    description={
                        <Space direction="vertical" size={2}>
                            {errors.map(error => (
                                <Text key={error.file} style={{fontSize: 12}}>
                                    {error.file}：{error.reason}
                                </Text>
                            ))}
                        </Space>
                    }
                />
            )}

            <Card size="small" style={{marginBottom: 'var(--spacing-md)'}}>
                <Space wrap size="middle">
                    <Input.Search
                        placeholder="搜索插件名 / 描述"
                        allowClear
                        style={{width: 220}}
                        onChange={event => setKeyword(event.target.value)}
                    />
                    <Select
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
                        value={status}
                        onChange={value => setStatus(value)}
                        style={{width: 130}}
                        options={[
                            {label: '全部状态', value: 'all'},
                            {label: '已安装', value: 'installed'},
                            {label: '未安装', value: 'available'},
                        ]}
                    />
                    <Upload accept=".json" showUploadList={false} beforeUpload={file => void importFile(file)}>
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

            {!ready && entries.length === 0 ? (
                <Card size="small">
                    <Empty description="正在读取插件目录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                </Card>
            ) : visible.length === 0 ? (
                <Card size="small">
                    <Empty description="没有匹配的插件" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                </Card>
            ) : (
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
                                                    checked={plugin.enabled}
                                                    disabled={busy}
                                                    onChange={checked => void toggle(plugin, checked)}
                                                />
                                                <Popconfirm
                                                    title="卸载插件"
                                                    description="删除本机上的插件文件，官方条目可以重新安装。"
                                                    okText="卸载"
                                                    okButtonProps={{danger: true}}
                                                    cancelText="取消"
                                                    onConfirm={() => void uninstall(plugin)}
                                                >
                                                    <Button size="small" danger type="text" icon={<DeleteOutlined />} />
                                                </Popconfirm>
                                            </>
                                        ) : (
                                            <Button
                                                size="small"
                                                type="primary"
                                                disabled={busy}
                                                onClick={() => void install(plugin.id)}
                                            >
                                                安装
                                            </Button>
                                        )}
                                    </Space>
                                }
                            >
                                <Text type="secondary" style={{fontSize: 12}}>
                                    {plugin.id}
                                    {plugin.author ? ` · ${plugin.author}` : ''}
                                </Text>
                                {plugin.description ? (
                                    <Paragraph style={{marginTop: 6, marginBottom: 0}}>{plugin.description}</Paragraph>
                                ) : null}
                                {renderContributions(plugin)}
                            </Card>
                        </Col>
                    ))}
                </Row>
            )}

            <Text type="secondary" style={{fontSize: 12, display: 'block', marginTop: 'var(--spacing-md)'}}>
                插件目录：{pluginsDir || '读取中'}
            </Text>
        </div>
    );
};

export default PluginMarket;
