import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { request } from 'node:http';
import { planUpgrade, rollback } from '../src/engine.js';
import { hash, writeJson } from '../src/files.js';
import { coordinatorRequest } from '../src/coordinator.js';
import { serviceEnv } from '../src/project.js';
import { storeSpec } from '../src/backup.js';

test('managed relative data and protected paths resolve against the installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-relative-paths-'));
  try {
    mkdirSync(join(root, 'config'));
    writeFileSync(
      join(root, 'config/router.env'),
      'DATA_DIR=data/router\nDATABASE_URL=file:data/router/state.db?mode=rwc\nTLS_KEY_PATH=tls/server.key\n',
    );
    const env = serviceEnv(root, 'router');
    assert.equal(env.DATA_DIR, join(root, 'data/router'));
    assert.equal(env.TLS_KEY_PATH, join(root, 'tls/server.key'));
    assert.equal(env.DATABASE_URL, `file:${join(root, 'data/router/state.db')}?mode=rwc`);
    assert.deepEqual(storeSpec('router', env, root).sqlite, [join(root, 'data/router/state.db')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hive-control-test-'));
  const dir = join(root, 'versions/baseline');
  mkdirSync(dir, { recursive: true });
  writeJson(join(root, 'config/project.json'), {
    schema: 1,
    id: randomUUID(),
    manager: 'foreground',
    services: ['router'],
    launcher: '@hivemagnus/hive',
    createdAt: new Date().toISOString(),
  });
  writeJson(join(dir, 'node_modules/@hivemagnus/hive/package.json'), {
    name: '@hivemagnus/hive',
    version: '1.1.0',
  });
  writeJson(join(dir, 'node_modules/@hivemagnus/hive-router/package.json'), {
    name: '@hivemagnus/hive-router',
    version: '1.0.3',
  });
  writeFileSync(join(root, 'config/router.env'), `HIVE_ROUTER_SECRET=${'example-'.repeat(8)}\n`);
  symlinkSync(dir, join(root, 'current'));
  mkdirSync(join(root, 'router'));
  const db = new DatabaseSync(join(root, 'router/router.db'));
  db.exec('CREATE TABLE fixture(id TEXT)');
  db.close();
  return root;
}
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.isFile()) result[p] = hash(readFileSync(p));
    }
  };
  walk(root);
  return result;
}
test('rollback records interrupted recovery before stopping any writer', async () => {
  const root = fixture();
  try {
    const id = randomUUID();
    writeJson(join(root, 'run/last-transaction.json'), {
      schema: 1,
      id,
      installation: JSON.parse(readFileSync(join(root, 'config/project.json'), 'utf8')).id,
      action: 'upgrade',
      from: '1.1.0',
      to: '1.2.0',
      oldDirectory: join(root, 'versions/baseline'),
      newDirectory: join(root, 'versions/baseline'),
      phase: 'completed',
      completedAt: new Date().toISOString(),
    });
    await assert.rejects(
      rollback(
        root,
        {},
        {
          stop: async () => {
            throw new Error('Synthetic stop interruption');
          },
          start: async () => {},
          health: async () => {},
        },
      ),
      /Synthetic stop interruption/,
    );
    const receipt = readdirSync(join(root, 'run')).find((f) => /^transaction-/.test(f))!;
    const pending = JSON.parse(readFileSync(join(root, 'run', receipt), 'utf8'));
    assert.equal(pending.recoveryOf, id);
    assert.equal(pending.phase, 'held-for-recovery');
    assert.equal(pending.completedAt, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('upgrade dry-run resolves exact tarballs without changing the managed installation', async () => {
  const root = fixture();
  const source = mkdtempSync(join(tmpdir(), 'hive-tarball-test-'));
  const manifest = JSON.parse(
    readFileSync(new URL('../../hive/package.json', import.meta.url), 'utf8'),
  ).hiveRelease;
  try {
    for (const name of ['@hivemagnus/hive', '@hivemagnus/hive-router']) {
      const staging = join(source, name.split('/')[1]!);
      mkdirSync(join(staging, 'package'), { recursive: true });
      writeJson(join(staging, 'package/package.json'), {
        name,
        version: manifest.version,
        hiveRelease: manifest,
        engines: manifest.engines,
      });
      assert.equal(
        spawnSync('tar', [
          '-czf',
          join(source, `${name.split('/')[1]}.tgz`),
          '-C',
          staging,
          'package',
        ]).status,
        0,
      );
    }
    const before = snapshot(root);
    const plan = await planUpgrade(root, { from: source, dryRun: true });
    assert.equal(plan.from, '1.1.0');
    assert.equal(plan.target.version, manifest.version);
    assert.deepEqual(plan.services, ['router']);
    assert.deepEqual(snapshot(root), before);
    writeFileSync(
      join(root, 'config/router.env'),
      `HIVE_ROUTER_SECRET=${'different-example-'.repeat(4)}\n`,
    );
    assert.notEqual(
      (await planUpgrade(root, { from: source, dryRun: true })).hash,
      plan.hash,
      'configuration edits invalidate the displayed plan',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});
test('owner-only coordinator rejects unknown plans and arbitrary apply properties', async () => {
  const root = fixture();
  const runtime = pathToFileURL(
    resolve(import.meta.dirname, '../../hive/src/release/runtime.js'),
  ).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {serveCoordinator} from ${JSON.stringify(runtime)};await serveCoordinator(${JSON.stringify(root)})`,
    ],
    {
      env: {
        PATH: process.env.PATH,
        HIVE_HOME: root,
        HIVE_UI_UPGRADE: 'true',
        HIVE_UPDATE_CHECK: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr += c;
  });
  try {
    await new Promise<void>((yes, no) => {
      child.stdout.once('data', () => yes());
      child.once('error', no);
      child.once('exit', () => no(new Error(stderr)));
    });
    assert.equal(statSync(join(root, 'run/coordinator.sock')).mode & 0o777, 0o600);
    const local = await new Promise<number>((yes, no) => {
      const req = request(
        { socketPath: join(root, 'run/coordinator.sock'), path: '/local', method: 'POST' },
        (res) => {
          res.resume();
          res.once('end', () => yes(res.statusCode!));
        },
      );
      req.once('error', no);
      req.end(
        JSON.stringify({ command: 'upgrade', options: { from: '/tmp/example-untrusted-package' } }),
      );
    });
    assert.equal(local, 403, 'web socket access cannot use the owner CLI operation');
    await assert.rejects(
      coordinatorRequest(root, 'apply', { planHash: 'a'.repeat(64) }),
      /unknown plan/,
    );
    await assert.rejects(
      coordinatorRequest(root, 'apply', { planHash: 'a'.repeat(64), command: 'arbitrary' }),
    );
    const status = (await coordinatorRequest(root, 'status')) as {
      busy: boolean;
      updates: { enabled: boolean };
    };
    assert.equal(status.busy, false);
    assert.equal(status.updates.enabled, false);
    const pendingId = randomUUID();
    writeJson(join(root, 'run', `transaction-${pendingId}.json`), {
      schema: 1,
      id: pendingId,
      installation: JSON.parse(readFileSync(join(root, 'config/project.json'), 'utf8')).id,
      action: 'upgrade',
      from: '1.2.0',
      to: '1.2.1',
      oldDirectory: join(root, 'versions/baseline'),
      phase: 'held-for-restore',
      error: 'Synthetic recovery failure',
    });
    const held = (await coordinatorRequest(root, 'status')) as {
      result: { version: string; state: string; error: string };
    };
    assert.equal(held.result.version, '1.2.1');
    assert.equal(held.result.state, 'held-for-restore');
    assert.equal(held.result.error, 'Synthetic recovery failure');
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((r) => {
      if (child.exitCode !== null) r();
      else child.once('exit', () => r());
    });
    rmSync(root, { recursive: true, force: true });
  }
});
