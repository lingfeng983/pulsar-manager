// electron-builder 的 afterPack 钩子：把主程序 exe 的版本信息改成本应用的事实。
//
// 为什么需要它：electron-builder 自带的资源编辑只写 FileDescription / ProductName =
// productName，还会把 OriginalFilename 直接清空；而配置里 win.signAndEditExecutable
// 一旦为 false，连那一步都不做——装到用户机器上，属性面板里看到的就是 Electron 预编译
// 那份（文件说明 Electron、公司 GitHub, Inc.、原始文件名称 electron.exe、文件版本跟着
// Electron 走），跟本应用是哪个版本毫无关系。
//
// 时机：afterPack 跑在 win-unpacked 目录生成之后、NSIS 把目录压进安装包之前，
// 所以安装包本身与装完落在磁盘上的 exe 都会带上这里写的信息。
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const APP_NAME = 'Pulsar Manager';
const PUBLISHER = 'Pulsar Manager Team';

function appBuilderBinary() {
    const platform = process.platform === 'win32' ? 'win' : process.platform;
    const binary = path.join(__dirname, '..', 'node_modules', 'app-builder-bin', platform, 'x64', 'app-builder.exe');
    if (!fs.existsSync(binary)) {
        throw new Error(`找不到 app-builder 可执行文件（${binary}），无法写 exe 版本信息`);
    }
    return binary;
}

// app-builder 的 rcedit 子命令要先解出 winCodeSign 里的 rcedit.exe，解包用的是 PATH 上的
// 7za。electron-builder 自己跑时把 7zip-bin 塞进了子进程 PATH，我们直接调它就没人塞，
// 表现是"下载完 7z 之后 exec: 7za not found in %PATH%"。
function rceditEnv() {
    const sevenZipDir = path.dirname(require('7zip-bin').path7za);
    return {...process.env, PATH: `${sevenZipDir}${path.delimiter}${process.env.PATH || ''}`};
}

module.exports = async function afterPack(context) {
    if (context.electronPlatformName !== 'win32') {
        return;
    }
    const exe = path.join(context.appOutDir, `${APP_NAME}.exe`);
    if (!fs.existsSync(exe)) {
        throw new Error(`afterPack：${exe} 不存在，版本信息无处可写（产物是被文件锁截断的半成品？）`);
    }
    // 版本只取 appInfo（即 package.json 的 version），与 app.asar 里那份同源，
    // 避免出现"属性面板一个版本、关于弹窗另一个版本"
    const version = context.packager.appInfo.version;
    // 图标本来由 electron-builder 的编辑步写入，但那条通道（win.signAndEditExecutable）
    // 会顺手把 OriginalFilename 清空，所以配置里关掉了它，图标改在这里补：
    // build/icon.ico 一旦存在就跟着写，别让"加了图标却没人应用"变成静默失效
    const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');
    const args = [
        exe,
        '--set-version-string',
        'FileDescription',
        'Pulsar 管理工具 —— Apache Pulsar 桌面管理工具',
        '--set-version-string',
        'ProductName',
        APP_NAME,
        '--set-version-string',
        'InternalName',
        APP_NAME,
        '--set-version-string',
        'OriginalFilename',
        `${APP_NAME}.exe`,
        '--set-version-string',
        'CompanyName',
        PUBLISHER,
        '--set-version-string',
        'LegalCopyright',
        `Copyright (C) ${new Date().getFullYear()} ${PUBLISHER}`,
        '--set-version-string',
        'LegalTrademarks',
        APP_NAME,
        '--set-file-version',
        version,
        '--set-product-version',
        version,
    ];
    if (fs.existsSync(iconPath)) {
        args.push('--set-icon', iconPath);
    }
    try {
        execFileSync(appBuilderBinary(), ['rcedit', '--args', JSON.stringify(args)], {stdio: 'pipe', env: rceditEnv()});
    } catch (error) {
        const detail = (error.stderr || error.stdout || '').toString().trim();
        throw new Error(`afterPack：写入 exe 版本信息失败${detail ? `\n${detail}` : `（${error.message}）`}`);
    }
    console.log(`afterPack: ${APP_NAME}.exe 版本信息已写入 ${version}`);
};
