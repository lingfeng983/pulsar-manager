import React, {useContext, useEffect, useMemo, useRef, useState} from 'react';
import {Alert, Button, Card, Space, Switch, Table, Tag, Tooltip, Typography, message} from 'antd';
import {DownloadOutlined, ReloadOutlined, UploadOutlined} from '@ant-design/icons';
import {GROUP_ORDER, COMMAND_BY_ID, COMMAND_CATALOG, type CommandId, type CommandMeta} from '../store/commands';
import {useShortcutStore, resolveBinding, isDefaultBinding, findConflicts} from '../store/shortcuts';
import {bindingFromEvent, formatBinding} from '../utils/keybinding';
import {downloadBlob} from '../utils/download';
import {PaneActiveContext} from '../hooks/useKeybindings';
import PageShell from '../components/common/PageShell';
import StateBlock from '../components/common/StateBlock';
import {useConfirmDanger} from '../components/common/dangerConfirm';

const {Text} = Typography;

interface ShortcutRow {
    meta: CommandMeta;
    binding: string | null;
    usingDefault: boolean;
    conflictWith: CommandId[];
}

const ShortcutConfig: React.FC = () => {
    const {config, platform, ready, load, setBinding, resetOne, resetAll, setEnabled, exportConfig, importConfig} =
        useShortcutStore();
    const [capturing, setCapturing] = useState<CommandId | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const paneActive = useContext(PaneActiveContext);
    const confirmDanger = useConfirmDanger();

    useEffect(() => {
        if (!ready) {
            void load();
        }
    }, [ready, load]);

    // 切走页签（antd 只是 display:none）时必须退出捕获态：
    // 捕获用的是 window 级 keydown，不取消的话在别的页签打字也会被它吞掉。
    useEffect(() => {
        if (!paneActive && capturing) {
            setCapturing(null);
            setPreview(null);
            setPreviewError(null);
        }
    }, [paneActive, capturing]);

    const conflicts = useMemo(() => findConflicts(config, platform), [config, platform]);

    const rows = useMemo(() => {
        const byGroup = new Map<string, ShortcutRow[]>();
        GROUP_ORDER.forEach(group => byGroup.set(group, []));
        COMMAND_CATALOG.forEach(meta => {
            byGroup.get(meta.group)?.push({
                meta,
                binding: resolveBinding(config, platform, meta.id),
                usingDefault: isDefaultBinding(config, platform, meta.id),
                conflictWith: conflicts[meta.id] ?? [],
            });
        });
        return byGroup;
    }, [config, platform, conflicts]);

    const totalConflicts = Object.keys(conflicts).length;

    // 捕获态：接管全局 keydown，把按键转成绑定并即时做冲突校验。
    // 冲突时不落库、继续保持捕获，让用户直接改按其它组合键。
    useEffect(() => {
        if (!capturing || !paneActive) {
            return;
        }
        const handleKeyDown = (event: KeyboardEvent) => {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === 'Escape') {
                setCapturing(null);
                setPreview(null);
                setPreviewError(null);
                return;
            }
            const binding = bindingFromEvent(event);
            if (!binding) {
                setPreviewError('请按下包含修饰键的组合键（Esc 取消）');
                return;
            }
            const holder = COMMAND_CATALOG.find(
                other => other.id !== capturing && resolveBinding(config, platform, other.id) === binding,
            );
            if (holder) {
                setPreview(binding);
                setPreviewError(`已被「${COMMAND_BY_ID[holder.id].name}」占用，请改按其它组合键`);
                return;
            }
            void setBinding(capturing, binding);
            setCapturing(null);
            setPreview(null);
            setPreviewError(null);
            message.success(`已绑定「${COMMAND_BY_ID[capturing].name}」`);
        };
        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [capturing, paneActive, platform, config, setBinding]);

    const handleExport = () => {
        downloadBlob(exportConfig(), `pulsar-manager-shortcuts_${platform}.json`);
        message.success('配置已导出');
    };

    const handleImportFile = async (file: File) => {
        try {
            const raw = await file.text();
            const result = importConfig(raw);
            if (result.success) {
                message.success('配置已导入');
            } else {
                message.error(result.error ?? '导入失败');
            }
        } catch {
            message.error('读取文件失败');
        }
    };

    const handleResetAll = () => {
        confirmDanger({
            title: '恢复默认快捷键',
            description: '所有自定义绑定与解绑都会被清空，无法撤销。',
            okText: '恢复',
            onOk: () => {
                resetAll();
                message.success('已恢复出厂快捷键');
            },
        });
    };

    const columns = [
        {
            title: '功能名称',
            dataIndex: 'name',
            key: 'name',
            render: (_: unknown, row: ShortcutRow) => (
                <Space size={4}>
                    <Text>{row.meta.name}</Text>
                    {!row.usingDefault && <Tag color="blue">已自定义</Tag>}
                </Space>
            ),
        },
        {
            title: '当前快捷键',
            key: 'binding',
            width: 200,
            render: (_: unknown, row: ShortcutRow) => {
                const isCapturing = capturing === row.meta.id;
                if (isCapturing) {
                    return (
                        <Tag color={previewError ? 'red' : 'processing'}>
                            {previewError ?? (preview ? formatBinding(preview, platform) : '请按下组合键…')}
                        </Tag>
                    );
                }
                return <Text code>{formatBinding(row.binding, platform)}</Text>;
            },
        },
        {
            title: '冲突标记',
            key: 'conflict',
            width: 200,
            render: (_: unknown, row: ShortcutRow) =>
                row.conflictWith.length === 0 ? (
                    <Text type="secondary">—</Text>
                ) : (
                    <Tooltip title={row.conflictWith.map(id => COMMAND_BY_ID[id].name).join('、')}>
                        <Tag color="red">与 {COMMAND_BY_ID[row.conflictWith[0]].name} 冲突</Tag>
                    </Tooltip>
                ),
        },
        {
            title: '操作',
            key: 'actions',
            width: 200,
            render: (_: unknown, row: ShortcutRow) => (
                <Space size={4}>
                    <Button
                        size="small"
                        type={capturing === row.meta.id ? 'primary' : 'default'}
                        onClick={() => {
                            setCapturing(capturing === row.meta.id ? null : row.meta.id);
                            setPreview(null);
                            setPreviewError(null);
                        }}
                    >
                        {capturing === row.meta.id ? '捕获中' : '编辑'}
                    </Button>
                    <Button size="small" onClick={() => void setBinding(row.meta.id, null)}>
                        解绑
                    </Button>
                    <Button
                        size="small"
                        type="link"
                        disabled={row.usingDefault}
                        onClick={() => void resetOne(row.meta.id)}
                    >
                        重置
                    </Button>
                </Space>
            ),
        },
    ];

    return (
        <PageShell
            title={
                <Space size="small">
                    <span>快捷键配置</span>
                    <Tag>{platform === 'mac' ? 'macOS' : 'Windows / Linux'}</Tag>
                </Space>
            }
            subtitle="两套平台映射相互独立保存；点击「编辑」后按下任意组合键即可绑定，Esc 取消。"
            actions={
                <>
                    <Space size={4}>
                        <Text type="secondary">全局快捷键</Text>
                        <Switch
                            aria-label="启用全局快捷键"
                            checked={config.enabled}
                            onChange={checked => void setEnabled(checked)}
                        />
                    </Space>
                    <Button icon={<UploadOutlined />} onClick={() => fileInputRef.current?.click()}>
                        导入配置
                    </Button>
                    <Button icon={<DownloadOutlined />} onClick={handleExport}>
                        导出配置
                    </Button>
                    <Button icon={<ReloadOutlined />} onClick={handleResetAll}>
                        恢复默认
                    </Button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="application/json"
                        style={{display: 'none'}}
                        onChange={event => {
                            const file = event.target.files?.[0];
                            if (file) {
                                void handleImportFile(file);
                            }
                            event.target.value = '';
                        }}
                    />
                </>
            }
        >
            {!config.enabled && (
                <Alert
                    type="warning"
                    showIcon
                    message="全局快捷键已关闭"
                    description="关闭后所有自定义按键均不会响应，仅可在界面按钮上手动操作。"
                />
            )}

            {totalConflicts > 0 && (
                <Alert
                    type="error"
                    showIcon
                    message={`检测到 ${totalConflicts} 个快捷键冲突`}
                    description="冲突的按键只会触发列表中靠前的功能，请手动调整以保证行为可预期。"
                />
            )}

            <StateBlock loading={!ready}>
                {GROUP_ORDER.map(group => {
                    const groupRows = rows.get(group) ?? [];
                    if (groupRows.length === 0) {
                        return null;
                    }
                    return (
                        <Card key={group} size="small" title={group}>
                            <Table<ShortcutRow>
                                rowKey={row => row.meta.id}
                                size="small"
                                columns={columns}
                                dataSource={groupRows}
                                pagination={false}
                                scroll={{x: 'max-content'}}
                                rowClassName={row => (row.conflictWith.length > 0 ? 'shortcut-row-conflict' : '')}
                            />
                        </Card>
                    );
                })}
            </StateBlock>
        </PageShell>
    );
};

export default ShortcutConfig;
