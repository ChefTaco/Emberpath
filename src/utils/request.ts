import { randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { createRequestContext, runWithRequestContext } from '@hivemagnus/hive-common/context';
import type { AppVariables } from '../types/app.js';

const HIVE_REQUEST_ID_HEADER = 'x-hive-request-id';
const REQUEST_ID_HEADER = 'x-request-id';

export function getRequestId(c: Context<{ Variables: AppVariables }>): string {
  return c.get('requestId');
}

export interface RequestIdOptions {
  /**
   * Accept a safe inbound `x-request-id` (or `x-hive-request-id` / `x-correlation-id`) and
   * W3C `traceparent`. Only the admin plane, which sits behind the suite console, trusts
   * them; the inference plane may face external clients, so it always generates its own.
   */
  trustInbound: boolean;
}

/**
 * Request context for every request: a request ID and trace span that logs and peer calls
 * read from async context. The ID is echoed as `x-request-id` and `x-hive-request-id`.
 */
export function requestIdMiddleware(options: RequestIdOptions): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const context = createRequestContext((name) => c.req.header(name), {
      trustInbound: options.trustInbound,
      generateRequestId: randomUUID,
    });
    c.set('requestId', context.requestId);
    c.header(REQUEST_ID_HEADER, context.requestId);
    c.header(HIVE_REQUEST_ID_HEADER, context.requestId);
    await runWithRequestContext(context, next);
  };
}
