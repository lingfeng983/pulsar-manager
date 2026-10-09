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

function resolveArtifact(explicit) {
    if (explicit) {
        if (!fs.existsSync(explicit)) {
            throw new Error(`找不到安装包：${explicit}`);
        }
        return explicit;
    }
    const dir = path.join(ROOT, 'release');
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
}

async function uploadAttachment(releaseId, artifact) {
    const name = path.basename(artifact);
    const existing = (await api(`${API}/releases/${releaseId}/attach_files`)) || [];
    for (const item of existing) {
        if (item.name === name) {
            await api(`${API}/releases/${releaseId}/attach_files/${item.id}`, {method: 'DELETE'});
            console.log(`已删除同名旧附件 ${name}（id=${item.id}）`);
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
    const artifact = resolveArtifact(artifactArg);

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
