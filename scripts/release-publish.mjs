#!/usr/bin/env node
// Gitee 发行版发布助手（被 release.sh 调用，也可单独运行）。
//
//   node scripts/release-publish.mjs <tag> <标题文件> <正文文件> [安装包路径]
//
// 标题与正文必须经 UTF-8 文件传递，不能走命令行参数：Windows 控制台是 GBK，
// 中文经参数传进来会被破坏成 U+FFFD。
//
// 两个仓库各司其职：
//   源码仓（私有）留提交历史与发行说明，不再挂安装包；
//   分发仓（公开）只放发行版与安装包，应用内「检查更新」读它——公开仓库的
//   releases/attachments 读取不需要 access_token，用户就不用自己建令牌了。
// 安装包因此只上传一次（到分发仓），源码仓那个同名发行版上的历史 exe 会被删掉，
// 否则同一版本有两个渠道、两份可能对不上的包。
//
// 行为：分发仓不存在就创建（公开）；发行版没有就建、有就更新标题与正文；同名旧附件
// 先删再传；最后按版本号只保留最近 GITEE_DIST_KEEP（默认 3）个版本的安装包。
// 整个流程可以重复执行而不会留下重复发行版或重复附件。
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const OWNER = 'lingfeng983';
const REPO = process.env.GITEE_REPO || 'pulsar-manager';
const DIST_REPO = process.env.GITEE_DIST_REPO || 'pulsar-manager-dist';
const DIST_KEEP = Number(process.env.GITEE_DIST_KEEP || 3);
const API_BASE = 'https://gitee.com/api/v5';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 每个 API 请求都要读一次令牌：取到一次就记住，别每次为凭据管理器起一个子进程。
let cachedToken = '';
function readToken() {
    if (!cachedToken) {
        const fromEnv = (process.env.GITEE_TOKEN || '').trim();
        if (fromEnv) {
            cachedToken = fromEnv;
        } else {
            const file = path.join(ROOT, '.gitee_token');
            cachedToken = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : tokenFromCredentialManager();
        }
    }
    return cachedToken;
}

// 凭据管理器兜底：里面存的就是 git push 用的那枚私人令牌，Gitee 的 API 同样认它。
// 不在代码里写死默认值（加密也一样）——本脚本会随 dist 进 asar，内嵌令牌等于随安装包分发凭据。
function tokenFromCredentialManager() {
    // git credential-manager 从 stdin 读 protocol/host 请求，把存好的凭证打到 stdout。
    // helper 不存在或未存 gitee.com 时，子进程会非零退出或无输出，这里一律当"没取到"处理。
    // GCM_INTERACTIVE=never 让它查不到就立刻失败，而不是弹窗要登录——那样发版脚本会卡在
    // 一个界面看不见的交互提示上。
    const probe = spawnSync('git', ['credential-manager', 'get'], {
        input: 'protocol=https\nhost=gitee.com\n\n',
        encoding: 'utf8',
        env: {...process.env, GCM_INTERACTIVE: 'never'},
    });
    if (probe.error || probe.status !== 0 || !probe.stdout) {
        throw new Error(
            '缺少 Gitee 令牌：设置 GITEE_TOKEN 环境变量、在仓库根目录放 .gitee_token，' +
                '或先用 git 访问一次 gitee.com 让 Windows 凭据管理器存有令牌',
        );
    }
    const line = probe.stdout.split('\n').find(l => l.startsWith('password='));
    const token = line ? line.slice('password='.length).trim() : '';
    if (!token) {
        throw new Error(
            'Windows 凭据管理器里没有 gitee.com 的令牌记录：先用 git 访问一次 gitee.com，或改用 GITEE_TOKEN / .gitee_token',
        );
    }
    return token;
}

// 令牌放在查询串里（GET/JSON 请求）或 multipart 字段里（上传），报错时统一抹掉
function redact(url) {
    return url.replace(/access_token=[^&]*/, 'access_token=***');
}

async function api(url, {method = 'GET', body, multipart = false} = {}) {
    const target = multipart
        ? url
        : `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(readToken())}`;
    const response = await fetch(target, {
        method,
        body,
        headers: multipart ? undefined : {'Content-Type': 'application/json;charset=UTF-8'},
    });
    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        // 路由不存在时 Gitee 返回 HTML 错误页，不是 JSON
    }
    if (!response.ok) {
        const detail = data ? JSON.stringify(data) : text.replace(/\s+/g, ' ').slice(0, 200);
        throw new Error(`${method} ${redact(url)} -> ${response.status} ${detail}`);
    }
    return data;
}

const repoApi = repo => `${API_BASE}/repos/${OWNER}/${repo}`;

function statusOf(error) {
    const matched = /-> (\d{3})/.exec(error.message || '');
    return matched ? Number(matched[1]) : 0;
}

async function findRelease(repo, tag) {
    try {
        const release = await api(`${repoApi(repo)}/releases/tags/${encodeURIComponent(tag)}`);
        return release && release.id ? release : null;
    } catch (error) {
        if (statusOf(error) === 404) {
            return null;
        }
        throw error;
    }
}

