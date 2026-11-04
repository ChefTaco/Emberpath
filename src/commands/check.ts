import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { inspectEnv, type Env } from '../config/env.js';
import { explicitEnvFileLoaded } from '../config/env-file.js';
import { packageInfo } from '../config/paths.js';
import { resolveSqlitePath } from '../storage/sqlite-path.js';
import { hiveMemTlsOptions, iamTlsOptions } from '../security/iam-tls.js';
import { requestServiceHealth } from '../contracts/service-health.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface CheckReport {
  ok: boolean;
  checks: CheckResult[];
}

export interface CheckOptions {
  offline?: boolean;
  source?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isRoot?: boolean;
  /** Overrides the HTTP probe, for tests. Resolves to a status line or throws. */
  probe?: (url: string, tls: Record<string, unknown>) => Promise<{ ok: boolean; statusCode: number }>;
  findExecutable?: (command: string) => string | null;
}

const CERT_EXPIRY_WARNING_MS = 14 * 24 * 60 * 60 * 1000;

function findOnPath(command: string, source: NodeJS.ProcessEnv): string | null {
  const candidates = isAbsolute(command) || command.includes('/')
    ? [command]
    : (source['PATH'] ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Can this user create or write `path` without writing anything now? */
function writableTarget(path: string): { ok: boolean; detail: string } {
  if (existsSync(path)) {
    try {
      accessSync(path, constants.W_OK | (statSync(path).isDirectory() ? constants.X_OK : 0));
      return { ok: true, detail: 'exists and is writable' };
    } catch {
      return { ok: false, detail: 'exists but is not writable by this user' };
    }
  }
  let ancestor = dirname(path);
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  try {
    accessSync(ancestor, constants.W_OK | constants.X_OK);
    return { ok: true, detail: `will be created (under ${ancestor})` };
  } catch {
    return { ok: false, detail: `cannot be created: ${ancestor} is not writable by this user` };
  }
}

function checkTls(env: Env, results: CheckResult[]): void {
  if (!env.TLS_CERT_PATH || !env.TLS_KEY_PATH) {
    results.push({ name: 'tls', status: 'warn', message: 'TLS is off: both listeners use plain HTTP. Set TLS_CERT_PATH and TLS_KEY_PATH for anything beyond loopback.' });
    return;
  }
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(readFileSync(env.TLS_CERT_PATH));
  } catch (error) {
    results.push({ name: 'tls', status: 'fail', message: `TLS_CERT_PATH (${env.TLS_CERT_PATH}) is not a readable PEM certificate: ${error instanceof Error ? error.message : String(error)}` });
    return;
  }
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(readFileSync(env.TLS_KEY_PATH));
  } catch (error) {
    results.push({ name: 'tls', status: 'fail', message: `TLS_KEY_PATH (${env.TLS_KEY_PATH}) is not a readable PEM private key: ${error instanceof Error ? error.message : String(error)}` });
    return;
  }
  if (!certificate.checkPrivateKey(key)) {
    results.push({ name: 'tls', status: 'fail', message: 'TLS_KEY_PATH does not match the certificate in TLS_CERT_PATH. Point both at the same key pair.' });
    return;
  }
  const expiresAt = Date.parse(certificate.validTo);
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) {
    results.push({ name: 'tls', status: 'fail', message: `The certificate in TLS_CERT_PATH expired on ${certificate.validTo}. Renew it.` });
  } else if (remaining < CERT_EXPIRY_WARNING_MS) {
    results.push({ name: 'tls', status: 'warn', message: `The certificate in TLS_CERT_PATH expires soon (${certificate.validTo}).` });
  } else {
    results.push({ name: 'tls', status: 'ok', message: `certificate and key match; valid until ${certificate.validTo}` });
  }
}

function checkStorage(env: Env, results: CheckResult[]): void {
  const databasePath = resolveSqlitePath(env.DATABASE_URL);
  const targets: Array<[string, string]> = [
    ['DATA_DIR', env.DATA_DIR],
    ['TRACE_DIR', env.TRACE_DIR],
    ['DATABASE_URL', databasePath],
  ];
  for (const [variable, path] of targets) {
    const { ok, detail } = writableTarget(path);
    results.push({
      name: variable.toLowerCase().replace('_url', '').replace('_', '-'),
      status: ok ? 'ok' : 'fail',
      message: ok ? `${path} ${detail}` : `${variable}: ${path} ${detail}. Point ${variable} at a writable location or set HIVE_HOME.`,
    });
  }
  if (existsSync(env.DATA_DIR)) {
    const mode = statSync(env.DATA_DIR).mode & 0o077;
    if (mode !== 0) {
      results.push({ name: 'data-dir-mode', status: 'warn', message: `${env.DATA_DIR} is accessible to other users; the Router tightens it to 0700 on start.` });
    }
  }
}

