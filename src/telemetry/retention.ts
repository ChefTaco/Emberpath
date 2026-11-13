import { readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { loadEnv } from '../config/env.js';
import { prisma } from '../storage/client.js';
import { log } from './logger.js';

const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/** Rows per statement, well under SQLite's bound-parameter limit. */
const RETENTION_BATCH = 500;

/**
 * The directory a stored body lives in, when it is a direct child of TRACE_DIR.
 * Request bodies are filed under the request ID and response bodies under the
 * trace ID, so both come from the stored paths rather than from the trace ID.
 */
function bodyDirectory(traceDir: string, bodyPath: string | null): string | undefined {
  if (!bodyPath) return undefined;
  const directory = dirname(bodyPath);
  const inside = relative(traceDir, directory);
  return inside && !inside.startsWith('..') && !inside.includes(sep) ? directory : undefined;
}

/**
 * Remove body directories no trace refers to any more and that are older than
 * the retention window: what earlier releases left behind when they deleted a
 * trace but not the request body filed under its request ID.
 */
async function pruneOrphanedBodies(traceDir: string, cutoff: Date): Promise<number> {
  const entries = await readdir(traceDir, { withFileTypes: true }).catch(() => []);
  const expired: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const info = await stat(join(traceDir, entry.name)).catch(() => undefined);
    if (info && info.mtime < cutoff) expired.push(entry.name);
  }

  let removed = 0;
  for (let index = 0; index < expired.length; index += RETENTION_BATCH) {
    const names = expired.slice(index, index + RETENTION_BATCH);
    const referenced = await prisma.trace.findMany({
      where: { OR: [{ id: { in: names } }, { requestId: { in: names } }] },
      select: { id: true, requestId: true },
    });
    const live = new Set(referenced.flatMap((trace) => [trace.id, trace.requestId]));
    for (const name of names) {
      if (live.has(name)) continue;
      await rm(join(traceDir, name), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

export async function pruneExpiredTraces(now = new Date()): Promise<number> {
  if (loadEnv().HIVE_REHEARSAL) return 0;
  await prisma.actorEnrollment.updateMany({ where: { receiptExpiresAt: { lt: now }, encryptedSecrets: { not: null } }, data: { encryptedSecrets: null, receiptExpiresAt: null } });
  // Lifecycle journal timestamps are numeric milliseconds shared with direct SQLite writers.
  await prisma.$executeRaw`UPDATE ActorLifecycleOperation SET encryptedSecrets = NULL, receiptExpiresAt = NULL WHERE receiptExpiresAt <= ${now.getTime()}`;
  const env = loadEnv();
  const cutoff = new Date(now.getTime() - env.DEFAULT_TRACE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let pruned = 0;
  for (;;) {
    // Batched so a large backlog cannot exceed SQLite's bound-parameter limit
    // and leave retention failing on every run.
    const expired = await prisma.trace.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true, requestBodyPath: true, responseBodyPath: true, reasoningBodyPath: true },
      orderBy: { createdAt: 'asc' },
      take: RETENTION_BATCH,
    });
    if (expired.length === 0) break;
    const directories = new Set<string>();
    for (const trace of expired) {
      directories.add(join(env.TRACE_DIR, trace.id));
      for (const path of [trace.requestBodyPath, trace.responseBodyPath, trace.reasoningBodyPath]) {
        const directory = bodyDirectory(env.TRACE_DIR, path);
        if (directory) directories.add(directory);
      }
    }
    for (const directory of directories) {
      await rm(directory, { recursive: true, force: true });
    }
    await prisma.trace.deleteMany({ where: { id: { in: expired.map((trace) => trace.id) } } });
    pruned += expired.length;
  }
  await pruneOrphanedBodies(env.TRACE_DIR, cutoff);
  return pruned;
}

export function startTraceRetention(): NodeJS.Timeout | undefined {
  if (loadEnv().HIVE_REHEARSAL) return undefined;
  void pruneExpiredTraces().then((count) => {
    if (count > 0) log('info', 'Pruned expired traces', { count });
  }).catch((error) => log('error', 'Trace retention failed', { error: error instanceof Error ? error.message : String(error) }));
  const timer = setInterval(() => {
    void pruneExpiredTraces().catch((error) => log('error', 'Trace retention failed', { error: error instanceof Error ? error.message : String(error) }));
  }, RETENTION_INTERVAL_MS);
  timer.unref();
  return timer;
}
