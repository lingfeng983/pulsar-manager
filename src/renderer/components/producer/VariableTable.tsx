import React, {useMemo} from 'react';
import {Button, Input, Space, Table, Tooltip} from 'antd';
import {DeleteOutlined, PlusOutlined, ThunderboltOutlined} from '@ant-design/icons';
import type {TemplateVariable} from '../../types';
import {FUNCTION_SIGNATURES, KNOWN_FUNCTIONS, referencedVariables} from '../../../shared/template-engine';

// 变量表：具名变量在一条报文里只求值一次，多个字段引用同一个 ${user} 拿到的是
// 同一个值——这是它区别于逐处内联占位符的唯一理由，界面上得把这件事说清楚。

interface VariableTableProps {
    value: TemplateVariable[];
    onChange: (next: TemplateVariable[]) => void;
    // 正文：「从正文收集」按它补出漏写的裸变量名
    body: string;
}

const FUNCTION_LIST = KNOWN_FUNCTIONS.map(name => FUNCTION_SIGNATURES[name]);

const VariableTable: React.FC<VariableTableProps> = ({value, onChange, body}) => {
    const knownNames = useMemo(() => new Set(value.map(item => item.name)), [value]);

    const patch = (index: number, next: Partial<TemplateVariable>) => {
        onChange(value.map((item, position) => (position === index ? {...item, ...next} : item)));
    };

    const collectFromBody = () => {
        // referencedVariables 只吐正文里用到的裸名字：已经定义的保持原值不动，
        // 缺的补一行空表达式，让用户自己决定这个变量到底等于什么，
        // 而不是我们猜一个 int(0,100) 塞进去。
        const missing = referencedVariables(body).filter(name => !knownNames.has(name));
        if (missing.length === 0) {
            return;
        }
        onChange([...value, ...missing.map(name => ({name, expr: ''}))]);
    };

    return (
        <Space direction="vertical" size="small" style={{width: '100%'}}>
            <Table<TemplateVariable>
                dataSource={value}
                rowKey={(record, index) => `${index}-${record.name}`}
                pagination={false}
                size="small"
                columns={[
                    {
                        title: '变量名',
                        dataIndex: 'name',
                        width: 140,
                        render: (text: string, _record: TemplateVariable, index: number) => (
                            <Input
                                aria-label="变量名"
                                size="small"
                                value={text}
                                status={text && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(text) ? 'error' : undefined}
                                onChange={event => patch(index, {name: event.target.value})}
                                placeholder="user"
                            />
                        ),
                    },
                    {
                        title: '表达式',
                        dataIndex: 'expr',
                        render: (text: string, record, index) => (
                            <Input
                                aria-label="变量表达式"
                                size="small"
                                value={text}
                                status={record.name && !text.trim() ? 'error' : undefined}
                                onChange={event => patch(index, {expr: event.target.value})}
                                placeholder="int(1000, 9999)"
                            />
                        ),
                    },
                    {
                        title: '',
                        key: 'actions',
                        width: 40,
                        render: (_, record, index) => (
                            <Button
                                type="text"
                                size="small"
                                aria-label={`删除变量 ${record.name}`}
                                icon={<DeleteOutlined />}
                                onClick={() => onChange(value.filter((_, position) => position !== index))}
                            />
                        ),
                    },
                ]}
            />
            <Space wrap size="small">
                <Button
                    size="small"
                    icon={<PlusOutlined />}
                    onClick={() => onChange([...value, {name: '', expr: ''}])}
                    aria-label="新增变量"
                >
                    新增变量
                </Button>
                <Button
                    size="small"
                    icon={<ThunderboltOutlined />}
                    onClick={collectFromBody}
                    aria-label="从正文收集变量"
                >
                    从正文收集
                </Button>
                <Tooltip
                    title={
                        <div style={{fontFamily: 'var(--font-mono)'}}>
                            {FUNCTION_LIST.map(line => (
                                <div key={line}>{line}</div>
                            ))}
                        </div>
                    }
                >
                    <span className="hint-text">函数清单</span>
                </Tooltip>
            </Space>
        </Space>
    );
};

export default VariableTable;
