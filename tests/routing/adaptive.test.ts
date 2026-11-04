import { describe, expect, it } from 'vitest';
import {
  computeAdaptiveScores,
  computeProviderStats,
  DEFAULT_ADAPTIVE_CONFIG,
  type ProviderTraceSample,
} from '../../src/routing/adaptive.js';

function sample(overrides: Partial<ProviderTraceSample> & { providerId: string }): ProviderTraceSample {
  return { outcome: 'SUCCEEDED', durationMs: 500, totalTokens: null, ...overrides };
}

describe('routing/adaptive computeProviderStats', () => {
  it('aggregates success rate, latency, and tokens per provider', () => {
    const stats = computeProviderStats([
      sample({ providerId: 'a', outcome: 'SUCCEEDED', durationMs: 100, totalTokens: 10 }),
      sample({ providerId: 'a', outcome: 'FAILED', durationMs: 300, totalTokens: 30 }),
      sample({ providerId: 'b', outcome: 'SUCCEEDED', durationMs: 1000 }),
    ]);

    const a = stats.get('a');
    expect(a?.samples).toBe(2);
    expect(a?.successRate).toBe(0.5);
    expect(a?.avgLatencyMs).toBe(200);
    expect(a?.avgTotalTokens).toBe(20);
    expect(stats.get('b')?.successRate).toBe(1);
  });

  it('excludes DENIED outcomes and null providers', () => {
    const stats = computeProviderStats([
      sample({ providerId: 'a', outcome: 'DENIED' }),
      { providerId: null, outcome: 'SUCCEEDED', durationMs: 100 },
      sample({ providerId: 'a', outcome: 'SUCCEEDED' }),
    ]);
    expect(stats.get('a')?.samples).toBe(1);
  });

  it('treats STREAM_FAILED as a failure', () => {
    const stats = computeProviderStats([
      sample({ providerId: 'a', outcome: 'STREAM_FAILED' }),
      sample({ providerId: 'a', outcome: 'SUCCEEDED' }),
    ]);
    expect(stats.get('a')?.successRate).toBe(0.5);
  });
});

describe('routing/adaptive computeAdaptiveScores', () => {
  const config = { ...DEFAULT_ADAPTIVE_CONFIG, enabled: true, minSamples: 3, latencyTargetMs: 4000 };

  it('returns no scores when disabled', () => {
    const stats = computeProviderStats([sample({ providerId: 'a' }), sample({ providerId: 'a' }), sample({ providerId: 'a' })]);
    expect(computeAdaptiveScores(stats, { ...config, enabled: false }).size).toBe(0);
  });

  it('rewards fast, reliable providers and penalizes slow, failing ones', () => {
    const fast = computeProviderStats(
      Array.from({ length: 5 }, () => sample({ providerId: 'fast', outcome: 'SUCCEEDED', durationMs: 200 })),
    );
    const slow = computeProviderStats(
      Array.from({ length: 5 }, () => sample({ providerId: 'slow', outcome: 'FAILED', durationMs: 9000 })),
    );

    const fastScore = computeAdaptiveScores(fast, config).get('fast') ?? 0;
    const slowScore = computeAdaptiveScores(slow, config).get('slow') ?? 0;

    expect(fastScore).toBeGreaterThan(0);
    expect(slowScore).toBeLessThan(0);
    expect(fastScore).toBeGreaterThan(slowScore);
  });

  it('leaves providers below the minimum sample threshold neutral', () => {
    const stats = computeProviderStats([sample({ providerId: 'a' }), sample({ providerId: 'a' })]);
    expect(computeAdaptiveScores(stats, { ...config, minSamples: 5 }).has('a')).toBe(false);
  });

  it('scales the adjustment by the configured weight', () => {
    const stats = computeProviderStats(
      Array.from({ length: 5 }, () => sample({ providerId: 'a', outcome: 'SUCCEEDED', durationMs: 200 })),
    );
    const single = computeAdaptiveScores(stats, { ...config, weight: 1 }).get('a') ?? 0;
    const doubled = computeAdaptiveScores(stats, { ...config, weight: 2 }).get('a') ?? 0;
    expect(doubled).toBeCloseTo(single * 2, 1);
  });
});
