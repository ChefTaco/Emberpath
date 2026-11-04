import { ProviderKind, type Provider } from '../../src/generated/prisma/client.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseAnthropicModels,
  parseOllamaTags,
  parseOpenAiModels,
  reconcileDiscoveredModels,
  type ExistingModelRow,
} from '../../src/providers/model-parsers.js';
import { OpenAiCompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OllamaAdapter } from '../../src/providers/ollama.js';
import type { ProviderRuntime } from '../../src/providers/types.js';

function buildRuntime(kind: ProviderKind, baseUrl: string): ProviderRuntime {
  const now = new Date('2026-03-20T00:00:00.000Z');
  const provider: Provider = {
    id: 'provider_discover',
    slug: 'discover-provider',
    name: 'Discovery Provider',
    kind,
    baseUrl,
    authMode: 'NONE',
    authHeaderName: 'Authorization',
    encryptedAuthSecret: null,
    defaultHeadersJson: '{}',
    capabilityJson: '{}',
    passthroughJson: '[]',
    tlsInsecure: false,
    timeoutMs: 120000,
    maxRetries: 1,
    concurrency: 16,
    priority: 50,
    weight: 100,
    failoverGroup: null,
    enabled: true,
    lastHealthStatus: null,
    lastHealthError: null,
    lastHealthAt: null,
    createdAt: now,
    updatedAt: now,
  };
  return {
    id: provider.id,
    slug: provider.slug,
    name: provider.name,
    kind,
    baseUrl,
    authHeaderName: 'Authorization',
    authMode: 'NONE',
    defaultHeaders: {},
    capabilities: {
      reasoning: true,
      tools: true,
      jsonSchema: true,
      vision: false,
      audio: false,
      video: false,
      embeddings: true,
      longContext: false,
      streaming: true,
      passthroughRoutes: [],
      supportedRoutes: ['v1.models'],
      tags: [],
    },
    timeoutMs: 120000,
    maxRetries: 1,
    concurrency: 16,
    priority: 50,
    weight: 100,
    provider,
  };
}

function existingRow(overrides: Partial<ExistingModelRow> & { model: string }): ExistingModelRow {
  return {
    displayName: null,
    enabled: true,
    maxContextWindow: null,
    capabilityJson: null,
    ...overrides,
  };
}

describe('providers/model-parsers', () => {
  it('parses OpenAI-compatible model lists and captures context windows', () => {
    const models = parseOpenAiModels({
      object: 'list',
      data: [
        { id: 'gpt-4o', display_name: 'GPT-4o', context_window: 128000 },
        { id: 'text-embedding-3-small' },
        { id: 'llama-3-70b', max_model_len: 8192 },
      ],
    });

    expect(models).toEqual([
      { model: 'gpt-4o', displayName: 'GPT-4o', maxContextWindow: 128000 },
      { model: 'text-embedding-3-small' },
      { model: 'llama-3-70b', maxContextWindow: 8192 },
    ]);
  });

  it('ignores malformed OpenAI entries and de-duplicates model ids', () => {
    const models = parseOpenAiModels({
      data: [
        { id: 'dup' },
        { id: 'dup' },
        { id: '' },
        null,
        'not-an-object',
        { name: 'no-id' },
        { id: 'valid', context_length: -1 },
      ],
    });

    expect(models).toEqual([{ model: 'dup' }, { model: 'valid' }]);
  });

  it('returns an empty list when the OpenAI payload is not a list', () => {
    expect(parseOpenAiModels({})).toEqual([]);
    expect(parseOpenAiModels(null)).toEqual([]);
    expect(parseOpenAiModels({ data: 'nope' })).toEqual([]);
  });

  it('parses Ollama /api/tags payloads', () => {
    const models = parseOllamaTags({
      models: [
        { name: 'llama3:latest', model: 'llama3:latest' },
        { model: 'qwen2.5:7b' },
        { name: '' },
        { name: 'llama3:latest' },
      ],
    });

    expect(models).toEqual([{ model: 'llama3:latest' }, { model: 'qwen2.5:7b' }]);
  });

  it('parses Anthropic model lists with display names', () => {
    const models = parseAnthropicModels({
      data: [
        { id: 'claude-3-7-sonnet', display_name: 'Claude 3.7 Sonnet' },
        { id: 'claude-3-5-haiku' },
      ],
    });

    expect(models).toEqual([
      { model: 'claude-3-7-sonnet', displayName: 'Claude 3.7 Sonnet' },
      { model: 'claude-3-5-haiku' },
    ]);
  });
});

