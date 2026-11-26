import { createHash } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import type { EndpointKind, RouteRequest } from '../providers/types.js';
import type { UsageSnapshot } from '../telemetry/tracing.js';

/**
 * Optional exact-match response cache (`EMBERPATH_RESPONSE_CACHE_TTL_MS`, off by default).
 *
 * Only deterministic, non-streaming requests are cached: chat completions, completions and
 * Responses API calls that set `temperature: 0` (and ask for one choice), and embeddings.
 * Entries are keyed by client key, route and the SHA-256 of the exact request body (which
 * names the model), so one key never sees another key's answers. Only `200` JSON answers up
 * to `MAX_ENTRY_BYTES` are kept, in this process's memory, least recently used first out.
 * A request with `Cache-Control: no-cache` skips the lookup; `no-store` skips the cache.
 */
const CACHEABLE_GENERATIONS = new Set<EndpointKind>(['v1.chat.completions', 'v1.completions', 'v1.responses']);
const MAX_ENTRY_BYTES = 1024 * 1024;
export const CACHE_HEADER = 'x-emberpath-cache';

export interface CachedResponse {
  status: number;
  headers: Array<[string, string]>;
  body: string;
  usage?: UsageSnapshot | undefined;
  estimatedUsage: boolean;
  providerId: string;
  providerKind: string;
  providerModel?: string | undefined;
  sourceTraceId: string;
}

interface Entry extends CachedResponse { at: number; bytes: number }

export interface CachePlan {
  key: string;
  lookup: boolean;
  store: boolean;
}

/** Whether and how the request may use the cache; undefined when it may not. */
export function planResponseCache(route: RouteRequest, clientKeyId: string | undefined): CachePlan | undefined {
  if (loadEnv().EMBERPATH_RESPONSE_CACHE_TTL_MS <= 0 || !clientKeyId || route.method !== 'POST' || route.stream) return undefined;
  if (route.requestBodyText === undefined || !route.requestBodyJson || typeof route.requestBodyJson !== 'object' || Array.isArray(route.requestBodyJson)) return undefined;
  const body = route.requestBodyJson as Record<string, unknown>;
  if (body.stream === true) return undefined;
  const deterministic = route.endpointKind === 'v1.embeddings'
    || (CACHEABLE_GENERATIONS.has(route.endpointKind) && body.temperature === 0 && (body.n === undefined || body.n === 1));
  if (!deterministic) return undefined;
  const directives = (route.headers['cache-control'] ?? '').toLowerCase().split(',').map((part) => part.trim());
  if (directives.includes('no-store')) return undefined;
  const bodyDigest = createHash('sha256').update(route.requestBodyText).digest('hex');
  const key = createHash('sha256').update([clientKeyId, route.endpointKind, route.path, route.routingTrait ?? '', bodyDigest].join('\u0000')).digest('hex');
  return { key, lookup: !directives.includes('no-cache'), store: true };
}

const entries = new Map<string, Entry>();
let totalBytes = 0;

function drop(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  totalBytes -= entry.bytes;
}

export function lookupCachedResponse(key: string, now = Date.now()): CachedResponse | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (now - entry.at >= loadEnv().EMBERPATH_RESPONSE_CACHE_TTL_MS) {
    drop(key);
    return undefined;
  }
  // Most recently used last.
  entries.delete(key);
  entries.set(key, entry);
  return entry;
}

export function storeCachedResponse(key: string, response: CachedResponse, now = Date.now()): boolean {
  const env = loadEnv();
  const contentType = response.headers.find(([name]) => name === 'content-type')?.[1] ?? '';
  const bytes = Buffer.byteLength(response.body) + 512;
  if (response.status !== 200 || !contentType.includes('application/json') || bytes > MAX_ENTRY_BYTES || bytes > env.EMBERPATH_RESPONSE_CACHE_MAX_BYTES) return false;
  drop(key);
  entries.set(key, { ...response, at: now, bytes });
  totalBytes += bytes;
  while (entries.size > env.EMBERPATH_RESPONSE_CACHE_MAX_ENTRIES || totalBytes > env.EMBERPATH_RESPONSE_CACHE_MAX_BYTES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    drop(oldest);
  }
  return true;
}

export function clearResponseCache(): void {
  entries.clear();
  totalBytes = 0;
}

export function responseCacheStats(): { entries: number; bytes: number } {
  return { entries: entries.size, bytes: totalBytes };
}
