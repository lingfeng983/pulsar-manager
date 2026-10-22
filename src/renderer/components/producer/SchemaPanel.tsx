import React, {useMemo} from 'react';
import {Input, Radio} from 'antd';
import {parseSchemaJson} from '../../../shared/json-schema-lite';
import type {TemplateSchemaMode} from '../../types';

// Schema 校验面板：只在发送前做结构校验（校验链路在主进程 producer-send 的
// resolveBatch 里），这里负责把 schema 文本立时解析一遍——存一个语法就坏的
// schema 等于给自己埋一个"每条都失败但看不出为什么"的坑。

const EXAMPLE_SCHEMA = [
    '{',
    '  "type": "object",',
    '  "required": ["id", "ts"],',
    '  "properties": {',
    '    "id": {"type": "string"},',
    '    "ts": {"type": "integer"}',
    '  }',
    '}',
].join('\n');

const OK_HINT =
    'schema 语法合法。支持的子集：type（含 integer/number 区分）、enum、const、required、properties、items。';

interface SchemaPanelProps {
    schemaMode: TemplateSchemaMode;
    schemaJson?: string;
    onModeChange: (mode: TemplateSchemaMode) => void;
    onSchemaChange: (schemaJson: string) => void;
}

const SchemaPanel: React.FC<SchemaPanelProps> = ({schemaMode, schemaJson, onModeChange, onSchemaChange}) => {
    const feedback = useMemo(() => {
        if (schemaMode !== 'inline') {
            return null;
        }
        const raw = (schemaJson || '').trim();
        if (!raw) {
            return {ok: false, text: '还没有写 schema：这个模式下每条报文都会被拒发。'};
        }
        const parsed = parseSchemaJson(raw);
        return parsed.ok ? {ok: true, text: OK_HINT} : {ok: false, text: `schema 不合法：${parsed.error}`};
    }, [schemaMode, schemaJson]);

    return (
        <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
            <Radio.Group
                size="small"
                value={schemaMode}
                onChange={event => onModeChange(event.target.value as TemplateSchemaMode)}
                options={[
                    {value: 'none', label: '不校验'},
                    {value: 'inline', label: '内联 JSON Schema'},
                    {value: 'broker', label: 'Broker Schema（暂未接通）'},
                ]}
                optionType="button"
            />
            {schemaMode === 'inline' && (
                <Input.TextArea
                    rows={8}
                    spellCheck={false}
                    style={{fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)'}}
                    value={schemaJson || ''}
                    onChange={event => onSchemaChange(event.target.value)}
                    placeholder={EXAMPLE_SCHEMA}
                    aria-label="内联 JSON Schema"
                />
            )}
            {schemaMode === 'broker' && (
                <div className="hint-text">
                    原生客户端与 Admin REST 都没有"给单条报文按 broker 注册的 schema 校验"的入口，
                    这个模式暂时不可用——发送时会被明确拒绝，不会假装校验过。
                </div>
            )}
            {feedback && <div className={feedback.ok ? 'hint-text' : 'hint-text danger-text'}>{feedback.text}</div>}
        </div>
    );
};

export default SchemaPanel;
