import React, {type ReactNode, useEffect} from 'react';
import {DatePicker, Input, InputNumber, Select, Switch, Tooltip} from 'antd';
import type {ProducerOptions} from '../../types';
import {defaultProducerOptions} from '../../../shared/producer-defaults';
import dayjs from 'dayjs';

// 生产者参数表单。分成「连接参数」与「报文参数」两组是因为原生侧的生效时机不同：
// 前者建会话时就定死了（绑定没有修改入口，只能断开重连），后者逐条压在报文上。
// 混在一排里用户会以为改了批大小立刻作用到已经连上的 producer。

interface ProducerOptionsFormProps {
    value: ProducerOptions;
    onChange: (next: ProducerOptions) => void;
}

const COMPRESSION = ['None', 'Zlib', 'LZ4', 'ZSTD', 'SNAPPY'] as const;

const Row: React.FC<{label: ReactNode; hint?: string; children: ReactNode}> = ({label, hint, children}) => (
    <div className="opt-row">
        <span className="field-label">
            {hint ? (
                <Tooltip title={hint}>
                    <span>{label}</span>
                </Tooltip>
            ) : (
                label
            )}
        </span>
        <span className="opt-control">{children}</span>
    </div>
);

const ProducerOptionsForm: React.FC<ProducerOptionsFormProps> = ({value, onChange}) => {
    const patch = (next: Partial<ProducerOptions>) => onChange({...value, ...next});

    // 批量与分块同开会让原生进程 abort，模板回填等外部来源仍可能带进这种组合：
    // 这里按"批量优先"把真实值纠正回来，否则界面显示分块为关、发出去的参数却是同开。
    useEffect(() => {
        if (value.batchingEnabled && value.chunkingEnabled) {
            onChange({...value, chunkingEnabled: false});
        }
    }, [value, onChange]);

    const number = (key: keyof ProducerOptions, min: number, max: number, step = 1) => (
        <InputNumber
            size="small"
            min={min}
            max={max}
            step={step}
            value={value[key] as number}
            onChange={input => patch({[key]: input ?? undefined} as Partial<ProducerOptions>)}
        />
    );

    return (
        <div className="options-grid">
            <div className="opt-group">
                <div className="opt-group-title">连接参数（改动需重新建立连接）</div>
                <Row label="生产者名" hint="留空由 broker 起名；会话卡片上显示的就是这个名字">
                    <Input
                        size="small"
                        value={value.producerName || ''}
                        onChange={event => patch({producerName: event.target.value || undefined})}
                        placeholder="自动"
                    />
                </Row>
                <Row label="发送超时">
                    {number('sendTimeoutMs', 1000, 600_000, 1000)} <span className="hint-text">毫秒</span>
                </Row>
                <Row label="在途队列上限" hint="原生 maxPendingMessages：队列满了之后由下面的开关决定是排队还是报错">
                    {number('maxPendingMessages', 1, 50_000, 100)}
                </Row>
                <Row label="队列满时阻塞">
                    <Switch
                        size="small"
                        checked={value.blockIfQueueFull}
                        onChange={checked => patch({blockIfQueueFull: checked})}
                    />
                </Row>
                <Row label="批量发送">
                    <Switch
                        size="small"
                        checked={value.batchingEnabled}
                        // 原生绑定不允许批量与分块同开（同开会直接 abort 主进程），
                        // 所以开批量时顺手把分块关掉，而不是留一个点了就崩的开关。
                        onChange={checked =>
                            patch(checked ? {batchingEnabled: true, chunkingEnabled: false} : {batchingEnabled: false})
                        }
                    />
                </Row>
                {value.batchingEnabled && (
                    <>
                        <Row label="批大小">
                            {number('batchingMaxMessages', 1, 100_000, 50)} <span className="hint-text">条</span>
                        </Row>
                        <Row label="批等待" hint="凑不满批大小时最多等多久；调大它能把消息攒成更大的批">
                            {number('batchingMaxPublishDelayMs', 1, 10_000, 5)} <span className="hint-text">毫秒</span>
                        </Row>
                    </>
                )}
                <Row label="压缩">
                    <Select
                        size="small"
                        value={value.compressionType}
                        onChange={next => patch({compressionType: next})}
                        options={COMPRESSION.map(item => ({value: item, label: item}))}
                    />
                </Row>
                <Row
                    label="分块"
                    hint={
                        value.batchingEnabled
                            ? '超过 broker 单条上限的报文切块发送。原生客户端不让它和批量发送同开，要先关掉上面的批量'
                            : '超过 broker 单条上限的报文切块发送'
                    }
                >
                    <Switch
                        size="small"
                        disabled={value.batchingEnabled}
                        checked={value.chunkingEnabled}
                        onChange={checked => patch({chunkingEnabled: checked})}
                    />
                </Row>
                <Row label="路由模式">
                    <Select
                        size="small"
                        allowClear
                        placeholder="默认"
                        value={value.messageRoutingMode}
                        onChange={next => patch({messageRoutingMode: next})}
                        options={[
                            {value: 'UseSinglePartition', label: '固定单分区'},
                            {value: 'RoundRobinDistribution', label: '轮询'},
                            {value: 'CustomPartition', label: '自定义'},
                        ]}
                    />
                </Row>
                <Row label="哈希">
                    <Select
                        size="small"
                        allowClear
                        placeholder="默认"
                        value={value.hashingScheme}
                        onChange={next => patch({hashingScheme: next})}
                        options={[
                            {value: 'Murmur3_32Hash', label: 'Murmur3_32'},
                            {value: 'BoostHash', label: 'Boost'},
                            {value: 'JavaStringHash', label: 'JavaString'},
                        ]}
                    />
                </Row>
                <Row label="访问模式">
                    <Select
                        size="small"
                        allowClear
                        placeholder="Shared"
                        value={value.accessMode}
                        onChange={next => patch({accessMode: next})}
                        options={[
                            {value: 'Shared', label: 'Shared'},
                            {value: 'Exclusive', label: 'Exclusive'},
                            {value: 'WaitForExclusive', label: '等待独占'},
                            {value: 'ExclusiveWithFencing', label: '独占并踢掉旧连接'},
                        ]}
                    />
                </Row>
            </div>

            <div className="opt-group">
                <div className="opt-group-title">报文参数（每条报文生效）</div>
                <Row label="固定路由键">
                    <Input
                        size="small"
                        value={value.partitionKey || ''}
                        onChange={event => patch({partitionKey: event.target.value || undefined})}
                        placeholder="不带"
                    />
                </Row>
                <Row label="按字段取路由键">
                    <Switch
                        size="small"
                        checked={!!value.usePartitionKeyFromField}
                        onChange={checked => patch({usePartitionKeyFromField: checked})}
                    />
                </Row>
                {value.usePartitionKeyFromField && (
                    <Row label="路由键字段" hint="支持点号路径，如 order.userId">
                        <Input
                            size="small"
                            value={value.partitionKeyField || ''}
                            onChange={event => patch({partitionKeyField: event.target.value || undefined})}
                            placeholder="userId"
                        />
                    </Row>
                )}
                <Row label="事件时间">
                    <Select
                        size="small"
                        value={value.eventTimeMode || defaultProducerOptions().eventTimeMode}
                        onChange={next => patch({eventTimeMode: next})}
                        options={[
                            {value: 'none', label: '不带'},
                            {value: 'now', label: '发送时刻'},
                            {value: 'fromField', label: '取字段'},
                            {value: 'fixed', label: '固定值'},
                        ]}
                    />
                </Row>
                {value.eventTimeMode === 'fromField' && (
                    <Row label="事件时间字段">
                        <Input
                            size="small"
                            value={value.eventTimeField || ''}
                            onChange={event => patch({eventTimeField: event.target.value || undefined})}
                            placeholder="ts"
                        />
                    </Row>
                )}
                {value.eventTimeMode === 'fixed' && (
                    <Row label="事件时间值">
                        <DatePicker
                            size="small"
                            showTime
                            value={value.eventTimeFixed ? dayjs(value.eventTimeFixed) : null}
                            onChange={date => patch({eventTimeFixed: date ? date.valueOf() : undefined})}
                        />
                    </Row>
                )}
                <Row label="投递时间">
                    <Select
                        size="small"
                        value={value.delayMode || defaultProducerOptions().delayMode}
                        onChange={next => patch({delayMode: next})}
                        options={[
                            {value: 'none', label: '立即'},
                            {value: 'deliverAfter', label: '延时多久'},
                            {value: 'deliverAt', label: '指定时刻'},
                        ]}
                    />
                </Row>
                {value.delayMode === 'deliverAfter' && (
                    <Row label="延时">
                        {number('deliverAfterMs', 1, 7 * 24 * 3600 * 1000, 1000)}{' '}
                        <span className="hint-text">毫秒</span>
                    </Row>
                )}
                {value.delayMode === 'deliverAt' && (
                    <Row label="投递时刻">
                        <DatePicker
                            size="small"
                            showTime
                            value={value.deliverAt ? dayjs(value.deliverAt) : null}
                            onChange={date => patch({deliverAt: date ? date.valueOf() : undefined})}
                        />
                    </Row>
                )}
                <Row label="随机种子" hint="锁定后预览与实发逐字节一致；留空每次真随机">
                    <InputNumber
                        size="small"
                        min={0}
                        max={999_999_999}
                        value={value.seed}
                        onChange={input => patch({seed: input ?? undefined})}
                        placeholder="随机"
                    />
                </Row>
            </div>
        </div>
    );
};

export default ProducerOptionsForm;
