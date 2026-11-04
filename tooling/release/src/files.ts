import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  readdirSync,
  lstatSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

const deadlines = new AsyncLocalStorage<number>();
export function withinDeadline<T>(milliseconds: number, task: () => Promise<T>): Promise<T> {
  return deadlines.run(Date.now() + milliseconds, task);
}
export function remaining(maximum: number): number {
  const deadline = deadlines.getStore();
  if (deadline === undefined) return maximum;
  const left = deadline - Date.now();
  if (left <= 0)
    throw new Error('Upgrade execution deadline exceeded; inspect its recovery receipt');
  return Math.min(maximum, left);
}

export function home(env = process.env): string {
  return resolve((env.HIVE_HOME || join(homedir(), '.hive')).replace(/^~(?=\/|$)/, homedir()));
}
export function findPackageRoot(moduleUrl: string, name?: string): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const file = join(dir, 'package.json');
    if (existsSync(file) && (!name || json<{ name: string }>(file).name === name)) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Cannot locate package manifest');
    dir = parent;
  }
}
export function hash(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
export function json<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}
export function privateDir(dir: string): void {
  if (existsSync(dir)) return;
  const parent = dirname(dir);
  if (parent !== dir) privateDir(parent);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  syncFile(parent);
}
export function syncFile(file: string): void {
  const fd = openSync(file, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function durableTree(dir: string): void {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name),
      entry = lstatSync(file);
    if (entry.isDirectory()) durableTree(file);
    else if (entry.isFile()) syncFile(file);
    else if (!entry.isSymbolicLink()) throw new Error('Unexpected special file in staged release');
  }
  syncFile(dir);
}
export function atomic(file: string, content: string): void {
  privateDir(dirname(file));
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
  const dir = openSync(dirname(file), 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
export function writeJson(file: string, data: unknown): void {
  atomic(file, `${JSON.stringify(data, null, 2)}\n`);
}
/** Kernel lock: no stale lock stealing, automatically released after a process crash. */
export async function withLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  privateDir(dirname(file));
  const child = spawn(
    'flock',
    [
      '--exclusive',
      '--nonblock',
      file,
      process.execPath,
      '-e',
      'process.stdout.write("locked\\n");process.stdin.resume()',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  await new Promise<void>((yes, no) => {
    child.once('error', () => no(new Error('flock is required for migration and upgrade locks')));
    child.once('exit', () => no(new Error('Another migration or upgrade holds the lock')));
    child.stdout.once('data', () => yes());
  });
  try {
    return await task();
  } finally {
    child.stdin.end();
    await new Promise<void>((done) => {
      if (child.exitCode !== null) done();
      else child.once('exit', () => done());
    });
  }
}
export async function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<string> {
  return new Promise((yes, no) => {
    const timeoutMs = remaining(options.timeout ?? 180_000);
    const child = spawn(command, args, {
      ...options,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 32 * 1024 * 1024) child.kill();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      no(error);
    });
    // `exit` can precede the final stdout/stderr data events. JSON-producing
    // server commands must be completely drained before their output is read.
    child.once('close', (code) => {
      clearTimeout(timeout);
      code === 0
        ? yes(stdout)
        : no(
            new Error(
              `${command} ${args.find((arg) => ['check', 'migrate', 'start'].includes(arg)) || ''} failed (${code}): ${(stderr || stdout).slice(-4000)}`,
            ),
          );
    });
  });
}
export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function assertAbsent(path: string): void {
  if (existsSync(path)) throw new Error(`Refusing to overwrite ${path}`);
}
export function remove(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
