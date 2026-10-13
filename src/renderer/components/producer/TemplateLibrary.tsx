import React, {useCallback, useEffect, useState} from 'react';
import {Button, Checkbox, Input, Popconfirm, Select, Space, Tooltip, message} from 'antd';
import {CopyOutlined, DeleteOutlined, ReloadOutlined, SaveOutlined} from '@ant-design/icons';
import type {MessageTemplate, ProducerOptions, TemplateVariable} from '../../types';

// 模板库：全部在本地 SQLite 里，集群断了也能翻出上次写好的报文——
// 这正是把它建成本地表而不是每次去 broker 查的理由。

export interface TemplateDraft {
    name: string;
    body: string;
    variables: TemplateVariable[];
    properties?: Record<string, string>;
}

interface TemplateLibraryProps {
    clusterId: string;
    topicUri: string;
    draft: TemplateDraft;
    // 存的是页面上当前这份参数，而不是模板里原来带的：用户调完批大小点保存，
    // 落库的必须是他此刻看到的数。
    producerOptions: ProducerOptions;
    currentId?: string;
    onApply: (template: MessageTemplate) => void;
    onSaved: (template: MessageTemplate) => void;
    onNameChange: (name: string) => void;
    // 删除的是当前模板时让父层把 id 也清掉：只清名字的话，点「更新」会拿着已删的 id 去 update
    onDeleted?: (id: string) => void;
}

const scopeLabel = (template: MessageTemplate): string =>
    template.topicUri
        ? `${template.name}（${template.topicUri.replace(/^(?:non-)?persistent:\/\//, '')}）`
        : `${template.name}（通用）`;

const TemplateLibrary: React.FC<TemplateLibraryProps> = ({
    clusterId,
    topicUri,
    draft,
    producerOptions,
    currentId,
    onApply,
    onSaved,
    onNameChange,
    onDeleted,
}) => {
    const [templates, setTemplates] = useState<MessageTemplate[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    // 新建时默认绑当前 topic；勾了就存成通用模板（topic_uri 空），其他 topic 也能用
    const [asGeneric, setAsGeneric] = useState(false);

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            const response = await window.electronAPI.template.list({clusterId, topicUri});
            if (response.success) {
                setTemplates(response.data || []);
            } else {
                message.error(response.error || '读取模板库失败');
            }
        } finally {
            setLoading(false);
        }
    }, [clusterId, topicUri]);

    useEffect(() => {
        void reload();
    }, [reload]);

    const persist = async (id?: string, scopeTopicUri?: string) => {
        if (!draft.name.trim()) {
            message.warning('先给模板起个名字');
            return;
        }
        setSaving(true);
        try {
            const response = await (id ? window.electronAPI.template.update : window.electronAPI.template.create)({
                id,
                clusterId,
                topicUri: scopeTopicUri ?? topicUri,
                name: draft.name.trim(),
                body: draft.body,
                variables: draft.variables,
                properties: draft.properties,
                producerOptions,
                // schema 校验在批次 8 接上，这里先按"不校验"落库，
                // 存了 inline 却没有校验链路会让用户以为报文被按 schema 检查过。
                schemaMode: 'none',
            });
            if (response.success && response.data) {
                onSaved(response.data);
                void reload();
                message.success(id ? `已更新「${response.data.name}」` : `已保存到模板库：${response.data.name}`);
            } else {
                // 同作用域重名会被唯一索引拒绝，这句错误必须原样送达：
                // 只报"保存失败"用户会以为是集群连不上。
                message.error(response.error || '保存失败');
            }
        } finally {
            setSaving(false);
        }
    };

    const remove = async (id: string) => {
        const response = await window.electronAPI.template.delete(id);
        if (response.success) {
            if (currentId === id) {
                onNameChange('');
                onDeleted?.(id);
            }
            void reload();
        } else {
            message.error(response.error || '删除失败');
        }
    };

    const copy = async (id: string) => {
        const response = await window.electronAPI.template.copy({id});
        if (response.success && response.data) {
            void reload();
            onApply(response.data);
            message.success(`已复制为「${response.data.name}」`);
        } else {
            message.error(response.error || '复制失败');
        }
    };

    const selected = templates.find(item => item.id === currentId);

    return (
        <Space wrap size="small">
            <span className="field-label">模板</span>
            <Select
                aria-label="选择报文模板"
                size="small"
                style={{width: 240}}
                loading={loading}
                placeholder={templates.length ? '选择模板' : '模板库为空'}
                value={currentId}
                onChange={value => {
                    const template = templates.find(item => item.id === value);
                    if (template) {
                        onApply(template);
                    }
                }}
                options={templates.map(item => ({
                    value: item.id,
                    // 通用模板不带 topic 前缀，否则一行里全是重复的 public/default
                    label: scopeLabel(item),
                }))}
            />
            <Input
                aria-label="模板名称"
                size="small"
                style={{width: 160}}
                value={draft.name}
                onChange={event => onNameChange(event.target.value)}
                placeholder="模板名称"
            />
            {!currentId && (
                <Checkbox checked={asGeneric} onChange={event => setAsGeneric(event.target.checked)}>
                    <Tooltip title="存成不限 topic 的通用模板，本集群其他 topic 的工作台也能选到它">
                        <span>通用</span>
                    </Tooltip>
                </Checkbox>
            )}
            {currentId ? (
                <Button
                    size="small"
                    icon={<SaveOutlined />}
                    loading={saving}
                    onClick={() => persist(currentId, selected?.topicUri ?? topicUri)}
                >
                    更新
                </Button>
            ) : (
                <Button
                    size="small"
                    icon={<SaveOutlined />}
                    loading={saving}
                    onClick={() => persist(undefined, asGeneric ? '' : topicUri)}
                >
                    保存
                </Button>
            )}
            <Button
                size="small"
                icon={<CopyOutlined />}
                disabled={!currentId}
                onClick={() => currentId && copy(currentId)}
            >
                另存副本
            </Button>
            <Popconfirm
                title="删除这个模板？"
                description="只删本地模板库里的这一条，已经发出去的消息不受影响。"
                okText="删除"
                okButtonProps={{danger: true}}
                onConfirm={() => currentId && remove(currentId)}
            >
                <Button size="small" icon={<DeleteOutlined />} disabled={!currentId} aria-label="删除模板" />
            </Popconfirm>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void reload()} aria-label="重新读取模板库" />
        </Space>
    );
};

export default TemplateLibrary;
