import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {homedir} from 'node:os';
import {updateK8sForward, type K8sForwardRecord} from '../database/sqlite';
import {createLogger} from '../utils/logger';

const log = createLogger('K8sForward');

// 本地监听端口由 kubectl 自己挑（只给它远端端口），所以这里不需要传本地端口。
export interface ForwardTargets {
    adminPort: number;
    brokerPort: number;
}

export interface ForwardEndpoints {
    forwardId: string;
    localAdminPort: number;
    localBrokerPort: number;
}

interface ActiveForward {
    child: ChildProcessWithoutNullStreams;
    endpoints: ForwardEndpoints;
    targets: ForwardTargets;
}

const FORWARD_READY_TIMEOUT_MS = 30000;
// kubectl 的 "Forwarding from 127.0.0.1:41234 -> 8080" / "[::1]:41234 -> 8080"
const FORWARDING_LINE = /Forwarding from (?:\[[0-9A-Fa-f:.]+\]|[0-9.]+):(\d+) -> (\d+)/;
// stderr 只留最后这么多字符用于报错：一次 port-forward 失败可能刷整段
// client-go 的重试日志，全量进 toast 会把真正那行挤出去
const STDERR_KEEP_CHARS = 4000;

/**
 * 拼装 kubectl 的参数数组。
 *
 * 走 spawn(无 shell) 而不是拼一条命令字符串：kubeconfig 路径在 Windows 上带空格是常态，
 * 拼字符串要么写坏引号、要么开一个 `shell: true` 出来——后者等于把用户填的任何一个字段
 * 变成命令注入点。数组之下这些值都只是 argv 里的一个元素。
 *
 * 端口一律只给远端号（不给 local:remote）：文档里这就是「本机任取一个空闲端口转发到该容器端口」，
 * 与 SSH 隧道那边「绑 127.0.0.1:0 让系统分配」是同一个理由——固定端口会与用户本机服务相撞。
 */
/**
 * 把开头那一个 `~` 换成当前用户目录。
 *
 * 不展开的话，表单里写的 `~/.kube/config` 会以字面值进 argv——spawn 不开 shell，
 * 没人替它做展开，kubectl 只会报"文件不存在"，而用户看到的是自己明明写过的位置。
 * 只认开头的 `~` 后面紧跟分隔符这一种：`~` 出现在路径中间属于合法文件名字符，不能动。
 */
export function expandHomePath(value: string): string {
    const trimmed = value.trim();
    if (trimmed === '~') {
        return homedir();
    }
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
        return homedir() + trimmed.slice(1);
    }
    return trimmed;
}

export function buildKubectlArgs(record: K8sForwardRecord, targets: ForwardTargets): string[] {
    const args: string[] = [];
    const kubeconfig = expandHomePath(record.kubeconfig_path || '');
    if (kubeconfig) {
        args.push('--kubeconfig', kubeconfig);
    }
    const context = (record.context || '').trim();
    if (context) {
        args.push('--context', context);
    }
    // -n 而不是把 namespace 拼进资源名：kubectl 的 `TYPE/NAME` 里没有命名空间这一格，
    // 少了这个参数就会静默地转发到 default 里的同名资源
    args.push('-n', record.namespace, 'port-forward', record.resource);
    args.push(String(targets.adminPort), String(targets.brokerPort));
    return args;
}

/**
 * 解析一行就绪输出。返回 null 表示这行不是转发声明（kubectl 在就绪前后还会输出别的行）。
 * 两个远端端口谁先就绪不确定，所以按行里的远端端口归位，不靠输出顺序。
 */
export function parseForwardingLine(line: string): {localPort: number; remotePort: number} | null {
    const matched = FORWARDING_LINE.exec(line);
    if (!matched) {
        return null;
    }
    const localPort = Number(matched[1]);
    const remotePort = Number(matched[2]);
    if (!Number.isInteger(localPort) || !Number.isInteger(remotePort)) {
        return null;
    }
    return {localPort, remotePort};
}

