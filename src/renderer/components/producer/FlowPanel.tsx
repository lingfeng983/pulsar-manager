import React, {useState} from 'react';
import {Button, InputNumber, Switch, Tooltip} from 'antd';
import {PlayCircleOutlined, StopOutlined} from '@ant-design/icons';
import type {ProducerRunStats} from '../../types';
import {formatThroughputAuto} from '../../utils/format';

// 连续发送面板。速率/总量/在途这三个数只在"这一轮"有意义，所以状态留在组件里，
// 不上抬到页面：多开几条会话时每条各跑各的，抬上去就要按 sessionId 建一张表，
// 而那张表除了这里没人读。

export interface FlowSettings {
    ratePerSecond: number;
    totalMessages: number;
    maxInFlight: number;
    stopOnError: boolean;
}

const DEFAULT_SETTINGS: FlowSettings = {
    ratePerSecond: 100,
    totalMessages: 0,
    maxInFlight: 500,
    stopOnError: true,
};

interface FlowPanelProps {
    running: boolean;
    stats: ProducerRunStats | null;
    busy: boolean;
    onStart: (settings: FlowSettings) => void;
    onStop: () => void;
    onSetRate: (ratePerSecond: number) => void;
}

const FlowPanel: React.FC<FlowPanelProps> = ({running, stats, busy, onStart, onStop, onSetRate}) => {
    const [settings, setSettings] = useState<FlowSettings>(DEFAULT_SETTINGS);
    const patch = (next: Partial<FlowSettings>) => setSettings(current => ({...current, ...next}));
    const latency = stats?.latency || null;

    if (running) {
        return (
            <div className="flow-panel">
                <div className="summary-line metric-line">
                    <strong>{stats?.sent ?? 0}</strong> 条<strong>{stats?.failed ?? 0}</strong> 失败
                    <strong>{stats?.msgPerSec ?? 0}</strong> msg/s
                    <strong>{formatThroughputAuto((stats?.mbPerSec ?? 0) * 1024 * 1024)}</strong>
                    {latency ? (
                        <Tooltip title={`发送确认延迟，抽样 ${latency.count} 条`}>
                            <span>
                                P50 {latency.p50Ms}ms P99 {latency.p99Ms}ms
                            </span>
                        </Tooltip>
                    ) : (
                        <span className="hint-text">延迟暂无样本</span>
                    )}
                </div>
                <div className="summary-line">
                    <Tooltip title="运行中改速率：只换限速器，不断开重连">
                        <InputNumber
                            size="small"
                            min={0}
                            max={200_000}
                            step={10}
                            value={settings.ratePerSecond}
                            // 逐键下发会打成一片 setRate 请求：改数值只更新本地，
                            // 失焦或回车才真的下发
                            onChange={value => patch({ratePerSecond: value ?? 0})}
                            onBlur={() => onSetRate(settings.ratePerSecond)}
                            onPressEnter={() => onSetRate(settings.ratePerSecond)}
                            style={{width: 88}}
                            aria-label="运行中速率"
                        />
                    </Tooltip>
                    <span className="hint-text">条/秒</span>
                    <Button size="small" danger icon={<StopOutlined />} loading={busy} onClick={onStop}>
                        停止
                    </Button>
                    {stats?.lastError ? <span className="danger-text">最后一次失败：{stats.lastError}</span> : null}
                </div>
            </div>
        );
    }

    return (
        <div className="flow-panel">
            <div className="summary-line">
                <InputNumber
                    size="small"
                    min={0}
                    max={200_000}
                    step={10}
                    value={settings.ratePerSecond}
                    onChange={value => patch({ratePerSecond: value ?? 0})}
                    style={{width: 88}}
                    aria-label="连续发送速率"
                />
                <span className="hint-text">条/秒（0 不限速）</span>
                <InputNumber
                    size="small"
                    min={0}
                    max={10_000_000}
                    step={100}
                    value={settings.totalMessages}
                    onChange={value => patch({totalMessages: value ?? 0})}
                    style={{width: 96}}
                    aria-label="连续发送总量"
                />
                <span className="hint-text">条（0 到手动停止）</span>
            </div>
            <div className="summary-line">
                <Tooltip title="同时在途（已发出未收到 broker 确认）的条数上限">
                    <InputNumber
                        size="small"
                        min={1}
                        max={2000}
                        step={50}
                        value={settings.maxInFlight}
                        onChange={value => patch({maxInFlight: value ?? 1})}
                        style={{width: 88}}
                        aria-label="在途上限"
                    />
                </Tooltip>
                <span className="hint-text">在途</span>
                <Tooltip title="关掉它，出错的那几条只计入失败，其余继续投">
                    <span>
                        <Switch
                            size="small"
                            checked={settings.stopOnError}
                            onChange={checked => patch({stopOnError: checked})}
                            aria-label="出错即停"
                        />
                        <span className="hint-text" style={{marginLeft: 4}}>
                            出错即停
                        </span>
                    </span>
                </Tooltip>
                <Button
                    size="small"
                    type="primary"
                    icon={<PlayCircleOutlined />}
                    loading={busy}
                    onClick={() => onStart(settings)}
                >
                    连续发送
                </Button>
                {stats && stats.sent + stats.failed > 0 ? (
                    <span className="hint-text">
                        上一轮 {stats.sent} 条 / {stats.failed} 失败 / 用时{' '}
                        {Math.round((stats.elapsedMs || 0) / 100) / 10}s
                    </span>
                ) : null}
            </div>
        </div>
    );
};

export default FlowPanel;
