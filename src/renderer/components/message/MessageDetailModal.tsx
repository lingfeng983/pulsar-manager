import React, {useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent} from 'react';
import {Button, Modal, Tag, Tooltip, message as notify} from 'antd';
import {ArrowsAltOutlined, CopyOutlined, ShrinkOutlined} from '@ant-design/icons';
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

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 480;
const MIN_WIDTH = 520;
const MIN_HEIGHT = 360;

interface ModalSize {
    width: number;
    height: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

// WebView2 的 tauri:// 是安全上下文，navigator.clipboard 一般可用；老内核上可能缺，
// 退回临时 textarea + execCommand，保证「复制」按钮在任何情况下都有结果。
async function copyToClipboard(text: string): Promise<void> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }
    } catch {
        // 权限被拒或焦点不在本窗口时 writeText 会抛，继续走下面的 textarea 兜底
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        if (!document.execCommand('copy')) {
            throw new Error('copy command rejected');
        }
    } finally {
        document.body.removeChild(textarea);
    }
}

interface MessageDetailModalProps {
    message: Message | null;
    onClose: () => void;
}

const MessageDetailModal: React.FC<MessageDetailModalProps> = ({message, onClose}) => {
    // 只在弹窗真的打开时解 base64：列表每次推新都会重渲染这个组件，
    // 不挡住的话每条消息的解码要在闭弹窗状态下反复重跑。
    const payload = useMemo(() => (message ? decodePayload(message.data) : null), [message]);

    const [size, setSize] = useState<ModalSize>(() => ({
        width: DEFAULT_WIDTH,
        // 矮窗口下固定 480px 会连 top:24px 一起顶出视口：初始高度先按视口收一次。
        height: Math.min(DEFAULT_HEIGHT, Math.max(MIN_HEIGHT, window.innerHeight - 48)),
    }));
    const [maximized, setMaximized] = useState(false);
    // 视口尺寸进 state：aria-valuemax 与 resize 夹取都按它算，窗口变化时才不会读到旧值。
    const [viewport, setViewport] = useState(() => ({width: window.innerWidth, height: window.innerHeight}));
    const sizeRef = useRef(size);
    sizeRef.current = size;
    const dragCleanupRef = useRef<(() => void) | null>(null);

    // 卸载时若还拖着，收回全局样式与监听
    useEffect(() => () => dragCleanupRef.current?.(), []);

    // 窗口变矮/变窄时把当前尺寸夹回视口内；窗口变大不把用户手动拖过的尺寸拉回去，
    // 所以只在"超出"时收缩。放大态用的是 calc(...)，但退出放大后 size 也要是合法值。
    useEffect(() => {
        const onResize = () => {
            const next = {width: window.innerWidth, height: window.innerHeight};
            setViewport(next);
            const maxWidth = Math.max(MIN_WIDTH, next.width - 32);
            const maxHeight = Math.max(MIN_HEIGHT, next.height - 48);
            setSize(current => {
                const width = Math.min(current.width, maxWidth);
                const height = Math.min(current.height, maxHeight);
                return width === current.width && height === current.height ? current : {width, height};
            });
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    const handleCopy = async () => {
        if (!payload) {
            return;
        }
        try {
            await copyToClipboard(payload.formatted);
            notify.success('消息正文已复制');
        } catch {
            notify.error('复制失败，可在编辑器中选中后按 Ctrl+C');
        }
    };

    const handleResizeStart = useCallback(
        (event: ReactMouseEvent) => {
            event.preventDefault();
            const startX = event.clientX;
            const startY = event.clientY;
            // 放大态用的是 calc(100vh - 48px)，拖之前先换成等价像素，
            // 否则第一下会跳回默认尺寸。
            const start: ModalSize = maximized
                ? {
                      width: Math.max(MIN_WIDTH, window.innerWidth - 32),
                      height: Math.max(MIN_HEIGHT, window.innerHeight - 48),
                  }
                : sizeRef.current;
            setMaximized(false);
            setSize(start);

            const onMove = (moveEvent: MouseEvent) => {
                // 弹框水平居中：宽度加 Δ 时左右各外扩 Δ/2，所以拖动 dx 要按 2×dx 换算，
                // 把手才跟得住鼠标；垂直方向是顶部钉住的，按 dy 直接加。
                const width = clamp(start.width + (moveEvent.clientX - startX) * 2, MIN_WIDTH, window.innerWidth - 32);
                const height = clamp(start.height + (moveEvent.clientY - startY), MIN_HEIGHT, window.innerHeight - 48);
                setSize({width, height});
            };
            const cleanup = () => {
                if (dragCleanupRef.current !== cleanup) {
                    return;
                }
                dragCleanupRef.current = null;
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', cleanup);
                window.removeEventListener('blur', cleanup);
                document.body.style.userSelect = '';
                document.body.style.cursor = '';
            };
            dragCleanupRef.current = cleanup;
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'nwse-resize';
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', cleanup);
            window.addEventListener('blur', cleanup);
        },
        [maximized],
    );

    // 方向键等价物：separator 只有鼠标拖拽时键盘用户完全没法调尺寸。
    // 左右改宽、上下改高，与 nwse-resize 的对角语义一致；步长 20px 便于精调。
    const resizeBy = useCallback(
        (dW: number, dH: number) => {
            const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - 32);
            const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - 48);
            setMaximized(false);
            setSize(current => {
                // 放大态先折算成像素再调，否则第一下方向键会跳回旧尺寸（同鼠标拖拽）
                const base: ModalSize = maximized ? {width: maxWidth, height: maxHeight} : current;
                return {
                    width: clamp(base.width + dW, MIN_WIDTH, maxWidth),
                    height: clamp(base.height + dH, MIN_HEIGHT, maxHeight),
                };
            });
        },
        [maximized],
    );

    const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const step = 20;
        const dW = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dH = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        if (!dW && !dH) {
            return;
        }
        event.preventDefault();
        resizeBy(dW, dH);
    };

    const maxWidth = Math.max(MIN_WIDTH, viewport.width - 32);
    const maxHeight = Math.max(MIN_HEIGHT, viewport.height - 48);
    const modalWidth = maximized ? 'calc(100vw - 32px)' : size.width;
    const modalHeight = maximized ? 'calc(100vh - 48px)' : size.height;
    // 无障碍属性要读的是"当前生效的宽高"：放大态下取视口上限，与弹框实际尺寸一致。
    const currentWidth = maximized ? maxWidth : size.width;
    const currentHeight = maximized ? maxHeight : size.height;

    return (
        <Modal
            className="message-detail-modal"
            title={
                <div className="message-detail-title">
                    <span>消息详情</span>
                    <Tooltip title={maximized ? '还原弹框' : '放大弹框'}>
                        <Button
                            type="text"
                            size="small"
                            aria-label={maximized ? '还原弹框' : '放大弹框'}
                            icon={maximized ? <ShrinkOutlined /> : <ArrowsAltOutlined />}
                            onClick={() => setMaximized(current => !current)}
                        />
                    </Tooltip>
                    {/* separator 的 valuenow 只能表达一维，宽高同时可调时用 valuetext 报全两维 */}
                    <div
                        className="message-detail-resize"
                        role="separator"
                        tabIndex={0}
                        aria-label="拖动调整弹框大小"
                        aria-orientation="vertical"
                        aria-valuemin={MIN_WIDTH}
                        aria-valuemax={maxWidth}
                        aria-valuenow={currentWidth}
                        aria-valuetext={`宽 ${currentWidth} 像素，高 ${currentHeight} 像素`}
                        title="按住拖动调整弹框大小"
                        onMouseDown={handleResizeStart}
                        onKeyDown={handleResizeKeyDown}
                    />
                </div>
            }
            open={message !== null}
            onCancel={onClose}
            width={modalWidth}
            height={modalHeight}
            footer={null}
        >
            {message && payload && (
                <div className="stack message-detail-stack" style={{gap: 'var(--spacing-md)'}}>
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
                    <div className="message-detail-data">
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
                            <Button
                                size="small"
                                type="text"
                                icon={<CopyOutlined />}
                                aria-label="复制消息正文"
                                style={{marginLeft: 'auto'}}
                                onClick={() => void handleCopy()}
                            >
                                复制
                            </Button>
                        </div>
                        <div className="message-detail-code">
                            <CodePane value={payload.formatted} kind={payload.kind} fluid ariaLabel="消息正文" />
                        </div>
                    </div>
                </div>
            )}
        </Modal>
    );
};

export default MessageDetailModal;
