import { metadata } from '../release/runtime.js';
import { packageRoot } from '../config/paths.js';
import { prisma } from '../storage/client.js';
import { runProviderHealthSweep } from '../providers/health.js';
import { loadEnv } from '../config/env.js';
import { getSecurityExporterJwksStatus } from '../security/security-exporter-jwks-status.js';

export type RouterDependencyStatus = 'pass' | 'warn' | 'fail';
export type RouterReadinessStatus = 'ready' | 'degraded';

export interface RouterDependencyCheck {
  name: string;
  status: RouterDependencyStatus;
  message: string;
  latencyMs?: number;
}

export interface RouterDependencyReport {
  version: string;
  release: string;
  protocol: number;
  status: RouterReadinessStatus;
  checks: RouterDependencyCheck[];
  providers: {
    configured: number;
    healthy: number;
    checked: boolean;
  };
}

const PROVIDER_SWEEP_REUSE_MS = 5_000;
let recentSweep: { startedAt: number; result: ReturnType<typeof runProviderHealthSweep> } | undefined;

/**
 * One provider sweep serves every dependency report asked for within a few
 * seconds. The reports back unauthenticated health endpoints on both planes, and
 * each sweep calls every enabled provider and writes its health row, so a caller
 * polling `/health/ready` must not be able to multiply upstream traffic.
 */
function sharedProviderHealthSweep(): ReturnType<typeof runProviderHealthSweep> {
  const now = Date.now();
  if (recentSweep && now - recentSweep.startedAt < PROVIDER_SWEEP_REUSE_MS && now >= recentSweep.startedAt) {
    return recentSweep.result;
  }
  const result = runProviderHealthSweep();
  const sweep = { startedAt: now, result };
  recentSweep = sweep;
  result.catch(() => {
    if (recentSweep === sweep) recentSweep = undefined;
  });
  return result;
}

export function resetProviderHealthSweepReuse(): void {
  recentSweep = undefined;
}

async function timedCheck(name: string, operation: () => Promise<string>): Promise<RouterDependencyCheck> {
  const startedAt = performance.now();
  try {
    const message = await operation();
    return {
      name,
      status: 'pass',
      message,
      latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  } catch (error) {
    return {
      name,
      status: 'fail',
      message: error instanceof Error ? error.message : 'failed',
      latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  }
}

export async function buildRouterDependencyReport(): Promise<RouterDependencyReport> {
  const env = loadEnv();
  const databaseCheck = await timedCheck('sqlite', async () => {
    await prisma.$queryRawUnsafe('SELECT 1');
    return 'connected';
  });

  const providerHealth = await sharedProviderHealthSweep();
  const configured = await prisma.provider.count({ where: { enabled: true } });
  const healthy = providerHealth.filter((entry) => entry.healthy).length;
  const providerCheck: RouterDependencyCheck = configured === 0
    ? { name: 'providers', status: 'warn', message: 'no enabled providers configured' }
    : env.HIVE_REHEARSAL
      ? { name: 'providers', status: 'warn', message: 'External providers are not checked during isolated restore rehearsal' }
      : { name: 'providers', status: healthy > 0 ? 'pass' : 'fail', message: healthy + '/' + configured + ' enabled providers healthy' };

  const jwks = getSecurityExporterJwksStatus(env.HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS);
  const jwksCheck: RouterDependencyCheck = {
    name: 'security-exporter-jwks',
    status: jwks.state === 'healthy' ? 'pass' : 'warn',
    message: jwks.state === 'uninitialized'
      ? 'not cached yet; first exporter request will load IAM keys'
      : `${Math.ceil(jwks.remainingMs / 1_000)}s trusted-key lifetime remaining (${jwks.state})`,
  };
  const checks = [databaseCheck, providerCheck, jwksCheck];
  const ready = databaseCheck.status === 'pass' && (env.HIVE_REHEARSAL || configured === 0 || healthy > 0);

  return {
    ...metadata(packageRoot),
    status: ready ? 'ready' : 'degraded',
    checks,
    providers: { configured, healthy, checked: !env.HIVE_REHEARSAL },
  };
}
