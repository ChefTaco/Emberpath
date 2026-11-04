import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { QuotaLedger } from '../../src/security/quota-ledger.js';
import { schemaStatements } from '../../src/storage/generated-sqlite-schema.js';

it('reserves the last allowance once and survives trace deletion and window rollover', () => {
  const db = new Database(':memory:');
  try {
    for (const sql of schemaStatements) db.exec(sql);
    const ledger = new QuotaLedger(db); const now = new Date('2026-09-07T00:00:00Z');
    const first = ledger.reserve('key', 100, { dailyRequests: 1, monthlyTokens: 1000 }, now);
    expect(first.id).toBeTruthy();
    expect(ledger.reserve('key', 100, { dailyRequests: 1 }, now).exceeded).toContain('dailyRequests');
    ledger.attach(first.id!, 'trace'); ledger.settle('trace', 40); ledger.settle('trace', 10);
    expect(ledger.usage('key', now)).toMatchObject({ dayRequests: 1, monthTokens: 40 });
    db.exec('DELETE FROM Trace');
    expect(new QuotaLedger(db).usage('key', new Date('2026-09-08T00:00:00Z'))).toMatchObject({ dayRequests: 0, monthRequests: 1, monthTokens: 40 });
  } finally { db.close(); }
});

it('imports all retained usage beyond 20,000 traces and records incomplete historical coverage', () => {
  const db = new Database(':memory:');
  try {
    for (const sql of schemaStatements) if (sql.includes('"Quota')) db.exec(sql);
    db.exec('CREATE TABLE Trace(clientApiKeyId TEXT, startedAt INTEGER, usageJson TEXT)');
    const insert = db.prepare('INSERT INTO Trace VALUES (?,?,?)');
    const now = new Date('2026-09-07T00:00:00Z');
    db.exec('BEGIN');
    for (let n = 0; n < 20_001; n++) insert.run('fixture', now.getTime(), '{"totalTokens":2}');
    db.exec('COMMIT');
    const ledger = new QuotaLedger(db); ledger.migrateRetainedHistory(now);
    expect(ledger.usage('fixture', now)).toMatchObject({ monthRequests: 20_001, monthTokens: 40_002 });
    expect(ledger.history()?.historicalCoverage).toBe('retained-traces-only');
    db.exec('DELETE FROM Trace'); ledger.migrateRetainedHistory(now);
    expect(ledger.usage('fixture', now).monthTokens).toBe(40_002);
  } finally { db.close(); }
});

it('serializes the final allowance across independent Router processes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-quota-process-'));
  const path = join(directory, 'router.sqlite');
  const db = new Database(path);
  try {
    for (const sql of schemaStatements) db.exec(sql);
  } finally {
    db.close();
  }
  try {
    const fixture = resolve('tests/fixtures/quota-reserve.ts');
    const attempts = await Promise.all(Array.from({ length: 24 }, () => new Promise<{ id?: string; exceeded: string[] }>((resolveAttempt, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fixture, path, 'shared-key', '7', '70'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolveAttempt(JSON.parse(stdout) as { id?: string; exceeded: string[] }) : reject(new Error(stderr || `quota child exited ${code}`)));
    })));
    expect(attempts.filter((result) => result.id).length).toBe(7);
    expect(attempts.filter((result) => result.exceeded.length > 0).length).toBe(17);
    const verify = new Database(path, { readonly: true });
    try { expect(new QuotaLedger(verify).usage('shared-key')).toMatchObject({ dayRequests: 7, dayTokens: 70 }); }
    finally { verify.close(); }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

it('refunds a cancelled request once and retains an unknown usage reservation', () => {
  const db = new Database(':memory:');
  try {
    for (const sql of schemaStatements) db.exec(sql);
    const ledger = new QuotaLedger(db);
    const cancelled = ledger.reserve('key', 50, {}, new Date());
    ledger.attach(cancelled.id!, 'cancelled');
    ledger.settle('cancelled', 0, { estimated: false });
    ledger.settle('cancelled', 25, { estimated: false });
    const unknown = ledger.reserve('key', 80, {}, new Date());
    ledger.attach(unknown.id!, 'unknown');
    ledger.settle('unknown', undefined, { estimated: true });
    expect(ledger.usage('key')).toMatchObject({ dayRequests: 2, dayTokens: 80 });
  } finally { db.close(); }
});

it('keeps per-key trends isolated and reports mixed or missing price coverage as null', () => {
  const db = new Database(':memory:');
  try {
    for (const sql of schemaStatements) db.exec(sql);
    const ledger = new QuotaLedger(db);
    const priced = ledger.reserve('actor-a', 20, {}); ledger.attach(priced.id!, 'priced');
    ledger.settle('priced', 12, { costUsd: 0.25, source: 'operator-declared-provider-prices', estimated: false });
    const unknown = ledger.reserve('actor-a', 30, {}); ledger.attach(unknown.id!, 'unknown-price');
    ledger.settle('unknown-price', 30, { estimated: false });
    const other = ledger.reserve('actor-b', 40, {}); ledger.attach(other.id!, 'other');
    ledger.settle('other', 40, { costUsd: 1, source: 'operator-declared-provider-prices', estimated: false });
    expect(ledger.trends('actor-a')).toMatchObject([{ requests: 2, tokens: 42, costUsd: null }]);
    expect(ledger.trends('actor-b')).toMatchObject([{ requests: 1, tokens: 40, costUsd: 1 }]);
  } finally { db.close(); }
});
