import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { writeJson, withLock } from '../src/files.js';

test(
  'termination at every durable upgrade boundary leaves verifiable, conservative recovery state',
  { timeout: 120_000 },
  async () => {
    const work = mkdtempSync(join(tmpdir(), 'hive-interruption-test-'));
    const source = join(work, 'packs');
    mkdirSync(source);
    const baseline = JSON.parse(
      readFileSync(new URL('../../hive/package.json', import.meta.url), 'utf8'),
    ).hiveRelease;
    const target = structuredClone(baseline);
    target.version = '1.2.1';
    for (const name of Object.keys(target.components)) target.components[name] = '1.2.1';
    const runtime = pathToFileURL(
      resolve(import.meta.dirname, '../../hive/src/release/runtime.js'),
    ).href;
    const bin = `import fs from 'node:fs';import path from 'node:path';const state=path.join(process.env.HIVE_HOME,'memory/format');const args=process.argv.slice(2);if(args[0]==='migrate'){if(args.includes('--plan'))console.log(JSON.stringify({pending:fs.existsSync(state)?[]:['format-1'],dataChanged:true}));else fs.writeFileSync(state,'format-1')}else console.log('{}');`;
    for (const [name, executable] of [
      ['@hivemagnus/hive', 'hive'],
      ['@hivemagnus/hivemem-server', 'hivemem-server'],
    ]) {
      const staging = join(work, executable!, 'package');
      mkdirSync(staging, { recursive: true });
      writeJson(join(staging, 'package.json'), {
        name,
        type: 'module',
        version: '1.2.1',
        engines: baseline.engines,
        hiveRelease: target,
        bin: { [executable!]: 'cli.js' },
      });
      writeFileSync(join(staging, 'cli.js'), bin);
      assert.equal(
        spawnSync('tar', [
          '-czf',
          join(source, `${executable}.tgz`),
          '-C',
          join(staging, '..'),
          'package',
        ]).status,
        0,
      );
    }
    try {
      for (const phase of [
        'quiescing',
        'backing-up',
        'migrating',
        'checking',
        'restarting',
        'health',
        'completed',
      ]) {
        const root = join(work, phase),
          old = join(root, 'versions/baseline');
        mkdirSync(join(root, 'memory'), { recursive: true });
        writeFileSync(join(root, 'memory/journal'), 'synthetic previous state');
        writeJson(join(root, 'config/project.json'), {
          schema: 1,
          id: randomUUID(),
          manager: 'foreground',
          services: ['memory'],
          launcher: '@hivemagnus/hive',
          createdAt: new Date().toISOString(),
        });
        writeFileSync(
          join(root, 'config/memory.env'),
          'HIVEMEM_TS_PERSISTENCE=memory\nHIVE_UPDATE_CHECK=false\n',
        );
        for (const [name, executable] of [
          ['@hivemagnus/hive', 'hive'],
          ['@hivemagnus/hivemem-server', 'hivemem-server'],
        ]) {
          const dir = join(old, 'node_modules', name!);
          mkdirSync(dir, { recursive: true });
          writeJson(join(dir, 'package.json'), {
            name,
            type: 'module',
            version: '1.2.0',
            engines: baseline.engines,
            hiveRelease: baseline,
            bin: { [executable!]: 'cli.js' },
          });
          writeFileSync(join(dir, 'cli.js'), bin);
        }
        symlinkSync(old, join(root, 'current'));
        const script = `const r=await import(${JSON.stringify(runtime)});await r.upgrade(${JSON.stringify(root)},{from:${JSON.stringify(source)}},{stop:async()=>{},start:async()=>{},health:async()=>{}},{afterPersist:async t=>{if(t.phase===${JSON.stringify(phase)}){process.stdout.write('boundary\\n');await new Promise(()=>{})}}});`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
          env: { PATH: process.env.PATH, HOME: work, HIVE_HOME: root, HIVE_UPDATE_CHECK: 'false' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
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
          child.kill('SIGKILL');
          await new Promise((r) => child.once('exit', r));
          const receipt = readdirSync(join(root, 'run')).find((f) => f.startsWith('transaction-'))!;
          const txn = JSON.parse(readFileSync(join(root, 'run', receipt), 'utf8'));
          assert.equal(txn.phase, phase);
          assert.equal(Boolean(txn.completedAt), phase === 'completed');
          if (['migrating', 'checking', 'restarting', 'health', 'completed'].includes(phase)) {
            const { verifyBackup } = await import('../src/backup.js');
            await verifyBackup(txn.backup, txn.installation);
          }
          // Kernel locks are released after coordinator death, without stale lock stealing.
          for (let attempt = 0; ; attempt++) {
            try {
              await withLock(join(root, 'run/upgrade.lock'), async () => {});
              break;
            } catch (error) {
              if (attempt >= 30) throw error;
              await new Promise((r) => setTimeout(r, 20));
            }
          }
          assert.equal(
            readFileSync(join(root, 'memory/journal'), 'utf8'),
            'synthetic previous state',
          );
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);
