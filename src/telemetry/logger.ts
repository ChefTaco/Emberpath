import { getRequestContext } from '@hivemagnus/hive-common/context';
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

  // Lines written while serving a request carry its request ID unless the caller set one.
  const requestId = getRequestContext()?.requestId;
  const payload = {
    level,
    message,
    service: 'hive-router',
    timestamp: new Date().toISOString(),
    ...(requestId ? { requestId } : {}),
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
