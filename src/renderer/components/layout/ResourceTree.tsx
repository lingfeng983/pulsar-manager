import React, {useState, useEffect, useCallback, useMemo, useRef} from 'react';
import {Tree, Button, Space, Spin, message, Input} from 'antd';
import type {DataNode} from 'antd/es/tree';
import {
    ClusterOutlined,
    FolderOutlined,
    DatabaseOutlined,
    TableOutlined,
    MenuFoldOutlined,
    BarChartOutlined,
    ApartmentOutlined,
    EyeOutlined,
    DeleteOutlined,
    PlusOutlined,
    EditOutlined,
    SendOutlined,
    DownloadOutlined,
    SearchOutlined,
} from '@ant-design/icons';
import {useClusterStore} from '../../store/cluster';
import {useTabStore} from '../../store/tabs';
import {
    loadTenants,
    loadNamespaces,
    loadTopics,
    invalidateResourceCache,
    invalidateTenants,
    invalidateNamespaces,
    invalidateTopics,
    invalidateTopicStats,
    onResourceCacheInvalidated,
    type ResourceChangeTarget,
} from '../../hooks/resourceCache';
import {shortName} from '../../utils/format';
import {fuzzyMatch} from '../../utils/fuzzyMatch';
import {topicTab, tenantTab, namespaceTab, topologyTab, metricsTab, producerTab, consumerTab} from '../../utils/tabIds';
import {useCommand} from '../../hooks/useKeybindings';
import TenantFormModal from '../tenant/TenantFormModal';
import TopicFormModal from '../topic/TopicFormModal';
import ContextMenu, {clampMenuPosition, type ContextMenuItem} from '../common/ContextMenu';
import StateBlock from '../common/StateBlock';
import IconButton from '../common/IconButton';
import {useConfirmDanger, themedModal} from '../common/dangerConfirm';
import type {Tenant, Topic} from '../../types';

interface ResourceTreeNode extends DataNode {
    dataRef?: {
        type: 'cluster' | 'tenant' | 'namespace' | 'topic';
        clusterId?: string;
        tenant?: string;
        namespace?: string;
        topic?: string;
        persistent?: boolean;
        cluster?: any;
    };
}

const SIDEBAR_MIN_WIDTH = 160;
const SIDEBAR_MAX_WIDTH = 640;
const SIDEBAR_WIDTH_KEY = 'pulsar-manager.sidebar-width';
// 折叠态只放一个图标按钮
const SIDEBAR_COLLAPSED_WIDTH = 40;
// 集群状态探活整个应用只自动跑一次：StrictMode 会把挂载走两遍，侧边栏也不会因为
// 切页签重新挂载，所以用模块级标记而不是组件 ref。手动点刷新图标不受它限制。
let statusProbed = false;

// 节点菜单最长的一支（集群：查看/拓扑/监控/分隔/新建租户/分隔/删除）用于定位时估算高度
const MAX_MENU_ITEMS = 7;

const clampSidebarWidth = (w: number) => Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, w));

// 状态色点已经表达了在线/警告/离线，文字只留给悬停提示与读屏
const CLUSTER_STATUS_LABEL: Record<string, string> = {
    connected: '在线',
    warning: '警告',
    disconnected: '离线',
};

const clusterStatusLabel = (status?: string) => CLUSTER_STATUS_LABEL[status ?? ''] ?? '未知';

/** 该节点是否已在当前树中（即其父分支展开过）。 */
function containsNodeKey(nodes: DataNode[], key: React.Key): boolean {
    for (const node of nodes) {
        if (node.key === key) {
            return true;
        }
        if (node.children && containsNodeKey(node.children, key)) {
            return true;
        }
    }
    return false;
}

