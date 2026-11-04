import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildColumnMigrations, buildGeneratedModule } from '../../scripts/generate-sqlite-bootstrap.js';
import { schemaStatements } from '../../src/storage/generated-sqlite-schema.js';
import { ensureSqliteSchema, reconcileSqliteColumns } from '../../src/storage/schema.js';

const schemaPath = new URL('../../prisma/schema.prisma', import.meta.url);
const generatedPath = new URL('../../src/storage/generated-sqlite-schema.ts', import.meta.url);

function newDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hive-router-schema-'));
  return join(dir, 'router.db');
}

function bootstrapFullSchema(database: Database.Database): void {
  for (const statement of schemaStatements) {
    database.exec(statement);
  }
}

describe('router sqlite bootstrap schema', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'file:' + newDbPath();
  });

  it('is generated from prisma/schema.prisma', () => {
    const schema = readFileSync(schemaPath, 'utf8');
    const generated = readFileSync(generatedPath, 'utf8');

    expect(generated).toBe(buildGeneratedModule(schema));
  });

  it('boots a fresh database with the Prisma-derived table shape', async () => {
    await ensureSqliteSchema();

    // ensureSqliteSchema resolves its path through loadEnv(), which caches the
    // first DATABASE_URL for the process. Read that same path back.
    const { loadEnv } = await import('../../src/config/env.js');
    const databasePath = loadEnv().DATABASE_URL.slice('file:'.length);
    const database = new Database(databasePath);

    try {
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name);

      expect(tables).toContain('Provider');
      expect(tables).toContain('Trace');
      expect(tables).toContain('RuntimeSetting');

      const traceColumns = database.prepare('PRAGMA table_info("Trace")').all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const estimatedUsage = traceColumns.find((column) => column.name === 'estimatedUsage');
      expect(estimatedUsage).toMatchObject({ type: 'BOOLEAN', notnull: 1, dflt_value: 'false' });

      const traceIndexes = database.prepare('PRAGMA index_list("Trace")').all() as Array<{ name: string; unique: number }>;
      expect(traceIndexes).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Trace_requestId_key', unique: 1 })]));
      const auditIndexes = database.prepare('PRAGMA index_list("AuditEvent")').all() as Array<{ name: string; unique: number }>;
      expect(auditIndexes).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'AuditEvent_action_id_idx', unique: 0 }),
      ]));

      // A freshly bootstrapped DB needs no additive migrations.
      expect(reconcileSqliteColumns(database)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('adds a missing column to an existing populated table without data loss', () => {
    const databasePath = newDbPath();

    // Simulate an older deployed DB: create Provider WITHOUT several later columns.
    const legacy = new Database(databasePath);
    try {
      legacy.exec(
        'CREATE TABLE "Provider" (\n' +
          '  "id" TEXT NOT NULL PRIMARY KEY,\n' +
          '  "slug" TEXT NOT NULL,\n' +
          '  "name" TEXT NOT NULL,\n' +
          '  "kind" TEXT NOT NULL,\n' +
          '  "baseUrl" TEXT NOT NULL,\n' +
          '  "authMode" TEXT NOT NULL DEFAULT \'BEARER\',\n' +
          '  "authHeaderName" TEXT NOT NULL DEFAULT \'Authorization\',\n' +
          '  "enabled" BOOLEAN NOT NULL DEFAULT true,\n' +
          '  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n' +
          '  "updatedAt" DATETIME NOT NULL\n' +
          ')',
      );
      legacy.exec(
        'INSERT INTO "Provider" ("id", "slug", "name", "kind", "baseUrl", "updatedAt") ' +
          "VALUES ('p1', 'openai', 'OpenAI', 'OPENAI', 'https://api.openai.com', CURRENT_TIMESTAMP)",
      );

      // Reconcile against the current Prisma-derived shape.
      const applied = reconcileSqliteColumns(legacy);
      expect(applied).toContain('Provider.failoverGroup');
      expect(applied).toContain('Provider.capabilityJson');
      expect(applied).toContain('Provider.priority');

      const columns = (legacy.prepare('PRAGMA table_info("Provider")').all() as Array<{ name: string }>).map(
        (row) => row.name,
      );
      expect(columns).toContain('failoverGroup');
      expect(columns).toContain('capabilityJson');
      expect(columns).toContain('priority');

      // Existing row preserved; nullable column defaults to null.
      const row = legacy.prepare('SELECT id, slug, failoverGroup FROM "Provider" WHERE id = ?').get('p1') as {
        id: string;
        slug: string;
        failoverGroup: string | null;
      };
      expect(row).toMatchObject({ id: 'p1', slug: 'openai', failoverGroup: null });

      // A constant-default NOT NULL column backfills to its default for existing rows.
      const priorityRow = legacy.prepare('SELECT priority FROM "Provider" WHERE id = ?').get('p1') as {
        priority: number;
      };
      expect(priorityRow.priority).toBe(100);
    } finally {
      legacy.close();
    }
  });

  it('is idempotent: a fully bootstrapped DB needs no migrations across repeated runs', () => {
    const database = new Database(newDbPath());
    try {
      bootstrapFullSchema(database);
      expect(reconcileSqliteColumns(database)).toEqual([]);
      expect(reconcileSqliteColumns(database)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('never emits additive migrations for primary keys or non-constant defaults', () => {
    const schema = readFileSync(schemaPath, 'utf8');
    const migrations = buildColumnMigrations(schema);
    const columns = migrations.map((migration) => migration.column);
    expect(columns).not.toContain('id');
    expect(columns).not.toContain('createdAt');
    expect(columns).not.toContain('updatedAt');
    // A nullable column and a constant-default NOT NULL column are addable.
    expect(columns).toContain('failoverGroup');
    expect(columns).toContain('priority');
  });
});
