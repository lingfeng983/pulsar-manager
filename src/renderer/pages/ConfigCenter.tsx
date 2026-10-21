import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
    Alert,
    Button,
    Card,
    Col,
    InputNumber,
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
import {DownloadOutlined, UploadOutlined, ReloadOutlined, DeleteOutlined, FolderOpenOutlined} from '@ant-design/icons';
import type {ConfigBundle, ConfigImportResult, ConfigMeta} from '../types';
import {useSettingsStore} from '../store/settings';
import {useThemeStore} from '../store/theme';
import {useClusterStore} from '../store/cluster';
import {useShortcutStore} from '../store/shortcuts';
import {downloadBlob} from '../utils/download';
import {FONT_SIZE_OPTIONS} from '../utils/fontScale';
import PageShell from '../components/common/PageShell';
import StateBlock from '../components/common/StateBlock';
import {useConfirmDanger} from '../components/common/dangerConfirm';

const {Text} = Typography;

const REFRESH_OPTIONS = [
    {label: '5 秒', value: 5},
    {label: '10 秒', value: 10},
    {label: '30 秒', value: 30},
    {label: '1 分钟', value: 60},
    {label: '5 分钟', value: 300},
    {label: '手动', value: 0},
];

// 集群状态探活比普通刷新重（逐集群打 broker），档位从 30 秒起步
const STATUS_REFRESH_OPTIONS = [
    {label: '30 秒', value: 30},
    {label: '1 分钟', value: 60},
    {label: '5 分钟', value: 300},
    {label: '10 分钟', value: 600},
    {label: '仅启动时', value: 0},
];

// 快照保留天数用预设而不是数字框：每敲一个字符就写一次设置没有意义，
// 而"留多久"本来就只有几档常用值。
const METRICS_RETENTION_OPTIONS = [
    {label: '1 天', value: 1},
    {label: '3 天', value: 3},
    {label: '7 天', value: 7},
    {label: '30 天', value: 30},
    {label: '90 天', value: 90},
];

// 告警评估间隔同样是预设档位：下限 10 秒由主进程的 zod 卡着（一轮要发几十到上千
// 个 admin 请求，再密就成攻击自己的 broker），这里只把常用几档摆出来。
const ALERT_CHECK_OPTIONS = [
    {label: '10 秒', value: 10},
    {label: '30 秒', value: 30},
    {label: '1 分钟', value: 60},
    {label: '5 分钟', value: 300},
    {label: '15 分钟', value: 900},
];

// 事件保留：未恢复的事件不受这个天数约束，一直留到确认或恢复为止
const ALERT_RETENTION_OPTIONS = [
    {label: '7 天', value: 7},
    {label: '30 天', value: 30},
    {label: '90 天', value: 90},
    {label: '180 天', value: 180},
];

// 导入前的本地体检：文件选错（比如拿了日志导出）时给出人话提示，
// 而不是把整包丢给主进程再回一句 zod 校验失败。
function looksLikeConfigBundle(raw: unknown): raw is ConfigBundle {
    if (!raw || typeof raw !== 'object') return false;
    const candidate = raw as Partial<ConfigBundle>;
    return candidate.format === 'pulsar-manager-config' && candidate.version === 1;
}