function checkListeners(env: Env, isRoot: boolean, results: CheckResult[]): void {
  if (env.API_PORT === env.ADMIN_PORT) {
    results.push({ name: 'ports', status: 'fail', message: `API_PORT and ADMIN_PORT are both ${env.API_PORT}. Give each plane its own port.` });
    return;
  }
  const privileged = [['API_PORT', env.API_PORT], ['ADMIN_PORT', env.ADMIN_PORT]].filter(([, port]) => Number(port) < 1024);
  if (privileged.length > 0 && !isRoot) {
    results.push({
      name: 'ports',
      status: 'warn',
      message: `${privileged.map(([name, port]) => `${name}=${port}`).join(', ')} is below 1024 and needs root or CAP_NET_BIND_SERVICE.`,
    });
    return;
  }
  results.push({ name: 'ports', status: 'ok', message: `API ${env.API_HOST}:${env.API_PORT}, admin ${env.ADMIN_HOST}:${env.ADMIN_PORT}` });
}

function checkAuth(env: Env, source: NodeJS.ProcessEnv, options: Required<Pick<CheckOptions, 'platform' | 'findExecutable'>>, results: CheckResult[]): void {
  if (!source['HIVE_ROUTER_ADMIN_USERS']?.trim()) {
    results.push({ name: 'admin-users', status: 'warn', message: 'HIVE_ROUTER_ADMIN_USERS is not set, so only the account "admin" may sign in. Set it to the exact operator accounts.' });
  } else {
    results.push({ name: 'admin-users', status: 'ok', message: `sign-in allowed for: ${env.HIVE_ROUTER_ADMIN_USERS}` });
  }

  if (env.HIVE_ROUTER_AUTH_MODE !== 'os') {
    results.push({ name: 'auth-mode', status: 'ok', message: 'iam-oidc: console sign-in goes through Hive IAM' });
    return;
  }
  const custom = env.HIVE_ROUTER_OS_AUTH_COMMAND?.trim();
  if (custom) {
    const found = options.findExecutable(custom);
    results.push(found
      ? { name: 'auth-mode', status: 'ok', message: `os: HIVE_ROUTER_OS_AUTH_COMMAND resolves to ${found}` }
      : { name: 'auth-mode', status: 'fail', message: `HIVE_ROUTER_OS_AUTH_COMMAND (${custom}) is not an executable file or not on PATH. Fix the command, or unset it to use pamtester.` });
    return;
  }
  if (options.platform !== 'linux') {
    results.push({ name: 'auth-mode', status: 'fail', message: `HIVE_ROUTER_AUTH_MODE=os uses Linux PAM through pamtester, which is not supported on ${options.platform}. Use HIVE_ROUTER_AUTH_MODE=iam-oidc with Hive IAM.` });
    return;
  }
  const pamtester = options.findExecutable('pamtester');
  results.push(pamtester
    ? { name: 'auth-mode', status: 'ok', message: `os: PAM sign-in through ${pamtester}` }
    : { name: 'auth-mode', status: 'fail', message: 'HIVE_ROUTER_AUTH_MODE=os needs pamtester on PATH. Install it (for example: sudo apt-get install pamtester) or use HIVE_ROUTER_AUTH_MODE=iam-oidc.' });
}

async function checkDependency(
  name: 'iam' | 'memory',
  url: string,
  required: boolean,
  tls: () => Record<string, unknown>,
  probe: NonNullable<CheckOptions['probe']>,
  results: CheckResult[],
): Promise<void> {
  const failStatus: CheckStatus = required ? 'fail' : 'warn';
  const displayUrl = new URL(url);
  displayUrl.username = '';
  displayUrl.password = '';
  displayUrl.search = '';
  displayUrl.hash = '';
  try {
    const result = await probe(url, tls());
    results.push(result.ok
      ? { name, status: 'ok', message: `${displayUrl} is reachable (HTTP ${result.statusCode})` }
      : { name, status: failStatus, message: `${displayUrl} answered HTTP ${result.statusCode}; the service is up but not ready.` });
  } catch {
    const variable = name === 'iam' ? 'HIVE_IAM_INTERNAL_URL' : 'HIVEMEM_INTERNAL_URL';
    results.push({ name, status: failStatus, message: `${displayUrl} is unreachable. Start the service or fix ${variable}.` });
  }
}

