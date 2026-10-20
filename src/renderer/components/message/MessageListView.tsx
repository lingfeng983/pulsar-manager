import React, {useMemo, useState} from 'react';
import {Button, Space, Table, Tag, Tooltip} from 'antd';
import type {TableColumnsType} from 'antd';
import {DownOutlined, UpOutlined, ZoomInOutlined} from '@ant-design/icons';
import type {Message} from '../../types';
import {useResizableColumns} from '../../hooks/useResizableColumns';
import {useVirtualTable} from '../../hooks/useVirtualTable';
import {decodeMessageBatch, truncateText} from './messageFormat';

// 收到消息的列表视图。与消息浏览器那张表同构，但多了一列 seq：
// 手动确认那一批要按序号选条，而 Message ID 太长，用户在几十条里点选时
// 根本对不上"我选的是第几条"。seq 取界面里的位置，从 1 开始，最新的在最后一行。

const KIND_LABEL = {json: 'JSON', xml: 'XML', text: '文本'} as const;

interface MessageListViewProps {
    messages: Message[];
    truncateLength: number;
    onOpenDetail: (message: Message) => void;
    // 手动确认会话（关闭了 autoAck 且还活着）才给操作列：确认要按主进程登记表的
    // 序号（ackSeq）发，序号不在表里的行（超出窗口、会话已结束）只说明状态不给按钮。
    manualAck?: boolean;
    // broker 只对 Exclusive/Failover 接受累计确认，Shared 上必被拒，按钮就别摆出来
    cumulativeAllowed?: boolean;
    ackBusy?: boolean;
    resolved?: Record<number, 'acked' | 'nacked'>;
    onAck?: (seqs: number[], cumulative: boolean) => void;
    onNack?: (seq: number) => void;
}

