import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupStores, restoreStores, verifyBackup } from '../src/backup.js';
import { hash, withLock, run } from '../src/files.js';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  autoEligible,
  canonicalJson,
  parseVersion,
  releaseSchema,
  satisfies,
} from '../src/manifest.js';
import { guardedMigration, schemaCommit, schemaPlan } from '../src/migration.js';
import { maintenanceDate, updateStatus } from '../src/updates.js';
import { releaseChanges } from '../src/engine.js';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { assertQdrantContainment } from '../src/qdrant-containment.js';

const manifest = () =>
  releaseSchema.parse(
    JSON.parse(readFileSync(new URL('../../hive/package.json', import.meta.url), 'utf8'))
      .hiveRelease,
  );

test('backup protects nested configuration env files without an ambiguous path regex', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-protected-path-test-'));
  try {
    const config = join(root, 'config', 'config', 'config');
    mkdirSync(config, { recursive: true });
    const envFile = join(config, 'operator.env');
    writeFileSync(envFile, 'SYNTHETIC_CONFIG=fixture');
    const receipt = await backupStores([{ service: 'router', paths: [envFile], sqlite: [] }], join(root, 'backup'), 'example-installation');
    assert.equal(receipt.files.length, 1);
    assert.equal(receipt.files[0]!.protected, true);
    assert.equal(receipt.files[0]!.source, envFile);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('manifest equivalence ignores object key order while preserving arrays and values', () => {
  assert.equal(
    canonicalJson({ pins: { router: '1.2.1', iam: '1.2.1' }, migrations: ['a', 'b'] }),
    canonicalJson({ migrations: ['a', 'b'], pins: { iam: '1.2.1', router: '1.2.1' } }),
  );
  assert.notEqual(
    canonicalJson({ migrations: ['a', 'b'] }),
    canonicalJson({ migrations: ['b', 'a'] }),
  );
  assert.notEqual(
    canonicalJson({ pins: { iam: '1.2.1' } }),
    canonicalJson({ pins: { iam: '1.2.2' } }),
  );
});
test('command output is drained after exit before JSON or errors are returned', async () => {
  const original = childProcess.spawn;
  let code = 0;
  childProcess.spawn = (() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    process.nextTick(() => {
      child.emit('exit', code);
      child.stdout.end(code === 0 ? '{"complete":true}' : '');
      child.stderr.end(code === 0 ? '' : 'Synthetic drained command failure');
      child.emit('close', code);
    });
    return child;
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try {
    assert.deepEqual(JSON.parse(await run('synthetic-output', [])), { complete: true });
    code = 1;
    await assert.rejects(run('synthetic-error', []), /Synthetic drained command failure/);
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  }
});
test('copied release-tooling semver conformance fixtures remain stable', () => {
  const fixtures = JSON.parse(
    readFileSync(new URL('../../../release/semver-fixtures.json', import.meta.url), 'utf8'),
  ) as { version: string; range: string; matches?: boolean; invalid?: boolean }[];
  for (const row of fixtures) {
    if (row.invalid) assert.throws(() => satisfies(row.version, row.range));
    else assert.equal(satisfies(row.version, row.range), row.matches, JSON.stringify(row));
  }
});
test('Qdrant restore cannot undo agent containment or forgotten memory tombstones', () => {
  assert.throws(
    () =>
      assertQdrantContainment(
        '_agents',
        { example: 'old-generation' },
        { example: 'new-generation' },
      ),
    /containment changed/,
  );
  assert.throws(
    () =>
      assertQdrantContainment('shared_semantic', { example: 'visible' }, { example: 'forgotten' }),
    /forgotten content/,
  );
  assert.throws(
    () => assertQdrantContainment('shared_semantic', { example: 'visible' }, {}),
    /containment changed/,
  );
  assertQdrantContainment(
    'shared_semantic',
    { example: 'visible' },
    { example: 'visible', additional: 'visible' },
  );
});
test('skipped releases retain required configuration and reject edited migrations', () => {
  const first = manifest(),
    last = manifest();
  first.newRequiredEnv = [
    {
      component: 'router',
      name: 'EXAMPLE_REQUIRED_SETTING',
      secret: false,
      description: 'Synthetic setting',
    },
  ];
  last.newRequiredEnv = [];
  assert.equal(releaseChanges([first, last]).newRequiredEnv[0]?.name, 'EXAMPLE_REQUIRED_SETTING');
  last.removedEnv = first.newRequiredEnv;
  assert.equal(releaseChanges([first, last]).newRequiredEnv.length, 0);
  last.migrations[0]!.checksum = 'a'.repeat(64);
  assert.throws(() => releaseChanges([first, last]), /Immutable migration checksum/);
});
test('strict semver and engine guards reject prereleases, unsupported ranges and future Node majors', () => {
  assert(satisfies('24.22.3', '^24.22.3 || ^26.13.1'));
  assert(!satisfies('22.23.5', '^24.22.3 || ^26.13.1'));
  assert(!satisfies('24.22.1', '^24.22.3 || ^26.13.1'));
  assert(!satisfies('24.22.2', '^24.22.3 || ^26.13.1'));
  assert(!satisfies('26.13.0', '^24.22.3 || ^26.13.1'));
  assert(satisfies('26.13.1', '^24.22.3 || ^26.13.1'));
  assert(!satisfies('24.22.0', '^24.22.3 || ^26.13.1'));
  assert(!satisfies('25.0.0', '^24.22.3 || ^26.13.1'));
  assert(!satisfies('27.0.0', '^24.22.3 || ^26.13.1'));
  for (const v of ['1.2.0-beta', '01.2.0', '1.2', '1.2.0;id']) assert.throws(() => parseVersion(v));
  assert.throws(() => satisfies('1.2.0', '*'));
});
test('unattended policy permits only approved stable patch/minor paths', () => {
  const m = manifest();
  assert(autoEligible('1.1.9', m, 'minor'));
  assert(!autoEligible('1.1.9', m, 'patch'));
  assert(!autoEligible('0.9.0', m, 'minor'));
  m.migrations[0]!.impact = 'one-way';
  assert(!autoEligible('1.1.9', m, 'minor'));
});
test('maintenance windows require timezone and leave a complete execution budget; DST dates are stable', () => {
  assert.equal(
    maintenanceDate(new Date('2026-11-01T07:10:00Z'), '01:00-02:00', 'America/Chicago'),
    '2026-11-01',
  );
  assert.equal(
    maintenanceDate(new Date('2026-11-01T07:50:00Z'), '01:00-02:00', 'America/Chicago'),
    null,
  );
  assert.equal(maintenanceDate(new Date(), undefined, 'UTC'), null);
  assert.throws(() => maintenanceDate(new Date(), '23:00-01:00', 'UTC'));
});
test('disabled update checks perform no registry request or filesystem write', async () => {
  const previous = process.env.HIVE_UPDATE_CHECK;
  delete process.env.HIVE_UPDATE_CHECK;
  const fetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('Unexpected network request');
  };
  try {
    assert.deepEqual(await updateStatus('1.2.0', '/nonexistent/example-upgrade-home'), {
      enabled: false,
      installed: '1.2.0',
    });
  } finally {
    globalThis.fetch = fetch;
    if (previous !== undefined) process.env.HIVE_UPDATE_CHECK = previous;
  }
});
test('SQLite backup includes WAL contents, rejects corruption and restores only the same installation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-backup-test-'));
  const file = join(dir, 'source.db');
  const db = new DatabaseSync(file);
  db.exec(
    "PRAGMA journal_mode=WAL;CREATE TABLE evidence(id TEXT PRIMARY KEY,value TEXT);INSERT INTO evidence VALUES('sample','before')",
  );
  const spec = { service: 'router' as const, paths: [], sqlite: [file] };
  const backup = join(dir, 'backup');
  try {
    await backupStores([spec], backup, 'example-installation');
    db.exec("UPDATE evidence SET value='after'");
    await assert.rejects(verifyBackup(backup, 'different-installation'), /another installation/);
    await assert.rejects(
      restoreStores([spec], backup, 'example-installation', 'wrong'),
      /confirmation/,
    );
    db.close();
    await restoreStores(
      [spec],
      backup,
      'example-installation',
      hash(readFileSync(join(backup, 'manifest.json'))),
    );
    const restored = new DatabaseSync(file);
    assert.equal(restored.prepare('SELECT value FROM evidence').get()!.value, 'before');
    restored.close();
    writeFileSync(join(backup, 'files/0'), 'corrupt');
    await assert.rejects(verifyBackup(backup, 'example-installation'), /checksum/);
  } finally {
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('kernel lock excludes concurrent migration and releases after a thrown error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-lock-test-'));
  const file = join(dir, 'migration.lock');
  try {
    await withLock(file, async () => {
      await assert.rejects(
        withLock(file, async () => {}),
        /holds the lock/,
      );
    });
    await assert.rejects(
      withLock(file, async () => {
        throw new Error('synthetic failure');
      }),
      /synthetic/,
    );
    await withLock(file, async () => {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('automatic migration refuses by default and no migration runs when backup fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-migrate-test-'));
  let applied = 0;
  const opts = {
    service: 'router' as const,
    spec: { service: 'router' as const, paths: [join(dir, 'missing-required-data')], sqlite: [] },
    lock: join(dir, 'migration.lock'),
    pending: () => true,
    apply: async () => {
      applied++;
    },
  };
  const previous = process.env.HIVE_AUTO_MIGRATE;
  delete process.env.HIVE_AUTO_MIGRATE;
  try {
    await assert.rejects(guardedMigration({ ...opts, automatic: true }), /HIVE_AUTO_MIGRATE=false/);
    await assert.rejects(guardedMigration(opts), /Required backup path/);
    assert.equal(applied, 0);
  } finally {
    if (previous !== undefined) process.env.HIVE_AUTO_MIGRATE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
test('schema planning is read-only and newer incompatible data fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-schema-test-'));
  const file = join(dir, 'schema.json');
  try {
    assert.equal(schemaPlan(file, 'old', '1.2.0').pending.length, 1);
    assert(!existsSync(file));
    schemaCommit(file, 'new', '2.0.0', '^2.0.0');
    assert.throws(() => schemaPlan(file, 'old', '1.2.0'), /newer code/);
    schemaCommit(file, 'new', '1.2.1', '^1.2.0');
    assert.deepEqual(schemaPlan(file, 'old', '1.2.0').pending, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore refuses to reactivate disabled identities or replace newer credential hashes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-containment-test-'));
  const source = join(root, 'iam.db');
  const spec = { service: 'iam' as const, paths: [], sqlite: [source] };
  const db = new DatabaseSync(source);
  try {
    db.exec(
      "CREATE TABLE users(id TEXT PRIMARY KEY,active INTEGER,passwordHash TEXT);INSERT INTO users VALUES('example-user',1,'synthetic-old-hash')",
    );
    const backup = join(root, 'backup');
    await backupStores([spec], backup, 'example-installation');
    const confirmation = hash(readFileSync(join(backup, 'manifest.json')));
    db.exec("UPDATE users SET active=0,passwordHash='synthetic-new-hash'");
    await assert.rejects(
      restoreStores([spec], backup, 'example-installation', confirmation),
      /containment changed/,
    );
    assert.equal(db.prepare('SELECT active FROM users').get()!.active, 0);
    assert.equal(
      db.prepare('SELECT passwordHash FROM users').get()!.passwordHash,
      'synthetic-new-hash',
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('disk exhaustion during backup prevents migration application', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-disk-test-'));
  const source = join(root, 'journal.txt');
  writeFileSync(source, 'synthetic persisted state');
  const original = fs.copyFileSync;
  let applied = false;
  try {
    fs.copyFileSync = () => {
      throw Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' });
    };
    syncBuiltinESMExports();
    await assert.rejects(
      guardedMigration({
        service: 'memory',
        spec: { service: 'memory', paths: [source], sqlite: [] },
        lock: join(root, 'migration.lock'),
        backupDir: join(root, 'backups'),
        pending: () => true,
        apply: async () => {
          applied = true;
        },
      }),
      /disk full/,
    );
    assert.equal(applied, false);
  } finally {
    fs.copyFileSync = original;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});
