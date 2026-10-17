/**
 * 内置文档中心（docs/pulsar/01–08）的解析与检索口径。
 *
 * 这层是纯函数：输入 markdown 字符串，输出目录、锚点与检索命中，不碰 fs、不碰 ipc、
 * 不依赖 marked。放在 shared 里是为了能被 scripts/doc-kb-selftest.cjs 直接 require
 * 编译产物，从而在没有渲染环境的机器上被证伪——尤其是「锚点必须对得上文档里手写的
 * 目录链接」这一条，只有拿真实文档跑一遍才知道对不对。
 */

/** 文档里出现过的标题（用于渲染目录树与正文锚点）。 */
export interface DocHeading {
    depth: number;
    text: string;
    slug: string;
}

/** 一篇文档的骨架。 */
export interface DocMeta {
    title: string;
    summary: string;
    headings: DocHeading[];
}

/** 检索用的正文段落：归属于某个最近标题（或标题之前的前言）。 */
export interface DocSection {
    heading: DocHeading | null;
    text: string;
}

/** 一次检索命中。 */
export interface DocSearchHit {
    docKey: string;
    docTitle: string;
    heading: string;
    slug: string;
    snippet: string;
    score: number;
}

/**
 * GitHub 风格的锚点：小写 → 去掉非「字母/数字/空格/-/_」的字符 → 每个空格换成一个连字符。
 *
 * 必须逐空格替换而不是把连续空白压成一个连字符：文档里「 / 」这类写法会留下两个空格，
 * GitHub 生成的是 `--`，压成单个就跳不过去（03 与 07 的目录里就有好几处）。
 * 中文属于 \p{L}，所以整串保留，不做拼音转换。
 */
export function headingSlug(input: string): string {
    const text = stripInlineMarkdown(input).trim();
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N} \-_]/gu, '')
        .replace(/ /g, '-');
}

/**
 * 标题里若带 markdown 语法，锚点取的是渲染后的文字。
 *
 * 只处理这一批文档里真实会出现的几类：链接（取文字丢 URL）、图片（整段丢）、
 * 行内代码与成对强调标记（丢符号留文字）。单个下划线不能丢：07/04 的标题里写着
 * `pulsar_env.sh`、`bookkeeper.conf` 这类真实文件名，把 `_` 当强调符号吃掉之后
 * 生成的锚点就成了 confpulsarenvshjvm，与文档目录里手写的链接差一个字符，跳不过去。
 */
export function stripInlineMarkdown(text: string): string {
    return text
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/(\*\*|__|~~|\*)/g, '');
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * 把 markdown 切成「标题 + 它下面的正文」。
 *
 * 两条约束都得写死在这里：
 * 1) 代码块内必须跳过标题识别——07 是一整份 broker.conf / bookkeeper.conf 模板，
 *    里面每行注释都以 `#` 开头，不跳过就会凭空多出上百个「标题」，目录树不可读，
 *    检索也会被这些注释行淹没。
 * 2) 一个标题只产出一个 section（标题自己就是归属者），不要把「标题行」和
 *    「它下面的正文」拆成两条都带同一个 heading；那样上层按 section 数标题时
 *    每个标题都会被数两遍，目录里就出现「1. broker.conf」「1. broker.conf-1」。
 */
export function splitSections(markdown: string): DocSection[] {
    const sections: DocSection[] = [];
    let current: DocHeading | null = null;
    let buffer: string[] = [];
    let inFence = false;
    let fenceMarker = '';

    const flush = () => {
        const text = buffer.join('\n').trim();
        if (current || text) {
            sections.push({heading: current, text});
        }
        buffer = [];
    };

    for (const line of markdown.split(/\r?\n/)) {
        const fence = line.match(FENCE);
        if (fence) {
            if (!inFence) {
                inFence = true;
                fenceMarker = fence[1][0];
            } else if (fence[1][0] === fenceMarker) {
                inFence = false;
                fenceMarker = '';
            }
            buffer.push(line);
            continue;
        }
        const heading = inFence ? null : line.match(ATX);
        if (heading) {
            flush();
            current = {depth: heading[1].length, text: heading[2], slug: headingSlug(heading[2])};
            continue;
        }
        buffer.push(line);
    }
    flush();
    return sections;
}

