import type {EChartsOption} from 'echarts';
import type {TopologyPalette} from '../../utils/topologyColors';

/**
 * 两张拓扑图（首页总览 / 集群拓扑）共用的图模型与 option 构造。
 * 之前两边各写一份 node/link/tooltip 组装，字段和配色一直在分叉：
 * 首页改一次配色就要记得改另一处，边和节点的类型也对不上。
 */
export type TopologyNodeType = 'cluster' | 'broker' | 'topic' | 'partition' | 'subscription';

export interface TopologyGraphNode {
    id: string;
    name: string;
    type: TopologyNodeType;
    /** 应用内的集群 id，点击节点打开标签页时要带 */
    clusterId?: string;
    clusterName?: string;
    tenant?: string;
    namespace?: string;
    /** topic 节点：完整 tenant/ns/topic */
    topicPath?: string;
    persistent?: boolean;
    status?: string;
    count?: number;
    /** 分区节点所属 topic 的完整路径 */
    parentTopic?: string;
}

export interface TopologyGraphEdge {
    source: string;
    target: string;
    value?: number;
}

export type TopologyLayout = 'force' | 'circular';

export const NODE_TYPE_LABELS: Record<TopologyNodeType, string> = {
    cluster: '集群',
    broker: 'Broker',
    topic: 'Topic',
    partition: 'Partition',
    subscription: 'Subscription',
};

const CATEGORY_ORDER: TopologyNodeType[] = ['cluster', 'broker', 'topic', 'partition', 'subscription'];

/** 统一后的分类配色：一张图里同一类型只可能是一种颜色。 */
function colorForType(type: TopologyNodeType, palette: TopologyPalette): string {
    switch (type) {
        case 'cluster':
            return palette.primary;
        case 'broker':
            return palette.success;
        case 'topic':
            return palette.warning;
        case 'partition':
            return palette.edge;
        case 'subscription':
            return palette.danger;
    }
}

const SIZE_MULTIPLIER: Record<TopologyNodeType, number> = {
    cluster: 2.6,
    broker: 1.8,
    topic: 1.4,
    partition: 1.15,
    subscription: 1,
};

function clamp(min: number, max: number, value: number): number {
    return Math.max(min, Math.min(max, value));
}

export function buildTopologyOption(params: {
    nodes: TopologyGraphNode[];
    edges: TopologyGraphEdge[];
    palette: TopologyPalette;
    layout: TopologyLayout;
    showLegend?: boolean;
}): EChartsOption {
    const {nodes, edges, palette, layout, showLegend = true} = params;
    const nodeById = new Map(nodes.map(node => [node.id, node]));

    // 分类表固定为完整类型表、不随数据增删：两张拓扑图都用合并式 setOption
    // （notMerge=false，为的是保住用户拖动过的节点位置），而合并是按位覆盖数组的，
    // 一旦某个类型的节点全部消失、catgories 数组变短，旧的多余分类会被留在图上，
    // 切主题时那几项的颜色就再也刷不掉。定长数组让每次合并都是干净的按位覆盖。
    const categoryIndex = new Map(CATEGORY_ORDER.map((type, index) => [type, index]));
    const categories = CATEGORY_ORDER.map(type => ({
        name: NODE_TYPE_LABELS[type],
        itemStyle: {color: colorForType(type, palette)},
    }));
    // 节点越多越小、斥力越大，否则上百个节点会糊成一团。
    const baseSize = clamp(14, 40, 50 - nodes.length / 10);
    const repulsion = clamp(120, 600, 260 + nodes.length * 4);

    const graphNodes = nodes.map(node => {
        const category = categoryIndex.get(node.type) ?? 0;
        const offlineCluster = node.type === 'cluster' && node.status !== 'connected';
        const color = offlineCluster ? palette.danger : colorForType(node.type, palette);
        return {
            id: node.id,
            name: node.name,
            category,
            symbolSize: baseSize * SIZE_MULTIPLIER[node.type],
            value: node.count,
            itemStyle: {
                color,
                borderColor: color,
                borderWidth: 3,
                shadowBlur: 12,
                shadowColor: 'rgba(0, 0, 0, 0.25)',
            },
            emphasis: {
                itemStyle: {borderWidth: 4, shadowBlur: 20, shadowColor: color},
                label: {fontSize: 14, fontWeight: 600 as const},
            },
        };
    });

    const graphLinks = edges.map(edge => ({
        source: edge.source,
        target: edge.target,
        value: edge.value,
        lineStyle: {
            color: palette.edge,
            width: edge.value ? clamp(1, 6, edge.value / 200) : 1,
            curveness: layout === 'force' ? 0.15 : 0.3,
            opacity: 0.55,
        },
    }));

    return {
        tooltip: {
            trigger: 'item',
            backgroundColor: palette.surface,
            borderColor: palette.border,
            borderWidth: 1,
            padding: [10, 14],
            textStyle: {color: palette.text, fontSize: 13},
            formatter: (params: any) => {
                if (params.dataType !== 'node') {
                    return `${params.data?.source ?? ''} → ${params.data?.target ?? ''}`;
                }
                const node = nodeById.get(params.data?.id);
                if (!node) {
                    return '';
                }
                const rows: string[] = [
                    `<div style="font-weight:600;font-size:14px;margin-bottom:6px">${node.name}</div>`,
                    `<div>类型: ${NODE_TYPE_LABELS[node.type]}</div>`,
                ];
                if (node.clusterName) {
                    rows.push(`<div>集群: ${node.clusterName}</div>`);
                }
                if (node.status) {
                    const online = node.status === 'connected';
                    const dot = `<span style="color:${online ? palette.success : palette.danger}">●</span>`;
                    rows.push(`<div>状态: ${dot} ${online ? '在线' : '离线'}</div>`);
                }
                if (node.tenant) {
                    rows.push(`<div>租户: ${node.tenant}</div>`);
                }
                if (node.namespace) {
                    rows.push(`<div>命名空间: ${node.namespace}</div>`);
                }
                if (node.topicPath) {
                    rows.push(`<div style="color:${palette.label}">${node.topicPath}</div>`);
                }
                if (node.count !== undefined) {
                    // 同一个 count 字段在不同节点上含义不同：集群/Broker 是关联 Topic 个数，
                    // topic 是消息速率。混在一句"数量/速率"里两种单位都说不清。
                    if (node.type === 'topic') {
                        rows.push(`<div>输入速率: ${node.count} msg/s</div>`);
                    } else if (node.type === 'cluster' || node.type === 'broker') {
                        rows.push(`<div>关联 Topic: ${node.count} 个</div>`);
                    } else {
                        rows.push(`<div>数量: ${node.count}</div>`);
                    }
                }
                return rows.join('');
            },
        },
        legend: showLegend
            ? {
                  data: categories.map(category => category.name),
                  top: 8,
                  left: 'center',
                  itemWidth: 14,
                  itemHeight: 14,
                  padding: [5, 10],
                  backgroundColor: palette.surface,
                  borderColor: palette.border,
                  borderWidth: 1,
                  borderRadius: 4,
                  // 力导节点会漂出布局框，图例必须压在它们上面才读得清。
                  z: 10,
                  textStyle: {fontSize: 13, color: palette.label},
              }
            : undefined,
        animation: true,
        animationDuration: 800,
        animationDurationUpdate: 800,
        animationEasingUpdate: 'quinticInOut',
        series: [
            {
                type: 'graph',
                layout,
                top: showLegend ? 56 : 24,
                bottom: 44,
                roam: true,
                draggable: true,
                label: {
                    show: true,
                    position: 'bottom',
                    formatter: '{b}',
                    fontSize: 12,
                    color: palette.label,
                    fontWeight: 500,
                },
                edgeSymbol: ['circle', 'arrow'],
                edgeSymbolSize: [4, 10],
                data: graphNodes,
                links: graphLinks,
                categories,
                circular: {rotateLabel: false},
                force: {
                    repulsion,
                    gravity: 0.1,
                    edgeLength: [80, 220],
                    layoutAnimation: true,
                },
                lineStyle: {opacity: 0.55},
                emphasis: {focus: 'adjacency', lineStyle: {width: 4}},
            },
        ],
    };
}

