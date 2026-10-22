import {Marked} from 'marked';
import DOMPurify from 'dompurify';

// 更新说明与我们自己的文档不是一回事：它是仓库里的一段正文，长度从几行到几十行都有，
// 还可能是别人代发的。所以：
// - gfm + breaks：发行说明基本都按 GitHub 的写法写，换行就是换行；
// - 一律过 DOMPurify：这里最终是 dangerouslySetInnerHTML，不能把仓库内容当可信输入。
const marked = new Marked({gfm: true, breaks: true});

/** 把发行说明渲染成可安全注入的 HTML。 */
export function renderMarkdown(markdown: string): string {
    const html = marked.parse(markdown || '', {async: false});
    return DOMPurify.sanitize(typeof html === 'string' ? html : '');
}
