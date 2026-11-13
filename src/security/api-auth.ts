import type { Context, Next } from 'hono';
import type { AppVariables } from '../types/app.js';
import { prisma } from '../storage/client.js';
import { safeJsonParse } from '../utils/json.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { verifyHash } from './crypto.js';
import { log } from '../telemetry/logger.js';

const VERIFIED_KEY_CACHE_SIZE = 1024;
/**
 * Stored key hash -> SHA-256 of the raw key that verified against it. The stored
 * hash is scrypt, which is synchronous and slow by design; without this every
 * inference request would stall the event loop (and every stream being relayed)
 * for the full derivation. Only the verification result is remembered: the key
 * row is still read on every request, so disabling, expiry, rotation and scope
 * changes apply immediately. Client keys are random 288-bit values, so a fast
 * digest held in memory does not make them guessable.
 */
const verifiedKeys = new Map<string, Buffer>();

export function clearVerifiedClientKeys(): void {
  verifiedKeys.clear();
}

function verifyClientKey(rawKey: string, storedHash: string): boolean {
  const digest = createHash('sha256').update(rawKey).digest();
  const known = verifiedKeys.get(storedHash);
  // A stored hash has one raw key, so any other value is wrong without rederiving.
  if (known) return timingSafeEqual(known, digest);
  if (!verifyHash(rawKey, storedHash)) return false;
  if (verifiedKeys.size >= VERIFIED_KEY_CACHE_SIZE) {
    const oldest = verifiedKeys.keys().next();
    if (!oldest.done) verifiedKeys.delete(oldest.value);
  }
  verifiedKeys.set(storedHash, digest);
  return true;
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

  const match = candidates.find((candidate) => verifyClientKey(rawKey, candidate.keyHash));
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
  const permission = context.req.method === 'GET' ? 'models:read' : 'inference:write';
  if (Array.isArray(metadata.scopes) && !metadata.scopes.includes('*') && !metadata.scopes.includes(permission)) return context.json({ error: 'Client key does not permit this operation' }, 403);
  context.set('clientApiKey', match);
  void prisma.clientApiKey.update({
    where: { id: match.id },
    data: { lastUsedAt: new Date() },
  }).catch((error: unknown) => {
    log('warn', 'Failed to record client API key usage', { keyId: match.id, error: error instanceof Error ? error.message : String(error) });
  });
  await next();
}