/**
 * 解析一篇文档的标题、摘要与目录。
 *
 * slug 同名要加 `-1`、`-2` 后缀：文档里同名小节真实存在，而 GitHub 的口径就是重复者
 * 依次加后缀；不加就会出现两个目录项跳到同一个位置。
 */
export function parseDocMeta(markdown: string): DocMeta {
    const seen = new Map<string, number>();
    const headings: DocHeading[] = [];
    let title = '';
    let summary = '';

    for (const section of splitSections(markdown)) {
        const heading = section.heading;
        if (!heading) {
            if (!summary && section.text) {
                summary = firstSummaryLine(section.text);
            }
            continue;
        }
        if (!title && heading.depth === 1) {
            title = heading.text;
        }
        if (!summary && section.text) {
            summary = firstSummaryLine(section.text);
        }
        const count = seen.get(heading.slug) || 0;
        seen.set(heading.slug, count + 1);
        headings.push({...heading, slug: count ? `${heading.slug}-${count}` : heading.slug});
    }

    return {title: title || '未命名文档', summary, headings};
}

/** 摘要取引用块的首行；正文若直接以段落开始就取那一行。 */
function firstSummaryLine(text: string): string {
    const lines = text
        .split(/\r?\n/)
        .map(line => line.replace(/^>+\s?/, '').trim())
        .filter(Boolean);
    return lines.length ? lines[0] : '';
}

/** 检索词：拉丁串按词切，中文按 2-gram 补一批，避免「积压」这种短词命中不了长句。 */
export function tokenizeQuery(query: string): string[] {
    const normalized = query.toLowerCase().trim();
    if (!normalized) {
        return [];
    }
    const words = normalized.match(/[a-z0-9_.-]+/g) || [];
    const cjk = normalized.match(/[\p{Script=Han}]{2,}/gu) || [];
    const grams: string[] = [];
    for (const run of cjk) {
        if (run.length <= 2) {
            grams.push(run);
            continue;
        }
        for (let i = 0; i + 2 <= run.length; i += 1) {
            grams.push(run.slice(i, i + 2));
        }
    }
    return Array.from(new Set([...words, ...grams, normalized])).filter(Boolean);
}

