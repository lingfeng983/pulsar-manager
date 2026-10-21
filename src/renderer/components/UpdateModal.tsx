import React, {useState, useEffect, useCallback, useRef} from 'react';
import {Modal, Alert, Button, Space, Progress, Typography, Descriptions, message} from 'antd';

type CheckResult = NonNullable<Awaited<ReturnType<typeof window.electronAPI.update.check>>['data']>;

const formatBytes = (n: number): string =>
    n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;

const UpdateModal: React.FC<{open: boolean; onClose: () => void}> = ({open, onClose}) => {
    const [checking, setChecking] = useState(false);
    const [result, setResult] = useState<CheckResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [downloading, setDownloading] = useState(false);
    const [progress, setProgress] = useState<{received: number; total: number} | null>(null);
    const [downloaded, setDownloaded] = useState(false);
    // 检查请求代次：开窗触发的检查与错误条上的"重试"并发时，
    // 晚到的旧响应不能覆盖新结果。
    const checkRequestRef = useRef(0);

    const runCheck = useCallback(async () => {
        const requestId = ++checkRequestRef.current;
        const isStale = () => requestId !== checkRequestRef.current;
        setChecking(true);
        setError(null);
        setResult(null);
        setDownloaded(false);
        setProgress(null);
        try {
            const response = await window.electronAPI.update.check();
            if (isStale()) {
                return;
            }
            if (response.success && response.data) {
                setResult(response.data);
            } else {
                setError(response.error || '检查更新失败');
            }
        } catch (e) {
            if (isStale()) {
                return;
            }
            setError(String(e));
        } finally {
            if (!isStale()) {
                setChecking(false);
            }
        }
    }, []);

    useEffect(() => {
        if (!open) return;
        void runCheck();
    }, [open, runCheck]);

    useEffect(() => {
        // 订阅常开：下载可能比弹窗活得更久，关闭弹窗期间不能丢 done 事件，
        // 否则重新打开时会永远停在“下载中”。
        return window.electronAPI.update.onProgress(p => {
            if (p.error) {
                setDownloading(false);
                setError(p.error);
            } else if (p.done) {
                setDownloading(false);
                setDownloaded(true);
            } else {
                setProgress({received: p.received, total: p.total});
            }
        });
    }, []);

    const handleDownload = async () => {
        if (!result?.downloadUrl) return;
        setDownloading(true);
        setError(null);
        setProgress({received: 0, total: result.size || 0});
        try {
            const response = await window.electronAPI.update.download(result.downloadUrl);
            if (response.success) {
                // download() 只在文件落地后返回；done 事件可能在弹窗关闭期间错过，
                // 这里以返回值兜底，保证重新打开时能看到“立即安装”。
                setDownloading(false);
                setDownloaded(true);
            } else {
                setDownloading(false);
                setError(response.error || '下载失败');
            }
        } catch (e) {
            setDownloading(false);
            setError(String(e));
        } finally {
            setProgress(null);
        }
    };

    const handleInstall = async () => {
        const response = await window.electronAPI.update.install();
        if (!response.success) {
            message.error(response.error || '启动安装程序失败');
        }
        // 成功时主进程随即退出，应用整体关闭
    };

    const percent =
        progress && progress.total > 0 ? Math.min(99, Math.floor((progress.received / progress.total) * 100)) : 0;

    return (
        <Modal title="软件更新" open={open} onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
            <Space direction="vertical" style={{width: '100%'}} size="small">
                {error && (
                    <Alert
                        type="error"
                        showIcon
                        message={error}
                        action={
                            <Button size="small" onClick={() => void runCheck()}>
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
                            {result.hasUpdate && (
                                <Typography.Text style={{marginLeft: 8, color: 'var(--color-warning)'}}>
                                    可更新
                                </Typography.Text>
                            )}
                            {!result.hasUpdate && (
                                <Typography.Text style={{marginLeft: 8, color: 'var(--color-success)'}}>
                                    已是最新
                                </Typography.Text>
                            )}
                        </Descriptions.Item>
                        {result.hasUpdate && result.releaseNotes && (
                            <Descriptions.Item label="更新说明">
                                <div style={{whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto'}}>
                                    {result.releaseNotes}
                                </div>
                            </Descriptions.Item>
                        )}
                    </Descriptions>
                )}

                {result?.hasUpdate && !downloading && !downloaded && result.downloadUrl && (
                    <Space size={4}>
                        <Typography.Text>
                            安装包: {result.fileName}
                            {result.size ? `（${formatBytes(result.size)}）` : ''}
                        </Typography.Text>
                        <Button type="primary" onClick={() => void handleDownload()}>
                            下载并安装
                        </Button>
                    </Space>
                )}

                {downloading && (
                    <Space direction="vertical" style={{width: '100%'}} size={4}>
                        <Progress percent={percent} status="active" />
                        {progress && progress.total <= 0 && (
                            <Typography.Text type="secondary" style={{fontSize: 'var(--font-size-xs)'}}>
                                已下载 {formatBytes(progress.received)}（服务端未报告总大小）
                            </Typography.Text>
                        )}
                    </Space>
                )}

                {downloaded && (
                    <Alert
                        type="success"
                        showIcon
                        message="下载完成，安装后将自动重启应用"
                        action={
                            <Button type="primary" size="small" onClick={() => void handleInstall()}>
                                立即安装并重启
                            </Button>
                        }
                    />
                )}
            </Space>
        </Modal>
    );
};

export default UpdateModal;
