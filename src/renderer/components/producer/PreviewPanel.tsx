import React, {useMemo} from 'react';
import {Button, Space, Tag} from 'antd';
import {LockOutlined, UnlockOutlined} from '@ant-design/icons';
import type {TemplateVariable} from '../../types';
import {resolveTemplate} from '../../../shared/template-engine';

// 预览与实发同源：这里直接调 shared/template-engine 的 resolveTemplate，参数
// 与主进程解析时完全一致（同一个 seed、第 0 条）。渲染层自己另算一套的话，
// 用户看到的就是"预览对、发出去错"，而那正是这套模板最容易出的事故。

interface PreviewPanelProps {
    body: string;
    variables: TemplateVariable[];
    // undefined 表示不锁随机：每次预览都换一组值，实发也用 Math.random
    seed?: number;
    onSeedChange: (next?: number) => void;
    height?: number;
}

const PreviewPanel: React.FC<PreviewPanelProps> = ({body, variables, seed, onSeedChange, height = 200}) => {
    const result = useMemo(() => resolveTemplate(body, variables, {seed, messageIndex: 0}), [body, variables, seed]);

    // 展示用重排：引擎输出的是紧凑 JSON，逐字节与实发一致；这里只在"能解析"时
    // 换个读得动的形状，改的是显示不是内容。
    const display = useMemo(() => {
        if (!result.ok) {
            return '';
        }
        try {
            return JSON.stringify(JSON.parse(result.text) as unknown, null, 2);
        } catch {
            return result.text;
        }
    }, [result]);

    const lock = () => {
        // 1e9 以内：整数种子要能进 z.number().int()，也要能被 xorshift 直接吃下
        onSeedChange(Math.floor(Math.random() * 1_000_000_000));
    };

    return (
        <Space direction="vertical" size="small" style={{width: '100%'}}>
            <div className="summary-line metric-line">
                {result.ok ? (
                    <>
                        <strong>{result.bytes}</strong> 字节
                        <span className="hint-text">第 1 条，随机值每次预览都变；多条目之间互不相同</span>
                    </>
                ) : (
                    <span style={{color: 'var(--color-danger)'}}>{result.error}</span>
                )}
                <span style={{marginLeft: 'auto'}}>
                    {seed === undefined ? (
                        <Button
                            size="small"
                            type="text"
                            icon={<UnlockOutlined />}
                            onClick={lock}
                            aria-label="锁定随机种子"
                        >
                            随机
                        </Button>
                    ) : (
                        <Space size={2}>
                            <Tag color="blue" style={{marginRight: 0}}>
                                seed {seed}
                            </Tag>
                            <Button
                                size="small"
                                type="text"
                                icon={<LockOutlined />}
                                onClick={() => onSeedChange(undefined)}
                                aria-label="取消锁定随机种子"
                            />
                        </Space>
                    )}
                </span>
            </div>
            <pre
                className="field-value"
                style={{
                    margin: 0,
                    padding: 'var(--spacing-sm)',
                    maxHeight: height,
                    overflow: 'auto',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--font-size-xs)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    backgroundColor: 'var(--color-bg-secondary)',
                    borderRadius: 'var(--radius-sm)',
                }}
            >
                {display || '（无法解析）'}
            </pre>
        </Space>
    );
};

export default PreviewPanel;
