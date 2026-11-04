import { AuthMode, ProviderKind, type Provider } from '../../src/generated/prisma/client.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleAdapter } from '../../src/providers/openai-compatible.js';
import type { ProviderRuntime, RouteRequest } from '../../src/providers/types.js';

function buildProvider(kind: ProviderKind): Provider {
  const now = new Date('2026-03-20T00:00:00.000Z');
  return {
    id: 'provider_llamacpp',
    slug: 'local-llamacpp',
    name: 'Local llama.cpp',
    kind,
    baseUrl: 'http://gpu-host:8000',
    authMode: AuthMode.NONE,
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
}

function buildRuntime(kind: ProviderKind): ProviderRuntime {
  const provider = buildProvider(kind);
  return {
    id: provider.id,
    slug: provider.slug,
    name: provider.name,
    kind,
    baseUrl: provider.baseUrl,
    authHeaderName: provider.authHeaderName,
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
      supportedRoutes: ['v1.models', 'v1.responses', 'v1.chat.completions', 'v1.completions', 'v1.embeddings'],
      tags: ['local-only'],
    },
    timeoutMs: provider.timeoutMs,
    maxRetries: provider.maxRetries,
    concurrency: provider.concurrency,
    priority: provider.priority,
    weight: provider.weight,
    provider,
  };
}

function buildModelLessChatRoute(): RouteRequest {
  const requestBody = {
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
  };

  return {
    requestId: 'req_llamacpp_modeless',
    method: 'POST',
    path: '/v1/chat/completions',
    queryString: '',
    endpointKind: 'v1.chat.completions',
    routeKey: 'POST /v1/chat/completions',
    stream: false,
    toolsRequested: false,
    jsonSchemaRequested: false,
    modalities: [],
    headers: { 'content-type': 'application/json' },
    requestBodyJson: requestBody,
    requestBodyText: JSON.stringify(requestBody),
    bodyBuffer: new TextEncoder().encode(JSON.stringify(requestBody)),
  };
}

describe('providers/openai-compatible', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops caller credentials while preserving configured provider credentials and safe headers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ choices: [] }));
    const route = buildModelLessChatRoute();
    route.headers = { ...route.headers, 'X-Client-Secret': 'dummy-caller-secret', 'x-agent-token': 'dummy-caller-token', 'x-password': 'dummy-caller-password', 'x-request-id': 'request-123' };
    const provider = buildRuntime(ProviderKind.LLAMACPP);
    provider.authMode = 'API_KEY';
    provider.authSecret = 'dummy-provider-key';
    provider.defaultHeaders = { 'x-provider-token': 'dummy-provider-token' };
    await new OpenAiCompatibleAdapter(ProviderKind.LLAMACPP).execute(route, provider);
    const headers = new Headers(fetchMock.mock.calls[0]![1]!.headers);
    for (const name of ['x-client-secret', 'x-agent-token', 'x-password']) expect(headers.has(name)).toBe(false);
    expect(headers.get('x-api-key')).toBe('dummy-provider-key');
    expect(headers.get('x-provider-token')).toBe('dummy-provider-token');
    expect(headers.get('x-request-id')).toBe('request-123');
  });

  it('forwards llama.cpp chat requests without injecting a model name', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ choices: [{ message: { content: 'ok' } }] }),
    );
    const adapter = new OpenAiCompatibleAdapter(ProviderKind.LLAMACPP);

    const execution = await adapter.execute(buildModelLessChatRoute(), buildRuntime(ProviderKind.LLAMACPP));

    expect(execution.response.ok).toBe(true);
    expect(execution.providerModel).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://gpu-host:8000/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    });
  });
});
