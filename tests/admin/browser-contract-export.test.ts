import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, it} from 'vitest';
import {exportModelAdminContract} from '../../scripts/lib/browser-contract-export.js';

it('exports exact committed browser bytes and version, preserving attribution without local files or overwrites', () => {
  const root = mkdtempSync(join(tmpdir(), 'emberpath-public-contract-'));
  try {
    const git = (args: string[]) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
    git(['init', '--quiet']); mkdirSync(join(root, 'src/contracts'), {recursive: true});
    const source = 'src/contracts/model-admin.ts', text = "import {z} from 'zod';\nexport const modelAdminContractVersion=1;\n";
    for (const [name, value] of [[source, text], ['package.json', '{"version":"1.2.3"}'], ['LICENSE', 'Synthetic Apache notice'], ['NOTICE', 'Synthetic source attribution']]) writeFileSync(join(root, name!), value!);
    git(['add', '.']); git(['-c', 'commit.gpgsign=false', '-c', 'user.name=Example Contributor', '-c', 'user.email=contributor@example.com', 'commit', '--quiet', '-m', 'test: public contract']);
    const revision = git(['rev-parse', 'HEAD']);
    writeFileSync(join(root, source), '// Unreviewed local content\n'); writeFileSync(join(root, 'package.json'), '{"version":"9.9.9"}');
    writeFileSync(join(root, '.env'), 'SYNTHETIC_SECRET=obviously-fake-local-only\n');
    const output = join(root, 'export'); exportModelAdminContract(root, output);
    expect(readdirSync(output).sort()).toEqual(['LICENSE', 'NOTICE', 'model-admin.ts', 'provenance.json']);
    expect(readFileSync(join(output, 'model-admin.ts'), 'utf8')).toBe(text);
    expect(JSON.parse(readFileSync(join(output, 'provenance.json'), 'utf8'))).toMatchObject({revision, source, productVersion: '1.2.3', sha256: createHash('sha256').update(text).digest('hex')});
    expect(statSync(output).mode & 0o777).toBe(0o700); expect(statSync(join(output, 'model-admin.ts')).mode & 0o777).toBe(0o600);
    expect(() => exportModelAdminContract(root, output)).toThrow();
    expect(readFileSync(join(output, 'model-admin.ts'), 'utf8')).toBe(text);
  } finally {rmSync(root, {recursive: true, force: true});}
});
