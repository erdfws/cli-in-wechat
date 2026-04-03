export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

let currentLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function formatLogTimestamp(date: Date = new Date()): string {
  const hhmmss = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${hhmmss}.${ms}`;
}

function ts(): string {
  return formatLogTimestamp();
}

export const log = {
  debug: (...args: unknown[]) => {
    if (currentLevel <= LogLevel.DEBUG)
      console.log(`\x1b[90m[${ts()}] [DBG]\x1b[0m`, ...args);
  },
  info: (...args: unknown[]) => {
    if (currentLevel <= LogLevel.INFO)
      console.log(`\x1b[36m[${ts()}] [INF]\x1b[0m`, ...args);
  },
  warn: (...args: unknown[]) => {
    if (currentLevel <= LogLevel.WARN)
      console.warn(`\x1b[33m[${ts()}] [WRN]\x1b[0m`, ...args);
  },
  error: (...args: unknown[]) => {
    if (currentLevel <= LogLevel.ERROR)
      console.error(`\x1b[31m[${ts()}] [ERR]\x1b[0m`, ...args);
  },
};
