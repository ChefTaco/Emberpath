import { ProviderKind, type Provider } from '../../src/generated/prisma/client.js';
import type { EndpointKind, ProviderRuntime, RouteObservation, RouteRequest } from '../../src/providers/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { routeRuleFindManyMock, modelAliasFindUniqueMock, evaluateHeuristicsMock, runtimeSettingFindUniqueMock, traceFindManyMock } = vi.hoisted(() => ({
  routeRuleFindManyMock: vi.fn(),
  modelAliasFindUniqueMock: vi.fn(),
  evaluateHeuristicsMock: vi.fn(),
  runtimeSettingFindUniqueMock: vi.fn(),
  traceFindManyMock: vi.fn(),
}));

vi.mock('../../src/storage/client.js', () => ({
  prisma: {
    routeRule: {
      findMany: routeRuleFindManyMock,
    },
    modelAlias: {
      findUnique: modelAliasFindUniqueMock,
    },
    runtimeSetting: {
      findUnique: runtimeSettingFindUniqueMock,
    },
    trace: {
      findMany: traceFindManyMock,
    },
  },
}));

vi.mock('../../src/routing/heuristics.js', () => ({
  evaluateHeuristics: evaluateHeuristicsMock,
}));

import { resolveRoute } from '../../src/routing/service.js';

