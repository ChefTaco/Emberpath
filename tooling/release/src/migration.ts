import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { backupStores, type StoreSpec } from './backup.js';
import { inspectStores, assertQuiesced } from './inspect.js';
import { findPackageRoot, hash, home, json, withLock, writeJson } from './files.js';
import {
  compareVersions,
  releaseSchema,
  satisfies,
  type Release,
  type Service,
} from './manifest.js';

export function metadata(packageRoot: string): { version: string; release: string; protocol: 1 } {
  const pkg = json<{ version: string; hiveRelease?: unknown }>(join(packageRoot, 'package.json'));
  return {
    version: pkg.version,
    release: pkg.hiveRelease ? releaseSchema.parse(pkg.hiveRelease).version : pkg.version,
    protocol: 1,
  };
}
export function ownRelease(packageRoot: string): Release {
  return releaseSchema.parse(
    json<{ hiveRelease: unknown }>(join(packageRoot, 'package.json')).hiveRelease,
  );
}

export function schemaPlan(file: string, checksum: string, version: string): { pending: string[] } {
  if (!existsSync(file)) return { pending: [checksum] };
  const state = json<{ checksum: string; version: string; readableBy: string }>(file);
  if (state.checksum === checksum) return { pending: [] };
  if (compareVersions(state.version, version) > 0) {
    if (!satisfies(version, state.readableBy))
      throw new Error('Datastore requires newer code; restore explicitly or upgrade the package');
    return { pending: [] };
  }
  return { pending: [checksum] };
}
export function schemaCommit(
  file: string,
  checksum: string,
  version: string,
  readableBy: string,
): void {
  writeJson(file, { schema: 1, checksum, version, readableBy });
}
export function commonEnv(): {
  name: string;
  required: boolean;
  secret: boolean;
  default: string;
  description: string;
}[] {
  const switches = [
    'HIVE_AUTO_MIGRATE',
    'HIVE_UPDATE_CHECK',
    'HIVE_AUTO_UPGRADE',
    'HIVE_UI_UPGRADE',
    'HIVE_COMPOSE_UPGRADE_SUPERVISOR',
  ].map((name) => ({
    name,
    required: false,
    secret: false,
    default: 'false',
    description: 'Explicit opt-in outside managed installations. See UPGRADING.md.',
  }));
  return [
    ...switches,
    ...[
      ['HIVE_AUTO_UPGRADE_POLICY', 'patch'],
      ['HIVE_AUTO_UPGRADE_WINDOW', ''],
      ['HIVE_AUTO_UPGRADE_TIMEZONE', ''],
      ['HIVE_BACKUP_DIR', ''],
      ['HIVE_UPDATE_REGISTRY', 'https://registry.npmjs.org'],
      ['HIVE_MANAGED_PROJECT', ''],
      ['HIVE_COORDINATOR_SOCKET', ''],
    ].map(([name, defaultValue]) => ({
      name: name!,
      required: false,
      secret: false,
      default: defaultValue!,
      description: 'Owner coordinator configuration or managed wiring. See UPGRADING.md.',
    })),
  ];
}
export function extraArguments(
  args: readonly string[],
): { command: string; rest: string[]; envFiles: string[] } | null {
  const rest: string[] = [],
    envFiles: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--env-file' || arg.startsWith('--env-file=')) {
      const file = arg === '--env-file' ? args[++i] : arg.slice(11);
      if (!file) throw new Error('--env-file requires a file');
      envFiles.push(file);
    } else rest.push(arg);
  }
  const command = rest[0];
  if (!command || !['migrate', 'upgrade', 'rollback'].includes(command)) return null;
  return { command, rest: rest.slice(1), envFiles };
}
export async function captureCheck(check: () => Promise<number> | number): Promise<number> {
  const lines: string[] = [];
  const previous = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  let code: number;
  try {
    code = await check();
  } finally {
    console.log = previous;
  }
  const version = json<{ version: string }>(
    join(findPackageRoot(import.meta.url), 'package.json'),
  ).version;
  const updates = await (await import('./updates.js')).updateStatus(version);
  console.log(JSON.stringify({ ok: code === 0, version, checks: lines, updates }));
  return code;
}
export function migrationFlags(args: readonly string[]): {
  plan: boolean;
  json: boolean;
  backupDir?: string;
  confirmPlan?: string;
} {
  let backupDir: string | undefined;
  let confirmPlan: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--backup-dir') {
      backupDir = args[++i];
      if (!backupDir || backupDir.startsWith('--'))
        throw new Error('--backup-dir requires a directory');
    } else if (flag === '--confirm-plan') {
      confirmPlan = args[++i];
      if (!confirmPlan || !/^[a-f0-9]{64}$/.test(confirmPlan))
        throw new Error('--confirm-plan requires the migration plan hash');
    } else if (flag !== '--plan' && flag !== '--json')
      throw new Error(`Unknown migration option ${flag}`);
  }
  return {
    plan: args.includes('--plan'),
    json: args.includes('--json'),
    ...(backupDir ? { backupDir } : {}),
    ...(confirmPlan ? { confirmPlan } : {}),
  };
}
export function migrationReview(
  release: Release,
  service: Service,
): { approval?: string; warnings: Release['migrations'] } {
  const warnings = release.migrations.filter((m) => m.component === service && m.impact !== 'fast');
  return {
    warnings,
    ...(warnings.length
      ? { approval: hash(JSON.stringify({ release: release.version, service, warnings })) }
      : {}),
  };
}
export async function guardedMigration<T>(options: {
  service: Service;
  spec: StoreSpec;
  lock: string;
  pending: () => Promise<boolean> | boolean;
  apply: () => Promise<T>;
  automatic?: boolean;
  backupDir?: string;
  release?: Release;
  confirmPlan?: string;
}): Promise<T | undefined> {
  return withLock(options.lock, async () => {
    if (!(await options.pending())) return;
    if (options.automatic && process.env.HIVE_AUTO_MIGRATE !== 'true')
      throw new Error(
        `Pending migrations; run ${options.service === 'memory' ? 'hivemem-server' : options.service === 'iam' ? 'hive-iam-server' : `hive-${options.service}`} migrate before starting (HIVE_AUTO_MIGRATE=false)`,
      );
    if (
      options.automatic &&
      options.release?.migrations.some(
        (m) => m.component === options.service && m.impact !== 'fast',
      )
    )
      throw new Error(
        'Slow or one-way migration requires an explicitly approved hive upgrade plan',
      );
    if (options.release && !options.automatic) {
      const review = migrationReview(options.release, options.service);
      if (review.approval && options.confirmPlan !== review.approval)
        throw new Error(
          `Slow or one-way migration requires review of migrate --plan, then --confirm-plan ${review.approval}`,
        );
    }
    if (process.platform === 'linux' && options.spec.sqlite.length) assertQuiesced([{ ...options.spec, paths: [] }]);
    const root = home();
    const identityFile = join(root, 'config', 'project.json');
    const installation = existsSync(identityFile)
      ? json<{ id: string }>(identityFile).id
      : `standalone-${options.service}`;
    const destination = join(
      options.backupDir || process.env.HIVE_BACKUP_DIR || join(dirname(options.lock), 'backups'),
      `pre-migrate-${Date.now()}-${randomUUID()}`,
    );
    await inspectStores([options.spec]);
    const receipt = await backupStores([options.spec], destination, installation);
    if (!receipt.completed) throw new Error('Migration refused: backup did not complete');
    return options.apply();
  });
}
export function writeRuntime(root: string, service: Service, packageRoot: string): void {
  if (process.env.HIVE_MANAGED_PROJECT)
    writeJson(join(root, 'run', `${service}-runtime.json`), {
      ...metadata(packageRoot),
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
}
export function maintenanceActive(path: string): boolean {
  return (
    Boolean(process.env.HIVE_MANAGED_PROJECT) &&
    existsSync(join(home(), 'run/maintenance.json')) &&
    !/^\/(?:health(?:\/|$)|ready$|healthz$|v1\/health(?:\/|$)|api\/v1\/health(?:\/|$)|api\/hive\/upgrades\/status$)/.test(
      path,
    )
  );
}

/** Server commands hand off only to the enrolled installation's pinned launcher. */
export async function delegate(args: string[]): Promise<number> {
  const root = home();
  const file = join(root, 'config', 'project.json');
  if (!existsSync(file))
    throw new Error(
      'This server is not enrolled; run hive adopt --dry-run with its existing configuration',
    );
  const project = json<{ launcher: string }>(file);
  const { run } = await import('./files.js');
  process.stdout.write(
    await run(
      process.execPath,
      [join(root, 'current', 'node_modules', '@hivemagnus', 'hive', 'dist/src/cli.js'), ...args],
      { env: { ...process.env, HIVE_HOME: root }, timeout: 3_720_000 },
    ),
  );
  return 0;
}
