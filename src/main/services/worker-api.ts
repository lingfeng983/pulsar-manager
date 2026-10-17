import {AxiosInstance} from 'axios';
import {createReadStream, statSync} from 'node:fs';
import {basename} from 'node:path';
// 上传走 form-data 而不是全局 FormData：全局那份只能装 Blob，
// 几十 MB 的包得先进内存；这一份能直接把文件流接进分段。
import UploadForm from 'form-data';
import {
    NotFoundError,
    Semaphore,
    condenseErrorText,
    mapWithConcurrency,
    orNotFound,
    seg,
    withRetry,
    withSemaphore,
} from './http-client';
import {REQUEST_CONFIG} from '../config/constants';
import type {
    PulsarBuiltinDefinition,
    PulsarFunctionInstance,
    PulsarFunctionRuntime,
    PulsarFunctionStats,
    PulsarInstanceStatus,
    PulsarResourceKind,
    PulsarRuntimeConfig,
    PulsarRuntimeCreateParams,
    PulsarRuntimeItem,
    PulsarRuntimeStatus,
    PulsarTriggerResult,
    PulsarWorkerNode,
    PulsarWorkerState,
} from '../../shared/types';

// ========== 路径与错误口径 ==========

// worker 的运维端点在 v2，函数/连接器在 v3：这个不一致是 broker 那边就有的，
// 统一成 v3 会让 worker 探测恒定 404，然后整个页面显示「未启用」。
const WORKER_BASE = '/admin/v2/worker';

function runtimeBase(kind: PulsarResourceKind): string {
    if (kind === 'function') {
        return '/admin/v3/functions';
    }
    return kind === 'sink' ? '/admin/v3/sinks' : '/admin/v3/sources';
}

// 内置清单的路径不是复数规则：functions/builtins、sinks/builtinsinks、sources/builtinsources
function builtinBase(kind: PulsarResourceKind): string {
    if (kind === 'function') {
        return `${runtimeBase(kind)}/builtins`;
    }
    return kind === 'sink' ? `${runtimeBase(kind)}/builtinsinks` : `${runtimeBase(kind)}/builtinsources`;
}

function reloadPath(kind: PulsarResourceKind): string {
    if (kind === 'function') {
        return `${builtinBase(kind)}/reload`;
    }
    return kind === 'sink' ? `${runtimeBase(kind)}/reloadBuiltInSinks` : `${runtimeBase(kind)}/reloadBuiltInSources`;
}

/**
 * 集群没开 function worker。broker 在这种情况下不会注册这些资源，
 * 拿到的是一句没有 JSON 体的裸 404——把它翻译成人话，
 * 否则界面只能显示 "Resource not found: /admin/v3/functions/public/default"，
 * 用户会以为是命名空间写错了。
 */
export class WorkerUnavailableError extends Error {
    constructor(message = WORKER_UNAVAILABLE_MESSAGE) {
        super(message);
        this.name = 'WorkerUnavailableError';
    }
}

const WORKER_UNAVAILABLE_MESSAGE =
    '该集群没有可用的 Function Worker：/admin/v2/worker 与 /admin/v3/functions 都不存在。' +
    '函数与连接器要求 broker 配置 functionWorkerEnabled=true，或另起一个 worker 节点；' +
    '只做消息收发的部署本来就没有这两个端点。';

// 函数名与路径段同名规则：含 / 的名字必须转义，否则一个名字就能拼出别的资源路径
function itemPath(kind: PulsarResourceKind, tenant: string, namespace: string, name?: string): string {
    const base = `${runtimeBase(kind)}/${seg(tenant)}/${seg(namespace)}`;
    return name ? `${base}/${seg(name)}` : base;
}

// ========== 包字段与运行时 ==========

// worker 的包字段按运行时分裂：函数是 jar / py / go 三选一，连接器只有 archive。
// 字段名写错不是「被忽略」：配置分段由 Jackson 严格反序列化，未知属性直接 400 回来。
const RUNTIME_FIELDS: Record<PulsarFunctionRuntime, 'jar' | 'py' | 'go'> = {
    JAVA: 'jar',
    PYTHON: 'py',
    GO: 'go',
};

