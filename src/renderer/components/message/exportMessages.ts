import dayjs from 'dayjs';
import type {Message} from '../../types';
import {formatMessageData} from './messageFormat';

// 收信列表的导出。两种格式都只带界面看得见的字段，正文一律解回文本再落盘：
// 导出 base64 的 CSV 打开是一墙乱码，等于没导出。

export interface MessagesExport {
    content: string;
    mimeType: string;
    extension: string;
}

const stamp = (timestamp: number) => dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss.SSS');

// CSV 里含换行的正文必须整体加引号，内部的引号翻倍——这是 CSV 唯一的转义写法，
// 少一步就会让一条多行 JSON 在表里裂成好几行。
const csvCell = (value: string) => `"${value.replace(/"/g, '""')}"`;

export function buildMessagesExport(messages: Message[], format: 'json' | 'csv'): MessagesExport {
    if (format === 'json') {
        const rows = messages.map(msg => ({
            messageId: msg.messageId,
            producerName: msg.producerName,
            publishTime: stamp(msg.publishTime),
            eventTime: msg.eventTime ? stamp(msg.eventTime) : undefined,
            partitionKey: msg.partitionKey,
            redeliveryCount: msg.redeliveryCount,
            properties: msg.properties,
            data: formatMessageData(msg.data),
        }));
        return {content: JSON.stringify(rows, null, 2), mimeType: 'application/json', extension: 'json'};
    }
    const headers = ['messageId', 'publishTime', 'producerName', 'redeliveryCount', 'properties', 'data'];
    const rows = messages.map(msg =>
        [
            msg.messageId,
            stamp(msg.publishTime),
            msg.producerName,
            String(msg.redeliveryCount ?? 0),
            csvCell(JSON.stringify(msg.properties || {})),
            csvCell(formatMessageData(msg.data)),
        ].join(','),
    );
    return {
        content: [headers.join(','), ...rows].join('\n'),
        mimeType: 'text/csv',
        extension: 'csv',
    };
}

export function messagesExportFilename(topic: string, format: 'json' | 'csv'): string {
    const extension = format === 'json' ? 'json' : 'csv';
    return `messages_${topic}_${dayjs().format('YYYYMMDD_HHmmss')}.${extension}`;
}
