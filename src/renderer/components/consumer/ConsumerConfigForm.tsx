import React, {type ReactNode} from 'react';
import {Checkbox, Input, InputNumber, Select, Switch, Tooltip} from 'antd';
import type {ConsumerConfigDraft} from '../../types';

// 消费者参数表单。分两列按"什么时候生效"来切：左列决定这条订阅怎么被消费
// （模式、起点、要不要自动确认），右列是原生客户端与 broker 之间的流控和死信，
// 两者都要断开重连才起作用——放一排会让人以为改接收队列立刻生效。

interface ConsumerConfigFormProps {
    value: ConsumerConfigDraft;
    onChange: (next: ConsumerConfigDraft) => void;
}

const SUBSCRIPTION_TYPES = [
    {value: 'Shared', label: '共享 Shared'},
    {value: 'Key_Shared', label: '键共享 Key_Shared'},
    {value: 'Failover', label: '故障切换 Failover'},
    {value: 'Exclusive', label: '独占 Exclusive'},
] as const;

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

const ConsumerConfigForm: React.FC<ConsumerConfigFormProps> = ({value, onChange}) => {
    const patch = (next: Partial<ConsumerConfigDraft>) => onChange({...value, ...next});
    const optionalNumber = (
        key: 'receiverQueueSize' | 'ackTimeoutMs' | 'nAckRedeliverTimeoutMs',
        min: number,
        max: number,
        step: number,
    ) => (
        <InputNumber
            size="small"
            min={min}
            max={max}
            step={step}
            value={value[key]}
            placeholder="默认"
            onChange={input => patch({[key]: input ?? undefined} as Partial<ConsumerConfigDraft>)}
        />
    );
    const deadLetter = value.deadLetter;
    const setDeadLetter = (next: Partial<NonNullable<ConsumerConfigDraft['deadLetter']>> | undefined) =>
        patch({
            deadLetter: next === undefined ? undefined : {...deadLetter, topicName: '', maxRedeliverCount: 3, ...next},
        });

    return (
        <div className="options-grid">
            <div className="opt-group">
                <div className="opt-group-title">消费行为</div>
                <Row label="消费模式" hint="独占模式下两条会话会互相踢下线，所以同一订阅只放一条 Exclusive 会话">
                    <Select
                        size="small"
                        value={value.subscriptionType}
                        onChange={next => patch({subscriptionType: next})}
                        options={[...SUBSCRIPTION_TYPES]}
                    />
                </Row>
                <Row
                    label="起始位置"
                    hint="只在订阅第一次创建时生效：订阅已经有游标的话，broker 会从游标处继续投，这里选「最早」也不会回放"
                >
                    <Select
                        size="small"
                        value={value.initialPosition}
                        onChange={next => patch({initialPosition: next})}
                        options={[
                            {value: 'Latest', label: '最新位置'},
                            {value: 'Earliest', label: '最早位置'},
                        ]}
                    />
                </Row>
                <Row
                    label="自动确认"
                    hint="关掉后消息停在未确认状态，等界面上的逐条确认入口（下一批接入）；现在关闭只会让积压一直涨到会话断开"
                >
                    <Switch size="small" checked={value.autoAck} onChange={checked => patch({autoAck: checked})} />
                </Row>
                <Row label="收满自动停" hint="填 0 表示不限，一直收到手动停止或出错为止；限制条数是为了不把内存塞满">
                    <InputNumber
                        size="small"
                        min={0}
                        max={10000}
                        step={100}
                        value={value.maxMessages}
                        onChange={input => patch({maxMessages: input ?? 0})}
                    />
                    <span className="hint-text">条</span>
                </Row>
                <Row label="消费者名" hint="留空由 broker 起名；会话卡片上显示的就是它">
                    <Input
                        size="small"
                        value={value.consumerName || ''}
                        onChange={event => patch({consumerName: event.target.value || undefined})}
                        placeholder="自动"
                    />
                </Row>
            </div>

            <div className="opt-group">
                <div className="opt-group-title">客户端流控与死信（改动需重新开始消费）</div>
                <Row
                    label="接收队列"
                    hint="原生 receiverQueueSize：一次从 broker 预取多少条压在本地，调大能提高吞吐，但积压会从 broker 挪到本进程内存"
                >
                    {optionalNumber('receiverQueueSize', 1, 10000, 50)}
                </Row>
                {!value.autoAck && (
                    <>
                        <Row
                            label="未确认超时"
                            hint="超过这个时间没确认的消息由 broker 重投；留空沿用原生默认（不超时）"
                        >
                            {optionalNumber('ackTimeoutMs', 1000, 3600000, 1000)}{' '}
                            <span className="hint-text">毫秒</span>
                        </Row>
                        <Row label="重投间隔" hint="手动 nack 之后隔多久再送回来">
                            {optionalNumber('nAckRedeliverTimeoutMs', 1000, 3600000, 500)}{' '}
                            <span className="hint-text">毫秒</span>
                        </Row>
                    </>
                )}
                <Row label="死信主题">
                    <Checkbox
                        checked={!!deadLetter}
                        onChange={event => setDeadLetter(event.target.checked ? {} : undefined)}
                    >
                        <Tooltip title="未确认消息重投到上限后进死信主题。本批还没有手动确认与 nack 入口，自动确认开着时这条策略不会被触发">
                            <span>启用</span>
                        </Tooltip>
                    </Checkbox>
                </Row>
                {deadLetter && (
                    <>
                        <Row
                            label="主题全路径"
                            hint="必须带 persistent:// 或 non-persistent:// 前缀，例如 persistent://public/default/t1-DLQ"
                        >
                            <Input
                                size="small"
                                value={deadLetter.topicName}
                                onChange={event => setDeadLetter({topicName: event.target.value})}
                                placeholder="persistent://public/default/t1-DLQ"
                            />
                        </Row>
                        <Row label="重投上限">
                            <InputNumber
                                size="small"
                                min={1}
                                max={100}
                                value={deadLetter.maxRedeliverCount}
                                onChange={input => setDeadLetter({maxRedeliverCount: input ?? 1})}
                            />
                        </Row>
                        <Row label="死信订阅" hint="留空按 broker 默认订阅名创建">
                            <Input
                                size="small"
                                value={deadLetter.initialSubscriptionName || ''}
                                onChange={event =>
                                    setDeadLetter({initialSubscriptionName: event.target.value || undefined})
                                }
                                placeholder="默认"
                            />
                        </Row>
                    </>
                )}
            </div>
        </div>
    );
};

export default ConsumerConfigForm;
