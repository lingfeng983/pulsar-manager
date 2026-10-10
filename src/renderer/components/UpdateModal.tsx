import React, {useState, useEffect, useCallback} from 'react';
import {Modal, Alert, Button, Space, Input, Progress, Typography, Descriptions, message} from 'antd';

type CheckResult = NonNullable<Awaited<ReturnType<typeof window.electronAPI.update.check>>['data']>;

const formatBytes = (n: number): string =>
    n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;

const UpdateModal: React.FC<{open: boolean; onClose: () => void}> = ({open, onClose}) => {
    const [tokenConfigured, setTokenConfigured] = useState(false);
    const [tokenInput, setTokenInput] = useState('');
    const [savingToken, setSavingToken] = useState(false);
    const [checking, setChecking] = useState(false);
    const [result, setResult] = useState<CheckResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [downloading, setDownloading] = useState(false);
    const [progress, setProgress] = useState<{received: number; total: number} | null>(null);
    const [downloaded, setDownloaded] = useState(false);

    const runCheck = useCallback(async () => {
        setChecking(true);
        setError(null);
        setResult(null);
        setDownloaded(false);
        setProgress(null);
        try {
            const response = await window.electronAPI.update.check();
            if (response.success && response.data) {
                setResult(response.data);
            } else {
                setError(response.error || '检查更新失败');
            }
        } catch (e) {
            setError(String(e));
        } finally {
            setChecking(false);
        }
    }, []);

    useEffect(() => {
        if (!open) return;
        void window.electronAPI.update
            .tokenStatus()
            .then(r => r.success && r.data && setTokenConfigured(r.data.configured))
            .catch(() => {});
        void runCheck();
    }, [open, runCheck]);

    useEffect(() => {
        if (!open) return;
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
    }, [open]);

    const handleSaveToken = async () => {
        setSavingToken(true);
        try {
            const response = await window.electronAPI.update.setToken(tokenInput.trim());
            if (response.success) {
                message.info(tokenInput.trim() ? '令牌已保存' : '令牌已清除');
                setTokenInput('');
                setTokenConfigured(!!tokenInput.trim());
                void runCheck();
            } else {
                message.error(response.error || '保存失败');
            }
        } finally {
            setSavingToken(false);
        }
    };

    const handleDownload = async () => {
        if (!result?.downloadUrl || !result.fileName) return;
        setDownloading(true);
        setError(null);
        setProgress({received: 0, total: result.size || 0});
        const response = await window.electronAPI.update.download(result.downloadUrl, result.fileName);
        if (!response.success) {
            setDownloading(false);
            setError(response.error || '下载失败');
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
            <Space direction="vertical" style={{width: '100%'}} size="middle">
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
                    <Descriptions column={1} size="small" bordered>
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
                    <Space>
                        <Typography.Text>
                            安装包: {result.fileName}
                            {result.size ? `（${formatBytes(result.size)}）` : ''}
                        </Typography.Text>
                        <Button type="primary" onClick={() => void handleDownload()}>
                            下载并安装
                        </Button>
                    </Space>
                )}

                {downloading && <Progress percent={percent} status="active" />}

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

                <Alert
                    type={tokenConfigured ? 'success' : 'warning'}
                    showIcon
                    message={tokenConfigured ? 'Gitee 访问令牌已配置' : 'Gitee 访问令牌未配置（私有仓库检查更新必需）'}
                    description={
                        <Space direction="vertical" style={{width: '100%'}}>
                            <Space.Compact style={{width: '100%'}}>
                                <Input.Password
                                    value={tokenInput}
                                    onChange={e => setTokenInput(e.target.value)}
                                    placeholder={
                                        tokenConfigured
                                            ? '输入新令牌可覆盖，留空保存即清除'
                                            : 'Gitee 私人令牌 (access_token)'
                                    }
                                />
                                <Button loading={savingToken} onClick={() => void handleSaveToken()}>
                                    保存
                                </Button>
                            </Space.Compact>
                            <Typography.Text type="secondary" style={{fontSize: 12}}>
                                令牌在 Gitee「设置 → 私人令牌」创建，仅需只读仓库权限；本机加密保存，不会上传。
                            </Typography.Text>
                        </Space>
                    }
                />
            </Space>
        </Modal>
    );
};

export default UpdateModal;
