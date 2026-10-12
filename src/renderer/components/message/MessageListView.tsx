import React, {useMemo, useState} from 'react';
import {Button, Table, Tag, Tooltip} from 'antd';
import type {TableColumnsType} from 'antd';
import {DownOutlined, UpOutlined, ZoomInOutlined} from '@ant-design/icons';
import type {Message} from '../../types';
import {useResizableColumns} from '../../hooks/useResizableColumns';
import {decodeMessageBatch, truncateText} from './messageFormat';

// 收到消息的列表视图。与消息浏览器那张表同构，但多了一列 seq：
// 手动确认那一批要按序号选条，而 Message ID 太长，用户在几十条里点选时
// 根本对不上"我选的是第几条"。seq 取界面里的位置，从 1 开始，最新的在最后一行。

const KIND_LABEL = {json: 'JSON', xml: 'XML', text: '文本'} as const;

interface MessageListViewProps {
    messages: Message[];
    truncateLength: number;
    onOpenDetail: (message: Message) => void;
}

const MessageListView: React.FC<MessageListViewProps> = ({messages, truncateLength, onOpenDetail}) => {
    const [expanded, setExpanded] = useState<string[]>([]);

    const decoded = useMemo(() => decodeMessageBatch(messages.map(item => item.data)), [messages]);

    const toggle = (key: string) =>
        setExpanded(current => (current.includes(key) ? current.filter(id => id !== key) : [...current, key]));

    const columns: TableColumnsType<Message> = [
        {
            title: '#',
            key: 'seq',
            width: 48,
            render: (_: unknown, __: Message, index: number) => <span className="hint-text">{index + 1}</span>,
        },
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

    return (
        <Table
            dataSource={messages}
            columns={resizableColumns}
            components={components}
            rowKey={(record, index) => `${record.messageId}-${index}`}
            pagination={false}
            size="small"
            scroll={{x: 'max-content'}}
        />
    );
};

export default MessageListView;
