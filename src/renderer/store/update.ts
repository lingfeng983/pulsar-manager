import {create} from 'zustand';
import type {UpdateCheckResult} from '../api-contract';

// 「跳过此版本」与「稍后提醒」是这台机器上的 UI 状态，不是应用配置：
// 它跟着窗口走就够了，换个用户/换台机器不该继承"我不想升级"。
const SKIP_KEY = 'pulsar-manager.update.skipVersion';
const REMIND_KEY = 'pulsar-manager.update.remindAfter';
/** 「稍后提醒」的窗口：一周。短了像骚扰，长了等于没提醒。 */
const REMIND_MS = 7 * 24 * 60 * 60 * 1000;
/** 检查结果的保鲜期：弹窗打开时若结果还在这个窗口内，直接复用，不再吃一次限流额度。 */
const FRESH_MS = 10 * 60 * 1000;

function readSkip(): string {
    try {
        return localStorage.getItem(SKIP_KEY) || '';
    } catch {
        return '';
    }
}

function readRemindAfter(): number {
    try {
        return Number(localStorage.getItem(REMIND_KEY) || 0) || 0;
    } catch {
        return 0;
    }
}

function write(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // 隐私模式/配额满：只是这一次不记住，不该影响检查更新本身
    }
}

/** 是否有"值得提示"的更新：有新版，且没被跳过、也不在"稍后提醒"窗口里。 */
function worthPrompting(result: UpdateCheckResult | null): boolean {
    if (!result?.hasUpdate) {
        return false;
    }
    if (readSkip() === result.latestVersion) {
        return false;
    }
    return Date.now() >= readRemindAfter();
}

interface UpdateState {
    /** 最近一次检查结果，弹窗与顶栏共用 */
    result: UpdateCheckResult | null;
    checking: boolean;
    /** 检查失败的原文；silent 检查失败不写这里，免得静默检查把错误条挂到用户脸上 */
    error: string | null;
    checkedAt: number;
    /** 顶栏是否要点提示：由 result + 跳过/稍后状态算出 */
    available: boolean;

    check: (options?: {silent?: boolean}) => Promise<void>;
    /** 用户看到弹窗后选择「稍后提醒」：7 天内不再提示 */
    remindLater: () => void;
    /** 用户选择「跳过此版本」：这个版本号以后都不提示（更高版本仍会提示） */
    skipVersion: () => void;
    /** 「已是最新」或手动关掉提示 */
    clear: () => void;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
    result: null,
    checking: false,
    error: null,
    checkedAt: 0,
    available: false,

    check: async (options = {}) => {
        const silent = options.silent === true;
        set({checking: true, error: silent ? get().error : null});
        try {
            const response = await window.electronAPI.update.check();
            if (response.success && response.data) {
                set({
                    result: response.data,
                    error: null,
                    checkedAt: Date.now(),
                    available: worthPrompting(response.data),
                });
            } else if (!silent) {
                set({error: response.error || '检查更新失败'});
            }
        } catch (error) {
            if (!silent) {
                set({error: (error as Error).message || String(error)});
            }
        } finally {
            set({checking: false});
        }
    },

    remindLater: () => {
        write(REMIND_KEY, String(Date.now() + REMIND_MS));
        set({available: false});
    },

    skipVersion: () => {
        const latest = get().result?.latestVersion;
        if (latest) {
            write(SKIP_KEY, latest);
        }
        set({available: false});
    },

    clear: () => set({available: false}),
}));

/** 结果的保鲜判断：弹窗打开时用它决定"直接展示"还是"重新检查一次"。 */
export function isFresh(result: UpdateCheckResult | null, checkedAt: number): boolean {
    return Boolean(result) && Date.now() - checkedAt < FRESH_MS;
}