const ConfigCenter: React.FC = () => {
    const confirmDanger = useConfirmDanger();
    const settings = useSettingsStore(state => state.settings);
    const updateSettings = useSettingsStore(state => state.update);
    const resetSettings = useSettingsStore(state => state.reset);
    const theme = useThemeStore(state => state.theme);
    const setTheme = useThemeStore(state => state.setTheme);
    const fetchClusters = useClusterStore(state => state.fetchClusters);
    const loadShortcuts = useShortcutStore(state => state.load);

    const [meta, setMeta] = useState<ConfigMeta | null>(null);
    const [metaLoading, setMetaLoading] = useState(true);
    const [metaError, setMetaError] = useState<string | null>(null);
    // 重试与首屏加载可能同时在途，晚到的那一份不能覆盖新一轮的结果
    const metaRequestRef = useRef(0);
    const [busy, setBusy] = useState(false);
    const [logBusy, setLogBusy] = useState(false);
    // 截断长度在输入过程中只改草稿，失焦/回车才落库：
    // 直接每敲一位就写一次设置，输入 500 会先落 5、50，再落 500。
    const [truncateDraft, setTruncateDraft] = useState<number | null>(null);

    const loadMeta = useCallback(() => {
        const requestId = ++metaRequestRef.current;
        const isStale = () => requestId !== metaRequestRef.current;

        setMetaLoading(true);
        setMetaError(null);
        window.electronAPI.config
            .meta()
            .then(response => {
                if (isStale()) {
                    return;
                }
                if (response.success && response.data) {
                    setMeta(response.data);
                } else {
                    setMetaError(response.error || '读取运行信息失败');
                }
            })
            .catch((error: unknown) => {
                if (!isStale()) {
                    setMetaError(error instanceof Error ? error.message : String(error));
                }
            })
            .finally(() => {
                if (!isStale()) {
                    setMetaLoading(false);
                }
            });
    }, []);

    useEffect(() => {
        loadMeta();
    }, [loadMeta]);

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

    const handleClearLogs = () => {
        confirmDanger({
            title: '清空操作日志',
            description: '日志只存在本机，清空后无法找回。',
            okText: '清空',
            onOk: async () => {
                const response = await window.electronAPI.config.clearLogs();
                if (!response.success) {
                    // 抛错让 antd 保持确认框打开，失败不会被静默关掉
                    throw new Error(response.error || '清空失败');
                }
                message.success(`已清空操作日志（删除 ${response.data?.deleted ?? 0} 条）`);
            },
        });
    };

    const handleOpenLogDir = async () => {
        try {
            const response = await window.electronAPI.logs.openDir();
            if (!response.success) {
                message.error(response.error || '打开日志目录失败');
                return;
            }
            if (response.data?.failure) {
                message.error(response.data.failure);
                return;
            }
            message.success(`已打开日志目录：${response.data?.dir ?? ''}`);
        } catch (error) {
            message.error(`打开日志目录失败：${(error as Error).message}`);
        }
    };

    const handleExportLogs = async () => {
        setLogBusy(true);
        try {
            const response = await window.electronAPI.logs.export();
            if (!response.success) {
                message.error(response.error || '导出失败');
                return;
            }
            // 用户在"另存为"里取消不是失败
            if (!response.data) {
                return;
            }
            message.success(`日志已导出到 ${response.data.path}`);
        } catch (error) {
            message.error(`导出失败：${(error as Error).message}`);
        } finally {
            setLogBusy(false);
        }
    };

    const handleChooseLogDir = async () => {
        setLogBusy(true);
        try {
            const response = await window.electronAPI.logs.chooseDir();
            if (!response.success) {
                message.error(response.error || '修改日志目录失败');
                return;
            }
            if (!response.data) {
                return;
            }
            message.success(`运行时日志已切换到 ${response.data.dir}，新的日志会写入该目录`);
            // 路径显示直接读 config:meta，切换后必须重取
            loadMeta();
        } catch (error) {
            message.error(`修改日志目录失败：${(error as Error).message}`);
        } finally {
            setLogBusy(false);
        }
    };

    const handleResetSettings = () => {
        confirmDanger({
            title: '恢复默认设置',
            description: '只影响界面与刷新相关的设置，不动集群配置。',
            okText: '恢复',
            onOk: async () => {
                const result = await resetSettings();
                if (!result.ok) {
                    throw new Error(result.error ?? '恢复失败');
                }
                message.success('已恢复默认设置');
            },
        });
    };

    return (
        <PageShell subtitle="这里改的是应用自身的设置，全部落在本机 SQLite，改完立即生效。">
            <Row gutter={[12, 12]}>
                <Col span={12}>
                    <Card title="界面" size="small">
                        <Space direction="vertical" size={8} style={{width: '100%'}}>
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
                                <Text>字号</Text>
                                <div style={{marginTop: 4}}>
                                    <Radio.Group
                                        aria-label="界面字号"
                                        value={settings.fontSize}
                                        onChange={event => void patch({fontSize: event.target.value})}
                                        optionType="button"
                                        buttonStyle="solid"
                                        size="small"
                                    >
                                        {FONT_SIZE_OPTIONS.map(option => (
                                            <Radio.Button key={option.value} value={option.value}>
                                                {option.label}
                                            </Radio.Button>
                                        ))}
                                    </Radio.Group>
                                </div>
                                <Text className="hint-text">
                                    整界面文字一起缩放：表格、菜单、侧边栏与图表字号同时变化，切档立即生效
                                </Text>
                            </div>
                            <div>
                                <Text>消息正文截断长度（20 ~ 500 字符）</Text>
                                <div style={{marginTop: 4}}>
                                    <InputNumber
                                        aria-label="消息正文截断长度"
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
                                <Text className="hint-text">
                                    消息浏览器列表里的正文超过该长度即折叠，可点"展开全文"看完整内容
                                </Text>
                            </div>
                            <div>
                                <Space size={4}>
                                    <Text>发送历史全文留存</Text>
                                    <Switch
                                        aria-label="发送历史全文留存"
                                        checked={settings.sendHistoryFullBody}
                                        onChange={checked => void patch({sendHistoryFullBody: checked})}
                                        size="small"
                                    />
                                </Space>
                                <div style={{marginTop: 4}}>
                                    <Text className="hint-text">
                                        开启后发送历史连带整篇模板正文落库（单行上限 512
                                        KB），工作台的历史里才能原样重发； 关掉只留 400
                                        字符前缀。默认关：全文会让库持续变大。
                                    </Text>
                                </div>
                            </div>
                            <div>
                                <Space size={4}>
                                    <Text>监控曲线留存</Text>
                                    <Switch
                                        aria-label="监控曲线留存"
                                        checked={settings.metricsSnapshotEnabled}
                                        onChange={checked => void patch({metricsSnapshotEnabled: checked})}
                                        size="small"
                                    />
                                </Space>
                                <div style={{marginTop: 4}}>
                                    <Text className="hint-text">
                                        开启后监控页每次刷新都会把速率、吞吐与积压落库，切页签或重启应用后
                                        趋势图仍有历史；关掉则曲线只活在本次会话的内存里。
                                    </Text>
                                </div>
                            </div>
                            <div>
                                <Space size={4}>
                                    <Text>快照保留</Text>
                                    <Select
                                        aria-label="快照保留天数"
                                        size="small"
                                        value={settings.metricsRetentionDays}
                                        options={METRICS_RETENTION_OPTIONS}
                                        style={{width: 120}}
                                        onChange={value => void patch({metricsRetentionDays: value})}
                                    />
                                </Space>
                                <div style={{marginTop: 4}}>
                                    <Text className="hint-text">
                                        超期的快照点在写入与读取时顺带清理，不额外跑定时器。
                                    </Text>
                                </div>
                            </div>
                            <div>
                                <Space size={4}>
                                    <Text>告警评估</Text>
                                    <Switch
                                        aria-label="告警评估"
                                        checked={settings.alertEnabled}
                                        onChange={checked => void patch({alertEnabled: checked})}
                                        size="small"
                                    />
                                </Space>
                                <div style={{marginTop: 4}}>
                                    <Text className="hint-text">
                                        开关管的是引擎本身：关掉之后规则仍留着，但不会再评估、也不会发通知。 走 SSH
                                        隧道的集群会按下面的间隔被唤起一次。
                                    </Text>
                                </div>
                            </div>
                            <div>
                                <Space size={4}>
                                    <Text>评估间隔</Text>
                                    <Select
                                        aria-label="告警评估间隔"
                                        size="small"
                                        value={settings.alertCheckSeconds}
                                        options={ALERT_CHECK_OPTIONS}
                                        style={{width: 120}}
                                        onChange={value => void patch({alertCheckSeconds: value})}
                                    />
                                </Space>
                                <div style={{marginTop: 4}}>
                                    <Text className="hint-text">
                                        命名空间与集群口径一轮要读几十到上千个 Topic 的统计，间隔太短会拖慢 broker
                                        的响应。
                                    </Text>
                                </div>
                            </div>
                            <div>
                                <Space size={4}>
                                    <Text>事件保留</Text>
                                    <Select
                                        aria-label="告警事件保留天数"
                                        size="small"
                                        value={settings.alertRetentionDays}
                                        options={ALERT_RETENTION_OPTIONS}
                                        style={{width: 120}}
                                        onChange={value => void patch({alertRetentionDays: value})}
                                    />
                                </Space>
                                <div style={{marginTop: 4}}>
                                    <Text className="hint-text">
                                        只清理已恢复的事件；未恢复的那条无论多久都留在列表里，直到它恢复或被确认。
                                    </Text>
                                </div>
                            </div>
                        </Space>
                    </Card>
                </Col>

                <Col span={12}>
                    <Card title="刷新节奏" size="small">
                        <Space direction="vertical" size={8} style={{width: '100%'}}>
                            <div>
                                <Space size={4}>
                                    <Text>自动刷新</Text>
                                    <Switch
                                        aria-label="自动刷新监控"
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
                                        aria-label="监控刷新间隔"
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
                                <Text className="hint-text">
                                    监控面板按此节奏拉取集群统计；选"手动"后只响应刷新按钮
                                </Text>
                            </div>
                            <div>
                                <Text>集群状态刷新间隔</Text>
                                <div style={{marginTop: 4}}>
                                    <Select
                                        aria-label="集群状态刷新间隔"
                                        value={settings.statusRefreshSeconds}
                                        options={STATUS_REFRESH_OPTIONS}
                                        style={{width: 160}}
                                        onChange={value => void patch({statusRefreshSeconds: value})}
                                    />
                                </div>
                                <Text className="hint-text">
                                    首页与侧边栏的集群在线状态启动时自动探一次，之后按此节奏轮询；选"仅启动时"则只探一次
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
                                <Button icon={<ReloadOutlined />} onClick={handleResetSettings}>
                                    恢复默认
                                </Button>
                            </Space>
                            {/* 单行提示：带 description 的两段式 Alert 会占掉一整屏高度的三分之一 */}
                            <Alert
                                type="info"
                                showIcon
                                message={
                                    '导出文件不含任何凭据：Token / TLS 证书、SSH 的密码与私钥都以加密形式存在本机，不会写进导出文件，' +
                                    '导入后需在集群配置里重新填一次凭据。导入只做新增，同名集群会被跳过。'
                                }
                            />
                        </Space>
                    </Card>
                </Col>

                <Col span={24}>
                    <Card title="日志" size="small">
                        <Space direction="vertical" size={8} style={{width: '100%'}}>
                            <Text copyable={meta?.logPath ? {text: meta.logPath} : undefined}>
                                运行时日志：{meta?.logPath || '读取中…'}
                            </Text>
                            <Text className="hint-text">
                                默认目录是 %APPDATA%\pulsar-manager\logs；单个文件超过 2MB 轮转为 main.1.log，保留最近 5
                                份备份（最多约 12MB）。
                            </Text>
                            <Space wrap>
                                <Button icon={<FolderOpenOutlined />} onClick={() => void handleOpenLogDir()}>
                                    打开日志目录
                                </Button>
                                <Button onClick={() => void handleChooseLogDir()} loading={logBusy}>
                                    修改位置
                                </Button>
                                <Button
                                    icon={<DownloadOutlined />}
                                    onClick={() => void handleExportLogs()}
                                    loading={logBusy}
                                >
                                    导出日志
                                </Button>
                                <Button danger icon={<DeleteOutlined />} onClick={handleClearLogs}>
                                    清空操作日志
                                </Button>
                            </Space>
                            <Text className="hint-text">
                                导出会把操作日志与运行时日志合并成一个 JSON 文件，位置由系统"另存为"对话框决定。
                            </Text>
                        </Space>
                    </Card>
                </Col>

                <Col span={24}>
                    <Card title="运行信息" size="small">
                        <StateBlock
                            loading={metaLoading}
                            error={metaError}
                            errorTitle="运行信息读取失败"
                            onRetry={loadMeta}
                        >
                            {meta ? (
                                <Space direction="vertical" size={4} style={{width: '100%'}}>
                                    <Text>
                                        应用版本：<Tag color="blue">{meta.appVersion}</Tag>
                                    </Text>
                                    <Text copyable={{text: meta.databasePath}}>本地数据库：{meta.databasePath}</Text>
                                    <Text className="hint-text">快捷键绑定在"快捷键配置"页里单独管理与导入导出。</Text>
                                </Space>
                            ) : null}
                        </StateBlock>
                    </Card>
                </Col>
            </Row>
        </PageShell>
    );
};

export default ConfigCenter;
