import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
} from 'react';
import {Compartment, EditorState} from '@codemirror/state';
import {
    EditorView,
    drawSelection,
    highlightActiveLine,
    keymap,
    lineNumbers,
    rectangularSelection,
} from '@codemirror/view';
import {defaultKeymap, history, historyKeymap, indentWithTab} from '@codemirror/commands';
import {json} from '@codemirror/lang-json';
import {xml} from '@codemirror/lang-xml';
import {bracketMatching, foldGutter, foldKeymap, indentOnInput} from '@codemirror/language';
import {closeBrackets} from '@codemirror/autocomplete';
import type {PayloadKind} from '../message/messageFormat';
import {formatPayload} from '../message/messageFormat';
import {editorTheme, jsonHighlight, xmlHighlight} from './cmTheme';

// 带语法着色的代码框，只读与可编辑两用：消息详情里读它，发送面板里写它。
// 一个组件两用是因为两套扩展表（着色、主题、折叠、高度钉法）本来就该一致——
// 分两个文件写迟早漂成"详情里 JSON 是主色、面板里是绿色"。
// 模板编辑器另有 JsonEditor：它多了占位符装饰与 ${ 补全，那些在读写报文时是干扰。

export interface CodePaneHandle {
    /** 按当前类型格式化（JSON 重排、XML 缩进）。纯文本没有可格式化的结构，返回 false。 */
    format: () => boolean;
    focus: () => void;
}

interface CodePaneProps {
    value: string;
    kind: PayloadKind;
    ariaLabel: string;
    height?: number;
    editable?: boolean;
    /** 底边可上下拖动改高度；配合 storageKey 让拖出来的尺寸跨页签保留。 */
    resizable?: boolean;
    /** 给了就把高度存进 localStorage，重开页签不回到默认值。 */
    storageKey?: string;
    onChange?: (value: string) => void;
}

const RESIZE_MIN = 80;
const RESIZE_MAX = 1200;

function readStoredHeight(key: string | undefined, fallback: number): number {
    if (!key) {
        return fallback;
    }
    try {
        const saved = Number(localStorage.getItem(key));
        return saved >= RESIZE_MIN && saved <= RESIZE_MAX ? saved : fallback;
    } catch {
        return fallback;
    }
}

function languageExtension(kind: PayloadKind) {
    if (kind === 'json') {
        return [json(), jsonHighlight];
    }
    if (kind === 'xml') {
        return [xml(), xmlHighlight];
    }
    // 纯文本不挂语言：挂上去只会把一行普通话标成花，判不出结构就不装作判得出
    return [];
}

// 高度钉在 '&' 上并让 scroller 自己滚：不给的话编辑器按内容长高，
// 在 flex 容器里就是每敲一行整页跳一次。走 Compartment 是为了拖动改高度时
// 只换这一条主题，不重建编辑器（重建会丢撤销历史与光标）。
function heightTheme(px: number) {
    return EditorView.theme({'&': {height: `${px}px`}, '.cm-scroller': {overflow: 'auto'}});
}

