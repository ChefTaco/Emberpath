import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatReport, runChecks } from '../../src/commands/check.js';
import { main } from '../../src/main.js';

const secret = 'test-secret-0123456789abcdef0123456789';

describe('hive-router check', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hive-router-check-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('passes a valid OS-mode configuration without creating anything', async () => {
    const report = await runChecks({
      source: { HIVE_ROUTER_SECRET: secret, HIVE_HOME: join(home, 'hive'), HIVE_ROUTER_ADMIN_USERS: 'admin' },
      platform: 'linux',
      isRoot: false,
      findExecutable: (command) => (command === 'pamtester' ? '/usr/bin/pamtester' : null),
    });

    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.name === 'auth-mode')?.status).toBe('ok');
    expect(existsSync(join(home, 'hive'))).toBe(false);
    expect(formatReport(report)).toMatch(/Configuration OK/u);
  });

  it('fails OS mode without pamtester and names the fix', async () => {
    const report = await runChecks({
      source: { HIVE_ROUTER_SECRET: secret, HIVE_HOME: home },
      platform: 'linux',
      isRoot: false,
      findExecutable: () => null,
    });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'auth-mode')).toMatchObject({ status: 'fail' });
    expect(report.checks.find((check) => check.name === 'auth-mode')?.message).toMatch(/pamtester/u);
  });

  it('requires a reachable IAM in iam-oidc mode but only warns for HiveMem', async () => {
    const probed: string[] = [];
    const report = await runChecks({
      source: {
        HIVE_ROUTER_SECRET: secret,
        HIVE_HOME: home,
        HIVE_ROUTER_AUTH_MODE: 'iam-oidc',
        HIVE_ROUTER_IAM_CLIENT_SECRET: 'iam-client-secret-0123456789abcdef',
        HIVE_IAM_INTERNAL_URL: 'http://127.0.0.1:4200',
        HIVEMEM_INTERNAL_URL: 'http://127.0.0.1:18790',
        HIVE_ROUTER_MEMORY_PROXY_TOKEN: 'memory-token-0123456789',
      },
      platform: 'linux',
      isRoot: false,
      probe: async (url) => {
        probed.push(url);
        throw new Error('connect ECONNREFUSED');
      },
    });

    expect(probed).toEqual(['http://127.0.0.1:4200/api/v1/health/ready', 'http://127.0.0.1:18790/v1/health/ready']);
    expect(report.checks.find((check) => check.name === 'iam')?.status).toBe('fail');
    expect(report.checks.find((check) => check.name === 'memory')?.status).toBe('warn');
    expect(report.ok).toBe(false);
  });

  it('reports which HiveMem credential is used and warns before a static token expires', async () => {
    const now = Date.parse('2026-11-20T00:00:00Z');
    const jwt = (exp: number) => ['{"alg":"HS256"}', JSON.stringify({ sub: 'fake-router', exp: Math.floor(exp / 1000) })].map((part) => Buffer.from(part).toString('base64url')).join('.') + '.fake-signature';
    const credential = async (extra: Record<string, string>) => (await runChecks({
      source: { HIVE_ROUTER_SECRET: secret, HIVE_HOME: home, HIVEMEM_INTERNAL_URL: 'http://127.0.0.1:18790', ...extra },
      findExecutable: () => '/usr/bin/pamtester',
      probe: async () => ({ ok: true, statusCode: 200 }),
      now: () => now,
    })).checks.find((check) => check.name === 'memory-token');
    expect(await credential({})).toMatchObject({ status: 'warn', message: expect.stringMatching(/EMBERPATH_HIVEMEM_CLIENT_ID/u) });
    expect(await credential({ HIVE_ROUTER_MEMORY_PROXY_TOKEN: jwt(now + 30 * 86_400_000) })).toMatchObject({ status: 'ok' });
    expect(await credential({ HIVE_ROUTER_MEMORY_PROXY_TOKEN: jwt(now + 3 * 86_400_000) })).toMatchObject({ status: 'warn', message: expect.stringMatching(/expires at 2026-11-23/u) });
    expect(await credential({ HIVE_ROUTER_MEMORY_PROXY_TOKEN: jwt(now - 1000) })).toMatchObject({ status: 'warn', message: expect.stringMatching(/expired at/u) });
    const renewing = await credential({ HIVE_ROUTER_MEMORY_PROXY_TOKEN: jwt(now - 1000), EMBERPATH_HIVEMEM_CLIENT_ID: 'fake-emberpath-hivemem', EMBERPATH_HIVEMEM_CLIENT_SECRET: 'fake-hivemem-client-secret-0123456789abcdef' });
    expect(renewing).toMatchObject({ status: 'ok', message: expect.stringMatching(/self-renewing/u) });
    expect(JSON.stringify(renewing)).not.toContain('fake-hivemem-client-secret');
  });

  it('requires the HiveMem client ID and secret together, and HTTPS for the token endpoint in production', async () => {
    const report = await runChecks({ source: { HIVE_ROUTER_SECRET: secret, HIVE_HOME: home, EMBERPATH_HIVEMEM_CLIENT_ID: 'fake-emberpath-hivemem' } });
    expect(report.ok).toBe(false);
    expect(report.checks.map((check) => check.message).join('\n')).toMatch(/EMBERPATH_HIVEMEM_CLIENT_SECRET is not set/u);
    const production = await runChecks({ source: { HIVE_ROUTER_SECRET: secret, HIVE_HOME: home, NODE_ENV: 'production', EMBERPATH_HIVEMEM_CLIENT_ID: 'fake-emberpath-hivemem', EMBERPATH_HIVEMEM_CLIENT_SECRET: 'fake-hivemem-client-secret-0123456789abcdef', HIVE_IAM_INTERNAL_URL: 'http://oathweave.example.com:4200' } });
    expect(production.checks.map((check) => check.message).join('\n')).toMatch(/EMBERPATH_HIVEMEM_TOKEN_URL must use HTTPS/u);
    expect(JSON.stringify(production)).not.toContain('fake-hivemem-client-secret');
  });

  it('reports configuration errors as failures', async () => {
    const report = await runChecks({ source: { HIVE_HOME: home } });
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.message).toMatch(/HIVE_ROUTER_SECRET/u);
  });

  it.each([200, 503, 'network'])('omits URL credentials from dependency reports for %s', async (outcome) => {
    const report = await runChecks({
      source: { HIVE_ROUTER_SECRET: secret, HIVE_HOME: home, HIVEMEM_INTERNAL_URL: 'http://dummy-user:dummy-password@memory.example.com?key=dummy-query#dummy-fragment' },
      findExecutable: () => '/usr/bin/pamtester',
      probe: async () => {
        if (outcome === 'network') throw new Error('dummy-private-error');
        return { ok: outcome === 200, statusCode: Number(outcome) };
      },
    });
    expect(report.checks.find((check) => check.name === 'memory')).toBeDefined();
    expect(JSON.stringify(report)).not.toMatch(/dummy-(?:user|password|query|fragment|private-error)/);
  });
});

