import {useCallback, useEffect, useRef, useState} from 'react';
import type {Message, MessageBatch, SessionEndEvent} from '../../types';
import {STREAM_MAX_BYTES, trimMessageList} from './messageFormat';

// 消息流的订阅收口。消费与读取两条推送通道 + 会话结束事件在每个要看实时消息的
// 页面里都是同一套：按 sessionId 认领、新消息插到最前、超过上限裁尾。
// 原来这段只写在消息浏览器里，消费者工作台要再接一遍就是第三份，
// 而三份"看起来一样"的裁剪逻辑迟早有一份忘了摘会话。

// 上限按会话算，不按整页算：多开三条订阅时如果共享一个上限，
// 消息来得最凶的那条会把另外两条挤出界面，看起来像是另外两条没在收。
export const DEFAULT_STREAM_LIMIT = 500;

export interface MessageStreamOptions {
    // 这个会话 id 是不是本页签该收的（别的 topic 的工作台推来的批次要直接丢）
    owns: (sessionId: string) => boolean;
    limit?: number;
    onSessionEnd?: (event: SessionEndEvent) => void;
}

export interface MessageStream {
    buckets: Record<string, Message[]>;
    // 到达总条数（含暂停期间与超出上限被裁掉的），按会话算。
    // 界面上的"已收"必须用它而不是 buckets 的长度：上限 500 条时
    // 收到第 800 条还显示 500，读起来就像消费停了。
    counts: Record<string, number>;
    // 暂停期间到达的条数：暂停只停渲染、不停消费，所以总得有个地方说明
    // "界面这里少了几条"，否则用户会以为 broker 没投。
    dropped: Record<string, number>;
    paused: boolean;
    setPaused: (next: boolean) => void;
    clear: (sessionId: string) => void;
    reset: () => void;
}

export function useMessageStream({
    owns,
    limit = DEFAULT_STREAM_LIMIT,
    onSessionEnd,
}: MessageStreamOptions): MessageStream {
    const [buckets, setBuckets] = useState<Record<string, Message[]>>({});
    const [counts, setCounts] = useState<Record<string, number>>({});
    const [dropped, setDropped] = useState<Record<string, number>>({});
    const [paused, setPaused] = useState(false);

    // 回调与上限放 ref：订阅只建一次，靠它们读到最新值。放依赖里会让
    // 每次渲染都重订阅一遍，重订阅之间到达的批次正好没人接。
    const ownsRef = useRef(owns);
    ownsRef.current = owns;
    const limitRef = useRef(limit);
    limitRef.current = limit;
    const pausedRef = useRef(paused);
    pausedRef.current = paused;
    const endedRef = useRef(onSessionEnd);
    endedRef.current = onSessionEnd;

    const append = useCallback((batch: MessageBatch) => {
        if (batch.messages.length === 0) {
            return;
        }
        setCounts(current => ({
            ...current,
            [batch.sessionId]: (current[batch.sessionId] || 0) + batch.messages.length,
        }));
        if (pausedRef.current) {
            setDropped(current => ({
                ...current,
                [batch.sessionId]: (current[batch.sessionId] || 0) + batch.messages.length,
            }));
            return;
        }
        setBuckets(current => {
            const previous = current[batch.sessionId] || [];
            // 条数之外还要按正文长度收：几 MB 一条的报文×500 条就是把渲染进程
            // 按 GB 驻留，而实时推送路径没有主进程扫描那道 8MB 护栏。
            const next = trimMessageList([...batch.messages, ...previous], limitRef.current, STREAM_MAX_BYTES);
            return {...current, [batch.sessionId]: next};
        });
    }, []);

    useEffect(() => {
        const offConsume = window.electronAPI.messages.onConsumeBatch(batch => {
            if (ownsRef.current(batch.sessionId)) {
                append(batch);
            }
        });
        const offRead = window.electronAPI.messages.onReadBatch(batch => {
            if (ownsRef.current(batch.sessionId)) {
                append(batch);
            }
        });
        // 会话自己结束（收满上限、循环出错）后不再往里塞，也顺手把该会话的计数清了
        const offEnd = window.electronAPI.messages.onSessionEnd((event: SessionEndEvent) => {
            if (ownsRef.current(event.sessionId)) {
                endedRef.current?.(event);
            }
        });
        return () => {
            offConsume();
            offRead();
            offEnd();
        };
    }, [append]);

    const clear = useCallback((sessionId: string) => {
        const drop = (current: Record<string, number>) => {
            if (!(sessionId in current)) {
                return current;
            }
            const {[sessionId]: _gone, ...rest} = current;
            return rest;
        };
        setBuckets(current => {
            if (!(sessionId in current)) {
                return current;
            }
            const {[sessionId]: _gone, ...rest} = current;
            return rest;
        });
        setCounts(drop);
        setDropped(drop);
    }, []);

    const reset = useCallback(() => {
        setBuckets({});
        setCounts({});
        setDropped({});
    }, []);

    return {buckets, counts, dropped, paused, setPaused, clear, reset};
}
