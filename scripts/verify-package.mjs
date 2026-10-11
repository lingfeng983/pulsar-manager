// 打包产物完整性校验。
//
// 为什么需要它：electron-builder 清空输出目录时如果被别的进程锁住（IDE 的文件
// 索引器会长期持有 win-unpacked/app.asar 的句柄），它可能只写出 resources/app.asar
// 就"结束"——命令退出码仍是 0，安装包照样生成，但产物里没有 exe、没有原生模块。
// 这种半成品装到用户机器上，现象是应用打不开或 SQLite / 原生 Pulsar 客户端加载失败，
// 而发布脚本只检查"安装包 exe 在不在"，根本发现不了。
//
// 用法：node scripts/verify-package.mjs [输出目录，默认取 electron-builder.json 的 directories.output]
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const builderConfig = JSON.parse(fs.readFileSync(path.resolve('electron-builder.json'), 'utf-8'));
const outputDir = path.resolve(process.argv[2] || builderConfig.directories?.output || 'release');
const sourceVersion = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8')).version;

/** 按平台找出 electron-builder 的 --dir 输出目录。 */
function findUnpackedDir() {
    if (!fs.existsSync(outputDir)) return null;
    const entries = fs.readdirSync(outputDir, {withFileTypes: true});
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
    const candidates = {
        win32: ['win-unpacked', 'win-arm64-unpacked'],
        darwin: dirs.filter(n => /^mac(-arm64)?$/.test(n)),
        linux: ['linux-unpacked', 'linux-arm64-unpacked'],
    }[process.platform] || [];
    return candidates.map(name => path.join(outputDir, name)).find(dir => fs.existsSync(dir)) || null;
}

// 原生模块必须落在 asar.unpacked：electron-builder.json 的 asarUnpack 只列了这两个 .node，
// 它们一旦缺失，主进程一 require better-sqlite3 / pulsar-client 就会在启动时炸掉。
const REQUIRED_UNPACKED = [
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    'node_modules/pulsar-client/lib/binding/pulsar.node',
];

const EXECUTABLES = {
    win32: ['Pulsar Manager.exe'],
    darwin: ['Pulsar Manager.app'],
    linux: ['pulsar-manager', 'Pulsar Manager'],
};

/** 从 app.asar 头部读出真实的 package.json 版本。 */
function readAsarVersion(asarPath) {
    const fd = fs.openSync(asarPath, 'r');
    try {
        const head = Buffer.alloc(16);
        fs.readSync(fd, head, 0, 16, 0);
        const headerSize = head.readUInt32LE(4);
        const jsonLength = head.readUInt32LE(12);
        const headerBuf = Buffer.alloc(jsonLength);
        fs.readSync(fd, headerBuf, 0, jsonLength, 16);
        const header = JSON.parse(headerBuf.toString('utf8'));
        const entry = header.files?.['package.json'];
        if (!entry) return null;
        const pkgBuf = Buffer.alloc(entry.size);
        fs.readSync(fd, pkgBuf, 0, entry.size, 8 + headerSize + Number(entry.offset));
        return JSON.parse(pkgBuf.toString('utf8')).version || null;
    } finally {
        fs.closeSync(fd);
    }
}

const problems = [];
const fail = message => problems.push(message);

const unpackedDir = findUnpackedDir();
if (!unpackedDir) {
    fail(`在 ${outputDir} 下找不到 ${process.platform} 的 --dir 输出目录（win-unpacked / mac* / linux-unpacked）`);
} else {
    const exeNames = EXECUTABLES[process.platform] || EXECUTABLES.linux;
    if (!exeNames.some(name => fs.existsSync(path.join(unpackedDir, name)))) {
        fail(`缺少应用可执行文件（期望 ${exeNames.join(' 或 ')}）——产物是被文件锁截断的半成品`);
    }

    const asarPath = path.join(unpackedDir, 'resources', 'app.asar');
    if (!fs.existsSync(asarPath)) {
        fail('缺少 resources/app.asar');
    } else {
        try {
            const packaged = readAsarVersion(asarPath);
            if (packaged !== sourceVersion) {
                fail(`app.asar 里是 ${packaged}，源码是 ${sourceVersion}——打进去的是上一代 dist`);
            }
        } catch (error) {
            fail(`app.asar 解析失败：${error.message}`);
        }
    }

    for (const relative of REQUIRED_UNPACKED) {
        const full = path.join(unpackedDir, 'resources', 'app.asar.unpacked', relative);
        if (!fs.existsSync(full)) {
            fail(`缺少原生模块 resources/app.asar.unpacked/${relative}`);
        }
    }
}

if (problems.length > 0) {
    console.error(`打包产物校验失败（${outputDir}）：`);
    problems.forEach(p => console.error(`  - ${p}`));
    console.error('\n多半是输出目录被别的进程锁住，electron-builder 清空时只写了一部分。');
    console.error('关闭占用该目录的程序（或 IDE 的文件索引）后重新打包；本机发版可改用 -c.directories.output=<新目录> 绕开。');
    process.exit(1);
}

console.log(`打包产物校验通过：${unpackedDir}（版本 ${sourceVersion}）`);
