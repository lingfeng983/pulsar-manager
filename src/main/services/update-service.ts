import {app, BrowserWindow} from 'electron';
import axios from 'axios';
import type {AxiosResponse} from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {spawn} from 'child_process';
import {createLogger} from '../utils/logger';

const log = createLogger('Update');

// 发行版托管在 Gitee 私有仓库 lingfeng983/pulsar-manager，
// 私有仓库的 releases/attachments API 必须带 access_token 才能读取。
const GITEE_OWNER = 'lingfeng983';
const GITEE_REPO = 'pulsar-manager';
const API_BASE = 'https://gitee.com/api/v5';

export interface UpdateCheckResult {
    currentVersion: string;
    latestVersion: string;
    hasUpdate: boolean;
    releaseName?: string;
    releaseNotes?: string;
    downloadUrl?: string;
    fileName?: string;
    size?: number;
}

export interface DownloadProgress {
    received: number;
    total: number;
    done?: boolean;
    error?: string;
}

function parseVersion(v: string): number[] {
    return v
        .replace(/^v/, '')
        .split('.')
        .map(n => parseInt(n, 10) || 0);
}

export function compareVersions(a: string, b: string): number {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
}

function isAllowedAssetUrl(raw: string): boolean {
    try {
        const u = new URL(raw);
        return u.protocol === 'https:' && (u.hostname === 'gitee.com' || u.hostname.endsWith('.gitee.com'));
    } catch {
        return false;
    }
}

// 安装包上限 512MB：NSIS 包目前 1 亿字节上下，留一倍余量。没有这道闸，
// 一个谎报 Content-Length 或对端持续吐数据的响应就能把磁盘写满。
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

// 最近一次检查得到的下载目标。令牌只留在主进程：一旦把它拼进下发给渲染层的
// downloadUrl，页面里的任何脚本都能读走它。
interface PendingRelease {
    publicUrl: string;
    tokenizedUrl: string;
    fileName: string;
    size: number;
    sha256: string;
}

let pending: PendingRelease | null = null;

// release.sh 写发行说明时固定带一行 `- SHA256：\`<64 位十六进制>\``，
// 下载完按它校验；对不上就是包被换过（或仓库被篡改），不能装。
function sha256FromNotes(notes: string): string {
    const matched = /SHA256[：:]\s*`?([0-9a-fA-F]{64})`?/.exec(notes || '');
    if (!matched) {
        throw new Error('该发行版的说明里没有 SHA256，无法校验安装包，请先用 release.sh 重新发布');
    }
    return matched[1].toLowerCase();
}

