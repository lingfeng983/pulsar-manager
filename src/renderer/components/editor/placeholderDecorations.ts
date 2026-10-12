import type {Range, EditorState} from '@codemirror/state';
import {Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate} from '@codemirror/view';
import type {Extension} from '@codemirror/state';
import {syntaxTree} from '@codemirror/language';
import {PLACEHOLDER_PATTERN, checkPlaceholder} from '../../../shared/template-engine';

// 把 ${...} 占位符标出来。判定复用 template-engine 的 checkPlaceholder：
// 编辑器标红的写法必须与解析阶段拒绝的写法逐字一致，否则用户会遇见
// "看起来没问题、点发送才报错"和反过来两种都无法解释的情况。

// 键名里的 ${} 引擎不展开（占位符只允许出现在字符串值里），跟着高亮等于承诺了
// 一件不会发生的事，所以要从语法树里把属性名的范围挑出来跳过。
function propertyNameRanges(state: EditorState): {from: number; to: number}[] {
    const tree = syntaxTree(state);
    // 增量解析只覆盖视口附近，先把文末解析出来，否则屏幕外的键名范围是缺的
    tree.resolve(state.doc.length, 1);
    const ranges: {from: number; to: number}[] = [];
    tree.iterate({
        enter: node => {
            if (node.name === 'PropertyName') {
                ranges.push({from: node.from, to: node.to});
            }
            return true;
        },
    });
    return ranges;
}

function buildDecorations(view: EditorView, names: Set<string>): DecorationSet {
    const text = view.state.doc.toString();
    if (text.length === 0) {
        return Decoration.none;
    }
    const keys = propertyNameRanges(view.state);
    const ranges: Range<Decoration>[] = [];
    // 每次扫描都用新的正则实例：带 g 的正则把 lastIndex 存在对象上，共享一份就会
    // 与别的调用方互相跳位（同一个 ${} 这边扫到、那边漏掉）。
    const pattern = new RegExp(PLACEHOLDER_PATTERN.source, 'g');
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        const from = match.index;
        const to = from + match[0].length;
        if (keys.some(range => from >= range.from && to <= range.to)) {
            continue;
        }
        const ok = checkPlaceholder(match[1], names).ok;
        ranges.push(Decoration.mark({class: ok ? 'cm-pm-placeholder' : 'cm-pm-placeholder-invalid'}).range(from, to));
    }
    // 匹配本来就按位置递增，sorted 传 true 省掉一次排序
    return Decoration.set(ranges, true);
}

// 变量表走构造参数而不是闭包捕获：不带 arg 的 fromClass 在类型上会退化成
// ViewPlugin<V, unknown>，那个 extension 是 null，塞不进 Extension 数组。
const placeholderPlugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;
        private readonly names: Set<string>;

        constructor(view: EditorView, arg: {names: Set<string>}) {
            this.names = arg.names;
            this.decorations = buildDecorations(view, this.names);
        }

        update(update: ViewUpdate): void {
            if (update.docChanged || update.viewportChanged) {
                this.decorations = buildDecorations(update.view, this.names);
            }
        }
    },
    {decorations: value => value.decorations},
);

/**
 * 占位符高亮。变量名集合变了要重新装配一次（界面用 Compartment.reconfigure），
 * 因为"这个裸名字算不算已定义变量"取决于变量表。
 */
export function placeholderExtension(variableNames: string[]): Extension {
    return placeholderPlugin.of({names: new Set(variableNames)});
}