// stderr 里的已知签名 → 面向运维的说法。顺序即优先级：RBAC 那条也含 "not found"
// 之外的字样，但它的原文是先出现 forbidden，先判它才有意义。
const STDERR_HINTS: [RegExp, string][] = [
    [
        /cannot (?:patch|get|create).*portforward|pods\/portforward/i,
        '没有该命名空间的 port-forward 权限（需要 pods/portforward）',
    ],
    [/forbidden/i, 'apiserver 拒绝了请求（当前上下文没有该命名空间的权限）'],
    [/(?:pods?|services?|deployments?|statefulsets?)\s+".*"\s+not found/i, '目标资源在这个命名空间里不存在'],
    [/context ".+" does not exist/i, 'kubeconfig 里没有这个上下文'],
    [
        /connection refused|no such host|was refused|timed out/i,
        '连不上 apiserver（检查 kubeconfig、上下文与集群是否可达）',
    ],
    [/x509|certificate/i, 'apiserver 证书校验失败（kubeconfig 里的证书数据不完整）'],
    [
        /executable file not found|cannot find the file specified|system cannot find the path specified/i,
        '找不到 kubectl 可执行文件',
    ],
];

/**
 * 把 kubectl 的失败原因整理成一句能照着做的话。
 * 原文里最有用的往往是最后几行，所以未命中已知签名时给 stderr 尾部，
 * 而不是笼统一句「转发失败」让人去猜是权限、资源名还是 apiserver 的问题。
 */
export function describeForwardFailure(stderr: string, exitCode: number | null): string {
    const text = stderr.trim();
    for (const [pattern, hint] of STDERR_HINTS) {
        if (pattern.test(text)) {
            return hint;
        }
    }
    if (!text) {
        return `kubectl port-forward 退出（code=${exitCode ?? '未知'}），没有留下任何输出`;
    }
    const tail = text.length > STDERR_KEEP_CHARS ? text.slice(-STDERR_KEEP_CHARS) : text;
    return tail.split('\n').slice(-3).join(' / ');
}

function sameTargets(a: ForwardTargets, b: ForwardTargets): boolean {
    return a.adminPort === b.adminPort && a.brokerPort === b.brokerPort;
}

/**
 * 与 SSH 隧道同一套形状：本地随机端口 + 落库状态 + 世代作废。
 *
 * 区别在于这里管的是一整个子进程，两个端口都由它监听：SSH 那边是本进程起两个
 * net.Server 往隧道里灌，而 kubectl 一条命令就能同时转发多个端口。所以"关掉转发"
 * 必须是杀掉进程——只砸本地对象会留下一个仍在监听的 kubectl。
 */
export class K8sPortForwardManager {
    private active = new Map<string, ActiveForward>();
    private pending = new Map<string, Promise<ForwardEndpoints>>();
    // 每次 invalidate/disconnect 递增：建立中的那次若世代已变，说明它用的是改之前的
    // 命名空间或资源名，交出去等于让请求打到错误的 pod。
    private generation = new Map<string, number>();

    endpoints(forwardId: string): ForwardEndpoints | undefined {
        return this.active.get(forwardId)?.endpoints;
    }

    isForwarding(forwardId: string): boolean {
        return this.active.has(forwardId);
    }

    private currentGeneration(forwardId: string): number {
        return this.generation.get(forwardId) ?? 0;
    }

    /** 已有转发且目标端口一致就复用，否则重建（并发调用共享同一次建立）。 */
    ensure(record: K8sForwardRecord, targets: ForwardTargets): Promise<ForwardEndpoints> {
        const existing = this.active.get(record.id);
        if (existing && sameTargets(existing.targets, targets)) {
            return Promise.resolve(existing.endpoints);
        }
        const inflight = this.pending.get(record.id);
        if (inflight && !existing) {
            return inflight;
        }
        const generation = this.currentGeneration(record.id);
        const work = (
            inflight
                ? inflight.then(
                      () => undefined,
                      () => undefined,
                  )
                : Promise.resolve()
        )
            .then(() => this.open(record, targets, generation))
            .finally(() => {
                if (this.pending.get(record.id) === work) {
                    this.pending.delete(record.id);
                }
            });
        this.pending.set(record.id, work);
        return work;
    }

