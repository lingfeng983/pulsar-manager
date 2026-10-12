/**
 * 列表筛选用的模糊匹配：空格分词，每个词都要命中；词内先按连续子串找，
 * 找不到再退到跳字子序列（"tns" 命中 "tenant-ns"）。
 *
 * 不用第三方模糊匹配库：这里要的只是"打错一个顺序也能捞到"，而库的评分排序
 * 在没有相关度可比的场景（一棵树的同名 topic 分散在多个命名空间）只会多出一层
 * 看不懂为什么这么排的顺序。
 */
export function fuzzyMatch(text: string | undefined | null, query: string): boolean {
    if (!query) {
        return true;
    }
    const haystack = (text || '').toLowerCase();
    return query
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every(token => containsAsSubsequence(haystack, token));
}

function containsAsSubsequence(haystack: string, needle: string): boolean {
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
