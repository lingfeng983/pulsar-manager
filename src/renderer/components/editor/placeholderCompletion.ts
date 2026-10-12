import type {Completion, CompletionContext, CompletionResult} from '@codemirror/autocomplete';
import {FUNCTION_SIGNATURES, KNOWN_FUNCTIONS} from '../../../shared/template-engine';

// ${ 之后的补全。函数清单与参数写法直接取自 template-engine 的 KNOWN_FUNCTIONS /
// FUNCTION_SIGNATURES——引擎加一个函数这里就自动多一条，不会出现"界面补全出来的
// 写法引擎不认"这种两边各维护一份才会有的错位。

const FUNCTION_HINTS: Record<string, string> = {
    int: '区间内的随机整数',
    float: '区间内的随机小数',
    bool: '随机 true / false',
    string: '随机字符串',
    uuid: '随机 UUID',
    choice: '从候选里随机取一个',
    seq: '按消息序号递增',
    index: '本条在 $each 里的序号',
    now: '当前时间',
    date: '区间内的随机日期',
    timestamp: '当前时间戳',
};

const COMPLETIONS: Completion[] = KNOWN_FUNCTIONS.map(name => {
    const signature = FUNCTION_SIGNATURES[name];
    // 参数部分就是 label 括号里的内容，两者永远一致
    const args = signature.slice(signature.indexOf('('));
    return {
        label: signature,
        type: 'function',
        detail: FUNCTION_HINTS[name],
        boost: 10,
        apply: `\${${name}${args}}`,
    };
});

function variableCompletions(names: string[]): Completion[] {
    return names.map(name => ({label: name, type: 'variable', detail: '具名变量', apply: `\${${name}}`}));
}

/**
 * @param variableNames 变量表里已经定义好的名字；裸名字补全只在有变量时出现
 */
export function placeholderCompletion(variableNames: string[]) {
    const options = [...COMPLETIONS, ...variableCompletions(variableNames)];
    return (context: CompletionContext): CompletionResult | null => {
        // 只在 $ 或 ${ 之后拉起：JSON 里其他地方弹一列花括号只会挡住正常输入
        const before = context.matchBefore(/\$\{?[A-Za-z0-9_]*$/);
        if (!before) {
            return null;
        }
        if (before.from === before.to && !context.explicit) {
            return null;
        }
        return {from: before.from, options, validFor: /^\$\{?[A-Za-z0-9_]*$/};
    };
}
