import {app, BrowserWindow} from 'electron';
import axios from 'axios';
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
    const sep = exe.download_url.includes('?') ? '&' : '?';
    result.downloadUrl = token
        ? `${exe.download_url}${sep}access_token=${encodeURIComponent(token)}`
        : exe.download_url;
    result.fileName = exe.show_name || `PulsarManager-${latestVersion}-Setup.exe`;
    result.size = exe.size;
    return result;
}

let downloading = false;
let lastDownloadedFile: string | null = null;

function broadcastProgress(payload: DownloadProgress): void {
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) {
            w.webContents.send('update:progress', payload);
        }
    }
}

export async function downloadUpdate(
    downloadUrl: string,
    fileName: string,
    expectedUrl: string | undefined,
): Promise<string> {
    // 只允许下载最近一次 check 给出的地址，渲染层无法借这个通道拉任意 URL
    if (!expectedUrl || downloadUrl !== expectedUrl) {
        throw new Error('下载地址与最近一次检查结果不一致，请重新检查更新');
    }
    if (!isAllowedAssetUrl(downloadUrl)) {
        throw new Error('下载地址不是受信任的 gitee 域名');
    }
    if (downloading) {
        throw new Error('已有下载任务在进行中');
    }
    downloading = true;
    const safeName = path.basename(fileName).replace(/[^\w.\-一-龥]/g, '_');
    const dir = path.join(app.getPath('userData'), 'updates');
    const target = path.join(dir, safeName);
    const part = `${target}.part`;
    try {
        fs.mkdirSync(dir, {recursive: true});
        const resp = await axios.get(downloadUrl, {responseType: 'stream', timeout: 0, maxRedirects: 5});
        const total = Number(resp.headers['content-length'] || 0);
        const out = fs.createWriteStream(part);
        let received = 0;
        let lastEmit = 0;
        resp.data.on('data', (chunk: Buffer) => {
            received += chunk.length;
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
        fs.renameSync(part, target);
        lastDownloadedFile = target;
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
    // NSIS 支持 /SILENT 静默覆盖安装；detached 后主进程退出，安装器继续跑
    const child = spawn(lastDownloadedFile, ['/SILENT'], {detached: true, stdio: 'ignore'});
    child.on('error', err => {
        log.error(`Failed to launch installer: ${err.message}`);
    });
    child.unref();
    app.quit();
}
