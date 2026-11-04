import { createRequire } from 'node:module';
import { mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const workspace = join(root, 'tooling/release');
const require = createRequire(join(workspace, 'package.json'));
const { build } = require('esbuild');
const target = join(root, ".");
const out = join(target, 'src/release');
if (process.argv.includes('--copy')) {
  const dist = join(target, "dist/src/release");
  mkdirSync(dist, { recursive: true });
  copyFileSync(join(out, 'runtime.js'), join(dist, 'runtime.js'));
  copyFileSync(join(workspace, 'node_modules/zod/LICENSE'), join(dist, 'ZOD_LICENSE'));
} else {
  const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(workspace, 'tsconfig.json'), '--emitDeclarationOnly'], {stdio:'inherit'});
  if (result.status !== 0) process.exit(result.status || 1);
  mkdirSync(out, {recursive:true});
  await build({ entryPoints:[join(workspace,'src/index.ts')], outfile:join(out,'runtime.js'), bundle:true, format:'esm', platform:'node', target:'node24', alias:{'node:sqlite':join(workspace,'src/sqlite-native.ts')} });
  for (const file of readdirSync(join(workspace,'dist')).filter(f=>f.endsWith('.d.ts')))
    copyFileSync(join(workspace,'dist',file), join(out,file==='index.d.ts'?'runtime.d.ts':file));
}
