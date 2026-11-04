import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHiveStatus } from '../../src/admin/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/storage/client.js';
import * as serviceHealth from '../../src/status/service-health.js';
import * as tlsCertificate from '../../src/status/tls-certificate.js';
import {
  recordSecurityExporterJwksRefresh,
  resetSecurityExporterJwksStatusForTests,
} from '../../src/security/security-exporter-jwks-status.js';

describe('Hive console Router status', () => {
  beforeEach(() => {
    resetSecurityExporterJwksStatusForTests();
    vi.spyOn(prisma.provider, 'count').mockResolvedValue(1);
    vi.spyOn(prisma.routeRule, 'count').mockResolvedValue(0);
    vi.spyOn(prisma.trace, 'count').mockResolvedValue(0);
    vi.spyOn(prisma.traceEvent, 'count').mockResolvedValue(0);
    vi.spyOn(tlsCertificate, 'inspectTlsCertificate').mockReturnValue({
      status: 'pass', message: 'valid test certificate',
    } as ReturnType<typeof tlsCertificate.inspectTlsCertificate>);
    vi.spyOn(serviceHealth, 'requestIamHealth').mockResolvedValue({ ok: false, statusCode: 503, payload: null });
    vi.spyOn(serviceHealth, 'requestMemoryHealth').mockResolvedValue({ ok: false, statusCode: 503, payload: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSecurityExporterJwksStatusForTests();
  });

  async function routerStatus() {
    const status = await buildHiveStatus(loadEnv());
    return status.apps.find((app) => app.key === 'router')!;
  }

  it('keeps a fresh Router online before the optional exporter first loads keys', async () => {
    const router = await routerStatus();
    expect(router.status).toBe('online');
    expect(router.checks.find((check) => check.name === 'security-exporter-jwks')).toMatchObject({
      status: 'warn', message: 'not cached yet; first exporter request will load IAM keys',
    });
    expect(router.details?.securityExporterJwks).toMatchObject({ state: 'uninitialized' });
  });

  it.each([
    [0.1, 'online', 'pass'],
    [0.6, 'degraded', 'warn'],
    [0.9, 'degraded', 'warn'],
    [1.1, 'degraded', 'fail'],
  ])('preserves key lifetime alerts at age fraction %s', async (fraction, status, checkStatus) => {
    const env = loadEnv();
    recordSecurityExporterJwksRefresh(Date.now() - env.HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS * fraction, 1);
    const router = await routerStatus();
    expect(router.status).toBe(status);
    expect(router.checks.find((check) => check.name === 'security-exporter-jwks')?.status).toBe(checkStatus);
  });

  it('still reports trace failures when exporter keys have not been loaded', async () => {
    vi.mocked(prisma.trace.count).mockResolvedValue(1);
    expect((await routerStatus()).status).toBe('degraded');
  });

  it('still reports certificate problems when exporter keys have not been loaded', async () => {
    vi.mocked(tlsCertificate.inspectTlsCertificate).mockReturnValue({
      status: 'fail', message: 'expired test certificate',
    } as ReturnType<typeof tlsCertificate.inspectTlsCertificate>);
    expect((await routerStatus()).status).toBe('degraded');
  });
});