describe('hive-router CLI', () => {
  let output: string[];
  let errors: string[];

  beforeEach(() => {
    output = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
    vi.spyOn(console, 'error').mockImplementation((value: unknown) => { errors.push(String(value)); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the version and help', async () => {
    expect(await main(['--version'])).toBe(0);
    expect(output[0]).toBe(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
    expect(await main(['--help'])).toBe(0);
    expect(output[1]).toMatch(/hive-router check/u);
  });

  it('prints the env schema as JSON', async () => {
    expect(await main(['env-schema'])).toBe(0);
    const document = JSON.parse(output.join('\n')) as { service: string; env: unknown[] };
    expect(document.service).toBe('router');
    expect(document.env.length).toBeGreaterThan(10);
  });

  it('rejects unknown commands and options with one line', async () => {
    expect(await main(['launch'])).toBe(1);
    expect(await main(['--bogus'])).toBe(1);
    expect(await main(['--env-file'])).toBe(1);
    expect(errors).toHaveLength(3);
    expect(errors.every((line) => line.startsWith('hive-router: '))).toBe(true);
  });

  it('loads --env-file without overriding the existing environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-router-envfile-'));
    try {
      const file = join(dir, 'router.env');
      writeFileSync(file, 'HIVE_ROUTER_TEST_FROM_FILE=file\nHIVE_ROUTER_TEST_PRESET=file\n');
      process.env['HIVE_ROUTER_TEST_PRESET'] = 'environment';
      expect(await main(['env-schema', '--env-file', file])).toBe(0);
      expect(process.env['HIVE_ROUTER_TEST_FROM_FILE']).toBe('file');
      expect(process.env['HIVE_ROUTER_TEST_PRESET']).toBe('environment');
    } finally {
      delete process.env['HIVE_ROUTER_TEST_FROM_FILE'];
      delete process.env['HIVE_ROUTER_TEST_PRESET'];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
