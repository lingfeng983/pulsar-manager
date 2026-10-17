// v2.6 K8s 端口转发的自测。本机没有可对照的集群，
// 「参数顺序写错会不会静默转发到 default 里的同名资源、就绪行是不是两个端口都要认、
// 未勾转发时半成品表单会不会卡住保存、导出的 kubeconfig 路径会不会被当成凭据拒收」
// 这类事情只能靠这一份钉住。
// 跑法：npm run selftest:k8s（先编译主进程，再跑这一份）。
const {
    buildKubectlArgs,
    parseForwardingLine,
    describeForwardFailure,
    expandHomePath,
    K8sPortForwardManager,
} = require('../dist/src/main/services/k8s-port-forward.js');
const {
    K8sInlineSchema,
    K8sConfigSchema,
    ClusterConfigSchema,
    ClusterTestSchema,
    rewriteUrl,
    forwardVerifyHost,
} = require('../dist/src/main/ipc/_shared.js');
const {
    APP_CONFIG_DEFAULTS,
    EXPORT_FORMAT,
    EXPORT_VERSION,
    ConfigImportSchema,
    parseConfigBundle,
} = require('../dist/src/main/services/app-config.js');

let failures = 0;
function check(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`ok   ${name}`))
        .catch(error => {
            failures += 1;
            console.log(`FAIL ${name}: ${error.message}`);
        });
}

function assert(cond, message) {
    if (!cond) {
        throw new Error(message);
    }
}

function eq(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
        throw new Error(`${message}：期望 ${b}，实际 ${a}`);
    }
}

function record(overrides) {
    return {
        id: 'f1',
        namespace: 'pulsar',
        resource: 'service/pulsar-broker',
        context: null,
        kubeconfig_path: null,
        kubectl_path: null,
        local_admin_port: 0,
        local_broker_port: 0,
        remote_admin_port: 8080,
        remote_broker_port: 6650,
        status: 'disconnected',
        created_at: '',
        updated_at: '',
        ...(overrides || {}),
    };
}

const TARGETS = {adminPort: 8080, brokerPort: 6650};

function errorMessages(schema, value) {
    const parsed = schema.safeParse(value);
    if (parsed.success) {
        return [];
    }
    return parsed.error.issues.map(issue => issue.message);
}

const CLUSTER_BASE = {
    name: 'k8s-demo',
    serviceUrl: 'pulsar://broker.pulsar.svc:6650',
    webServiceUrl: 'http://admin.pulsar.svc:8080',
    tlsEnabled: false,
    adminApiTimeout: 5000,
};

const K8S_BASE = {namespace: 'pulsar', resource: 'service/pulsar-broker'};

