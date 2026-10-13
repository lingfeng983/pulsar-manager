// 报文模板的占位符引擎。渲染层用它做编辑期校验与预览，主进程用它做实际发送的解析，
// 两边必须是同一份实现——否则"预览看到的"和"发出去的"不是一回事，而用户唯一的
// 判断依据就是预览。
//
// 三条贯穿全局的设计约束：
// 1. 占位符只允许出现在 JSON 字符串值内部，所以模板本身永远是合法 JSON，
//    编辑器的高亮/格式化/语法检查不会因为用户填了占位符而全线报错。
// 2. 某个字符串值"整体恰好是一个占位符"时，解析结果替换整个值（${int(1,50)} → 数字 50），
//    否则做字符串插值（SKU${int(100,999)} → "SKU421"）。类型保持靠这一条，
//    而 JSON 报文里 number/boolean 字段的类型通常就是接口约定的一部分。
// 3. 键名不支持占位符。
//
// 本模块禁止 import 任何 Node / Electron / 第三方包：它同时被 tsconfig.node.json
// （主进程，CommonJS）与 tsconfig.json（渲染层，ESNext + strict）编译，只有
// src/shared/ 是两者共同的 include 范围。日期格式化因此自带一个极小的 pattern 实现，
// 而不是复用渲染层的 dayjs。

export interface TemplateVariable {
    name: string;
    expr: string;
}

export interface ResolveOptions {
    // 带 seed 时随机走可复现的 xorshift32：预览与实发在同一个 seed 下逐字节一致，
    // 自测才能把"两边同源"这件事钉死。不带则用 Math.random。
    seed?: number;
    // 第几条消息（从 0 起）：seq() 的取值由它推出，解析器因此保持无状态。
    messageIndex?: number;
    // 时钟基准，自测用
    now?: number;
    maxBytes?: number;
}

export type ResolveResult = {ok: true; text: string; bytes: number} | {ok: false; error: string};

export interface ValidateResult {
    ok: boolean;
    error?: string;
}

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const PLACEHOLDER = /\$\{([^}]*)\}/g;
const WHOLE_PLACEHOLDER = /^\$\{([^}]*)\}$/;
const CALL = /^([A-Za-z_][A-Za-z0-9_]*)\(([\s\S]*)\)$/;
const EACH_KEY = '$each';
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const KNOWN_FUNCTIONS: string[] = [
    'int',
    'float',
    'bool',
    'string',
    'uuid',
    'choice',
    'seq',
    'index',
    'now',
    'date',
    'timestamp',
];

export const FUNCTION_SIGNATURES: Record<string, string> = {
    int: 'int(min, max)',
    float: 'float(min, max, 小数位)',
    bool: 'bool()',
    string: 'string(长度, 字符集?)',
    uuid: 'uuid()',
    choice: 'choice(a|b|c)',
    seq: 'seq(起始, 步长)',
    index: 'index(起始?)',
    now: 'now(格式, 偏移毫秒)',
    date: 'date(起, 止, 格式?)',
    timestamp: 'timestamp(ms|s)',
};

// ---------- 随机源 ----------

interface Rng {
    next(): number;
    int(min: number, max: number): number;
    pick<T>(items: T[]): T;
}

function createRng(seed?: number): Rng {
    // xorshift32：只需要"同 seed 同序列"，不需要密码学强度
    const reproducible = seed !== undefined;
    let state = (seed ?? 0) >>> 0 || 0x9e3779b9;
    const unit = (): number => {
        if (!reproducible) {
            return Math.random();
        }
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state >>>= 0;
        state ^= state << 5;
        state >>>= 0;
        return state / 0x100000000;
    };
    return {
        next: unit,
        int(min: number, max: number): number {
            return Math.ceil(min) + Math.floor(unit() * (Math.floor(max) - Math.ceil(min) + 1));
        },
        pick<T>(items: T[]): T {
            return items[Math.min(items.length - 1, Math.floor(unit() * items.length))];
        },
    };
}

// ---------- 日期 ----------