// Gitee 的 PATCH 要求 tag_name 与 body 必传，否则 400，所以创建与更新共用同一份 payload
async function upsertRelease(repo, tag, name, body) {
    const payload = JSON.stringify({
        access_token: readToken(),
        tag_name: tag,
        target_commitish: 'master',
        name,
        body,
    });
    const existing = await findRelease(repo, tag);
    const release = existing
        ? await api(`${repoApi(repo)}/releases/${existing.id}`, {method: 'PATCH', body: payload})
        : await api(`${repoApi(repo)}/releases`, {method: 'POST', body: payload});
    console.log(`${repo}: ${existing ? '更新' : '创建'}发行版 id=${release.id} tag=${tag}`);
    return release;
}

function resolveArtifact(explicit, tag) {
    const dir = path.join(ROOT, 'release');
    const chosen = (() => {
        if (explicit) {
            if (!fs.existsSync(explicit)) {
                throw new Error(`找不到安装包：${explicit}`);
            }
            return explicit;
        }
        const candidates = fs.existsSync(dir)
            ? fs
                  .readdirSync(dir)
                  .filter(name => name.endsWith('.exe'))
                  .map(name => path.join(dir, name))
            : [];
        if (candidates.length === 0) {
            throw new Error('release/ 下没有 .exe，先跑 npm run electron:dist');
        }
        return candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    })();

    // 单独运行时取的是「release/ 里最新的那个 exe」，文件名不带标签版本号就中止：
    // 把 1.1.0 的包挂到 v1.2.0 标签上，等于给所有装了的机器推送一个内容对不上号
    // 的"新版本"，而更新通道一旦污染就再也收不回来。
    const version = tag.replace(/^v/, '');
    const name = path.basename(chosen);
    if (!name.includes(version)) {
        throw new Error(`安装包文件名 ${name} 与标签 ${tag} 的版本号不符，拒绝发布`);
    }
    return chosen;
}

async function listAttachments(repo, releaseId) {
    return (await api(`${repoApi(repo)}/releases/${releaseId}/attach_files`)) || [];
}

// 一个发行版里只该有一个 exe：应用内「检查更新」在有多个 exe 时按"最大的那个"挑，
// 留旧包在原地就会把旧版本发给用户。keepName 为 null 表示把 exe 全清掉。
async function dropExeAttachments(repo, releaseId, keepName) {
    for (const item of await listAttachments(repo, releaseId)) {
        const itemName = item.name || '';
        const itemShowName = item.show_name || '';
        const isExe = itemName.toLowerCase().endsWith('.exe') || itemShowName.toLowerCase().endsWith('.exe');
        if (isExe && itemName !== keepName && itemShowName !== keepName) {
            await api(`${repoApi(repo)}/releases/${releaseId}/attach_files/${item.id}`, {method: 'DELETE'});
            console.log(`${repo}: 删除旧附件 ${itemName || itemShowName}（id=${item.id}）`);
        }
    }
}

async function uploadAttachment(repo, releaseId, artifact) {
    const name = path.basename(artifact);
    const localSize = fs.statSync(artifact).size;
    await dropExeAttachments(repo, releaseId, null);
    const form = new FormData();
    form.append('access_token', readToken());
    form.append('release_id', String(releaseId));
    form.append('file', new Blob([fs.readFileSync(artifact)]), name);
    const uploaded = await api(`${repoApi(repo)}/releases/${releaseId}/attach_files`, {
        method: 'POST',
        body: form,
        multipart: true,
    });
    // Gitee 附件有 100MB 硬上限，超限时它可能返回 2xx 却只收下截断后的内容；
    // 不核对就完成发布会把坏包变成"最新发行版"，所有客户端都会下它。
    if (Number(uploaded.size) !== localSize) {
        throw new Error(`上传后 Gitee 记录 ${uploaded.size} 字节，与本地 ${localSize} 字节不符`);
    }
    const listed = (await listAttachments(repo, releaseId)).find(
        item => item.name === name || item.show_name === name,
    );
    if (!listed) {
        throw new Error(`上传接口返回成功，但附件列表里没有 ${name}`);
    }
    console.log(`${repo}: 已上传 ${uploaded.name}（${uploaded.size} 字节）`);
    return uploaded.browser_download_url;
}

// 分发仓不存在就建一个公开仓。公开是刻意的：它是唯一的匿名下载入口，里面只有
// 安装包与发行说明，源码仍然只在私有仓。
async function ensureDistRepo() {
    try {
        return await api(repoApi(DIST_REPO));
    } catch (error) {
        if (statusOf(error) !== 404) {
            throw error;
        }
    }
    const created = await api(`${API_BASE}/user/repos`, {
        method: 'POST',
        body: JSON.stringify({
            access_token: readToken(),
            name: DIST_REPO,
            // 建仓参数只有 private 可用（public 会回 "public is invalid"），而 Gitee
            // 又拒绝在空仓库上改可见性，所以这里先建出来，公开这一步由 ensureDistPublic 做
            private: false,
            description: 'Pulsar 管理工具安装包分发仓库（应用内自动更新源，只放发行版与安装包，源码在私有仓）',
        }),
    });
    console.log(`${DIST_REPO}: 已创建仓库 ${created.html_url || ''}（稍后设为公开）`);
    return created;
}

