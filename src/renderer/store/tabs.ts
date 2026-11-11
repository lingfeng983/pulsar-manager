import {create} from 'zustand';

// data 是各页签自带的载荷：topic / topology / producer / consumer / metrics 等
// 每种 type 带的字段都不同（clusterId、tenant、topic、instanceSeq……），形状由
// tabIds.ts 等构造方决定。这里刻意保留 any 而不硬收成联合类型：精确化得把全部
// 构造方与读取方一起改成判别联合，牵连大量本任务不拥有的调用点；改成 unknown
// 又会让本文件里的 t.data?.clusterId、{...tab.data} 直接编译不过。属于成本过高，
// 保留并注明，而不是硬改成一个错误的类型。
export interface TabItem {
    id: string;
    title: string;
    type: string;
    data?: any;
}

// 生产者/消费者工作台允许对同一条 topic 多开：每个实例挂着独立的发送/消费配置。
const MULTI_INSTANCE_TYPES = new Set(['producer', 'consumer']);

// 多开的实例 id：base id（producer-/consumer- + topic 身份）只认归属，
// 序号从 1 起、与已有序号撞车就递增，标题同步带上序号，两个并排页签才分得出。
function allocateInstanceTab(tab: TabItem, tabs: TabItem[]): TabItem {
    let seq = 1;
    while (tabs.some(t => t.id === `${tab.id}#${seq}`)) {
        seq += 1;
    }
    return {
        ...tab,
        id: `${tab.id}#${seq}`,
        title: `${tab.title} #${seq}`,
        data: {...tab.data, instanceSeq: seq},
    };
}

interface TabState {
    tabs: TabItem[];
    activeTabId: string;
    addTab: (tab: TabItem) => void;
    removeTab: (id: string) => void;
    removeClusterTabs: (clusterId: string) => void;
    setActiveTab: (id: string) => void;
}

export const useTabStore = create<TabState>(set => ({
    tabs: [{id: 'home', title: '首页', type: 'home'}],
    activeTabId: 'home',
    addTab: tab =>
        set(state => {
            if (MULTI_INSTANCE_TYPES.has(tab.type)) {
                const fresh = allocateInstanceTab(tab, state.tabs);
                return {tabs: [...state.tabs, fresh], activeTabId: fresh.id};
            }
            // 命中已存在的页签：标题与 data 用最新一次调用覆盖（同一资源的入口不止一个，
            // 参数可能更完整），但绝不能把页签重新挂载成第二个实例。
            if (state.tabs.some(t => t.id === tab.id)) {
                return {
                    tabs: state.tabs.map(t => (t.id === tab.id ? {...t, ...tab, data: {...t.data, ...tab.data}} : t)),
                    activeTabId: tab.id,
                };
            }
            return {tabs: [...state.tabs, tab], activeTabId: tab.id};
        }),
    removeTab: id =>
        set(state => {
            if (id === 'home') return state; // 首页不可关闭
            const newTabs = state.tabs.filter(t => t.id !== id);
            const newActiveId =
                state.activeTabId === id ? newTabs[newTabs.length - 1]?.id || 'home' : state.activeTabId;
            return {tabs: newTabs, activeTabId: newActiveId};
        }),
    removeClusterTabs: clusterId =>
        set(state => {
            // 标签 id 形如 `topic-${clusterId}-...`、`topology-${clusterId}`，clusterId 是 uuid，
            // 直接做子串匹配即可锁定归属；顶层 `metrics`/`topology` 等无簇标签不会被误伤。
            const belongsToCluster = (t: TabItem) =>
                t.id !== 'home' && (t.data?.clusterId === clusterId || t.id.includes(clusterId));
            const newTabs = state.tabs.filter(t => !belongsToCluster(t));
            if (newTabs.length === state.tabs.length) return state;
            const newActiveId = newTabs.some(t => t.id === state.activeTabId)
                ? state.activeTabId
                : newTabs[newTabs.length - 1]?.id || 'home';
            return {tabs: newTabs, activeTabId: newActiveId};
        }),
    setActiveTab: id => set({activeTabId: id}),
}));
