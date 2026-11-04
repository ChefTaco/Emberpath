import { describe, expect, it } from 'vitest';
import { ConfigError, inspectEnv, parseEnv, envSchema } from '../../src/config/env.js';
import { buildEnvSchemaDocument, routerEnvCatalog } from '../../src/config/env-catalog.js';

const secret = 'test-secret-0123456789abcdef0123456789';

describe('environment defaults for a fresh install', () => {
  it('uses unprivileged ports and keeps state under HIVE_HOME/router', () => {
    const env = parseEnv({ HIVE_ROUTER_SECRET: secret, HIVE_HOME: '/srv/hive-home' });

    expect(env.API_PORT).toBe(4020);
    expect(env.ADMIN_PORT).toBe(9443);
    expect(env.DATA_DIR).toBe('/srv/hive-home/router');
    expect(env.DATABASE_URL).toBe('file:/srv/hive-home/router/router.db');
    expect(env.TRACE_DIR).toBe('/srv/hive-home/router/traces');
    expect(env.PUBLIC_API_URL).toBe('http://localhost:4020');
    expect(env.PUBLIC_ADMIN_URL).toBe('http://localhost:9443');
    expect(env.HIVE_UI_PUBLIC_URL).toBe('http://localhost:9443');
    expect(env.HIVE_IAM_PUBLIC_URL).toBe('http://localhost:9443/iam');
    expect(env.HIVE_ROUTER_IAM_REDIRECT_URI).toBe('http://localhost:9443/api/auth/oidc/callback');
  });

  it('keeps explicit deployment values unchanged', () => {
    const env = parseEnv({
      HIVE_ROUTER_SECRET: secret,
      API_PORT: '4020',
      ADMIN_PORT: '443',
      PUBLIC_API_URL: 'https://hive.example.com:4020',
      PUBLIC_ADMIN_URL: 'https://hive.example.com',
      HIVEMEM_PUBLIC_URL: 'https://memory.example.com',
      DATABASE_URL: 'file:/opt/hive-router/shared/data/router.db',
      DATA_DIR: '/opt/hive-router/shared/data',
      TRACE_DIR: '/opt/hive-router/shared/data/traces',
    });

    expect(env.ADMIN_PORT).toBe(443);
    expect(env.PUBLIC_API_URL).toBe('https://hive.example.com:4020');
    expect(env.HIVE_UI_PUBLIC_URL).toBe('https://hive.example.com');
    expect(env.HIVE_IAM_PUBLIC_URL).toBe('https://hive.example.com/iam');
    expect(env.HIVEMEM_PUBLIC_URL).toBe('https://memory.example.com');
    expect(env.DATABASE_URL).toBe('file:/opt/hive-router/shared/data/router.db');
    expect(env.TRACE_DIR).toBe('/opt/hive-router/shared/data/traces');
  });

  it('derives DATABASE_URL and TRACE_DIR from an explicit DATA_DIR', () => {
    const env = parseEnv({ HIVE_ROUTER_SECRET: secret, DATA_DIR: '/var/lib/hive-router' });
    expect(env.DATABASE_URL).toBe('file:/var/lib/hive-router/router.db');
    expect(env.TRACE_DIR).toBe('/var/lib/hive-router/traces');
  });
});

describe('configuration errors', () => {
  it('names the missing secret and how to create one, on a single line', () => {
    const { env, problems } = inspectEnv({});
    expect(env).toBeNull();
    expect(problems).toHaveLength(1);
    expect(problems[0]?.variable).toBe('HIVE_ROUTER_SECRET');
    expect(problems[0]?.message).toMatch(/^HIVE_ROUTER_SECRET is not set\..*openssl rand -hex 32/u);
    expect(problems[0]?.message).not.toContain('\n');
  });

  it('reports a short secret without echoing it', () => {
    const { problems } = inspectEnv({ HIVE_ROUTER_SECRET: 'short-value' });
    expect(problems[0]?.message).toMatch(/too short \(11 characters\)/u);
    expect(problems[0]?.message).not.toContain('short-value');
  });

  it('explains how to fix production without TLS', () => {
    expect(() => parseEnv({ HIVE_ROUTER_SECRET: secret, NODE_ENV: 'production' })).toThrow(ConfigError);
    const { problems } = inspectEnv({ HIVE_ROUTER_SECRET: secret, NODE_ENV: 'production' });
    expect(problems.map((problem) => problem.variable)).toEqual(['TLS_CERT_PATH']);
    expect(problems[0]?.message).toMatch(/NODE_ENV=production.*TLS_CERT_PATH and TLS_KEY_PATH.*openssl req -x509/u);
  });

  it('rejects half a TLS configuration and missing files', () => {
    const { problems } = inspectEnv({ HIVE_ROUTER_SECRET: secret, TLS_CERT_PATH: '/nonexistent/server.crt' });
    expect(problems.map((problem) => problem.variable)).toEqual(['TLS_KEY_PATH', 'TLS_CERT_PATH']);
  });

  it('reports invalid ports by name', () => {
    const { problems } = inspectEnv({ HIVE_ROUTER_SECRET: secret, ADMIN_PORT: '70000' });
    expect(problems[0]?.message).toMatch(/^ADMIN_PORT must be a TCP port between 1 and 65535 \(got "70000"\)/u);
  });
});

describe('env-schema document', () => {
  it('describes the service for launchers', () => {
    const document = buildEnvSchemaDocument();
    expect(document).toMatchObject({
      service: 'router',
      package: '@hivemagnus/emberpath',
      defaultPort: 4020,
      adminPort: 9443,
      healthPath: '/health',
    });
    expect(document.dependencies.map((dependency) => dependency.service)).toEqual(['iam', 'memory']);
    expect(document.env.filter((entry) => entry.required).map((entry) => entry.name)).toEqual(['HIVE_ROUTER_SECRET']);
    expect(document.env.find((entry) => entry.name === 'HIVE_ROUTER_SECRET')).toMatchObject({ secret: true, generate: 'hex32' });
  });

  it('only lists variables the Router actually reads', () => {
    const known = new Set(Object.keys(envSchema.in.shape));
    const unknown = routerEnvCatalog.map((entry) => entry.name).filter((name) => !known.has(name));
    expect(unknown).toEqual([]);
    for (const dependency of buildEnvSchemaDocument().dependencies) {
      expect(dependency.env.filter((name) => !known.has(name))).toEqual([]);
      for (const shared of [...dependency.sharedSecrets, ...dependency.issuedTokens]) {
        expect(dependency.env).toContain(shared.name);
      }
    }
  });

  it('describes the HiveMem proxy token as minted by hivemem-server issue-token', () => {
    const memory = buildEnvSchemaDocument().dependencies.find((dependency) => dependency.service === 'memory');
    expect(memory?.sharedSecrets).toEqual([]);
    expect(memory?.issuedTokens).toEqual([
      expect.objectContaining({
        name: 'HIVE_ROUTER_MEMORY_PROXY_TOKEN',
        command: 'hivemem-server issue-token',
        args: ['--subject', 'hive-router', '--role', 'admin'],
        signedWith: 'HIVEMEM_JWT_SECRET',
      }),
    ]);
    const iam = buildEnvSchemaDocument().dependencies.find((dependency) => dependency.service === 'iam');
    expect(iam?.sharedSecrets).toEqual([{ name: 'HIVE_ROUTER_IAM_CLIENT_SECRET', peerEnv: 'SEED_HIVE_ROUTER_CLIENT_SECRET' }]);
  });
});
