#!/usr/bin/env node
// Gitee 发行版发布助手（被 release.sh 调用，也可单独运行）。
//
//   node scripts/release-publish.mjs <tag> <标题文件> <正文文件> [安装包路径]
//
// 标题与正文必须经 UTF-8 文件传递，不能走命令行参数：Windows 控制台是 GBK，
// 中文经参数传进来会被破坏成 U+FFFD。
// 行为：tag 没有对应发行版就创建，有就更新标题与正文；随后上传附件，同名旧附件
// 先删掉，所以整个流程可以重复执行而不会留下两份附件。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const OWNER = 'lingfeng983';
const REPO = 'pulsar-manager';
const API = `https://gitee.com/api/v5/repos/${OWNER}/${REPO}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readToken() {
    const fromEnv = (process.env.GITEE_TOKEN || '').trim();
    if (fromEnv) {
        return fromEnv;
    }
    const file = path.join(ROOT, '.gitee_token');
    if (!fs.existsSync(file)) {
        throw new Error('缺少 Gitee 令牌：设置 GITEE_TOKEN 环境变量，或在仓库根目录放 .gitee_token');
    }
    return fs.readFileSync(file, 'utf8').trim();
}

// 令牌放在查询串里（GET/JSON 请求）或 multipart 字段里（上传），报错时统一抹掉
function redact(url) {
    return url.replace(/access_token=[^&]*/, 'access_token=***');
}

async function api(url, {method = 'GET', body, multipart = false} = {}) {
    const target = multipart ? url : `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(readToken())}`;
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

async function findRelease(tag) {
    try {
        const release = await api(`${API}/releases/tags/${encodeURIComponent(tag)}`);
        return release && release.id ? release : null;
    } catch (error) {
        if (error.message.includes('-> 404')) {
            return null;
        }
        throw error;
    }
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

async function uploadAttachment(releaseId, artifact) {
    const name = path.basename(artifact);
    const localSize = fs.statSync(artifact).size;
    const existing = (await api(`${API}/releases/${releaseId}/attach_files`)) || [];
    for (const item of existing) {
        const itemName = item.name || '';
        const itemShowName = item.show_name || '';
        const isSame = itemName === name || itemShowName === name;
        // 除同名之外，任何残留的 .exe 也一并删掉：应用内「检查更新」在一个发行版
        // 里按"最大的那个 exe"挑安装包，留旧包在原地就会把旧版本发给用户。
        const isStaleExe = itemName.toLowerCase().endsWith('.exe') || itemShowName.toLowerCase().endsWith('.exe');
        if (isSame || isStaleExe) {
            await api(`${API}/releases/${releaseId}/attach_files/${item.id}`, {method: 'DELETE'});
            console.log(`已删除旧附件 ${itemName || itemShowName}（id=${item.id}）`);
        }
    }
    const form = new FormData();
    form.append('access_token', readToken());
    form.append('release_id', String(releaseId));
    form.append('file', new Blob([fs.readFileSync(artifact)]), name);
    const uploaded = await api(`${API}/releases/${releaseId}/attach_files`, {
        method: 'POST',
        body: form,
        multipart: true,
    });
    // Gitee 附件有 100MB 硬上限，超限时它可能返回 2xx 却只收下截断后的内容；
    // 不核对就完成发布会把坏包变成"最新发行版"，所有客户端都会下它。
    if (Number(uploaded.size) !== localSize) {
        throw new Error(`上传后 Gitee 记录 ${uploaded.size} 字节，与本地 ${localSize} 字节不符`);
    }
    const listed = ((await api(`${API}/releases/${releaseId}/attach_files`)) || []).find(
        item => item.name === name || item.show_name === name,
    );
    if (!listed) {
        throw new Error(`上传接口返回成功，但附件列表里没有 ${name}`);
    }
    console.log(`已上传 ${uploaded.name}（${uploaded.size} 字节）`);
    console.log(`download=${uploaded.browser_download_url}`);
}

async function main() {
    const [tag, titleFile, bodyFile, artifactArg] = process.argv.slice(2);
    if (!tag || !titleFile || !bodyFile) {
        throw new Error('用法: node scripts/release-publish.mjs <tag> <标题文件> <正文文件> [安装包路径]');
    }
    const name = fs.readFileSync(titleFile, 'utf8').trim();
    const body = fs.readFileSync(bodyFile, 'utf8').trim();
    const artifact = resolveArtifact(artifactArg, tag);

    const payload = JSON.stringify({
        access_token: readToken(),
        tag_name: tag,
        target_commitish: 'master',
        name,
        body,
    });
    const existing = await findRelease(tag);
    // Gitee 的 PATCH 要求 tag_name 与 body 必传，否则 400
    const release = existing
        ? await api(`${API}/releases/${existing.id}`, {method: 'PATCH', body: payload})
        : await api(`${API}/releases`, {method: 'POST', body: payload});
    console.log(`${existing ? 'updated' : 'created'} release id=${release.id} tag=${tag}`);

    await uploadAttachment(release.id, artifact);
    console.log(`page=https://gitee.com/${OWNER}/${REPO}/releases/tag/${tag}`);
}

main().catch(error => {
    console.error(`!! ${error.message}`);
    process.exit(1);
});
