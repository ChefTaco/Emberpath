import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { candidateArtifacts } from '../../../scripts/upgrade-candidate.mjs';
import { run } from '../src/files.js';

test('post-publication CI creates a complete synthetic candidate without editing the working tree', async () => {
  const work = mkdtempSync(join(tmpdir(), 'hive-candidate-test-'));
  const packs = join(work, 'packs');
  mkdirSync(packs);
  const original = { name: '@hivemagnus/hive', version: '1.2.0' };
  try {
    for (const name of ['hive', 'hivemem-server']) {
      const dir = join(work, name, 'package');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: `@hivemagnus/${name}`,
          version: '1.2.0',
          hiveRelease: {
            version: '1.2.0',
            components: { '@hivemagnus/hive': '1.2.0', '@hivemagnus/hivemem-server': '1.2.0' },
            testedSdks: { '@hivemagnus/hivemem-sdk': '1.0.3' },
          },
        }),
      );
      await run('tar', [
        '-czf',
        join(packs, `hivemagnus-${name}-1.2.0.tgz`),
        '-C',
        join(dir, '..'),
        'package',
      ]);
    }
    const candidate = await candidateArtifacts(work, packs, original, '1.2.0', run);
    assert.equal(candidate.version, '1.2.1');
    assert.equal(original.version, '1.2.0');
    for (const file of readdirSync(packs)) {
      const pkg = JSON.parse(await run('tar', ['-xOf', join(packs, file), 'package/package.json']));
      assert.equal(pkg.version, '1.2.1');
      assert(Object.values(pkg.hiveRelease.components).every((v) => v === '1.2.1'));
      assert.equal(pkg.hiveRelease.testedSdks['@hivemagnus/hivemem-sdk'], '1.0.3');
    }
    assert.equal(
      JSON.parse(readFileSync(join(work, 'hive/package/package.json'), 'utf8')).version,
      '1.2.0',
    );
    await assert.rejects(
      candidateArtifacts(work, packs, original, '2.0.0', run),
      /same supported major/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