// 分发仓必须公开，否则用户读不到更新源。Gitee 不接受在空仓库上改可见性
// （"空仓库不支持设置为公开仓库"），所以这一步排在 release.sh 推完 README 锚点提交之后。
async function ensureDistPublic() {
    const repo = await api(repoApi(DIST_REPO));
    if (repo.public === true) {
        return repo;
    }
    // 建仓与改可见性都只认 private 参数（public 会回 "public is invalid"）
    await api(repoApi(DIST_REPO), {method: 'PATCH', body: JSON.stringify({name: DIST_REPO, private: false})});
    const after = await api(repoApi(DIST_REPO));
    if (after.public !== true) {
        throw new Error(`${DIST_REPO} 仍不是公开仓库：Gitee 拒绝把空仓库设为公开，请先确认 master 上已有提交`);
    }
    console.log(`${DIST_REPO}: 已设为公开仓库`);
    return after;
}

// 发行版必须挂在一条真实分支上（target_commitish=master），空仓库没有分支可指。
async function masterSha(repo) {
    try {
        const branch = await api(`${repoApi(repo)}/branches/master`);
        return (branch && branch.commit && branch.commit.sha) || '';
    } catch (error) {
        if (statusOf(error) === 404) {
            return '';
        }
        throw error;
    }
}

function versionOf(tag) {
    return (tag || '')
        .replace(/^v/, '')
        .split('.')
        .map(n => parseInt(n, 10) || 0);
}

function compareTags(a, b) {
    const pa = versionOf(a);
    const pb = versionOf(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
}

// 安装包一个 81MB，堆十几份就撞 Gitee 的仓库容量上限，所以分发仓只留最近几个版本。
// 删的是发行版（附件随之没了）；标签留着不碍事，也不影响脚本重复执行。
async function pruneDistReleases(currentTag) {
    const releases = (await api(`${repoApi(DIST_REPO)}/releases`)) || [];
    const sorted = releases.filter(r => r.tag_name).sort((a, b) => compareTags(b.tag_name, a.tag_name));
    const dropped = sorted.slice(DIST_KEEP);
    if (dropped.length === 0) {
        console.log(`${DIST_REPO}: 现有 ${sorted.length} 个发行版（保留上限 ${DIST_KEEP}），无需清理`);
        return;
    }
    for (const release of dropped) {
        // 刚发的这个版本绝不能被当成"最旧的"删掉：版本号解析异常时宁可跳过
        if (release.tag_name === currentTag) {
            continue;
        }
        await api(`${repoApi(DIST_REPO)}/releases/${release.id}`, {method: 'DELETE'});
        console.log(`${DIST_REPO}: 删除旧发行版 ${release.tag_name}（id=${release.id}）`);
    }
}

async function main() {
    const [tag, titleFile, bodyFile, artifactArg] = process.argv.slice(2);
    // release.sh 用它先建好分发仓、再拿 master 的 sha 决定要不要初始化提交
    if (tag === 'ensure-dist') {
        await ensureDistRepo();
        process.stdout.write(`${(await masterSha(DIST_REPO)) || ''}\n`);
        return;
    }
    if (!tag || !titleFile || !bodyFile) {
        throw new Error('用法: node scripts/release-publish.mjs <tag> <标题文件> <正文文件> [安装包路径]');
    }
    const name = fs.readFileSync(titleFile, 'utf8').trim();
    const body = fs.readFileSync(bodyFile, 'utf8').trim();
    const artifact = resolveArtifact(artifactArg, tag);

    await ensureDistRepo();
    if (!(await masterSha(DIST_REPO))) {
        throw new Error(
            `${DIST_REPO} 还没有 master 分支：发行版要挂在真实提交上。` +
                '先往该仓库推一个只含 README 的提交（release.sh 的第 4 步会自动做）',
        );
    }
    await ensureDistPublic();

    // 先发分发仓，源码仓的正文里才能带上准确的下载地址
    const distRelease = await upsertRelease(DIST_REPO, tag, name, body);
    const downloadUrl = await uploadAttachment(DIST_REPO, distRelease.id, artifact);
    const distPage = `https://gitee.com/${OWNER}/${DIST_REPO}/releases/tag/${tag}`;

    const sourceBody = `${body}\n\n- 安装包下载：${distPage}\n- 直链：${downloadUrl}`;
    const sourceRelease = await upsertRelease(REPO, tag, name, sourceBody);
    // 安装包只留一份（在分发仓）：源码仓这份是渠道切换前的遗留，留着就有两份可能对不上的包
    await dropExeAttachments(REPO, sourceRelease.id, null);

    await pruneDistReleases(tag);

    console.log(`page=${distPage}`);
    console.log(`download=${downloadUrl}`);
    console.log(`source-page=https://gitee.com/${OWNER}/${REPO}/releases/tag/${tag}`);
}

main().catch(error => {
    console.error(`!! ${error.message}`);
    process.exit(1);
});