const defaultProbe: NonNullable<CheckOptions['probe']> = async (url, tls) => {
  const result = await requestServiceHealth(url, { allowInsecureTls: tls['rejectUnauthorized'] === false, tls, timeoutMs: 4000 });
  return { ok: result.ok, statusCode: result.statusCode };
};

/** Validates configuration without starting listeners or writing data. */
export async function runChecks(options: CheckOptions = {}): Promise<CheckReport> {
  const source = options.source ?? process.env;
  const results: CheckResult[] = [];
  const { env, problems } = inspectEnv(source);

  if (!env) {
    for (const problem of problems) results.push({ name: 'config', status: 'fail', message: problem.message });
    return { ok: false, checks: results };
  }
  results.push({ name: 'config', status: 'ok', message: `environment is valid (NODE_ENV=${env.NODE_ENV}, auth mode ${env.HIVE_ROUTER_AUTH_MODE})` });

  checkTls(env, results);
  checkStorage(env, results);
  checkListeners(env, options.isRoot ?? process.getuid?.() === 0, results);
  checkAuth(env, source, {
    platform: options.platform ?? process.platform,
    findExecutable: options.findExecutable ?? ((command) => findOnPath(command, source)),
  }, results);

  const probe = options.probe ?? defaultProbe;
  const iamRequired = env.HIVE_ROUTER_AUTH_MODE === 'iam-oidc';
  if (iamRequired || source['HIVE_IAM_INTERNAL_URL'] || source['HIVE_ROUTER_IAM_CLIENT_SECRET']) {
    const url = `${env.HIVE_IAM_INTERNAL_URL.replace(/\/$/u, '')}/api/v1/health/ready`;
    if (options.offline) results.push({ name:'iam',status:'warn',message:'Not probed during offline configuration check; live upgrade health must verify IAM' });
    else await checkDependency('iam', url, iamRequired, () => iamTlsOptions(new URL(url), env) as Record<string, unknown>, probe, results);
  } else {
    results.push({ name: 'iam', status: 'ok', message: 'not configured (optional)' });
  }

  if (source['HIVEMEM_INTERNAL_URL'] || env.HIVE_ROUTER_MEMORY_PROXY_TOKEN) {
    const url = `${env.HIVEMEM_INTERNAL_URL.replace(/\/$/u, '')}/v1/health/ready`;
    if (options.offline) results.push({ name:'memory',status:'warn',message:'Not probed during offline configuration check; live upgrade health must verify Memory' });
    else await checkDependency('memory', url, false, () => hiveMemTlsOptions(new URL(url), env) as Record<string, unknown>, probe, results);
    if (!env.HIVE_ROUTER_MEMORY_PROXY_TOKEN) {
      results.push({ name: 'memory-token', status: 'warn', message: 'HIVE_ROUTER_MEMORY_PROXY_TOKEN is not set, so the console Memory pages cannot call HiveMem. Set it to the HiveMem admin token.' });
    }
  } else {
    results.push({ name: 'memory', status: 'ok', message: 'not configured (optional)' });
  }

  return { ok: results.every((result) => result.status !== 'fail'), checks: results };
}

export function formatReport(report: CheckReport): string {
  const info = packageInfo();
  const envFile = explicitEnvFileLoaded();
  const label: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
  const width = Math.max(...report.checks.map((check) => check.name.length));
  const lines = [
    `Hive Router configuration check (${info.name} ${info.version})`,
    `env file: ${envFile ?? 'none (process environment and ./.env)'}`,
    '',
    ...report.checks.map((check) => `  ${label[check.status]}  ${check.name.padEnd(width)}  ${check.message}`),
    '',
  ];
  const failures = report.checks.filter((check) => check.status === 'fail').length;
  const warnings = report.checks.filter((check) => check.status === 'warn').length;
  lines.push(failures === 0
    ? `Configuration OK${warnings ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : ''}.`
    : `${failures} problem${failures === 1 ? '' : 's'} to fix${warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}.`);
  return lines.join('\n');
}
