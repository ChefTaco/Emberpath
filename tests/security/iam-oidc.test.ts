import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/config/env.js';
import { authenticateIamOidcUser, requestHiveMemServiceToken, requestIamClientCredentialsToken } from '../../src/security/iam-oidc.js';

let server: ReturnType<typeof createServer> | null = null;
let baseUrl = '';
/** What the fake Oathweave saw: forwarded client addresses and revoked sessions. */
const seen: { forwardedFor: Array<string | undefined>; logouts: string[]; mfaCodes: string[] } = { forwardedFor: [], logouts: [], mfaCodes: [] };

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { raw += chunk; });
    request.on('end', () => resolve(raw));
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function testEnv(): Env {
  return {
    HIVE_REHEARSAL: false,
    NODE_ENV: 'test',
    HIVE_AUTO_MIGRATE:'false', HIVE_UPDATE_CHECK:'false', HIVE_AUTO_UPGRADE:'false', HIVE_UI_UPGRADE:'false', HIVE_COMPOSE_UPGRADE_SUPERVISOR:'false',
    LOG_LEVEL: 'error',
    HOST: '127.0.0.1',
    API_HOST: '127.0.0.1',
    ADMIN_HOST: '127.0.0.1',
    API_PORT: 443,
    ADMIN_PORT: 9443,
    PUBLIC_API_URL: 'https://localhost:443',
    PUBLIC_ADMIN_URL: 'https://localhost:9443',
    HIVE_UI_PUBLIC_URL: 'https://localhost:9443',
    HIVEMEM_INTERNAL_URL: 'http://127.0.0.1:18790',
    HIVEMEM_PUBLIC_URL: 'https://hive.example.com',
    HIVEMEM_CA_CERT_PATH: undefined,
    HIVE_IAM_INTERNAL_URL: baseUrl,
    HIVE_IAM_PUBLIC_URL: `${baseUrl}/iam`,
    HIVE_STATUS_ALLOW_INSECURE_TLS: false,
    HIVE_ROUTER_AUTH_MODE: 'iam-oidc',
    HIVE_ROUTER_IAM_CLIENT_ID: 'hive-router',
    HIVE_ROUTER_IAM_CLIENT_SECRET: 'router-client-secret-1234567890',
    HIVE_ROUTER_IAM_REDIRECT_URI: 'https://localhost:9443/api/auth/oidc/callback',
    HIVE_ROUTER_IAM_SCOPES: 'openid profile email',
    HIVE_ROUTER_IAM_PROXY_SCOPES: 'iam:users:read iam:roles:read',
    HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS: false,
    HIVE_ROUTER_IAM_CA_CERT_PATH: undefined,
    HIVE_ROUTER_IAM_JWKS_REFRESH_MS: 300_000,
    HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS: 900_000,
    HIVE_ROUTER_IAM_ISSUER: 'hive-iam',
    HIVE_ROUTER_IAM_AUDIENCE: 'hive-router',
    HIVE_ROUTER_SECURITY_EXPORTER_CLIENT_ID: 'security-exporter',
    EMBERPATH_HIVEMEM_SCOPE: 'hivemem:admin:all',
    EMBERPATH_HIVEMEM_TOKEN_URL: `${baseUrl}/api/v1/oauth/token`,
    DATABASE_URL: 'file:./data/test-router.db',
    DATA_DIR: './data/test',
    TRACE_DIR: './data/test/traces',
    REQUIRE_TLS: false,
    HIVE_ROUTER_SECRET: 'hive-router-test-secret-1234567890',
    HIVE_ROUTER_ADMIN_USERS: 'admin',
    HIVE_ROUTER_OS_AUTH_COMMAND: undefined,
    HIVE_ROUTER_METRICS_TOKEN: undefined,
    HIVE_ROUTER_CLI_TOKEN: undefined,
    SEED_CLIENT_API_KEY: undefined,
    OPENROUTER_API_KEY: undefined,
    HIVE_TYPESAFE_AI_MODEL: "jev-latest",
    HIVE_ROUTER_DECISION_MODEL: "~typesafe/jev-latest",
    HIVE_ROUTER_DECISION_MODE: "off",
    HIVE_ROUTER_DECISION_TIMEOUT_MS: 10_000,
    EMBERPATH_DECISIONS_JEV_ENABLED: false,
    EMBERPATH_REQUEST_DEADLINE_MS: 300_000,
    EMBERPATH_TRUSTED_PROXIES: 'loopback',
    EMBERPATH_PROVIDER_QUEUE_MAX: 0,
    EMBERPATH_PROVIDER_QUEUE_TIMEOUT_MS: 0,
    EMBERPATH_CIRCUIT_FAILURE_THRESHOLD: 3,
    EMBERPATH_CIRCUIT_WINDOW_MS: 60_000,
    EMBERPATH_CIRCUIT_OPEN_MS: 30_000,
    EMBERPATH_UPSTREAM_RESPONSE_HEADERS: 'allowlist',
    EMBERPATH_UPSTREAM_RESPONSE_HEADER_ALLOW: '',
    OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
    PROMETHEUS_PREFIX: 'hive_router_test_',
    DEFAULT_TRACE_RETENTION_DAYS: 7,
    MAX_REQUEST_BODY_BYTES: 64 * 1024 * 1024,
    MAX_ADMIN_BODY_BYTES: 2 * 1024 * 1024,
    MAX_TRACE_BODY_BYTES: 1024 * 1024,
    CAPTURE_BINARY_MEDIA: false,
    CAPTURE_REQUEST_BODIES: true,
    CAPTURE_RESPONSE_BODIES: true,
    EMBERPATH_API_KEY_CACHE_TTL_MS: 60_000,
    EMBERPATH_KEY_LAST_USED_INTERVAL_MS: 60_000,
    EMBERPATH_MODELS_CACHE_TTL_MS: 5_000,
    EMBERPATH_RESPONSE_CACHE_TTL_MS: 0,
    EMBERPATH_RESPONSE_CACHE_MAX_ENTRIES: 1_000,
    EMBERPATH_RESPONSE_CACHE_MAX_BYTES: 64 * 1024 * 1024,
    TLS_CERT_PATH: undefined,
    TLS_KEY_PATH: undefined,
  };
}

