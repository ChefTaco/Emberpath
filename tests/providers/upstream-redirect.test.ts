import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthMode, ProviderKind, type Provider } from '../../src/generated/prisma/client.js';
import { getProviderAdapter } from '../../src/providers/index.js';
import { ProviderRedirectError, providerFetch } from '../../src/providers/upstream-fetch.js';
import type { ProviderRuntime, RouteRequest } from '../../src/providers/types.js';

// Two real listeners: the configured provider, which redirects everything, and the server it
// points to. Nothing sent to the provider may ever arrive at the second one.
const received: Array<{ url: string; headers: IncomingMessage['headers']; body: string }> = [];
let redirectStatus = 307;
let provider: Server;
let collector: Server;
let providerUrl = '';
let collectorUrl = '';

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

beforeAll(async () => {
  collector = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
    request.on('end', () => {
      received.push({ url: request.url ?? '', headers: request.headers, body });
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[],"models":[]}');
    });
  });
  collectorUrl = await listen(collector);
  provider = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (request.url?.startsWith('/same-origin')) response.writeHead(redirectStatus, { location: '/v1/models' }).end();
      else response.writeHead(redirectStatus, { location: `${collectorUrl}/collect?token=obviously-fake-query-token` }).end();
    });
  });
  providerUrl = await listen(provider);
});
afterAll(async () => {
  await Promise.all([provider, collector].map((server) => new Promise((resolve) => server.close(resolve))));
});
beforeEach(() => { received.length = 0; redirectStatus = 307; });

function runtime(kind: ProviderKind, authMode: ProviderRuntime['authMode'] = 'HEADER'): ProviderRuntime {
  const now = new Date('2026-03-20T00:00:00.000Z');
  const record: Provider = {
    id: 'provider_fixture', slug: 'fixture', name: 'Fixture', kind, baseUrl: providerUrl, authMode: AuthMode[authMode],
    authHeaderName: 'x-provider-auth', encryptedAuthSecret: null, defaultHeadersJson: '{}', capabilityJson: '{}', passthroughJson: '[]',
    tlsInsecure: false, timeoutMs: 5000, maxRetries: 0, concurrency: 4, priority: 50, weight: 100, failoverGroup: null, enabled: true,
    lastHealthStatus: null, lastHealthError: null, lastHealthAt: null, createdAt: now, updatedAt: now,
  };
  return {
    id: record.id, slug: record.slug, name: record.name, kind, baseUrl: providerUrl, authHeaderName: 'x-provider-auth', authMode,
    authSecret: 'obviously-fake-provider-credential', defaultHeaders: { 'x-api-token': 'obviously-fake-header-credential' },
    capabilities: { reasoning: false, tools: true, jsonSchema: true, vision: false, audio: false, video: false, embeddings: true, longContext: false,
      streaming: true, passthroughRoutes: [], supportedRoutes: ['v1.models', 'v1.chat.completions', 'ollama.native', 'vllm.native'], tags: [] },
    timeoutMs: 5000, maxRetries: 0, concurrency: 4, priority: 50, weight: 100, provider: record,
  };
}

function chatRoute(overrides: Partial<RouteRequest> = {}): RouteRequest {
  const body = { model: 'fixture-model', messages: [{ role: 'user', content: 'obviously-fake-prompt' }] };
  return {
    requestId: 'request_fixture', method: 'POST', path: '/v1/chat/completions', queryString: '', endpointKind: 'v1.chat.completions',
    routeKey: 'POST /v1/chat/completions', model: 'fixture-model', stream: false, toolsRequested: false, jsonSchemaRequested: false, modalities: [],
    headers: { 'content-type': 'application/json' }, requestBodyJson: body, requestBodyText: JSON.stringify(body),
    bodyBuffer: new TextEncoder().encode(JSON.stringify(body)), ...overrides,
  };
}

describe('provider requests do not follow redirects', () => {
  it.each([301, 302, 303, 307, 308])('providerFetch turns a %i into a provider failure that names only the target origin', async (status) => {
    redirectStatus = status;
    const failure = await providerFetch(`${providerUrl}/v1/models`, { headers: { 'x-api-key': 'obviously-fake-provider-credential' } }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderRedirectError);
    expect((failure as ProviderRedirectError).message).toContain(`HTTP ${status} to ${collectorUrl})`);
    expect((failure as ProviderRedirectError).message).toContain('Redirects are not followed');
    expect((failure as ProviderRedirectError).message).not.toMatch(/collect|obviously-fake/);
    expect(received).toHaveLength(0);
  });

  it('does not follow a same-origin redirect either', async () => {
    await expect(providerFetch(`${providerUrl}/same-origin`)).rejects.toBeInstanceOf(ProviderRedirectError);
  });

  it('passes other answers through unchanged', async () => {
    const response = await providerFetch(`${collectorUrl}/v1/models`);
    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
  });

  it.each([
    [ProviderKind.OPENAI_GENERIC, 'HEADER', chatRoute()],
    [ProviderKind.OPENAI, 'API_KEY', chatRoute()],
    [ProviderKind.ANTHROPIC, 'API_KEY', chatRoute()],
    [ProviderKind.OLLAMA, 'HEADER', chatRoute()],
    [ProviderKind.OLLAMA, 'HEADER', chatRoute({ path: '/api/chat', endpointKind: 'ollama.native', routeKey: 'POST /api/chat' })],
    [ProviderKind.VLLM, 'HEADER', chatRoute({ path: '/tokenize', endpointKind: 'vllm.native', routeKey: 'POST /tokenize' })],
    [ProviderKind.LLAMACPP, 'HEADER', chatRoute({ method: 'GET', path: '/v1/models', endpointKind: 'v1.models', bodyBuffer: undefined })],
  ] as const)('%s (%s) sends no credential, default header or request body to a redirect target', async (kind, authMode, route) => {
    const adapter = getProviderAdapter(kind);
    await expect(adapter.execute(route, runtime(kind, authMode))).rejects.toBeInstanceOf(ProviderRedirectError);
    expect(received).toHaveLength(0);
  });

  it('reports a redirecting provider as unhealthy with the reason, and fails model discovery', async () => {
    for (const kind of [ProviderKind.OPENAI_GENERIC, ProviderKind.OLLAMA]) {
      const adapter = getProviderAdapter(kind);
      const health = await adapter.healthCheck(runtime(kind));
      expect(health.healthy).toBe(false);
      expect(health.error).toContain('Redirects are not followed');
      await expect(adapter.discoverModels!(runtime(kind))).rejects.toBeInstanceOf(ProviderRedirectError);
    }
    await expect(getProviderAdapter(ProviderKind.ANTHROPIC).discoverModels!(runtime(ProviderKind.ANTHROPIC))).rejects.toBeInstanceOf(ProviderRedirectError);
    expect(received).toHaveLength(0);
  });
});
