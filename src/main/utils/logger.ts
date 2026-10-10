import fs from 'fs';
import path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

// 安装版（Windows GUI 子系统）没有控制台：只往 console 打的日志等于没打，
// 「装完双击没反应」「更新装不上」这类问题用户只能口头描述。打包运行时同时
// 落一份到 userData/logs/main.log，用户直接把这个文件发过来就能定位。
const MAX_LOG_BYTES = 5 * 1024 * 1024;
let logFile: string | null = null;

export function setLogFileForMainProcess(file: string): void {
    logFile = file;
    try {
        fs.mkdirSync(path.dirname(file), {recursive: true});
    } catch {
        logFile = null;
    }
}

// 令牌/密码只可能以查询参数或字段值的形式混进日志（HTTP 错误消息里会带完整 URL）
function redact(text: string): string {
    return text
        .replace(/(access_token|token|password|passwd|secret)=([^&\s"']+)/gi, '$1=***')
        .replace(/("authParams"\s*:\s*")[^"]*(")/gi, '$1***$2');
}

function appendToFile(line: string): void {
    if (!logFile) {
        return;
    }
    try {
        if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_BYTES) {
            fs.renameSync(logFile, `${logFile}.1`);
        }
        fs.appendFileSync(logFile, `${line}\n`, 'utf8');
    } catch {
        // 日志写不进去不能影响功能
    }
}

function emit(level: LogLevel, module: string, message: string, data?: unknown): void {
    if (LOG_LEVELS[level] < LOG_LEVELS.info) {
        return;
    }
    const timestamp = new Date().toISOString();
    const base = `[${timestamp}] [${level.toUpperCase()}] [${module}] ${message}`;
    const line = data === undefined ? base : `${base} ${JSON.stringify(data)}`;
    const safe = redact(line);
    if (level === 'error') {
        console.error(safe);
    } else if (level === 'warn') {
        console.warn(safe);
    } else {
        console.log(safe);
    }
    appendToFile(safe);
}

export function createLogger(module: string) {
    return {
        debug: (message: string, data?: unknown) => emit('debug', module, message, data),
        info: (message: string, data?: unknown) => emit('info', module, message, data),
        warn: (message: string, data?: unknown) => emit('warn', module, message, data),
        error: (message: string, data?: unknown) => emit('error', module, message, data),
    };
}
