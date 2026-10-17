import type {
    PulsarInstanceStatus,
    PulsarResourceKind,
    PulsarRuntimeItem,
    PulsarRuntimeStatus,
} from '../../../shared/types';

// 「函数与连接器」这一个页面里，口径的中文名、状态色的取法、以及从 broker 折叠回来的
// 状态到界面标签的映射都收在这里：页面与新建弹窗共用，两边各写一份必然漂移。

export const RUNTIME_KINDS: {key: PulsarResourceKind; label: string; hint: string}[] = [
    {key: 'function', label: '函数', hint: 'Pulsar Function：输入 topic → 计算 → 输出 topic'},
    {key: 'sink', label: 'Sink 连接器', hint: '从 topic 把数据写去外部系统'},
    {key: 'source', label: 'Source 连接器', hint: '从外部系统把数据读进 topic'},
];

export function runtimeKindLabel(kind: string): string {
    return RUNTIME_KINDS.find(item => item.key === kind)?.label ?? kind;
}

// 三个口径在 broker 侧是三条不同的资源，UI 只把它们当成「同一个表格的三种数据」
export const PROCESSING_GUARANTEES = [
    {value: 'ATLEAST_ONCE', label: '至少一次（ATLEAST_ONCE）'},
    {value: 'ATMOST_ONCE', label: '至多一次（ATMOST_ONCE）'},
    {value: 'EFFECTIVELY_ONCE', label: '恰好一次（EFFECTIVELY_ONCE）'},
];

// 选它等于选「包坐标发进 jar / py / go 三个字段里的哪一个」：worker 就是这么反推运行时的
export const FUNCTION_RUNTIMES = [
    {value: 'JAVA', label: 'Java'},
    {value: 'PYTHON', label: 'Python'},
    {value: 'GO', label: 'Go'},
];

export function instanceStatusMeta(status: PulsarInstanceStatus): {color: string; label: string} {
    if (status === 'running') {
        return {color: 'green', label: '运行中'};
    }
    if (status === 'error') {
        return {color: 'red', label: '出错'};
    }
    if (status === 'stopped') {
        return {color: 'default', label: '已停止'};
    }
    return {color: 'orange', label: '未知'};
}

/**
 * 整组实例折成一个标签。
 * 「未知」和「已停止」必须分开：取不到状态通常意味着 worker 还在初始化或这个函数
 * 是刚建的，而全停是用户自己停的——把它们混成一个灰色标签，就等于把两种待办合并了。
 */
export function groupStatusMeta(status: PulsarRuntimeStatus | undefined): {
    color: string;
    label: string;
    detail: string;
} {
    if (!status || status.numInstances === 0) {
        return {color: 'orange', label: '未知', detail: '状态取不到'};
    }
    const {running, error, stopped, numInstances} = status;
    const detail = `${running}/${numInstances} 运行`;
    if (error > 0) {
        return {color: 'red', label: '有实例出错', detail};
    }
    if (running === numInstances) {
        return {color: 'green', label: '运行中', detail};
    }
    if (running === 0) {
        return {color: 'default', label: '已停止', detail: `${stopped}/${numInstances} 停止`};
    }
    return {color: 'gold', label: '部分运行', detail};
}

// 只有名字那一行（详情取不到时）也要能删、能启停：操作只需要坐标，不需要配置内容
export function itemKey(item: PulsarRuntimeItem): string {
    return `${item.config.kind}/${item.config.tenant}/${item.config.namespace}/${item.config.name}`;
}

export function shortClass(className?: string): string {
    if (!className) {
        return '—';
    }
    const parts = className.split('.');
    return parts.length > 1 ? parts[parts.length - 1] : className;
}

export function fullItemName(item: PulsarRuntimeItem): string {
    return `${item.config.tenant}/${item.config.namespace}/${item.config.name}`;
}
