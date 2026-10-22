// 一键发版：出包 → 门禁 → 在 GitHub 建发行版 → 传安装包 → 匿名回读校验。
//
// 为什么要有这个脚本：应用内「检查更新」只认两样东西——仓库里版本号最大的发行版，
// 以及它说明正文里那行 `- SHA256：<64 位>`（见 pm-services/src/update.rs 的 sha256_from_notes）。
// 这两样任何一处写错，用户看到的是「有新版本」却下载校验失败或根本装不上，服务端没有兜底的机会：
// 所以把「版本号三处一致、标签已推、包大小与 exe 版本对、说明里恰好一个正确的 SHA256、
// 上传后匿名可读且字节一致」做成脚本里的硬门禁，而不是靠人记。
//
// 用法：
//   npm run release                                # 完整发版（先 npm run app:build）
//   npm run release -- --dry-run                   # 只出包、过门禁、打印发行说明，不建发行版
//   npm run release -- --skip-build                # 复用 rust/target/release/bundle/nsis 里已有的包
//   npm run release -- --verify-only --tag v1.6.2  # 只回读校验已发布的发行版
//   npm run release -- --check-auth                # 只验凭据能不能通过 GitHub 认证，不发版
//   npm run release -- --notes <路径>              # 指定发行说明（默认 docs/releases/v<版本>.md）
//
// 凭据：按「环境变量 GITHUB_TOKEN（或 GitHub CLI 惯用的 GH_TOKEN）→ Windows 凭据管理器」的顺序取，
//   不接受文件里的令牌。Windows 上推荐一次性把令牌存进凭据管理器（交互式，不回显、不进 shell 历史）：
//     powershell -NoProfile -ExecutionPolicy Bypass -File scripts/wincred.ps1 -Action store
//   存好后直接跑 npm run release 即可自己取用；查看与删除改用 -Action get / -Action delete。
//   令牌只进请求头，不进日志；需要的最小权限是「对 lingfeng983/pulsar-manager 有 Contents: write」。
//   只回读校验（--verify-only）走匿名请求，不需要任何令牌。
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const API = 'https://api.github.com';
const UPLOAD_API = 'https://uploads.github.com';
const DEFAULT_REPO = 'lingfeng983/pulsar-manager';
const NOTES_DIR = 'docs/releases';
// Windows 凭据管理器里的目标名。ps1 与这里必须逐字一致，改一处就得改两处。
const WINCRED_TARGET = 'pulsar-manager:github-token';
const WINCRED_SCRIPT = 'scripts/wincred.ps1';

// Rust 版 NSIS 包实测约 7.4 MB。上下限只拦两类事故：被文件锁截断的半成品、
// 以及误把 80 MB 的 Electron 包传成新版。真要涨过 12 MB，先确认是预期内再调这里。
const SIZE_MIN = 5 * 1024 * 1024;
const SIZE_MAX = 12 * 1024 * 1024;

function fail(message) {
    throw new Error(message);
}

function step(message) {
    console.log(`\n▶ ${message}`);
}

function ok(message) {
    console.log(`  ✓ ${message}`);
}

function warn(message) {
    console.log(`  ! ${message}`);
}