const LEAF_TYPES: TopologyNodeType[] = ['topic', 'partition', 'subscription'];

function matchesQuery(node: TopologyGraphNode, query: string): boolean {
    if (!query) {
        return true;
    }
    const haystack = [node.name, node.topicPath, node.tenant, node.namespace, node.clusterName]
        .filter(Boolean)
        .join(' ');
    return haystack.toLowerCase().includes(query.toLowerCase());
}

/**
 * 按类型与关键字筛选。中间层（集群 / Broker）只在与保留下来的叶子节点仍相连时留下，
 * 否则会剩下一堆没有任何连线的 Broker 气泡，看起来像数据错了。
 */
export function filterTopologyGraph(
    nodes: TopologyGraphNode[],
    edges: TopologyGraphEdge[],
    options: {types: Set<TopologyNodeType>; query: string},
): {nodes: TopologyGraphNode[]; edges: TopologyGraphEdge[]} {
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const incoming = new Map<string, string[]>();
    for (const edge of edges) {
        const parents = incoming.get(edge.target);
        if (parents) {
            parents.push(edge.source);
        } else {
            incoming.set(edge.target, [edge.source]);
        }
    }

    const kept = new Set<string>();
    const queue: string[] = [];
    for (const node of nodes) {
        if (LEAF_TYPES.includes(node.type) && options.types.has(node.type) && matchesQuery(node, options.query)) {
            kept.add(node.id);
            queue.push(node.id);
        }
    }
    // 只勾选中间层类型时（例如只看 Broker），叶子被过滤掉，上面的循环什么都不保留，
    // 这里再按普通节点补一次，避免整图空白。
    if (kept.size === 0) {
        for (const node of nodes) {
            if (options.types.has(node.type) && matchesQuery(node, options.query)) {
                kept.add(node.id);
            }
        }
    } else {
        while (queue.length > 0) {
            const current = queue.pop() as string;
            for (const parentId of incoming.get(current) || []) {
                const parent = nodeById.get(parentId);
                if (!parent || kept.has(parentId) || !options.types.has(parent.type)) {
                    continue;
                }
                kept.add(parentId);
                queue.push(parentId);
            }
        }
    }

    return {
        nodes: nodes.filter(node => kept.has(node.id)),
        edges: edges.filter(edge => kept.has(edge.source) && kept.has(edge.target)),
    };
}

export const ALL_NODE_TYPES = CATEGORY_ORDER;