export async function checkForUpdate(token: string | undefined): Promise<UpdateCheckResult> {
    const currentVersion = app.getVersion();
    const params: Record<string, string> = token ? {access_token: token} : {};

    const releasesResp = await axios.get(`${API_BASE}/repos/${GITEE_OWNER}/${GITEE_REPO}/releases`, {
        params,
        timeout: 15000,
    });
    const releases: Array<{tag_name?: string; name?: string; body?: string; id?: number | string}> = Array.isArray(
        releasesResp.data,
    )
        ? releasesResp.data
        : [];
    if (releases.length === 0) {
        throw new Error('仓库里还没有任何发行版');
    }

    // 不依赖 API 的排序约定：直接取版本号最大的 tag
    const latest = releases.reduce((best, r) =>
        r.tag_name && compareVersions(r.tag_name, best.tag_name || '0') > 0 ? r : best,
    );
    if (!latest.tag_name) {
        throw new Error('最新发行版缺少 tag');
    }
    const latestVersion = latest.tag_name.replace(/^v/, '');
    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

    const result: UpdateCheckResult = {
        currentVersion,
        latestVersion,
        hasUpdate,
        releaseName: latest.name || latest.tag_name,
        releaseNotes: latest.body || '',
    };
    if (!hasUpdate || !latest.id) {
        return result;
    }

    const attResp = await axios.get(
        `${API_BASE}/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/${latest.id}/attachments`,
        {
            params,
            timeout: 15000,
        },
    );
    const attachments: Array<{show_name?: string; name?: string; download_url?: string; url?: string; size?: number}> =
        Array.isArray(attResp.data) ? attResp.data : [];
    const exe = attachments
        .filter(a => {
            const n = a.show_name || a.name || '';
            return n.toLowerCase().endsWith('.exe') && !!a.download_url;
        })
        // 同版本可能有多个 exe，取名字含"安装包"的，再退化为最大的那个
        .sort((a, b) => {
            const aPkg = (a.show_name || '').includes('安装包') ? 1 : 0;
            const bPkg = (b.show_name || '').includes('安装包') ? 1 : 0;
            if (aPkg !== bPkg) return bPkg - aPkg;
            return (b.size || 0) - (a.size || 0);
        })[0];
    if (!exe?.download_url) {
        throw new Error(`最新版本 ${latestVersion} 没有可下载的 exe 安装包附件`);
    }
    if (!isAllowedAssetUrl(exe.download_url)) {
        throw new Error('发行版附件地址不是受信任的 gitee 域名');
    }
    const sha256 = sha256FromNotes(latest.body || '');
    const sep = exe.download_url.includes('?') ? '&' : '?';
    // 私有仓库的附件地址必须带令牌才能拉下来，但令牌只留在主进程
    const tokenizedUrl = token
        ? `${exe.download_url}${sep}access_token=${encodeURIComponent(token)}`
        : exe.download_url;
    if (token && !isAllowedAssetUrl(tokenizedUrl)) {
        throw new Error('附件下载地址拼接令牌后不再是受信任的 gitee 域名');
    }
    pending = {
        publicUrl: exe.download_url,
        tokenizedUrl,
        fileName: exe.show_name || `PulsarManager-${latestVersion}-Setup.exe`,
        size: exe.size || 0,
        sha256,
    };
    result.downloadUrl = pending.publicUrl;
    result.fileName = pending.fileName;
    result.size = exe.size;
    return result;
}

let downloading = false;
let lastDownloadedFile: string | null = null;

function updatesDir(): string {
    return path.join(app.getPath('userData'), 'updates');
}

function broadcastProgress(payload: DownloadProgress): void {
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) {
            w.webContents.send('update:progress', payload);
        }
    }
}

function destroyStream(body: unknown): void {
    const s = body as {destroy?: () => void; resume?: () => void} | null;
    if (s?.destroy) {
        s.destroy();
    } else {
        s?.resume?.();
    }
}

// axios 自己跟重定向时不会复查每一跳的域名，而 maxRedirects: 0 会让它直接用原生
// https 把 3xx 原样返回。这里手动一跳一跳跟，每跳都过 isAllowedAssetUrl——否则
// 一个把 Location 指向外部主机的响应会把 access_token 跟着发出去。
const MAX_REDIRECT_HOPS = 5;

async function openTrustedStream(url: string): Promise<AxiosResponse<fs.ReadStream>> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
        if (!isAllowedAssetUrl(current)) {
            throw new Error('下载地址（含重定向目标）不是受信任的 gitee 域名');
        }
        const resp = await axios.get<fs.ReadStream>(current, {
            responseType: 'stream',
            timeout: 0,
            maxRedirects: 0,
            validateStatus: () => true,
        });
        const status = resp.status;
        if (status >= 300 && status < 400) {
            destroyStream(resp.data);
            const location = resp.headers.location;
            if (!location) {
                throw new Error(`下载被重定向（HTTP ${status}）但没有 Location`);
            }
            current = new URL(location, current).toString();
            continue;
        }
        if (status < 200 || status >= 300) {
            destroyStream(resp.data);
            throw new Error(`下载失败：HTTP ${status}`);
        }
        return resp;
    }
    throw new Error('下载地址重定向次数过多');
}

// 保存路径只能落在 userData/updates 里且必须是 .exe：文件名来自发行版附件名，
// 不能让它带 ../ 或改成 .bat。
function packageTarget(dir: string, fileName: string): {target: string; part: string} {
    const safeName = path.basename(fileName).replace(/[^\w.\-一-龥]/g, '_');
    if (!safeName.toLowerCase().endsWith('.exe')) {
        throw new Error('安装包文件名必须以 .exe 结尾');
    }
    const target = path.resolve(dir, safeName);
    if (!target.startsWith(path.resolve(dir) + path.sep)) {
        throw new Error('安装包保存路径非法');
    }
    return {target, part: `${target}.part`};
}