    private async open(
        record: K8sForwardRecord,
        targets: ForwardTargets,
        generation: number,
    ): Promise<ForwardEndpoints> {
        const stale = () => this.currentGeneration(record.id) !== generation;
        if (stale()) {
            throw new Error('K8s 端口转发参数在建立期间已变更，请重试');
        }
        // 旧的（哪怕端口不同）先杀干净：本地监听是 kubectl 占的，不杀就一直占着
        await this.teardown(record.id, 'disconnected');

        const command = expandHomePath(record.kubectl_path || '') || 'kubectl';
        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawn(command, buildKubectlArgs(record, targets), {
                // 不传 shell：这些参数里没有需要通配或变量展开的东西，
                // 一旦开 shell，namespace / 资源名 / 路径就全成了注入点
                windowsHide: true,
            });
        } catch (error) {
            writeForward(record.id, {status: 'error', local_admin_port: 0, local_broker_port: 0});
            throw new Error(`无法启动 kubectl：${error instanceof Error ? error.message : String(error)}`);
        }

        let stderr = '';
        child.stderr.setEncoding('utf-8');
        child.stderr.on('data', (chunk: string) => {
            // 必须一直读，否则管道写满会把 kubectl 卡死在写日志上；
            // 同时只留尾部，长时间转发的 kubectl 刷出的连接日志没有留全的价值
            stderr += chunk;
            if (stderr.length > STDERR_KEEP_CHARS * 2) {
                stderr = stderr.slice(-STDERR_KEEP_CHARS);
            }
        });
        child.stdout.setEncoding('utf-8');