const ResourceTree: React.FC = () => {
    const [collapsed, setCollapsed] = useState(false);
    const [sidebarWidth, setSidebarWidth] = useState(() => {
        const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
        return saved >= SIDEBAR_MIN_WIDTH && saved <= SIDEBAR_MAX_WIDTH ? saved : 240;
    });
    const [resizing, setResizing] = useState(false);
    const sidebarWidthRef = useRef(sidebarWidth);
    sidebarWidthRef.current = sidebarWidth;
    const [loading, setLoading] = useState(false);
    const [treeData, setTreeData] = useState<DataNode[]>([]);
    const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
    // 供刷新回调读取最新树/展开状态，避免把 state 闭包进 useCallback 依赖里
    const treeDataRef = useRef<DataNode[]>([]);
    treeDataRef.current = treeData;
    const expandedKeysRef = useRef<React.Key[]>([]);
    expandedKeysRef.current = expandedKeys;
    // 每个节点 key 的加载代次，用于丢弃迟到的旧响应
    const reloadEpochRef = useRef(new Map<string, number>());
    const [contextMenu, setContextMenu] = useState<{x: number; y: number; node: ResourceTreeNode | null} | null>(null);
    const {clusters, fetchClusters, refreshClusterStatus, setActiveCluster, deleteClusterAsync, expandedClusterId} =
        useClusterStore();
    const {addTab} = useTabStore();
    const confirmDanger = useConfirmDanger();
    // 键盘打开菜单时用得上：右键有 node，纯键盘只有"最后一次选中的节点"
    const activeNodeRef = useRef<ResourceTreeNode | null>(null);
    const [tenantForm, setTenantForm] = useState<{
        open: boolean;
        mode: 'create' | 'edit';
        clusterId: string;
        tenant?: string;
        initial?: {adminRoles: string[]; allowedClusters: string[]};
    }>({open: false, mode: 'create', clusterId: ''});
    const [topicForm, setTopicForm] = useState<{
        open: boolean;
        clusterId: string;
        tenant: string;
        namespace: string;
    }>({open: false, clusterId: '', tenant: '', namespace: ''});

    // 主题名筛选：只对 topic 叶子生效，父级节点按"有没有留下东西"决定去留。
    const [topicFilter, setTopicFilter] = useState('');
    // 这一轮筛选里已经补拉过 topic 清单的命名空间，防止键入过程中反复自重发请求。
    const filterLoadedRef = useRef<{query: string; done: Set<string>}>({query: '', done: new Set()});
    // 进入筛选前的展开状态，清空筛选要还回去
    const preFilterExpandedRef = useRef<React.Key[] | null>(null);

    // 将集群转换为树节点
    const clusterToTreeData = useMemo(() => {
        return clusters.map(cluster => {
            const label = clusterStatusLabel(cluster.status);
            return {
                title: (
                    <Space size={4}>
                        <ClusterOutlined style={{color: 'var(--color-primary)'}} />
                        <span>{cluster.name}</span>
                        <span
                            className={`tree-status tree-status-${cluster.status ?? 'disconnected'}`}
                            role="img"
                            aria-label={`集群状态：${label}`}
                            title={label}
                        >
                            <span className="tree-status-dot" aria-hidden />
                        </span>
                    </Space>
                ),
                key: `cluster-${cluster.id}`,
                dataRef: {type: 'cluster' as const, clusterId: cluster.id, cluster},
                children: [],
                isLeaf: false,
            };
        });
    }, [clusters]);

    // 加载指定节点的子节点（带缓存）。失败返回 null —— 调用方据此保留原有子树，
    // 返回 [] 会把"请求失败"渲染成"这个分支本来就是空的"。
    const loadTreeNodeData = useCallback(async (node: ResourceTreeNode): Promise<DataNode[] | null> => {
        const dataRef = node.dataRef;
        if (!dataRef) return [];

        const {type, clusterId, tenant, namespace} = dataRef;

        try {
            if (type === 'cluster' && clusterId) {
                const tenants = await loadTenants(clusterId);
                return tenants.map((t: Tenant) => ({
                    title: (
                        <Space size={4}>
                            <FolderOutlined />
                            <span>{t.name}</span>
                        </Space>
                    ),
                    key: `tenant-${clusterId}-${t.name}`,
                    dataRef: {type: 'tenant' as const, clusterId, tenant: t.name},
                    children: [],
                    isLeaf: false,
                }));
            } else if (type === 'tenant' && clusterId && tenant) {
                const namespaces = await loadNamespaces(clusterId, tenant);
                return namespaces.map((ns: string) => ({
                    title: (
                        <Space size={4}>
                            <DatabaseOutlined />
                            <span>{ns}</span>
                        </Space>
                    ),
                    key: `ns-${clusterId}-${tenant}-${ns}`,
                    dataRef: {type: 'namespace' as const, clusterId, tenant, namespace: ns},
                    children: [],
                    isLeaf: false,
                }));
            } else if (type === 'namespace' && clusterId && tenant && namespace) {
                const topics = await loadTopics(clusterId, tenant, namespace);
                return topics.map((topic: Topic) => {
                    const topicName = shortName(topic.name);
                    return {
                        title: (
                            <Space size={4}>
                                <TableOutlined />
                                <span style={{fontSize: 'var(--font-size-xs)'}}>{topicName}</span>
                            </Space>
                        ),
                        // persistent 与 non-persistent 同名 topic 是两行，键里必须带 scheme，
                        // 否则 React 撞 key（渲染错乱）且第 488 行的按前缀清理会连带误伤
                        key: `topic-${clusterId}-${tenant}-${namespace}-${topic.persistent ? 'p' : 'n'}-${topicName}`,
                        dataRef: {
                            type: 'topic' as const,
                            clusterId,
                            tenant,
                            namespace,
                            topic: topicName,
                            persistent: topic.persistent,
                        },
                        isLeaf: true,
                    };
                });
            }
        } catch (error) {
            console.error('Failed to load tree node data:', error);
            message.error('加载资源失败');
            return null;
        }

        // 未知节点类型：确实没有子节点，按空处理而不是失败
        return [];
    }, []);

    // 重载某个节点后，用新列表替换旧列表；同名节点已经加载的下级子树必须原样保留。
    // 否则"刷新"会按展开顺序连带重读父层（集群→租户），新拉出来的租户节点 children
    // 为空，把用户已经展开的命名空间/topic 分支整个打回空壳。
    const mergeChildNodes = useCallback(
        (prevChildren: DataNode[] | undefined, nextChildren: DataNode[]): DataNode[] => {
            if (!prevChildren || prevChildren.length === 0) {
                return nextChildren;
            }
            const prevByKey = new Map(prevChildren.map(n => [n.key, n]));
            return nextChildren.map(n => {
                const prevNode = prevByKey.get(n.key);
                return prevNode && prevNode.children && prevNode.children.length > 0
                    ? {...n, children: prevNode.children}
                    : n;
            });
        },
        [],
    );

    // 变更后重新读取某个节点的子节点。handleLoadData 会跳过"已有子节点"的节点，
    // 所以增删改之后必须走这个强制重载，否则树会一直显示旧列表。
    // 每个节点各记一个代次：连续两次增删（例如建完立刻删）时，先发出的慢响应
    // 回来不能把后一次的结果盖掉。
    const reloadNodeChildren = useCallback(
        async (node: ResourceTreeNode) => {
            if (!node.dataRef) return;
            const key = String(node.key);
            const epoch = (reloadEpochRef.current.get(key) ?? 0) + 1;
            reloadEpochRef.current.set(key, epoch);
            const children = await loadTreeNodeData(node);
            if (children === null || reloadEpochRef.current.get(key) !== epoch) {
                return;
            }
            setTreeData(prev => {
                const update = (nodes: DataNode[]): DataNode[] =>
                    nodes.map(n => {
                        if (n.key === node.key) {
                            return {...n, children: mergeChildNodes(n.children, children)};
                        }
                        if (n.children) {
                            return {...n, children: update(n.children)};
                        }
                        return n;
                    });
                return update(prev);
            });
        },
        [loadTreeNodeData, mergeChildNodes],
    );

    // 增删改之后要重载的是"父节点"，这里按 key 约定合成父节点，
    // 不必先在 treeData 里把它找出来。
    const clusterNode = (clusterId: string): ResourceTreeNode => ({
        key: `cluster-${clusterId}`,
        dataRef: {type: 'cluster', clusterId},
    });

    const tenantNode = (clusterId: string, tenant: string): ResourceTreeNode => ({
        key: `tenant-${clusterId}-${tenant}`,
        dataRef: {type: 'tenant', clusterId, tenant},
    });

    const namespaceNode = (clusterId: string, tenant: string, namespace: string): ResourceTreeNode => ({
        key: `ns-${clusterId}-${tenant}-${namespace}`,
        dataRef: {type: 'namespace', clusterId, tenant, namespace},
    });

    // 筛选只按 topic 叶子的名字裁；父级节点自己命中就整支留下（搜 "prod" 的人想要的
    // 就是那套环境下面所有 topic），否则按有没有幸存子节点决定去留。
    const visibleTreeData = useMemo(() => {
        const query = topicFilter.trim();
        if (!query) {
            return treeData;
        }
        const filterNodes = (nodes: DataNode[]): DataNode[] => {
            const kept: DataNode[] = [];
            for (const node of nodes) {
                const ref = (node as ResourceTreeNode).dataRef;
                if (ref?.type === 'topic') {
                    if (fuzzyMatch(ref.topic, query)) {
                        kept.push(node);
                    }
                    continue;
                }
                const ownName =
                    ref?.type === 'namespace'
                        ? ref.namespace
                        : ref?.type === 'tenant'
                          ? ref.tenant
                          : String(ref?.cluster?.name ?? '');
                if (fuzzyMatch(ownName, query)) {
                    kept.push(node);
                    continue;
                }
                const children = node.children ? filterNodes(node.children) : [];
                if (children.length > 0) {
                    kept.push({...node, children});
                    continue;
                }
                // 还没加载过子节点的分支没有清单可筛，留着才能继续展开下钻
                if (!node.children || node.children.length === 0) {
                    kept.push(node);
                }
            }
            return kept;
        };
        return filterNodes(treeData);
    }, [treeData, topicFilter]);

    // 展开 effect 需要读最新筛选树但不希望被它的每次增量变化重新触发，故走 ref。
    const visibleTreeDataRef = useRef<DataNode[]>([]);
    visibleTreeDataRef.current = visibleTreeData;

    const matchedTopicCount = useMemo(() => {
        if (!topicFilter.trim()) {
            return 0;
        }
        const count = (nodes: DataNode[]): number =>
            nodes.reduce(
                (sum, node) =>
                    sum +
                    ((node as ResourceTreeNode).dataRef?.type === 'topic' ? 1 : 0) +
                    (node.children ? count(node.children) : 0),
                0,
            );
        return count(visibleTreeData);
    }, [visibleTreeData, topicFilter]);

    // 节点是懒加载的：没展开过的命名空间手上根本没有 topic 清单可筛。一开始输入就把
    // 树里已有的命名空间补齐（走 resourceCache，命中缓存时不发请求），否则
    // "只有展开过的分支才筛得出来"读起来就像筛选坏了。
    useEffect(() => {
        const query = topicFilter.trim();
        if (!query) {
            filterLoadedRef.current = {query: '', done: new Set()};
            return;
        }
        if (filterLoadedRef.current.query !== query) {
            filterLoadedRef.current = {query, done: new Set()};
        }
        const visited = filterLoadedRef.current.done;
        const targets: ResourceTreeNode[] = [];
        const collect = (nodes: DataNode[]) => {
            for (const node of nodes) {
                if ((node as ResourceTreeNode).dataRef?.type === 'namespace' && !visited.has(String(node.key))) {
                    targets.push(node as ResourceTreeNode);
                }
                if (node.children) {
                    collect(node.children);
                }
            }
        };
        collect(treeData);
        if (targets.length === 0) {
            return;
        }
        let cancelled = false;
        const pool = [...targets];
        const worker = async () => {
            while (!cancelled && pool.length > 0) {
                const node = pool.shift();
                if (!node) {
                    break;
                }
                // 先记再拉：补拉会写 treeData，本效果随之重跑，不占住这个坑就会自己转圈
                visited.add(String(node.key));
                await reloadNodeChildren(node);
            }
        };
        void Promise.all(Array.from({length: Math.min(6, pool.length)}, worker));
        return () => {
            cancelled = true;
        };
    }, [topicFilter, treeData, reloadNodeChildren]);

    // 命中项要一眼看见：进入筛选就展开全部幸存分支，清空时还原本来的展开状态。
    // 只在 query 变化时展开一次，而不是每次 visibleTreeData 增量更新都重放——否则
    // 补拉命名空间/筛选期树变化会把用户中途手动折叠的分支又重新展开。
    useEffect(() => {
        const query = topicFilter.trim();
        if (!query) {
            if (preFilterExpandedRef.current) {
                setExpandedKeys(preFilterExpandedRef.current);
                preFilterExpandedRef.current = null;
            }
            return;
        }
        if (!preFilterExpandedRef.current) {
            preFilterExpandedRef.current = expandedKeysRef.current;
        }
        const keys: React.Key[] = [];
        const collect = (nodes: DataNode[]) => {
            for (const node of nodes) {
                if (node.children && node.children.length > 0) {
                    keys.push(node.key);
                    collect(node.children);
                }
            }
        };
        collect(visibleTreeDataRef.current);
        setExpandedKeys(keys);
    }, [topicFilter]);

    // 订阅缓存失效事件：别的页面（Topic 详情页删 Topic、命名空间页建 Topic）改完
    // 数据只清缓存，而本组件把子节点存在自己的 treeData 里，不重读就永远显示旧列表。
    // 只有已在树里的分支才值得重载，未展开的节点交给下一次 handleLoadData。
    useEffect(() => {
        // 树里只有集群/租户/命名空间/topic 四层，统计类失效（topicStats）没有对应分支，
        // 显式返回 null 而不是落进兜底分支错重载命名空间。
        const nodeForTarget = (target: ResourceChangeTarget): ResourceTreeNode | null => {
            switch (target.kind) {
                case 'tenants':
                    return clusterNode(target.clusterId);
                case 'namespaces':
                    return tenantNode(target.clusterId, target.tenant);
                case 'topics':
                    return namespaceNode(target.clusterId, target.tenant, target.namespace);
                default:
                    return null;
            }
        };

        return onResourceCacheInvalidated(target => {
            const node = nodeForTarget(target);
            if (node && containsNodeKey(treeDataRef.current, node.key)) {
                void reloadNodeChildren(node);
            }
        });
    }, [reloadNodeChildren]);

    // 初始加载 / 集群列表变化时增量合并：整体替换会把已加载的租户/命名空间/
    // topic 子树全部丢掉，任何一次集群状态刷新都让展开的分支被打回空壳。
    // 这里只增删集群根节点、更新其标题与状态徽标，展开节点的 children 原样保留。
    useEffect(() => {
        const existingByKey = new Map(treeDataRef.current.map(n => [n.key, n]));
        const next = clusterToTreeData.map(entry => {
            const existing = existingByKey.get(entry.key);
            return existing ? {...entry, children: existing.children} : entry;
        });
        setTreeData(next);
        // 集群移除后，它名下所有节点的加载代次键都失去意义：reloadEpochRef 是只增不减
        // 的 Map，不清就会在长时间多集群会话里无界增长。按当前树仍存在的集群前缀清掉。
        const liveIds = next.map(entry => String(entry.key).slice('cluster-'.length));
        for (const key of reloadEpochRef.current.keys()) {
            const belongs = liveIds.some(
                id =>
                    key === `cluster-${id}` ||
                    key.startsWith(`tenant-${id}-`) ||
                    key.startsWith(`ns-${id}-`) ||
                    key.startsWith(`topic-${id}-`),
            );
            if (!belongs) {
                reloadEpochRef.current.delete(key);
            }
        }
        // 集群被删掉后，展开列表里会留下它的 key（以及它下面的租户/命名空间）；
        // 本地的 expandedKeys 不会自己收缩，顺手把树里已经不存在的 key 丢掉。
        setExpandedKeys(keys => {
            const kept = keys.filter(key => containsNodeKey(next, key));
            return kept.length === keys.length ? keys : kept;
        });
    }, [clusterToTreeData]);

    // 首屏自动探活：树里的状态徽标读的是落库列，不探的话上次退出时"在线"的集群
    // 会一直绿着。探活在后台跑，回来的时候由 store 更新 clusters 触发本组件重渲染。
    useEffect(() => {
        if (statusProbed) {
            return;
        }
        statusProbed = true;
        void refreshClusterStatus();
    }, [refreshClusterStatus]);

    // 响应集群展开事件
    useEffect(() => {
        if (expandedClusterId) {
            const clusterKey = `cluster-${expandedClusterId}`;
            setExpandedKeys(prev => {
                if (!prev.includes(clusterKey)) {
                    return [...prev, clusterKey];
                }
                return prev;
            });
        }
    }, [expandedClusterId]);

    // 处理树节点展开
    const handleExpand = useCallback((expandedKeysValue: React.Key[]) => {
        setExpandedKeys(expandedKeysValue);
    }, []);

    // 处理树节点加载数据
    const handleLoadData = useCallback(
        async (node: ResourceTreeNode) => {
            // 检查是否已有子节点
            if ((node?.children?.length ?? 0) > 0) return;

            const key = String(node.key);
            const epoch = (reloadEpochRef.current.get(key) ?? 0) + 1;
            reloadEpochRef.current.set(key, epoch);
            const children = await loadTreeNodeData(node);
            if (children === null || reloadEpochRef.current.get(key) !== epoch) {
                return;
            }
            setTreeData(prev => {
                const updateNode = (nodes: DataNode[]): DataNode[] => {
                    return nodes.map(n => {
                        if (n.key === node.key) {
                            return {...n, children};
                        }
                        if (n.children) {
                            return {...n, children: updateNode(n.children)};
                        }
                        return n;
                    });
                };
                return updateNode(prev);
            });
        },
        [loadTreeNodeData],
    );

    // 处理节点选择
    const handleSelect = useCallback(
        (keys: React.Key[], info: any) => {
            if (keys.length === 0) return;

            const selectedNode = info.node as ResourceTreeNode;
            const dataRef = selectedNode.dataRef;
            // 键盘入口要用最近选中的节点：Tree 渲染的 DOM 上没有节点 key，
            // 只有这里能拿到 React 侧完整的 dataRef。
            activeNodeRef.current = selectedNode;

            if (dataRef?.type === 'cluster') {
                setActiveCluster(dataRef.clusterId ?? null);
            } else if (dataRef?.type === 'topic') {
                addTab(
                    topicTab({
                        clusterId: dataRef.clusterId ?? '',
                        tenant: dataRef.tenant ?? '',
                        namespace: dataRef.namespace ?? '',
                        topic: dataRef.topic ?? '',
                        persistent: dataRef.persistent,
                    }),
                );
            } else if (dataRef?.type === 'tenant') {
                addTab(tenantTab(dataRef.clusterId ?? '', dataRef.tenant ?? ''));
            } else if (dataRef?.type === 'namespace') {
                addTab(namespaceTab(dataRef.clusterId ?? '', dataRef.tenant ?? '', dataRef.namespace ?? ''));
            }
        },
        [setActiveCluster, addTab],
    );

    // 右键菜单处理
    const handleContextMenu = useCallback((e: React.MouseEvent, node: DataNode) => {
        e.preventDefault();
        // 菜单锚定视口（树在滚动容器里，客户端坐标最稳），越界向内收
        const pos = clampMenuPosition(
            e.clientX,
            e.clientY,
            {width: window.innerWidth, height: window.innerHeight},
            MAX_MENU_ITEMS,
        );
        setContextMenu({x: pos.x, y: pos.y, node: node as ResourceTreeNode});
    }, []);

    // ContextMenu 键 / Shift+F10 的键盘等价入口：对最近选中的节点展开同一份菜单
    const handleTreeKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) {
            return;
        }
        const node = activeNodeRef.current;
        if (!node) {
            return;
        }
        e.preventDefault();
        const focusedRect = (document.activeElement as HTMLElement | null)?.getBoundingClientRect?.();
        const pos = clampMenuPosition(
            focusedRect?.left ?? 24,
            (focusedRect?.bottom ?? 120) + 4,
            {width: window.innerWidth, height: window.innerHeight},
            MAX_MENU_ITEMS,
        );
        setContextMenu({x: pos.x, y: pos.y, node});
    }, []);

    // 关闭右键菜单
    const closeContextMenu = useCallback(() => {
        setContextMenu(null);
    }, []);

    // 右键菜单操作
    // 命名空间只需要一个名字，用轻量确认框即可，不必再做一个表单组件。
    // 走 themedModal 而不是静态 Modal.confirm：静态弹窗不读 ConfigProvider，暗色下是亮块。
    const promptCreateNamespace = useCallback(
        (clusterId: string, tenant: string) => {
            const modal = themedModal();
            if (!modal) {
                return;
            }
            let draft = '';
            modal.confirm({
                title: `新建命名空间（${tenant}）`,
                icon: null,
                content: (
                    <Input
                        autoFocus
                        placeholder="命名空间名"
                        onChange={e => {
                            draft = e.target.value;
                        }}
                    />
                ),
                okText: '创建',
                cancelText: '取消',
                onOk: async () => {
                    const name = draft.trim();
                    if (!name) {
                        message.warning('请输入命名空间名');
                        return Promise.reject(new Error('name required'));
                    }
                    const response = await window.electronAPI.resources.createNamespace(clusterId, tenant, name);
                    if (!response.success) {
                        message.error(response.error || '创建失败');
                        return Promise.reject(new Error('create failed'));
                    }
                    message.success('命名空间已创建');
                    invalidateNamespaces(clusterId, tenant);
                    const parentKey = `tenant-${clusterId}-${tenant}`;
                    setExpandedKeys(prev => (prev.includes(parentKey) ? prev : [...prev, parentKey]));
                    await reloadNodeChildren(tenantNode(clusterId, tenant));
                },
            });
        },
        [reloadNodeChildren],
    );

    const handleContextMenuAction = useCallback(
        async (action: string, node: ResourceTreeNode) => {
            const dataRef = node.dataRef;

            switch (action) {
                case 'view':
                    if (dataRef?.type === 'topic') {
                        addTab(
                            topicTab({
                                clusterId: dataRef.clusterId ?? '',
                                tenant: dataRef.tenant ?? '',
                                namespace: dataRef.namespace ?? '',
                                topic: dataRef.topic ?? '',
                                persistent: dataRef.persistent,
                            }),
                        );
                    } else if (dataRef?.type === 'tenant') {
                        addTab(tenantTab(dataRef.clusterId ?? '', dataRef.tenant ?? ''));
                    } else if (dataRef?.type === 'namespace') {
                        addTab(namespaceTab(dataRef.clusterId ?? '', dataRef.tenant ?? '', dataRef.namespace ?? ''));
                    } else if (dataRef?.type === 'cluster') {
                        setActiveCluster(dataRef.clusterId ?? '');
                    }
                    break;
                case 'producer':
                    if (dataRef?.type === 'topic') {
                        addTab(
                            producerTab({
                                clusterId: dataRef.clusterId ?? '',
                                tenant: dataRef.tenant ?? '',
                                namespace: dataRef.namespace ?? '',
                                topic: dataRef.topic ?? '',
                                persistent: dataRef.persistent,
                            }),
                        );
                    }
                    break;
                case 'consumer':
                    if (dataRef?.type === 'topic') {
                        addTab(
                            consumerTab({
                                clusterId: dataRef.clusterId ?? '',
                                tenant: dataRef.tenant ?? '',
                                namespace: dataRef.namespace ?? '',
                                topic: dataRef.topic ?? '',
                                persistent: dataRef.persistent,
                            }),
                        );
                    }
                    break;
                case 'topology':
                    if (dataRef?.type === 'cluster') {
                        addTab(topologyTab(dataRef.clusterId ?? '', dataRef.cluster?.name));
                    }
                    break;
                case 'metrics':
                    if (dataRef?.type === 'cluster') {
                        addTab(metricsTab(dataRef.clusterId, dataRef.cluster?.name));
                    } else if (dataRef?.type === 'topic') {
                        addTab(
                            topicTab({
                                clusterId: dataRef.clusterId ?? '',
                                tenant: dataRef.tenant ?? '',
                                namespace: dataRef.namespace ?? '',
                                topic: dataRef.topic ?? '',
                                persistent: dataRef.persistent,
                            }),
                        );
                    }
                    break;
                case 'delete':
                    if (dataRef?.type === 'cluster') {
                        const {clusterId} = dataRef;
                        const clusterName = dataRef.cluster?.name || dataRef.clusterId;
                        confirmDanger({
                            title: '删除集群',
                            description: `删除本机保存的集群「${clusterName}」配置及其连接信息。`,
                            requireExactName: clusterName,
                            onOk: async () => {
                                if (!clusterId || !(await deleteClusterAsync(clusterId))) {
                                    throw new Error('删除集群失败');
                                }
                                message.success('删除成功');
                            },
                        });
                    } else if (dataRef?.type === 'tenant' && dataRef.clusterId && dataRef.tenant) {
                        const {clusterId, tenant} = dataRef;
                        confirmDanger({
                            title: '删除租户',
                            description: `删除租户 "${tenant}"。broker 会拒绝删除仍包含命名空间的租户。`,
                            requireExactName: tenant,
                            onOk: async () => {
                                const response = await window.electronAPI.resources.deleteTenant(clusterId, tenant);
                                if (!response.success) {
                                    throw new Error(response.error || '删除失败');
                                }
                                message.success('租户已删除');
                                invalidateTenants(clusterId);
                                await reloadNodeChildren(clusterNode(clusterId));
                            },
                        });
                    } else if (
                        dataRef?.type === 'namespace' &&
                        dataRef.clusterId &&
                        dataRef.tenant &&
                        dataRef.namespace
                    ) {
                        const {clusterId, tenant, namespace} = dataRef;
                        confirmDanger({
                            title: '删除命名空间',
                            description: `删除 "${tenant}/${namespace}" 会同时删除其中所有 Topic，且不可恢复。`,
                            requireExactName: namespace,
                            onOk: async () => {
                                const response = await window.electronAPI.resources.deleteNamespace(
                                    clusterId,
                                    tenant,
                                    namespace,
                                );
                                if (!response.success) {
                                    throw new Error(response.error || '删除失败');
                                }
                                message.success('命名空间已删除');
                                invalidateNamespaces(clusterId, tenant);
                                invalidateTopics(clusterId, tenant, namespace);
                                await reloadNodeChildren(tenantNode(clusterId, tenant));
                            },
                        });
                    } else if (dataRef?.type === 'topic' && dataRef.clusterId && dataRef.tenant && dataRef.namespace) {
                        const {clusterId, tenant, namespace, topic, persistent} = dataRef;
                        confirmDanger({
                            title: '删除 Topic',
                            description: `删除 "${tenant}/${namespace}/${topic}" 会丢弃其全部消息与订阅游标，不可恢复。`,
                            requireExactName: topic ?? '',
                            onOk: async () => {
                                const response = await window.electronAPI.resources.deleteTopic(
                                    clusterId,
                                    tenant,
                                    namespace,
                                    topic ?? '',
                                    persistent,
                                );
                                if (!response.success) {
                                    throw new Error(response.error || '删除失败');
                                }
                                message.success('Topic 已删除');
                                invalidateTopics(clusterId, tenant, namespace);
                                invalidateTopicStats(clusterId, tenant, namespace, topic ?? '');
                                await reloadNodeChildren(namespaceNode(clusterId, tenant, namespace));
                            },
                        });
                    }
                    break;
                case 'createTenant':
                    if (dataRef?.clusterId) {
                        setTenantForm({open: true, mode: 'create', clusterId: dataRef.clusterId});
                    }
                    break;
                case 'editTenant':
                    if (dataRef?.clusterId && dataRef.tenant) {
                        const {clusterId, tenant} = dataRef;
                        const response = await window.electronAPI.resources.getTenantInfo(clusterId, tenant);
                        if (!response.success || !response.data) {
                            message.error(response.error || '读取租户信息失败');
                            return;
                        }
                        setTenantForm({
                            open: true,
                            mode: 'edit',
                            clusterId,
                            tenant,
                            initial: {
                                adminRoles: response.data.adminRoles ?? [],
                                allowedClusters: response.data.allowedClusters ?? [],
                            },
                        });
                    }
                    break;
                case 'createNamespace':
                    if (dataRef?.clusterId && dataRef.tenant) {
                        promptCreateNamespace(dataRef.clusterId, dataRef.tenant);
                    }
                    break;
                case 'createTopic':
                    if (dataRef?.clusterId && dataRef.tenant && dataRef.namespace) {
                        setTopicForm({
                            open: true,
                            clusterId: dataRef.clusterId,
                            tenant: dataRef.tenant,
                            namespace: dataRef.namespace,
                        });
                    }
                    break;
            }
            closeContextMenu();
        },
        [
            addTab,
            setActiveCluster,
            deleteClusterAsync,
            closeContextMenu,
            reloadNodeChildren,
            promptCreateNamespace,
            confirmDanger,
        ],
    );

    // 构建右键菜单（共享 ContextMenu：视觉走 CSS token，方向键/Enter/Esc 键盘可操作）
    const contextMenuItems = useMemo<ContextMenuItem[]>(() => {
        const node = contextMenu?.node;
        if (!node) return [];

        const dataRef = node.dataRef;
        const run = (action: string) => () => {
            void handleContextMenuAction(action, node);
        };

        const baseItems: ContextMenuItem[] = [
            {key: 'view', label: '查看详情', icon: <EyeOutlined />, onSelect: run('view')},
        ];

        if (dataRef?.type === 'cluster') {
            return [
                ...baseItems,
                {key: 'topology', label: '查看拓扑', icon: <ApartmentOutlined />, onSelect: run('topology')},
                {key: 'metrics', label: '查看监控', icon: <BarChartOutlined />, onSelect: run('metrics')},
                {key: 'sep-1', separator: true},
                {key: 'createTenant', label: '新建租户', icon: <PlusOutlined />, onSelect: run('createTenant')},
                {key: 'sep-2', separator: true},
                {
                    key: 'delete',
                    label: '删除集群',
                    icon: <DeleteOutlined />,
                    danger: true,
                    onSelect: run('delete'),
                },
            ];
        }

        if (dataRef?.type === 'tenant') {
            return [
                ...baseItems,
                {
                    key: 'createNamespace',
                    label: '新建命名空间',
                    icon: <PlusOutlined />,
                    onSelect: run('createNamespace'),
                },
                {key: 'editTenant', label: '编辑租户', icon: <EditOutlined />, onSelect: run('editTenant')},
                {key: 'sep-1', separator: true},
                {
                    key: 'delete',
                    label: '删除租户',
                    icon: <DeleteOutlined />,
                    danger: true,
                    onSelect: run('delete'),
                },
            ];
        }

        if (dataRef?.type === 'namespace') {
            return [
                ...baseItems,
                {key: 'createTopic', label: '新建 Topic', icon: <PlusOutlined />, onSelect: run('createTopic')},
                {key: 'sep-1', separator: true},
                {
                    key: 'delete',
                    label: '删除命名空间',
                    icon: <DeleteOutlined />,
                    danger: true,
                    onSelect: run('delete'),
                },
            ];
        }

        if (dataRef?.type === 'topic') {
            return [
                ...baseItems,
                {key: 'producer', label: '生产者工作台', icon: <SendOutlined />, onSelect: run('producer')},
                {key: 'consumer', label: '消费者工作台', icon: <DownloadOutlined />, onSelect: run('consumer')},
                {key: 'metrics', label: '查看监控', icon: <BarChartOutlined />, onSelect: run('metrics')},
                {key: 'sep-1', separator: true},
                {
                    key: 'delete',
                    label: '删除 Topic',
                    icon: <DeleteOutlined />,
                    danger: true,
                    onSelect: run('delete'),
                },
            ];
        }

        return baseItems;
    }, [contextMenu, handleContextMenuAction]);

    // 重拉当前展开的分支：合并策略会保留旧 children，展开节点必须强制重载，
    // 否则"刷新"只是重读集群状态，树里的租户/命名空间/topic 还是旧的。
    const reloadExpandedNodes = useCallback(async () => {
        const targets: ResourceTreeNode[] = [];
        const walk = (nodes: DataNode[]) => {
            for (const n of nodes) {
                const node = n as ResourceTreeNode;
                if (node.dataRef && expandedKeysRef.current.includes(n.key)) {
                    targets.push(node);
                }
                if (n.children) {
                    walk(n.children);
                }
            }
        };
        walk(treeDataRef.current);
        await Promise.all(targets.map(target => reloadNodeChildren(target)));
    }, [reloadNodeChildren]);

    // 刷新整个树（增量合并，不重置展开状态）
    const handleRefresh = useCallback(async () => {
        setLoading(true);
        // 强制刷新时清空资源缓存，确保拉取到最新的租户/命名空间/Topic
        invalidateResourceCache();
        // 顺带探活，但不 await：不可达集群的探活最坏要试完四个候选端点，
        // 把它串进来会让整棵树转十几秒圈，而人等的明明是树的重新加载。
        void refreshClusterStatus();
        try {
            await fetchClusters();
            await reloadExpandedNodes();
            message.success('刷新成功');
        } catch (error) {
            console.error('Failed to refresh clusters:', error);
            message.error('刷新失败');
        } finally {
            setLoading(false);
        }
    }, [fetchClusters, refreshClusterStatus, reloadExpandedNodes]);

    useCommand('refreshResources', () => {
        void handleRefresh();
    });

    // 打开监控仪表盘（全局页签：跨集群自动选一个已连接集群）
    const handleOpenMetrics = useCallback(() => {
        addTab(metricsTab());
    }, [addTab]);

    // 打开拓扑可视化
    const handleOpenTopology = useCallback(() => {
        addTab({id: 'topology', title: '集群拓扑', type: 'topology'});
    }, [addTab]);

    // 左右拖动调整侧边栏宽度
    const dragCleanupRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        // 组件卸载时拖拽若仍在进行，收回全局样式与监听。
        return () => dragCleanupRef.current?.();
    }, []);

    const handleResizeStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = sidebarWidthRef.current;
        setResizing(true);
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';

        const onMove = (moveEvent: MouseEvent) => {
            setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
        };
        const cleanup = () => {
            if (dragCleanupRef.current !== cleanup) return;
            dragCleanupRef.current = null;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', cleanup);
            window.removeEventListener('blur', cleanup);
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            setResizing(false);
            localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidthRef.current));
        };
        dragCleanupRef.current = cleanup;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', cleanup);
        // 在窗口外松开鼠标或切走焦点时 mouseup 送不回来，blur 兜底结束拖拽。
        window.addEventListener('blur', cleanup);
    }, []);

    // 空状态
    const renderEmpty = () => <StateBlock empty emptyText="暂无集群，请在首页添加集群" />;

    return (
        <div
            style={{
                width: collapsed ? `${SIDEBAR_COLLAPSED_WIDTH}px` : sidebarWidth,
                backgroundColor: 'var(--color-bg-secondary)',
                borderRight: '1px solid var(--color-border)',
                display: 'flex',
                flexDirection: 'column',
                transition: resizing ? 'none' : 'width 0.2s ease',
                overflow: 'hidden',
                position: 'relative',
                flexShrink: 0,
            }}
        >
            {/* 右边缘拖动把手：按住左右移动调整宽度 */}
            {!collapsed && (
                <div
                    onMouseDown={handleResizeStart}
                    title="拖动调整宽度"
                    style={{
                        position: 'absolute',
                        top: 0,
                        right: 0,
                        bottom: 0,
                        width: 6,
                        cursor: 'col-resize',
                        zIndex: 10,
                        backgroundColor: resizing ? 'var(--color-primary)' : 'transparent',
                        opacity: resizing ? 0.35 : 1,
                    }}
                />
            )}
            {/* 工具栏 */}
            {!collapsed && (
                <div
                    style={{
                        padding: 'var(--spacing-sm)',
                        borderBottom: '1px solid var(--color-border)',
                    }}
                >
                    <Space size={4} wrap>
                        <Button size="small" icon={<BarChartOutlined />} onClick={handleOpenMetrics} title="监控仪表盘">
                            监控
                        </Button>
                        <Button size="small" icon={<ApartmentOutlined />} onClick={handleOpenTopology} title="集群拓扑">
                            拓扑
                        </Button>
                        <IconButton
                            size="small"
                            icon={<MenuFoldOutlined />}
                            label="折叠侧边栏"
                            onClick={() => setCollapsed(true)}
                        />
                    </Space>
                    <Input
                        size="small"
                        allowClear
                        aria-label="按名称模糊筛选 topic"
                        placeholder="筛选 topic"
                        prefix={<SearchOutlined style={{color: 'var(--color-text-tertiary)'}} />}
                        value={topicFilter}
                        onChange={event => setTopicFilter(event.target.value)}
                        style={{width: '100%', marginTop: 'var(--spacing-xs)'}}
                    />
                    {topicFilter.trim() ? (
                        <div className="hint-text" style={{marginTop: 2}}>
                            命中 {matchedTopicCount} 个 topic
                        </div>
                    ) : null}
                </div>
            )}

            {/* 展开/折叠按钮 */}
            {collapsed && (
                <IconButton
                    size="small"
                    icon={<MenuFoldOutlined rotate={180} />}
                    label="展开资源树"
                    onClick={() => setCollapsed(false)}
                    style={{margin: 'var(--spacing-sm)'}}
                />
            )}

            {/* 资源树 */}
            {!collapsed && (
                <div style={{flex: 1, overflow: 'auto', padding: 'var(--spacing-sm)'}} onKeyDown={handleTreeKeyDown}>
                    <Spin spinning={loading}>
                        {treeData.length === 0 ? (
                            renderEmpty()
                        ) : (
                            <Tree
                                treeData={visibleTreeData}
                                loadData={handleLoadData}
                                expandedKeys={expandedKeys}
                                onExpand={handleExpand}
                                defaultExpandAll={false}
                                showLine
                                showIcon
                                blockNode
                                onSelect={handleSelect}
                                onRightClick={(info: {event: React.MouseEvent; node: DataNode}) =>
                                    handleContextMenu(info.event, info.node)
                                }
                            />
                        )}
                    </Spin>
                </div>
            )}

            {/* 右键菜单 */}
            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    items={contextMenuItems}
                    ariaLabel="资源节点操作菜单"
                    fixed
                    onClose={closeContextMenu}
                />
            )}
            {/* 资源增删改表单 */}
            <TenantFormModal
                open={tenantForm.open}
                mode={tenantForm.mode}
                clusterId={tenantForm.clusterId}
                tenant={tenantForm.tenant}
                initial={tenantForm.initial}
                onClose={() => setTenantForm(prev => ({...prev, open: false}))}
                onSaved={async tenantName => {
                    const {clusterId, mode} = tenantForm;
                    invalidateTenants(clusterId);
                    if (mode === 'create') {
                        const parentKey = `cluster-${clusterId}`;
                        setExpandedKeys(prev => (prev.includes(parentKey) ? prev : [...prev, parentKey]));
                        await reloadNodeChildren(clusterNode(clusterId));
                    } else {
                        invalidateNamespaces(clusterId, tenantName);
                        await reloadNodeChildren(tenantNode(clusterId, tenantName));
                    }
                }}
            />
            <TopicFormModal
                open={topicForm.open}
                clusterId={topicForm.clusterId}
                tenant={topicForm.tenant}
                namespace={topicForm.namespace}
                onClose={() => setTopicForm(prev => ({...prev, open: false}))}
                onSaved={async () => {
                    const {clusterId, tenant, namespace} = topicForm;
                    invalidateTopics(clusterId, tenant, namespace);
                    const parentKey = `ns-${clusterId}-${tenant}-${namespace}`;
                    setExpandedKeys(prev => (prev.includes(parentKey) ? prev : [...prev, parentKey]));
                    await reloadNodeChildren(namespaceNode(clusterId, tenant, namespace));
                }}
            />
        </div>
    );
};

export default ResourceTree;
