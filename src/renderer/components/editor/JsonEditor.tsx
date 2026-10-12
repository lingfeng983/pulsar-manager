import {forwardRef, useEffect, useImperativeHandle, useRef} from 'react';
import {Compartment, EditorState, type Extension} from '@codemirror/state';
import {
    EditorView,
    drawSelection,
    highlightActiveLine,
    highlightActiveLineGutter,
    keymap,
    lineNumbers,
    rectangularSelection,
} from '@codemirror/view';
import {defaultKeymap, history, historyKeymap, indentWithTab} from '@codemirror/commands';
import {json} from '@codemirror/lang-json';
import {bracketMatching, foldGutter, foldKeymap, indentOnInput} from '@codemirror/language';
import {autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap} from '@codemirror/autocomplete';
import {linter, lintGutter, type Diagnostic} from '@codemirror/lint';
import {validateTemplate, type TemplateVariable} from '../../../shared/template-engine';
import {editorTheme, jsonHighlight} from './cmTheme';
import {placeholderExtension} from './placeholderDecorations';
import {placeholderCompletion} from './placeholderCompletion';

// JSON 报文编辑器。用 CodeMirror 6 而不是 antd 的 TextArea：占位符高亮、括号折叠、
// 语法着色、${ 补全这四件事 textarea 都做不到，而它们恰恰是模板编辑要依赖的东西。

export interface JsonEditorHandle {
    /** 缩进两格重排。正文不是合法 JSON 时返回 false，调用方据此提示而不是假装成功。 */
    format: () => boolean;
    focus: () => void;
}

interface JsonEditorProps {
    value: string;
    onChange?: (value: string) => void;
    /** 变量表；参与占位符判定与 ${ 补全，改一次就重新装配一次扩展 */
    variables?: TemplateVariable[];
    ariaLabel: string;
    height?: number;
    readOnly?: boolean;
}

// 依赖变量表的那三样扩展打包成一个函数：创建与重装配走同一份，
// 否则两处写法迟早漂成"高亮认这套、补全认那套"。
function templateExtensions(variables: TemplateVariable[]): Extension {
    const names = variables.map(item => item.name);
    return [
        placeholderExtension(names),
        autocompletion({
            // override 掉默认来源：JSON 字符串里默认补全只会给文档里的其他单词，
            // 而这里真正想要的只有占位符函数与具名变量。
            override: [placeholderCompletion(names)],
            activateOnTyping: true,
        }),
        linter(view => buildDiagnostics(view, variables), {delay: 250}),
    ];
}

function editableExtension(readOnly: boolean): Extension {
    // 两个开关各管一半：editable 决定 DOM 的 contenteditable，readOnly 拦下所有事务。
    // 只设前者的话，粘贴与程序化 dispatch 都还能改正文。
    return [EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)];
}

function buildDiagnostics(view: EditorView, variables: TemplateVariable[]): Diagnostic[] {
    const text = view.state.doc.toString();
    const result = validateTemplate(text, variables);
    if (result.ok) {
        return [];
    }
    // 位置给篇首一个字符而不是整篇：JSON 语法错的信息里已经带着内容，
    // 满屏红下划线除了挡住正文没有别的作用，而模板正文最长 1MB。
    return [{from: 0, to: Math.min(1, text.length), severity: 'error', message: result.error || '模板校验失败'}];
}

const JsonEditor = forwardRef<JsonEditorHandle, JsonEditorProps>(function JsonEditor(
    {value, onChange, variables = [], ariaLabel, height = 280, readOnly = false},
    ref,
) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    // 回调与变量表放 ref 给扩展读：让它们进 effect 依赖的话，每次输入都会
    // 重建编辑器实例，光标跳回开头、撤销历史整条没了。
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const variablesRef = useRef(variables);
    variablesRef.current = variables;
    const initialDoc = useRef(value);

    const editableCompartment = useRef(new Compartment());
    const templateCompartment = useRef(new Compartment());

    useEffect(() => {
        const host = hostRef.current;
        if (!host) {
            return;
        }
        const view = new EditorView({
            state: EditorState.create({
                doc: initialDoc.current,
                extensions: [
                    lineNumbers(),
                    highlightActiveLineGutter(),
                    highlightActiveLine(),
                    history(),
                    drawSelection(),
                    rectangularSelection(),
                    bracketMatching(),
                    closeBrackets(),
                    indentOnInput(),
                    foldGutter(),
                    json(),
                    editorTheme,
                    jsonHighlight,
                    lintGutter(),
                    keymap.of([
                        ...closeBracketsKeymap,
                        ...defaultKeymap,
                        ...historyKeymap,
                        ...foldKeymap,
                        ...completionKeymap,
                        indentWithTab,
                    ]),
                    EditorView.lineWrapping,
                    editableCompartment.current.of(editableExtension(readOnly)),
                    // 高度钉在 '&' 上并让 scroller 自己滚：不给的话编辑器按内容长高，
                    // 而父容器是 flex，于是输入时每敲一行整页都在跳。
                    EditorView.theme({'&': {height: `${height}px`}, '.cm-scroller': {overflow: 'auto'}}),
                    templateCompartment.current.of(templateExtensions(variablesRef.current)),
                    EditorView.updateListener.of(update => {
                        if (update.docChanged) {
                            onChangeRef.current?.(update.state.doc.toString());
                        }
                    }),
                    EditorView.contentAttributes.of({'aria-label': ariaLabel, 'aria-multiline': 'true'}),
                ],
            }),
            parent: host,
        });
        viewRef.current = view;
        return () => {
            view.destroy();
            viewRef.current = null;
        };
        // 只建一次实例：value / variables / readOnly 的变化都由下面的 effect 处理
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 外部换模板（从模板库载入、清空重写）：值不同才替换，否则每次输入都会
    // 触发一次整篇替换，等于把刚敲进去的内容按回去。
    useEffect(() => {
        const view = viewRef.current;
        if (!view) {
            return;
        }
        const current = view.state.doc.toString();
        if (current !== value) {
            view.dispatch({changes: {from: 0, to: current.length, insert: value}});
        }
    }, [value]);

    useEffect(() => {
        viewRef.current?.dispatch({
            effects: [
                editableCompartment.current.reconfigure(editableExtension(readOnly)),
                templateCompartment.current.reconfigure(templateExtensions(variables)),
            ],
        });
    }, [readOnly, variables]);

    useImperativeHandle(
        ref,
        () => ({
            format: () => {
                const view = viewRef.current;
                if (!view) {
                    return false;
                }
                const text = view.state.doc.toString();
                try {
                    const pretty = JSON.stringify(JSON.parse(text) as unknown, null, 2);
                    if (pretty !== text) {
                        view.dispatch({changes: {from: 0, to: text.length, insert: pretty}});
                    }
                    return true;
                } catch {
                    return false;
                }
            },
            focus: () => viewRef.current?.focus(),
        }),
        [],
    );

    return <div className="json-editor" ref={hostRef} style={{height}} />;
});

export default JsonEditor;
