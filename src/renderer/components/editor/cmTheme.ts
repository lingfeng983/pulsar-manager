import {EditorView} from '@codemirror/view';
import {HighlightStyle, syntaxHighlighting} from '@codemirror/language';
import {tags as t} from '@lezer/highlight';

// 颜色与字号一律引用 CSS 变量，不写死 px 或 #hex。
// 主题（亮/暗/护眼）与字号四档都是靠改 <html> 上那批变量生效的：style-mod 把这里的
// 值原样塞进生成的样式表，所以变量会在浏览器里按当前 <html> 解析，切主题和切字号
// 编辑器跟着走。写成 #fff 的话，实测就是"整页都变暗了只有编辑器还白底"。

export const editorTheme = EditorView.theme({
    '&': {
        color: 'var(--color-text-primary)',
        backgroundColor: 'var(--color-bg-base)',
        fontSize: 'var(--font-size-sm)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
    },
    '&.cm-focused': {outline: 'none'},
    '.cm-scroller': {
        fontFamily: 'var(--font-mono)',
        lineHeight: '1.5',
        // 不设这个的话 .cm-content 只在有内容的那几列着色，滚动区右侧一片空白底色
        overflow: 'auto',
    },
    '.cm-content': {
        caretColor: 'var(--color-text-primary)',
        padding: 'var(--spacing-xs) 0',
    },
    '.cm-gutters': {
        backgroundColor: 'var(--color-bg-secondary)',
        color: 'var(--color-text-tertiary)',
        borderRight: '1px solid var(--color-border)',
    },
    '.cm-lineNumbers .cm-gutterElement': {padding: '0 var(--spacing-sm)'},
    '.cm-activeLine': {backgroundColor: 'var(--color-bg-secondary)'},
    '.cm-activeLineGutter': {backgroundColor: 'var(--color-bg-secondary)'},
    '.cm-cursor, .cm-dropCursor': {borderLeftColor: 'var(--color-text-primary)'},
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'var(--color-fill-secondary)',
    },
    '.cm-selectionMatch': {backgroundColor: 'var(--color-fill-secondary)'},
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
        backgroundColor: 'var(--color-fill-secondary)',
        outline: '1px solid var(--color-border)',
    },
    '.cm-tooltip': {
        backgroundColor: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--color-text-primary)',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: 'var(--color-primary)',
        color: 'var(--color-bg-base)',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {padding: '0 var(--spacing-sm)'},
    '.cm-tooltip-autocomplete ul li .cm-completionDetail': {
        color: 'var(--color-text-tertiary)',
        fontStyle: 'normal',
        marginLeft: 'var(--spacing-sm)',
    },
    '.cm-panel.cm-lint-panel': {
        backgroundColor: 'var(--color-bg-secondary)',
        fontFamily: 'var(--font-family)',
        fontSize: 'var(--font-size-xs)',
    },
    '.cm-panels, .cm-panels-bottom': {
        backgroundColor: 'var(--color-bg-secondary)',
        color: 'var(--color-text-secondary)',
        border: '1px solid var(--color-border)',
    },
    '.cm-foldPlaceholder': {
        backgroundColor: 'var(--color-fill-secondary)',
        border: '1px solid var(--color-border)',
        color: 'var(--color-text-secondary)',
    },
    '.cm-search': {backgroundColor: 'var(--color-bg-elevated)', color: 'var(--color-text-primary)'},
    '.cm-search button, .cm-search input': {
        backgroundColor: 'var(--color-bg-secondary)',
        color: 'var(--color-text-primary)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
    },
    '.cm-search a': {color: 'var(--color-primary)'},
    '.cm-search a:hover': {color: 'var(--color-primary)'},
});

// JSON 的着色。键用主色、字符串用绿、数值用橙、true/false/null 用红：
// 与界面别处的"值/量/异常"配色一致，用户不必为编辑器另学一套颜色含义。
export const jsonHighlight = syntaxHighlighting(
    HighlightStyle.define([
        {tag: t.propertyName, color: 'var(--color-primary)'},
        {tag: [t.string, t.special(t.string)], color: 'var(--color-success)'},
        {tag: t.number, color: 'var(--color-warning)'},
        {tag: [t.bool, t.null], color: 'var(--color-danger)'},
        {tag: [t.punctuation, t.brace, t.squareBracket], color: 'var(--color-text-secondary)'},
        {tag: t.comment, color: 'var(--color-text-tertiary)', fontStyle: 'italic'},
        {tag: t.invalid, color: 'var(--color-danger)'},
    ]),
);

// XML 的着色：标签名用主色、属性名用橙、属性值用绿、注释与 PI 用三级灰，
// 与上面 JSON 那套"名字/值/异常"的配色含义保持一致。
export const xmlHighlight = syntaxHighlighting(
    HighlightStyle.define([
        {tag: t.tagName, color: 'var(--color-primary)'},
        {tag: t.attributeName, color: 'var(--color-warning)'},
        {tag: t.attributeValue, color: 'var(--color-success)'},
        {tag: [t.angleBracket, t.punctuation], color: 'var(--color-text-secondary)'},
        {tag: [t.comment, t.processingInstruction], color: 'var(--color-text-tertiary)', fontStyle: 'italic'},
        {tag: t.invalid, color: 'var(--color-danger)'},
    ]),
);
