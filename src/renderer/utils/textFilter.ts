import type {ReactNode} from 'react';

/**
 * 全应用唯一的筛选/搜索匹配器：列表页（首页集群、命名空间 Topic、插件市场）、
 * 资源树、拓扑图、顶栏全局搜索都走这里，语义只有一套。
 *
 * 规则（纯字符串比较，明确不支持正则表达式，也不支持通配符）：
 * 1. 查询串按空白分词，每个词都必须命中，词与词之间是"与"；
 * 2. 单词先在候选串里找连续子串，找不到再退到跳字子序列（"tns" 能捞到 "tenant-ns"），
 *    这条兜底是为了"打错一个顺序也找得到"，而不是评分排序；
 * 3. 大小写不敏感。
 *
 * 结果排序不在这个函数职责里：各列表按自己的业务顺序排（拓扑按类别、树按层级），
 * 没有可比的相关度就不硬造"相似度"。
 */
export function matchesFilter(fields: readonly (string | undefined | null)[], query: string): boolean {
    const trimmed = query.trim();
    if (!trimmed) {
        return true;
    }
    const haystack = fields.filter(Boolean).join(' ').toLowerCase();
    return trimmed
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every(token => containsLoose(haystack, token));
}

function containsLoose(haystack: string, needle: string): boolean {
    if (haystack.includes(needle)) {
        return true;
    }
    let index = 0;
    for (const char of haystack) {
        if (char === needle[index]) {
            index += 1;
            if (index === needle.length) {
                return true;
            }
        }
    }
    return needle.length === 0;
}

/**
 * antd Select 的 filterOption 入口：默认实现只按单个属性做连续子串，
 * 和上面这套分词规则不一致（同一个词在下拉里搜得到、在列表里搜不到），所以下拉一律走这里。
 * label 取不到纯文本时退回 value——本项目的下拉 label 都是字符串，这条只是兜底。
 */
export function filterByLabel(input: string, option?: {label?: ReactNode; value?: string | number}): boolean {
    const label = typeof option?.label === 'string' ? option.label : undefined;
    return matchesFilter([label ?? String(option?.value ?? '')], input);
}
