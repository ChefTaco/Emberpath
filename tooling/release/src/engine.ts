import { canonicalJson } from './manifest.js';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { rootCertificates } from 'node:tls';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { catalog, packageMetadata, registryUrl, targetRelease } from './catalog.js';
import {
  assertUpgrade,
  autoEligible,
  BINS,
  compareVersions,
  ENGINE_PROTOCOL,
  NATIVE_POLICY,
  PACKAGES,
  releaseSchema,
  satisfies,
  SERVICES,
  type Release,
  type Service,
} from './manifest.js';
import {
  activeDirectory,
  activate,
  installedPackage,
  inventory,
  readProject,
  serverBin,
  serviceEnv,
  type Project,
} from './project.js';
import { backupStores, restoreStores, verifyBackup, type StoreSpec } from './backup.js';
import { migrationReview } from './migration.js';
import { inspectStores, assertQuiesced } from './inspect.js';
import {
  atomic,
  hash,
  json,
  privateDir,
  quote,
  remaining,
  remove,
  run,
  withLock,
  withinDeadline,
  writeJson,
  durableTree,
} from './files.js';

export const upgradeOptionsSchema = z.object({
  to: z.string().optional(),
  from: z.string().optional(),
  dryRun: z.boolean().default(false),
  allowMajor: z.boolean().default(false),
  confirmPlan: z.string().optional(),
  automatic: z.boolean().default(false),
});
export interface UpgradeOptions {
  to?: string | undefined;
  from?: string | undefined;
  dryRun?: boolean | undefined;
  allowMajor?: boolean | undefined;
  confirmPlan?: string | undefined;
  automatic?: boolean | undefined;
}
export interface UpgradePlan {
  schema: 1;
  installation: string;
  from: string;
  currentDirectory: string;
  target: Release;
  packages: Record<string, { from: string; to: string }>;
  artifacts: Record<string, string>;
  services: Service[];
  attention: string[];
  configurationHash: string;
  changes: Pick<Release, 'newRequiredEnv' | 'newOptionalEnv' | 'removedEnv' | 'migrations'>;
  hash: string;
}
export interface Transaction {
  schema: 1;
  id: string;
  installation: string;
  action: 'upgrade' | 'rollback';
  from: string;
  to: string;
  oldDirectory: string;
  newDirectory?: string;
  phase: string;
  backup?: string;
  restoreCommand?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
  recoveryOf?: string;
}