describe('providers/reconcileDiscoveredModels', () => {
  it('creates newly discovered models', () => {
    const plan = reconcileDiscoveredModels([], [{ model: 'gpt-4o' }, { model: 'gpt-4o-mini' }]);
    expect(plan.toCreate.map((m) => m.model)).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.stale).toEqual([]);
  });

  it('fills missing context windows and display names without clobbering overrides', () => {
    const existing = [
      existingRow({ model: 'gpt-4o', displayName: 'Operator Name', maxContextWindow: 64000 }),
      existingRow({ model: 'gpt-4o-mini' }),
    ];
    const plan = reconcileDiscoveredModels(existing, [
      { model: 'gpt-4o', displayName: 'GPT-4o', maxContextWindow: 128000 },
      { model: 'gpt-4o-mini', displayName: 'GPT-4o mini', maxContextWindow: 128000 },
    ]);

    // gpt-4o already has operator display name + context window -> unchanged
    expect(plan.unchanged).toContain('gpt-4o');
    // gpt-4o-mini has gaps -> filled
    expect(plan.toUpdate).toEqual([
      { model: 'gpt-4o-mini', maxContextWindow: 128000, displayName: 'GPT-4o mini' },
    ]);
  });

  it('reports stale models that disappeared but never deletes them', () => {
    const existing = [existingRow({ model: 'old-model' }), existingRow({ model: 'kept' })];
    const plan = reconcileDiscoveredModels(existing, [{ model: 'kept' }, { model: 'new' }]);
    expect(plan.stale).toEqual(['old-model']);
    expect(plan.toCreate.map((m) => m.model)).toEqual(['new']);
  });

  it('handles a fixture server that changes its model list between runs', () => {
    // First run: server exposes A and B.
    const firstRun = reconcileDiscoveredModels([], [{ model: 'A' }, { model: 'B' }]);
    expect(firstRun.toCreate.map((m) => m.model)).toEqual(['A', 'B']);

    // Simulate persisted rows, then second run drops B and adds C.
    const persisted = [existingRow({ model: 'A' }), existingRow({ model: 'B' })];
    const secondRun = reconcileDiscoveredModels(persisted, [{ model: 'A' }, { model: 'C' }]);
    expect(secondRun.toCreate.map((m) => m.model)).toEqual(['C']);
    expect(secondRun.stale).toEqual(['B']);
    expect(secondRun.unchanged).toContain('A');
  });
});

describe('provider adapters discoverModels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('probes an OpenAI-compatible /v1/models endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ data: [{ id: 'gpt-4o', context_window: 128000 }] }),
    );
    const adapter = new OpenAiCompatibleAdapter(ProviderKind.OPENAI);
    const models = await adapter.discoverModels(buildRuntime(ProviderKind.OPENAI, 'https://api.example.com'));
    expect(models).toEqual([{ model: 'gpt-4o', maxContextWindow: 128000 }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/models',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('throws when the OpenAI discovery probe fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const adapter = new OpenAiCompatibleAdapter(ProviderKind.OPENAI);
    await expect(adapter.discoverModels(buildRuntime(ProviderKind.OPENAI, 'https://api.example.com'))).rejects.toThrow(
      /discovery returned 500/,
    );
  });

  it('probes an Ollama /api/tags endpoint', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ models: [{ name: 'llama3:latest' }, { name: 'qwen2.5:7b' }] }),
    );
    const adapter = new OllamaAdapter();
    const models = await adapter.discoverModels(buildRuntime(ProviderKind.OLLAMA, 'http://ollama:11434'));
    expect(models).toEqual([{ model: 'llama3:latest' }, { model: 'qwen2.5:7b' }]);
  });
});