function formatSize(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseArgs(argv) {
    const options = {
        dryRun: false,
        skipBuild: false,
        yes: false,
        verifyOnly: false,
        checkAuth: false,
        allowDirty: false,
        notes: null,
        repo: process.env.GITHUB_REPO || DEFAULT_REPO,
        tag: null,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = () => {
            index += 1;
            if (index >= argv.length) {
                fail(`参数 ${arg} 缺少取值`);
            }
            return argv[index];
        };
        if (arg === '--dry-run') {
            options.dryRun = true;
        } else if (arg === '--skip-build') {
            options.skipBuild = true;
        } else if (arg === '--yes' || arg === '-y') {
            options.yes = true;
        } else if (arg === '--verify-only') {
            options.verifyOnly = true;
        } else if (arg === '--check-auth') {
            options.checkAuth = true;
        } else if (arg === '--allow-dirty') {
            options.allowDirty = true;
        } else if (arg === '--notes') {
            options.notes = value();
        } else if (arg === '--repo') {
            options.repo = value();
        } else if (arg === '--tag') {
            options.tag = value();
        } else {
            fail(
                `不认识的参数：${arg}\n  可用：--dry-run --skip-build --yes --verify-only --check-auth --allow-dirty --notes <路径> --repo <owner/name> --tag <tag>`,
            );
        }
    }
    return options;
}

function readJson(relativePath) {
    return JSON.parse(readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function git(args) {
    return execFileSync('git', args, {cwd: ROOT, encoding: 'utf8'}).trim();
}

/** 版本号有三个落点，「设置 → 关于」与在线更新比对都取 Cargo workspace 那一份，必须一起改。 */
function readVersion() {
    step('版本号');
    const pkg = readJson('package.json');
    const tauri = readJson('rust/crates/pm-tauri/tauri.conf.json');
    const cargo = readFileSync(path.join(ROOT, 'rust/Cargo.toml'), 'utf8');
    const match = cargo.match(/\[workspace\.package\][\s\S]*?version\s*=\s*"([^"]+)"/);
    if (!match) {
        fail('rust/Cargo.toml 里找不到 [workspace.package] 的 version');
    }
    const versions = {package: pkg.version, cargo: match[1], tauri: tauri.version};
    if (new Set(Object.values(versions)).size !== 1) {
        fail(
            `版本号三处不一致：${JSON.stringify(versions)}\n  先把 package.json / rust/Cargo.toml / tauri.conf.json 对齐再发版。`,
        );
    }
    ok(`三处一致：${pkg.version}`);
    return pkg.version;
}

function compareVersions(left, right) {
    const parse = value =>
        value
            .replace(/^v/, '')
            .split('.')
            .map(part => Number.parseInt(part, 10) || 0);
    const one = parse(left);
    const two = parse(right);
    for (let index = 0; index < Math.max(one.length, two.length); index += 1) {
        const a = one[index] || 0;
        const b = two[index] || 0;
        if (a !== b) {
            return a > b ? 1 : -1;
        }
    }
    return 0;
}

/**
 * 与 pm-services/src/update.rs 的 sha256_from_notes 逐字对应：找到「SHA256」后跳过 6 个字符，
 * 取接下来的 64 个十六进制字符。两边算法必须一致，否则本地校验通过、客户端照样拒绝下载。
 */
function sha256FromNotes(notes) {
    let rest = notes;
    for (;;) {
        const index = rest.toUpperCase().indexOf('SHA256');
        if (index < 0) {
            return null;
        }
        const tail = rest.slice(index);
        const hex = [...tail.slice(6)]
            .filter(ch => /[0-9a-fA-F]/.test(ch))
            .slice(0, 64)
            .join('');
        if (hex.length === 64) {
            return hex.toLowerCase();
        }
        if (tail.length < 7) {
            return null;
        }
        rest = tail.slice(6);
    }
}

function checkTree(options) {
    step('工作区与标签');
    const tracked = git(['status', '--porcelain', '--untracked-files=no']);
    if (tracked) {
        if (!options.allowDirty) {
            fail(
                `有未提交的已跟踪改动，发出去的包会和标签对不上：\n${tracked}\n  先提交（或用 --allow-dirty 跳过这条）。`,
            );
        }
        warn('工作区有未提交改动（--allow-dirty），确认安装包就是当前代码打出来的');
    } else {
        ok('已跟踪文件无未提交改动');
    }
    const untracked = git(['status', '--porcelain', '--untracked-files=normal'])
        .split('\n')
        .filter(line => line.startsWith('?? '))
        .map(line => line.slice(3));
    if (untracked.length) {
        warn(`有未跟踪文件（不影响发版，但别是还没入库的源码）：${untracked.join('、')}`);
    }
}

function checkTag(tag, options) {
    const head = git(['rev-parse', 'HEAD']);
    let tagCommit;
    try {
        tagCommit = git(['rev-list', '-n1', tag]);
    } catch {
        fail(`本地没有标签 ${tag}；发版前先打标签并推送。`);
    }
    if (tagCommit !== head) {
        if (options.dryRun) {
            // 发版前先排练一遍是合理用法：只预览，不发布，所以这里放行但要说清楚。
            warn(`标签 ${tag} 指向 ${tagCommit.slice(0, 7)}，不是当前 HEAD ${head.slice(0, 7)}（dry-run 放行）`);
            return;
        }
        fail(
            `标签 ${tag} 指向 ${tagCommit.slice(0, 7)}，当前 HEAD 是 ${head.slice(0, 7)}；安装包与标签不是同一份代码。`,
        );
    }
    ok(`标签 ${tag} 指向 HEAD ${head.slice(0, 7)}`);
    // 全局 credential.helper 被有意置空（见 AGENTS.md），这里只对这条只读查询显式指定一个 helper。
    const remote = spawnSync(
        'git',
        ['-c', 'credential.helper=manager', 'ls-remote', '--tags', 'origin', `refs/tags/${tag}`],
        {
            cwd: ROOT,
            encoding: 'utf8',
            env: {...process.env, GIT_TERMINAL_PROMPT: '0'},
        },
    );
    if (remote.status !== 0) {
        warn('读不到 origin（离线或没有凭据），跳过「标签已推送」检查');
        return;
    }
    if (!remote.stdout.trim()) {
        fail(`标签 ${tag} 还没推到 origin；先 git push origin ${tag}。`);
    }
    ok('标签已在 origin 上');
}

function build() {
    step('出包：npm run app:build');
    const result = spawnSync('npm', ['run', 'app:build'], {
        cwd: ROOT,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
        fail(`构建失败（退出码 ${result.status}），没有产生可发布的安装包。`);
    }
    ok('构建完成');
}

function installerPath(version) {
    return path.join(ROOT, 'rust/target/release/bundle/nsis', `Pulsar Manager_${version}_x64-setup.exe`);
}

// 发行版附件名。GitHub 会把上传时的文件名里除字母数字与 `.` `_` `-` 以外的字符改写（空格会变成 `.`），
// 本地构建产物却固定带空格，两边不一致会让「说明里写的名字」「附件实际名字」「门禁的预期」对不上。
// 所以上传时显式指定一个不含空格的名字：本地文件名里的空白统一换成 `-`，三处用同一个函数推出来。
function publishedAssetName(file) {
    return path.basename(file).replace(/\s+/g, '-');
}

function checkExeVersion(file, version) {
    const quoted = `'${file.replace(/'/g, "''")}'`;
    const script = `$v=(Get-Item -LiteralPath ${quoted}).VersionInfo; $v.FileVersion + '|' + $v.ProductVersion`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
    });
    if (result.status !== 0) {
        warn('读不到 exe 版本信息，跳过该检查');
        return;
    }
    const [fileVersion, productVersion] = result.stdout.trim().split('|');
    const matches = value => value === version || value === `${version}.0`;
    if (!matches(fileVersion) || !matches(productVersion)) {
        fail(`exe 属性里的版本是 ${fileVersion}/${productVersion}，不是 ${version}；安装包可能是旧构建。`);
    }
    ok(`exe 属性版本 ${fileVersion}/${productVersion}`);
}

function inspectArtifact(file, version) {
    step('安装包门禁');
    if (!existsSync(file)) {
        fail(
            `找不到安装包：${path.relative(ROOT, file)}\n  先 npm run app:build，或用 --skip-build 时确认版本号没变。`,
        );
    }
    const stat = statSync(file);
    if (stat.size < SIZE_MIN || stat.size > SIZE_MAX) {
        fail(
            `安装包 ${formatSize(stat.size)} 不在 ${formatSize(SIZE_MIN)}–${formatSize(SIZE_MAX)} 之间，先确认是不是半成品。`,
        );
    }
    ok(`大小 ${formatSize(stat.size)}`);
    if (process.platform === 'win32') {
        checkExeVersion(file, version);
    }
    const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
    ok(`SHA256 ${sha256}`);
    return {file, localName: path.basename(file), name: publishedAssetName(file), size: stat.size, sha256};
}

function notesPathFor(version) {
    return path.join(ROOT, NOTES_DIR, `v${version}.md`);
}

function writeDraftNotes(file, version, tag) {
    mkdirSync(path.dirname(file), {recursive: true});
    const short = git(['rev-parse', '--short', 'HEAD']);
    let previous = null;
    try {
        previous = git(['describe', '--tags', '--abbrev=0', `${tag}^`]);
    } catch {
        previous = null;
    }
    const commits = git(['log', '--no-merges', '--format=- %s', previous ? `${previous}..${tag}` : tag])
        .split('\n')
        .filter(Boolean)
        .join('\n');
    const draft = [
        `Pulsar 管理工具 v${version}，Windows x64 安装包。`,
        '',
        `- 附件 \`${publishedAssetName(installerPath(version))}\`（约 7 MB），双击安装（当前用户安装，不需要管理员权限）`,
        '- SHA256：`{{SHA256}}`',
        `- 对应提交：\`${short}\`（master 分支）`,
        '- 数据兼容：沿用 `%APPDATA%\\pulsar-manager\\pulsar-manager.db`（user_version 17）与同一套 DPAPI 凭据密钥，老库直接读，不需要迁移',
        '',
        '## 这一版有什么',
        '',
        commits || '- ',
        '',
        `## 从 ${previous ? previous.replace(/^v/, '') : '旧版'} 升级`,
        '',
        '直接运行本安装包覆盖安装即可，本地数据与凭据无需迁移；也可以在应用内「设置 → 检查更新」升级。',
        '',
    ].join('\n');
    writeFileSync(file, draft, 'utf8');
}

function resolveNotes(version, options, tag) {
    step('发行说明');
    const file = options.notes ? path.resolve(ROOT, options.notes) : notesPathFor(version);
    if (!existsSync(file)) {
        writeDraftNotes(file, version, tag);
        fail(
            `发行说明不存在，已按提交记录生成草稿：\n  ${path.relative(ROOT, file)}\n  补全内容后重新运行；草稿里的 {{SHA256}} 会由脚本换成实际值。`,
        );
    }
    const raw = readFileSync(file, 'utf8').trim();
    if (!raw.includes(tag)) {
        warn(`发行说明里没有提到 ${tag}`);
    }
    // `ls-files --error-unmatch` 对未入库文件会往 stderr 打 pathspec 报错，这里只看退出码。
    const tracked = spawnSync(
        'git',
        ['ls-files', '--error-unmatch', path.relative(ROOT, file).split(path.sep).join('/')],
        {
            cwd: ROOT,
            stdio: 'ignore',
        },
    );
    if (tracked.status !== 0) {
        warn('发行说明还没入库，发布后记得把它一起提交');
    }
    ok(`${path.relative(ROOT, file)}（${raw.length} 字符）`);
    return {file, raw};
}

/** 把说明里的 SHA256 行换成刚算出来的值；没有就补一行，保证客户端永远读得到。 */
function injectSha(notes, sha256) {
    const line = `- SHA256：\`${sha256}\``;
    const existingLine = /^- SHA256[:：].*$/m;
    if (existingLine.test(notes)) {
        return notes.replace(existingLine, line);
    }
    if (notes.includes('{{SHA256}}')) {
        return notes.replaceAll('{{SHA256}}', sha256);
    }
    const anchor = /^- 对应提交：.*$/m;
    if (anchor.test(notes)) {
        return notes.replace(anchor, match => `${line}\n${match}`);
    }
    return `${notes}\n\n${line}\n`;
}

function assertShaInNotes(notes, sha256) {
    const parsed = sha256FromNotes(notes);
    if (parsed !== sha256) {
        fail(`发行说明里的 SHA256（${parsed || '缺失'}）与安装包（${sha256}）不一致。`);
    }
    ok('说明里的 SHA256 与安装包一致');
}

const WINCRED_HINT =
    'Windows 上可把令牌一次性存进凭据管理器（交互式，不回显、不进 shell 历史）：\n' +
    '    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/wincred.ps1 -Action store\n' +
    '  存好后重跑本脚本即可；查看与删除改用 -Action get / -Action delete。';

/**
 * 从 Windows 凭据管理器取令牌：只读已知目标名，不落任何令牌文件。
 * 非 Windows、ps1 不在、或条目不存在都返回 null，由 resolveAuth 统一给提示。
 * 子进程 stdout 只用于取值（失败时是空的），stderr 直接丢弃——任何情况下都不把输出写进日志。
 */
function tokenFromWindowsCredential() {
    if (process.platform !== 'win32') {
        return null;
    }
    const script = path.join(ROOT, WINCRED_SCRIPT);
    if (!existsSync(script)) {
        return null;
    }
    try {
        const token = execFileSync(
            'powershell',
            [
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                script,
                '-Action',
                'get',
                '-Target',
                WINCRED_TARGET,
            ],
            {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true},
        ).trim();
        return token || null;
    } catch {
        return null;
    }
}

function resolveAuth() {
    step('GitHub 凭据');
    const fromEnv = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
    if (fromEnv) {
        ok('使用环境变量 GITHUB_TOKEN / GH_TOKEN');
        return {token: fromEnv};
    }
    const fromCredential = tokenFromWindowsCredential();
    if (fromCredential) {
        ok(`使用 Windows 凭据管理器里的 ${WINCRED_TARGET}`);
        return {token: fromCredential};
    }
    fail(
        '没有可用的 GitHub 凭据：环境变量 GITHUB_TOKEN / GH_TOKEN 都为空，' +
            `Windows 凭据管理器里也没有目标名为 ${WINCRED_TARGET} 的条目。\n  ` +
            WINCRED_HINT +
            '\n  令牌需要「对 ' +
            DEFAULT_REPO +
            ' 有 Contents: write」的权限；只存在凭据管理器里，不要写进仓库里的文件。',
    );
}

/** 只验凭据：确认仓库可见、令牌有 push 权限、令牌属于哪个账号。全程只读，不创建任何东西。 */
async function checkAuth(options) {
    const auth = resolveAuth();
    const getJson = async pathname => {
        const response = await fetch(`${API}${pathname}`, {
            headers: {
                Authorization: `Bearer ${auth.token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'pulsar-manager-release-script',
            },
        });
        const body = await response.text();
        if (!response.ok) {
            fail(`GitHub API GET ${pathname} 失败：HTTP ${response.status} ${body.slice(0, 300)}`);
        }
        return JSON.parse(body);
    };

    step('校验凭据');
    const repo = await getJson(`/repos/${options.repo}`);
    ok(`仓库 ${repo.full_name}（${repo.private ? 'private' : 'public'}）可读`);
    if (!repo.permissions || !repo.permissions.push) {
        fail(`令牌对 ${options.repo} 没有 push 权限，创建发行版会被拒。`);
    }
    ok('令牌有 push 权限，可创建发行版');
    const user = await getJson('/user');
    ok(`令牌身份：${user.login}`);
    console.log('\n✔ 凭据可用；去掉 --check-auth 即可正式发版。');
}

async function api(pathname, {method = 'GET', auth = null, json, raw, base = API, headers = {}} = {}) {
    const init = {method, headers: {...headers}};
    if (auth) {
        init.headers.Authorization = `Bearer ${auth.token}`;
    }
    init.headers.Accept = 'application/vnd.github+json';
    init.headers['X-GitHub-Api-Version'] = '2022-11-28';
    init.headers['User-Agent'] = 'pulsar-manager-release-script';
    if (json !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(json);
    } else if (raw !== undefined) {
        init.headers['Content-Type'] = raw.type || 'application/octet-stream';
        init.body = raw.body;
    }
    const response = await fetch(`${base}${pathname}`, init);
    if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        fail(`GitHub API ${method} ${pathname} 失败：HTTP ${response.status} ${detail}`);
    }
    if (response.status === 204) {
        return null;
    }
    return response.json();
}

async function listReleases(repo, auth) {
    const releases = await api(`/repos/${repo}/releases?per_page=100`, {auth});
    return Array.isArray(releases) ? releases : [];
}

async function ensureReleaseAbsent(repo, tag, auth) {
    step('仓库发行版检查');
    const releases = await listReleases(repo, auth);
    const existing = releases.find(release => release.tag_name === tag);
    if (existing) {
        fail(`仓库里已有 ${tag} 的发行版（id ${existing.id}）。要重发先删掉它：https://github.com/${repo}/releases`);
    }
    ok(`还没有 ${tag} 的发行版`);
}

async function createRelease(repo, tag, notes, auth) {
    const release = await api(`/repos/${repo}/releases`, {
        method: 'POST',
        auth,
        json: {
            tag_name: tag,
            name: `Pulsar 管理工具 ${tag}`,
            body: notes,
            draft: false,
            prerelease: false,
        },
    });
    ok(`发行版已创建（id ${release.id}，标签 ${release.tag_name}）`);
    return release;
}

async function uploadAsset(repo, releaseId, artifact, auth) {
    const upload = await api(`/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(artifact.name)}`, {
        method: 'POST',
        auth,
        base: UPLOAD_API,
        raw: {body: readFileSync(artifact.file)},
    });
    if (!upload?.name) {
        fail('附件上传没有返回文件名，请到发行页确认。');
    }
    if (upload.name !== artifact.name) {
        fail(
            `GitHub 把附件名改写成了 ${upload.name}，与预期的 ${artifact.name} 不一致；` +
                '发行说明里写的名字和门禁的预期都要跟着改，否则客户端与说明对不上号。',
        );
    }
    ok(`附件已上传：${upload.name}（${formatSize(upload.size)}）`);
    return upload;
}

/** 用匿名请求跑一遍客户端会做的事：读发行版列表 → 解析说明里的 SHA256 → 下载附件 → 比对字节。 */
async function verifyRelease(repo, tag, expected = {}) {
    step('匿名回读校验');
    const releases = await listReleases(repo, null);
    if (releases.length === 0) {
        fail('仓库里读不到任何发行版。');
    }
    const latest = releases
        .filter(release => typeof release.tag_name === 'string' && !release.draft)
        .reduce((best, item) => (!best || compareVersions(item.tag_name, best.tag_name) > 0 ? item : best), null);
    if (!latest) {
        fail('发行版列表里没有能比较的 tag。');
    }
    if (latest.tag_name !== tag) {
        fail(`应用内「检查更新」会拿到 ${latest.tag_name}，不是 ${tag}；旧客户端收不到这次发布。`);
    }
    ok(`最新发行版是 ${latest.tag_name}`);

    const release = releases.find(item => item.tag_name === tag);
    const parsed = sha256FromNotes(release.body || '');
    if (!parsed) {
        fail('发行说明正文里没有可识别的 SHA256，所有旧客户端都会拒绝下载。');
    }
    ok(`说明里的 SHA256 ${parsed}`);

    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = assets.find(item => typeof item.name === 'string' && item.name.toLowerCase().endsWith('.exe'));
    if (!asset) {
        fail('发行版里没有 .exe 附件；应用内更新找不到可下载的安装包。');
    }
    if (expected.name && asset.name !== expected.name) {
        fail(`附件名是 ${asset.name}，预期 ${expected.name}。`);
    }
    if (expected.size && asset.size !== expected.size) {
        fail(`附件大小 ${asset.size}，预期 ${expected.size}。`);
    }
    ok(`附件 ${asset.name}（${formatSize(asset.size)}）`);

    const host = new URL(asset.browser_download_url).hostname.toLowerCase();
    const trusted =
        host === 'github.com' ||
        host.endsWith('.github.com') ||
        host === 'githubusercontent.com' ||
        host.endsWith('.githubusercontent.com');
    if (!trusted) {
        fail(`附件地址不是 GitHub 域名：${host}；客户端只信任 GitHub 的下载地址。`);
    }
    // 下载会跟随 302 跳到 release-assets.githubusercontent.com，匿名可读即通过。
    const response = await fetch(asset.browser_download_url, {redirect: 'follow'});
    if (!response.ok) {
        fail(`匿名下载附件失败：HTTP ${response.status}。`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== parsed) {
        fail(`下载回来的附件 SHA256（${actual}）与发行说明（${parsed}）不一致。`);
    }
    ok('匿名下载的附件与说明里的 SHA256 逐位一致');
    if (expected.sha256 && actual !== expected.sha256) {
        fail(`下载回来的附件与本地安装包不一致：${actual} ≠ ${expected.sha256}。`);
    }
    if (expected.size && bytes.length !== expected.size) {
        fail('下载回来的附件大小与本地安装包不一致。');
    }
    if (expected.sha256) {
        ok('下载回来的附件与本地安装包逐字节一致');
    }
    const page = await fetch(`https://github.com/${repo}/releases/tag/${tag}`);
    if (!page.ok) {
        warn(`发行页返回 ${page.status}，请手工打开确认页面正常`);
    }
    return {release, asset};
}

async function confirmPublish() {
    const rl = createInterface({input: process.stdin, output: process.stdout});
    const answer = await new Promise(resolve => rl.question('即将创建发行版并上传安装包，继续？[y/N] ', resolve));
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
        fail('已取消（没有确认）。');
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (process.platform !== 'win32' && !options.verifyOnly && !options.checkAuth) {
        fail('一键发版目前只出 Windows NSIS 包。');
    }

    if (options.checkAuth) {
        await checkAuth(options);
        return;
    }

    if (options.verifyOnly) {
        const tag = options.tag || `v${readVersion()}`;
        const local = installerPath(tag.replace(/^v/, ''));
        const expected = existsSync(local)
            ? {
                  sha256: createHash('sha256').update(readFileSync(local)).digest('hex'),
                  size: statSync(local).size,
                  name: publishedAssetName(local),
              }
            : {};
        await verifyRelease(options.repo, tag, expected);
        console.log(`\n✔ ${tag} 校验通过：https://github.com/${options.repo}/releases/tag/${tag}`);
        return;
    }

    const version = readVersion();
    const tag = `v${version}`;
    checkTree(options);
    checkTag(tag, options);
    if (options.skipBuild) {
        step('出包（--skip-build，复用已有安装包）');
    } else {
        build();
    }
    const artifact = inspectArtifact(installerPath(version), version);
    const {file: notesFile, raw} = resolveNotes(version, options, tag);
    const notes = injectSha(raw, artifact.sha256);
    assertShaInNotes(notes, artifact.sha256);

    console.log(`\n──── 发行版预览 ${tag} ────\n${notes}\n──────────────────────────`);
    if (options.dryRun) {
        console.log('\n✔ dry-run：门禁全过，未创建发行版（去掉 --dry-run 即发布）。');
        return;
    }
    if (!options.yes) {
        if (!process.stdin.isTTY) {
            fail('当前不是交互终端；确认无误后加 --yes 再跑一次。');
        }
        await confirmPublish();
    }

    const auth = resolveAuth();
    await ensureReleaseAbsent(options.repo, tag, auth);
    const release = await createRelease(options.repo, tag, notes, auth);
    await uploadAsset(options.repo, release.id, artifact, auth);
    await verifyRelease(options.repo, tag, artifact);
    console.log(
        `\n✔ ${tag} 已发布：https://github.com/${options.repo}/releases/tag/${tag}\n` +
            `  SHA256 ${artifact.sha256}\n` +
            `  发行说明源文件：${path.relative(ROOT, notesFile)}\n` +
            `  版本号、标签与安装包一致；旧客户端下次检查更新即可看到 ${version}。`,
    );
}

main().catch(error => {
    console.error(`\n✗ ${error.message}`);
    process.exitCode = 1;
});