const CodePane = forwardRef<CodePaneHandle, CodePaneProps>(function CodePane(
    {value, kind, ariaLabel, height = 320, editable = false, resizable = false, storageKey, onChange},
    ref,
) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const [paneHeight, setPaneHeight] = useState(() => readStoredHeight(storageKey, height));
    const paneHeightRef = useRef(paneHeight);
    paneHeightRef.current = paneHeight;
    const dragCleanupRef = useRef<(() => void) | null>(null);
    // 回调放 ref：进 effect 依赖的话每次输入都会重建编辑器，光标弹回开头、撤销历史也没了
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const kindRef = useRef(kind);
    kindRef.current = kind;
    const initialValue = useRef(value);
    const initialKind = useRef(kind);
    // 编辑器自己 emit 出去的那份文本：value 回流时靠它判定"这就是我刚写的内容"，
    // 省掉一次整篇 doc.toString()——5MB 报文每敲一键序列化两遍是肉眼可见的卡。
    const emitted = useRef<string | null>(initialValue.current);

    const languageCompartment = useRef(new Compartment());
    const heightCompartment = useRef(new Compartment());

    useEffect(() => {
        const host = hostRef.current;
        if (!host) {
            return;
        }
        const view = new EditorView({
            state: EditorState.create({
                doc: initialValue.current,
                extensions: [
                    lineNumbers(),
                    highlightActiveLine(),
                    drawSelection(),
                    rectangularSelection(),
                    bracketMatching(),
                    foldGutter(),
                    editorTheme,
                    EditorView.lineWrapping,
                    EditorView.editable.of(editable),
                    EditorState.readOnly.of(!editable),
                    heightCompartment.current.of(heightTheme(paneHeightRef.current)),
                    languageCompartment.current.of(languageExtension(initialKind.current)),
                    EditorView.updateListener.of(update => {
                        if (update.docChanged) {
                            const text = update.state.doc.toString();
                            emitted.current = text;
                            onChangeRef.current?.(text);
                        }
                    }),
                    EditorView.contentAttributes.of({'aria-label': ariaLabel, 'aria-multiline': 'true'}),
                    // 编辑相关的东西只在可编辑时挂：只读实例挂 history 只是多占内存，
                    // 挂 keymap 还会让方向键去动一个改不了的东西
                    ...(editable ? editingExtensions() : []),
                ],
            }),
            parent: host,
        });
        viewRef.current = view;
        return () => {
            view.destroy();
            viewRef.current = null;
        };
        // 只建一次实例：value / kind 的变化由下面的 effect 处理
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const view = viewRef.current;
        if (!view) {
            return;
        }
        if (value === emitted.current) {
            return;
        }
        const doc = view.state.doc;
        // 长度都不等就没必要序列化全文比对；等长时才需要读一遍确认不是外部塞进来的同长度内容。
        if (doc.length === value.length && doc.toString() === value) {
            return;
        }
        emitted.current = value;
        view.dispatch({changes: {from: 0, to: doc.length, insert: value}});
    }, [value]);

    useEffect(() => {
        viewRef.current?.dispatch({effects: [languageCompartment.current.reconfigure(languageExtension(kind))]});
    }, [kind]);

    useEffect(() => {
        viewRef.current?.dispatch({effects: [heightCompartment.current.reconfigure(heightTheme(paneHeight))]});
    }, [paneHeight]);

    // 卸载时若还拖着，收回全局样式与监听（和侧边栏拖宽同一套做法）
    useEffect(() => () => dragCleanupRef.current?.(), []);

    const handleResizeStart = useCallback(
        (event: ReactMouseEvent) => {
            event.preventDefault();
            const startY = event.clientY;
            const startHeight = paneHeightRef.current;
            const onMove = (moveEvent: MouseEvent) => {
                setPaneHeight(Math.min(RESIZE_MAX, Math.max(RESIZE_MIN, startHeight + moveEvent.clientY - startY)));
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
                if (storageKey) {
                    try {
                        localStorage.setItem(storageKey, String(paneHeightRef.current));
                    } catch {
                        // 存不下就只丢持久化，本次拖动的高度照常生效
                    }
                }
            };
            dragCleanupRef.current = cleanup;
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'ns-resize';
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', cleanup);
            // 在窗口外松手时 mouseup 送不回来，blur 兜底结束拖动
            window.addEventListener('blur', cleanup);
        },
        [storageKey],
    );

    useImperativeHandle(
        ref,
        () => ({
            format: () => {
                const view = viewRef.current;
                if (!view || kindRef.current === 'text') {
                    return false;
                }
                const text = view.state.doc.toString();
                // JSON 不合法时 formatPayload 原样返回，等于没格式化：这种时候要返回 false，
                // 让调用方提示"正文不是合法 JSON"，而不是假装成功。
                if (kindRef.current === 'json') {
                    try {
                        JSON.parse(text);
                    } catch {
                        return false;
                    }
                }
                const formatted = formatPayload(text, kindRef.current);
                if (formatted !== text) {
                    view.dispatch({changes: {from: 0, to: text.length, insert: formatted}});
                }
                return true;
            },
            focus: () => viewRef.current?.focus(),
        }),
        [],
    );

    if (!resizable) {
        return <div className="json-editor" ref={hostRef} style={{height: paneHeight}} />;
    }
    return (
        <div style={{position: 'relative', paddingBottom: 7}}>
            <div className="json-editor" ref={hostRef} style={{height: paneHeight}} />
            <div
                className="code-pane-resize"
                title="按住上下拖动调整高度"
                aria-label={`${ariaLabel} 高度调节`}
                role="separator"
                onMouseDown={handleResizeStart}
            />
        </div>
    );
});

// 只在可编辑时挂的那一批：撤销历史、括号闭合、缩进与键位。
function editingExtensions() {
    return [
        history(),
        closeBrackets(),
        indentOnInput(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
    ];
}

export default CodePane;
