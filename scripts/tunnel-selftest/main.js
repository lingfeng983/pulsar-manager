// SSH 隧道端到端自检（开发期工具，不进发行包）。
//
// 用 ssh2 自带的 Server 在本机起一个真实 SSH 服务器，让它把 direct-tcpip 转发到
// 本机另起的两个假 Pulsar 源站（http 与自签 https 各一），然后走应用自己的
// dist/src/main 代码链路（sqlite -> _shared.buildConnectionConfig -> getAdminClient）
// 访问它们。隧道建立、地址改写、TLS 主机名校验、失败与断链清理都是真代码在跑。
//
// 运行：bash scripts/tunnel-selftest/gen-certs.sh 先生成密钥与证书，再
//       npx electron scripts/tunnel-selftest/main.js
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const {Server, utils} = require('ssh2');
const {parseKey} = utils;

const ROOT = path.resolve(__dirname, '..', '..');
const MAIN = path.join(ROOT, 'dist', 'src', 'main');
const CERT_DIR = path.join(__dirname, 'certs');

const SSH_USER = 'pmuser';
const SSH_PASSWORD = 'pm-selftest-pw';

let failures = 0;
const results = [];

function check(name, ok, detail) {
    const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`;
    results.push(line);
    console.log(`>>> ${line}`);
    if (!ok) {
        failures += 1;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function listen(server, host) {
    return new Promise(resolve => server.listen(0, host, () => resolve(server.address().port)));
}

function closeServer(server) {
    return new Promise(resolve => server.close(() => resolve()));
}

const ROUTES = {
    '/admin/v2/clusters': ['standalone'],
    '/admin/v2/clusters/standalone': {
        serviceUrl: 'pulsar://broker.selftest:6650',
        brokerServiceUrl: 'pulsar://broker.selftest:6650',
        version: '4.0.0-selftest',
    },
    '/admin/v2/tenants': ['public', 'private'],
    '/admin/v2/tenants/public': {adminRoles: [], allowedClusters: ['standalone']},
    '/admin/v2/tenants/private': {adminRoles: [], allowedClusters: ['standalone']},
    '/admin/v2/namespaces/public': ['public/default'],
};

// 应用层的 getTenants() 会把列表逐项展开成对象，断言只关心租户名集合
function tenantNames(list) {
    return (list || []).map(item => (typeof item === 'string' ? item : item.name)).sort();
}

function pulsarHandler(req, res) {
    const url = req.url.split('?')[0];
    const body = ROUTES[url];
    if (body === undefined) {
        res.writeHead(404, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({reason: 'not found'}));
        return;
    }
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(body));
}

const sshPeers = [];

function startSshServer(hostKeys, expectedPubKey) {
    return new Server({hostKeys}, client => {
        sshPeers.push(client);
        client.on('authentication', ctx => {
            if (ctx.username !== SSH_USER) {
                return ctx.reject();
            }
            if (ctx.method === 'password') {
                return ctx.password === SSH_PASSWORD ? ctx.accept() : ctx.reject(['password']);
            }
            if (ctx.method === 'publickey') {
                // ssh2 的 publickey 是两步：先不带签名问"这把行不行"，再带签名正式认证，
                // 第一步必须回 accept()（即 PK_OK），否则客户端根本不会发签名。
                const offered = ctx.key && ctx.key.data ? ctx.key.data.toString('base64') : '';
                if (offered !== expectedPubKey) {
                    return ctx.reject(['publickey']);
                }
                if (!ctx.signature) {
                    return ctx.accept();
                }
                const parsed = parseKey(ctx.key.data);
                const ok = parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true;
                return ok ? ctx.accept() : ctx.reject(['publickey']);
            }
            return ctx.reject(['password', 'publickey']);
        });
        client.on('ready', () => {
            client.on('tcpip', (accept, reject, info) => {
                // 真转发：把通道接到目标地址，等价于 ssh -L
                const socket = net.connect(info.destPort, info.destIP, () => {
                    const stream = accept();
                    stream.pipe(socket);
                    socket.pipe(stream);
                });
                socket.once('error', () => reject());
            });
        });
        client.on('error', () => undefined);
    });
}

async function run() {
    app.disableHardwareAcceleration();
    // 自检里的临时窗口关掉后不能让 Electron 顺手退出（默认 all windows closed -> quit）
    app.on('window-all-closed', () => undefined);
    const tmpUserData = path.join(app.getPath('temp'), `pm-tunnel-selftest-${Date.now()}`);
    fs.mkdirSync(tmpUserData, {recursive: true});
    app.setPath('userData', tmpUserData);
    await app.whenReady();

    const shared = require(path.join(MAIN, 'ipc', '_shared.js'));
    const db = require(path.join(MAIN, 'database', 'sqlite.js'));
    const {sshTunnelManager, buildConnectionConfig, getAdminClient, establishTunnel, persistSshConfig, rewriteUrl} =
        shared;
    db.initDatabase();

    const hostKey = fs.readFileSync(path.join(CERT_DIR, 'ssh_host_ed25519'));
    const clientKey = fs.readFileSync(path.join(CERT_DIR, 'selftest_key'), 'utf-8');
    // ssh2 服务端拿到的是裸公钥 blob，直接比对 .pub 文件里的 base64 字段
    const clientPub = fs.readFileSync(path.join(CERT_DIR, 'selftest_key.pub'), 'utf-8').trim().split(' ')[1];
    const ca = fs.readFileSync(path.join(CERT_DIR, 'ca.crt'), 'utf-8');

    const httpOrigin = http.createServer(pulsarHandler);
    const httpsOrigin = https.createServer(
        {
            key: fs.readFileSync(path.join(CERT_DIR, 'broker.key')),
            cert: fs.readFileSync(path.join(CERT_DIR, 'broker.crt')),
        },
        pulsarHandler,
    );
    const httpPort = await listen(httpOrigin, '127.0.0.1');
    const httpsPort = await listen(httpsOrigin, '127.0.0.1');
    const sshServer = startSshServer([hostKey], clientPub);
    const sshPort = await listen(sshServer, '127.0.0.1');

    const LOCAL = '127.0.0.1';
    // insertCluster 走的是具名绑定，所有列都必须显式给值
    const newCluster = overrides => ({
        name: 'selftest',
        service_url: `pulsar://${LOCAL}:${httpPort}`,
        web_service_url: `http://${LOCAL}:${httpPort}`,
        auth_plugin: null,
        auth_params: null,
        tls_enabled: 0,
        tls_trust_certs: null,
        use_ssh_tunnel: 0,
        ssh_config_id: null,
        admin_api_timeout: 5000,
        status: 'disconnected',
        ...overrides,
    });

    // ---- 1. 隧道 + 明文 HTTP：走应用自己的连接解析 ----
    const sshConfigId = persistSshConfig(
        {host: LOCAL, port: sshPort, username: SSH_USER, authType: 'password', password: SSH_PASSWORD},
        null,
    );
    const plainId = '11111111-1111-4111-8111-111111111111';
    db.insertCluster(newCluster({id: plainId, use_ssh_tunnel: 1, ssh_config_id: sshConfigId}));

    const config = await buildConnectionConfig(plainId);
    const brokerPortNumber = Number(config.serviceUrl.split(':').pop());
    check(
        '隧道改写 broker 地址',
        config.serviceUrl === `pulsar://${LOCAL}:${brokerPortNumber}` && brokerPortNumber !== httpPort,
        config.serviceUrl,
    );
    check('admin 与 broker 各走独立本地端口', config.webServiceUrl !== config.serviceUrl);
    check('viaSshTunnel 标记', config.viaSshTunnel === true);

    const client = await getAdminClient(plainId);
    const tenants = await client.getTenants();
    check(
        '经隧道取到 tenants',
        JSON.stringify(tenantNames(tenants)) === JSON.stringify(['private', 'public']),
        JSON.stringify(tenants),
    );

    const test = await client.testConnection();
    check('经隧道 testConnection 成功', test.connected === true && test.version === '4.0.0-selftest', JSON.stringify(test));

    const second = await buildConnectionConfig(plainId);
    check('同参数复用同一条隧道', second.webServiceUrl === config.webServiceUrl);

    // 缓存的 admin 客户端必须跟着隧道端口走，否则会一直打旧端口
    const cachedFirst = await getAdminClient(plainId);
    await sshTunnelManager.invalidate(sshConfigId);
    const cachedSecond = await getAdminClient(plainId);
    check('隧道重建后 admin 客户端被换成新端口', cachedFirst !== cachedSecond);

    // ---- 2. 私钥认证 + 隧道 + 自签 HTTPS ----
    const tlsSshId = persistSshConfig(
        {host: LOCAL, port: sshPort, username: SSH_USER, authType: 'privateKey', privateKey: clientKey, remoteHost: LOCAL},
        null,
    );
    const tlsId = '22222222-2222-4222-8222-222222222222';
    db.insertCluster(
        newCluster({
            id: tlsId,
        service_url: `pulsar+ssl://${LOCAL}:${httpsPort}`,
        web_service_url: `https://broker.selftest:${httpsPort}`,
            tls_enabled: 1,
            tls_trust_certs: shared.encrypt(ca),
            use_ssh_tunnel: 1,
            ssh_config_id: tlsSshId,
        }),
    );
    const tlsConfig = await buildConnectionConfig(tlsId);
    check('证书校验主机名取原始服务地址', tlsConfig.tlsVerifyHost === 'broker.selftest', tlsConfig.tlsVerifyHost);
    const tlsClient = await getAdminClient(tlsId);
    const tlsTenants = await tlsClient.getTenants();
    check(
        '私钥认证 + 经隧道完成 TLS 握手',
        JSON.stringify(tenantNames(tlsTenants)) === JSON.stringify(['private', 'public']),
        JSON.stringify(tlsTenants),
    );

    // ---- 3. 反例：证书主机名不匹配必须失败（不是被放宽）----
    const wrongId = '33333333-3333-4333-8333-333333333333';
    db.insertCluster(
        newCluster({
            id: wrongId,
        service_url: `pulsar+ssl://${LOCAL}:${httpsPort}`,
        web_service_url: `https://attacker.selftest:${httpsPort}`,
            tls_enabled: 1,
            tls_trust_certs: shared.encrypt(ca),
            use_ssh_tunnel: 1,
            ssh_config_id: tlsSshId,
        }),
    );
    let wrongHostFailed = false;
    let wrongHostError = '';
    try {
        const badClient = await getAdminClient(wrongId);
        await badClient.getTenants();
    } catch (error) {
        wrongHostFailed = true;
        wrongHostError = error.message;
    }
    check('隧道 TLS 主机名不匹配时拒绝连接', wrongHostFailed, wrongHostError || '居然连上了');

    // ---- 4. 失败路径：错误密码 / 主机不可达 ----
    const badSshId = persistSshConfig(
        {host: LOCAL, port: sshPort, username: SSH_USER, authType: 'password', password: 'wrong'},
        null,
    );
    const badId = '44444444-4444-4444-8444-444444444444';
    db.insertCluster(newCluster({id: badId, use_ssh_tunnel: 1, ssh_config_id: badSshId}));
    let badError = '';
    try {
        await buildConnectionConfig(badId);
    } catch (error) {
        badError = error.message;
    }
    check('SSH 认证失败有明确错误', /SSH|authentication|认证/i.test(badError), badError);
    check('失败的隧道不落 connected', db.getSSHTunnelById(badSshId).status === 'error', db.getSSHTunnelById(badSshId).status);

    const deadId = '55555555-5555-4555-8555-555555555555';
    db.insertCluster(
        newCluster({
            id: deadId,
            use_ssh_tunnel: 1,
            ssh_config_id: persistSshConfig(
                {host: LOCAL, port: sshPort + 1, username: SSH_USER, authType: 'password', password: SSH_PASSWORD},
                null,
            ),
        }),
    );
    let deadError = '';
    try {
        await buildConnectionConfig(deadId);
    } catch (error) {
        deadError = error.message;
    }
    check('SSH 主机不可达有明确错误', deadError.length > 0, deadError);

    // ---- 5. 未配置隧道却勾选了开关 ----
    const orphanId = '66666666-6666-4666-8666-666666666666';
    db.insertCluster(newCluster({id: orphanId, use_ssh_tunnel: 1, ssh_config_id: null}));
    let orphanError = '';
    try {
        await buildConnectionConfig(orphanId);
    } catch (error) {
        orphanError = error.message;
    }
    check('缺隧道配置时报可读错误', /隧道/.test(orphanError), orphanError);

    // ---- 6. rewriteUrl 边界 ----
    check('rewriteUrl 保留协议', rewriteUrl('pulsar://10.0.0.1:6650', 7777) === `pulsar://${LOCAL}:7777`);
    check('rewriteUrl 容忍非法地址', rewriteUrl('not a url', 7777).startsWith(`pulsar://${LOCAL}:7777`));

    // ---- 7. establishTunnel 落库并可复用 ----
    const resolved = await establishTunnel(
        {service_url: `pulsar://${LOCAL}:${httpPort}`, web_service_url: `http://${LOCAL}:${httpPort}`},
        {sshConfigId: null, ssh: {host: LOCAL, port: sshPort, username: SSH_USER, authType: 'password', password: SSH_PASSWORD}},
    );
    check('establishTunnel 新建隧道并回 id', !!resolved.tunnelId && resolved.endpoints.localAdminPort > 0);
    check('establishTunnel 的隧道已落库', db.getSSHTunnelById(resolved.tunnelId).host === LOCAL);

    // ---- 8. 原生客户端明确拒绝 TLS + 隧道 ----
    const native = require(path.join(MAIN, 'services', 'pulsar-native-client.js'));
    let nativeError = '';
    try {
        await native.nativeClientManager.getClient('native-check', {
            serviceUrl: `pulsar+ssl://${LOCAL}:1`,
            tlsEnabled: true,
            viaSshTunnel: true,
            operationTimeoutSeconds: 5,
        });
    } catch (error) {
        nativeError = error.message;
    }
    check('原生客户端拒绝 TLS + 隧道', /隧道|SNI/.test(nativeError), nativeError);

    // ---- 9. 主窗口能加载（集群表单的入口）----
    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            preload: path.join(MAIN, '..', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    await win.loadFile(path.join(ROOT, 'dist', 'renderer', 'index.html'));
    check('主窗口加载成功', win.webContents.getURL().startsWith('file://'));
    win.destroy();

    // ---- 10. 对端断开：本地隧道摘除，下一次请求重建失败而不是打旧端口 ----
    const beforeDrop = sshTunnelManager.endpoints(sshConfigId);
    sshPeers.forEach(peer => {
        try {
            peer._sock.destroy();
        } catch {
            // 已经断开的忽略
        }
    });
    await sleep(500);
    check('对端断开后本地隧道被摘除', sshTunnelManager.endpoints(sshConfigId) === undefined, JSON.stringify(beforeDrop));
    sshServer.close();
    let dropError = '';
    try {
        await buildConnectionConfig(plainId);
    } catch (error) {
        dropError = error.message;
    }
    check('隧道断开后重建失败并报明确错误', dropError.length > 0, dropError);

    await sshTunnelManager.closeAll();
    await Promise.all([closeServer(httpOrigin), closeServer(httpsOrigin)]);
    db.closeDatabase();

    console.log('\n===== SELFTEST RESULT =====');
    results.forEach(line => console.log(line));
    console.log(failures === 0 ? `\nALL PASS (${results.length})` : `\n${failures} FAILED / ${results.length}`);
    app.exit(failures === 0 ? 0 : 1);
}

run().catch(error => {
    console.error('SELFTEST CRASHED', error);
    app.exit(2);
});
