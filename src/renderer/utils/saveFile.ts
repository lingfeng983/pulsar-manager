/**
 * 所有「导出」的唯一出口。
 *
 * 以前各页面各自走 Blob → objectURL → a.click，文件由 WebView2 静默写进默认下载目录，
 * 用户既选不了位置也不知道文件去哪了。现在统一交给后台的 file:saveText：
 * 由系统「另存为」对话框决定位置，成功后回显完整路径。内容仍由各页面生成
 * （消息 JSON/CSV、巡检 Markdown、配置包、快捷键……），这里不关心格式。
 */
export interface SaveTextResult {
    /** 用户在系统对话框里点了取消，不算失败，也不该弹错误提示 */
    cancelled: boolean;
    path?: string;
    error?: string;
}

export async function saveTextFile(content: string, filename: string, title = '导出文件'): Promise<SaveTextResult> {
    try {
        const response = await window.electronAPI.file.saveText({content, filename, title});
        if (!response.success) {
            return {cancelled: false, error: response.error || '导出失败'};
        }
        if (!response.data) {
            return {cancelled: true};
        }
        return {cancelled: false, path: response.data.path};
    } catch (error) {
        return {cancelled: false, error: error instanceof Error ? error.message : String(error)};
    }
}
