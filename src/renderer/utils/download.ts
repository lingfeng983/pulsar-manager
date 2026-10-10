/**
 * 触发浏览器下载。TopNav 的日志导出与 MessageBrowser 的消息导出此前各自
 * 重复了同一套 Blob → objectURL → a.click → revoke 流程。
 */
export function downloadBlob(content: string, filename: string, mimeType = 'application/json'): void {
    const blob = new Blob([content], {type: mimeType});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // 同一 tick 内 revoke 可能掐断尚未开始的下载，推迟到下一个宏任务。
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
