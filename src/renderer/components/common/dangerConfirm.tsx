import React, {useCallback, useEffect, type ReactNode} from 'react';
import {Input, Modal, Space, message} from 'antd';

type ModalApi = ReturnType<typeof Modal.useModal>[0];

let modalApi: ModalApi | null = null;

// 静态 Modal.confirm 拿不到 ConfigProvider 的主题，暗色下会渲染成亮色弹窗；
// 所有危险确认统一走这里注册的 useModal 实例（宿主挂在 App 的 ConfigProvider 之内）。
export const DangerConfirmHost: React.FC = () => {
    const [api, contextHolder] = Modal.useModal();

    useEffect(() => {
        modalApi = api;
        return () => {
            modalApi = null;
        };
    }, [api]);

    return <>{contextHolder}</>;
};

export interface DangerConfirmOptions {
    title: string;
    description: ReactNode;
    okText?: string;
    /** 需要原样输入该名称才能确认（规范 §8：高危操作强制输入资源名） */
    requireExactName?: string;
    /** onOk 抛错时 antd 会保持弹窗打开，失败不会被静默关掉 */
    onOk: () => Promise<void> | void;
}

/**
 * 需要主题化的非危险类弹窗（输入框、普通确认）从这里取实例。
 * 静态 Modal.confirm 不读 ConfigProvider，暗色主题下会渲染成亮色弹窗。
 * 宿主未挂载时返回 null，调用方直接放弃——静默退化到静态实现会让主题问题重新出现。
 */
export function themedModal(): ModalApi | null {
    if (!modalApi) {
        console.error('[themedModal] DangerConfirmHost 未挂载，弹窗被忽略');
        return null;
    }
    return modalApi;
}

export function useConfirmDanger() {
    // 引用保持稳定：调用方把它写进 useCallback / useMemo 依赖时不会每次渲染都重建
    return useCallback((options: DangerConfirmOptions) => {
        const {title, description, okText = '删除', requireExactName, onOk} = options;
        if (!modalApi) {
            console.error('[confirmDanger] DangerConfirmHost 未挂载，确认框被忽略');
            return;
        }
        let nameMatches = !requireExactName;

        // antd 只会保持弹窗打开，不会把 onOk 抛出的错误渲染出来；不在这里补一条
        // toast，用户看到的就是"点了删除没反应"。
        const runOk = async () => {
            try {
                await onOk();
            } catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                message.error(text || '操作失败');
                // 继续抛给 antd：失败时弹窗保持打开，用户可以改名重试或取消
                throw error;
            }
        };

        const instance = modalApi.confirm({
            title,
            okText,
            cancelText: '取消',
            okButtonProps: {danger: true, disabled: !nameMatches},
            content: requireExactName ? (
                <Space direction="vertical" size={8} style={{width: '100%'}}>
                    <div>{description}</div>
                    <Input
                        autoFocus
                        placeholder={`请输入「${requireExactName}」以确认`}
                        onChange={event => {
                            nameMatches = event.target.value === requireExactName;
                            instance.update({okButtonProps: {danger: true, disabled: !nameMatches}});
                        }}
                    />
                </Space>
            ) : (
                description
            ),
            onOk: runOk,
        });
    }, []);
}
