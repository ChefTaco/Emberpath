import type { Context, Next } from 'hono';
import type { AppVariables } from '../types/app.js';
import { prisma } from '../storage/client.js';
import { safeJsonParse } from '../utils/json.js';
import { digestText, verifyHashAsync } from './crypto.js';
import { loadEnv } from '../config/env.js';
import { log } from '../telemetry/logger.js';

export const OLLAMA_MANAGE_SCOPE = 'ollama:manage';

/** Most entries either per-process map below keeps; the oldest goes first. */
const MAX_TRACKED_KEYS = 10_000;

function trim<V>(map: Map<string, V>): void {
  while (map.size > MAX_TRACKED_KEYS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Keys that passed the scrypt check recently, by SHA-256 of the raw key, for
 * `EMBERPATH_API_KEY_CACHE_TTL_MS` (0 turns it off). Keys are 288-bit random, so the digest
 * is as unguessable as the key; only the digest is held in memory.
 */
export const verifiedKeys = (() => {
  const entries = new Map<string, { id: string; keyHash: string; at: number }>();
  return {
    recall(digest: string, now = Date.now()): { id: string; keyHash: string } | undefined {
      const ttl = loadEnv().EMBERPATH_API_KEY_CACHE_TTL_MS;
      const entry = entries.get(digest);
      if (!entry) return undefined;
      if (ttl <= 0 || now - entry.at >= ttl) {
        entries.delete(digest);
        return undefined;
      }
      return entry;
    },
    remember(digest: string, key: { id: string; keyHash: string }, now = Date.now()): void {
      if (loadEnv().EMBERPATH_API_KEY_CACHE_TTL_MS <= 0) return;
      entries.delete(digest);
      entries.set(digest, { ...key, at: now });
      trim(entries);
    },
    clear(): void { entries.clear(); },
  };
})();

/**
 * When each key's `lastUsedAt` was last written, so it is written at most once per
 * `EMBERPATH_KEY_LAST_USED_INTERVAL_MS` (0 writes it on every request).
 */
export const lastUsedWrites = (() => {
  const written = new Map<string, number>();
  return {
    due(keyId: string, now = Date.now()): boolean {
      const interval = loadEnv().EMBERPATH_KEY_LAST_USED_INTERVAL_MS;
      const last = written.get(keyId);
      if (interval > 0 && last !== undefined && now - last < interval) return false;
      written.delete(keyId);
      written.set(keyId, now);
      trim(written);
      return true;
    },
    forget(keyId: string): void { written.delete(keyId); },
    clear(): void { written.clear(); },
  };
})();

/** The client key scope a request needs. */
export function requiredScope(method: string, path: string): string {
  if (method === 'POST' && path === '/api/pull') return OLLAMA_MANAGE_SCOPE;
  return method === 'GET' ? 'models:read' : 'inference:write';
}

export async function requireApiKey(
  context: Context<{ Variables: AppVariables }>,
  next: Next,
): Promise<Response | void> {
  const authorization = context.req.header('authorization');
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  const headerKey = context.req.header('x-api-key');
  const rawKey = bearer ?? headerKey;

  if (!rawKey) {
    return context.json({ error: 'Missing API key' }, 401);
  }

  const candidates = await prisma.clientApiKey.findMany({
    where: { enabled: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }], keyPrefix: rawKey.slice(0, 8) },
    orderBy: { createdAt: 'desc' },
  });

  // A key verified recently is matched by its digest, as long as the same row (same id and
  // stored hash) is still enabled and unexpired; rotation, disabling and deletion end the
  // match at once because the row is read on every request.
  const digest = digestText(rawKey);
  const remembered = verifiedKeys.recall(digest);
  let match: (typeof candidates)[number] | undefined = remembered
    ? candidates.find((candidate) => candidate.id === remembered.id && candidate.keyHash === remembered.keyHash)
    : undefined;
  // Off the event loop: the stored hash is scrypt, and deriving it synchronously
  // here would stall every stream being relayed for each incoming request.
  if (!match) {
    for (const candidate of candidates) {
      if (await verifyHashAsync(rawKey, candidate.keyHash)) {
        match = candidate;
        verifiedKeys.remember(digest, { id: candidate.id, keyHash: candidate.keyHash });
        break;
      }
    }
  }
  if (!match) {
    return context.json({ error: 'Invalid API key' }, 401);
  }

  const metadata = safeJsonParse<{ scopes?: string[]; expiresAt?: unknown }>(match.metadataJson, {});
  if (metadata.expiresAt !== undefined) {
    const expiresAt = typeof metadata.expiresAt === 'string' ? Date.parse(metadata.expiresAt) : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return context.json({ error: 'Invalid API key' }, 401);
    }
  }
  const permission = requiredScope(context.req.method, context.req.path);
  const scopes = Array.isArray(metadata.scopes) ? metadata.scopes : undefined;
  // A key without a scope list may do everything except manage provider models, which
  // needs an explicit grant: an Ollama pull downloads arbitrary models onto the backend.
  const allowed = scopes
    ? scopes.includes('*') || scopes.includes(permission)
    : permission !== OLLAMA_MANAGE_SCOPE;
  if (!allowed) return context.json({ error: 'Client key does not permit this operation' }, 403);
  context.set('clientApiKey', match);
  if (lastUsedWrites.due(match.id)) {
    void prisma.clientApiKey.update({
      where: { id: match.id },
      data: { lastUsedAt: new Date() },
    }).catch((error: unknown) => {
      lastUsedWrites.forget(match.id);
      log('warn', 'Failed to record client API key usage', { keyId: match.id, error: error instanceof Error ? error.message : String(error) });
    });
  }
  await next();
}
