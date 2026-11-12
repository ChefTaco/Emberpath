import {afterAll, describe, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from '../../src/storage/sqlite.js';
import * as formatOne from '../../src/storage/migrations/managed-format-1.js';

const directory = mkdtempSync(join(tmpdir(), 'emberpath-trace-migration-'));
const databasePath = join(directory, 'router.db');
vi.stubEnv('DATABASE_URL', 'file:' + databasePath);
afterAll(() => {vi.unstubAllEnvs(); rmSync(directory, {recursive: true, force: true});});

const sha256 = (path: string) => createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex');
type ReleaseMigration = {component: string; id: string; checksum: string; impact: string};
const release = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).hiveRelease as {migrations: ReleaseMigration[]};

describe('managed-format-2 router migration', () => {
  it('pins each router format file by checksum and keeps managed-format-1 immutable', () => {
    const router = release.migrations.filter((migration) => migration.component === 'router');
    expect(router.map((migration) => migration.id)).toEqual(['managed-format-1', 'managed-format-2']);
    expect(router[0]!.checksum).toBe('9a7c87d16b66aa65a1200c00ba8eca252949bd683d0ae4843fdb2a44c4a4911d');
    for (const migration of router) {
      expect(sha256('../../src/storage/migrations/' + migration.id + '.ts'), migration.id).toBe(migration.checksum);
      expect(migration.impact).toBe('fast');
    }
    // The newest format is exactly the current generated bootstrap.
    expect(sha256('../../src/storage/migrations/managed-format-2.ts')).toBe(sha256('../../src/storage/generated-sqlite-schema.ts'));
  });

  it('adds Trace.actorId and its indexes to a populated managed-format-1 database without data loss', async () => {
    const legacy = new Database(databasePath);
    try {
      for (const statement of formatOne.schemaStatements) legacy.exec(statement);
      legacy.exec('INSERT INTO "Trace" ("id","requestId","method","path","endpointKind","routeKey","decisionJson") VALUES (\'t1\',\'r1\',\'POST\',\'/v1/responses\',\'v1.responses\',\'fixture\',\'{}\')');
      expect((legacy.prepare('PRAGMA table_info("Trace")').all() as {name: string}[]).map((column) => column.name)).not.toContain('actorId');
    } finally {legacy.close();}

    const {ensureSqliteSchema} = await import('../../src/storage/schema.js');
    await ensureSqliteSchema();
    await ensureSqliteSchema(); // idempotent

    const database = new Database(databasePath);
    try {
      const actorColumn = (database.prepare('PRAGMA table_info("Trace")').all() as {name: string; type: string; notnull: number}[])
        .find((column) => column.name === 'actorId');
      expect(actorColumn).toMatchObject({type: 'TEXT', notnull: 0});
      const indexes = (database.prepare('PRAGMA index_list("Trace")').all() as {name: string}[]).map((index) => index.name);
      expect(indexes).toEqual(expect.arrayContaining(['Trace_actorId_createdAt_idx', 'Trace_clientApiKeyId_createdAt_idx', 'Trace_requestId_key']));
      expect((database.prepare('PRAGMA index_info("Trace_actorId_createdAt_idx")').all() as {name: string}[]).map((column) => column.name))
        .toEqual(['actorId', 'createdAt']);
      expect(database.prepare('SELECT id, requestId, actorId FROM "Trace"').all()).toEqual([{id: 't1', requestId: 'r1', actorId: null}]);
      const plan = database.prepare('EXPLAIN QUERY PLAN SELECT id FROM "Trace" WHERE actorId = ? ORDER BY createdAt DESC').all('agent') as {detail: string}[];
      expect(plan.map((row) => row.detail).join(' ')).toContain('Trace_actorId_createdAt_idx');
    } finally {database.close();}
  });
});
