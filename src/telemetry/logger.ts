import { loadEnv } from '../config/env.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelWeight: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function shouldLog(level: LogLevel): boolean {
  return levelWeight[level] >= levelWeight[loadEnv().LOG_LEVEL];
}

export function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  if (!shouldLog(level)) {
    return;
  }

  const payload = {
    level,
    message,
    service: 'hive-router',
    timestamp: new Date().toISOString(),
    ...fields,
  };

  const serialized = JSON.stringify(payload);
  if (level === 'error') {
    console.error(serialized);
    return;
  }

  if (level === 'warn') {
    console.warn(serialized);
    return;
  }

  console.log(serialized);
}
