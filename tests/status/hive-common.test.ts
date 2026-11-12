import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RouterDependencyReport } from '../../src/status/router-health.js';

const state = vi.hoisted(() => ({ report: undefined as unknown as RouterDependencyReport }));
vi.mock('../../src/status/router-health.js', () => ({ buildRouterDependencyReport: async () => state.report }));

import { createApiApp } from '../../src/api/app.js';
import { createAdminApp } from '../../src/admin/app.js';
import { log } from '../../src/telemetry/logger.js';
import { requestIdMiddleware } from '../../src/utils/request.js';
import { Hono } from 'hono';
import type { AppVariables } from '../../src/types/app.js';

function report(overrides: Partial<RouterDependencyReport> = {}, providers = { status: 'pass' as const }): RouterDependencyReport {
  return {
    version: '0.0.0-test',
    release: 'test',
    protocol: 1,
    status: 'ready',
    checks: [
      { name: 'sqlite', status: 'pass', message: 'connected' },
      { name: 'providers', message: '1/1 enabled providers healthy', ...providers },
      { name: 'security-exporter-jwks', status: 'warn', message: 'not cached yet' },
    ],
    providers: { configured: 1, healthy: 1, checked: true },
    ...overrides,
  };
}

const apps = () => [['api', createApiApp()], ['admin', createAdminApp()]] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

afterEach(() => vi.restoreAllMocks());

describe('suite health probes', () => {
  it('serves /health/live and /health/ready in the suite format on both planes', async () => {
    state.report = report();
    for (const [plane, app] of apps()) {
      const live = await app.request('/health/live');
      expect(live.status, plane).toBe(200);
      expect(live.headers.get('cache-control')).toBe('no-store');
      expect(await live.json()).toMatchObject({ status: 'live', service: 'emberpath' });
      const ready = await app.request('/health/ready');
      expect(ready.status, plane).toBe(200);
      expect(await ready.json()).toMatchObject({
        status: 'ready',
        service: 'emberpath',
        checks: {
          database: { status: 'up', critical: true },
          providers: { status: 'up', critical: true, details: { configured: 1, healthy: 1, checked: true } },
          'security-exporter-jwks': { status: 'up', critical: false },
        },
      });
    }
  });

  it('keeps the readiness status codes: 503 when the database or every provider is down', async () => {
    for (const next of [
      report({ status: 'degraded', checks: [{ name: 'sqlite', status: 'fail', message: 'synthetic failure' }] }),
      report({ status: 'degraded' }, { status: 'fail' as never }),
    ]) {
      state.report = next;
      for (const [plane, app] of apps()) {
        const ready = await app.request('/health/ready');
        expect(ready.status, plane).toBe(503);
        const body = await ready.json();
        expect(body.status).toBe('not_ready');
        expect(JSON.stringify(body)).not.toContain('synthetic failure');
      }
    }
  });

  it('keeps the legacy health paths and their report bodies', async () => {
    state.report = report({ status: 'degraded' });
    for (const [plane, app] of apps()) {
      const health = await app.request('/health');
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: 'ok', plane });
      const dependencies = await app.request('/health/dependencies');
      expect(dependencies.status).toBe(503);
      expect(await dependencies.json()).toEqual(state.report);
    }
    const ready = await createAdminApp().request('/ready');
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual(state.report);
  });
});

describe('request context', () => {
  const inbound = {
    'x-request-id': 'caller-chosen-id',
    'x-hive-request-id': 'caller-chosen-hive-id',
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  };

  it('accepts a safe inbound request ID on the admin plane', async () => {
    state.report = report();
    const response = await createAdminApp().request('/health/live', { headers: inbound });
    expect(response.headers.get('x-request-id')).toBe('caller-chosen-id');
    expect(response.headers.get('x-hive-request-id')).toBe('caller-chosen-id');
    const unsafe = await createAdminApp().request('/health/live', { headers: { 'x-request-id': 'bad id with spaces' } });
    expect(unsafe.headers.get('x-request-id')).toMatch(uuid);
  });

  it('never lets inference callers choose the request ID', async () => {
    const app = createApiApp();
    for (const path of ['/health/live', '/v1/models']) {
      const first = await app.request(path, { headers: inbound });
      const second = await app.request(path, { headers: inbound });
      for (const response of [first, second]) {
        expect(response.headers.get('x-request-id')).toMatch(uuid);
        expect(response.headers.get('x-hive-request-id')).toBe(response.headers.get('x-request-id'));
      }
      expect(first.headers.get('x-request-id')).not.toBe(second.headers.get('x-request-id'));
    }
    // The inference error body is unchanged.
    const unauthorized = await app.request('/v1/models', { headers: inbound });
    expect(unauthorized.status).toBe(401);
    expect(Object.keys(await unauthorized.json())).toEqual(['error']);
  });

  it('adds the request ID to log lines written while serving a request', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => { lines.push(line); });
    const app = new Hono<{ Variables: AppVariables }>();
    app.use('*', requestIdMiddleware({ trustInbound: true }));
    app.get('/probe', (c) => {
      log('error', 'synthetic line');
      log('error', 'explicit line', { requestId: 'explicit-id' });
      return c.body(null, 204);
    });
    await app.request('/probe', { headers: { 'x-request-id': 'logged-id' } });
    log('error', 'outside a request');
    expect(lines.map((line) => JSON.parse(line).requestId)).toEqual(['logged-id', 'explicit-id', undefined]);
  });
});
