import type { Context, Env, Hono } from 'hono';
import { liveness, readiness, type HealthCheck, type HealthResponse } from '@hivemagnus/hive-common/health';
import { metadata } from '../release/runtime.js';
import { packageRoot } from '../config/paths.js';
import { loadEnv } from '../config/env.js';
import { getSecurityExporterJwksStatus } from '../security/security-exporter-jwks-status.js';
import { buildRouterDependencyReport, type RouterDependencyReport } from './router-health.js';

/** Health checks over one dependency report, so each probe runs the provider sweep once. */
export function readinessChecks(report: RouterDependencyReport): HealthCheck[] {
  const byName = new Map(report.checks.map((check) => [check.name, check]));
  return [
    // Readiness has always meant: the database answers, and an enabled provider is healthy
    // (unless none is configured, or this is an isolated restore rehearsal).
    { name: 'database', check: () => byName.get('sqlite')?.status === 'pass' },
    {
      name: 'providers',
      check: () => ({ ok: byName.get('providers')?.status !== 'fail', details: { ...report.providers } }),
    },
    {
      // Informational, as before: keys not yet fetched is normal until the first export.
      name: 'security-exporter-jwks',
      critical: false,
      check: () => {
        const { state } = getSecurityExporterJwksStatus(loadEnv().HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS);
        return { ok: state === 'healthy' || state === 'uninitialized', details: { state } };
      },
    },
  ];
}

// Through the context, so headers set by earlier middleware (the request ID) are kept.
// Hono answers HEAD from these GET routes without the body.
function respond(context: Context, result: HealthResponse<unknown>): Response {
  return context.body(JSON.stringify(result.body), result.status, { ...result.headers });
}

/**
 * The suite-standard `/health/live` and `/health/ready` probes. `/health`, `/ready` and
 * `/health/dependencies` keep their existing Emberpath report bodies.
 */
export function registerHealthProbes<E extends Env>(app: Hono<E>): void {
  const identity = () => ({ service: 'emberpath', version: metadata(packageRoot).version });
  app.get('/health/live', (context) => respond(context, liveness(identity())));
  app.get('/health/ready', async (context) => {
    const report = await buildRouterDependencyReport();
    return respond(context, await readiness({ ...identity(), checks: readinessChecks(report) }));
  });
}
