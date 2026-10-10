// 开发期用的本机 SSH 服务器：给「SSH 隧道」功能做实机验证，不需要真实远程机器。
// 只监听 127.0.0.1，允许把连接转发到任意地址（等价 ssh -d 本机版），仅用于本地测试。
//
// 运行：node scripts/dev-ssh-bridge.js [port]
const net = require('node:net');
const {Server, utils} = require('ssh2');

const port = Number(process.argv[2] || 2222);
const USER = 'pmuser';
const PASSWORD = 'pmtunnel';

const hostKey = utils.generateKeyPairSync('ed25519').private;

const server = new Server({hostKeys: [hostKey]}, client => {
    client.on('authentication', ctx => {
        if (ctx.username === USER && ctx.method === 'password' && ctx.password === PASSWORD) {
            return ctx.accept();
        }
        return ctx.reject(['password']);
    });
    client.on('ready', () => {
        console.log(`[bridge] client authenticated from ${client._sock.remoteAddress}:${client._sock.remotePort}`);
        client.on('tcpip', (accept, reject, info) => {
            console.log(`[bridge] forward -> ${info.destIP}:${info.destPort}`);
            const socket = net.connect(info.destPort, info.destIP, () => {
                const stream = accept();
                stream.pipe(socket);
                socket.pipe(stream);
            });
            socket.once('error', error => {
                console.log(`[bridge] forward target error: ${error.message}`);
                reject();
            });
        });
    });
    client.on('error', error => console.log(`[bridge] client error: ${error.message}`));
    client.on('end', () => console.log('[bridge] client connection ended'));
});

server.listen(port, '127.0.0.1', () => {
    console.log(`[bridge] dev SSH server on 127.0.0.1:${port} (${USER}/${PASSWORD})`);
});
