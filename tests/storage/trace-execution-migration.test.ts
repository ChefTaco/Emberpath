import {afterAll, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from '../../src/storage/sqlite.js';
import * as formatTwo from '../../src/storage/migrations/managed-format-2.js';

const directory = mkdtempSync(join(tmpdir(), 'emberpath-trace-execution-migration-'));
const databasePath = join(directory, 'router.db');
vi.stubEnv('DATABASE_URL', 'file:' + databasePath);
afterAll(() => {vi.unstubAllEnvs(); rmSync(directory, {recursive: true, force: true});});

const executionColumns = ['executionRootRef', 'executionSelfRef', 'executionParentRef', 'clientRequestId', 'inboundTraceparent', 'executionJson'];

describe('managed-format-3 router migration', () => {
  it('adds the Trace execution columns and indexes to a populated managed-format-2 database without data loss', async () => {
    const legacy = new Database(databasePath);
    try {
      for (const statement of formatTwo.schemaStatements) legacy.exec(statement);
      legacy.exec('INSERT INTO "Trace" ("id","requestId","method","path","endpointKind","routeKey","decisionJson","actorId") VALUES (\'t1\',\'r1\',\'POST\',\'/v1/responses\',\'v1.responses\',\'fixture\',\'{}\',\'agent\')');
      legacy.exec('INSERT INTO "TraceEvent" ("id","traceId","type","phase","message") VALUES (\'e1\',\'t1\',\'provider.failover\',\'execution\',\'legacy\')');
      const columns = (legacy.prepare('PRAGMA table_info("Trace")').all() as {name: string}[]).map((column) => column.name);
      for (const column of executionColumns) expect(columns).not.toContain(column);
    } finally {legacy.close();}

    const {ensureSqliteSchema} = await import('../../src/storage/schema.js');
    await ensureSqliteSchema();
    await ensureSqliteSchema(); // idempotent

    const database = new Database(databasePath);
    try {
      const columns = database.prepare('PRAGMA table_info("Trace")').all() as {name: string; type: string; notnull: number}[];
      for (const name of executionColumns) {
        expect(columns.find((column) => column.name === name), name).toMatchObject({type: 'TEXT', notnull: 0});
      }
      const indexes = (database.prepare('PRAGMA index_list("Trace")').all() as {name: string}[]).map((index) => index.name);
      expect(indexes).toEqual(expect.arrayContaining(['Trace_executionRootRef_createdAt_idx', 'Trace_executionSelfRef_idx', 'Trace_actorId_createdAt_idx']));
      expect((database.prepare('PRAGMA index_info("Trace_executionRootRef_createdAt_idx")').all() as {name: string}[]).map((column) => column.name))
        .toEqual(['executionRootRef', 'createdAt']);
      expect(database.prepare('SELECT id, actorId, executionRootRef, executionSelfRef, executionParentRef, clientRequestId, inboundTraceparent, executionJson FROM "Trace"').all())
        .toEqual([{id: 't1', actorId: 'agent', executionRootRef: null, executionSelfRef: null, executionParentRef: null, clientRequestId: null, inboundTraceparent: null, executionJson: null}]);
      expect(database.prepare('SELECT id FROM "TraceEvent"').all()).toEqual([{id: 'e1'}]);
      const rootPlan = database.prepare('EXPLAIN QUERY PLAN SELECT id FROM "Trace" WHERE executionRootRef = ? ORDER BY createdAt DESC').all('hx1:studio:lab:request:r1') as {detail: string}[];
      expect(rootPlan.map((row) => row.detail).join(' ')).toContain('Trace_executionRootRef_createdAt_idx');
      const selfPlan = database.prepare('EXPLAIN QUERY PLAN SELECT id FROM "Trace" WHERE executionSelfRef >= ? AND executionSelfRef < ?').all('hx1:ardent:a:attempt:t/', 'hx1:ardent:a:attempt:t/~') as {detail: string}[];
      expect(selfPlan.map((row) => row.detail).join(' ')).toContain('Trace_executionSelfRef_idx');
    } finally {database.close();}
  });
});