describe('security/iam-oidc', () => {
  beforeEach(async () => {
    server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', baseUrl);
      if (request.method === 'POST' && url.pathname === '/api/v1/auth/login') {
        seen.forwardedFor.push(request.headers['x-forwarded-for'] as string | undefined);
        const body = JSON.parse(await readBody(request)) as { username?: string; password?: string };
        if (body.username === 'mfa-user' && body.password === 'correct-password') {
          json(response, 200, { requiresMfa: true, mfaToken: 'mfa-challenge-token', methods: ['totp'] });
          return;
        }
        if (body.username !== 'admin' || body.password !== 'correct-password') {
          json(response, 401, { error: 'INVALID_CREDENTIALS' });
          return;
        }
        json(response, 200, { accessToken: 'iam-login-access-token', expiresIn: 900 });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/auth/mfa/challenge') {
        seen.forwardedFor.push(request.headers['x-forwarded-for'] as string | undefined);
        const body = JSON.parse(await readBody(request)) as { mfaToken?: string; code?: string };
        seen.mfaCodes.push(body.code ?? '');
        if (body.mfaToken !== 'mfa-challenge-token' || body.code !== '123456') {
          json(response, 401, { error: 'INVALID_MFA_CODE' });
          return;
        }
        json(response, 200, { accessToken: 'iam-login-access-token', expiresIn: 900 });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/auth/logout') {
        seen.logouts.push(String(request.headers.authorization));
        json(response, 200, { success: true });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/oauth/authorize') {
        expect(request.headers.authorization).toBe('Bearer iam-login-access-token');
        expect(url.searchParams.get('client_id')).toBe('hive-router');
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        const redirect = new URL(url.searchParams.get('redirect_uri') ?? 'https://localhost:9443/api/auth/oidc/callback');
        redirect.searchParams.set('code', 'auth-code-1');
        redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
        response.writeHead(302, { location: redirect.toString() });
        response.end();
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/oauth/token') {
        const form = new URLSearchParams(await readBody(request));
        if (form.get('grant_type') === 'client_credentials' && form.get('client_id') === 'fake-emberpath-hivemem') {
          expect(form.get('client_secret')).toBe('fake-hivemem-client-secret-0123456789abcdef');
          expect(form.get('scope')).toBe('hivemem:admin:all');
          json(response, 200, { access_token: 'hivemem-service-access-token', token_type: 'Bearer', expires_in: 300, scope: form.get('scope') });
          return;
        }
        if (form.get('grant_type') === 'client_credentials') {
          expect(form.get('client_id')).toBe('hive-router');
          expect(form.get('client_secret')).toBe('router-client-secret-1234567890');
          expect(form.get('scope')).toBe('iam:users:read iam:roles:read');
          json(response, 200, { access_token: 'iam-proxy-access-token', token_type: 'Bearer', expires_in: 600, scope: form.get('scope') });
          return;
        }

        expect(form.get('grant_type')).toBe('authorization_code');
        expect(form.get('client_id')).toBe('hive-router');
        expect(form.get('client_secret')).toBe('router-client-secret-1234567890');
        expect(form.get('code_verifier')).toBeTruthy();
        json(response, 200, { access_token: 'iam-oidc-access-token', token_type: 'Bearer', expires_in: 900 });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/oauth/userinfo') {
        expect(request.headers.authorization).toBe('Bearer iam-oidc-access-token');
        json(response, 200, { sub: 'user-1', preferred_username: 'admin', email: 'admin@iam.local', name: 'Admin', roles: ['SUPER_ADMIN'] });
        return;
      }

      json(response, 404, { error: 'not_found' });
    });

    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    seen.forwardedFor.length = 0;
    seen.logouts.length = 0;
    seen.mfaCodes.length = 0;
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = null;
  });

  it('authenticates a Router admin through IAM authorization code + PKCE', async () => {
    const user = await authenticateIamOidcUser('admin', 'correct-password', testEnv());
    expect(user).toEqual({
      subject: 'user-1',
      username: 'admin',
      email: 'admin@iam.local',
      displayName: 'Admin',
      roles: ['SUPER_ADMIN'],
      permissions: [],
    });
  });

  it('ends both Oathweave sessions the sign-in opened', async () => {
    await authenticateIamOidcUser('admin', 'correct-password', testEnv());
    expect(seen.logouts.sort()).toEqual(['Bearer iam-login-access-token', 'Bearer iam-oidc-access-token']);
  });

  it('forwards the client address so Oathweave can limit each client separately', async () => {
    await authenticateIamOidcUser('admin', 'correct-password', testEnv(), { clientIp: '::ffff:192.0.2.10' });
    await authenticateIamOidcUser('admin', 'correct-password', testEnv(), { clientIp: 'not-an-address' });
    expect(seen.forwardedFor).toEqual(['192.0.2.10', undefined]);
  });

  it('reports a multi-factor challenge instead of failing the sign-in', async () => {
    await expect(authenticateIamOidcUser('mfa-user', 'correct-password', testEnv())).resolves.toEqual({ mfaRequired: true, methods: ['totp'] });
    expect(seen.mfaCodes).toEqual([]);
    expect(seen.logouts).toEqual([]);
  });

  it('completes a multi-factor sign-in with the authenticator code', async () => {
    const user = await authenticateIamOidcUser('mfa-user', 'correct-password', testEnv(), { mfaCode: '123456', clientIp: '192.0.2.20' });
    expect(user).toMatchObject({ subject: 'user-1', username: 'admin' });
    expect(seen.forwardedFor).toEqual(['192.0.2.20', '192.0.2.20']);
    expect(seen.logouts).toHaveLength(2);
  });

  it('rejects a wrong authenticator code', async () => {
    await expect(authenticateIamOidcUser('mfa-user', 'correct-password', testEnv(), { mfaCode: '000000' })).resolves.toBeNull();
  });

  it('returns null for invalid IAM credentials', async () => {
    await expect(authenticateIamOidcUser('admin', 'wrong-password', testEnv())).resolves.toBeNull();
  });

  it('requests an IAM client-credentials token for the server-side proxy', async () => {
    await expect(requestIamClientCredentialsToken(testEnv())).resolves.toEqual({
      accessToken: 'iam-proxy-access-token',
      expiresIn: 600,
      tokenType: 'Bearer',
      scope: 'iam:users:read iam:roles:read',
    });
  });

  it('requests a HiveMem service token only when its Oathweave client is configured', async () => {
    await expect(requestHiveMemServiceToken(testEnv())).resolves.toBeNull();
    await expect(requestHiveMemServiceToken({
      ...testEnv(),
      EMBERPATH_HIVEMEM_CLIENT_ID: 'fake-emberpath-hivemem',
      EMBERPATH_HIVEMEM_CLIENT_SECRET: 'fake-hivemem-client-secret-0123456789abcdef',
    })).resolves.toEqual({
      accessToken: 'hivemem-service-access-token',
      expiresIn: 300,
      tokenType: 'Bearer',
      scope: 'hivemem:admin:all',
    });
  });
});
