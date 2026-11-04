import { ProviderKind } from '../src/generated/prisma/client.js';
import { OllamaAdapter } from '../src/providers/ollama.js';
import type { ProviderRuntime, RouteRequest } from '../src/providers/types.js';

const baseUrl = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
const timeoutMs = Number(process.env['OLLAMA_TIMEOUT_MS'] ?? 10000);

const providerRecord = {
  id: 'provider_ollama_smoke',
  slug: 'ollama-smoke',
  name: 'Ollama Smoke',
  kind: ProviderKind.OLLAMA,
  baseUrl,
  authMode: 'NONE' as const,
  authHeaderName: 'Authorization',
  encryptedAuthSecret: null,
  defaultHeadersJson: '{}',
  capabilityJson: '{}',
  passthroughJson: '[]',
  tlsInsecure: false,
  timeoutMs,
  maxRetries: 1,
  concurrency: 4,
  priority: 100,
  weight: 100,
  failoverGroup: null,
  enabled: true,
  lastHealthStatus: null,
  lastHealthError: null,
  lastHealthAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const provider: ProviderRuntime = {
  id: providerRecord.id,
  slug: providerRecord.slug,
  name: providerRecord.name,
  kind: providerRecord.kind,
  baseUrl: providerRecord.baseUrl,
  authHeaderName: providerRecord.authHeaderName,
  authMode: 'NONE',
  defaultHeaders: {},
  capabilities: {
    reasoning: true,
    tools: true,
    jsonSchema: true,
    vision: true,
    audio: false,
    video: false,
    embeddings: true,
    longContext: false,
    streaming: true,
    passthroughRoutes: ['/api/tags'],
    supportedRoutes: ['v1.models', 'ollama.native'],
    tags: ['local-only'],
  },
  timeoutMs,
  maxRetries: 1,
  concurrency: 4,
  priority: 100,
  weight: 100,
  provider: providerRecord,
};

const route: RouteRequest = {
  requestId: 'req_smoke_ollama',
  method: 'GET',
  path: '/api/tags',
  queryString: '',
  endpointKind: 'ollama.native',
  routeKey: 'GET /api/tags',
  stream: false,
  toolsRequested: false,
  jsonSchemaRequested: false,
  modalities: [],
  headers: {},
};

const adapter = new OllamaAdapter();
const health = await adapter.healthCheck(provider);
const execution = await adapter.execute(route, provider);
const responseJson = await execution.response.json() as { models?: Array<{ name?: string }> };

if (!health.healthy || !execution.response.ok) {
  console.error(JSON.stringify({ health, status: execution.response.status }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  health,
  baseUrl,
  modelCount: Array.isArray(responseJson.models) ? responseJson.models.length : 0,
  firstModel: Array.isArray(responseJson.models) && responseJson.models.length > 0
    ? responseJson.models[0]?.name ?? null
    : null,
}, null, 2));