// 更新目录里只留当前这一个包；每次成功下载后把旧包和残留的 .part 清掉，
// 否则反复升级会把 userData 越堆越大。
function pruneOldPackages(dir: string, keep: string): void {
    for (const name of fs.readdirSync(dir)) {
        if (!/\.(exe|part)$/i.test(name)) {
            continue;
        }
        const full = path.join(dir, name);
        if (full === keep) {
            continue;
        }
        try {
            fs.rmSync(full, {force: true});
        } catch (error) {
            log.warn(`Failed to remove old update package ${name}: ${String(error)}`);
        }
    }
}

export async function downloadUpdate(downloadUrl: string): Promise<string> {
    // 只允许下载最近一次 check 给出的地址，渲染层无法借这个通道拉任意 URL；
    // 令牌也只在主进程内部使用，这里用的是不含令牌的 publicUrl。
    if (!pending) {
        throw new Error('请先检查更新');
    }
    if (downloadUrl !== pending.publicUrl) {
        throw new Error('下载地址与最近一次检查结果不一致，请重新检查更新');
    }
    if (downloading) {
        throw new Error('已有下载任务在进行中');
    }
    downloading = true;
    const dir = updatesDir();
    const {target, part} = packageTarget(dir, pending.fileName);
    try {
        fs.mkdirSync(dir, {recursive: true});
        const resp = await openTrustedStream(pending.tokenizedUrl);
        const total = Number(resp.headers['content-length'] || 0);
        if (total > MAX_DOWNLOAD_BYTES) {
            destroyStream(resp.data);
            throw new Error(`安装包过大（${total} 字节），上限 ${MAX_DOWNLOAD_BYTES} 字节`);
        }
        const out = fs.createWriteStream(part);
        const hasher = crypto.createHash('sha256');
        let received = 0;
        let lastEmit = 0;
        resp.data.on('data', (chunk: Buffer) => {
            received += chunk.length;
            hasher.update(chunk);
            if (received > MAX_DOWNLOAD_BYTES) {
                resp.data.destroy(new Error(`安装包超过 ${MAX_DOWNLOAD_BYTES} 字节上限`));
                return;
            }
            if (Date.now() - lastEmit > 200) {
                lastEmit = Date.now();
                broadcastProgress({received, total});
            }
        });
        await new Promise<void>((resolve, reject) => {
            resp.data.on('error', reject);
            out.on('error', reject);
            out.on('finish', () => resolve());
            resp.data.pipe(out);
        });
        if (total > 0 && received !== total) {
            throw new Error(`下载不完整（${received}/${total} 字节）`);
        }
        const actualSha = hasher.digest('hex');
        if (actualSha !== pending.sha256) {
            throw new Error('安装包 SHA256 校验不通过（下载损坏或发行包被替换），不能安装');
        }
        fs.renameSync(part, target);
        lastDownloadedFile = target;
        pruneOldPackages(dir, target);
        broadcastProgress({received, total, done: true});
        log.info(`Update downloaded: ${target}`);
        return target;
    } catch (error) {
        fs.rm(part, {force: true}, () => {});
        const msg = error instanceof Error ? error.message : String(error);
        broadcastProgress({received: 0, total: 0, error: msg});
        throw error instanceof Error ? error : new Error(msg);
    } finally {
        downloading = false;
    }
}

export function installLastDownload(): void {
    if (!lastDownloadedFile || !fs.existsSync(lastDownloadedFile)) {
        throw new Error('尚未下载完成，请先下载安装包');
    }
    if (!lastDownloadedFile.toLowerCase().endsWith('.exe')) {
        throw new Error('安装包文件类型非法');
    }
    const installer = lastDownloadedFile;
    // NSIS 支持 /SILENT 静默覆盖安装，但正在退出的进程自己占着 exe 和 dll，
    // 安装器同时写会文件占用失败或装出半个新版本。等 quit 之后再拉起。
    app.once('quit', () => {
        const child = spawn(installer, ['/SILENT'], {detached: true, stdio: 'ignore'});
        child.on('error', err => {
            log.error(`Failed to launch installer: ${err.message}`);
        });
        child.unref();
    });
    app.quit();
}
