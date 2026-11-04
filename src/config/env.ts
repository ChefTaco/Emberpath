import { config as loadDotEnv } from 'dotenv';
import { join, resolve } from 'node:path';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { z } from 'zod';
import { assertStaticExporterFallbackAllowed } from '../security/static-exporter-fallback.js';
import { explicitEnvFileLoaded } from './env-file.js';
import { DEFAULT_ADMIN_PORT, DEFAULT_API_PORT } from './defaults.js';
import { defaultDataDir } from './paths.js';

// Without an explicit --env-file, keep the historical lookup of `.env` (and the
// overriding `.env.apikeys`) in the working directory.
if (!explicitEnvFileLoaded()) {
  const envPath = resolve(process.cwd(), '.env');
  const secretEnvPath = resolve(process.cwd(), '.env.apikeys');
  loadDotEnv({ path: envPath, quiet: true });
  if (existsSync(secretEnvPath)) {
    loadDotEnv({ path: secretEnvPath, override: true, quiet: true });
  }
}

export { DEFAULT_ADMIN_PORT, DEFAULT_API_PORT };

const portSchema = z.coerce.number().int().min(1).max(65535);
const byteLimitSchema = z.coerce.number().int().min(1024);
const optionalUrlSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.url().optional(),
);
const optionalSecretSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(24).optional(),
);
const optionalProxyTokenSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(8).optional(),
);
const optionalStringSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().optional(),
);
const booleanStringSchema = z
  .string()
  .optional()
  .transform((value) => value === 'true');

const defaultIamProxyScopes = [
  'iam:policy:write',
  'iam:users:read',
  'iam:users:write',
  'iam:users:delete',
  'iam:roles:read',
  'iam:roles:write',
  'iam:sa:read',
  'iam:sa:write',
  'iam:sa:delete',
  'iam:clients:read',
  'iam:clients:write',
  'iam:audit:read',
  'iam:sessions:revoke',
  'iam:system:login',
  'iam:tokens:introspect',
].join(' ');