async function waitForQuiescence(specs: StoreSpec[]): Promise<void> {
  const deadline = Date.now() + remaining(10_000);
  for (;;) {
    try {
      assertQuiesced(specs);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

function launcherVersion(dir: string): string {
  return installedPackage(dir, '@hivemagnus/hive').version;
}
function configurationHash(root: string, services: Service[]): string {
  const entries: [string, string][] = [];
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (!existsSync(file)) return;
    const actual = realpathSync(file);
    if (seen.has(actual)) return;
    seen.add(actual);
    if (statSync(actual).isDirectory()) {
      for (const name of readdirSync(actual).sort()) visit(join(actual, name));
    } else entries.push([file, hash(readFileSync(actual))]);
  };
  visit(join(root, 'config'));
  visit(join(root, 'tls'));
  visit(join(root, 'compose.yaml'));
  visit(join(root, '.env'));
  for (const service of services) {
    const env = serviceEnv(root, service);
    for (const name of [
      'JWT_PRIVATE_KEY_PATH',
      'JWT_PUBLIC_KEY_PATH',
      'TLS_KEY_PATH',
      'TLS_CERT_PATH',
      'HIVEMEM_TLS_KEY_FILE',
      'HIVEMEM_TLS_CERT_FILE',
      'HIVE_SKILLS_TLS_KEY_FILE',
      'HIVE_SKILLS_TLS_CERT_FILE',
      'NODE_EXTRA_CA_CERTS',
      'HIVE_ROUTER_IAM_CA_CERT_PATH',
      'HIVEMEM_CA_CERT_PATH',
      'HIVE_SKILLS_CA_CERT_PATH',
    ])
      if (env[name]) visit(resolve(env[name]!));
    if (service === 'iam') visit(join(root, 'iam/keys'));
  }
  return hash(JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b))));
}
export async function planUpgrade(root: string, rawOptions: UpgradeOptions): Promise<UpgradePlan> {
  const options = upgradeOptionsSchema.parse(rawOptions);
  const project = readProject(root);
  if (existsSync(join(root, 'run'))) {
    const unfinished = readdirSync(join(root, 'run'))
      .filter((file) => /^transaction-.*\.json$/.test(file))
      .map((file) => json<Transaction>(join(root, 'run', file)))
      .find((transaction) => !transaction.completedAt);
    if (unfinished)
      throw new Error(
        `Unfinished transaction ${unfinished.id}; inspect hive status and its recorded recovery command before another upgrade`,
      );
  }
  const dir = activeDirectory(root);
  await inspectStores(inventory(root, project));
  const from = launcherVersion(dir);
  const source = await catalog(options.from);
  const target = targetRelease(source.releases, from, options.to);
  assertUpgrade(from, target, options.allowMajor);
  const previousRelease = installedPackage(dir, '@hivemagnus/hive').hiveRelease;
  if (previousRelease) {
    const applied = releaseSchema.parse(previousRelease).migrations;
    for (const migration of applied.filter((m) => project.services.includes(m.component))) {
      const next = target.migrations.find(
        (m) => m.id === migration.id && m.component === migration.component,
      );
      if (!next || next.checksum !== migration.checksum)
        throw new Error(
          `Immutable migration history changed: ${migration.component}:${migration.id}`,
        );
    }
  }
  const path = source.releases
    .filter(
      (r) =>
        compareVersions(r.version, from) > 0 && compareVersions(r.version, target.version) <= 0,
    )
    .sort((a, b) => compareVersions(a.version, b.version));
  const changes = releaseChanges(path);
  for (const step of path) assertUpgrade(from, step, options.allowMajor);
  const packages: UpgradePlan['packages'] = {};
  const artifacts: Record<string, string> = {};
  for (const name of ['@hivemagnus/hive', ...project.services.map((s) => PACKAGES[s])]) {
    const current = installedPackage(dir, name).version;
    const to = target.components[name];
    if (!to) throw new Error(`Release omits ${name}`);
    if (target.minUpgradeFrom[name] && compareVersions(current, target.minUpgradeFrom[name]!) < 0)
      throw new Error(`${name} must first be upgraded to ${target.minUpgradeFrom[name]}`);
    packages[name] = { from: current, to };
    const pkg = await packageMetadata(source, name, to, options.from);
    if (
      pkg.name !== name ||
      pkg.version !== to ||
      !pkg.engines?.node ||
      !satisfies(process.versions.node, pkg.engines.node)
    )
      throw new Error(`Target ${name}@${to} requires a supported Node engine before installation`);
    if (canonicalJson(releaseSchema.parse(pkg.hiveRelease)) !== canonicalJson(target))
      throw new Error(`Target ${name}@${to} is outside the complete release bundle`);
    if (!pkg.dist?.integrity || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(pkg.dist.integrity))
      throw new Error(`Target ${name}@${to} has no verifiable integrity`);
    artifacts[name] = pkg.dist.integrity;
    if (options.from && !source.sources.has(`${name}@${to}`))
      throw new Error(`Missing tarball for ${name}@${to}`);
  }
  for (const entry of changes.newRequiredEnv) {
    if (entry.component === 'launcher') {
      if (!process.env[entry.name])
        throw new Error(`Required environment name missing: ${entry.name}`);
    } else if (
      project.services.includes(entry.component) &&
      !serviceEnv(root, entry.component)[entry.name]
    )
      throw new Error(`Set ${entry.name} in config/${entry.component}.env before upgrading`);
  }
  const attention = changes.migrations
    .filter((m) => project.services.includes(m.component) && m.impact !== 'fast')
    .map((m) => `${m.component}:${m.id}:${m.impact}`);
  if (path.some((r) => r.breaking) || options.allowMajor)
    attention.push('major-or-breaking-release');
  const base = {
    schema: 1 as const,
    installation: project.id,
    from,
    currentDirectory: dir,
    target,
    packages,
    artifacts,
    services: project.services,
    attention,
    changes,
    configurationHash: configurationHash(root, project.services),
  };
  return { ...base, hash: hash(JSON.stringify(base)) };
}

