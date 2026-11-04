import { commonEnv } from '../release/runtime.js';
import { DEFAULT_ADMIN_PORT, DEFAULT_API_PORT } from './defaults.js';
import { packageInfo } from './paths.js';

/**
 * Machine-readable description of the settings a fresh install needs, printed
 * by `hive-router env-schema`. Launchers use it to write env files and to
 * generate secrets. It covers install-time settings, not every tuning knob;
 * the README lists the rest.
 */
export interface EnvVarSpec {
  name: string;
  required: boolean;
  secret: boolean;
  default?: string;
  /** For secrets a launcher should create: `hex32` is 32 random bytes as hex. */
  generate?: 'hex32' | 'base64url32';
  description: string;
}

export interface DependencySpec {
  service: 'iam' | 'memory';
  /** npm package of the Hive server, when published. */
  package?: string;
  optional: boolean;
  requiredWhen?: string;
  healthPath: string;
  env: string[];
  /** Router variables whose value must equal a variable of the other service. */
  sharedSecrets: Array<{ name: string; peerEnv: string }>;
  /**
   * Router variables that hold a token minted by the other service's command
   * (for example `hivemem-server issue-token`), signed with `signedWith` of that
   * service. Tokens expire, so launchers re-issue them before `maxTtlSeconds`.
   */
  issuedTokens: Array<{ name: string; command: string; args: string[]; signedWith: string; maxTtlSeconds: number; description: string }>;
  description: string;
}

export interface EnvSchemaDocument {
  service: 'router';
  package: string;
  version: string;
  defaultPort: number;
  adminPort: number;
  healthPath: string;
  readyPath: string;
  consolePath: string;
  dependencies: DependencySpec[];
  env: EnvVarSpec[];
}

export const HEALTH_PATH = '/health';
export const READY_PATH = '/health/ready';

export const routerEnvCatalog: EnvVarSpec[] = [
  { name: 'NODE_ENV', required: false, secret: false, default: 'development', description: 'development, test or production. production requires TLS and rejects the insecure-TLS escape hatches.' },
  { name: 'LOG_LEVEL', required: false, secret: false, default: 'info', description: 'debug, info, warn or error.' },
  { name: 'HIVE_HOME', required: false, secret: false, default: '~/.hive', description: 'Base directory for Hive state. The Router keeps its data in $HIVE_HOME/router unless DATA_DIR is set.' },
  { name: 'HIVE_ROUTER_SECRET', required: true, secret: true, generate: 'hex32', description: 'Signs admin sessions and encrypts stored provider credentials. At least 32 characters. Keep it stable across restarts.' },
  { name: 'HIVE_ROUTER_ADMIN_USERS', required: false, secret: false, default: 'admin', description: 'Comma-separated account names allowed to sign in to the console. Set it explicitly.' },
  { name: 'HIVE_ROUTER_AUTH_MODE', required: false, secret: false, default: 'os', description: 'os: verify OS passwords through PAM (Linux, needs pamtester). iam-oidc: sign in through Hive IAM.' },
  { name: 'HIVE_ROUTER_OS_AUTH_COMMAND', required: false, secret: false, description: 'Command that replaces pamtester in os mode. It receives the username as its argument and the password on stdin; exit 0 accepts.' },
  { name: 'HOST', required: false, secret: false, default: '127.0.0.1', description: 'Default bind address for both listeners. Use 0.0.0.0 to listen on all interfaces.' },
  { name: 'API_HOST', required: false, secret: false, default: '$HOST', description: 'Bind address of the OpenAI-compatible API plane.' },
  { name: 'ADMIN_HOST', required: false, secret: false, default: '$HOST', description: 'Bind address of the admin plane and console.' },
  { name: 'API_PORT', required: false, secret: false, default: String(DEFAULT_API_PORT), description: 'API plane port.' },
  { name: 'ADMIN_PORT', required: false, secret: false, default: String(DEFAULT_ADMIN_PORT), description: 'Admin plane and console port.' },
  { name: 'PUBLIC_API_URL', required: false, secret: false, default: 'http(s)://localhost:$API_PORT', description: 'Externally visible API URL, shown in docs and agent enrollment. The scheme follows the TLS configuration.' },
  { name: 'PUBLIC_ADMIN_URL', required: false, secret: false, default: 'http(s)://localhost:$ADMIN_PORT', description: 'Externally visible console URL. Also the base of the default OIDC redirect URI.' },
  { name: 'HIVE_UI_PUBLIC_URL', required: false, secret: false, default: '$PUBLIC_ADMIN_URL', description: 'Public URL of the Hive console.' },
  { name: 'TLS_CERT_PATH', required: false, secret: false, description: 'PEM certificate (chain) served on both listeners. Required with TLS_KEY_PATH when NODE_ENV=production or REQUIRE_TLS=true.' },
  { name: 'TLS_KEY_PATH', required: false, secret: false, description: 'PEM private key for TLS_CERT_PATH.' },
  { name: 'REQUIRE_TLS', required: false, secret: false, default: 'false', description: 'Refuse to start without TLS even outside production.' },
  { name: 'DATA_DIR', required: false, secret: false, default: '$HIVE_HOME/router', description: 'Router state directory, created with mode 0700.' },
  { name: 'DATABASE_URL', required: false, secret: false, default: 'file:$DATA_DIR/router.db', description: 'SQLite database (file: URLs only).' },
  { name: 'TRACE_DIR', required: false, secret: false, default: '$DATA_DIR/traces', description: 'Trace body storage.' },
  { name: 'HIVE_ROUTER_METRICS_TOKEN', required: false, secret: true, generate: 'hex32', description: 'Bearer token for scraping /metrics on the admin plane. Without it, /metrics needs an admin session.' },
  { name: 'HIVE_IAM_INTERNAL_URL', required: false, secret: false, default: 'http://127.0.0.1:4200', description: 'Hive IAM base URL as the Router reaches it.' },
  { name: 'HIVE_IAM_PUBLIC_URL', required: false, secret: false, default: '$PUBLIC_ADMIN_URL/iam', description: 'Hive IAM URL shown to users.' },
  { name: 'HIVE_ROUTER_IAM_CLIENT_ID', required: false, secret: false, default: 'hive-router', description: 'OAuth client the Router uses with Hive IAM.' },
  { name: 'HIVE_ROUTER_IAM_CLIENT_SECRET', required: false, secret: true, generate: 'hex32', description: 'Secret of that IAM client (at least 24 characters). Required when HIVE_ROUTER_AUTH_MODE=iam-oidc; also enables the /api/iam/* console proxy. Must equal SEED_HIVE_ROUTER_CLIENT_SECRET in Hive IAM.' },
  { name: 'HIVE_ROUTER_IAM_REDIRECT_URI', required: false, secret: false, default: '$PUBLIC_ADMIN_URL/api/auth/oidc/callback', description: 'OIDC redirect URI registered for the Router client in Hive IAM.' },
  { name: 'HIVE_ROUTER_IAM_CA_CERT_PATH', required: false, secret: false, description: 'CA certificate trusted for IAM HTTPS (OIDC, JWKS, proxy).' },
  { name: 'HIVE_ROUTER_IAM_ISSUER', required: false, secret: false, default: 'hive-iam', description: 'Issuer required on IAM tokens.' },
  { name: 'HIVE_ROUTER_IAM_AUDIENCE', required: false, secret: false, default: 'hive-router', description: 'Audience required on IAM tokens.' },
  { name: 'HIVEMEM_INTERNAL_URL', required: false, secret: false, default: 'http://127.0.0.1:18790', description: 'HiveMem base URL as the Router reaches it (console Memory pages and the /v1/* compatibility proxy).' },
  { name: 'HIVEMEM_PUBLIC_URL', required: false, secret: false, default: '$PUBLIC_ADMIN_URL', description: 'HiveMem URL shown to users and agents.' },
  { name: 'HIVEMEM_CA_CERT_PATH', required: false, secret: false, description: 'CA certificate trusted for HiveMem HTTPS.' },
  { name: 'HIVE_ROUTER_MEMORY_PROXY_TOKEN', required: false, secret: true, description: 'Server-side HiveMem admin token for the console Memory pages, minted with `hivemem-server issue-token --subject hive-router --role admin` (signed with HiveMem\'s HIVEMEM_JWT_SECRET, valid for at most 30 days). Never sent to browsers.' },
];

