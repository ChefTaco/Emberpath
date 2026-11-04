import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnv } from '../config/env.js';
import { prisma } from '../storage/client.js';
import { log } from './logger.js';

const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

export async function pruneExpiredTraces(now = new Date()): Promise<number> {
  await prisma.actorEnrollment.updateMany({ where: { receiptExpiresAt: { lt: now }, encryptedSecrets: { not: null } }, data: { encryptedSecrets: null, receiptExpiresAt: null } });
  // Lifecycle journal timestamps are numeric milliseconds shared with direct SQLite writers.
  await prisma.$executeRaw`UPDATE ActorLifecycleOperation SET encryptedSecrets = NULL, receiptExpiresAt = NULL WHERE receiptExpiresAt <= ${now.getTime()}`;
  const env = loadEnv();
  const cutoff = new Date(now.getTime() - env.DEFAULT_TRACE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const expired = await prisma.trace.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true } });
  for (const trace of expired) {
    await rm(join(env.TRACE_DIR, trace.id), { recursive: true, force: true });
  }
  if (expired.length > 0) await prisma.trace.deleteMany({ where: { id: { in: expired.map((trace) => trace.id) } } });
  return expired.length;
}

export function startTraceRetention(): NodeJS.Timeout {
  void pruneExpiredTraces().then((count) => {
    if (count > 0) log('info', 'Pruned expired traces', { count });
  }).catch((error) => log('error', 'Trace retention failed', { error: error instanceof Error ? error.message : String(error) }));
  const timer = setInterval(() => {
    void pruneExpiredTraces().catch((error) => log('error', 'Trace retention failed', { error: error instanceof Error ? error.message : String(error) }));
  }, RETENTION_INTERVAL_MS);
  timer.unref();
  return timer;
}
