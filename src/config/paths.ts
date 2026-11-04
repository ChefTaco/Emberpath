import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locations that belong to the installed package, independent of the process
 * working directory. The same code runs from `src/` (tsx, vitest) and from
 * `dist/src/` (production and the npm package), so the package root is found
 * by walking up to the nearest package.json instead of a fixed `../..`.
 */
function findPackageRoot(start: string): string {
  let current = start;
  for (;;) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start, '..', '..');
    current = parent;
  }
}

export const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

/** Built console assets (`vite build` output) shipped with the package. */
export const uiDistDir = resolve(packageRoot, 'ui', 'dist');

interface PackageInfo {
  name: string;
  version: string;
}

let cachedPackageInfo: PackageInfo | null = null;

export function packageInfo(): PackageInfo {
  if (cachedPackageInfo) return cachedPackageInfo;
  const raw = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Partial<PackageInfo>;
  cachedPackageInfo = { name: raw.name ?? '@hivemagnus/hive-router', version: raw.version ?? '0.0.0' };
  return cachedPackageInfo;
}

/** `HIVE_HOME`, defaulting to `~/.hive`. Shared by the Hive server packages. */
export function hiveHome(source: NodeJS.ProcessEnv = process.env): string {
  const configured = source['HIVE_HOME']?.trim();
  if (configured) return resolve(configured.replace(/^~(?=$|\/)/u, homedir()));
  return join(homedir(), '.hive');
}

/** Default Router state directory: `${HIVE_HOME:-~/.hive}/router`. */
export function defaultDataDir(source: NodeJS.ProcessEnv = process.env): string {
  return join(hiveHome(source), 'router');
}
