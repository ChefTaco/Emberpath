import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handoff } from '../src/handoff.js';
import type { UpgradePlan } from '../src/engine.js';

test('staged engine handoff verifies capability and plan before owner manager operations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-handoff-test-'));
  const staged = join(root, 'versions/candidate');
  const runtime = join(staged, 'node_modules/@hivemagnus/hive/dist/src/release');
  mkdirSync(runtime, { recursive: true });
  mkdirSync(join(root, 'run'));
  writeFileSync(
    join(staged, 'node_modules/@hivemagnus/hive/package.json'),
    JSON.stringify({ type: 'module', version: '1.3.0' }),
  );
  const file = join(runtime, 'runtime.js');
  const plan = {
    hash: 'a'.repeat(64),
    from: '1.2.0',
    target: { version: '1.3.0', engineProtocol: 2 },
  } as UpgradePlan;
  const calls: string[] = [];
  const adapter = {
    stop: async () => {
      calls.push('stop');
    },
    start: async () => {
      calls.push('start');
    },
    health: async () => {
      calls.push('health');
    },
  };
  try {
    writeFileSync(file, 'export const ENGINE_PROTOCOL=1;');
    await assert.rejects(handoff(root, staged, plan, {}, adapter), /required protocol/);
    assert.deepEqual(calls, []);
    writeFileSync(
      file,
      `export const ENGINE_PROTOCOL=2;export async function planUpgrade(){return {hash:'changed'}}`,
    );
    await assert.rejects(handoff(root, staged, plan, {}, adapter), /plan changed/);
    assert.deepEqual(calls, []);
    writeFileSync(
      join(runtime, 'fixture.json'),
      JSON.stringify({ hash: plan.hash, staged }),
    );
    writeFileSync(
      file,
      `import { readFileSync } from 'node:fs';
const fixture=JSON.parse(readFileSync(new URL('./fixture.json',import.meta.url),'utf8'));
export const ENGINE_PROTOCOL=2;
export async function planUpgrade(){return {hash:fixture.hash}}
export async function upgrade(root,options,adapter){await adapter.stop();await adapter.start();await adapter.health(fixture.staged);return {phase:'completed'}}`,
    );
    const result = await handoff(root, staged, plan, {}, adapter);
    assert.equal(result.phase, 'completed');
    assert.deepEqual(calls, ['stop', 'start', 'health']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
