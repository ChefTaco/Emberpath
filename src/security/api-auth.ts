import type { Context, Next } from 'hono';
import type { AppVariables } from '../types/app.js';
import { prisma } from '../storage/client.js';
import { safeJsonParse } from '../utils/json.js';
import { verifyHashAsync } from './crypto.js';
import { log } from '../telemetry/logger.js';

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

  // Off the event loop: the stored hash is scrypt, and deriving it synchronously
  // here would stall every stream being relayed for each incoming request.
  let match: (typeof candidates)[number] | undefined;
  for (const candidate of candidates) {
    if (await verifyHashAsync(rawKey, candidate.keyHash)) {
      match = candidate;
      break;
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
