import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { Redis } from './redis.js';
import {
  assertAbsent,
  hash,
  json,
  privateDir,
  remaining,
  writeJson,
  syncFile,
  durableTree,
} from './files.js';
import type { Service } from './manifest.js';
import { assertContainmentUnchanged } from './containment.js';
import { assertQdrantContainment, qdrantContainment } from './qdrant-containment.js';

export interface StoreSpec {
  service: Service;
  paths: string[];
  sqlite: string[];
  qdrant?: { url: string; apiKey?: string };
  redis?: { url: string; prefix: string };
}
interface FileEntry {
  source: string;
  file: string;
  sha256: string;
  sqlite: boolean;
  mode: number;
  uid: number;
  gid: number;
  protected: boolean;
}
interface QdrantEntry {
  collection: string;
  file: string;
  sha256: string;
  metadata: unknown;
  containment?: Record<string, string>;
}
interface RedisEntry {
  key: string;
  dump: string;
  expiresAt: number | null;
}
export interface BackupReceipt {
  schema: 1;
  id: string;
  installation: string;
  createdAt: string;
  files: FileEntry[];
  qdrant: QdrantEntry[];
  redis: RedisEntry[];
  services: Service[];
  completed: true;
  sourceVersions: Record<string, string>;
}
const SKIP = new Set(['node_modules', 'backups', 'writer.lock', 'upgrade.lock', 'migration.lock']);
async function digest(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
export function sqliteIntegrity(file: string): void {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (
      db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new Error('SQLite integrity or foreign key verification failed');
  } finally {
    db.close();
  }
}
export async function backupSqlite(source: string, destination: string): Promise<void> {
  assertAbsent(destination);
  privateDir(dirname(destination));
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await sqliteBackup(db, destination, {
      progress: () => {
        remaining(900_000);
      },
    });
  } finally {
    db.close();
  }
  chmodSync(destination, 0o600);
  sqliteIntegrity(destination);
}
export async function qdrantRequest(
  config: NonNullable<StoreSpec['qdrant']>,
  path: string,
  method = 'GET',
  body?: BodyInit,
  contentType?: string,
): Promise<Response> {
  const base = new URL(config.url);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error('Qdrant needs a plain HTTP(S) URL and a separate API key');
  const response = await fetch(base.toString().replace(/\/$/, '') + path, {
    method,
    headers: {
      ...(config.apiKey ? { 'api-key': config.apiKey } : {}),
      ...(contentType ? { 'content-type': contentType } : {}),
    },
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(remaining(180_000)),
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(`Qdrant ${method} ${path.split('/')[1]} failed (${response.status})`);
  return response;
}
function ownedCollection(name: string): boolean {
  return (
    /^shared_(episodic|semantic|procedural)$/.test(name) ||
    /_private_(episodic|semantic|procedural)$/.test(name) ||
    /^hivemem_shadow_[A-Za-z0-9_-]+$/.test(name) ||
    [
      '_agents',
      '_conclusions',
      '_episodes',
      '_queue',
      '_sessions',
      '_webhooks',
      '_webhook_deliveries',
      '_workspaces',
      '_operations',
    ].includes(name)
  );
}
export async function backupStores(
  specs: StoreSpec[],
  destination: string,
  installation: string,
  sourceVersions: Record<string, string> = {},
): Promise<BackupReceipt> {
  assertAbsent(destination);
  privateDir(destination);
  const files: FileEntry[] = [],
    qdrant: QdrantEntry[] = [],
    redis: RedisEntry[] = [];
  const sqlite = new Set(
    specs.flatMap((s) => s.sqlite.map((p) => (existsSync(p) ? realpathSync(p) : resolve(p)))),
  );
  const visited = new Set<string>();
  const copy = async (source: string): Promise<void> => {
    remaining(900_000);
    source = resolve(source);
    if (
      source === resolve(destination) ||
      source.startsWith(resolve(destination) + '/') ||
      visited.has(source)
    )
      return;
    if (!existsSync(source)) throw new Error(`Required backup path is missing: ${source}`);
    visited.add(source);
    const info = lstatSync(source);
    if (info.isSymbolicLink()) {
      await copy(realpathSync(source));
      return;
    }
    if (info.isDirectory()) {
      for (const name of readdirSync(source))
        if (
          !SKIP.has(name) &&
          !/\.(lock|bak)$/.test(name) &&
          !name.includes('.pre-migrate-') &&
          !/-wal$|-shm$/.test(name)
        )
          await copy(join(source, name));
      return;
    }
    if (!info.isFile()) throw new Error('Unsupported special file in backup inventory');
    const file = `files/${files.length}`;
    const target = join(destination, file);
    privateDir(dirname(target));
    if (sqlite.has(source)) await backupSqlite(source, target);
    else {
      copyFileSync(source, target);
      chmodSync(target, 0o600);
    }
    syncFile(target);
    files.push({
      source,
      file,
      sha256: await digest(target),
      sqlite: sqlite.has(source),
      mode: info.mode & 0o777,
      uid: info.uid,
      gid: info.gid,
      protected:
        !sqlite.has(source) &&
        (/\.(env|pem|key|crt)$/.test(source) ||
          /\/compose\.ya?ml$/.test(source) ||
          /\/(keys|keyring|tls|certs)\//.test(source) ||
          /revok|revocation/.test(source)),
    });
  };
  for (const spec of specs) {
    for (const file of spec.sqlite) if (existsSync(file)) await copy(file);
    for (const path of spec.paths) await copy(path);
    if (spec.qdrant) {
      const cluster = (await (await qdrantRequest(spec.qdrant, '/cluster')).json()) as {
        result?: { status?: string };
      };
      if (cluster.result?.status !== 'disabled')
        throw new Error('Only single-node Qdrant backup is supported');
      const list = (await (await qdrantRequest(spec.qdrant, '/collections')).json()) as {
        result: { collections: { name: string }[] };
      };
      for (const { name } of list.result.collections.filter((c) => ownedCollection(c.name))) {
        const metadata = await (
          await qdrantRequest(spec.qdrant, `/collections/${encodeURIComponent(name)}`)
        ).json();
        const containment = await qdrantContainment(spec.qdrant, name);
        const route = `/collections/${encodeURIComponent(name)}/snapshots`;
        const created = (await (await qdrantRequest(spec.qdrant, route, 'POST')).json()) as {
          result: { name: string; checksum?: string };
        };
        const remote = `${route}/${encodeURIComponent(created.result.name)}`;
        const file = `qdrant/${qdrant.length}.snapshot`;
        privateDir(join(destination, 'qdrant'));
        try {
          const response = await qdrantRequest(spec.qdrant, remote);
          if (!response.body) throw new Error('Empty Qdrant snapshot');
          await pipeline(
            Readable.fromWeb(response.body as never),
            createWriteStream(join(destination, file), { flags: 'wx', mode: 0o600 }),
          );
          const sha256 = await digest(join(destination, file));
          syncFile(join(destination, file));
          if (created.result.checksum && created.result.checksum !== sha256)
            throw new Error('Qdrant snapshot checksum mismatch');
          qdrant.push({
            collection: name,
            file,
            sha256,
            metadata,
            ...(containment ? { containment } : {}),
          });
        } finally {
          await qdrantRequest(spec.qdrant, remote, 'DELETE');
        }
      }
    }
    if (spec.redis) {
      const client = new Redis(new URL(spec.redis.url));
      try {
        await client.ready();
        for (const key of await client.keys(spec.redis.prefix)) {
          const dump = (await client.command('DUMP', key)) as Buffer | null;
          const ttl = (await client.command('PTTL', key)) as number;
          if (dump && ttl !== -2)
            redis.push({
              key: key.toString('base64'),
              dump: dump.toString('base64'),
              expiresAt: ttl >= 0 ? Date.now() + ttl : null,
            });
        }
      } finally {
        client.close();
      }
    }
  }
  const receipt: BackupReceipt = {
    schema: 1,
    id: randomUUID(),
    installation,
    createdAt: new Date().toISOString(),
    files,
    qdrant,
    redis,
    services: specs.map((s) => s.service),
    completed: true,
    sourceVersions,
  };
  durableTree(destination);
  writeJson(join(destination, 'manifest.json'), receipt);
  await verifyBackup(destination, installation);
  return receipt;
}
export async function verifyBackup(
  directory: string,
  installation: string,
): Promise<BackupReceipt> {
  const receipt = json<BackupReceipt>(join(directory, 'manifest.json'));
  if (receipt.schema !== 1 || !receipt.completed || receipt.installation !== installation)
    throw new Error('Backup is incomplete or belongs to another installation');
  for (const entry of [...receipt.files, ...receipt.qdrant]) {
    const file = resolve(directory, entry.file);
    if (
      relative(resolve(directory), file).startsWith('..') ||
      !file.startsWith(resolve(directory) + '/')
    )
      throw new Error('Unsafe backup path');
    if ((await digest(file)) !== entry.sha256)
      throw new Error('Backup checksum verification failed');
    if ('sqlite' in entry && entry.sqlite) sqliteIntegrity(file);
  }
  return receipt;
}
/** Offline restore only. Callers must stop every writer and review containment first. */
export async function restoreStores(
  specs: StoreSpec[],
  directory: string,
  installation: string,
  confirmation: string,
): Promise<void> {
  const receipt = await verifyBackup(directory, installation);
  if (confirmation !== hash(readFileSync(join(directory, 'manifest.json'))))
    throw new Error('Restore requires confirmation of the exact backup manifest hash');
  const destinations = new Set(
    specs
      .flatMap((s) => [...s.paths, ...s.sqlite])
      .map((p) => (existsSync(p) ? realpathSync(p) : resolve(p))),
  );
  if (receipt.services.some((service) => !specs.some((spec) => spec.service === service)))
    throw new Error('Restore service inventory differs from the backup');
  if (
    (receipt.qdrant.length && !specs.some((s) => s.qdrant)) ||
    (receipt.redis.length && !specs.some((s) => s.redis))
  )
    throw new Error('A datastore restore adapter is missing');
  const q = specs.find((s) => s.qdrant)?.qdrant;
  if (receipt.qdrant.length && !q) throw new Error('Qdrant restore configuration is missing');
  if (q) {
    const list = (await (await qdrantRequest(q, '/collections')).json()) as {
      result: { collections: { name: string }[] };
    };
    const existing = new Set(list.result.collections.map((c) => c.name));
    if (
      [...existing].some(
        (name) =>
          ownedCollection(name) && !receipt.qdrant.some((entry) => entry.collection === name),
      )
    )
      throw new Error(
        'New HiveMem collections exist; reconcile them before restoring an older inventory',
      );
    for (const entry of receipt.qdrant)
      if (entry.containment && existing.has(entry.collection))
        assertQdrantContainment(
          entry.collection,
          entry.containment,
          (await qdrantContainment(q, entry.collection)) || {},
        );
  }
  for (const entry of receipt.files) {
    if (![...destinations].some((p) => entry.source === p || entry.source.startsWith(p + '/')))
      throw new Error('Restore inventory differs from current configuration');
    if (existsSync(entry.source) && lstatSync(entry.source).isSymbolicLink())
      throw new Error('Refusing to restore through a changed symlink');
    if (
      entry.protected &&
      existsSync(entry.source) &&
      (await digest(entry.source)) !== entry.sha256
    )
      throw new Error(
        'Protected configuration, signing keys or revocations changed; reconcile them before restoring data',
      );
    if (process.getuid?.() !== 0 && entry.uid !== process.getuid?.())
      throw new Error('Restore requires the original file owner');
    if (entry.sqlite) {
      const service = specs.find((s) =>
        s.sqlite.some((p) => (existsSync(p) ? realpathSync(p) : resolve(p)) === entry.source),
      )?.service;
      if (service) assertContainmentUnchanged(entry.source, join(directory, entry.file), service);
    }
  }
  for (const entry of receipt.files) {
    privateDir(dirname(entry.source));
    if (entry.sqlite) {
      rmSync(`${entry.source}-wal`, { force: true });
      rmSync(`${entry.source}-shm`, { force: true });
    }
    copyFileSync(join(directory, entry.file), entry.source);
    chmodSync(entry.source, entry.mode);
    if (process.getuid?.() === 0) chownSync(entry.source, entry.uid, entry.gid);
    syncFile(entry.source);
    syncFile(dirname(entry.source));
  }
  for (const entry of receipt.qdrant) {
    const form = new FormData();
    form.append(
      'snapshot',
      new Blob([readFileSync(join(directory, entry.file))]),
      'restore.snapshot',
    );
    await qdrantRequest(
      q!,
      `/collections/${encodeURIComponent(entry.collection)}/snapshots/upload?priority=snapshot&wait=true`,
      'POST',
      form,
    );
  }
  const r = specs.find((s) => s.redis)?.redis;
  if (r) {
    const client = new Redis(new URL(r.url));
    try {
      await client.ready();
      // One-time authentication challenges must never become replayable after recovery.
      for (const key of await client.keys(r.prefix))
        if (!key.toString().startsWith(`${r.prefix}:webauthn:`)) await client.command('DEL', key);
      for (const entry of receipt.redis) {
        const key = Buffer.from(entry.key, 'base64');
        if (!key.toString().startsWith(r.prefix + ':'))
          throw new Error('Redis restore namespace mismatch');
        if (key.toString().startsWith(`${r.prefix}:webauthn:`)) continue;
        const ttl = entry.expiresAt === null ? 0 : entry.expiresAt - Date.now();
        if (entry.expiresAt !== null && ttl <= 0) continue;
        await client.command('RESTORE', key, String(ttl), Buffer.from(entry.dump, 'base64'));
      }
    } finally {
      client.close();
    }
  }
}

export function storeSpec(service: Service, env: NodeJS.ProcessEnv, root: string): StoreSpec {
  const base = env.HIVE_MANAGED_PROJECT ? root : process.cwd();
  const data = resolve(
    base,
    service === 'iam'
      ? env.IAM_DATA_DIR || join(root, 'iam')
      : service === 'router'
        ? env.DATA_DIR || join(root, 'router')
        : service === 'skills'
          ? env.HIVE_SKILLS_DATA_DIR || join(root, 'skills')
          : env.HIVEMEM_STORAGE_PATH || join(root, 'memory'),
  );
  const rawDatabase = (
    env.DATABASE_URL || `file:${join(data, service === 'iam' ? 'iam.db' : 'router.db')}`
  ).replace(/^file:/, '');
  const database = resolve(base, service === 'router' ? rawDatabase.split('?')[0]! : rawDatabase);
  if (
    env.DATABASE_URL &&
    !env.DATABASE_URL.startsWith('file:') &&
    (service === 'iam' || service === 'router')
  )
    throw new Error('Only SQLite is supported; database backup adapter unavailable');
  const sqlite =
    service === 'skills' ? [join(data, 'registry.sqlite')] : service === 'memory' ? [] : [database];
  const paths = [
    data,
    ...[
      'AUDIT_LOG_DIR',
      'TRACE_DIR',
      'HIVEMEM_REVOCATION_FILE',
      'JWT_PRIVATE_KEY_PATH',
      'JWT_PUBLIC_KEY_PATH',
      'TLS_KEY_PATH',
      'TLS_CERT_PATH',
      'HIVE_SKILLS_TLS_KEY_FILE',
      'HIVE_SKILLS_TLS_CERT_FILE',
      'HIVEMEM_TLS_KEY_FILE',
      'HIVEMEM_TLS_CERT_FILE',
      'HIVEMEM_TS_TLS_KEY_FILE',
      'HIVEMEM_TS_TLS_CERT_FILE',
    ].flatMap((key) => (env[key] ? [resolve(base, env[key]!)] : [])),
  ];
  return {
    service,
    paths: [...new Set(paths)].filter(existsSync),
    sqlite,
    ...(service === 'memory' && env.HIVEMEM_TS_PERSISTENCE !== 'memory'
      ? {
          qdrant: {
            url:
              env.HIVEMEM_QDRANT_URL ||
              env.QDRANT_URL ||
              `http://${env.HIVEMEM_QDRANT_HOST || env.QDRANT_HOST || '127.0.0.1'}:${env.HIVEMEM_QDRANT_PORT || env.QDRANT_PORT || 6333}`,
            ...(env.QDRANT_API_KEY ? { apiKey: env.QDRANT_API_KEY } : {}),
          },
        }
      : {}),
    ...(service === 'iam'
      ? {
          redis: {
            url: env.REDIS_URL || 'redis://127.0.0.1:6379',
            prefix: env.REDIS_PREFIX || 'hive-iam',
          },
        }
      : {}),
  };
}