function buildProviderRecord(kind: ProviderKind, id: string): Provider {
  const now = new Date('2026-03-20T00:00:00.000Z');

  return {
    id,
    slug: id,
    name: id,
    kind,
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

function buildRuntime(kind: ProviderKind, id: string, overrides: Partial<ProviderRuntime> = {}): ProviderRuntime {
  const shared = {
    reasoning: false,
    tools: true,
    jsonSchema: true,
    vision: false,
    audio: false,
    video: false,
    embeddings: true,
    longContext: false,
    streaming: true,
    passthroughRoutes: [] as string[],
    supportedRoutes: ['v1.models', 'v1.responses', 'v1.chat.completions', 'v1.completions', 'v1.embeddings'] as EndpointKind[],
    tags: [] as string[],
  };

  if (kind === ProviderKind.OLLAMA) {
    shared.reasoning = true;
    shared.vision = true;
    shared.passthroughRoutes = ['/api/tags', '/api/chat'];
    shared.supportedRoutes = ['v1.models', 'v1.responses', 'v1.chat.completions', 'v1.completions', 'v1.embeddings', 'ollama.native'];
    shared.tags = ['local-only'];
  }

  if (kind === ProviderKind.LLAMACPP) {
    shared.reasoning = true;
    shared.tags = ['local-only'];
  }

  if (kind === ProviderKind.OPENAI) {
    shared.reasoning = true;
    shared.vision = true;
    shared.audio = true;
    shared.video = true;
    shared.longContext = true;
    shared.tags = ['safe-tools', 'long-context'];
  }

  return {
    id,
    slug: id,
    name: id,
    kind,
    baseUrl: `https://${id}.example.com`,
    authHeaderName: 'Authorization',
    authMode: 'BEARER',
    defaultHeaders: {},
    capabilities: shared,
    timeoutMs: 120000,
    maxRetries: 1,
    concurrency: 16,
    priority: 100,
    weight: 100,
    provider: buildProviderRecord(kind, id),
    ...overrides,
  };
}

function buildRoute(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    requestId: 'req_service_1',
    method: 'POST',
    path: '/v1/responses',
    queryString: '',
    endpointKind: 'v1.responses',
    routeKey: 'POST /v1/responses',
    model: 'router-default',
    stream: false,
    toolsRequested: false,
    jsonSchemaRequested: false,
    modalities: [],
    headers: {},
    requestBodyText: 'hello',
    ...overrides,
  };
}

describe('routing/service', () => {
  beforeEach(() => {
    routeRuleFindManyMock.mockReset();
    modelAliasFindUniqueMock.mockReset();
    evaluateHeuristicsMock.mockReset();
    runtimeSettingFindUniqueMock.mockReset();
    traceFindManyMock.mockReset();

    routeRuleFindManyMock.mockResolvedValue([]);
    modelAliasFindUniqueMock.mockResolvedValue(null);
    evaluateHeuristicsMock.mockResolvedValue([] satisfies RouteObservation[]);
    runtimeSettingFindUniqueMock.mockResolvedValue(null);
    traceFindManyMock.mockResolvedValue([]);
  });

  it('pins native Ollama passthrough routes to Ollama providers', async () => {
    const decision = await resolveRoute(
      buildRoute({
        path: '/api/tags',
        endpointKind: 'ollama.native',
        routeKey: 'GET /api/tags',
        method: 'GET',
        model: undefined,
      }),
      [
        buildRuntime(ProviderKind.OPENAI, 'openai-primary'),
        buildRuntime(ProviderKind.OLLAMA, 'ollama-local'),
      ],
    );

    expect(decision.selectedProviderKind).toBe(ProviderKind.OLLAMA);
    expect(decision.candidateProviderIds).toEqual(['ollama-local']);
  });

  it('resolves model aliases before ranking providers', async () => {
    modelAliasFindUniqueMock.mockResolvedValue({
      alias: 'safe-model',
      upstreamModel: 'gpt-4.1',
      providerId: 'openai-safe',
      enabled: true,
    });

    const decision = await resolveRoute(
      buildRoute({ model: 'safe-model' }),
      [
        buildRuntime(ProviderKind.OPENAI, 'openai-safe', { weight: 90 }),
        buildRuntime(ProviderKind.OPENROUTER, 'openrouter-fallback', { weight: 150 }),
      ],
    );

    expect(decision.targetModel).toBe('gpt-4.1');
    expect(decision.selectedProviderId).toBe('openai-safe');
    expect(decision.triggeredRuleNames).toContain('alias:safe-model');
  });

  it('uses an explicit routing trait as the alias/rule key without prompt interpretation', async () => {
    modelAliasFindUniqueMock.mockResolvedValue({
      alias: 'internet_data',
      upstreamModel: 'deepseek/deepseek-v4-pro',
      providerId: null,
      enabled: true,
    });
    routeRuleFindManyMock.mockResolvedValue([
      {
        name: 'route-internet-data-profile',
        kind: 'MODEL_ALIAS',
        priority: 30,
        enabled: true,
        matchJson: JSON.stringify({ models: ['internet_data'] }),
        actionJson: JSON.stringify({ providerKinds: [ProviderKind.OPENROUTER] }),
      },
    ]);

    const decision = await resolveRoute(
      buildRoute({
        path: '/v1/completions',
        endpointKind: 'v1.completions',
        routeKey: 'POST /v1/completions',
        model: 'caller-visible-model',
        routingTrait: 'internet_data',
        requestBodyText: 'plain completion request',
      }),
      [
        buildRuntime(ProviderKind.OPENAI, 'openai-primary', { weight: 200 }),
        buildRuntime(ProviderKind.OPENROUTER, 'openrouter-data', { weight: 80 }),
      ],
    );

    expect(modelAliasFindUniqueMock).toHaveBeenCalledWith({ where: { alias: 'internet_data' } });
    expect(decision.targetModel).toBe('deepseek/deepseek-v4-pro');
    expect(decision.selectedProviderKind).toBe(ProviderKind.OPENROUTER);
    expect(decision.triggeredRuleNames).toContain('route-internet-data-profile');
  });

  it('denies an explicit routing trait that is missing or disabled', async () => {
    modelAliasFindUniqueMock.mockResolvedValue(null);

    const decision = await resolveRoute(
      buildRoute({ routingTrait: 'not-a-real-trait' }),
      [buildRuntime(ProviderKind.OPENAI, 'openai-primary')],
    );

    expect(decision.selectedProviderId).toBeUndefined();
    expect(decision.denialReason).toBe('Routing trait "not-a-real-trait" was not found or is disabled.');
  });

  it('routes model-less chat requests to Local llama.cpp when selected by rule', async () => {
    routeRuleFindManyMock.mockResolvedValue([
      {
        name: 'prefer-local-llamacpp-chat',
        kind: 'PROVIDER_PREFERENCE',
        priority: 5,
        enabled: true,
        matchJson: JSON.stringify({ endpointKinds: ['v1.chat.completions'] }),
        actionJson: JSON.stringify({ providerKinds: [ProviderKind.LLAMACPP] }),
      },
    ]);

    const decision = await resolveRoute(
      buildRoute({
        path: '/v1/chat/completions',
        endpointKind: 'v1.chat.completions',
        routeKey: 'POST /v1/chat/completions',
        model: undefined,
      }),
      [
        buildRuntime(ProviderKind.OPENAI, 'openai-primary'),
        buildRuntime(ProviderKind.LLAMACPP, 'local-llamacpp'),
      ],
    );

    expect(decision.targetModel).toBeUndefined();
    expect(decision.selectedProviderKind).toBe(ProviderKind.LLAMACPP);
    expect(decision.candidateProviderIds).toEqual(['local-llamacpp']);
  });

  it('returns a denial decision when heuristics demand it', async () => {
    evaluateHeuristicsMock.mockResolvedValue([
      {
        name: 'prompt-injection',
        category: 'prompt-safety',
        score: 90,
        action: 'deny',
        details: 'Possible prompt injection language',
      },
    ] satisfies RouteObservation[]);

    const decision = await resolveRoute(
      buildRoute(),
      [buildRuntime(ProviderKind.OPENAI, 'openai-primary')],
    );

    expect(decision.selectedProviderId).toBeUndefined();
    expect(decision.denialReason).toBe('Possible prompt injection language');
  });

  it('prefers a faster, more reliable provider when adaptive routing is enabled', async () => {
    runtimeSettingFindUniqueMock.mockResolvedValue({
      key: 'routing.adaptive',
      valueJson: JSON.stringify({ enabled: true, minSamples: 3, latencyTargetMs: 4000 }),
    });
    // fast-provider: fast + always succeeds; slow-provider: slow + frequently fails.
    traceFindManyMock.mockResolvedValue([
      ...Array.from({ length: 5 }, () => ({ providerId: 'fast-provider', outcome: 'SUCCEEDED', durationMs: 200, usageJson: null })),
      ...Array.from({ length: 5 }, () => ({ providerId: 'slow-provider', outcome: 'FAILED', durationMs: 9000, usageJson: null })),
    ]);

    const decision = await resolveRoute(
      buildRoute(),
      [
        // slow-provider has a higher base weight, so without adaptive it would win.
        buildRuntime(ProviderKind.OPENAI, 'slow-provider', { weight: 200 }),
        buildRuntime(ProviderKind.OPENAI, 'fast-provider', { weight: 100 }),
      ],
    );

    expect(decision.selectedProviderId).toBe('fast-provider');
    expect(decision.candidateProviderIds[0]).toBe('fast-provider');
  });

  it('ignores adaptive telemetry when disabled', async () => {
    runtimeSettingFindUniqueMock.mockResolvedValue(null);
    traceFindManyMock.mockResolvedValue([
      ...Array.from({ length: 10 }, () => ({ providerId: 'fast-provider', outcome: 'SUCCEEDED', durationMs: 100, usageJson: null })),
    ]);

    const decision = await resolveRoute(
      buildRoute(),
      [
        buildRuntime(ProviderKind.OPENAI, 'slow-provider', { weight: 200 }),
        buildRuntime(ProviderKind.OPENAI, 'fast-provider', { weight: 100 }),
      ],
    );

    // With adaptive disabled, the higher base weight still wins.
    expect(decision.selectedProviderId).toBe('slow-provider');
  });

  it('does not adjust providers below the minimum sample threshold', async () => {
    runtimeSettingFindUniqueMock.mockResolvedValue({
      key: 'routing.adaptive',
      valueJson: JSON.stringify({ enabled: true, minSamples: 20 }),
    });
    traceFindManyMock.mockResolvedValue([
      { providerId: 'fast-provider', outcome: 'SUCCEEDED', durationMs: 100, usageJson: null },
    ]);

    const decision = await resolveRoute(
      buildRoute(),
      [
        buildRuntime(ProviderKind.OPENAI, 'slow-provider', { weight: 200 }),
        buildRuntime(ProviderKind.OPENAI, 'fast-provider', { weight: 100 }),
      ],
    );

    expect(decision.selectedProviderId).toBe('slow-provider');
  });

  it('uses routing objective settings to prefer lower-cost providers', async () => {
    runtimeSettingFindUniqueMock.mockImplementation(async ({ where }: { where: { key: string } }) => {
      if (where.key === 'routing.objective') {
        return {
          key: 'routing.objective',
          valueJson: JSON.stringify({ goal: 'cheapest' }),
        };
      }
      return null;
    });

    const decision = await resolveRoute(
      buildRoute(),
      [
        buildRuntime(ProviderKind.OPENAI, 'premium-provider', {
          capabilities: {
            ...buildRuntime(ProviderKind.OPENAI, 'premium-provider').capabilities,
            inputCostPerMillionTokens: 12,
            outputCostPerMillionTokens: 36,
            qualityScore: 98,
          },
        }),
        buildRuntime(ProviderKind.OPENAI, 'budget-provider', {
          capabilities: {
            ...buildRuntime(ProviderKind.OPENAI, 'budget-provider').capabilities,
            inputCostPerMillionTokens: 0.2,
            outputCostPerMillionTokens: 0.4,
            qualityScore: 50,
          },
        }),
      ],
    );

    expect(decision.selectedProviderId).toBe('budget-provider');
    expect(decision.candidateProviderIds[0]).toBe('budget-provider');
  });
});