// pattern 只认这几个 token，其余字符原样输出（所以 now(YYYY-MM-DDTHH:mm:ssZ) 里的
// Z 就是字面量，不需要 dayjs 那套方括号转义）。
function formatDate(ms: number, pattern: string): string {
    const date = new Date(ms);
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
    const tokens: Record<string, string> = {
        YYYY: String(date.getFullYear()),
        MM: pad(date.getMonth() + 1),
        DD: pad(date.getDate()),
        HH: pad(date.getHours()),
        mm: pad(date.getMinutes()),
        ss: pad(date.getSeconds()),
        SSS: pad(date.getMilliseconds(), 3),
    };
    return pattern.replace(/YYYY|MM|DD|HH|mm|ss|SSS/g, token => tokens[token]);
}

// ---------- 表达式求值 ----------

type Value = string | number | boolean;

interface Scope {
    // $each 里的 0 基序号；不在展开作用域时为 undefined
    index?: number;
}

function splitArgs(input: string): string[] {
    const text = input.trim();
    if (!text) {
        return [];
    }
    // 裸 split(',') 会把引号里的逗号也当分隔符：string(8, "a b") 这类还行，
    // choice("x,y"|z) 或带逗号的日期 pattern 会被切成错误的碎片。
    // 这里按引号状态扫描切分，引号内的逗号不参与分隔。
    const parts: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (quote === null && (char === '"' || char === "'")) {
            quote = char;
            current += char;
        } else if (char === quote) {
            quote = null;
            current += char;
        } else if (char === ',' && quote === null) {
            parts.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    parts.push(current.trim());
    return parts;
}

function toNumber(raw: string | undefined, fallback: number, fn: string): number {
    if (raw === undefined || raw === '') {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        throw new Error(`${fn} 的参数要是数字，收到「${raw}」`);
    }
    return parsed;
}

const HEX = '0123456789abcdef';
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function uuidOf(rng: Rng): string {
    const hex = (count: number): string => {
        let out = '';
        for (let index = 0; index < count; index += 1) {
            out += HEX[rng.int(0, 15)];
        }
        return out;
    };
    // 版本位与变体位按 v4 填，界面上一眼就能认出这是个 uuid
    return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[rng.int(0, 3)]}${hex(3)}-${hex(12)}`;
}

// choice 选中什么就按什么转型：全数字候选发成数字、true/false 发成布尔，
// 其余按字符串。"code": "${choice(200|404|500)}" 发出去是数字 200 而不是 "200"，
// 这是写这种模板的人的预期。
function castScalar(raw: string): Value {
    const trimmed = raw.trim();
    if (trimmed === 'true' || trimmed === 'false') {
        return trimmed === 'true';
    }
    // 只有"转成数字再写回来一模一样"才算数字：19~20 位的订单号超出 2^53，
    // Number() 会把末几位改掉，"007" 也会掉前导零。这两个场景里用户要的
    // 恰恰是与报文一致的字符串，静默转数字就是发出一条对不上账的消息。
    if (trimmed !== '' && Number.isFinite(Number(trimmed)) && String(Number(trimmed)) === trimmed) {
        return Number(trimmed);
    }
    return raw;
}

function evaluate(
    expression: string,
    rng: Rng,
    options: ResolveOptions,
    scope: Scope,
    variables: Map<string, string>,
): Value {
    const text = expression.trim();
    const call = CALL.exec(text);
    if (!call) {
        if (!IDENTIFIER.test(text)) {
            throw new Error(`占位符「${text}」既不是具名变量也不是函数调用`);
        }
        if (!variables.has(text)) {
            throw new Error(`未定义的具名变量「${text}」，请在变量表里补上，或改用函数调用`);
        }
        return castScalar(variables.get(text) as string);
    }

    const fn = call[1];
    const args = splitArgs(call[2]);
    switch (fn) {
        case 'int': {
            const min = toNumber(args[0], 0, 'int');
            const max = toNumber(args[1], min, 'int');
            if (min > max) {
                throw new Error(`int 的范围反了：${min} > ${max}`);
            }
            return rng.int(min, max);
        }
        case 'float': {
            const min = toNumber(args[0], 0, 'float');
            const max = toNumber(args[1], min, 'float');
            if (min > max) {
                throw new Error(`float 的范围反了：${min} > ${max}`);
            }
            const decimals = Math.max(0, Math.min(12, Math.round(toNumber(args[2], 2, 'float'))));
            return Number((min + rng.next() * (max - min)).toFixed(decimals));
        }
        case 'bool':
            return rng.next() < 0.5;
        case 'string': {
            const length = Math.max(1, Math.min(4096, Math.round(toNumber(args[0], 8, 'string'))));
            const charset = args[1] || ALNUM;
            let out = '';
            for (let index = 0; index < length; index += 1) {
                out += charset[rng.int(0, charset.length - 1)];
            }
            return out;
        }
        case 'uuid':
            return uuidOf(rng);
        case 'choice': {
            const candidates = call[2]
                .split('|')
                .map(item => item.trim())
                .filter(item => item !== '');
            if (candidates.length < 2) {
                throw new Error('choice 至少要两个候选，用 | 分隔');
            }
            return castScalar(rng.pick(candidates));
        }
        case 'seq': {
            // 跨消息自增：值 = 起点 + 消息序号 × 步长。解析器保持无状态，序号由调用方给。
            const start = toNumber(args[0], 1, 'seq');
            const step = toNumber(args[1], 1, 'seq');
            return start + (options.messageIndex ?? 0) * step;
        }
        case 'index': {
            if (scope.index === undefined) {
                throw new Error('index() 只能在 $each 展开里使用');
            }
            // 对人读数从 1 起：报文里的序号通常是给人看的
            return toNumber(args[0], 1, 'index') + scope.index;
        }
        case 'now': {
            const pattern = args[0] || 'YYYY-MM-DD HH:mm:ss';
            const offset = toNumber(args[1], 0, 'now');
            return formatDate((options.now ?? Date.now()) + offset, pattern);
        }
        case 'date': {
            const from = Date.parse((args[0] || '').replace(/'/g, ''));
            const to = Date.parse((args[1] || '').replace(/'/g, ''));
            if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
                throw new Error(`date 的区间无效：${args[0] || '空'} ~ ${args[1] || '空'}`);
            }
            return formatDate(from + rng.int(0, to - from), args[2] || 'YYYY-MM-DD');
        }
        case 'timestamp': {
            const base = options.now ?? Date.now();
            return args[0] === 's' ? Math.floor(base / 1000) : base;
        }
        default:
            throw new Error(`未知占位符函数「${fn}」，可用：${KNOWN_FUNCTIONS.join('/')}`);
    }
}

// 具名变量每条消息只解析一次：订单号在三个字段里必须一致，这是这个功能的主要用途。
// 变量按数组顺序解析，所以后面的变量可以引用前面已解析的值。
function buildVariableValues(
    variables: TemplateVariable[],
    rng: Rng,
    options: ResolveOptions,
    scope: Scope,
): Map<string, string> {
    const table = new Map<string, string>();
    for (const item of variables || []) {
        if (!IDENTIFIER.test(item.name)) {
            throw new Error(`变量名「${item.name}」不合法，只能用字母数字下划线且不能以数字开头`);
        }
        table.set(item.name, interpolate(item.expr, rng, options, scope, table));
    }
    return table;
}

function interpolate(
    raw: string,
    rng: Rng,
    options: ResolveOptions,
    scope: Scope,
    variables: Map<string, string>,
): string {
    return raw.replace(PLACEHOLDER, (_whole, expression: string) =>
        String(evaluate(expression, rng, options, scope, variables)),
    );
}

/** 单个字符串值：整体是一个占位符就替换成类型化结果，否则插值。 */
function resolveString(
    raw: string,
    rng: Rng,
    options: ResolveOptions,
    scope: Scope,
    variables: Map<string, string>,
): Value {
    const whole = WHOLE_PLACEHOLDER.exec(raw);
    if (whole) {
        return evaluate(whole[1], rng, options, scope, variables);
    }
    if (raw.includes('${')) {
        return interpolate(raw, rng, options, scope, variables);
    }
    return raw;
}

type JsonValue = string | number | boolean | null | JsonValue[] | {[key: string]: JsonValue};

function isPlainObject(node: JsonValue): node is {[key: string]: JsonValue} {
    return typeof node === 'object' && node !== null && !Array.isArray(node);
}

function isEach(node: {[key: string]: JsonValue}): boolean {
    const keys = Object.keys(node);
    return keys.length === 1 && keys[0] === EACH_KEY;
}

interface WalkContext {
    rng: Rng;
    options: ResolveOptions;
    scope: Scope;
    variables: Map<string, string>;
    budget: {nodes: number; chars: number; depth: number};
}

// 每展开一个 $each 元素计一次。单级 count 上限 10000 管不住嵌套——内外两级
// 相乘能到 1e8，而 5MB 检查在 walk+stringify 全量物化之后才生效，届时主进程
// 已经 OOM。所以在展开时就按累计预算拦，超限直接抛错，不等物化。
const MAX_EXPANDED_NODES = 200_000;
// 解析出的字符串按字符累计，与节点数双轨封顶，防止"节点少但每个巨大"绕开。
const MAX_ACCUMULATED_CHARS = 8_000_000;
// 嵌套形状异常（如 {"$each":{"count":1,"of":{"$each":…}}} 的自指写法）会让
// walk 无限递归，JS 栈溢出是原生层崩溃而不是友好报错，必须提前拦。
const MAX_WALK_DEPTH = 256;

function walk(node: JsonValue, ctx: WalkContext, path: string): JsonValue {
    ctx.budget.depth += 1;
    if (ctx.budget.depth > MAX_WALK_DEPTH) {
        throw new Error('模板嵌套层级异常（超过 256 层），请检查 $each 是否层层自引用');
    }
    try {
        if (Array.isArray(node)) {
            const out: JsonValue[] = [];
            for (let index = 0; index < node.length; index += 1) {
                const item = node[index];
                // 数组元素本身就是 $each 时展开成多个元素，这是列表类字段的主要写法
                if (isPlainObject(item) && isEach(item)) {
                    for (const expanded of expandEach(item[EACH_KEY], ctx, `${path}[${index}]`)) {
                        out.push(expanded);
                    }
                    continue;
                }
                out.push(walk(item, ctx, `${path}[${index}]`));
            }
            return out;
        }
        if (isPlainObject(node)) {
            if (isEach(node)) {
                return expandEach(node[EACH_KEY], ctx, path);
            }
            const out: {[key: string]: JsonValue} = {};
            for (const key of Object.keys(node)) {
                out[key] = walk(node[key], ctx, path ? `${path}.${key}` : key);
            }
            return out;
        }
        if (typeof node === 'string') {
            const resolved = resolveString(node, ctx.rng, ctx.options, ctx.scope, ctx.variables);
            // 整体占位符会保留原类型（${int(1,9)} 解析成数字），预算按序列化后的体积估
            ctx.budget.chars += typeof resolved === 'string' ? resolved.length : String(resolved).length;
            if (ctx.budget.chars > MAX_ACCUMULATED_CHARS) {
                const mb = Math.round(ctx.budget.chars / 1024 / 1024);
                throw new Error(`模板解析累计文本约 ${mb}MB，超出安全预算，请减少 $each 的 count 或字段体积`);
            }
            return resolved;
        }
        return node;
    } finally {
        ctx.budget.depth -= 1;
    }
}

function expandEach(spec: JsonValue | undefined, ctx: WalkContext, path: string): JsonValue[] {
    if (!isPlainObject(spec)) {
        throw new Error(`${path || '这里'} 的 $each 要写成 {"count": 条数, "of": 模板}`);
    }
    // count 允许写成占位符（"随机 3~5 条明细"是常见需求），但必须解析成整数：
    // ${float(1,3)} 这种给出 2.31 时静默取整，等于预览与实发的条数不是一回事。
    const rawCount =
        typeof spec.count === 'string'
            ? resolveString(spec.count, ctx.rng, ctx.options, ctx.scope, ctx.variables)
            : spec.count;
    const count = Number(rawCount);
    if (!Number.isInteger(count) || count < 0 || count > 10000) {
        throw new Error(`${path} 的 count 要解析成 0~10000 的整数，收到「${String(spec.count)}」`);
    }
    const out: JsonValue[] = [];
    for (let index = 0; index < count; index += 1) {
        ctx.budget.nodes += 1;
        if (ctx.budget.nodes > MAX_EXPANDED_NODES) {
            throw new Error(
                `$each 累计展开已达 ${MAX_EXPANDED_NODES} 个元素（嵌套层级会相乘放大），` + '请减少各层 count',
            );
        }
        // 每一项是独立作用域：index() 取本项序号，具名变量的值则整条消息共用
        out.push(walk(spec.of as JsonValue, {...ctx, scope: {index}}, `${path}[${index}]`));
    }
    return out;
}

// 不引 Buffer / TextEncoder：中文按 3 字节估，宁可高估也不让超限的报文溜过去。
function utf8Bytes(text: string): number {
    let bytes = 0;
    for (const char of text) {
        const code = char.codePointAt(0) as number;
        bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    }
    return bytes;
}

/** 解析一条消息，返回的 text 就是交给 producer.send 的正文。 */
export function resolveTemplate(
    body: string,
    variables: TemplateVariable[],
    options: ResolveOptions = {},
): ResolveResult {
    try {
        const parsed = JSON.parse(body) as JsonValue;
        const rng = createRng(options.seed);
        const resolveOptions: ResolveOptions = {...options, messageIndex: options.messageIndex ?? 0};
        const table = buildVariableValues(variables, rng, resolveOptions, {});
        const walkContext: WalkContext = {
            rng,
            options: resolveOptions,
            scope: {},
            variables: table,
            budget: {nodes: 0, chars: 0, depth: 0},
        };
        const text = JSON.stringify(walk(parsed, walkContext, ''));
        const bytes = utf8Bytes(text);
        const max = options.maxBytes ?? DEFAULT_MAX_BYTES;
        if (bytes > max) {
            // 兜底检查：嵌套 $each 的失控展开已由 walk/expandEach 的累计预算
            // 在物化前拦截，这里守住"单级大 count 一次性撑爆"的剩余路径。
            return {
                ok: false,
                error:
                    `解析后约 ${Math.round(bytes / 1024)}KB，超过单条消息 ${Math.round(max / 1024 / 1024)}MB 上限，` +
                    '请减少 $each 的 count 或字段体积',
            };
        }
        return {ok: true, text, bytes};
    } catch (error) {
        return {ok: false, error: error instanceof Error ? error.message : String(error)};
    }
}

/** 占位符的正则本体。编辑器的高亮层复用同一份，避免"这边标红、那边解析成功"；
 * 复用时务必自己 clone——共享 lastIndex 会让两处扫描互相把对方的位置跳掉。 */
export const PLACEHOLDER_PATTERN = PLACEHOLDER;

export type PlaceholderCheck = {ok: true; kind: 'function' | 'variable'} | {ok: false; reason: string};

/** 判断 `${}` 里的写法可不可用：已知函数调用，或已定义的具名变量。
 * 校验与编辑期高亮共用这一份判定，两处对同一个占位符不可能给出不同结论。 */
export function checkPlaceholder(expression: string, names: Set<string>): PlaceholderCheck {
    const text = expression.trim();
    const call = CALL.exec(text);
    if (call) {
        return KNOWN_FUNCTIONS.includes(call[1])
            ? {ok: true, kind: 'function'}
            : {ok: false, reason: `${text}：未知函数，可用 ${KNOWN_FUNCTIONS.join('/')}`};
    }
    if (!IDENTIFIER.test(text)) {
        return {ok: false, reason: `\${${text}}：函数调用要带括号，变量名只能用字母数字下划线`};
    }
    return names.has(text) ? {ok: true, kind: 'variable'} : {ok: false, reason: `引用了未定义变量「${text}」`};
}

/**
 * 编辑期校验：JSON 是否合法、占位符语法是否正确、具名变量是否都已定义。
 * 只查结构不真随机，避免每敲一个键预览值就跳一次。
 */
export function validateTemplate(body: string, variables: TemplateVariable[]): ValidateResult {
    let parsed: JsonValue;
    try {
        parsed = JSON.parse(body) as JsonValue;
    } catch (error) {
        return {ok: false, error: `JSON 格式错误：${error instanceof Error ? error.message : String(error)}`};
    }
    const names = new Set((variables || []).map(item => item.name));
    for (const name of names) {
        if (!IDENTIFIER.test(name)) {
            return {ok: false, error: `变量名「${name}」不合法`};
        }
    }

    const check = (expression: string, where: string): string | null => {
        const result = checkPlaceholder(expression, names);
        if (result.ok) {
            return null;
        }
        // 取 reason 要显式收窄一次：主进程那侧的 tsconfig 关了 strict，判别式联合
        // 在 strict:false 下不收窄，直接写 result.reason 是编译不过的（同 ResolveResult）。
        const reason = (result as {reason?: string}).reason || '占位符写法不合法';
        // 「引用了未定义变量」这句本身已经带了位置语义，其余两种要在前面补上在哪儿
        return reason.startsWith('引用了') ? `${where}${reason}` : `${where}的 ${reason}`;
    };

    const scanString = (value: string, where: string): string | null => {
        for (const match of value.matchAll(PLACEHOLDER)) {
            const failure = check(String(match[1]), where);
            if (failure) {
                return failure;
            }
        }
        return null;
    };

    for (const item of variables || []) {
        const failure = scanString(item.expr, `变量 ${item.name} 的表达式`);
        if (failure) {
            return {ok: false, error: failure};
        }
    }

    const visit = (node: JsonValue, path: string): string | null => {
        const where = path ? `位置 ${path} ` : '';
        if (typeof node === 'string') {
            return scanString(node, where);
        }
        if (Array.isArray(node)) {
            for (let index = 0; index < node.length; index += 1) {
                const failure = visit(node[index], `${path}[${index}]`);
                if (failure) {
                    return failure;
                }
            }
            return null;
        }
        if (isPlainObject(node)) {
            if (isEach(node)) {
                const spec = node[EACH_KEY];
                if (!isPlainObject(spec) || !('of' in spec)) {
                    return `${where || ''}$each 要写成 {"count": 条数, "of": 模板}`;
                }
                // 校验阶段不真解析（否则每敲一个键预览就跳一次），所以 count 允许是
                // 整数，也允许是"整体一个占位符"的字符串——是否解析成整数由解析阶段管。
                const count = spec.count;
                const countOk =
                    Number.isInteger(Number(count)) || (typeof count === 'string' && WHOLE_PLACEHOLDER.test(count));
                if (!countOk) {
                    return `${where || ''}$each 的 count 要是 0~10000 的整数或一个占位符`;
                }
                return visit(spec.of as JsonValue, `${path}.of`);
            }
            for (const key of Object.keys(node)) {
                const failure = visit(node[key], path ? `${path}.${key}` : key);
                if (failure) {
                    return failure;
                }
            }
        }
        return null;
    };

    const failure = visit(parsed, '');
    return failure ? {ok: false, error: failure} : {ok: true};
}

/** 收集正文里用到的裸变量名，供界面把变量表补齐。 */
export function referencedVariables(body: string): string[] {
    let parsed: JsonValue;
    try {
        parsed = JSON.parse(body) as JsonValue;
    } catch {
        return [];
    }
    const names = new Set<string>();
    const scan = (value: JsonValue): void => {
        if (typeof value === 'string') {
            for (const match of value.matchAll(PLACEHOLDER)) {
                const expression = String(match[1]).trim();
                if (IDENTIFIER.test(expression) && !KNOWN_FUNCTIONS.includes(expression)) {
                    names.add(expression);
                }
            }
            return;
        }
        if (Array.isArray(value)) {
            value.forEach(scan);
            return;
        }
        if (isPlainObject(value)) {
            Object.values(value).forEach(scan);
        }
    };
    scan(parsed);
    return [...names];
}