/** Registry history is cumulative: skipping a release must not hide required settings or risk. */
export function releaseChanges(path: Release[]): UpgradePlan['changes'] {
  const required = new Map<string, Release['newRequiredEnv'][number]>();
  const optional = new Map<string, Release['newOptionalEnv'][number]>();
  const removed = new Map<string, Release['removedEnv'][number]>();
  const migrations = new Map<string, Release['migrations'][number]>();
  for (const release of path) {
    for (const entry of release.removedEnv) {
      const key = `${entry.component}:${entry.name}`;
      required.delete(key);
      optional.delete(key);
      removed.set(key, entry);
    }
    for (const entry of release.newRequiredEnv) {
      const key = `${entry.component}:${entry.name}`;
      optional.delete(key);
      removed.delete(key);
      required.set(key, entry);
    }
    for (const entry of release.newOptionalEnv) {
      const key = `${entry.component}:${entry.name}`;
      required.delete(key);
      removed.delete(key);
      optional.set(key, entry);
    }
    for (const entry of release.migrations) {
      const key = `${entry.component}:${entry.id}`;
      if (migrations.has(key) && migrations.get(key)!.checksum !== entry.checksum)
        throw new Error(`Immutable migration checksum changed: ${key}`);
      migrations.set(key, entry);
    }
  }
  return {
    newRequiredEnv: [...required.values()],
    newOptionalEnv: [...optional.values()],
    removedEnv: [...removed.values()],
    migrations: [...migrations.values()],
  };
}
async function stage(root: string, plan: UpgradePlan, from?: string): Promise<string> {
  const source = await catalog(from);
  const dir = join(root, 'versions', `${plan.target.version}-${randomUUID()}`);
  privateDir(dir);
  writeJson(join(dir, 'package.json'), {
    name: 'hive-managed-runtime',
    private: true,
    allowScripts: NATIVE_POLICY,
    dependencies: Object.fromEntries(
      Object.entries(plan.packages).map(([name, p]) => [
        name,
        from ? source.sources.get(`${name}@${p.to}`)! : p.to,
      ]),
    ),
  });
  await run(
    'npm',
    [
      'install',
      '--prefix',
      dir,
      '--omit=dev',
      '--ignore-scripts',
      '--no-fund',
      '--no-audit',
      '--save-exact',
      '--package-lock=true',
      '--registry',
      registryUrl(),
    ],
    { timeout: 900_000 },
  );
  const lock = json<{
    packages: Record<string, { resolved?: string; integrity?: string; link?: boolean }>;
  }>(join(dir, 'package-lock.json'));
  for (const [name, pkg] of Object.entries(lock.packages)) {
    if (!name) continue;
    if (
      pkg.link ||
      !pkg.integrity ||
      !pkg.resolved ||
      (!pkg.resolved.startsWith('https://') &&
        !pkg.resolved.startsWith('file:') &&
        !pkg.resolved.startsWith('http://127.0.0.1:'))
    )
      throw new Error('Unverifiable or unsupported dependency in staged lockfile');
    if (
      pkg.resolved.startsWith('file:') &&
      ![...source.sources.values()].some(
        (p) => realpathSync(resolve(dir, pkg.resolved!.slice(5))) === realpathSync(p),
      )
    )
      throw new Error('Unexpected file dependency');
  }
  for (const [name, expected] of Object.entries(plan.artifacts)) {
    if (lock.packages[`node_modules/${name}`]?.integrity !== expected)
      throw new Error('Staged package integrity differs from the reviewed plan');
  }
  await run(
    'npm',
    [
      'rebuild',
      'better-sqlite3',
      'argon2',
      '--prefix',
      dir,
      '--ignore-scripts=false',
      '--no-fund',
      '--no-audit',
    ],
    { timeout: 900_000 },
  );
  for (const [name, versions] of Object.entries(plan.packages)) {
    const pkg = installedPackage(dir, name);
    if (
      pkg.name !== name ||
      pkg.version !== versions.to ||
      !pkg.engines?.node ||
      !satisfies(process.versions.node, pkg.engines.node)
    )
      throw new Error(`Invalid staged package ${name}`);
    const manifest = releaseSchema.parse(pkg.hiveRelease);
    if (
      manifest.version !== plan.target.version ||
      canonicalJson(manifest) !== canonicalJson(plan.target)
    )
      throw new Error('Staged release manifests differ from the approved bundle');
  }
  for (const service of plan.services) {
    const load = createRequire(join(dir, 'node_modules', PACKAGES[service], 'package.json'));
    if (service === 'iam' || service === 'router') {
      const SQLite = load('better-sqlite3');
      new SQLite(':memory:').close();
    }
    if (service === 'iam') {
      const argon = load('argon2');
      const encoded = await argon.hash('synthetic-native-check');
      if (!(await argon.verify(encoded, 'synthetic-native-check')))
        throw new Error('Argon2 verification failed');
    }
    await run(
      process.execPath,
      [serverBin(dir, service), 'check', '--json', ...(service === 'router' ? ['--offline'] : [])],
      { cwd: root, env: serviceEnv(root, service) },
    );
    await run(process.execPath, [serverBin(dir, service), 'migrate', '--plan', '--json'], {
      cwd: root,
      env: serviceEnv(root, service),
    });
  }
  writeJson(join(dir, 'release.json'), plan.target);
  durableTree(dir);
  return dir;
}
export interface Manager {
  prepare?(version: string): Promise<void>;
  stop(): Promise<void>;
  start(): Promise<void>;
  health(directory: string): Promise<void>;
}
function probe(url: URL, ca?: string[]): Promise<Record<string, unknown>> {
  return new Promise((yes, no) => {
    const req = (url.protocol === 'https:' ? httpsGet : httpGet)(
      url,
      { ...(ca ? { ca } : {}), timeout: 3000 },
      (response) => {
        let body = '';
        response.on('data', (c) => {
          body += c;
          if (body.length > 1024 * 1024) response.destroy();
        });
        response.once('end', () => {
          try {
            if (response.statusCode !== 200)
              throw new Error(`Health returned HTTP ${response.statusCode}`);
            yes(JSON.parse(body));
          } catch (e) {
            no(e);
          }
        });
      },
    );
    req.once('timeout', () => req.destroy(new Error('Health timed out')));
    req.once('error', no);
  });
}
export async function serviceReady(
  root: string,
  service: Service,
  expected: string,
): Promise<boolean> {
  const env = serviceEnv(root, service);
  const endpoint =
    service === 'iam'
      ? `${env.TLS_CERT_PATH ? 'https' : 'http'}://localhost:${env.PORT || 4200}/api/v1/health/ready`
      : service === 'memory'
        ? `${env.HIVEMEM_TS_TLS_CERT_FILE || env.HIVEMEM_TLS_CERT_FILE ? 'https' : 'http'}://localhost:${env.HIVEMEM_WEB_PORT || 18790}/v1/health/ready`
        : service === 'skills'
          ? new URL(
              '/healthz',
              env.HIVE_SKILLS_PUBLIC_URL || `https://localhost:${env.HIVE_SKILLS_PORT || 4030}`,
            ).href
          : new URL(
              '/health/ready',
              env.PUBLIC_ADMIN_URL || `https://localhost:${env.ADMIN_PORT || 9443}`,
            ).href;
  try {
    const ca = env.NODE_EXTRA_CA_CERTS
      ? [...rootCertificates, readFileSync(env.NODE_EXTRA_CA_CERTS, 'utf8')]
      : undefined;
    return (await probe(new URL(endpoint), ca)).version === expected;
  } catch {
    return false;
  }
}
export function manager(root: string, project: Project): Manager {
  const pidFile = join(root, 'run/hive.pid');
  let startedChild: ReturnType<typeof spawn> | undefined;
  return {
    async stop() {
      if (project.manager === 'compose')
        throw new Error('Compose upgrades require the enrolled host supervisor');
      if (project.manager === 'systemd') {
        await run('systemctl', ['--user', 'stop', 'hive.service'], { timeout: 660_000 });
        return;
      }
      if (!existsSync(pidFile)) {
        if (startedChild?.pid && startedChild.exitCode === null) {
          startedChild.kill('SIGTERM');
          await new Promise<void>((done) => startedChild!.once('exit', () => done()));
        }
        return;
      }
      const { pid } = json<{ pid: number }>(pidFile);
      let command: string;
      try {
        command = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      } catch {
        throw new Error('Cannot verify foreground supervisor identity; stop it manually');
      }
      const environment = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      if (
        !environment.includes(`HIVE_HOME=${root}`) ||
        !command.includes('start') ||
        !/hive\/dist\/src\/cli.js/.test(command)
      )
        throw new Error('PID is not the enrolled Hive supervisor');
      process.kill(pid, 'SIGTERM');
      const deadline = Date.now() + remaining(660_000);
      while (existsSync(pidFile)) {
        if (Date.now() > deadline) throw new Error('Foreground supervisor did not quiesce');
        await new Promise((r) => setTimeout(r, 100));
      }
      if (startedChild?.exitCode === null)
        await new Promise<void>((done) => startedChild!.once('exit', () => done()));
    },
    async start() {
      if (project.manager === 'systemd') {
        await run('systemctl', ['--user', 'start', 'hive.service']);
        return;
      }
      if (project.manager === 'compose')
        throw new Error('Compose upgrades require the enrolled host supervisor');
      const log = openSync(join(root, 'run/upgrade-services.log'), 'a', 0o600);
      const child = spawn(
        process.execPath,
        [join(activeDirectory(root), 'node_modules/@hivemagnus/hive/dist/src/cli.js'), 'start'],
        {
          cwd: root,
          env: { ...process.env, HIVE_HOME: root, HIVE_UPGRADE_START: 'true' },
          detached: true,
          stdio: ['ignore', log, log],
        },
      );
      child.unref();
      closeSync(log);
      startedChild = child;
      await new Promise<void>((yes, no) => {
        child.once('spawn', yes);
        child.once('error', no);
      });
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (child.exitCode !== null)
          throw new Error('Hive supervisor exited before registering its process state');
        if (existsSync(pidFile) && json<{ pid: number }>(pidFile).pid === child.pid) break;
        if (Date.now() > deadline)
          throw new Error('Hive supervisor did not register its process state');
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    async health(directory) {
      for (const service of project.services) {
        const env = serviceEnv(root, service);
        const output = await run(process.execPath, [serverBin(directory, service), 'env-schema'], {
          cwd: root,
          env,
        });
        const schema = JSON.parse(output) as {
          readyPath?: string;
          healthPath: string;
          defaultPort: number;
        };
        const url =
          service === 'iam'
            ? `${env.TLS_CERT_PATH ? 'https' : 'http'}://localhost:${env.PORT || schema.defaultPort}`
            : service === 'memory'
              ? `${env.HIVEMEM_TS_TLS_CERT_FILE || env.HIVEMEM_TLS_CERT_FILE ? 'https' : 'http'}://localhost:${env.HIVEMEM_WEB_PORT || schema.defaultPort}`
              : service === 'skills'
                ? env.HIVE_SKILLS_PUBLIC_URL ||
                  `https://localhost:${env.HIVE_SKILLS_PORT || schema.defaultPort}`
                : env.PUBLIC_ADMIN_URL || `https://localhost:${env.ADMIN_PORT || 9443}`;
        const expected = installedPackage(directory, PACKAGES[service]).version;
        const endpoint = new URL(schema.readyPath || schema.healthPath, url);
        const ca = env.NODE_EXTRA_CA_CERTS
          ? [...rootCertificates, readFileSync(env.NODE_EXTRA_CA_CERTS, 'utf8')]
          : undefined;
        const deadline = Date.now() + remaining(service === 'iam' ? 180_000 : 90_000);
        for (;;) {
          try {
            const health = await probe(endpoint, ca);
            if (health.version !== expected) {
              if (health.version || installedPackage(directory, PACKAGES[service]).hiveRelease)
                throw new Error('Health belongs to a different or unknown package version');
              const supervisor = json<{ pid: number; services: Record<string, number> }>(pidFile);
              const command = readFileSync(`/proc/${supervisor.pid}/cmdline`, 'utf8');
              if (!command.includes(directory) || !supervisor.services[service])
                throw new Error('Cannot verify the legacy service process generation');
            }
            break;
          } catch (error) {
            if (Date.now() > deadline) throw error;
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      }
      if (project.services.includes('router'))
        await run(process.execPath, [serverBin(directory, 'router'), 'check', '--json'], {
          cwd: root,
          env: serviceEnv(root, 'router'),
        });
    },
  };
}
export async function upgrade(
  root: string,
  rawOptions: UpgradeOptions,
  adapter?: Manager,
  hooks?: { afterPersist?: (transaction: Readonly<Transaction>) => Promise<void> },
): Promise<UpgradePlan | Transaction> {
  const options = upgradeOptionsSchema.parse(rawOptions);
  const plan = await planUpgrade(root, options);
  if (options.dryRun) return plan;
  if (options.automatic) {
    const policy = process.env.HIVE_AUTO_UPGRADE_POLICY || 'patch';
    if (
      process.env.HIVE_AUTO_UPGRADE !== 'true' ||
      (policy !== 'patch' && policy !== 'minor') ||
      !autoEligible(plan.from, { ...plan.target, ...plan.changes }, policy)
    )
      throw new Error('Release is not eligible for the enabled unattended policy');
  }
  if (!adapter && readProject(root).manager === 'compose')
    return (await (
      await import('./coordinator.js')
    ).coordinatorRequest(root, 'local', { command: 'upgrade', options })) as Transaction;
  if (plan.attention.length && options.confirmPlan !== plan.hash)
    throw new Error(
      `Explicit approval required for ${plan.attention.join(', ')}; review --dry-run then pass --confirm-plan ${plan.hash}`,
    );
  await adapter?.prepare?.(plan.target.version);
  const staged = await stage(root, plan, options.from);
  if (plan.target.engineProtocol > ENGINE_PROTOCOL)
    return (await import('./handoff.js')).handoff(root, staged, plan, options, adapter);
  return withLock(join(root, 'run/upgrade.lock'), () =>
    withinDeadline(options.automatic ? 900_000 : 3_600_000, async () => {
      if (
        options.automatic &&
        !(await import('./updates.js')).maintenanceDate(
          new Date(),
          process.env.HIVE_AUTO_UPGRADE_WINDOW,
          process.env.HIVE_AUTO_UPGRADE_TIMEZONE,
        )
      )
        throw new Error('Maintenance window closed while staging; no services were stopped');
      const project = readProject(root);
      if (activeDirectory(root) !== plan.currentDirectory)
        throw new Error('Active release changed while staging; rerun upgrade');
      if (configurationHash(root, project.services) !== plan.configurationHash)
        throw new Error('Configuration or signing keys changed while staging; review a fresh plan');
      const pending = readdirSync(join(root, 'run'))
        .filter((f) => f.startsWith('transaction-') && f.endsWith('.json'))
        .map((f) => json<Transaction>(join(root, 'run', f)))
        .find((t) => !t.completedAt);
      if (pending)
        throw new Error(
          `Unfinished transaction ${pending.id}; review its recovery receipt before another upgrade`,
        );
      const specs = inventory(root, project);
      const txn: Transaction = {
        schema: 1,
        id: randomUUID(),
        installation: project.id,
        action: 'upgrade',
        from: plan.from,
        to: plan.target.version,
        oldDirectory: plan.currentDirectory,
        newDirectory: staged,
        phase: 'prepared',
        startedAt: new Date().toISOString(),
      };
      const file = join(root, 'run', `transaction-${txn.id}.json`);
      const save = async (phase: string) => {
        txn.phase = phase;
        writeJson(file, txn);
        await hooks?.afterPersist?.({ ...txn });
      };
      const control = adapter || manager(root, project);
      let migrated = false;
      try {
        await save('quiescing');
        writeJson(join(root, 'run/maintenance.json'), { transaction: txn.id });
        await control.stop();
        await waitForQuiescence(specs);
        await save('backing-up');
        txn.backup = join(process.env.HIVE_BACKUP_DIR || join(root, 'backups'), txn.id);
        const configSpec = {
          service: project.services[0]!,
          paths: [
            join(root, 'config'),
            ...['tls', 'compose.yaml', '.env'].map((name) => join(root, name)).filter(existsSync),
          ],
          sqlite: [],
        };
        await backupStores(
          [...specs, configSpec],
          txn.backup,
          project.id,
          Object.fromEntries(
            Object.entries(plan.packages).map(([name, versions]) => [name, versions.from]),
          ),
        );
        txn.restoreCommand = `HIVE_HOME=${quote(root)} hive rollback --restore-data --transaction ${txn.id} --confirm-restore ${hash(readFileSync(join(txn.backup, 'manifest.json')))} --containment-reviewed <review-receipt>`;
        await save('migrating');
        for (const service of project.services) {
          const pending = JSON.parse(
            await run(
              process.execPath,
              [serverBin(staged, service), 'migrate', '--plan', '--json'],
              { cwd: root, env: serviceEnv(root, service) },
            ),
          ) as { pending: unknown[]; dataChanged?: boolean };
          migrated ||= pending.pending.length > 0 && pending.dataChanged !== false;
          await run(
            process.execPath,
            [
              serverBin(staged, service),
              'migrate',
              '--backup-dir',
              join(txn.backup, 'service-migrations'),
              ...(migrationReview(plan.target, service).approval
                ? ['--confirm-plan', migrationReview(plan.target, service).approval!]
                : []),
            ],
            { cwd: root, env: { ...serviceEnv(root, service), HIVE_UPGRADE_TRANSACTION: txn.id } },
          );
        }
        await save('checking');
        for (const service of project.services)
          await run(
            process.execPath,
            [
              serverBin(staged, service),
              'check',
              '--json',
              ...(service === 'router' ? ['--offline'] : []),
            ],
            { cwd: root, env: serviceEnv(root, service) },
          );
        if (configurationHash(root, project.services) !== plan.configurationHash)
          throw new Error(
            'Migration changed protected configuration or signing keys; services remain held for explicit recovery',
          );
        activate(root, staged);
        await save('restarting');
        await control.start();
        await save('health');
        await control.health(staged);
        txn.completedAt = new Date().toISOString();
        await save('completed');
        writeJson(join(root, 'run/last-transaction.json'), txn);
        remove(join(root, 'run/maintenance.json'));
        return txn;
      } catch (error) {
        txn.error = error instanceof Error ? error.message : 'Upgrade failed';
        await save('recovering');
        try {
          await withinDeadline(120_000, async () => {
            await control.stop();
            activate(root, txn.oldDirectory);
            // An unmanifested old IAM binary rejects newer migration history. Never assume recovery.
            const compatible =
              configurationHash(root, project.services) === plan.configurationHash &&
              (!migrated ||
                (project.services.every((s) =>
                  satisfies(
                    installedPackage(txn.oldDirectory, PACKAGES[s]).version,
                    plan.target.dataCompatibility[s] || plan.target.components[PACKAGES[s]]!,
                  ),
                ) &&
                  project.services.every((s) =>
                    Boolean(installedPackage(txn.oldDirectory, PACKAGES[s]).hiveRelease),
                  )));
            if (compatible) {
              await control.start();
              await control.health(txn.oldDirectory);
              txn.completedAt = new Date().toISOString();
              await save('reverted');
              remove(join(root, 'run/maintenance.json'));
            } else await save('held-for-restore');
          });
        } catch (recovery) {
          txn.error += `; recovery failed: ${recovery instanceof Error ? recovery.message : 'unknown error'}`;
          await save('held-for-restore');
        }
        throw new Error(
          `${txn.error}\nTransaction: ${file}\n${txn.restoreCommand || 'No migration ran; inspect the recorded service state before restarting.'}`,
        );
      }
    }),
  );
}
export async function rollback(
  root: string,
  options: {
    to?: string | undefined;
    transaction?: string | undefined;
    restoreData?: boolean | undefined;
    confirmRestore?: string | undefined;
    containmentReviewed?: string | undefined;
  },
  adapter?: Manager,
): Promise<Transaction> {
  if (!adapter && readProject(root).manager === 'compose')
    return (await (
      await import('./coordinator.js')
    ).coordinatorRequest(root, 'local', { command: 'rollback', options })) as Transaction;
  return withLock(join(root, 'run/upgrade.lock'), async () => {
    const project = readProject(root);
    const previous = json<Transaction>(
      options.transaction
        ? join(root, 'run', `transaction-${z.uuid().parse(options.transaction)}.json`)
        : join(root, 'run/last-transaction.json'),
    );
    if (previous.installation !== project.id)
      throw new Error('Transaction belongs to another installation');
    const target = options.to ? join(root, 'versions', options.to) : previous.oldDirectory;
    if (options.to && (options.to.includes('/') || options.to.includes('..')))
      throw new Error('Rollback takes a recorded release directory name');
    if (
      !existsSync(target) ||
      !realpathSync(target).startsWith(realpathSync(join(root, 'versions')) + '/')
    )
      throw new Error('Unknown rollback release');
    if (
      options.restoreData &&
      (!previous.backup || !options.confirmRestore || !options.containmentReviewed)
    )
      throw new Error(
        'Data restore requires --confirm-restore and --containment-reviewed before stopping services',
      );
    const control = adapter || manager(root, project);
    const existing = readdirSync(join(root, 'run'))
      .filter((f) => /^transaction-.*\.json$/.test(f))
      .map((f) => json<Transaction>(join(root, 'run', f)))
      .find((t) => t.recoveryOf === previous.id && !t.completedAt);
    const txn: Transaction = existing || {
      schema: 1,
      id: randomUUID(),
      installation: project.id,
      action: 'rollback',
      recoveryOf: previous.id,
      from: launcherVersion(activeDirectory(root)),
      to: launcherVersion(target),
      oldDirectory: activeDirectory(root),
      newDirectory: target,
      phase: 'quiescing',
      startedAt: new Date().toISOString(),
      ...(previous.backup ? { backup: previous.backup } : {}),
      ...(previous.restoreCommand ? { restoreCommand: previous.restoreCommand } : {}),
    };
    if (txn.newDirectory !== target)
      throw new Error('Pending rollback has a different target; finish that recovery first');
    const save = (phase: string) => {
      txn.phase = phase;
      writeJson(join(root, 'run', `transaction-${txn.id}.json`), txn);
    };
    save('quiescing');
    try {
      writeJson(join(root, 'run/maintenance.json'), { transaction: txn.id });
      await control.stop();
      await waitForQuiescence(inventory(root, project));
      save(options.restoreData ? 'preserving-failed-state' : 'checking');
      if (options.restoreData) {
        if (!previous.backup || !options.confirmRestore || !options.containmentReviewed)
          throw new Error(
            'Data restore requires --confirm-restore and --containment-reviewed after explicit review of newer revocations, disabled credentials and signing keys',
          );
        await verifyBackup(previous.backup, project.id);
        const failed = join(root, 'backups', `failed-state-${randomUUID()}`);
        await backupStores(
          [
            ...inventory(root, project),
            {
              service: project.services[0]!,
              paths: [
                join(root, 'config'),
                ...['tls', 'compose.yaml', '.env']
                  .map((name) => join(root, name))
                  .filter(existsSync),
              ],
              sqlite: [],
            },
          ],
          failed,
          project.id,
        );
        const review = hash(
          JSON.stringify({
            installation: project.id,
            transaction: previous.id,
            backup: options.confirmRestore,
          }),
        );
        if (options.containmentReviewed !== review)
          throw new Error(
            `Failed state preserved at ${failed}; reconcile current containment and confirm with --containment-reviewed ${review}`,
          );
        save('restoring');
        await restoreStores(
          [
            ...inventory(root, project),
            {
              service: project.services[0]!,
              paths: [
                join(root, 'config'),
                ...['tls', 'compose.yaml', '.env']
                  .map((name) => join(root, name))
                  .filter(existsSync),
              ],
              sqlite: [],
            },
          ],
          previous.backup,
          project.id,
          options.confirmRestore,
        );
      } else {
        for (const service of project.services) {
          if (installedPackage(target, PACKAGES[service]).hiveRelease) {
            const pending = JSON.parse(
              await run(
                process.execPath,
                [serverBin(target, service), 'migrate', '--plan', '--json'],
                { cwd: root, env: serviceEnv(root, service) },
              ),
            ) as { pending: unknown[] };
            if (pending.pending.length)
              throw new Error(
                'Rollback target requires migration; use explicit data recovery instead',
              );
          } else if (service === 'iam') {
            const spec = inventory(root, project).find((s) => s.service === 'iam')!;
            const db = new DatabaseSync(spec.sqlite[0]!, { readOnly: true });
            try {
              const applied = db
                .prepare(
                  'SELECT migration_name,checksum,finished_at FROM _prisma_migrations WHERE rolled_back_at IS NULL',
                )
                .all();
              for (const row of applied) {
                const sql = join(
                  target,
                  'node_modules',
                  PACKAGES.iam,
                  'prisma/migrations',
                  String(row.migration_name),
                  'migration.sql',
                );
                if (
                  !row.finished_at ||
                  !existsSync(sql) ||
                  hash(readFileSync(sql)) !== row.checksum
                )
                  throw new Error(
                    'Legacy IAM cannot read the current migration history; restore explicitly',
                  );
              }
            } finally {
              db.close();
            }
          }
        }
        const release = installedPackage(activeDirectory(root), '@hivemagnus/hive').hiveRelease;
        if (release)
          for (const service of project.services)
            if (
              !satisfies(
                installedPackage(target, PACKAGES[service]).version,
                releaseSchema.parse(release).dataCompatibility[service]!,
              )
            )
              throw new Error(
                'Code rollback is not data-compatible; restore the transaction backup explicitly',
              );
      }
      save('switching');
      activate(root, target);
      save('restarting');
      await control.start();
      save('health');
      await control.health(target);
      txn.completedAt = new Date().toISOString();
      delete txn.error;
      previous.completedAt = new Date().toISOString();
      previous.phase = options.restoreData ? 'restored' : 'rolled-back';
      writeJson(join(root, 'run', `transaction-${previous.id}.json`), previous);
      save('completed');
      writeJson(join(root, 'run/last-transaction.json'), txn);
      remove(join(root, 'run/maintenance.json'));
      return txn;
    } catch (error) {
      txn.error = error instanceof Error ? error.message : 'Rollback failed';
      save('held-for-recovery');
      throw error;
    }
  });
}
