import { existsSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Redis } from './redis.js';
import { qdrantRequest, sqliteIntegrity, type StoreSpec } from './backup.js';

/** Only the native standalone store adapters are supported; shared external
 * writers remain outside the managed installation's ownership contract. */
export async function inspectStores(specs: StoreSpec[]): Promise<void> {
  for (const spec of specs) {
    for (const file of spec.sqlite) if (existsSync(file)) sqliteIntegrity(file);
    if (spec.qdrant) {
      const cluster = (await (await qdrantRequest(spec.qdrant, '/cluster')).json()) as {
        result?: { status?: string };
      };
      if (cluster.result?.status !== 'disabled')
        throw new Error('Only single-node Qdrant upgrades are supported');
      await qdrantRequest(spec.qdrant, '/collections');
    }
    if (spec.redis) {
      const redis = new Redis(new URL(spec.redis.url));
      try {
        await redis.ready();
        await redis.keys(spec.redis.prefix);
      } finally {
        redis.close();
      }
    }
  }
}

/** Legacy SQLite writers do not know the new locks. Refuse if any still holds a
 * datastore open after the enrolled supervisor has quiesced. Never kill it. */
export function assertQuiesced(specs: StoreSpec[]): void {
  if (process.platform !== 'linux')
    throw new Error(
      'Managed writer verification currently requires Linux; use the existing operator release procedure',
    );
  const files = new Set(
    specs.flatMap((s) => s.sqlite).map((p) => (existsSync(p) ? realpathSync(p) : resolve(p))),
  );
  const directories = specs
    .flatMap((s) => s.paths)
    .filter((p) => existsSync(p) && statSync(p).isDirectory())
    .map((p) => realpathSync(p) + '/');
  for (const pid of readdirSync('/proc').filter(
    (p) => /^\d+$/.test(p) && Number(p) !== process.pid,
  )) {
    let descriptors: string[];
    try {
      descriptors = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of descriptors) {
      let file: string;
      try {
        file = readlinkSync(`/proc/${pid}/fd/${fd}`).replace(/ \(deleted\)$/, '');
      } catch {
        continue;
      }
      if (
        files.has(file) ||
        files.has(file.replace(/-wal$|-shm$/, '')) ||
        directories.some((dir) => file.startsWith(dir))
      )
        throw new Error(
          'An external process still holds owned datastore files; stop that writer and retry. No migration ran',
        );
    }
  }
}