async function main() {
    // ---- 参数拼装：一条都没拼错才等于「转发的确实是用户填的那个东西」 ----
    await check('最小参数只有 -n / port-forward / TYPE/NAME / 两个远端端口', () => {
        eq(
            buildKubectlArgs(record(), TARGETS),
            ['-n', 'pulsar', 'port-forward', 'service/pulsar-broker', '8080', '6650'],
            '默认参数',
        );
    });

    await check('namespace 走 -n 而不是拼进资源名（少了它会把 default 里的同名资源当成目标）', () => {
        const args = buildKubectlArgs(record({namespace: 'pulsar-staging'}), TARGETS);
        assert(args.includes('-n'), '参数里没有 -n');
        eq(args.slice(args.indexOf('-n'), args.indexOf('-n') + 2), ['-n', 'pulsar-staging'], '-n 后面跟的不是命名空间');
        eq(args[args.indexOf('port-forward') + 1], 'service/pulsar-broker', '资源名里不该带命名空间');
    });

    await check('只给远端端口：本地端口交给 kubectl 随机分配（固定端口会与用户本机服务相撞）', () => {
        const args = buildKubectlArgs(record(), TARGETS);
        const ports = args.slice(args.indexOf('port-forward') + 2);
        eq(ports, ['8080', '6650'], '端口参数不该带 local:remote 形式');
        assert(!ports.some(port => port.includes(':')), `出现了带冒号的端口声明：${ports.join(',')}`);
    });

    await check('集群地址自带端口时按地址端口转发，而不是记录里的 8080/6650', () => {
        eq(
            buildKubectlArgs(record({remote_admin_port: 8080, remote_broker_port: 6650}), {
                adminPort: 8081,
                brokerPort: 6651,
            }),
            ['-n', 'pulsar', 'port-forward', 'service/pulsar-broker', '8081', '6651'],
            'targets 优先于记录',
        );
    });

    await check('kubeconfig / context 留空时不拼出 --kubeconfig 与 --context 这两个空参数', () => {
        const args = buildKubectlArgs(record({kubeconfig_path: '   ', context: ''}), TARGETS);
        assert(!args.includes('--kubeconfig'), '空白路径仍然拼出了 --kubeconfig');
        assert(!args.includes('--context'), '空上下文仍然拼出了 --context');
    });

    await check('带空格与反斜杠的 kubeconfig 路径仍然是一个 argv 元素', () => {
        const path = 'C:\\Users\\ming ming\\.kube\\config';
        const args = buildKubectlArgs(record({kubeconfig_path: path}), TARGETS);
        eq(args.slice(0, 2), ['--kubeconfig', path], '路径被拆开或被改写了');
    });

    await check('全局参数排在子命令之前（kubectl 不认 port-forward 后面的 --context）', () => {
        const args = buildKubectlArgs(record({kubeconfig_path: '/tmp/kc', context: 'gke_a_b_c'}), TARGETS);
        const sub = args.indexOf('port-forward');
        assert(sub > 0, '参数里没有 port-forward');
        const globalIndex = Math.max(args.indexOf('--kubeconfig'), args.indexOf('--context'));
        assert(globalIndex < sub, `全局参数出现在子命令之后：${args.join(' ')}`);
        eq(args.slice(0, 4), ['--kubeconfig', '/tmp/kc', '--context', 'gke_a_b_c'], '全局参数顺序');
    });

    await check('表单提示的 ~/.kube/config 会被展开（spawn 不开 shell，没人替它做这件事）', () => {
        const os = require('node:os');
        const args = buildKubectlArgs(record({kubeconfig_path: '~/.kube/config'}), TARGETS);
        eq(args.slice(0, 2), ['--kubeconfig', `${os.homedir()}/.kube/config`], '~/ 前缀没换成用户目录');
        eq(expandHomePath('~\\Desktop\\kc'), `${os.homedir()}\\Desktop\\kc`, '~\\ 前缀没换');
        eq(expandHomePath('~'), os.homedir(), '单独的 ~ 也该换');
        eq(expandHomePath('/etc/~app/kc'), '/etc/~app/kc', '路径中间的 ~ 不是家目录，不能动');
        eq(expandHomePath('  C:\\kc  '), 'C:\\kc', '首尾空格没清掉');
    });

    // ---- 就绪判定：两个远端端口都认出来才算转发成功 ----
    await check('IPv4 就绪行解析出本地与远端端口', () => {
        eq(parseForwardingLine('Forwarding from 127.0.0.1:41234 -> 8080'), {localPort: 41234, remotePort: 8080}, 'IPv4');
    });

    await check('IPv6 就绪行同样解析（kubectl 默认两个家族各刷一行）', () => {
        eq(parseForwardingLine('Forwarding from [::1]:41235 -> 6650'), {localPort: 41235, remotePort: 6650}, 'IPv6');
    });

    await check('非就绪行返回 null，而不是抛出 NaN', () => {
        for (const line of [
            'Unable to listen on port 8080: listeners not enabled',
            'Handling POST localhost:41234 -> service/pulsar-broker:8080',
            'Forwarding from',
            '',
        ]) {
            eq(parseForwardingLine(line), null, `这行不该被当成就绪：${line}`);
        }
    });

    await check('按远端端口归位：broker 行先于 admin 行输出时结果依然正确', () => {
        const first = parseForwardingLine('Forwarding from 127.0.0.1:51000 -> 6650');
        const second = parseForwardingLine('Forwarding from 127.0.0.1:51001 -> 8080');
        eq([first.remotePort, second.remotePort], [6650, 8080], '输出顺序不该影响归位');
        eq([first.localPort, second.localPort], [51000, 51001], '本地端口解析错误');
    });

    // ---- 失败原因：运维要看懂的那一句，而不是整段 client-go 日志 ----
    await check('port-forward 权限不足单独成句（原文里也含 not found 之类的字样）', () => {
        const text =
            'Error from server (Forbidden): namespaces "pulsar" is forbidden: ' +
            'User "u-1" cannot create resource "pods/portforward" in API group "" in the namespace "pulsar"';
        assert(
            describeForwardFailure(text, 1).includes('port-forward 权限'),
            `未识别为权限问题：${describeForwardFailure(text, 1)}`,
        );
    });

    await check('forbidden（非 portforward）说成当前上下文没有该命名空间权限', () => {
        const message = describeForwardFailure('Error from server (Forbidden): services is forbidden', 1);
        assert(message.includes('apiserver 拒绝了请求'), message);
    });

    await check('资源不存在 / 上下文不存在 / 找不到 kubectl 各归各类', () => {
        eq(
            describeForwardFailure('Error from server (NotFound): services "pulsar-brokerx" not found', 1),
            '目标资源在这个命名空间里不存在',
            '资源不存在',
        );
        eq(
            describeForwardFailure('error: context "gke_demo_cluster" does not exist', 1),
            'kubeconfig 里没有这个上下文',
            '上下文不存在',
        );
        eq(
            describeForwardFailure('exec: "kubectl": executable file not found in $PATH', 1),
            '找不到 kubectl 可执行文件',
            'kubectl 缺失',
        );
    });

    await check('apiserver 不可达与证书不完整分别命中', () => {
        const refused = describeForwardFailure('dial tcp 10.0.0.1:6443: connectex: connection refused', 1);
        assert(refused.includes('连不上 apiserver'), `连接被拒未归类为 apiserver 不可达：${refused}`);
        const tls = describeForwardFailure('x509: certificate signed by unknown authority', 1);
        assert(tls.includes('证书校验失败'), `x509 未归类为证书问题：${tls}`);
    });

    await check('未命中签名时给 stderr 尾部而不是空话；完全没有输出时说明退出码', () => {
        const text = 'line one\nline two\nline three\nline four';
        eq(describeForwardFailure(text, 7), 'line two / line three / line four', '尾部三行');
        assert(describeForwardFailure('', null).includes('没有留下任何输出'), '空 stderr 也该交代退出码');
        assert(describeForwardFailure('', null).includes('code=未知'), '退出码为空时不能写成 null');
        const long = `${'noise '.repeat(2000)}\nreal error line`;
        const tail = describeForwardFailure(long, 1);
        assert(tail.length < long.length, `超长 stderr 没有被截断（${tail.length} 字符）`);
        assert(tail.endsWith('real error line'), `尾部最后一行丢了：${tail.slice(-40)}`);
        assert(tail.split(' / ').length <= 3, `不该吐超过三行：${tail.split(' / ').length}`);
    });

    // ---- 参数校验：挡住的必须是会被 kubectl 误读成选项的输入 ----
    await check('资源名必须是小写 TYPE/NAME', () => {
        eq(K8sInlineSchema.safeParse({...K8S_BASE, resource: 'pulsar-broker'}).success, false, '缺 TYPE 也该拒绝');
        eq(K8sInlineSchema.safeParse({...K8S_BASE, resource: 'Service/pulsar-broker'}).success, false, '大写 TYPE');
        eq(K8sInlineSchema.safeParse({...K8S_BASE, resource: 'service/PulsarBroker'}).success, false, '大写 NAME');
        eq(K8sInlineSchema.safeParse({...K8S_BASE, resource: 'deployment.apps/pulsar-proxy'}).success, true, '带组的 TYPE 要能过');
    });

    await check('--help 这类输入会被拼成 kubectl 自己的参数，必须挡掉', () => {
        for (const resource of ['--help', 'service/../exec', 'service/pod --namespace=kube-system', 'service/']) {
            eq(K8sInlineSchema.safeParse({...K8S_BASE, resource}).success, false, `该拒绝：${resource}`);
        }
    });

    await check('命名空间按 DNS-1123：不以 - 开头结尾、不含大写、不超过 63', () => {
        for (const namespace of ['-pulsar', 'pulsar-', 'Pulsar', 'pul sar', 'x'.repeat(64)]) {
            eq(K8sInlineSchema.safeParse({...K8S_BASE, namespace}).success, false, `该拒绝：${namespace}`);
        }
        eq(K8sInlineSchema.safeParse({...K8S_BASE, namespace: 'pulsar-staging-2'}).success, true, '合法命名空间被拒');
    });

    await check('上下文不能以 - 或空格开头，其余字符放行（gke_x_y_z 与带空格的描述名都要能用）', () => {
        for (const context of ['--context=evil', ' gke_demo', '-']) {
            eq(K8sInlineSchema.safeParse({...K8S_BASE, context}).success, false, `该拒绝：${context}`);
        }
        for (const context of ['gke_demo-cluster_us-central1_a', 'My Cluster 名称']) {
            eq(K8sInlineSchema.safeParse({...K8S_BASE, context}).success, true, `不该拒绝：${context}`);
        }
    });

    await check('远端端口范围校验（0 与越界值会让 kubectl 直接报错）', () => {
        eq(K8sInlineSchema.safeParse({...K8S_BASE, remoteAdminPort: 0}).success, false, '端口 0');
        eq(K8sInlineSchema.safeParse({...K8S_BASE, remoteBrokerPort: 70000}).success, false, '端口越界');
        eq(K8sInlineSchema.safeParse({...K8S_BASE, remoteBrokerPort: 6650}).success, true, '合法端口被拒');
    });

    await check('转发配置带 id 时按 uuid 校验（渲染进程伪造 id 不该直接进库查询）', () => {
        eq(K8sConfigSchema.safeParse({...K8S_BASE, id: 'not-a-uuid'}).success, false, '非法 id');
        eq(K8sConfigSchema.safeParse({...K8S_BASE}).success, true, 'id 可缺省');
    });

    // ---- 表单与开关：未勾选的半成品不该卡住保存，两条通道不能同时开 ----
    await check('没勾 K8s 转发时表单里的半成品 k8s 参数被丢掉，不再抛整段 zod JSON', () => {
        const value = {...CLUSTER_BASE, useK8sForward: false, k8s: {namespace: 'Pulsar', resource: '乱七八糟'}};
        eq(errorMessages(ClusterConfigSchema, value), [], '未勾选仍然被校验');
        const parsed = ClusterConfigSchema.parse(value);
        eq(parsed.k8s, undefined, '未勾选的 k8s 应该没有落进结果里');
    });

    await check('没勾 SSH 时同理，两个开关的半成品互不牵连', () => {
        const value = {
            ...CLUSTER_BASE,
            useSshTunnel: false,
            ssh: {host: '', username: '', port: 22, authType: 'password'},
            useK8sForward: false,
            k8s: {namespace: '', resource: ''},
        };
        eq(errorMessages(ClusterConfigSchema, value), [], '未勾选的隧道参数仍在卡住保存');
    });

    await check('勾了 K8s 却没填资源名/没有已存 id 时明确报错', () => {
        const messages = errorMessages(ClusterConfigSchema, {...CLUSTER_BASE, useK8sForward: true, k8s: null});
        assert(
            messages.includes('K8s 端口转发需要命名空间与资源名'),
            `缺少 K8s 开关兜底提示：${messages.join(' | ')}`,
        );
    });

    await check('勾了 K8s 且带上已存 k8sConfigId 时不要求重填参数', () => {
        const id = '2f1a6b0e-6f1c-4f0d-9b57-3f0b0a6b1e77';
        eq(errorMessages(ClusterConfigSchema, {...CLUSTER_BASE, useK8sForward: true, k8sConfigId: id}), [], '沿用已存配置被拒');
    });

    await check('SSH 与 K8s 同时勾选被拒（两者都会改写同一对地址）', () => {
        const value = {
            ...CLUSTER_BASE,
            useSshTunnel: true,
            ssh: {host: 'jump', username: 'op', port: 22, authType: 'password'},
            useK8sForward: true,
            k8s: K8S_BASE,
        };
        const messages = errorMessages(ClusterConfigSchema, value);
        assert(
            messages.some(message => message.includes('只能启用其一')),
            `互斥提示缺失：${messages.join(' | ')}`,
        );
        const testMessages = errorMessages(
            ClusterTestSchema,
            {...CLUSTER_BASE, useSshTunnel: true, ssh: value.ssh, useK8sForward: true, k8s: K8S_BASE},
        );
        assert(
            testMessages.some(message => message.includes('只能启用其一')),
            `测试连接同样要互斥：${testMessages.join(' | ')}`,
        );
    });

    await check('只勾 K8s 的表单在校验里通过，并且 k8s 参数原样保留', () => {
        const parsed = ClusterConfigSchema.parse({...CLUSTER_BASE, useK8sForward: true, k8s: K8S_BASE});
        eq(parsed.k8s, K8S_BASE, 'k8s 参数被改写');
    });

    // ---- 地址改写：转发建好之后 Admin 与 Broker 都指向本地端口 ----
    await check('rewriteUrl 只换主机与端口，scheme 与路径留着（TLS 判定全靠它）', () => {
        eq(rewriteUrl('pulsar://broker.pulsar.svc:6650', 51000), 'pulsar://127.0.0.1:51000', '明文 broker');
        eq(rewriteUrl('pulsar+ssl://broker.pulsar.svc:6650', 51000), 'pulsar+ssl://127.0.0.1:51000', 'TLS broker');
        eq(rewriteUrl('https://admin.pulsar.svc:8080/admin', 51001), 'https://127.0.0.1:51001/admin', 'admin 路径');
    });

    await check('证书校验主机名取用户自己填的地址（集群内 service 名不会出现在 broker 证书里）', () => {
        eq(
            forwardVerifyHost({
                service_url: 'pulsar://broker.pulsar.svc:6650',
                web_service_url: 'http://admin.pulsar.svc:8080',
            }),
            'admin.pulsar.svc',
            '优先 admin 主机',
        );
        eq(forwardVerifyHost({service_url: 'pulsar://broker.pulsar.svc:6650'}), 'broker.pulsar.svc', '只剩 broker 时');
        eq(forwardVerifyHost({service_url: '不是地址'}), null, '地址非法应返回 null 而不是抛异常');
    });

    // ---- 配置包：导出的是 kubeconfig 的「路径」，不是内容 ----
    await check('配置包里的 k8s 条目被接受，路径与上下文原样保留', () => {
        const bundle = {
            format: EXPORT_FORMAT,
            version: EXPORT_VERSION,
            settings: APP_CONFIG_DEFAULTS,
            clusters: [
                {
                    name: 'k8s-demo',
                    serviceUrl: 'pulsar://broker:6650',
                    webServiceUrl: 'http://admin:8080',
                    tlsEnabled: false,
                    adminApiTimeout: 5000,
                    k8s: {
                        namespace: 'pulsar',
                        resource: 'service/pulsar-broker',
                        context: 'gke_demo',
                        kubeconfigPath: 'C:\\Users\\ming ming\\.kube\\config',
                        kubectlPath: null,
                        remoteAdminPort: 8080,
                        remoteBrokerPort: 6650,
                    },
                },
            ],
        };
        const parsed = parseConfigBundle(bundle);
        assert(!('error' in parsed), `合法配置包被拒：${JSON.stringify(parsed.error?.issues)}`);
        eq(parsed.bundle.clusters[0].k8s.namespace, 'pulsar', '命名空间丢了');
        eq(parsed.bundle.clusters[0].k8s.kubeconfigPath, 'C:\\Users\\ming ming\\.kube\\config', '路径被改写');
    });

    await check('配置包里的非法命名空间/资源名仍然拒收整包（导入是第二道边界）', () => {
        for (const k8s of [
            {namespace: 'Pulsar', resource: 'service/pulsar-broker'},
            {namespace: 'pulsar', resource: '--help'},
        ]) {
            const result = parseConfigBundle({
                format: EXPORT_FORMAT,
                version: EXPORT_VERSION,
                settings: APP_CONFIG_DEFAULTS,
                clusters: [
                    {
                        name: 'k8s-demo',
                        serviceUrl: 'pulsar://broker:6650',
                        tlsEnabled: false,
                        adminApiTimeout: 5000,
                        k8s,
                    },
                ],
            });
            assert('error' in result, `该拒收：${JSON.stringify(k8s)}`);
        }
    });

    await check('老导出文件没有 k8s 键时照常导入（缺省不等于报错）', () => {
        const result = ConfigImportSchema.safeParse({
            format: EXPORT_FORMAT,
            version: EXPORT_VERSION,
            settings: APP_CONFIG_DEFAULTS,
            clusters: [
                {name: 'plain', serviceUrl: 'pulsar://broker:6650', tlsEnabled: false, adminApiTimeout: 5000},
            ],
        });
        assert(result.success, `老文件被拒：${JSON.stringify(result.error?.issues)}`);
        eq(result.data.clusters[0].k8s, undefined, '缺省的 k8s 不该被填成对象');
    });

    // ---- 管理器的空闲状态：没起过进程时任何查询都不该抛异常 ----
    await check('未建立转发时 endpoints / isForwarding 都是空的', () => {
        const manager = new K8sPortForwardManager();
        eq(manager.endpoints('nope'), undefined, '不存在的 id 不该返回端点');
        eq(manager.isForwarding('nope'), false, '不存在的 id 不该算在转发');
    });

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} 项失败`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => {
    console.error('selftest crashed:', error);
    process.exit(1);
});
