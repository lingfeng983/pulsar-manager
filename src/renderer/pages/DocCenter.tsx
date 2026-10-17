import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Alert, Button, Input, List, Space, Tag, Typography, message} from 'antd';
import {FileTextOutlined, MenuFoldOutlined, MenuUnfoldOutlined, SearchOutlined} from '@ant-design/icons';
import PageShell from '../components/common/PageShell';
import StateBlock from '../components/common/StateBlock';
import {KB_DOCS} from '../utils/doc-kb-source';
import {renderDocHtml} from '../utils/doc-kb-render';
import {resolveAnchor, searchDocs, type DocSearchHit} from '../../shared/doc-kb';

const SEARCH_TARGETS = KB_DOCS.map(doc => ({key: doc.key, title: doc.title, markdown: doc.markdown}));

// 标题按层级缩进：03/05 一篇就有 40 多个标题，不缩进时二级和三级混成一列，
// 想找回「1.2 副本与托管 Ledger」只能在长串同名文字里逐字看。20 像素是这一列
// 字号下的最小可辨差值，再小就回到「看起来一样平」。
function indent(depth: number): number {
    return 8 + (depth - 2) * 20;
}

const SIDE_MIN_WIDTH = 180;
const SIDE_MAX_WIDTH = 460;
const SIDE_DEFAULT_WIDTH = 280;

/**
 * 内置文档中心：把 docs/01–08 变成能查的东西。
 *
 * 这些文档原本只在仓库里，运维要查一个参数得离开应用去翻 markdown；而巡检报告和
 * 监控页给的数值，恰恰要靠这些参数说明才能判读。所以这一页的入口是检索而不是目录：
 * 输入「积压」或「managedLedger」，直接落到那一篇的那一节。
 */