// 文件段三种运行时同名（data），配置段却各自不同：functionConfig / sinkConfig / sourceConfig
function configPart(kind: PulsarResourceKind): string {
    return kind === 'function' ? 'functionConfig' : `${kind}Config`;
}

const MB = 1024 * 1024;

// broker 的 resources.ram / resources.disk 是字节（默认 1073741824 = 1GB），
// 界面统一按 MB 收口，进出各换算一次。
function bytesToMb(value: unknown): number | undefined {
    return typeof value === 'number' ? Math.round(value / MB) : undefined;
}

function functionRuntime(data: any): PulsarFunctionRuntime | undefined {
    const explicit = String(data?.runtime ?? '').toUpperCase();
    if (explicit === 'JAVA' || explicit === 'PYTHON' || explicit === 'GO') {
        return explicit as PulsarFunctionRuntime;
    }
    // worker 也是这么推的：看 jar / py / go 哪一个非空
    if (data?.py) {
        return 'PYTHON';
    }
    if (data?.go) {
        return 'GO';
    }
    return data?.jar ? 'JAVA' : undefined;
}

// 读回来的包位置与运行时一起折，函数才有的三个字段在这里收成界面上的一个 archive
function foldPackage(kind: PulsarResourceKind, data: any): {archive?: string; runtime?: PulsarFunctionRuntime} {
    if (kind !== 'function') {
        return data?.archive ? {archive: String(data.archive)} : {};
    }
    const runtime = functionRuntime(data);
    for (const field of Object.values(RUNTIME_FIELDS)) {
        if (data?.[field]) {
            return {archive: String(data[field]), runtime};
        }
    }
    return runtime ? {runtime} : {};
}

// ========== 响应折叠 ==========

// broker 的实例状态形如 {numInstances, instances: {"<t>-<n>-<fn>-<i>": {instanceId, status:{...}}}}，
// 少数版本把 status 的字段直接摊在外层。两种都见过，所以取内层取不到就退到外层。
function readInstanceEntry(entry: any, index: number): PulsarFunctionInstance {
    const inner = entry?.status ?? entry ?? {};
    const raw = String(inner?.status ?? '').toLowerCase();
    let status: PulsarInstanceStatus = 'unknown';
    if (inner?.running === true) {
        status = 'running';
    } else if (inner?.error) {
        status = 'error';
    } else if (raw.includes('stopped') || raw.includes('nonexistent')) {
        status = 'stopped';
    } else if (inner?.running === false) {
        // running 明确为假、又没有错误：这就是「停着」，标成未知会让人以为状态取不到
        status = 'stopped';
    }
    const instanceId = Number(inner?.instanceId ?? entry?.instanceId ?? index);
    return {
        instanceId: Number.isFinite(instanceId) ? instanceId : index,
        status,
        error: inner?.error ? condenseErrorText(String(inner.error)) : undefined,
        numRestarts: typeof inner?.numRestarts === 'number' ? inner.numRestarts : undefined,
        workerId: inner?.workerId ? String(inner.workerId) : undefined,
    };
}

function foldStatus(data: any): PulsarRuntimeStatus {
    const instances: PulsarFunctionInstance[] = [];
    const raw = data?.instances;
    if (Array.isArray(raw)) {
        raw.forEach((entry, index) => instances.push(readInstanceEntry(entry, index)));
    } else if (raw && typeof raw === 'object') {
        // 键是 "<tenant>-<ns>-<fn>-<instanceId>"，但顺序不能靠字符串排（10 会排在 2 前面），
        // 只按对象键插入顺序收集，展示时再按 instanceId 数值排
        Object.keys(raw).forEach((key, index) => instances.push(readInstanceEntry(raw[key], index)));
    }
    instances.sort((a, b) => a.instanceId - b.instanceId);
    const count = (state: PulsarInstanceStatus) => instances.filter(item => item.status === state).length;
    const numInstances = typeof data?.numInstances === 'number' ? data.numInstances : instances.length;
    return {
        numInstances,
        running: count('running'),
        stopped: count('stopped'),
        error: count('error'),
        instances,
    };
}

