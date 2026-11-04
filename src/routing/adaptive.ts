import { prisma } from '../storage/client.js';
import { safeJsonParse } from '../utils/json.js';

/**
 * Adaptive routing lets the router learn from its own telemetry. It computes a
 * rolling success rate and average latency per provider from recent traces and
 * turns them into an optional score adjustment used when ranking candidate
 * providers. It is disabled by default and configured through the
 * `routing.adaptive` runtime setting so operators keep full control.
 */
export interface AdaptiveRoutingConfig {
  /** When false, adaptive scoring contributes nothing. */
  enabled: boolean;
  /** Overall multiplier applied to the computed adjustment. */
  weight: number;
  /** Rolling window, in minutes, of traces to consider. */
  windowMinutes: number;
  /** Minimum trace samples before a provider's stats are trusted. */
  minSamples: number;
  /** Latency (ms) at which the latency component contributes zero. */
  latencyTargetMs: number;
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveRoutingConfig = {
  enabled: false,
  weight: 1,
  windowMinutes: 60,
  minSamples: 5,
  latencyTargetMs: 4000,
};

export const ADAPTIVE_SETTING_KEY = 'routing.adaptive';

export interface ProviderTraceSample {
  providerId: string | null;
  outcome: string;
  durationMs: number | null;
  totalTokens?: number | null;
}

export interface ProviderStats {
  providerId: string;
  samples: number;
  successRate: number;
  avgLatencyMs: number;
  avgTotalTokens: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Aggregate raw trace samples into per-provider rolling statistics. */
export function computeProviderStats(samples: ProviderTraceSample[]): Map<string, ProviderStats> {
  const accumulator = new Map<
    string,
    { samples: number; successes: number; latencyTotal: number; latencyCount: number; tokenTotal: number; tokenCount: number }
  >();

  for (const sample of samples) {
    if (!sample.providerId) {
      continue;
    }
    // DENIED requests never reach a provider, so they do not inform provider quality.
    if (sample.outcome === 'DENIED') {
      continue;
    }

    const entry = accumulator.get(sample.providerId) ?? {
      samples: 0,
      successes: 0,
      latencyTotal: 0,
      latencyCount: 0,
      tokenTotal: 0,
      tokenCount: 0,
    };
    entry.samples += 1;
    if (sample.outcome === 'SUCCEEDED') {
      entry.successes += 1;
    }
    if (typeof sample.durationMs === 'number' && Number.isFinite(sample.durationMs)) {
      entry.latencyTotal += sample.durationMs;
      entry.latencyCount += 1;
    }
    if (typeof sample.totalTokens === 'number' && Number.isFinite(sample.totalTokens)) {
      entry.tokenTotal += sample.totalTokens;
      entry.tokenCount += 1;
    }
    accumulator.set(sample.providerId, entry);
  }

  const stats = new Map<string, ProviderStats>();
  for (const [providerId, entry] of accumulator) {
    stats.set(providerId, {
      providerId,
      samples: entry.samples,
      successRate: entry.samples > 0 ? entry.successes / entry.samples : 0,
      avgLatencyMs: entry.latencyCount > 0 ? entry.latencyTotal / entry.latencyCount : 0,
      avgTotalTokens: entry.tokenCount > 0 ? entry.tokenTotal / entry.tokenCount : 0,
    });
  }
  return stats;
}

/**
 * Turn provider statistics into a score adjustment. Higher success rates and
 * lower latencies produce a positive adjustment; failing or slow providers get
 * a negative one. Providers below `minSamples` are left neutral so cold starts
 * do not distort routing.
 */
export function computeAdaptiveScores(
  stats: Map<string, ProviderStats>,
  config: AdaptiveRoutingConfig,
): Map<string, number> {
  const scores = new Map<string, number>();
  if (!config.enabled) {
    return scores;
  }

  for (const stat of stats.values()) {
    if (stat.samples < config.minSamples) {
      continue;
    }
    // Success component: -50 (always fails) .. +50 (always succeeds).
    const successScore = (stat.successRate - 0.5) * 100;
    // Latency component: +40 (instant) .. -40 (>= 2x target). Neutral at target.
    const latencyRatio = config.latencyTargetMs > 0
      ? (config.latencyTargetMs - stat.avgLatencyMs) / config.latencyTargetMs
      : 0;
    const latencyScore = clamp(latencyRatio, -1, 1) * 40;
    const adjustment = (successScore + latencyScore) * config.weight;
    scores.set(stat.providerId, Math.round(adjustment * 100) / 100);
  }

  return scores;
}

function parseTotalTokens(usageJson: string | null): number | null {
  if (!usageJson) {
    return null;
  }
  const usage = safeJsonParse<{ totalTokens?: number; total_tokens?: number }>(usageJson, {});
  const total = usage.totalTokens ?? usage.total_tokens;
  return typeof total === 'number' ? total : null;
}

export async function loadAdaptiveRoutingConfig(): Promise<AdaptiveRoutingConfig> {
  const setting = await prisma.runtimeSetting.findUnique({ where: { key: ADAPTIVE_SETTING_KEY } });
  if (!setting) {
    return DEFAULT_ADAPTIVE_CONFIG;
  }
  const parsed = safeJsonParse<Partial<AdaptiveRoutingConfig>>(setting.valueJson, {});
  return {
    enabled: parsed.enabled ?? false,
    weight: typeof parsed.weight === 'number' && parsed.weight >= 0 ? parsed.weight : DEFAULT_ADAPTIVE_CONFIG.weight,
    windowMinutes:
      typeof parsed.windowMinutes === 'number' && parsed.windowMinutes > 0
        ? parsed.windowMinutes
        : DEFAULT_ADAPTIVE_CONFIG.windowMinutes,
    minSamples:
      typeof parsed.minSamples === 'number' && parsed.minSamples >= 0
        ? parsed.minSamples
        : DEFAULT_ADAPTIVE_CONFIG.minSamples,
    latencyTargetMs:
      typeof parsed.latencyTargetMs === 'number' && parsed.latencyTargetMs > 0
        ? parsed.latencyTargetMs
        : DEFAULT_ADAPTIVE_CONFIG.latencyTargetMs,
  };
}

export async function loadProviderStats(windowMinutes: number): Promise<Map<string, ProviderStats>> {
  const since = new Date(Date.now() - windowMinutes * 60_000);
  const traces = await prisma.trace.findMany({
    where: { startedAt: { gte: since }, providerId: { not: null } },
    select: { providerId: true, outcome: true, durationMs: true, usageJson: true },
    take: 5000,
    orderBy: { startedAt: 'desc' },
  });
  const samples: ProviderTraceSample[] = traces.map((trace) => ({
    providerId: trace.providerId,
    outcome: trace.outcome,
    durationMs: trace.durationMs,
    totalTokens: parseTotalTokens(trace.usageJson),
  }));
  return computeProviderStats(samples);
}

export interface AdaptiveScoreResult {
  config: AdaptiveRoutingConfig;
  scores: Map<string, number>;
  stats: Map<string, ProviderStats>;
}

/**
 * Best-effort resolution of adaptive routing scores. Any telemetry failure
 * degrades gracefully to no adjustment so routing always proceeds.
 */
export async function resolveAdaptiveScores(): Promise<AdaptiveScoreResult> {
  try {
    const config = await loadAdaptiveRoutingConfig();
    if (!config.enabled) {
      return { config, scores: new Map(), stats: new Map() };
    }
    const stats = await loadProviderStats(config.windowMinutes);
    return { config, scores: computeAdaptiveScores(stats, config), stats };
  } catch {
    return { config: DEFAULT_ADAPTIVE_CONFIG, scores: new Map(), stats: new Map() };
  }
}
