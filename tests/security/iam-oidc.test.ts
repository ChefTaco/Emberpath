import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/config/env.js';
import { authenticateIamOidcUser, requestIamClientCredentialsToken } from '../../src/security/iam-oidc.js';

let server: ReturnType<typeof createServer> | null = null;
let baseUrl = '';

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
    DATABASE_URL: 'file:./data/test-router.db',
    DATA_DIR: './data/test',
    TRACE_DIR: './data/test/traces',
    REQUIRE_TLS: false,
    HIVE_ROUTER_SECRET: 'hive-router-test-secret-1234567890',
    HIVE_ROUTER_ADMIN_USERS: 'admin',
    HIVE_ROUTER_OS_AUTH_COMMAND: undefined,
    HIVE_ROUTER_METRICS_TOKEN: undefined,
    HIVE_ROUTER_SECURITY_EXPORT_TOKEN_HASH: undefined,
    HIVE_ROUTER_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED: false,
    HIVE_ROUTER_CLI_TOKEN: undefined,
    SEED_CLIENT_API_KEY: undefined,
    OPENROUTER_API_KEY: undefined,
    HIVE_TYPESAFE_AI_MODEL: "jev-latest",
    HIVE_ROUTER_DECISION_MODEL: "~typesafe/jev-latest",
    HIVE_ROUTER_DECISION_MODE: "off",
    HIVE_ROUTER_DECISION_TIMEOUT_MS: 10_000,
    OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
    PROMETHEUS_PREFIX: 'hive_router_test_',
    DEFAULT_TRACE_RETENTION_DAYS: 7,
    MAX_REQUEST_BODY_BYTES: 64 * 1024 * 1024,
    MAX_ADMIN_BODY_BYTES: 2 * 1024 * 1024,
    MAX_TRACE_BODY_BYTES: 1024 * 1024,
    CAPTURE_BINARY_MEDIA: false,
    CAPTURE_REQUEST_BODIES: true,
    CAPTURE_RESPONSE_BODIES: true,
    TLS_CERT_PATH: undefined,
    TLS_KEY_PATH: undefined,
  };
}

describe('security/iam-oidc', () => {
  beforeEach(async () => {
    server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', baseUrl);
      if (request.method === 'POST' && url.pathname === '/api/v1/auth/login') {
        const body = JSON.parse(await readBody(request)) as { username?: string; password?: string };
        if (body.username !== 'admin' || body.password !== 'correct-password') {
          json(response, 401, { error: 'INVALID_CREDENTIALS' });
          return;
        }
        json(response, 200, { accessToken: 'iam-login-access-token', expiresIn: 900 });
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
});
