import { dirname, join } from 'node:path';
import { loadEnv } from './config/env.js';
import { packageRoot, hiveHome } from './config/paths.js';
import { resolveSqlitePath, ensureSqliteSchema } from './storage/schema.js';
import { schemaStatements, columnMigrations } from './storage/migrations/managed-format-1.js';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import {
  guardedMigration,
  hash,
  metadata,
  migrationFlags,
  migrationReview,
  ownRelease,
  schemaCommit,
  schemaPlan,
  storeSpec,
} from './release/runtime.js';

export async function routerMigration(args: readonly string[], automatic = false): Promise<void> {
  const flags = migrationFlags(args);
  const env = loadEnv();
  const root = hiveHome();
  const database = resolveSqlitePath(env.DATABASE_URL);
  const state = join(dirname(database), '.hive-router-schema.json');
  const release = ownRelease(packageRoot);
  const checksum = hash(
    JSON.stringify(
      release.migrations.filter((m) => m.component === 'router').map((m) => [m.id, m.checksum]),
    ),
  );
  const plan = () => {
    const result = schemaPlan(state, checksum, metadata(packageRoot).version);
    if (existsSync(state) && !existsSync(database))
      throw new Error('Existing Router database is missing; restore it before starting');
    if (!existsSync(database)) return { ...result, dataChanged: true };
    const db = new Database(database, { readonly: true, fileMustExist: true });
    try {
      const tables = new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
            name: string;
          }[]
        ).map((r) => r.name),
      );
      const missingTable = schemaStatements.some((sql) => {
        const name = /CREATE TABLE IF NOT EXISTS "([^"]+)"/.exec(sql)?.[1];
        return name && !tables.has(name);
      });
      const missingColumn = columnMigrations.some(
        (m) =>
          !(db.prepare(`PRAGMA table_info("${m.table}")`).all() as { name: string }[]).some(
            (c) => c.name === m.column,
          ),
      );
      return { ...result, dataChanged: missingTable || missingColumn };
    } finally {
      db.close();
    }
  };
  if (flags.plan) {
    console.log(JSON.stringify({ ...plan(), ...migrationReview(release, 'router') }));
    return;
  }
  const spec = storeSpec(
    'router',
    { ...process.env, DATA_DIR: env.DATA_DIR, DATABASE_URL: env.DATABASE_URL },
    root,
  );
  await guardedMigration({
    service: 'router',
    spec,
    lock: `${database}.migration.lock`,
    pending: () => plan().pending.length > 0,
    automatic,
    release,
    ...(flags.backupDir ? { backupDir: flags.backupDir } : {}),
    ...(flags.confirmPlan ? { confirmPlan: flags.confirmPlan } : {}),
    apply: async () => {
      await ensureSqliteSchema();
      schemaCommit(state, checksum, release.version, release.dataCompatibility.router!);
    },
  });
}
