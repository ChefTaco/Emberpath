import { ProviderKind, type Provider } from '../../src/generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import type { ProviderRuntime } from '../../src/providers/types.js';
import {
  computeObjectiveScore,
  parseRoutingObjectiveConfig,
  providerCostPerMillionTokens,
} from '../../src/routing/objective.js';

function buildProviderRecord(id: string): Provider {
  const now = new Date('2026-03-20T00:00:00.000Z');
  return {
    id,
    slug: id,
    name: id,
    kind: ProviderKind.OPENAI,
    baseUrl: `https://${id}.example.com`,
    authMode: 'BEARER',
    authHeaderName: 'Authorization',
    encryptedAuthSecret: null,
    defaultHeadersJson: '{}',
    capabilityJson: '{}',
    passthroughJson: '[]',
    tlsInsecure: false,
    timeoutMs: 120000,
    maxRetries: 1,
    concurrency: 16,
    priority: 100,
    weight: 100,
    failoverGroup: null,
    enabled: true,
    lastHealthStatus: null,
    lastHealthError: null,
    lastHealthAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function buildRuntime(id: string, overrides: Partial<ProviderRuntime['capabilities']>): ProviderRuntime {
  return {
    id,
    slug: id,
    name: id,
    kind: ProviderKind.OPENAI,
    baseUrl: `https://${id}.example.com`,
    authHeaderName: 'Authorization',
    authMode: 'BEARER',
    defaultHeaders: {},
    capabilities: {
      reasoning: true,
      tools: true,
      jsonSchema: true,
      vision: true,
      audio: false,
      video: false,
      embeddings: true,
      longContext: true,
      streaming: true,
      passthroughRoutes: [],
      supportedRoutes: ['v1.models', 'v1.responses', 'v1.chat.completions'],
      tags: [],
      ...overrides,
    },
    timeoutMs: 120000,
    maxRetries: 1,
    concurrency: 16,
    priority: 100,
    weight: 100,
    provider: buildProviderRecord(id),
  };
}

describe('routing/objective', () => {
  it('averages declared input and output pricing', () => {
    const provider = buildRuntime('priced', {
      inputCostPerMillionTokens: 1,
      outputCostPerMillionTokens: 9,
    });

    expect(providerCostPerMillionTokens(provider)).toBe(5);
  });

  it('scores cheapest and quality goals differently', () => {
    const cheap = buildRuntime('cheap', {
      inputCostPerMillionTokens: 0.2,
      outputCostPerMillionTokens: 0.4,
      qualityScore: 40,
    });
    const excellent = buildRuntime('excellent', {
      inputCostPerMillionTokens: 20,
      outputCostPerMillionTokens: 30,
      qualityScore: 98,
    });

    expect(computeObjectiveScore(cheap, parseRoutingObjectiveConfig({ goal: 'cheapest' })))
      .toBeGreaterThan(computeObjectiveScore(excellent, parseRoutingObjectiveConfig({ goal: 'cheapest' })));
    expect(computeObjectiveScore(excellent, parseRoutingObjectiveConfig({ goal: 'highest-quality' })))
      .toBeGreaterThan(computeObjectiveScore(cheap, parseRoutingObjectiveConfig({ goal: 'highest-quality' })));
  });

  it('prefers declared throughput for fastest routing', () => {
    const slow = buildRuntime('slow', { throughputTokensPerSecond: 30, qualityScore: 80 });
    const fast = buildRuntime('fast', { throughputTokensPerSecond: 1400, qualityScore: 60 });

    expect(computeObjectiveScore(fast, parseRoutingObjectiveConfig({ goal: 'fastest' })))
      .toBeGreaterThan(computeObjectiveScore(slow, parseRoutingObjectiveConfig({ goal: 'fastest' })));
  });
});
