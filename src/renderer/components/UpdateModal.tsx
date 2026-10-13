import React, {useState, useEffect, useCallback, useRef} from 'react';
import {Modal, Alert, Button, Space, Input, Progress, Typography, Descriptions, message} from 'antd';

type CheckResult = NonNullable<Awaited<ReturnType<typeof window.electronAPI.update.check>>['data']>;

const formatBytes = (n: number): string =>
    n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;

// 令牌状态必须是三态：布尔初值 false 会让"读取中"先闪一条"未配置"的警告，
// 明明配好了却先看到红字。unknown 用来区分"读失败"和"确实没配"。
type TokenStatus = 'loading' | 'configured' | 'missing' | 'unknown';

const TOKEN_ALERT: Record<TokenStatus, {type: 'info' | 'success' | 'warning'; message: string}> = {
    loading: {type: 'info', message: '正在读取令牌状态...'},
    configured: {type: 'success', message: 'Gitee 访问令牌已配置'},
    missing: {type: 'warning', message: 'Gitee 访问令牌未配置（私有仓库检查更新必需）'},
    unknown: {type: 'warning', message: '令牌状态读取失败，可关闭后重新打开本窗口'},
};

const UpdateModal: React.FC<{open: boolean; onClose: () => void}> = ({open, onClose}) => {
    const [tokenStatus, setTokenStatus] = useState<TokenStatus>('loading');
    const [tokenInput, setTokenInput] = useState('');
    const [savingToken, setSavingToken] = useState(false);
    const [checking, setChecking] = useState(false);
    const [result, setResult] = useState<CheckResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [downloading, setDownloading] = useState(false);
    const [progress, setProgress] = useState<{received: number; total: number} | null>(null);
    const [downloaded, setDownloaded] = useState(false);
    // 检查请求代次：开窗触发的检查与"保存令牌/重试"触发的检查并发时，
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
        setTokenStatus('loading');
        void window.electronAPI.update
            .tokenStatus()
            .then(r => {
                if (r.success && r.data) {
                    setTokenStatus(r.data.configured ? 'configured' : 'missing');
                } else {
                    setTokenStatus('unknown');
                }
            })
            .catch(() => setTokenStatus('unknown'));
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
                setTokenStatus(tokenInput.trim() ? 'configured' : 'missing');
                void runCheck();
            } else {
                message.error(response.error || '保存失败');
            }
        } finally {
            setSavingToken(false);
        }
    };

    const handleDownload = async () => {
        if (!result?.downloadUrl) return;
        setDownloading(true);
        setError(null);
        setProgress({received: 0, total: result.size || 0});
        try {
            const response = await window.electronAPI.update.download(result.downloadUrl);
            if (!response.success) {
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

                <Alert
                    type={TOKEN_ALERT[tokenStatus].type}
                    showIcon
                    message={TOKEN_ALERT[tokenStatus].message}
                    description={
                        <Space direction="vertical" style={{width: '100%'}}>
                            <Space.Compact style={{width: '100%'}}>
                                <Input.Password
                                    value={tokenInput}
                                    onChange={e => setTokenInput(e.target.value)}
                                    placeholder={
                                        tokenStatus === 'configured'
                                            ? '输入新令牌可覆盖，留空保存即清除'
                                            : 'Gitee 私人令牌 (access_token)'
                                    }
                                    disabled={tokenStatus === 'loading'}
                                />
                                <Button
                                    loading={savingToken}
                                    disabled={tokenStatus === 'loading'}
                                    onClick={() => void handleSaveToken()}
                                >
                                    保存
                                </Button>
                            </Space.Compact>
                            <Typography.Text type="secondary" style={{fontSize: 'var(--font-size-xs)'}}>
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
