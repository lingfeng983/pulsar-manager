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
import {execFileSync} from 'node:child_process';

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

/** 从 app.asar 头部读出真实的 package.json 与文件清单。 */
function readAsarInfo(asarPath) {
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
        return {pkg: JSON.parse(pkgBuf.toString('utf8')), header};
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * 按 asar 头部的目录树确认某个文件真的被打进去了。
 * 只看 package.json.version 是不够的：写到一半的 asar 可以带着正确的 package.json，
 * 却没有 main 入口或 preload，装出来就是一点击就退出的空壳。
 */
function asarHasFile(header, relativePath) {
    let node = header;
    for (const segment of relativePath.split('/').filter(Boolean)) {
        node = node?.files?.[segment];
        if (!node) return false;
    }
    // 目录节点会带 files，文件节点带 size/offset
    return typeof node.size === 'number' && !node.files;
}

const problems = [];
const fail = message => problems.push(message);

/**
 * 读 exe 的属性面板数据（VS_VERSION_INFO）。
 * 路径经环境变量传进去：这串文件名带空格，拼进 -Command 里再套一层引号很容易被
 * 引号规则吃掉，PowerShell 与 shell 两套转义混在一起出错时是静默的。
 * 输出编码必须显式改成 UTF-8：PowerShell 默认按控制台代码页（本机是 cp936）吐字符，
 * 用 utf8 读回来就是一串乱码，会把"其实写对了"的 FileDescription 判成失败。
 */
function readExeVersionInfo(exePath) {
    try {
        const out = execFileSync(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $i=(Get-Item -LiteralPath $env:EXE_PATH).VersionInfo; $i | ConvertTo-Json -Compress',
            ],
            {env: {...process.env, EXE_PATH: exePath}, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']},
        );
        return JSON.parse(out.trim());
    } catch (error) {
        fail(
            `读不到 exe 版本信息（${error.message}）——属性校验不能跳过，跳过的话 Electron 那份默认值会一路发到用户机器上`,
        );
        return null;
    }
}

// 期望值与 scripts/after-pack.js 写的那一份对齐：这里查的正是发版时最容易漏的字段，
// 装完在资源管理器里看到 "Electron / GitHub, Inc. / electron.exe / 29.x" 就是它没生效
function checkExeMetadata(exePath, version) {
    const info = readExeVersionInfo(exePath);
    if (!info) {
        return;
    }
    const expect = {
        FileDescription: 'Pulsar 管理工具',
        ProductName: 'Pulsar Manager',
        InternalName: 'Pulsar Manager',
        OriginalFilename: 'Pulsar Manager.exe',
        CompanyName: 'Pulsar Manager Team',
        LegalCopyright: 'Pulsar Manager Team',
    };
    for (const [field, needle] of Object.entries(expect)) {
        const actual = String(info[field] ?? '');
        if (!actual.includes(needle)) {
            fail(`exe 属性 ${field} 是「${actual || '(空)'}」，应包含「${needle}」（afterPack 没生效？）`);
        }
    }
    for (const field of ['FileVersion', 'ProductVersion']) {
        const actual = String(info[field] ?? '');
        if (!actual.startsWith(version)) {
            fail(`exe 属性 ${field} 是「${actual || '(空)'}」，与 package.json 的 ${version} 不符`);
        }
    }
    return info;
}

const unpackedDir = findUnpackedDir();
if (!unpackedDir) {
    fail(`在 ${outputDir} 下找不到 ${process.platform} 的 --dir 输出目录（win-unpacked / mac* / linux-unpacked）`);
} else {
    const exeNames = EXECUTABLES[process.platform] || EXECUTABLES.linux;
    const exeName = exeNames.find(name => fs.existsSync(path.join(unpackedDir, name)));
    if (!exeName) {
        fail(`缺少应用可执行文件（期望 ${exeNames.join(' 或 ')}）——产物是被文件锁截断的半成品`);
    } else if (process.platform === 'win32') {
        checkExeMetadata(path.join(unpackedDir, exeName), sourceVersion);
    }

    const asarPath = path.join(unpackedDir, 'resources', 'app.asar');
    if (!fs.existsSync(asarPath)) {
        fail('缺少 resources/app.asar');
    } else {
        try {
            const info = readAsarInfo(asarPath);
            if (!info) {
                fail('app.asar 里没有 package.json');
            } else {
                const packaged = info.pkg.version;
                if (packaged !== sourceVersion) {
                    fail(`app.asar 里是 ${packaged}，源码是 ${sourceVersion}——打进去的是上一代 dist`);
                }
                const entry = typeof info.pkg.main === 'string' ? info.pkg.main.replace(/\\/g, '/') : '';
                const requiredEntries = [
                    entry,
                    'dist/preload.js',
                    // 渲染层入口：只有主进程与 preload、没有页面时窗口会白屏，
                    // 而安装包本身看起来完全正常
                    'dist/renderer/index.html',
                ].filter(Boolean);
                for (const relative of requiredEntries) {
                    if (!asarHasFile(info.header, relative)) {
                        fail(`app.asar 缺少入口文件 ${relative}——产物是被文件锁截断的半成品`);
                    }
                }
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