function foldStats(data: any): PulsarFunctionStats {
    return {
        received: Number(data?.received ?? data?.receivedTotalCount ?? 0) || 0,
        processed: Number(data?.processed ?? data?.processedTotalCount ?? 0) || 0,
        successfullyProcessed: Number(data?.successfullyProcessed ?? data?.successfullyProcessedTotalCount ?? 0) || 0,
        unsuccessfullyProcessed:
            Number(data?.unsuccessfullyProcessed ?? data?.unsuccessfullyProcessedTotalCount ?? 0) || 0,
        emitted: Number(data?.written ?? data?.emittedToSinkTotalCount ?? 0) || 0,
        exceptions: Number(data?.exceptions ?? data?.exceptionsTotalCount ?? 0) || 0,
    };
}

// 函数与连接器共用 resources:{cpu,ram,disk}（ram/disk 是字节），包字段却不同：
// 函数按运行时分成 jar / py / go，连接器只有 archive。这里一次收口，界面上只有一种口径。
function foldConfig(
    kind: PulsarResourceKind,
    tenant: string,
    namespace: string,
    name: string,
    data: any,
): PulsarRuntimeConfig {
    const resources = data?.resources ?? {};
    const asNumber = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
    const pkg = foldPackage(kind, data);
    return {
        kind,
        tenant,
        namespace,
        name,
        className: data?.className ? String(data.className) : undefined,
        archive: pkg.archive,
        runtime: pkg.runtime,
        inputs: Array.isArray(data?.inputs) ? data.inputs.map(String) : undefined,
        // 函数的产出叫 output，来源的叫 topicName；连接器没有单一输出字段
        output: data?.output ? String(data.output) : data?.topicName ? String(data.topicName) : undefined,
        logTopic: data?.logTopic ? String(data.logTopic) : undefined,
        parallelism: asNumber(data?.parallelism),
        processingGuarantee: data?.processingGuarantees ? String(data.processingGuarantees) : undefined,
        cpu: asNumber(resources?.cpu),
        ramMb: bytesToMb(resources?.ram),
        diskMb: bytesToMb(resources?.disk),
        autoAck: typeof data?.autoAck === 'boolean' ? data.autoAck : undefined,
        timeoutMs: asNumber(data?.timeoutMs),
        raw: data && typeof data === 'object' ? data : {},
    };
}

function foldBuiltin(kind: PulsarResourceKind, data: any): PulsarBuiltinDefinition {
    return {
        kind,
        name: String(data?.name ?? ''),
        className: String(data?.className ?? data?.sinkClass ?? data?.sourceClass ?? ''),
        archive: foldPackage(kind, data).archive,
        description: data?.description ? String(data.description) : undefined,
        inputs: data?.inputs,
        multiDataInputs: data?.multiDataInputs,
        output: data?.output,
    };
}

// 列表接口只回名字，租户/命名空间是调用方自己带上去的——这里补回配置里，
// 免得每个渲染处再拼一次。
function nameOnly(kind: PulsarResourceKind, tenant: string, namespace: string, name: string): PulsarRuntimeConfig {
    return {kind, tenant, namespace, name, raw: {}};
}

// ========== API ==========

export class WorkerAPI {
    // 探测结果按实例缓存：一个 WorkerAPI 对一个集群，缓存 30 秒意味着
    // 「进页面 → 切命名空间 → 刷新」只会真的探一次，而 worker 事后被启用了也能自己跟上。
    private workerProbe?: {at: number; state: PulsarWorkerState};

    constructor(
        private http: AxiosInstance,
        private semaphore: Semaphore,
    ) {}

