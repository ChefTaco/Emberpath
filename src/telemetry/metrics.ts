import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { loadEnv } from '../config/env.js';
import {
  getSecurityExporterJwksStatus,
  type SecurityExporterJwksLifetimeState,
} from '../security/security-exporter-jwks-status.js';

const metricsEnv = loadEnv();
const prefix = metricsEnv.PROMETHEUS_PREFIX;
export const metricsRegistry = new Registry();
collectDefaultMetrics({ prefix, register: metricsRegistry });

export const requestCounter = new Counter({
  name: `${prefix}requests_total`,
  help: 'Total inbound requests',
  labelNames: ['plane', 'route', 'method', 'status', 'provider', 'outcome'] as const,
  registers: [metricsRegistry],
});

export const requestDuration = new Histogram({
  name: `${prefix}request_duration_ms`,
  help: 'Request duration in milliseconds',
  labelNames: ['plane', 'route', 'method', 'provider'] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [metricsRegistry],
});

export const streamFirstByteDuration = new Histogram({
  name: `${prefix}stream_first_byte_ms`,
  help: 'Duration until first streamed byte',
  labelNames: ['route', 'provider'] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [metricsRegistry],
});

export const providerHealthGauge = new Gauge({
  name: `${prefix}provider_health`,
  help: 'Provider health state (1=healthy, 0=unhealthy)',
  labelNames: ['provider', 'kind'] as const,
  registers: [metricsRegistry],
});

export const failoverCounter = new Counter({
  name: `${prefix}failovers_total`,
  help: 'Number of failover attempts',
  labelNames: ['route', 'from_provider', 'to_provider'] as const,
  registers: [metricsRegistry],
});

export const streamFailureCounter = new Counter({
  name: `${prefix}stream_failures_total`,
  help: 'Streaming responses that failed, labeled by failure phase',
  labelNames: ['route', 'provider', 'phase'] as const,
  registers: [metricsRegistry],
});

export const heuristicCounter = new Counter({
  name: `${prefix}heuristics_total`,
  help: 'Triggered heuristic observations',
  labelNames: ['name', 'category', 'action'] as const,
  registers: [metricsRegistry],
});

let securityExporterJwksRefreshedAt = 0;

export const securityExporterAuthCounter = new Counter({
  name: `${prefix}security_exporter_auth_total`,
  help: 'Security exporter authorization outcomes and credential methods',
  labelNames: ['method', 'outcome'] as const,
  registers: [metricsRegistry],
});

export const securityExporterJwksRefreshAge = new Gauge({
  name: `${prefix}security_exporter_jwks_refresh_age_seconds`,
  help: 'Age in seconds of the currently cached Security exporter JWKS',
  registers: [metricsRegistry],
  collect() {
    this.set(securityExporterJwksRefreshedAt
      ? Math.max(0, (Date.now() - securityExporterJwksRefreshedAt) / 1_000)
      : -1);
  },
});

export const securityExporterJwksRefreshFailures = new Counter({
  name: `${prefix}security_exporter_jwks_refresh_failures_total`,
  help: 'Failed Security exporter JWKS refreshes',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

export const securityExporterJwksRemainingLifetime = new Gauge({
  name: `${prefix}security_exporter_jwks_remaining_lifetime_seconds`,
  help: 'Seconds remaining before the trusted Security exporter JWKS fails closed',
  registers: [metricsRegistry],
  collect() {
    this.set(getSecurityExporterJwksStatus(
      metricsEnv.HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS,
    ).remainingMs / 1_000);
  },
});

const jwksLifetimeStates: SecurityExporterJwksLifetimeState[] = [
  'uninitialized',
  'healthy',
  'warning',
  'critical',
  'expired',
];

export const securityExporterJwksLifetimeState = new Gauge({
  name: `${prefix}security_exporter_jwks_lifetime_state`,
  help: 'Current trusted JWKS lifetime state (1=current state, 0=other states)',
  labelNames: ['state'] as const,
  registers: [metricsRegistry],
  collect() {
    const current = getSecurityExporterJwksStatus(
      metricsEnv.HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS,
    ).state;
    for (const state of jwksLifetimeStates) this.set({ state }, state === current ? 1 : 0);
  },
});

export const securityExporterTrustedKeys = new Gauge({
  name: `${prefix}security_exporter_jwks_trusted_key`,
  help: 'Currently trusted bounded JWKS key IDs (1=trusted)',
  labelNames: ['kid'] as const,
  registers: [metricsRegistry],
});

export const securityExporterRejectedRotations = new Counter({
  name: `${prefix}security_exporter_jwks_rejected_rotations_total`,
  help: 'Rejected JWKS refresh or rotation responses',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

export function reportSecurityExporterTrustedKeys(refreshedAt: number, keyIds: string[]): void {
  securityExporterJwksRefreshedAt = refreshedAt;
  securityExporterTrustedKeys.reset();
  for (const kid of keyIds) securityExporterTrustedKeys.set({ kid }, 1);
}
