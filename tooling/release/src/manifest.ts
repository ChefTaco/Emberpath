import { z } from 'zod';

export const SERVICES = ['iam', 'memory', 'skills', 'router'] as const;
export type Service = (typeof SERVICES)[number];
export const PACKAGES: Record<Service, string> = {
  iam: '@hivemagnus/hive-iam-server',
  memory: '@hivemagnus/hivemem-server',
  router: '@hivemagnus/hive-router',
  skills: '@hivemagnus/hive-skills',
};
export const BINS: Record<Service, string> = {
  iam: 'hive-iam-server',
  memory: 'hivemem-server',
  router: 'hive-router',
  skills: 'hive-skills',
};
export const NODE_RANGE = '^24.22.1 || ^26.13.0';
export const ENGINE_PROTOCOL = 1;
export const NATIVE_POLICY = {
  'better-sqlite3': true,
  argon2: true,
  'msgpackr-extract': false,
} as const;
const version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
const envEntry = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  component: z.enum([...SERVICES, 'launcher']),
  secret: z.boolean().default(false),
  description: z.string(),
});
export const migrationSchema = z.object({
  component: z.enum(SERVICES),
  id: z.string().min(1),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  impact: z.enum(['fast', 'slow', 'one-way']),
  readableBy: z.string(),
  note: z.string().optional(),
});
export const releaseSchema = z.object({
  schema: z.literal(1),
  version,
  engineProtocol: z.number().int().positive(),
  engines: z.object({ node: z.string() }),
  components: z.record(z.string(), version),
  optionalComponents: z.array(z.enum(SERVICES)).default(['skills']),
  testedSdks: z.record(z.string(), version),
  minUpgradeFrom: z.record(z.string(), version),
  requiredIntermediates: z.array(version).default([]),
  newRequiredEnv: z.array(envEntry),
  newOptionalEnv: z.array(envEntry),
  removedEnv: z.array(envEntry),
  migrations: z.array(migrationSchema),
  wireCompatibility: z.record(z.string(), z.string()),
  dataCompatibility: z.record(z.string(), z.string()),
  summary: z.string(),
  notesUrl: z
    .url()
    .refine((value) => new URL(value).protocol === 'https:', 'Release notes must use HTTPS'),
  breaking: z.boolean().default(false),
});
// Keep consumer declarations independent of Zod: the validator is bundled, and
// the launcher, Memory and Skills do not acquire a runtime dependency on Zod.
export interface EnvironmentChange {
  name: string;
  component: Service | 'launcher';
  secret: boolean;
  description: string;
}
export interface Migration {
  component: Service;
  id: string;
  checksum: string;
  impact: 'fast' | 'slow' | 'one-way';
  readableBy: string;
  note?: string | undefined;
}
export interface Release {
  schema: 1;
  version: string;
  engineProtocol: number;
  engines: { node: string };
  components: Record<string, string>;
  optionalComponents: Service[];
  testedSdks: Record<string, string>;
  minUpgradeFrom: Record<string, string>;
  requiredIntermediates: string[];
  newRequiredEnv: EnvironmentChange[];
  newOptionalEnv: EnvironmentChange[];
  removedEnv: EnvironmentChange[];
  migrations: Migration[];
  wireCompatibility: Record<string, string>;
  dataCompatibility: Record<string, string>;
  summary: string;
  notesUrl: string;
  breaking: boolean;
}

/** Registry storage may reorder object keys. Arrays retain their semantic order. */
export function canonicalJson(value: unknown): string {
  const json = JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
  if (json === undefined) throw new Error('Expected a JSON value');
  return json;
}

export function parseVersion(value: string): [number, number, number] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    throw new Error(`Expected a stable exact version, got ${value}`);
  const parts = value.split('.').map(Number);
  if (parts.some((n) => !Number.isSafeInteger(n)))
    throw new Error('Version contains an unsafe integer');
  return parts as [number, number, number];
}
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a),
    y = parseVersion(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
/** Deliberately bounded grammar: release generation rejects unsupported ranges. */
export function satisfies(value: string, range: string): boolean {
  const actual = parseVersion(value.replace(/^v/, ''));
  return range.split('||').some((part) => {
    const match = /^(\^|>=)?(\d+)\.(\d+)\.(\d+)$/.exec(part.trim());
    if (!match) throw new Error(`Unsupported compatibility range: ${range}`);
    const base = `${match[2]}.${match[3]}.${match[4]}`;
    if (match[1] === '>=') return compareVersions(value.replace(/^v/, ''), base) >= 0;
    if (match[1] === '^')
      return (
        actual[0] === Number(match[2]) &&
        compareVersions(value.replace(/^v/, ''), base) >= 0 &&
        (actual[0] !== 0 ||
          (actual[1] === Number(match[3]) && (actual[1] !== 0 || actual[2] === Number(match[4]))))
      );
    return compareVersions(value.replace(/^v/, ''), base) === 0;
  });
}
export function assertUpgrade(current: string, target: Release, allowMajor = false): void {
  if (compareVersions(target.version, current) <= 0)
    throw new Error('Target must be newer; use hive rollback for a downgrade');
  if (!allowMajor && parseVersion(current)[0] !== parseVersion(target.version)[0])
    throw new Error('Major upgrades require --allow-major and confirmation of the exact plan');
  if (!satisfies(process.versions.node, target.engines.node))
    throw new Error(`Node ${target.engines.node} is required; running ${process.versions.node}`);
  for (const intermediate of target.requiredIntermediates)
    if (
      compareVersions(current, intermediate) < 0 &&
      compareVersions(intermediate, target.version) < 0
    )
      throw new Error(`Upgrade to ${intermediate} first: hive upgrade --to ${intermediate}`);
}
export function autoEligible(current: string, target: Release, policy: 'patch' | 'minor'): boolean {
  const a = parseVersion(current),
    b = parseVersion(target.version);
  return (
    a[0] === b[0] &&
    (policy === 'minor' || a[1] === b[1]) &&
    compareVersions(target.version, current) > 0 &&
    !target.breaking &&
    !target.newRequiredEnv.length &&
    target.migrations.every((m) => m.impact === 'fast') &&
    target.requiredIntermediates.every((v) => compareVersions(current, v) >= 0)
  );
}
