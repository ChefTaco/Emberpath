import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { expect, it } from 'vitest';
import { schemaStatements } from '../../src/storage/generated-sqlite-schema.js';
import { applyRoutingRevision, routingSnapshot } from '../../src/routing/revisions.js';
import { ActorJournal } from '../../src/admin/actor-journal.js';
import { actorJournalWrite } from '../../src/admin/actor-journal-runtime.js';

it('protects a revision snapshot from another SQLite writer and rejects stale comparisons', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'routing-revision-')); const path = join(directory, 'router.db');
  const other = new Database(path);
  for (const statement of schemaStatements) other.exec(statement);
  other.exec('PRAGMA busy_timeout = 0');
  const client = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: path, timeout: 0 }) });
  let blocked = 0; let comparing = false;
  const instrumented = client.$extends({ query: { modelAlias: { async findMany({ args, query }) {
    if (!comparing) return query(args);
    // Another connection attempts a write while revision comparison is reading.
    // It must not obtain a reservation and invalidate that read snapshot.
    try {
      other.exec('BEGIN IMMEDIATE'); other.exec('ROLLBACK');
      throw new Error('Concurrent writer entered the revision snapshot');
    } catch (error) {
      if ((error as { code?: string }).code !== 'SQLITE_BUSY') throw error;
      blocked++;
    }
    return query(args);
  } } } });
  // The extension only intercepts a query; Prisma's extension type changes its overloads.
  const database = instrumented as unknown as Pick<typeof client, '$transaction'>;
  try {
    const before = await routingSnapshot(client);
    const objective = { ...before.config.objective, goal: 'cheapest' };
    comparing = true;
    await applyRoutingRevision(before.revision, { objective }, 'operator', database);
    comparing = false;
    expect(blocked).toBe(1);
    const after = await routingSnapshot(client);
    expect(after.revision).not.toBe(before.revision);
    comparing = true;
    await expect(applyRoutingRevision(before.revision, { objective: before.config.objective }, 'operator', database)).rejects.toMatchObject({ status: 409 });
    comparing = false;
    expect((await routingSnapshot(client)).revision).toBe(after.revision);
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    let release!: () => void;
    const releaseWriter = new Promise<void>((resolve) => { release = resolve; });
    const writer = client.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "RuntimeSetting" SET "valueJson" = '{}' WHERE "key" = 'routing.write-lock'`;
      acquired(); await releaseWriter;
    });
    await ready;
    const journal = new ActorJournal(other); let timerRan = false;
    const timer = setTimeout(() => { timerRan = true; release(); }, 50);
    try {
      const lease = await actorJournalWrite(() => journal.holdEnrollment('prisma-contention-fixture'));
      expect(timerRan).toBe(true);
      journal.release(lease);
    } finally { clearTimeout(timer); release(); await writer; }
  } finally { await client.$disconnect(); other.close(); rmSync(directory, { recursive: true, force: true }); }
});
