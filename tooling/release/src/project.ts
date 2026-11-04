import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  mkdirSync,
  cpSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { BINS, PACKAGES, SERVICES, type Service } from './manifest.js';
import { home, json, privateDir, writeJson, withLock, run, syncFile } from './files.js';
import { storeSpec, type StoreSpec } from './backup.js';

export const projectSchema = z.object({
  schema: z.literal(1),
  id: z.uuid(),
  manager: z.enum(['foreground', 'systemd', 'compose']),
  services: z
    .array(z.enum(SERVICES))
    .min(1)
    .refine(
      (services) =>
        new Set(services).size === services.length &&
        services.every(
          (service, index) =>
            index === 0 || SERVICES.indexOf(services[index - 1]!) < SERVICES.indexOf(service),
        ),
      'Services must be unique and in dependency order',
    ),
  launcher: z.literal('@hivemagnus/hive'),
  createdAt: z.iso.datetime(),
});
export interface Project {
  schema: 1;
  id: string;
  manager: 'foreground' | 'systemd' | 'compose';
  services: Service[];
  launcher: '@hivemagnus/hive';
  createdAt: string;
}
export function projectFile(root: string): string {
  return join(root, 'config/project.json');
}
export function readProject(root = home()): Project {
  return projectSchema.parse(json(projectFile(root)));
}
export function activeDirectory(root: string): string {
  const path = realpathSync(join(root, 'current'));
  if (!path.startsWith(realpathSync(join(root, 'versions')) + '/'))
    throw new Error('Current release escapes the managed versions directory');
  return path;
}
export function installedPackage(
  directory: string,
  name: string,
): {
  name: string;
  version: string;
  bin?: Record<string, string>;
  hiveRelease?: unknown;
  engines?: { node: string };
} {
  return json(join(directory, 'node_modules', name, 'package.json'));
}
export function serverBin(directory: string, service: Service): string {
  const pkg = installedPackage(directory, PACKAGES[service]);
  const bin = pkg.bin?.[BINS[service]];
  if (
    !bin ||
    resolve(directory, 'node_modules', PACKAGES[service], bin).startsWith(
      resolve(directory, 'node_modules', PACKAGES[service]) + '/',
    ) === false
  )
    throw new Error('Invalid installed server executable');
  return resolve(directory, 'node_modules', PACKAGES[service], bin);
}
export function serviceEnv(root: string, service: Service): NodeJS.ProcessEnv {
  const parsed = parseEnv(readFileSync(join(root, 'config', `${service}.env`), 'utf8'));
  const pass = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'TZ',
    'NODE_EXTRA_CA_CERTS',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
  ];
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    pass.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])),
  );
  Object.assign(env, parsed, { HIVE_HOME: root, HIVE_MANAGED_PROJECT: root });
  for (const name of [
    'DATA_DIR',
    'IAM_DATA_DIR',
    'HIVE_SKILLS_DATA_DIR',
    'HIVEMEM_STORAGE_PATH',
    'AUDIT_LOG_DIR',
    'TRACE_DIR',
    'HIVEMEM_REVOCATION_FILE',
    'JWT_PRIVATE_KEY_PATH',
    'JWT_PUBLIC_KEY_PATH',
    'TLS_KEY_PATH',
    'TLS_CERT_PATH',
    'HIVEMEM_TLS_KEY_FILE',
    'HIVEMEM_TLS_CERT_FILE',
    'HIVEMEM_TS_TLS_KEY_FILE',
    'HIVEMEM_TS_TLS_CERT_FILE',
    'HIVE_SKILLS_TLS_KEY_FILE',
    'HIVE_SKILLS_TLS_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'HIVE_ROUTER_IAM_CA_CERT_PATH',
    'HIVEMEM_CA_CERT_PATH',
    'HIVE_SKILLS_CA_CERT_PATH',
  ])
    if (env[name]) env[name] = resolve(root, env[name]!);
  if (env.DATABASE_URL?.startsWith('file:')) {
    const [file, ...query] = env.DATABASE_URL.slice(5).split('?');
    env.DATABASE_URL = `file:${resolve(root, file!)}${query.length ? `?${query.join('?')}` : ''}`;
  }
  if (!env.NODE_EXTRA_CA_CERTS && existsSync(join(root, 'tls/ca.crt')))
    env.NODE_EXTRA_CA_CERTS = join(root, 'tls/ca.crt');
  return env;
}
export function inventory(root: string, project: Project, requireExisting = true): StoreSpec[] {
  return project.services.map((service) => {
    const spec = storeSpec(service, serviceEnv(root, service), root);
    if (requireExisting)
      for (const path of spec.sqlite)
        if (!existsSync(path))
          throw new Error(
            `${service} database is missing; upgrade will not initialize a replacement`,
          );
    if (requireExisting && service === 'iam') {
      const env = serviceEnv(root, service);
      for (const path of [
        env.JWT_PRIVATE_KEY_PATH || join(root, 'iam/keys/iam-private.pem'),
        env.JWT_PUBLIC_KEY_PATH || join(root, 'iam/keys/iam-public.pem'),
      ])
        if (!existsSync(path))
          throw new Error(
            'Existing IAM signing keys are missing; refusing key generation during upgrade',
          );
    }
    return spec;
  });
}
export function activate(root: string, directory: string): void {
  if (!realpathSync(directory).startsWith(realpathSync(join(root, 'versions')) + '/'))
    throw new Error('Release is outside the installation');
  const temporary = join(root, `.current-${randomUUID()}`);
  symlinkSync(directory, temporary);
  renameSync(temporary, join(root, 'current'));
  syncFile(root);
}
export function adoptionPlan(root: string): {
  services: Service[];
  runtime: string;
  managed: boolean;
} {
  if (existsSync(projectFile(root)))
    return { services: readProject(root).services, runtime: activeDirectory(root), managed: true };
  const services = SERVICES.filter((service) => existsSync(join(root, 'config', `${service}.env`)));
  const runtime = join(root, 'runtime');
  if (
    !services.length ||
    !existsSync(join(root, 'config/launcher.json')) ||
    !existsSync(join(runtime, 'package-lock.json'))
  )
    throw new Error(
      'Unknown installation layout; inspect and explicitly configure a managed project before adoption',
    );
  for (const service of services) serverBin(runtime, service);
  return { services, runtime, managed: false };
}
export async function adopt(
  root: string,
  apply: boolean,
  manager: Project['manager'] = 'foreground',
): Promise<ReturnType<typeof adoptionPlan>> {
  const plan = adoptionPlan(root);
  if (!apply || plan.managed) return plan;
  return withLock(join(root, 'run/upgrade.lock'), async () => {
    if (existsSync(join(root, 'run/hive.pid')))
      throw new Error(
        'Stop the legacy launcher before adoption; no processes will be killed implicitly',
      );
    if (lstatSync(plan.runtime).isSymbolicLink())
      throw new Error('Unknown runtime symlink; explicit operator adoption is required');
    const project: Project = {
      schema: 1,
      id: randomUUID(),
      services: plan.services,
      manager,
      launcher: '@hivemagnus/hive',
      createdAt: new Date().toISOString(),
    };
    // Keep all previous package bytes and lockfile intact. Data/config paths never move.
    const release = join(root, 'versions', `adopted-${randomUUID()}`);
    privateDir(dirname(release));
    if (!existsSync(join(plan.runtime, 'node_modules/@hivemagnus/hive/package.json'))) {
      // The pre-managed launcher did not install itself into runtime. Only this tested
      // public baseline is eligible; keep the original tree untouched during staging.
      for (const service of plan.services) {
        const expected = service === 'skills' ? '1.1.0' : '1.0.3';
        if (installedPackage(plan.runtime, PACKAGES[service]).version !== expected)
          throw new Error(
            'Unrecognized legacy package set; explicit operator migration is required',
          );
      }
      cpSync(plan.runtime, release, { recursive: true });
      const pkg = json<Record<string, unknown>>(join(release, 'package.json'));
      writeJson(join(release, 'package.json'), {
        ...pkg,
        dependencies: {
          ...Object.fromEntries(
            plan.services.map((s) => [
              PACKAGES[s],
              installedPackage(plan.runtime, PACKAGES[s]).version,
            ]),
          ),
          '@hivemagnus/hive': '1.1.0',
        },
      });
      await run(
        'npm',
        [
          'install',
          '--prefix',
          release,
          '--ignore-scripts',
          '--omit=dev',
          '--no-fund',
          '--no-audit',
          '--registry',
          'https://registry.npmjs.org',
        ],
        { timeout: 900_000 },
      );
      renameSync(plan.runtime, join(root, 'versions', `legacy-original-${randomUUID()}`));
    } else renameSync(plan.runtime, release);
    activate(root, release);
    symlinkSync('current', plan.runtime);
    writeJson(projectFile(root), project);
    return { ...plan, managed: true, runtime: release };
  });
}