export const envSchema = z.object({
  HIVE_AUTO_MIGRATE: z.string().default('false'),
  HIVE_UPDATE_CHECK: z.string().default('false'),
  HIVE_AUTO_UPGRADE: z.string().default('false'),
  HIVE_UI_UPGRADE: z.string().default('false'),
  HIVE_COMPOSE_UPGRADE_SUPERVISOR: z.string().default('false'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  HOST: z.string().default('127.0.0.1'),
  API_HOST: z.string().optional(),
  ADMIN_HOST: z.string().optional(),
  API_PORT: portSchema.default(DEFAULT_API_PORT),
  ADMIN_PORT: portSchema.default(DEFAULT_ADMIN_PORT),
  // Public URLs default to localhost on the configured ports, with the scheme
  // following the TLS configuration (see the transform below).
  PUBLIC_API_URL: optionalUrlSchema,
  PUBLIC_ADMIN_URL: optionalUrlSchema,
  HIVE_UI_PUBLIC_URL: optionalUrlSchema,
  HIVE_SKILLS_INTERNAL_URL: z.url().optional(),
  HIVE_SKILLS_PUBLIC_URL: z.url().optional(),
  HIVEMEM_INTERNAL_URL: z.url().default('http://127.0.0.1:18790'),
  HIVEMEM_PUBLIC_URL: optionalUrlSchema,
  HIVEMEM_CA_CERT_PATH: z.string().optional(),
  HIVE_ROUTER_MEMORY_PROXY_TOKEN: optionalProxyTokenSchema,
  HIVE_IAM_INTERNAL_URL: z.url().default('http://127.0.0.1:4200'),
  HIVE_IAM_PUBLIC_URL: optionalUrlSchema,
  HIVE_STATUS_ALLOW_INSECURE_TLS: booleanStringSchema.prefault('false'),
  HIVE_ROUTER_AUTH_MODE: z.enum(['os', 'iam-oidc']).default('os'),
  HIVE_ROUTER_IAM_CLIENT_ID: z.string().min(1).default('hive-router'),
  HIVE_ROUTER_IAM_CLIENT_SECRET: optionalSecretSchema,
  HIVE_ROUTER_IAM_REDIRECT_URI: optionalUrlSchema,
  HIVE_ROUTER_IAM_SCOPES: z.string().default('openid profile email'),
  HIVE_ROUTER_IAM_PROXY_SCOPES: z.string().default(defaultIamProxyScopes),
  HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS: booleanStringSchema.prefault('false'),
  HIVE_ROUTER_IAM_CA_CERT_PATH: z.string().optional(),
  HIVE_ROUTER_IAM_JWKS_REFRESH_MS: z.coerce.number().int().min(1_000).default(5 * 60_000),
  HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS: z.coerce.number().int().min(1_000).default(15 * 60_000),
  HIVE_ROUTER_IAM_ISSUER: z.string().min(1).default('hive-iam'),
  HIVE_ROUTER_IAM_AUDIENCE: z.string().min(1).default('hive-router'),
  HIVE_ROUTER_SECURITY_EXPORTER_CLIENT_ID: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).default('security-exporter'),
  // Router state defaults to ${HIVE_HOME:-~/.hive}/router (see the transform).
  HIVE_HOME: optionalStringSchema,
  DATABASE_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().startsWith('file:', { error: 'must be a SQLite file: URL, for example file:/var/lib/hive/router.db' }).optional(),
  ),
  DATA_DIR: optionalStringSchema,
  TRACE_DIR: optionalStringSchema,
  TLS_CERT_PATH: optionalStringSchema,
  TLS_KEY_PATH: optionalStringSchema,
  REQUIRE_TLS: booleanStringSchema,
  HIVE_ROUTER_SECRET: z.string().min(32),
  HIVE_ROUTER_ADMIN_USERS: z.string().default('admin'),
  HIVE_ROUTER_OS_AUTH_COMMAND: z.string().optional(),
  HIVE_ROUTER_METRICS_TOKEN: optionalSecretSchema,
  HIVE_ROUTER_SECURITY_EXPORT_TOKEN_HASH: z.string().optional(),
  HIVE_ROUTER_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED: booleanStringSchema.prefault('false'),
  HIVE_ROUTER_CLI_TOKEN: z.string().optional(),
  SEED_CLIENT_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  HIVE_TYPESAFE_AI_KEY: z.string().trim().min(1).optional(),
  HIVE_TYPESAFE_AI_MODEL: z.string().trim().min(1).default("jev-latest"),
  HIVE_ROUTER_OPENROUTER_KEY: z.string().trim().min(1).optional(),
  HIVE_ROUTER_DECISION_MODEL: z.string().min(1).default("~typesafe/jev-latest"),
  HIVE_ROUTER_DECISION_MODE: z.enum(["off", "shadow"]).default("shadow"),
  HIVE_ROUTER_DECISION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrlSchema,
  PROMETHEUS_PREFIX: z.string().default('hive_router_'),
  DEFAULT_TRACE_RETENTION_DAYS: z.coerce.number().int().min(1).default(7),
  MAX_REQUEST_BODY_BYTES: byteLimitSchema.default(64 * 1024 * 1024),
  MAX_ADMIN_BODY_BYTES: byteLimitSchema.default(2 * 1024 * 1024),
  MAX_TRACE_BODY_BYTES: byteLimitSchema.default(1024 * 1024),
  CAPTURE_BINARY_MEDIA: booleanStringSchema,
  CAPTURE_REQUEST_BODIES: booleanStringSchema.prefault('false'),
  CAPTURE_RESPONSE_BODIES: booleanStringSchema.prefault('false'),
}).transform((env) => {
  const tls = Boolean(env.TLS_CERT_PATH && env.TLS_KEY_PATH);
  const scheme = tls ? 'https' : 'http';
  const publicAdminUrl = env.PUBLIC_ADMIN_URL ?? `${scheme}://localhost:${env.ADMIN_PORT}`;
  const dataDir = env.DATA_DIR
    ? resolve(process.cwd(), env.DATA_DIR)
    : defaultDataDir(env.HIVE_HOME ? { HIVE_HOME: env.HIVE_HOME } : {});
  return {
    ...env,
    API_HOST: env.API_HOST ?? env.HOST,
    ADMIN_HOST: env.ADMIN_HOST ?? env.HOST,
    PUBLIC_API_URL: env.PUBLIC_API_URL ?? `${scheme}://localhost:${env.API_PORT}`,
    PUBLIC_ADMIN_URL: publicAdminUrl,
    HIVE_UI_PUBLIC_URL: env.HIVE_UI_PUBLIC_URL ?? publicAdminUrl,
    HIVEMEM_PUBLIC_URL: env.HIVEMEM_PUBLIC_URL ?? publicAdminUrl,
    HIVE_IAM_PUBLIC_URL: env.HIVE_IAM_PUBLIC_URL ?? `${publicAdminUrl.replace(/\/$/, '')}/iam`,
    DATA_DIR: dataDir,
    DATABASE_URL: env.DATABASE_URL ?? `file:${join(dataDir, 'router.db')}`,
    TRACE_DIR: env.TRACE_DIR ? resolve(process.cwd(), env.TRACE_DIR) : join(dataDir, 'traces'),
    TLS_CERT_PATH: env.TLS_CERT_PATH ? resolve(process.cwd(), env.TLS_CERT_PATH) : undefined,
    TLS_KEY_PATH: env.TLS_KEY_PATH ? resolve(process.cwd(), env.TLS_KEY_PATH) : undefined,
    HIVE_ROUTER_IAM_REDIRECT_URI: env.HIVE_ROUTER_IAM_REDIRECT_URI ?? `${publicAdminUrl.replace(/\/$/, '')}/api/auth/oidc/callback`,
    HIVE_ROUTER_IAM_CA_CERT_PATH: env.HIVE_ROUTER_IAM_CA_CERT_PATH
      ? resolve(process.cwd(), env.HIVE_ROUTER_IAM_CA_CERT_PATH)
      : undefined,
  };
});