const DocCenter: React.FC = () => {
    const [activeKey, setActiveKey] = useState(KB_DOCS[0]?.key || '');
    const [query, setQuery] = useState('');
    const [hits, setHits] = useState<DocSearchHit[]>([]);
    const [pendingSlug, setPendingSlug] = useState('');
    const [sideWidth, setSideWidth] = useState(SIDE_DEFAULT_WIDTH);
    const [sideCollapsed, setSideCollapsed] = useState(false);
    const bodyRef = useRef<HTMLDivElement>(null);

    // 拖动期间宽度只进 state，松手才结束监听：正文在 flex 里重排，逐帧改都便宜。
    // 监听挂在 window 上而不是把 pointer capture 留在把手上——拖快了指针会跑出 6 像素的
    // 把手，capture 能接住，但用户在把手外松手时也要正常结束，window 这一层更直白。
    const startResize = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            event.preventDefault();
            const startX = event.clientX;
            const startWidth = sideWidth;
            document.body.classList.add('is-doc-resizing');
            const onMove = (moveEvent: PointerEvent) => {
                const next = Math.min(
                    SIDE_MAX_WIDTH,
                    Math.max(SIDE_MIN_WIDTH, startWidth + moveEvent.clientX - startX),
                );
                setSideWidth(next);
            };
            const stop = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', stop);
                window.removeEventListener('pointercancel', stop);
                document.body.classList.remove('is-doc-resizing');
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', stop);
            window.addEventListener('pointercancel', stop);
        },
        [sideWidth],
    );

    const doc = useMemo(() => KB_DOCS.find(item => item.key === activeKey) || null, [activeKey]);

    const slugs = useMemo(() => (doc ? doc.headings.map(heading => heading.slug) : []), [doc]);

    // id 表与目录共用同一份 slug（带同名 -1 后缀），正文里每个标题按文档顺序取一个。
    const html = useMemo(() => (doc ? renderDocHtml(doc.markdown, slugs) : ''), [doc, slugs]);

    const jumpTo = useCallback((slug: string) => {
        if (!slug) {
            return;
        }
        // 用遍历而不是 querySelector('[id="..."]')：锚点里有中文、点、连字符，
        // 拼进选择器就要赌转义正确，遍历 id 不存在这个问题。
        const nodes = bodyRef.current?.querySelectorAll('h1, h2, h3, h4, h5, h6');
        const target = nodes ? Array.from(nodes).find(node => node.id === slug) : null;
        if (!target) {
            return;
        }
        target.scrollIntoView({behavior: 'smooth', block: 'start'});
        target.classList.add('doc-target-flash');
        window.setTimeout(() => target.classList.remove('doc-target-flash'), 1200);
    }, []);

    // 命中可能在另一篇：先切过去，等正文渲染完再跳，否则找不到那个标题节点。
    useEffect(() => {
        if (doc && pendingSlug) {
            setPendingSlug('');
            jumpTo(pendingSlug);
        }
    }, [doc, html, pendingSlug, jumpTo]);

    const handleSearch = useCallback((value: string) => {
        setQuery(value);
        setHits(value.trim() ? searchDocs(SEARCH_TARGETS, value) : []);
    }, []);

    const handleContentClick = useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            const anchor = (event.target as HTMLElement).closest('a');
            if (!anchor) {
                return;
            }
            const href = anchor.getAttribute('href') || '';
            if (href.startsWith('#')) {
                event.preventDefault();
                const slug = resolveAnchor(href, slugs);
                if (!slug) {
                    // 04 与 08 的目录手写了标题前半段（少了括号里的内容），这类链接
                    // 在 GitHub 上同样跳不到；唯一前缀能对上时我们已经归位了，
                    // 对不上就必须说句话，否则用户只会觉得点了没反应。
                    message.info('这一条目录链接指向的锚点在原文里对不上，请用左侧目录跳转');
                    return;
                }
                setPendingSlug(slug);
                return;
            }
            if (/^https?:\/\//i.test(href)) {
                // 主进程把 window.open 全部转交系统浏览器，并禁止页面自身导航离开；
                // 不拦的话点击会让整个应用被远程页面替换掉。
                event.preventDefault();
                window.open(href, '_blank');
            }
        },
        [slugs],
    );

    const handleOpenHit = useCallback((hit: DocSearchHit) => {
        setActiveKey(hit.docKey);
        setPendingSlug(hit.slug);
    }, []);

    if (!KB_DOCS.length) {
        return (
            <PageShell title="文档中心" subtitle="内置的 Pulsar 参数与运维文档">
                <StateBlock
                    empty
                    emptyText="应用包里没有内置文档（docs/0*.md 未随构建打入渲染包），这一页只能显示空内容"
                    height={240}
                />
            </PageShell>
        );
    }

    return (
        <PageShell
            title="文档中心"
            subtitle={`${KB_DOCS.length} 篇内置文档 · 关键词跨篇检索`}
            actions={
                <Input
                    allowClear
                    style={{width: 320}}
                    prefix={<SearchOutlined />}
                    placeholder="搜索参数、配置项或概念，回车检索"
                    value={query}
                    onChange={event => {
                        setQuery(event.target.value);
                        if (!event.target.value) {
                            setHits([]);
                        }
                    }}
                    onPressEnter={() => handleSearch(query)}
                />
            }
        >
            <div className="doc-kb-layout">
                {sideCollapsed ? (
                    <div className="doc-kb-side-collapsed">
                        <Button
                            type="text"
                            size="small"
                            icon={<MenuUnfoldOutlined />}
                            onClick={() => setSideCollapsed(false)}
                            title="展开文档列表"
                        />
                        <span className="doc-kb-side-collapsed-label">文档目录</span>
                    </div>
                ) : (
                    <>
                        <nav className="doc-kb-side" style={{width: sideWidth}}>
                            <div className="doc-kb-side-head">
                                <span>文档目录</span>
                                <Button
                                    type="text"
                                    size="small"
                                    icon={<MenuFoldOutlined />}
                                    onClick={() => setSideCollapsed(true)}
                                    title="收起文档列表"
                                />
                            </div>
                            {KB_DOCS.map(item => (
                                <div key={item.key} className="doc-kb-item">
                                    <div
                                        className={`doc-kb-item-title${item.key === activeKey ? ' is-active' : ''}`}
                                        onClick={() => setActiveKey(item.key)}
                                    >
                                        <FileTextOutlined />
                                        <span>{item.title}</span>
                                    </div>
                                    {item.key === activeKey ? (
                                        <ul className="doc-kb-toc">
                                            {item.headings
                                                .filter(heading => heading.depth >= 2 && heading.depth <= 3)
                                                .map(heading => (
                                                    <li
                                                        key={heading.slug}
                                                        style={{paddingLeft: indent(heading.depth)}}
                                                        onClick={() => jumpTo(heading.slug)}
                                                        title={heading.text}
                                                    >
                                                        {heading.text}
                                                    </li>
                                                ))}
                                        </ul>
                                    ) : null}
                                </div>
                            ))}
                        </nav>
                        <div
                            className="doc-kb-resizer"
                            role="separator"
                            aria-orientation="vertical"
                            aria-label="拖动调整文档列表宽度，双击恢复默认"
                            onPointerDown={startResize}
                            onDoubleClick={() => setSideWidth(SIDE_DEFAULT_WIDTH)}
                        />
                    </>
                )}

                <div className="doc-kb-main">
                    {query && hits.length ? (
                        <List
                            className="doc-kb-hits"
                            size="small"
                            header={
                                <Typography.Text type="secondary">
                                    「{query}」命中 {hits.length} 处，按相关度排序
                                </Typography.Text>
                            }
                            dataSource={hits}
                            renderItem={hit => (
                                <List.Item onClick={() => handleOpenHit(hit)} style={{cursor: 'pointer'}}>
                                    <Space direction="vertical" size={2} style={{width: '100%'}}>
                                        <Space size={6} wrap>
                                            <Tag color="blue">{hit.docTitle}</Tag>
                                            <Typography.Text strong>{hit.heading}</Typography.Text>
                                            <Typography.Text type="secondary">相关度 {hit.score}</Typography.Text>
                                        </Space>
                                        <Typography.Text type="secondary" ellipsis>
                                            {hit.snippet}
                                        </Typography.Text>
                                    </Space>
                                </List.Item>
                            )}
                        />
                    ) : null}
                    {query && !hits.length ? (
                        <Alert
                            type="info"
                            showIcon
                            message={`「${query}」在 ${KB_DOCS.length} 篇文档里没有找到`}
                            description="配置项名建议用英文原文（如 managedLedgerDefaultEnsembleSize），中文按整句搜也容易落空。"
                        />
                    ) : null}

                    {doc ? (
                        <>
                            <div className="doc-kb-doc-head">
                                <Typography.Title level={4} style={{margin: 0}}>
                                    {doc.title}
                                </Typography.Title>
                                {doc.summary ? <Typography.Text type="secondary">{doc.summary}</Typography.Text> : null}
                                <Typography.Text type="secondary">{doc.file}</Typography.Text>
                            </div>
                            <div ref={bodyRef} className="doc-kb-body" onClick={handleContentClick}>
                                <div dangerouslySetInnerHTML={{__html: html}} />
                            </div>
                        </>
                    ) : null}
                </div>
            </div>
        </PageShell>
    );
};

export default DocCenter;