export function buildEnvSchemaDocument(): EnvSchemaDocument {
  const info = packageInfo();
  return {
    service: 'router',
    package: info.name,
    version: info.version,
    defaultPort: DEFAULT_API_PORT,
    adminPort: DEFAULT_ADMIN_PORT,
    healthPath: HEALTH_PATH,
    readyPath: READY_PATH,
    consolePath: '/',
    dependencies: [
      {
        service: 'iam',
        package: '@hivemagnus/hive-iam-server',
        optional: true,
        requiredWhen: 'HIVE_ROUTER_AUTH_MODE=iam-oidc',
        healthPath: '/api/v1/health/ready',
        env: [
          'HIVE_IAM_INTERNAL_URL',
          'HIVE_IAM_PUBLIC_URL',
          'HIVE_ROUTER_IAM_CLIENT_ID',
          'HIVE_ROUTER_IAM_CLIENT_SECRET',
          'HIVE_ROUTER_IAM_REDIRECT_URI',
          'HIVE_ROUTER_IAM_CA_CERT_PATH',
          'HIVE_ROUTER_IAM_ISSUER',
          'HIVE_ROUTER_IAM_AUDIENCE',
        ],
        sharedSecrets: [{ name: 'HIVE_ROUTER_IAM_CLIENT_SECRET', peerEnv: 'SEED_HIVE_ROUTER_CLIENT_SECRET' }],
        issuedTokens: [],
        description: 'Identity provider for console sign-in (iam-oidc mode) and the IAM console pages.',
      },
      {
        service: 'memory',
        package: '@hivemagnus/hivemem-server',
        optional: true,
        healthPath: '/v1/health/ready',
        env: ['HIVEMEM_INTERNAL_URL', 'HIVEMEM_PUBLIC_URL', 'HIVEMEM_CA_CERT_PATH', 'HIVE_ROUTER_MEMORY_PROXY_TOKEN'],
        sharedSecrets: [],
        issuedTokens: [
          {
            name: 'HIVE_ROUTER_MEMORY_PROXY_TOKEN',
            command: 'hivemem-server issue-token',
            args: ['--subject', 'hive-router', '--role', 'admin'],
            signedWith: 'HIVEMEM_JWT_SECRET',
            maxTtlSeconds: 30 * 24 * 60 * 60,
            description: 'HiveMem admin token for the Memory pages and the memory proxy. Re-issue it before it expires and restart the Router.',
          },
        ],
        description: 'Memory service behind the console Memory pages.',
      },
    ],
    env: [...commonEnv(), ...routerEnvCatalog],
  };
}
