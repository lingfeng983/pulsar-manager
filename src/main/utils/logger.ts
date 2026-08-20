export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

let currentLevel: LogLevel = 'info'

export function setLogLevel(level: LogLevel): void {
  currentLevel = level
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel]
}

function formatMessage(level: LogLevel, module: string, message: string, data?: unknown): string {
  const timestamp = new Date().toISOString()
  const base = `[${timestamp}] [${level.toUpperCase()}] [${module}] ${message}`
  if (data !== undefined) {
    return `${base} ${JSON.stringify(data)}`
  }
  return base
}

export function createLogger(module: string) {
  return {
    debug: (message: string, data?: unknown) => {
      if (shouldLog('debug')) console.debug(formatMessage('debug', module, message, data))
    },
    info: (message: string, data?: unknown) => {
      if (shouldLog('info')) console.log(formatMessage('info', module, message, data))
    },
    warn: (message: string, data?: unknown) => {
      if (shouldLog('warn')) console.warn(formatMessage('warn', module, message, data))
    },
    error: (message: string, data?: unknown) => {
      if (shouldLog('error')) console.error(formatMessage('error', module, message, data))
    },
  }
}
