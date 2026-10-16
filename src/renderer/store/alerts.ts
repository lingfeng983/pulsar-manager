import {create} from 'zustand';
import {message} from 'antd';
import type {AlertEvent, AlertProbeResult, AlertPush, AlertRule, AlertRuleUpsertParams} from '../types';
import {formatAlertValue} from '../../shared/alert-metrics';

interface AlertState {
    rules: AlertRule[];
    events: AlertEvent[];
    // 未恢复事件数：TopNav 的徽标读的就是它。它单独存而不是从 events 里数，
    // 因为事件列表有 limit，徽标却必须反映全部立案中的告警。
    openCount: number;
    loading: boolean;
    error: string | null;
    loaded: boolean;

    refresh: () => Promise<void>;
    saveRule: (params: AlertRuleUpsertParams) => Promise<AlertRule | null>;
    removeRule: (id: string) => Promise<boolean>;
    probe: (id: string) => Promise<AlertProbeResult>;
    ack: (ids: number[]) => Promise<boolean>;
    removeEvents: (ids: number[]) => Promise<boolean>;
    applyPush: (push: AlertPush) => void;
}

interface AlertListResponse {
    rules?: AlertRule[];
    events?: AlertEvent[];
    openCount?: number;
    error?: string;
}

// 三条取数一起失败才算"加载失败"：单条通道出错时其余两份数据仍是有效的，
// 整页压成错误块反而把能看的藏起来了。
async function fetchAll(): Promise<AlertListResponse> {
    const [rules, events, open] = await Promise.all([
        window.electronAPI.alert.listRules(),
        window.electronAPI.alert.listEvents({limit: 500}),
        window.electronAPI.alert.countOpen(),
    ]);
    if (!rules.success && !events.success) {
        return {error: rules.error || events.error || '告警数据读取失败'};
    }
    return {
        rules: rules.success ? rules.data || [] : undefined,
        events: events.success ? events.data || [] : undefined,
        openCount: open.success ? open.data || 0 : undefined,
    };
}

export const useAlertStore = create<AlertState>((set, get) => ({
    rules: [],
    events: [],
    openCount: 0,
    loading: false,
    error: null,
    loaded: false,

    refresh: async () => {
        set({loading: true, error: null});
        try {
            const result = await fetchAll();
            if (result.error) {
                set({loading: false, error: result.error});
                return;
            }
            set(state => ({
                rules: result.rules ?? state.rules,
                events: result.events ?? state.events,
                openCount: result.openCount ?? state.openCount,
                loading: false,
                loaded: true,
            }));
        } catch (error) {
            set({loading: false, error: (error as Error).message});
        }
    },

    saveRule: async params => {
        const response = await window.electronAPI.alert.upsertRule(params);
        if (!response.success || !response.data) {
            message.error(response.error || '保存规则失败');
            return null;
        }
        const saved = response.data;
        set(state => ({
            // 覆盖同一行而不是追加：新建时 id 是库里生成的 uuid，这里不可能撞车，
            // 撞上的只会是"编辑已有规则"，追加会变成两条同名行。
            rules: state.rules.some(rule => rule.id === saved.id)
                ? state.rules.map(rule => (rule.id === saved.id ? saved : rule))
                : [saved, ...state.rules],
        }));
        return saved;
    },

    removeRule: async id => {
        const response = await window.electronAPI.alert.deleteRule(id);
        if (!response.success) {
            message.error(response.error || '删除规则失败');
            return false;
        }
        // 规则行删了，指向它的事件在库里被 CASCADE 一起删掉了，列表必须整份重取
        set(state => ({rules: state.rules.filter(rule => rule.id !== id)}));
        await get().refresh();
        return true;
    },

    probe: async id => {
        const response = await window.electronAPI.alert.testRule(id);
        if (!response.success || !response.data) {
            throw new Error(response.error || '试跑失败');
        }
        return response.data;
    },

    ack: async ids => {
        const response = await window.electronAPI.alert.ackEvents(ids);
        if (!response.success) {
            message.error(response.error || '确认失败');
            return false;
        }
        const ackedAt = Date.now();
        set(state => ({
            events: state.events.map(event =>
                ids.includes(event.id) && event.ackedAt == null ? {...event, ackedAt} : event,
            ),
        }));
        return true;
    },

    removeEvents: async ids => {
        const response = await window.electronAPI.alert.deleteEvents(ids);
        if (!response.success) {
            message.error(response.error || '删除事件失败');
            return false;
        }
        const removed = new Set(ids);
        // 删掉的里面若有未恢复的，徽标要跟着降，否则数字和列表对不上
        const firingRemoved = get().events.filter(event => removed.has(event.id) && event.state === 'firing').length;
        set(current => ({
            events: current.events.filter(event => !removed.has(event.id)),
            openCount: Math.max(0, current.openCount - firingRemoved),
        }));
        return true;
    },

    applyPush: push => {
        const {event, kind} = push;
        const text =
            kind === 'fired'
                ? `告警：${event.ruleName}（当前 ${formatAlertValue(event.metric, event.value)}）`
                : `已恢复：${event.ruleName}（当前 ${formatAlertValue(event.metric, event.lastValue)}）`;
        if (kind === 'fired') {
            message.warning(text, 6);
        } else {
            message.success(text, 4);
        }
        set(state => ({
            openCount: Math.max(0, state.openCount + (kind === 'fired' ? 1 : -1)),
            events: state.loaded
                ? [event, ...state.events.filter(item => item.id !== event.id)].slice(0, 500)
                : state.events,
        }));
    },
}));

let runtimeStarted = false;

/**
 * 订阅引擎的下行推送（应用启动时调用一次，幂等）。
 * 放在 store 而不是页面里：窗口收进托盘后仍要有提醒，而页面那时可能根本没挂载。
 */
export function startAlertRuntime(): void {
    if (runtimeStarted) {
        return;
    }
    runtimeStarted = true;
    window.electronAPI.alert.onEvent(push => useAlertStore.getState().applyPush(push));
    void useAlertStore.getState().refresh();
}
