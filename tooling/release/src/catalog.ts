import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { run } from './files.js';
import { compareVersions, parseVersion, releaseSchema, type Release } from './manifest.js';

export interface Catalog {
  releases: Release[];
  sources: Map<string, string>;
  packages: Map<string, PackageMetadata>;
}
export interface PackageMetadata {
  name: string;
  version: string;
  engines?: { node?: string };
  hiveRelease?: unknown;
  dist?: { integrity?: string };
}
export function registryUrl(env = process.env): string {
  const url = new URL(env.HIVE_UPDATE_REGISTRY || 'https://registry.npmjs.org');
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
  )
    throw new Error(
      'Registry must use HTTPS (HTTP allowed only on loopback), without URL credentials',
    );
  return url.toString().replace(/\/$/, '');
}
export async function catalog(from?: string, registry = registryUrl()): Promise<Catalog> {
  const result: Catalog = { releases: [], sources: new Map(), packages: new Map() };
  if (from) {
    for (const name of readdirSync(from).filter((n) => n.endsWith('.tgz'))) {
      const file = resolve(from, name);
      const pkg = JSON.parse(
        await run('tar', ['-xOf', file, 'package/package.json']),
      ) as PackageMetadata;
      parseVersion(pkg.version);
      if (!pkg.name.startsWith('@hivemagnus/')) continue;
      const key = `${pkg.name}@${pkg.version}`;
      if (result.sources.has(key)) throw new Error(`Duplicate source tarball for ${key}`);
      result.sources.set(key, file);
      result.packages.set(key, {
        ...pkg,
        dist: {
          integrity: `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`,
        },
      });
      if (pkg.name === '@hivemagnus/hive')
        result.releases.push(releaseSchema.parse(pkg.hiveRelease));
    }
    return result;
  }
  const response = await fetch(`${registry}/@hivemagnus%2fhive`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Registry lookup failed (${response.status})`);
  const doc = (await response.json()) as { versions: Record<string, PackageMetadata> };
  for (const [v, pkg] of Object.entries(doc.versions))
    if (pkg.hiveRelease) {
      const manifest = releaseSchema.parse(pkg.hiveRelease);
      if (manifest.version !== v) throw new Error('Registry release version mismatch');
      try {
        parseVersion(v);
        result.releases.push(manifest);
        result.packages.set(`@hivemagnus/hive@${v}`, pkg);
      } catch {
        /* never choose prereleases */
      }
    }
  return result;
}
export async function packageMetadata(
  source: Catalog,
  name: string,
  version: string,
  from?: string,
): Promise<PackageMetadata> {
  const key = `${name}@${version}`;
  const known = source.packages.get(key);
  if (known) return known;
  if (from) throw new Error(`Missing tarball for ${key}`);
  const response = await fetch(
    `${registryUrl()}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new Error(`Target package is unavailable: ${key}`);
  const pkg = (await response.json()) as PackageMetadata;
  source.packages.set(key, pkg);
  return pkg;
}
export function targetRelease(available: Release[], current: string, requested?: string): Release {
  const candidates = available
    .filter((r) =>
      requested
        ? r.version === requested
        : parseVersion(r.version)[0] === parseVersion(current)[0] &&
          compareVersions(r.version, current) > 0,
    )
    .sort((a, b) => compareVersions(b.version, a.version));
  if (!candidates[0])
    throw new Error(
      requested
        ? `No complete release manifest for ${requested}`
        : 'No newer supported Hive release is available',
    );
  return candidates[0];
}
