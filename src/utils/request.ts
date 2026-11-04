import { randomUUID } from 'node:crypto';
import type { Context, Next } from 'hono';
import type { AppVariables } from '../types/app.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const HIVE_REQUEST_ID_HEADER = 'x-hive-request-id';
const REQUEST_ID_HEADER = 'x-request-id';

export function getRequestId(c: Context<{ Variables: AppVariables }>): string {
  return c.get('requestId');
}

function normalizeRequestId(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && REQUEST_ID_PATTERN.test(trimmed) ? trimmed : randomUUID();
}

export async function requestIdMiddleware(
  c: Context<{ Variables: AppVariables }>,
  next: Next,
): Promise<void> {
  const requestId = normalizeRequestId(c.req.header(HIVE_REQUEST_ID_HEADER) ?? c.req.header(REQUEST_ID_HEADER) ?? undefined);
  c.set('requestId', requestId);
  c.header(REQUEST_ID_HEADER, requestId);
  c.header(HIVE_REQUEST_ID_HEADER, requestId);
  await next();
}
