import React, {useMemo} from 'react';
import {Modal, Tag} from 'antd';
import dayjs from 'dayjs';
import type {Message} from '../../types';
import type {PayloadKind} from './messageFormat';
import {decodePayload} from './messageFormat';
import CodePane from '../editor/CodePane';

// 单条消息的完整详情。字段名沿用 broker 侧的叫法（Message ID / Producer /
// Publish Time / Properties / Data），界面里不翻译——这些词在订阅列表、
// 死信主题里也是同一套，翻成中文反而对不上别处。
//
// 正文按解出来的内容自动判类型：JSON 与 XML 用 CodeMirror 着色并缩进重排，
// 判不出结构的纯文本仍走等宽高亮但不着色。判定规则见 messageFormat.ts。

const KIND_LABEL: Record<PayloadKind, string> = {json: 'JSON', xml: 'XML', text: '文本'};

const MAX_HEIGHT = 420;

interface MessageDetailModalProps {
    message: Message | null;
    onClose: () => void;
}

const MessageDetailModal: React.FC<MessageDetailModalProps> = ({message, onClose}) => {
    // 只在弹窗真的打开时解 base64：列表每次推新都会重渲染这个组件，
    // 不挡住的话每条消息的解码要在闭弹窗状态下反复重跑。
    const payload = useMemo(() => (message ? decodePayload(message.data) : null), [message]);
    const viewerHeight = payload
        ? Math.min(MAX_HEIGHT, Math.max(140, payload.formatted.split('\n').length * 21 + 32))
        : 140;

    return (
        <Modal title="消息详情" open={message !== null} onCancel={onClose} width={800} footer={null}>
            {message && payload && (
                <div className="stack" style={{gap: 'var(--spacing-md)'}}>
                    <div>
                        <label className="field-label">Message ID:</label>
                        <code className="field-value hint-text">{message.messageId}</code>
                    </div>
                    <div>
                        <label className="field-label">Producer:</label>
                        <span className="field-value">{message.producerName}</span>
                    </div>
                    <div>
                        <label className="field-label">Publish Time:</label>
                        <span className="field-value">
                            {dayjs(message.publishTime).format('YYYY-MM-DD HH:mm:ss.SSS')}
                        </span>
                    </div>
                    {message.eventTime ? (
                        <div>
                            <label className="field-label">Event Time:</label>
                            <span className="field-value">
                                {dayjs(message.eventTime).format('YYYY-MM-DD HH:mm:ss.SSS')}
                            </span>
                        </div>
                    ) : null}
                    {message.partitionKey ? (
                        <div>
                            <label className="field-label">Partition Key:</label>
                            <span className="field-value">{message.partitionKey}</span>
                        </div>
                    ) : null}
                    <div>
                        <label className="field-label">Properties:</label>
                        <pre className="field-value hint-text" style={{maxHeight: 100, overflow: 'auto'}}>
                            {JSON.stringify(message.properties, null, 2)}
                        </pre>
                    </div>
                    <div>
                        <div
                            className="field-label"
                            style={{display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)'}}
                        >
                            <span>Data:</span>
                            <Tag color={payload.kind === 'text' ? 'default' : 'blue'}>{KIND_LABEL[payload.kind]}</Tag>
                            <span className="hint-text">
                                {payload.kind === 'text'
                                    ? '未识别出结构，按纯文本展示'
                                    : '自动识别并按语法着色，已缩进重排'}
                            </span>
                        </div>
                        <CodePane
                            value={payload.formatted}
                            kind={payload.kind}
                            height={viewerHeight}
                            ariaLabel="消息正文"
                        />
                    </div>
                </div>
            )}
        </Modal>
    );
};

export default MessageDetailModal;