const MessageListView: React.FC<MessageListViewProps> = ({
    messages,
    truncateLength,
    onOpenDetail,
    manualAck,
    cumulativeAllowed,
    ackBusy,
    resolved,
    onAck,
    onNack,
}) => {
    const [expanded, setExpanded] = useState<string[]>([]);

    const decoded = useMemo(() => decodeMessageBatch(messages.map(item => item.data)), [messages]);

    const toggle = (key: string) =>
        setExpanded(current => (current.includes(key) ? current.filter(id => id !== key) : [...current, key]));

    const columns: TableColumnsType<Message> = [
        {
            title: '#',
            key: 'seq',
            width: 48,
            // 手动确认会话显示主进程登记的 ackSeq：它不随界面裁剪变化，
            // 用户对上的序号就是发给主进程的那个序号。其余场景退回行位。
            render: (_: unknown, record: Message, index: number) => (
                <span className="hint-text">{record.ackSeq ?? index + 1}</span>
            ),
        },
        ...(manualAck
            ? [
                  {
                      title: '确认操作',
                      key: 'ackActions',
                      width: 170,
                      render: (_: unknown, record: Message) => {
                          const seq = record.ackSeq;
                          if (seq === undefined) {
                              return <span className="hint-text">-</span>;
                          }
                          const state = resolved?.[seq];
                          if (state === 'acked') {
                              return (
                                  <Tag color="green" style={{marginRight: 0}}>
                                      已确认
                                  </Tag>
                              );
                          }
                          if (state === 'nacked') {
                              return (
                                  <Tag color="orange" style={{marginRight: 0}}>
                                      已交回重投
                                  </Tag>
                              );
                          }
                          if (record.ackable === false) {
                              return (
                                  <Tooltip title="超出主进程的未确认窗口，这条没法逐条确认，会由 broker 按时重投">
                                      <span className="hint-text">超窗口</span>
                                  </Tooltip>
                              );
                          }
                          return (
                              <Space wrap size={2}>
                                  <Button
                                      size="small"
                                      type="link"
                                      disabled={ackBusy}
                                      onClick={() => onAck?.([seq], false)}
                                  >
                                      确认
                                  </Button>
                                  {cumulativeAllowed && (
                                      <Tooltip title="确认这条以及它之前的全部未确认消息（按 broker 游标累计）">
                                          <Button
                                              size="small"
                                              type="link"
                                              disabled={ackBusy}
                                              onClick={() => onAck?.([seq], true)}
                                          >
                                              到此确认
                                          </Button>
                                      </Tooltip>
                                  )}
                                  <Button
                                      size="small"
                                      type="link"
                                      danger
                                      disabled={ackBusy}
                                      onClick={() => onNack?.(seq)}
                                  >
                                      重投
                                  </Button>
                              </Space>
                          );
                      },
                  } as TableColumnsType<Message>[number],
              ]
            : []),
        {
            title: 'Message ID',
            dataIndex: 'messageId',
            key: 'messageId',
            width: 190,
            render: (text: string) => (
                <code style={{fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)'}}>{text}</code>
            ),
        },
        {
            title: '发布时',
            dataIndex: 'publishTime',
            key: 'publishTime',
            width: 120,
            defaultSortOrder: 'descend',
            sorter: (a, b) => a.publishTime - b.publishTime,
            render: (timestamp: number) => {
                const full = new Date(timestamp).toLocaleString('zh-CN', {hour12: false});
                return <span title={full}>{full.slice(5)}</span>;
            },
        },
        {title: 'Producer', dataIndex: 'producerName', key: 'producerName', width: 120},
        {
            title: '属性',
            dataIndex: 'properties',
            key: 'properties',
            width: 96,
            render: (props: Record<string, string>) => {
                const keys = Object.keys(props || {});
                if (keys.length === 0) {
                    return '-';
                }
                return (
                    <Tooltip title={keys.map(key => `${key}: ${props[key]}`).join('\n')}>
                        <Tag color="blue" style={{marginRight: 0}}>
                            {keys.length} 个
                        </Tag>
                    </Tooltip>
                );
            },
        },
        {
            title: '重投',
            dataIndex: 'redeliveryCount',
            key: 'redeliveryCount',
            width: 56,
            render: (count?: number) => (count ? <Tag color="orange">{count}</Tag> : '-'),
        },
        {
            title: '正文',
            dataIndex: 'data',
            key: 'data',
            width: 320,
            render: (data: string, record: Message) => {
                const payload = decoded.get(data);
                const text = payload?.formatted ?? '';
                const key = `${record.messageId}-${record.publishTime}`;
                const isExpanded = expanded.includes(key);
                return (
                    <div>
                        <Tag>{payload ? KIND_LABEL[payload.kind] : '文本'}</Tag>
                        <div
                            style={{
                                maxHeight: isExpanded ? 200 : 'auto',
                                overflow: 'auto',
                                fontFamily: 'var(--font-mono)',
                                fontSize: 'var(--font-size-xs)',
                                wordBreak: 'break-all',
                                color: 'var(--color-text-secondary)',
                            }}
                        >
                            {isExpanded ? text : truncateText(text, truncateLength)}
                        </div>
                        {text.length > truncateLength && (
                            <Button
                                type="text"
                                size="small"
                                icon={isExpanded ? <UpOutlined /> : <DownOutlined />}
                                onClick={() => toggle(key)}
                            >
                                {isExpanded ? '收起' : `展开全文 (${text.length} 字符)`}
                            </Button>
                        )}
                        <Button type="text" size="small" icon={<ZoomInOutlined />} onClick={() => onOpenDetail(record)}>
                            全屏查看
                        </Button>
                    </div>
                );
            },
        },
    ];

    // 列宽能拖：Message ID 与正文这两个定宽在窄窗口里互相挤，拖开一个总比读不全好。
    const {resizableColumns, components} = useResizableColumns(columns);

    // 界面保留条数最大能开到 5000，几千行 × 每行一堆 Tag/Tooltip/Button 是这台
    // 客户端最主要的一次卡顿来源。行数超过阈值才切成虚拟滚动，几百条以内维持原样。
    const box = useVirtualTable(messages.length);

    return (
        <div ref={box.ref}>
            <Table
                dataSource={messages}
                columns={resizableColumns}
                components={components}
                // messageId 在一条 topic 内唯一，是这里唯一稳定的行标识。拼上 index 的话，
                // 新消息从头部插入会把所有旧行的 index 推后，整张表重挂（展开态与滚动位置都会丢）。
                rowKey="messageId"
                pagination={false}
                size="small"
                scroll={box.scroll}
                virtual={box.virtual}
            />
        </div>
    );
};

export default MessageListView;
