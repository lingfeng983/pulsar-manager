import React, {useEffect, useState} from 'react';
import {
    Alert,
    Button,
    Card,
    Col,
    InputNumber,
    Popconfirm,
    Radio,
    Row,
    Select,
    Space,
    Switch,
    Tag,
    Typography,
    Upload,
    message,
} from 'antd';
import {DownloadOutlined, UploadOutlined, ReloadOutlined, DeleteOutlined} from '@ant-design/icons';
import type {ConfigBundle, ConfigImportResult, ConfigMeta} from '../types';
import {useSettingsStore} from '../store/settings';
import {useThemeStore} from '../store/theme';
import {useClusterStore} from '../store/cluster';
import {useShortcutStore} from '../store/shortcuts';
import {downloadBlob} from '../utils/download';

const {Text, Title, Paragraph} = Typography;

const REFRESH_OPTIONS = [
    {label: '5 秒', value: 5},
    {label: '10 秒', value: 10},
    {label: '30 秒', value: 30},
    {label: '1 分钟', value: 60},
    {label: '5 分钟', value: 300},
    {label: '手动', value: 0},
];

// 导入前的本地体检：文件选错（比如拿了日志导出）时给出人话提示，
// 而不是把整包丢给主进程再回一句 zod 校验失败。
function looksLikeConfigBundle(raw: unknown): raw is ConfigBundle {
    if (!raw || typeof raw !== 'object') return false;
    const candidate = raw as Partial<ConfigBundle>;
    return candidate.format === 'pulsar-manager-config' && candidate.version === 1;
}

