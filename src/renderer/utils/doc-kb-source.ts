import {parseDocMeta, type DocHeading} from '../../shared/doc-kb';

/** 一篇内置文档：原文 + 解析出来的骨架。 */
export interface KbDoc {
    key: string;
    file: string;
    title: string;
    summary: string;
    headings: DocHeading[];
    markdown: string;
}

/**
 * 文档正文在构建时被打进渲染包（Vite 的 ?raw 导入），所以这里没有运行时读文件：
 * 生产页面走 file:// 加载，安装包里也只有 dist，读不到仓库的 docs 目录。
 *
 * 模式写死成 docs/pulsar/0*.md：docs/ 下另有数据源说明与几份本项目的设计稿，
 * 里面写着本机路径和内部方案，不该出现在发给用户的界面里。
 */
const sources = import.meta.glob<string>('../../../docs/pulsar/0*.md', {
    query: '?raw',
    import: 'default',
    eager: true,
});

export const KB_DOCS: KbDoc[] = Object.entries(sources)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, markdown]) => {
        const file = path.slice(path.lastIndexOf('/') + 1);
        const meta = parseDocMeta(markdown);
        return {
            key: file.replace(/\.md$/, ''),
            file,
            title: meta.title,
            summary: meta.summary,
            headings: meta.headings,
            markdown,
        };
    });