export type Env = z.infer<typeof envSchema>;

export interface ConfigProblem {
  /** The environment variable to fix. */
  variable: string;
  /** One line that names the variable and says how to fix it. */
  message: string;
}

/** Invalid configuration. `message` holds one line per problem, no stack needed. */
export class ConfigError extends Error {
  readonly problems: ConfigProblem[];

  constructor(problems: ConfigProblem[]) {
    super(problems.map((problem) => problem.message).join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const FIX_HINT = 'in the environment or the --env-file';
const SELF_SIGNED_HINT = 'openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj /CN=localhost -keyout key.pem -out cert.pem';

function describeIssue(variable: string, issue: z.core.$ZodIssue, source: NodeJS.ProcessEnv): string {
  const raw = source[variable];
  if (variable === 'HIVE_ROUTER_SECRET') {
    return raw === undefined || raw === ''
      ? `HIVE_ROUTER_SECRET is not set. Set it ${FIX_HINT} to a random value of at least 32 characters (for example: openssl rand -hex 32).`
      : `HIVE_ROUTER_SECRET is too short (${raw.length} characters). Use at least 32 random characters (for example: openssl rand -hex 32).`;
  }
  if (raw === undefined) {
    return `${variable} is not set. Set it ${FIX_HINT}.`;
  }
  if (variable.endsWith('_PORT')) {
    return `${variable} must be a TCP port between 1 and 65535 (got "${raw}"). Fix it ${FIX_HINT}.`;
  }
  if (/SECRET|TOKEN|KEY|PASSWORD/u.test(variable)) {
    return `${variable} is invalid: ${issue.message}. Fix it ${FIX_HINT}.`;
  }
  return `${variable} is invalid: ${issue.message} (got "${raw}"). Fix it ${FIX_HINT}.`;
}

/**
 * Validate the environment without touching the filesystem beyond existence
 * checks. Returns every problem found, so `hive-router check` can report them
 * all; `parseEnv`/`loadEnv` throw them as one ConfigError.
 */
export function inspectEnv(source: NodeJS.ProcessEnv = process.env): { env: Env | null; problems: ConfigProblem[] } {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const seen = new Set<string>();
    const problems: ConfigProblem[] = [];
    for (const issue of parsed.error.issues) {
      const variable = String(issue.path[0] ?? 'environment');
      if (seen.has(variable)) continue;
      seen.add(variable);
      problems.push({ variable, message: describeIssue(variable, issue, source) });
    }
    return { env: null, problems };
  }

  const env = parsed.data;
  const problems: ConfigProblem[] = [];
  const add = (variable: string, message: string) => problems.push({ variable, message });

  if (Boolean(source['TLS_CERT_PATH']) !== Boolean(source['TLS_KEY_PATH'])) {
    const missing = source['TLS_CERT_PATH'] ? 'TLS_KEY_PATH' : 'TLS_CERT_PATH';
    add(missing, `${missing} is not set but ${missing === 'TLS_KEY_PATH' ? 'TLS_CERT_PATH' : 'TLS_KEY_PATH'} is. Set both to enable TLS, or neither for plain HTTP.`);
  }
  if (env.TLS_CERT_PATH && !existsSync(env.TLS_CERT_PATH)) {
    add('TLS_CERT_PATH', `TLS_CERT_PATH points to ${env.TLS_CERT_PATH}, which does not exist. Set it to a PEM certificate file.`);
  }
  if (env.TLS_KEY_PATH && !existsSync(env.TLS_KEY_PATH)) {
    add('TLS_KEY_PATH', `TLS_KEY_PATH points to ${env.TLS_KEY_PATH}, which does not exist. Set it to the PEM private key for TLS_CERT_PATH.`);
  }
  if (env.HIVE_ROUTER_IAM_CA_CERT_PATH && !existsSync(env.HIVE_ROUTER_IAM_CA_CERT_PATH)) {
    add('HIVE_ROUTER_IAM_CA_CERT_PATH', `HIVE_ROUTER_IAM_CA_CERT_PATH points to ${env.HIVE_ROUTER_IAM_CA_CERT_PATH}, which does not exist. Set it to the CA certificate that signed the IAM certificate, or unset it.`);
  }
  if (env.HIVEMEM_CA_CERT_PATH && !existsSync(env.HIVEMEM_CA_CERT_PATH)) {
    add('HIVEMEM_CA_CERT_PATH', `HIVEMEM_CA_CERT_PATH points to ${env.HIVEMEM_CA_CERT_PATH}, which does not exist. Set it to the CA certificate that signed the HiveMem certificate, or unset it.`);
  }
  if (env.HIVE_ROUTER_IAM_JWKS_REFRESH_MS > env.HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS) {
    add('HIVE_ROUTER_IAM_JWKS_REFRESH_MS', 'HIVE_ROUTER_IAM_JWKS_REFRESH_MS must not exceed HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS. Lower the refresh interval or raise the maximum age.');
  }
  if (env.HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS && env.NODE_ENV === 'production') {
    add('HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS', 'HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS is forbidden in production. Set it to false and trust the IAM certificate with HIVE_ROUTER_IAM_CA_CERT_PATH.');
  }
  if (env.HIVE_STATUS_ALLOW_INSECURE_TLS && env.NODE_ENV === 'production') {
    add('HIVE_STATUS_ALLOW_INSECURE_TLS', 'HIVE_STATUS_ALLOW_INSECURE_TLS is forbidden in production. Set it to false and trust the HiveMem certificate with HIVEMEM_CA_CERT_PATH.');
  }
  try {
    assertStaticExporterFallbackAllowed(env.HIVE_ROUTER_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED);
  } catch (error) {
    add('HIVE_ROUTER_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED', `${error instanceof Error ? error.message : String(error)}. Set HIVE_ROUTER_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED=false and use the IAM security exporter client.`);
  }
  if ((env.NODE_ENV === 'production' || env.REQUIRE_TLS) && (!env.TLS_CERT_PATH || !env.TLS_KEY_PATH)) {
    const reason = env.NODE_ENV === 'production' ? 'NODE_ENV=production' : 'REQUIRE_TLS=true';
    add('TLS_CERT_PATH', `TLS is required because ${reason}, but TLS_CERT_PATH and TLS_KEY_PATH are not set. Point both at a PEM certificate and private key (self-signed for testing: ${SELF_SIGNED_HINT}), or use NODE_ENV=development with REQUIRE_TLS=false for plain HTTP on a trusted network.`);
  }
  if (env.HIVE_ROUTER_AUTH_MODE === 'iam-oidc' && !env.HIVE_ROUTER_IAM_CLIENT_SECRET) {
    add('HIVE_ROUTER_IAM_CLIENT_SECRET', 'HIVE_ROUTER_IAM_CLIENT_SECRET is required when HIVE_ROUTER_AUTH_MODE=iam-oidc. Set it to the hive-router client secret registered in Hive IAM (at least 24 characters), or use HIVE_ROUTER_AUTH_MODE=os.');
  }

  return { env: problems.length === 0 ? env : null, problems };
}

/** Parse and validate without creating directories. Throws ConfigError. */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const { env, problems } = inspectEnv(source);
  if (!env) throw new ConfigError(problems);
  return env;
}

function ensurePrivateDir(variable: string, path: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
    throw new ConfigError([{
      variable,
      message: `${variable} (${path}) cannot be created or secured (${code}). Point ${variable} at a directory this user can write, or set HIVE_HOME.`,
    }]);
  }
}

let cachedEnv: Env | null = null;

export function loadEnv(): Env {
  if (cachedEnv) {
    return cachedEnv;
  }

  const env = parseEnv(process.env);
  ensurePrivateDir('DATA_DIR', env.DATA_DIR);
  ensurePrivateDir('TRACE_DIR', env.TRACE_DIR);

  cachedEnv = env;
  return env;
}
