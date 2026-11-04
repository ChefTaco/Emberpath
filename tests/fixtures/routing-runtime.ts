import { ProviderKind, type Provider } from '../../src/generated/prisma/client.js';
import type { EndpointKind, ProviderRuntime, RouteRequest } from '../../src/providers/types.js';

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

export function buildRuntime(kind: ProviderKind, id: string, overrides: Partial<ProviderRuntime> = {}): ProviderRuntime {
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

export function buildRoute(overrides: Partial<RouteRequest> = {}): RouteRequest {
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
