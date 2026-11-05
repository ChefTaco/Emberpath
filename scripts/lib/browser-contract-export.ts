import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

/** Export exact reviewed Git objects; working-tree files and replace refs are not release inputs. */
export function exportModelAdminContract(root: string, output: string): void {
  const git = (args: string[]) => execFileSync('git', ['--no-replace-objects', ...args], {cwd: root});
  const revision = git(['rev-parse', '--verify', 'HEAD^{commit}']).toString('utf8').trim();
  const source = 'src/contracts/model-admin.ts', contract = git(['show', revision + ':' + source]);
  if (!/export const modelAdminContractVersion\s*=\s*1\s*;/u.test(contract.toString('utf8'))) throw Error('Unsupported committed browser contract version');
  if (/from\s+['"](?!zod['"])/u.test(contract.toString('utf8'))) throw Error('Browser contract imports a backend implementation');
  const productVersion: unknown = JSON.parse(git(['show', revision + ':package.json']).toString('utf8')).version;
  if (typeof productVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(productVersion)) throw Error('Committed product version is invalid');
  const manifest = {schema: 1, product: 'emberpath-model-admin', contractVersion: 1, productVersion,
    repository: 'https://github.com/ChefTaco/Emberpath', revision, source, sha256: createHash('sha256').update(contract).digest('hex')};
  const license = git(['show', revision + ':LICENSE']), notice = git(['show', revision + ':NOTICE']);
  mkdirSync(output, {mode: 0o700});
  for (const [name, bytes] of [['model-admin.ts', contract], ['LICENSE', license], ['NOTICE', notice],
    ['provenance.json', JSON.stringify(manifest, null, 2) + '\n']] as const)
    writeFileSync(join(output, name), bytes, {mode: 0o600, flag: 'wx'});
}
