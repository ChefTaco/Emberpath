import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { assertNodeVersion, packageNodeRange } from './check-node-runtime.mjs';

const range = packageNodeRange();
test('native deployment follows package engines and rejects vulnerable or unsupported Node', () => {
  for (const version of ['24.22.3', '24.23.0', '26.13.1', '26.14.0']) assert.doesNotThrow(() => assertNodeVersion(version, range));
  for (const version of ['22.23.5', '24.22.0', '24.22.1', '24.22.2', '25.0.0', '26.13.0', '27.0.0', '24.22.3-rc.1', '24.022.3']) {
    assert.throws(() => assertNodeVersion(version, range), /Node.js/);
  }
  // The guard reads the package policy, rather than duplicating its patch floor.
  assert.throws(() => assertNodeVersion('24.22.3', '^24.22.4'), /required/);
  for (const invalid of ['>=22', '*', '^24.22.3; id', '', undefined]) assert.throws(() => assertNodeVersion('24.22.3', invalid));
});

test('streamed SSH preflight fails closed before a following deployment mutation', () => {
  const helper = readFileSync(new URL('./check-node-runtime.mjs', import.meta.url), 'utf8');
  for (const [version, accepted] of [['24.22.2', false], ['26.13.0', false], ['22.23.5', false], ['24.22.3', true], ['26.13.1', true]]) {
    const source = `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });\n` + helper;
    const child = spawnSync('bash', ['-e', '-c', '"$1" --input-type=module - --engines "$2"; printf DEPLOYMENT_ALLOWED', 'preflight-test', process.execPath, range], { input: source, encoding: 'utf8' });
    assert.equal(child.status, accepted ? 0 : 1, child.stderr);
    assert.equal(child.stdout, accepted ? 'DEPLOYMENT_ALLOWED' : '');
  }
});

test('the native deployment rejects an unsupported host before any install or activation', () => {
  for (const reject of ['path', 'service']) {
    assert.match(readFileSync(new URL('deploy-hive-router.sh', import.meta.url), 'utf8'), /^ExecStart=\/usr\/bin\/node /m);
    const temporary = mkdtempSync(join(tmpdir(), 'native-node-preflight-'));
    try {
      const root = join(temporary, 'product'), bin = join(temporary, 'bin'), log = join(temporary, 'calls');
      mkdirSync(join(root, 'scripts'), { recursive: true }); mkdirSync(bin);
      const manifest = join(root, 'package.json'); mkdirSync(dirname(manifest), { recursive: true });
      writeFileSync(manifest, JSON.stringify({ engines: { node: range } }));
      for (const name of ['deploy-hive-router.sh', 'check-node-runtime.mjs']) copyFileSync(new URL(name, import.meta.url), join(root, 'scripts', name));
      writeFileSync(join(root, '.env'), 'SSH_HOST=node.example.com\nSSH_USERNAME=deploy\nHIVEMEM_REFRESH_ADMIN_TOKEN=false\nHIVEMEM_PRESERVE_REMOTE_ENV=true\n');
      writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DEPLOY_GUARD_LOG"\nif [ \"$DEPLOY_GUARD_REJECT\" = service ]; then case \"$*\" in *\"/usr/bin/node\"*) ;; *) exit 0;; esac; fi\nprintf SYNTHETIC_GUARD_REJECTED >&2\nexit 1\n', { mode: 0o755 });
      writeFileSync(join(bin, 'ssh-keygen'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      for (const command of ['scp', 'rsync', 'sudo', 'npm']) writeFileSync(join(bin, command), '#!/bin/sh\nprintf MUTATION >> "$DEPLOY_GUARD_LOG"\nexit 99\n', { mode: 0o755 });
      const child = spawnSync('bash', [join(root, 'scripts', 'deploy-hive-router.sh')], { encoding: 'utf8', env: {
        PATH: bin + ':' + process.env.PATH, HOME: temporary, DEPLOY_GUARD_LOG: log, DEPLOY_GUARD_REJECT: reject,
        DEPLOY_HOST: 'node.example.com', DEPLOY_USER: 'deploy', HIVE_IAM_DEPLOY_HOST: 'node.example.com',
        HIVE_SKILLS_DEPLOY_HOST: 'node.example.com', HIVE_PUBLIC_URL: 'https://identity.example.com',
      } });
      assert.equal(child.status, 1, child.stderr);
      assert.match(child.stderr, /SYNTHETIC_GUARD_REJECTED/);
      const calls = readFileSync(log, 'utf8');
      assert.match(calls, /node --input-type=module - --engines/);
      assert.doesNotMatch(calls, /MUTATION/);
      assert.equal(calls.trim().split('\n').length, reject === 'path' ? 1 : 2);
      if (reject === 'service') assert.match(calls, /\/usr\/bin\/node --input-type=module/);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
});