function countOccurrences(haystack: string, needle: string): number {
    if (!needle) {
        return 0;
    }
    let index = haystack.indexOf(needle);
    let count = 0;
    while (index >= 0) {
        count += 1;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}

/**
 * 跨篇检索：段落为单位打分，命中数与是否落在标题上一起决定先后。
 *
 * 只按出现次数排会让「某个参数在表格里出现 40 次」压过「这一节就在讲这个词」，
 * 所以标题命中额外加权；片段取命中所在的那一行而不是整段，正文表格一整段能有几百行，
 * 全塞进结果列表就没有可读性了。
 */
export function searchDocs(docs: {key: string; title: string; markdown: string}[], query: string): DocSearchHit[] {
    const terms = tokenizeQuery(query);
    if (!terms.length) {
        return [];
    }
    const hits: DocSearchHit[] = [];

    for (const doc of docs) {
        const sections = splitSections(doc.markdown);
        const meta = parseDocMeta(doc.markdown);
        let activeHeading: DocHeading | null = null;
        let headingOrder = 0;

        for (const section of sections) {
            if (section.heading) {
                activeHeading = section.heading;
                headingOrder += 1;
            }
            const body = section.text || (activeHeading ? activeHeading.text : '');
            if (!body) {
                continue;
            }
            const haystack = body.toLowerCase();
            const headingText = activeHeading ? activeHeading.text : doc.title;
            const lowerHeading = headingText.toLowerCase();
            let score = 0;
            const matched: string[] = [];
            for (const term of terms) {
                const inBody = countOccurrences(haystack, term);
                const inTitle = countOccurrences(lowerHeading, term);
                if (inBody || inTitle) {
                    matched.push(term);
                }
                score += inBody + inTitle * 5;
            }
            if (!matched.length) {
                continue;
            }
            // 只命中部分词的段落降权，让「每个词都出现」的那几段排在前面。
            const fullMatch = matched.length === terms.length ? 1 : 0.4;
            hits.push({
                docKey: doc.key,
                docTitle: doc.title,
                heading: headingText,
                slug: slugAt(meta, activeHeading, headingOrder),
                snippet: buildSnippet(body, terms),
                score: Math.round(score * fullMatch * 100) / 100,
            });
        }
    }

    return hits.sort((a, b) => b.score - a.score || a.docTitle.localeCompare(b.docTitle)).slice(0, 40);
}

/**
 * 把段落所属的标题映射回带去重后缀的 slug。
 *
 * splitSections 里的 heading 没有后缀信息（同名标题必须靠 parseDocMeta 的全局计数才能定名），
 * 所以命中要落到锚点上时，只能按「第几个标题」去 meta.headings 里取同一位置的项。
 */
function slugAt(meta: DocMeta, heading: DocHeading | null, order: number): string {
    if (!heading) {
        return '';
    }
    const matched = meta.headings[order - 1];
    return matched ? matched.slug : heading.slug;
}

/**
 * 把文档正文里手写的 `#锚点` 对到真实存在的 slug 上。
 *
 * 04 与 08 的目录链接只写了标题的前半段（实际标题是「2. 高危可靠性 Bug（非 CVE，
 * 重灾区：消息丢失/卡死）」，目录里写的是 `#2-高危可靠性-bug非-cve`）。这类链接在
 * GitHub 上同样是坏链。应用不打算改文档内容，所以按「唯一前缀」把它归位：
 * 只有恰好一个 slug 以它开头时才认，多个候选就放弃（宁可不跳，也不跳到错的那一节）。
 */
export function resolveAnchor(href: string, slugs: string[]): string {
    const wanted = href.replace(/^#/, '');
    if (!wanted) {
        return '';
    }
    if (slugs.includes(wanted)) {
        return wanted;
    }
    const candidates = slugs.filter(slug => slug.startsWith(wanted));
    return candidates.length === 1 ? candidates[0] : '';
}

const SNIPPET_WIDTH = 60;

/** 片段以首个命中的行为中心裁一段，前后各留 SNIPPET_WIDTH 个字符。 */
export function buildSnippet(text: string, terms: string[]): string {
    const lower = text.toLowerCase();
    let at = -1;
    for (const term of terms) {
        const index = lower.indexOf(term);
        if (index >= 0 && (at < 0 || index < at)) {
            at = index;
        }
    }
    if (at < 0) {
        return collapse(text.slice(0, SNIPPET_WIDTH * 2));
    }
    const lineStart = text.lastIndexOf('\n', at) + 1;
    const lineEnd = text.indexOf('\n', at);
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    if (line.length <= SNIPPET_WIDTH * 2) {
        return collapse(line);
    }
    const from = Math.max(0, at - lineStart - SNIPPET_WIDTH);
    return collapse(line.slice(from, at - lineStart + SNIPPET_WIDTH));
}

/** markdown 表格行读起来是一串竖线，压掉分隔符才像一句人话。 */
function collapse(line: string): string {
    const plain = line
        .replace(/\s+/g, ' ')
        .replace(/^-{2,}$/, '')
        .trim();
    return plain.length > SNIPPET_WIDTH * 2 ? `${plain.slice(0, SNIPPET_WIDTH * 2)}…` : plain;
}