    private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
        return withSemaphore(this.semaphore, fn);
    }

    // 只有真正的「这个端点不存在」才认定 worker 未启用；网络错误与 5xx 一律照原样抛，
    // 否则一次隧道抖动就会被显示成「该集群没有 worker」。
    private static isMissingEndpoint(error: unknown): boolean {
        return error instanceof NotFoundError;
    }

    async getWorkerState(force = false): Promise<PulsarWorkerState> {
        const cached = this.workerProbe;
        if (!force && cached && Date.now() - cached.at < 30_000) {
            return cached.state;
        }
        let state: PulsarWorkerState;
        try {
            const response = await this.http.get(WORKER_BASE + '/cluster');
            const nodes = WorkerAPI.readWorkerNodes(response.data);
            state = {enabled: true, nodes};
        } catch (error) {
            if (!WorkerAPI.isMissingEndpoint(error)) {
                throw error;
            }
            state = {enabled: false, nodes: [], notice: WORKER_UNAVAILABLE_MESSAGE};
        }
        this.workerProbe = {at: Date.now(), state};
        return state;
    }

    private static readWorkerNodes(data: unknown): PulsarWorkerNode[] {
        const list = Array.isArray(data) ? data : data ? [data] : [];
        return list.map((item: any) => ({
            workerId: String(item?.workerId ?? item?.assignorTopic ?? ''),
            workerHostname: item?.workerHostname ? String(item.workerHostname) : undefined,
            port: typeof item?.port === 'number' ? item.port : undefined,
            isLeader: typeof item?.isLeader === 'boolean' ? item.isLeader : undefined,
            assignmentOffset: typeof item?.assignmentOffset === 'number' ? item.assignmentOffset : undefined,
        }));
    }

    // ========== 列表与详情 ==========

    // worker 未启用时，列表类调用直接抛出人话错误，让页面显示一条说明而不是空表：
    // 空表会让人以为「集群里没有函数」，而事实是「这里根本没法有函数」。
    private async requireWorker(): Promise<void> {
        const state = await this.getWorkerState();
        if (!state.enabled) {
            throw new WorkerUnavailableError(state.notice);
        }
    }

    private static readNames(data: unknown): string[] {
        return (Array.isArray(data) ? data : []).map(String).filter(Boolean);
    }

    // 一次列出命名空间下的全部函数/连接器：名字列表 → 逐个取配置与状态。
    // worker 是否启用由 requireWorker 决定，列表本身失败（命名空间不存在）则照原样抛。
    async listItems(kind: PulsarResourceKind, tenant: string, namespace: string): Promise<PulsarRuntimeItem[]> {
        return this.enqueue(async () => {
            await this.requireWorker();
            const response = await withRetry(() => this.http.get(itemPath(kind, tenant, namespace)));
            const names = WorkerAPI.readNames(response.data);
            const items = await mapWithConcurrency(names, REQUEST_CONFIG.FANOUT_CONCURRENCY, name =>
                this.fetchItem(kind, tenant, namespace, name),
            );
            return items.sort((a, b) => a.config.name.localeCompare(b.config.name));
        });
    }

    // 外层已持有许可，这里只做真正的 HTTP 请求（不能再 acquire，否则自锁）。
    // 单个详情取不到不影响整张表：那一行退化成「只有名字」——
    // 一个正在初始化的函数就能让整页打不开，而列表本身仍然是有用的。
    private async fetchItem(
        kind: PulsarResourceKind,
        tenant: string,
        namespace: string,
        name: string,
    ): Promise<PulsarRuntimeItem> {
        const path = itemPath(kind, tenant, namespace, name);
        const configResponse = await orNotFound(() => this.http.get(path), undefined);
        const config = configResponse
            ? foldConfig(kind, tenant, namespace, name, configResponse.data)
            : nameOnly(kind, tenant, namespace, name);
        const statusResponse = await orNotFound(() => this.http.get(`${path}/status`), undefined);
        // 连接器的 /stats 在部分版本上不存在，取不到就留空
        const statsResponse =
            kind === 'function' ? await orNotFound(() => this.http.get(`${path}/stats`), undefined) : undefined;
        const item: PulsarRuntimeItem = {config};
        if (statusResponse) {
            item.status = foldStatus(statusResponse.data);
        }
        if (statsResponse) {
            item.stats = foldStats(statsResponse.data);
        }
        return item;
    }

    async getItem(
        kind: PulsarResourceKind,
        tenant: string,
        namespace: string,
        name: string,
    ): Promise<PulsarRuntimeItem> {
        return this.enqueue(async () => {
            await this.requireWorker();
            return this.fetchItem(kind, tenant, namespace, name);
        });
    }

    // ========== 生命周期 ==========

    // force 用于「停止」：worker 只对显式停止的函数做重启抑制，
    // 不带这个参数停掉的函数会被另一个 leader 重新拉起。
    async control(
        kind: PulsarResourceKind,
        tenant: string,
        namespace: string,
        name: string,
        action: 'start' | 'stop' | 'restart',
        instanceId?: number,
    ): Promise<void> {
        return this.enqueue(async () => {
            await this.requireWorker();
            const scoped =
                instanceId === undefined
                    ? itemPath(kind, tenant, namespace, name)
                    : `${itemPath(kind, tenant, namespace, name)}/${instanceId}`;
            const params = action === 'stop' ? {params: {force: true}} : undefined;
            await withRetry(() => this.http.post(`${scoped}/${action}`, undefined, params));
        });
    }

    async remove(kind: PulsarResourceKind, tenant: string, namespace: string, name: string): Promise<void> {
        return this.enqueue(async () => {
            await this.requireWorker();
            await this.http.delete(itemPath(kind, tenant, namespace, name));
        });
    }

    // 触发一次：broker 这个端点收的是 multipart 表单字段，不是查询参数。
    // 没有 output topic 的函数返回空串，这是成功而不是失败。
    async trigger(
        tenant: string,
        namespace: string,
        name: string,
        topic: string,
        data?: string,
    ): Promise<PulsarTriggerResult> {
        return this.enqueue(async () => {
            await this.requireWorker();
            const form = WorkerAPI.buildForm({topic, ...(data === undefined ? {} : {data})});
            const response = await this.http.post(`${itemPath('function', tenant, namespace, name)}/trigger`, form);
            return {output: WorkerAPI.readText(response.data)};
        });
    }

    // ========== 新建 ==========

    async create(params: PulsarRuntimeCreateParams): Promise<string> {
        return this.enqueue(() => this.register(params));
    }

    /**
     * 本地包走的是「同一次注册请求里带文件段」，不是先上传再注册：
     * 注册端点自己就收 data 文件段（三种运行时同名），worker 收到后自己落包——
     * 开了包存储就写进包存储，没开就写 BookKeeper——坐标由它生成并记进函数元数据。
     * 而 packages 那套端点要的是 {type}/{tenant}/{ns}/{name}/{version} 加 metadata 段，
     * 成功只回 204 空体，坐标还得调用方自己拼，两步反而各多一个坑。
     *
     * 这一趟也刻意不占 admin 信号量：几十 MB 在慢链路上一分钟传不完，
     * 握着 5 个许可之一不放，会把同集群其它 admin 请求排到 30 秒等待上限之后全部报错。
     */
    async createWithLocalPackage(params: PulsarRuntimeCreateParams): Promise<string> {
        return this.register(params);
    }

    // 注册请求的三段：data 是文件（只有本地包这一档有）、url 是 worker 自己去取的坐标、
    // 配置段是完整的功能定义。文件段与 url 在 worker 侧是「有 url 就先按 url」的关系，
    // 两档来源各发各的那一个，不会互相盖掉。
    private async register(params: PulsarRuntimeCreateParams): Promise<string> {
        await this.requireWorker();
        const path = itemPath(params.kind, params.tenant, params.namespace, params.name);
        const config = JSON.stringify(WorkerAPI.buildCreateBody(params));
        if (params.localPackagePath) {
            const form = WorkerAPI.buildFileForm(configPart(params.kind), config, params.localPackagePath);
            const response = await this.http.post(path, form, {
                headers: form.getHeaders(),
                timeout: REQUEST_CONFIG.UPLOAD_TIMEOUT,
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
            });
            return WorkerAPI.readText(response.data) || '已提交';
        }
        const fields: Record<string, string> = {[configPart(params.kind)]: config};
        if (params.archive) {
            fields.url = params.archive;
        }
        const response = await this.http.post(path, WorkerAPI.buildForm(fields));
        return WorkerAPI.readText(response.data) || '已提交';
    }

    private static buildCreateBody(params: PulsarRuntimeCreateParams): Record<string, unknown> {
        const body: Record<string, unknown> = {
            tenant: params.tenant,
            namespace: params.namespace,
            name: params.name,
        };
        // GO 运行时 worker 不校验入口类，留空就不发这个键——发一个假类名只会存进元数据里
        if (params.className) {
            body.className = params.className;
        }
        // 空数组与 undefined 都写成「不发这个键」：函数配置里 inputs:[] 与不填
        // 在 broker 侧含义不同（前者会触发校验失败）
        // 本地包只把文件名写进包字段：字节在 data 段里，worker 只看 jar / py / go
        // 哪一个非空来推断运行时，这个字符串本身不会被它当路径去读。
        const pkg = params.archive ?? (params.localPackagePath ? basename(params.localPackagePath) : undefined);
        if (pkg) {
            body[params.kind === 'function' ? RUNTIME_FIELDS[params.runtime ?? 'JAVA'] : 'archive'] = pkg;
        }
        if (params.inputs?.length) {
            body.inputs = params.inputs;
        }
        // 连接器没有单一输出字段：sink 的目的地在 configs 里，只有 source 叫 topicName
        if (params.output && params.kind !== 'sink') {
            body[params.kind === 'function' ? 'output' : 'topicName'] = params.output;
        }
        if (params.logTopic) {
            body.logTopic = params.logTopic;
        }
        if (params.parallelism && params.parallelism > 1) {
            body.parallelism = params.parallelism;
        }
        if (params.processingGuarantee) {
            body.processingGuarantees = params.processingGuarantee;
        }
        if (params.cpu || params.ramMb || params.diskMb) {
            body.resources = {
                cpu: params.cpu ?? 1,
                ram: (params.ramMb ?? 1024) * MB,
                disk: (params.diskMb ?? 10240) * MB,
            };
        }
        if (params.userConfig && Object.keys(params.userConfig).length > 0) {
            body[params.kind === 'function' ? 'userConfig' : 'configs'] = params.userConfig;
        }
        return body;
    }

    // 文件段必须带 filename：worker 落包取的是 fileDetail.getFileName()，
    // 没有文件名的分段在它那边等于「没上传」，注册会以 Package is not provided 失败。
    private static buildFileForm(part: string, config: string, filePath: string): UploadForm {
        let size: number;
        try {
            size = statSync(filePath).size;
        } catch (error) {
            throw new Error(`本地包读不到：${filePath}（选完之后被移动或删除了？）原因：${(error as Error).message}`);
        }
        if (!size) {
            throw new Error(`本地包是空的：${filePath}`);
        }
        const form = new UploadForm();
        // knownLength 让 form-data 能写出 Content-Length 与正确的分段结尾：
        // 少了它，流式分段会被整个缓冲进内存，或者边界算错让 worker 读不到文件段。
        form.append('data', createReadStream(filePath), {
            filename: basename(filePath),
            contentType: 'application/octet-stream',
            knownLength: size,
        });
        form.append(part, config);
        return form;
    }

    // axios 会按 FormData 自动补 multipart 边界，这里不能手填 Content-Type：
    // 填了就没有 boundary，broker 直接把请求体当 JSON 读。
    private static buildForm(fields: Record<string, string>): FormData {
        if (typeof FormData === 'undefined') {
            throw new Error('当前运行环境不支持 multipart 表单，无法创建或触发函数');
        }
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) {
            form.append(key, value);
        }
        return form;
    }

    private static readText(data: unknown): string {
        if (typeof data === 'string') {
            return condenseErrorText(data);
        }
        if (data && typeof data === 'object') {
            const record = data as Record<string, unknown>;
            const text = record.message ?? record.reason ?? record.error;
            if (typeof text === 'string') {
                return condenseErrorText(text);
            }
        }
        return '';
    }

    // ========== 内置清单 ==========

    async listBuiltins(kind: PulsarResourceKind): Promise<PulsarBuiltinDefinition[]> {
        return this.enqueue(async () => {
            await this.requireWorker();
            const response = await withRetry(() => this.http.get(builtinBase(kind)));
            const list = Array.isArray(response.data) ? response.data : [];
            return list
                .map((item: unknown) => foldBuiltin(kind, item))
                .filter(item => item.name)
                .sort((a, b) => a.name.localeCompare(b.name));
        });
    }

    async reloadBuiltins(kind: PulsarResourceKind): Promise<void> {
        return this.enqueue(async () => {
            await this.requireWorker();
            await this.http.post(reloadPath(kind));
        });
    }
}
