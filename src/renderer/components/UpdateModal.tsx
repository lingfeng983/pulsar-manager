import React, {useState, useEffect, useRef} from 'react';
import {Modal, Alert, Button, Space, Progress, Typography, Descriptions, message} from 'antd';
import {useUpdateStore, isFresh} from '../store/update';
import {renderMarkdown} from '../utils/markdown';

const formatBytes = (n: number): string =>
    n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/**
 * 软件更新弹窗。
 *
 * 检查结果放在 store 里：顶栏的提示点与这个弹窗看的是同一份数据，打开弹窗不该再花一次
 * 匿名限流额度。下载进度仍在本地——它是"这一次点击"的过程状态，关掉弹窗就没了意义
 * （主进程的下载不会因为关窗中断，重新打开时会以返回值兜底成"已下载"）。
 */
const UpdateModal: React.FC<{open: boolean; onClose: () => void; force?: boolean}> = ({open, onClose, force}) => {
    const result = useUpdateStore(state => state.result);
    const checking = useUpdateStore(state => state.checking);
    const checkError = useUpdateStore(state => state.error);
    const checkedAt = useUpdateStore(state => state.checkedAt);
    const check = useUpdateStore(state => state.check);
    const remindLater = useUpdateStore(state => state.remindLater);
    const skipVersion = useUpdateStore(state => state.skipVersion);

    const [downloading, setDownloading] = useState(false);
    const [progress, setProgress] = useState<{received: number; total: number} | null>(null);
    const [retrying, setRetrying] = useState('');
    const [downloaded, setDownloaded] = useState(false);
    const [downloadError, setDownloadError] = useState<string | null>(null);
    // 每次"打开"只自动检查一次：结果还新鲜就复用，避免反复开窗反复吃限流额度
    const requestedRef = useRef(false);

    useEffect(() => {
        if (!open) {
            requestedRef.current = false;
            return;
        }
        if (requestedRef.current) {
            return;
        }
        requestedRef.current = true;
        setDownloadError(null);
        // force = 用户在菜单里明确点了「检查更新」：这时不能拿十分钟前的缓存糊弄他
        if (force || !isFresh(result, checkedAt)) {
            void check();
        }
    }, [open, force, result, checkedAt, check]);

    useEffect(() => {
        // 订阅常开：下载可能比弹窗活得更久，关窗期间不能丢 done 事件，
        // 否则重新打开时会永远停在"下载中"。
        return window.electronAPI.update.onProgress(event => {
            if (event.cancelled) {
                setDownloading(false);
                setProgress(null);
                setRetrying('');
                message.info('已取消下载');
                return;
            }
            if (event.error) {
                setDownloading(false);
                setProgress(null);
                setRetrying('');
                setDownloadError(event.error);
                return;
            }
            if (event.retrying) {
                // 断线重连：进度会从断点继续，这里只说明"在重试"，不清空进度条
                setRetrying(`网络中断，正在续传（第 ${event.retrying}/${event.attempts ?? 3} 次重试）`);
                return;
            }
            if (event.done) {
                setDownloading(false);
                setProgress(null);
                setRetrying('');
                setDownloaded(true);
                return;
            }
            setProgress({received: event.received, total: event.total});
        });
    }, []);

    const handleDownload = async () => {
        if (!result?.downloadUrl) {
            return;
        }
        setDownloading(true);
        setDownloadError(null);
        setRetrying('');
        setProgress({received: 0, total: result.size || 0});
        try {
            const response = await window.electronAPI.update.download(result.downloadUrl);
            if (response.success) {
                // 下载只在文件落地后返回；done 事件可能在弹窗关闭期间错过，这里兜底
                setDownloaded(true);
            } else if (!(response.error || '').includes('取消')) {
                setDownloadError(response.error || '下载失败');
            }
        } catch (error) {
            setDownloadError(String(error));
        } finally {
            setDownloading(false);
            setProgress(null);
            setRetrying('');
        }
    };

    const handleCancelDownload = () => {
        void window.electronAPI.update.cancel();
    };

    const handleInstall = async () => {
        const response = await window.electronAPI.update.install();
        if (!response.success) {
            message.error(response.error || '启动安装程序失败');
            return;
        }
        // 成功时主进程随即退出；安装器装完会把新版本拉起来
        message.success('安装程序已启动，应用将在安装完成后自动重启');
    };

    const percent =
        progress && progress.total > 0 ? Math.min(99, Math.floor((progress.received / progress.total) * 100)) : 0;
    const error = downloadError || checkError;
    const hasUpdate = Boolean(result?.hasUpdate);

    return (
        <Modal
            title="软件更新"
            open={open}
            onCancel={onClose}
            maskClosable={!downloading}
            footer={
                <Space>
                    {hasUpdate && !downloading && !downloaded && (
                        <>
                            {/* 两个按钮都顺手关窗：选完就不再需要盯着这一屏 */}
                            <Button
                                onClick={() => {
                                    remindLater();
                                    onClose();
                                }}
                            >
                                稍后提醒（7 天）
                            </Button>
                            <Button
                                onClick={() => {
                                    skipVersion();
                                    onClose();
                                }}
                            >
                                跳过此版本
                            </Button>
                        </>
                    )}
                    {downloading && <Button onClick={handleCancelDownload}>取消下载</Button>}
                    <Button onClick={onClose}>关闭</Button>
                </Space>
            }
        >
            <Space direction="vertical" style={{width: '100%'}} size="small">
                {error && (
                    <Alert
                        type="error"
                        showIcon
                        message={error}
                        action={
                            <Button
                                size="small"
                                onClick={() => {
                                    // 哪一步失败就重来哪一步：下载失败重新下载，检查失败重新检查
                                    if (downloadError) {
                                        setDownloadError(null);
                                        void handleDownload();
                                    } else {
                                        void check();
                                    }
                                }}
                            >
                                重试
                            </Button>
                        }
                    />
                )}

                {checking && <Alert type="info" showIcon message="正在检查更新..." />}

                {result && !checking && (
                    // 标签列必须给固定宽度：表格是 auto 布局，更新说明那种整段 pre-wrap
                    // 的长文本会把标签列压到最小宽度，「当前版本」竖着一字一行。
                    <Descriptions column={1} size="small" bordered labelStyle={{width: 92, whiteSpace: 'nowrap'}}>
                        <Descriptions.Item label="当前版本">{result.currentVersion}</Descriptions.Item>
                        <Descriptions.Item label="最新版本">
                            {result.latestVersion}
                            {hasUpdate ? (
                                <Typography.Text style={{marginLeft: 8, color: 'var(--color-warning)'}}>
                                    可更新
                                </Typography.Text>
                            ) : (
                                <Typography.Text style={{marginLeft: 8, color: 'var(--color-success)'}}>
                                    已是最新
                                </Typography.Text>
                            )}
                        </Descriptions.Item>
                        {hasUpdate && result.releaseNotes && (
                            <Descriptions.Item label="更新说明">
                                {/* 说明是仓库里的 Markdown，渲染后必须过 DOMPurify（在 renderMarkdown 里） */}
                                <div
                                    className="md-body update-notes"
                                    dangerouslySetInnerHTML={{__html: renderMarkdown(result.releaseNotes)}}
                                />
                            </Descriptions.Item>
                        )}
                    </Descriptions>
                )}

                {hasUpdate && !downloading && !downloaded && result?.downloadUrl && (
                    <Space size={4} wrap>
                        <Typography.Text>
                            安装包：{result.fileName}
                            {result.size ? `（${formatBytes(result.size)}）` : ''}
                        </Typography.Text>
                        <Button type="primary" onClick={() => void handleDownload()}>
                            下载安装包
                        </Button>
                    </Space>
                )}

                {downloading && (
                    <Space direction="vertical" style={{width: '100%'}} size={4}>
                        <Progress percent={percent} status="active" />
                        <Typography.Text type="secondary" style={{fontSize: 'var(--font-size-xs)'}}>
                            {retrying ||
                                (progress && progress.total > 0
                                    ? `已下载 ${formatBytes(progress.received)} / ${formatBytes(progress.total)}`
                                    : `已下载 ${formatBytes(progress?.received ?? 0)}（服务端未报告总大小）`)}
                        </Typography.Text>
                    </Space>
                )}

                {downloaded && (
                    <Alert
                        type="success"
                        showIcon
                        message="安装包已下载并通过 SHA256 校验，安装时应用会自动退出，装完自动重启"
                        action={
                            <Button type="primary" size="small" onClick={() => void handleInstall()}>
                                立即安装
                            </Button>
                        }
                    />
                )}
            </Space>
        </Modal>
    );
};

export default UpdateModal;