const ConfigCenter: React.FC = () => {
    const settings = useSettingsStore(state => state.settings);
    const updateSettings = useSettingsStore(state => state.update);
    const resetSettings = useSettingsStore(state => state.reset);
    const theme = useThemeStore(state => state.theme);
    const setTheme = useThemeStore(state => state.setTheme);
    const fetchClusters = useClusterStore(state => state.fetchClusters);
    const loadShortcuts = useShortcutStore(state => state.load);

    const [meta, setMeta] = useState<ConfigMeta | null>(null);
    const [metaError, setMetaError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // 截断长度在输入过程中只改草稿，失焦/回车才落库：
    // 直接每敲一位就写一次设置，输入 500 会先落 5、50，再落 500。
    const [truncateDraft, setTruncateDraft] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        window.electronAPI.config
            .meta()
            .then(response => {
                if (cancelled) {
                    return;
                }
                if (response.success && response.data) {
                    setMeta(response.data);
                } else {
                    setMetaError(response.error || '读取运行信息失败');
                }
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    setMetaError(error instanceof Error ? error.message : String(error));
                }
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const patch = async (next: Parameters<typeof updateSettings>[0]) => {
        const result = await updateSettings(next);
        if (!result.ok) {
            message.error(`保存失败：${result.error}`);
        }
    };

    const commitTruncate = (value: number | null) => {
        setTruncateDraft(null);
        if (typeof value === 'number' && value !== settings.truncateLength) {
            void patch({truncateLength: value});
        }
    };

    const handleExport = async () => {
        setBusy(true);
        try {
            const response = await window.electronAPI.config.export();
            if (!response.success || !response.data) {
                message.error(response.error || '导出失败');
                return;
            }
            downloadBlob(
                JSON.stringify(response.data, null, 2),
                `pulsar-manager-配置-${new Date().toISOString().slice(0, 10)}.json`,
            );
            message.success(`已导出 ${response.data.clusters.length} 个集群与全部应用设置（不含凭据）`);
        } catch (error) {
            message.error(`导出失败：${(error as Error).message}`);
        } finally {
            setBusy(false);
        }
    };

    const handleImport = async (file: File) => {
        setBusy(true);
        try {
            const text = await file.text();
            const parsed: unknown = JSON.parse(text);
            if (!looksLikeConfigBundle(parsed)) {
                message.error('文件不是本工具导出的配置（缺少 format/version 标记）');
                return;
            }
            const response = await window.electronAPI.config.import(parsed);
            if (!response.success || !response.data) {
                message.error(`导入失败：${response.error || '未知错误'}`);
                return;
            }
            const result: ConfigImportResult = response.data;
            const skipped = result.clustersSkipped.length ? `，跳过同名集群 ${result.clustersSkipped.join('、')}` : '';
            message.success(`导入完成：新增集群 ${result.clustersImported} 个${skipped}，应用设置已更新`);
            // 导入直接写了库，渲染层三份状态必须重新取，否则界面还停在旧值上
            await Promise.all([useSettingsStore.getState().load(), fetchClusters(), loadShortcuts()]);
        } catch (error) {
            message.error(`导入失败：${(error as Error).message}`);
        } finally {
            setBusy(false);
        }
    };

    const handleClearLogs = async () => {
        setBusy(true);
        try {
            const response = await window.electronAPI.config.clearLogs();
            if (response.success) {
                message.success(`已清空操作日志（删除 ${response.data?.deleted ?? 0} 条）`);
            } else {
                message.error(response.error || '清空失败');
            }
        } catch (error) {
            message.error(`清空失败：${(error as Error).message}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div style={{padding: 16}}>
            <Title level={4} style={{marginBottom: 4}}>
                配置中心
            </Title>
            <Paragraph type="secondary" style={{marginBottom: 16}}>
                这里改的是应用自身的设置，全部落在本机 SQLite，改完立即生效。
            </Paragraph>

            <Row gutter={[16, 16]}>
                <Col span={12}>
                    <Card title="界面" size="small">
                        <Space direction="vertical" size={12} style={{width: '100%'}}>
                            <div>
                                <Text>主题</Text>
                                <div style={{marginTop: 4}}>
                                    <Radio.Group
                                        value={theme}
                                        onChange={event => setTheme(event.target.value)}
                                        optionType="button"
                                        buttonStyle="solid"
                                        size="small"
                                    >
                                        <Radio.Button value="light">亮色</Radio.Button>
                                        <Radio.Button value="dark">暗色</Radio.Button>
                                        <Radio.Button value="eyeCare">护眼</Radio.Button>
                                    </Radio.Group>
                                </div>
                            </div>
                            <div>
                                <Text>消息正文截断长度（20 ~ 500 字符）</Text>
                                <div style={{marginTop: 4}}>
                                    <InputNumber
                                        min={20}
                                        max={500}
                                        step={10}
                                        value={truncateDraft ?? settings.truncateLength}
                                        onChange={value => setTruncateDraft(typeof value === 'number' ? value : null)}
                                        onBlur={() => commitTruncate(truncateDraft)}
                                        onPressEnter={() => commitTruncate(truncateDraft)}
                                        addonAfter="字符"
                                        style={{width: 160}}
                                    />
                                </div>
                                <Text type="secondary" style={{fontSize: 12}}>
                                    消息浏览器列表里的正文超过该长度即折叠，可点"展开全文"看完整内容
                                </Text>
                            </div>
                        </Space>
                    </Card>
                </Col>

                <Col span={12}>
                    <Card title="监控刷新" size="small">
                        <Space direction="vertical" size={12} style={{width: '100%'}}>
                            <div>
                                <Space>
                                    <Text>自动刷新</Text>
                                    <Switch
                                        checked={settings.autoRefresh}
                                        onChange={checked => void patch({autoRefresh: checked})}
                                        size="small"
                                    />
                                </Space>
                            </div>
                            <div>
                                <Text>刷新间隔</Text>
                                <div style={{marginTop: 4}}>
                                    <Select
                                        value={settings.autoRefresh ? settings.refreshIntervalSeconds : 0}
                                        options={REFRESH_OPTIONS}
                                        style={{width: 160}}
                                        onChange={value => {
                                            // 选"手动"只关自动刷新，保留原来的间隔值：
                                            // 一起写 0 的话，用户再打开开关就变成 0 秒间隔直接不刷新了。
                                            if (value > 0) {
                                                void patch({autoRefresh: true, refreshIntervalSeconds: value});
                                            } else {
                                                void patch({autoRefresh: false});
                                            }
                                        }}
                                    />
                                </div>
                                <Text type="secondary" style={{fontSize: 12}}>
                                    监控面板按此节奏拉取集群统计；选"手动"后只响应刷新按钮
                                </Text>
                            </div>
                        </Space>
                    </Card>
                </Col>

                <Col span={24}>
                    <Card title="配置迁移" size="small">
                        <Space direction="vertical" size={8} style={{width: '100%'}}>
                            <Space wrap>
                                <Button icon={<DownloadOutlined />} onClick={() => void handleExport()} loading={busy}>
                                    导出配置
                                </Button>
                                <Upload
                                    accept=".json"
                                    showUploadList={false}
                                    beforeUpload={file => {
                                        void handleImport(file);
                                        return false;
                                    }}
                                >
                                    <Button icon={<UploadOutlined />}>导入配置</Button>
                                </Upload>
                                <Popconfirm
                                    title="恢复默认设置"
                                    description="只影响界面与刷新相关的设置，不动集群配置。"
                                    onConfirm={async () => {
                                        const result = await resetSettings();
                                        if (result.ok) {
                                            message.success('已恢复默认设置');
                                        } else {
                                            message.error(result.error);
                                        }
                                    }}
                                    okText="恢复"
                                    cancelText="取消"
                                >
                                    <Button icon={<ReloadOutlined />}>恢复默认</Button>
                                </Popconfirm>
                                <Popconfirm
                                    title="清空操作日志"
                                    description="日志只存在本机，清空后无法找回。"
                                    onConfirm={() => void handleClearLogs()}
                                    okText="清空"
                                    okButtonProps={{danger: true}}
                                    cancelText="取消"
                                >
                                    <Button danger icon={<DeleteOutlined />}>
                                        清空操作日志
                                    </Button>
                                </Popconfirm>
                            </Space>
                            <Alert
                                type="info"
                                showIcon
                                message="导出文件不含任何凭据"
                                description={
                                    <span>
                                        集群的 Token / TLS 证书、SSH
                                        的密码与私钥都以加密形式存在本机，不会写进导出文件。
                                        导入后这些集群需要在集群配置里重新填一次凭据。导入只做新增：同名集群会被跳过，不会覆盖已有配置。
                                    </span>
                                }
                            />
                        </Space>
                    </Card>
                </Col>

                <Col span={24}>
                    <Card title="运行信息" size="small">
                        <Space direction="vertical" size={4}>
                            {metaError && (
                                <Alert type="warning" showIcon message="运行信息读取失败" description={metaError} />
                            )}
                            <Text>
                                应用版本：<Tag color="blue">{meta?.appVersion ?? '读取中'}</Tag>
                            </Text>
                            <Text copyable={meta ? {text: meta.databasePath} : false}>
                                本地数据库：{meta?.databasePath ?? '读取中'}
                            </Text>
                            <Text type="secondary" style={{fontSize: 12}}>
                                快捷键绑定在"快捷键配置"页里单独管理与导入导出；Gitee 更新令牌在"设置 →
                                检查更新"里配置。
                            </Text>
                        </Space>
                    </Card>
                </Col>
            </Row>
        </div>
    );
};

export default ConfigCenter;
