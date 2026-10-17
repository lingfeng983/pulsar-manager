// 「模板内联 schema」用的 JSON Schema 子集校验器，主进程与渲染层共用，保持零 import。
// 只认这些关键字：type（含 integer/number 区分）、enum、const、required、properties、
// items（单 schema 或元组）。$ref、allOf/anyOf/oneOf、format 与一切数值/长度边界
// 都不支持——发送路径上"这条报文为什么被拒"必须每条规则都解释得清，
// 解释不全的组合逻辑宁可不支持，也不养一个"看起来像 JSON Schema"的半吊子。

export interface SchemaIssue {
    // 出错位置：根是空串，字段用点路径（user.address.city），数组下标用 [n]（tags[3]）
    path: string;
    message: string;
}

const MAX_ISSUES = 10;

export interface SchemaValidationResult {
    issues: SchemaIssue[];
    // 超过 MAX_ISSUES 时为 true：此时 issues.length 只是显示上限，不是问题总数
    truncated: boolean;
}

type JsonType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

const KNOWN_TYPES: JsonType[] = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

function jsonTypeOf(value: unknown): JsonType {
    if (value === null) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return 'array';
    }
    switch (typeof value) {
        case 'string':
            return 'string';
        case 'boolean':
            return 'boolean';
        case 'number':
            return Number.isInteger(value) ? 'integer' : 'number';
        default:
            // JSON.parse 的产物里没有别的类型；走到这里说明传进来的不是解析过的报文
            return typeof value as JsonType;
    }
}

function matchesType(value: unknown, expected: string): boolean {
    const actual = jsonTypeOf(value);
    if (expected === 'number') {
        // integer 是 number 的子集：schema 说 number 时 3 必须合法
        return actual === 'number' || actual === 'integer';
    }
    return actual === expected;
}

function joinPath(base: string, key: string): string {
    return base === '' ? key : `${base}.${key}`;
}

// enum/const 的相等按 JSON 语义深比较（基本类型直接 ===，对象走 stringify）：
// 报文来自 JSON.parse，键序由 schema 作者与报文作者各自决定，这里不比键序。
function jsonEquals(a: unknown, b: unknown): boolean {
    if (a === b) {
        return true;
    }
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
        return false;
    }
    return JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
}

function sortDeep(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortDeep);
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1));
        return Object.fromEntries(entries.map(([k, v]) => [k, sortDeep(v)]));
    }
    return value;
}

/**
 * 按 schema 校验一个已解析的 JSON 值。schema 本身应是 parseSchemaJson 放行过的形状；
 * 校验器遇到不认识的关键字一律跳过（不是放行整个节点，是不判这条规则），
 * 这样"校验器版本旧于 schema"最多是少判一项，而不是把合法报文判死。
 */
export function validateJsonSchema(value: unknown, schema: unknown): SchemaValidationResult {
    const issues: SchemaIssue[] = [];
    let truncated = false;
    const push = (path: string, message: string): void => {
        if (issues.length < MAX_ISSUES) {
            issues.push({path, message});
        } else {
            truncated = true;
        }
    };

    const walk = (node: unknown, rule: unknown, path: string): void => {
        // 已经确认还有更多问题时就不必继续走：结论只需要「不止 10 处」
        if (truncated || rule === true || rule === undefined) {
            return;
        }
        if (rule === false) {
            push(path, '该位置不允许出现值');
            return;
        }
        if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
            return;
        }
        const spec = rule as Record<string, unknown>;

        if (typeof spec.type === 'string') {
            if (KNOWN_TYPES.includes(spec.type as JsonType) && !matchesType(node, spec.type)) {
                push(path, `应为 ${spec.type}，实际是 ${jsonTypeOf(node)}`);
                return;
            }
        } else if (Array.isArray(spec.type)) {
            const types = spec.type.filter((t): t is string => typeof t === 'string');
            if (types.length > 0 && !types.some(t => matchesType(node, t))) {
                push(path, `应为 ${types.join(' / ')} 之一，实际是 ${jsonTypeOf(node)}`);
                return;
            }
        }

        if ('const' in spec && !jsonEquals(node, spec.const)) {
            push(path, `值必须恰好是 ${JSON.stringify(spec.const)}`);
        }
        if (Array.isArray(spec.enum) && !spec.enum.some(option => jsonEquals(node, option))) {
            push(path, `值应属于枚举 ${JSON.stringify(spec.enum)}`);
        }

        if (jsonTypeOf(node) === 'object') {
            const current = node as Record<string, unknown>;
            if (Array.isArray(spec.required)) {
                for (const key of spec.required) {
                    if (typeof key === 'string' && !(key in current)) {
                        push(joinPath(path, key), '必填字段缺失');
                    }
                }
            }
            if (spec.properties && typeof spec.properties === 'object' && !Array.isArray(spec.properties)) {
                const props = spec.properties as Record<string, unknown>;
                for (const [key, sub] of Object.entries(props)) {
                    if (key in current) {
                        walk(current[key], sub, joinPath(path, key));
                    }
                }
            }
        }

        if (Array.isArray(node)) {
            if (Array.isArray(spec.items)) {
                // 元组写法：按下标各配各的，多出来的元素不判（additionalItems 不支持）
                node.forEach((item, i) => walk(item, spec.items![i], joinPath(path, `[${i}]`)));
            } else if (spec.items !== undefined) {
                node.forEach((item, i) => walk(item, spec.items, joinPath(path, `[${i}]`)));
            }
        }
    };

    walk(value, schema, '');
    return {issues, truncated};
}

/** schemaJson 列里存的原文 → 可用的 schema 值。保存与发送前都先过这道闸。 */
export function parseSchemaJson(raw: string): {ok: true; schema: unknown} | {ok: false; error: string} {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch {
        return {ok: false, error: 'schema 需要是合法的 JSON'};
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {ok: false, error: 'schema 需要是 JSON 对象（如 {"type":"object",...}）'};
    }
    return {ok: true, schema: parsed};
}

/** 把校验结论压成一句能进失败列表/错误提示的话；界面不再逐条拼。 */
export function formatSchemaIssues(result: SchemaValidationResult): string {
    const {issues, truncated} = result;
    const describe = (issue: SchemaIssue): string =>
        issue.path === '' ? `根对象：${issue.message}` : `${issue.path}：${issue.message}`;
    const shown = issues.slice(0, 3).map(describe).join('；');
    if (truncated) {
        return `schema 校验不通过：${shown}（仅显示前 ${issues.length} 处，还有更多）`;
    }
    return issues.length > 3 ? `schema 校验不通过：${shown}（共 ${issues.length} 处）` : `schema 校验不通过：${shown}`;
}
