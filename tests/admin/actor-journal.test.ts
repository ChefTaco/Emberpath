import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ActorJournal } from '../../src/admin/actor-journal.js';
import { schemaStatements } from '../../src/storage/generated-sqlite-schema.js';
import { actorJournalWrite } from '../../src/admin/actor-journal-runtime.js';

function open(path = ':memory:') {
  const database = new Database(path);
  for (const sql of schemaStatements) database.exec(sql);
  return database;
}
const request = () => ({ operationId: randomUUID(), bindingKey: 'enrollment:fixture', actorId: 'fixture', ownerId: 'operator', action: 'rotate' as const, identifiers: { routerClientKeyId: 'key' } });

it('resumes after reopen, keeps encrypted receipts, and excludes another owner or action', () => {
  const directory = mkdtempSync(join(tmpdir(), 'actor-journal-')); const path = join(directory, 'router.db');
  let database = open(path);
  try {
    let journal = new ActorJournal(database); const input = request(); const run = journal.begin(input);
    run.steps.iam = { service: 'iam', action: 'rotate', resourceId: 'service-account', status: 200, ok: true, attempts: 1 };
    run.secrets.iamApiKey = 'one-time-credential-sentinel'; run.operation.status = 'partial';
    journal.checkpoint(run); journal.release(run.lease!);
    const row = database.prepare('SELECT * FROM ActorLifecycleOperation').get();
    expect(JSON.stringify(row)).not.toContain('one-time-credential-sentinel');
    database.close(); database = open(path); journal = new ActorJournal(database);
    expect(() => journal.begin({ ...input, ownerId: 'different-operator' })).toThrow(/another/);
    expect(() => journal.begin({ ...input, action: 'disable' })).toThrow(/another/);
    const resumed = journal.begin(input);
    expect(resumed.steps.iam?.ok).toBe(true); expect(resumed.secrets.iamApiKey).toBe('one-time-credential-sentinel');
    resumed.operation.status = 'completed'; journal.checkpoint(resumed); journal.release(resumed.lease!);
    const replay = journal.begin(input); expect(replay.lease).toBeNull(); expect(replay.secrets).toEqual(resumed.secrets);
    expect(() => journal.acknowledge(input.operationId, 'different-operator')).toThrow();
    journal.acknowledge(input.operationId, 'operator');
    expect(database.prepare('SELECT encryptedSecrets FROM ActorLifecycleOperation').get()).toMatchObject({ encryptedSecrets: null });
    expect(() => journal.begin(input)).toThrow(/expired or was captured/);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('serializes independent connections, fences expired workers and shares the enrollment lock', () => {
  const directory = mkdtempSync(join(tmpdir(), 'actor-lease-')); const path = join(directory, 'router.db');
  const firstDb = open(path); const secondDb = open(path); let now = Date.now();
  try {
    const first = new ActorJournal(firstDb, undefined, () => now); const second = new ActorJournal(secondDb, undefined, () => now);
    const input = request(); const enrollmentLease = first.holdEnrollment(input.bindingKey);
    expect(() => second.begin(input)).toThrow(/running/); first.release(enrollmentLease);
    const old = first.begin(input); expect(() => second.begin(input)).toThrow(/running/);
    now += 120_001; const recovered = second.begin(input);
    expect(() => first.checkpoint(old)).toThrow(/lease was lost/);
    first.release(old.lease!); // An old worker cannot release its successor's lock.
    expect(() => first.begin(input)).toThrow(/running/);
    second.release(recovered.lease!);
    expect(() => first.holdEnrollment(input.bindingKey)).toThrow(/pending lifecycle/);
  } finally { firstDb.close(); secondDb.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('commits local key mutation and receipt together, and rolls both back on failure', () => {
  const database = open();
  try {
    database.exec('CREATE TABLE FixtureKey(value TEXT)'); database.prepare('INSERT INTO FixtureKey VALUES (?)').run('old');
    const journal = new ActorJournal(database); const run = journal.begin(request());
    run.secrets.routerApiKey = 'new-key-sentinel';
    expect(() => journal.checkpoint(run, (db) => { db.exec("UPDATE FixtureKey SET value = 'new'"); throw new Error('interrupted'); })).toThrow('interrupted');
    expect(database.prepare('SELECT value FROM FixtureKey').get()).toMatchObject({ value: 'old' });
    expect(database.prepare('SELECT encryptedSecrets FROM ActorLifecycleOperation').get()).toMatchObject({ encryptedSecrets: null });
    journal.checkpoint(run, (db) => { db.exec("UPDATE FixtureKey SET value = 'new'"); });
    expect(database.prepare('SELECT value FROM FixtureKey').get()).toMatchObject({ value: 'new' });
    expect(JSON.stringify(database.prepare('SELECT * FROM ActorLifecycleOperation').get())).not.toContain('new-key-sentinel');
  } finally { database.close(); }
});

it('Disable compensates partial rotation, clears receipts, and cannot resume the old operation', () => {
  const database = open();
  try {
    const journal = new ActorJournal(database); const input = request(); const run = journal.begin(input);
    run.secrets.iamApiKey = 'rotation-sentinel'; run.operation.status = 'partial'; journal.checkpoint(run); journal.release(run.lease!);
    expect(() => journal.begin({ ...input, operationId: randomUUID() })).toThrow(/Resume/);
    const disabled = journal.begin({ ...input, operationId: randomUUID(), action: 'disable', ownerId: 'containment-operator' });
    expect(database.prepare('SELECT status, encryptedSecrets FROM ActorLifecycleOperation WHERE id = ?').get(input.operationId)).toMatchObject({ status: 'compensated', encryptedSecrets: null });
    journal.release(disabled.lease!);
    expect(() => journal.begin(input)).toThrow(/cannot resume/);
  } finally { database.close(); }
});

it('expires receipts and requires explicit recovery instead of replaying a completed rotation', () => {
  const database = open(); let now = Date.now();
  try {
    const journal = new ActorJournal(database, undefined, () => now); const input = request(); const run = journal.begin(input);
    run.secrets.iamApiKey = 'expiring'; run.operation.status = 'completed'; journal.checkpoint(run); journal.release(run.lease!);
    now += 900_001;
    expect(() => journal.begin(input)).toThrow(/expired/);
    // A rejected replay rolls its own transaction back; independent retention
    // still physically clears the expired encrypted blob.
    journal.expireReceipts();
    expect(database.prepare('SELECT encryptedSecrets FROM ActorLifecycleOperation').get()).toMatchObject({ encryptedSecrets: null });
    const next = journal.begin({ ...input, operationId: randomUUID() }); journal.release(next.lease!);
    expect(() => journal.begin(input)).toThrow(/cannot resume/);
  } finally { database.close(); }
});

it('lets timers and asynchronous writers progress while another connection holds SQLite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'actor-busy-')); const path = join(directory, 'router.db');
  const writer = open(path); const reader = open(path);
  try {
    const journal = new ActorJournal(reader);
    writer.exec('BEGIN IMMEDIATE');
    let released = false;
    const timer = setTimeout(() => { writer.exec('COMMIT'); released = true; }, 50);
    try {
      const run = await actorJournalWrite(() => journal.begin(request()));
      expect(released).toBe(true); expect(run.lease).not.toBeNull();
      journal.release(run.lease!);
    } finally { clearTimeout(timer); if (!released) writer.exec('ROLLBACK'); }
  } finally { writer.close(); reader.close(); rmSync(directory, { recursive: true, force: true }); }
});
