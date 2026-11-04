import { QuotaLedger } from '../security/quota-ledger.js';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { loadEnv } from '../config/env.js';
import { columnMigrations, schemaStatements } from './migrations/managed-format-1.js';
import { resolveSqlitePath } from './sqlite-path.js';
import { log } from '../telemetry/logger.js';

export { resolveSqlitePath } from './sqlite-path.js';

/**
 * Apply additive `ALTER TABLE ... ADD COLUMN` migrations for any column defined
 * in prisma/schema.prisma that is missing from an existing table. `CREATE TABLE
 * IF NOT EXISTS` alone cannot evolve a populated database, so this reconciler
 * closes the gap without a destructive rebuild. It only adds safely-addable
 * columns (nullable or constant-default); it never drops or alters columns.
 */
export function reconcileSqliteColumns(database: Database.Database): string[] {
  const applied: string[] = [];
  const existingColumnsByTable = new Map<string, Set<string>>();

  for (const migration of columnMigrations) {
    let existing = existingColumnsByTable.get(migration.table);
    if (!existing) {
      const rows = database.prepare(`PRAGMA table_info("${migration.table}")`).all() as Array<{ name: string }>;
      existing = new Set(rows.map((row) => row.name));
      existingColumnsByTable.set(migration.table, existing);
    }

    // An empty column set means the table does not exist yet. CREATE TABLE IF
    // NOT EXISTS is responsible for such tables (with all columns present), so
    // there is nothing to reconcile and ALTER would fail on a missing table.
    if (existing.size === 0) {
      continue;
    }

    if (existing.has(migration.column)) {
      continue;
    }

    database.exec(migration.sql);
    existing.add(migration.column);
    applied.push(`${migration.table}.${migration.column}`);
  }

  return applied;
}

export async function ensureSqliteSchema(): Promise<void> {
  const env = loadEnv();
  const databasePath = resolveSqlitePath(env.DATABASE_URL);

  mkdirSync(dirname(databasePath), { recursive: true });

  const database = new Database(databasePath);

  try {
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec('PRAGMA journal_mode = WAL;');

    for (const statement of schemaStatements) {
      database.exec(statement);
    }

    const applied = reconcileSqliteColumns(database);
    new QuotaLedger(database).migrateRetainedHistory();
    if (applied.length > 0) {
      log('info', 'Applied additive SQLite column migrations', { columns: applied });
    }
  } finally {
    database.close();
  }

  if (existsSync(databasePath)) {
    chmodSync(databasePath, 0o600);
  }
}
