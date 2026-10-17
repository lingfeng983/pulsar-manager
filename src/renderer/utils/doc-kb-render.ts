import {Marked, type Tokens} from 'marked';
import DOMPurify from 'dompurify';

/**
 * 把一篇文档渲染成 HTML。
 *
 * 标题的 id 不在这儿算，而是按调用方传进来的顺序取：目录、检索命中跳转与正文锚点
 * 必须共用 parseDocMeta 那一份带 -1 后缀的 slug 表，两处各自算一份就会差一位。
 * marked 按文档顺序回调 heading，所以递增游标就能对上。
 */
export function renderDocHtml(markdown: string, ids: string[]): string {
    let order = 0;
    const marked = new Marked();
    marked.use({
        renderer: {
            heading(token: Tokens.Generic): string {
                const heading = token as Tokens.Heading;
                const id = ids[order];
                order += 1;
                const inner = this.parser.parseInline(heading.tokens);
                return id
                    ? `<h${heading.depth} id="${id}">${inner}</h${heading.depth}>`
                    : `<h${heading.depth}>${inner}</h${heading.depth}>`;
            },
        },
    });

    // id 是整个页面的导航依赖（目录与检索都靠它定位），显式保住而不是赌默认白名单。
    return DOMPurify.sanitize(marked.parse(markdown, {async: false}), {ADD_ATTR: ['id']});
}