        const wanted = [targets.adminPort, targets.brokerPort];
        const ports = new Map<number, number>();
        let settled = false;
        try {
            await new Promise<void>((resolve, reject) => {
                // 行监听器在 finish/fail 之后才创建，所以先放一个空实现：
                // 否则这两个回调引用未初始化的 const，读代码的人得先证明"调用时一定已经赋值"
                let closeReader = () => {};
                const finish = () => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);
                    closeReader();
                    resolve();
                };
                const fail = (error: unknown) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);
                    closeReader();
                    reject(error instanceof Error ? error : new Error(String(error)));
                };
                const timer = setTimeout(
                    () =>
                        fail(
                            new Error(
                                `kubectl port-forward 在 ${Math.round(FORWARD_READY_TIMEOUT_MS / 1000)}s 内没有就绪` +
                                    `（${record.namespace}/${record.resource}）：${describeForwardFailure(stderr, null)}`,
                            ),
                        ),
                    FORWARD_READY_TIMEOUT_MS,
                );
                closeReader = watchForwarding(child.stdout, line => {
                    const parsed = parseForwardingLine(line);
                    if (!parsed) {
                        return;
                    }
                    // 同一远端端口会先出 IPv4 再出 IPv6（或反之）：取第一条，
                    // 两个族上的本地端口相同，记两遍没有意义
                    if (!ports.has(parsed.remotePort)) {
                        ports.set(parsed.remotePort, parsed.localPort);
                    }
                    if (wanted.every(port => ports.has(port))) {
                        finish();
                    }
                });
                child.once('error', error =>
                    fail(
                        error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
                            ? new Error(`找不到 kubectl（${command}）：请安装 kubectl，或在集群配置里填写它的完整路径`)
                            : error,
                    ),
                );
                child.once('exit', code =>
                    fail(new Error(`kubectl port-forward 提前退出：${describeForwardFailure(stderr, code)}`)),
                );
            });
        } catch (error) {
            child.kill();
            writeForward(record.id, {status: 'error', local_admin_port: 0, local_broker_port: 0});
            const message = error instanceof Error ? error.message : String(error);
            // 这两类开头说明消息本身已经是给人看的了（就绪前的失败都带 kubectl 前缀，
            // 缺可执行文件那条直接说「找不到 kubectl」），再包一层前缀只会把重点挤出 toast。
            const operatorFacing = message.startsWith('kubectl') || message.startsWith('找不到');
            throw new Error(operatorFacing ? message : `K8s 端口转发失败：${message}`);
        }

        const localAdminPort = ports.get(targets.adminPort);
        const localBrokerPort = ports.get(targets.brokerPort);
        if (localAdminPort === undefined || localBrokerPort === undefined) {
            child.kill();
            throw new Error('kubectl 没有报告两个本地转发端口，无法建立地址映射');
        }
        if (stale()) {
            child.kill();
            throw new Error('K8s 端口转发参数在建立期间已变更，请重试');
        }

        const forward: ActiveForward = {
            child,
            targets,
            endpoints: {forwardId: record.id, localAdminPort, localBrokerPort},
        };
        this.active.set(record.id, forward);

        // 就绪前的一次性监听已经失效，换成常驻：kubectl 中途挂掉（apiserver 连接断、
        // pod 被删）必须摘掉登记，下一次请求才会重建，而不是对着没人监听的端口一直超时。
        child.stdout.resume();
        child.stderr.resume();
        child.on('exit', code => {
            if (this.active.get(record.id) === forward) {
                log.warn(`forward ${record.id} exited, code=${code}`);
                void this.teardown(record.id, 'disconnected');
            }
        });
        child.on('error', error => log.warn(`forward ${record.id} error`, error.message));

        writeForward(record.id, {
            status: 'connected',
            local_admin_port: localAdminPort,
            local_broker_port: localBrokerPort,
        });
        log.info(`forward ${record.id} ${record.namespace}/${record.resource} via ${command}`, {
            localAdminPort,
            localBrokerPort,
        });
        return forward.endpoints;
    }

    /** 主动关闭：杀掉 kubectl，本地端口留 0、状态置未连接。 */
    async disconnect(forwardId: string): Promise<void> {
        this.forget(forwardId);
        await this.teardown(forwardId, 'disconnected');
    }

    /** 配置变更后作废缓存转发（记录保留），下一次请求按新参数重建。 */
    async invalidate(forwardId: string): Promise<void> {
        this.forget(forwardId);
        await this.teardown(forwardId, 'disconnected');
    }

    private forget(forwardId: string): void {
        this.generation.set(forwardId, this.currentGeneration(forwardId) + 1);
        this.pending.delete(forwardId);
    }

    async closeAll(): Promise<void> {
        await Promise.all([...this.active.keys()].map(id => this.teardown(id, 'disconnected')));
    }

    private async teardown(forwardId: string, status: 'disconnected' | 'error'): Promise<void> {
        const forward = this.active.get(forwardId);
        if (!forward) {
            return;
        }
        this.active.delete(forwardId);
        await new Promise<void>(resolve => {
            if (forward.child.exitCode !== null || forward.child.signalCode !== null) {
                resolve();
                return;
            }
            const timer = setTimeout(() => {
                // SIGTERM 在 Windows 上等价于直接结束进程，但对端 pod 侧的流不一定收得到关闭；
                // 超时后不再等，杀掉本地进程即可——本地监听随进程一起消失。
                forward.child.kill('SIGKILL');
                resolve();
            }, 2000);
            forward.child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
            try {
                forward.child.kill();
            } catch (error) {
                log.warn(`forward ${forwardId} kill failed`, error instanceof Error ? error.message : error);
                clearTimeout(timer);
                resolve();
            }
        });
        writeForward(forwardId, {status, local_admin_port: 0, local_broker_port: 0});
    }
}

/** 把 stdout 按行喂给回调（kubectl 的就绪声明是一行一条，不按行切会永远匹配不上），返回摘掉监听的函数。 */
function watchForwarding(stream: NodeJS.ReadableStream, onLine: (line: string) => void): () => void {
    let buffer = '';
    const onData = (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            if (line.trim()) {
                onLine(line);
            }
            index = buffer.indexOf('\n');
        }
    };
    stream.on('data', onData);
    return () => stream.removeListener('data', onData);
}

function writeForward(forwardId: string, updates: Partial<K8sForwardRecord>): void {
    try {
        updateK8sForward(forwardId, updates);
    } catch (error) {
        log.warn(`failed to persist forward ${forwardId} status`, error instanceof Error ? error.message : error);
    }
}

export const k8sForwardManager = new K8sPortForwardManager();
