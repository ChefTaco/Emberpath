import { ProviderKind } from '../src/generated/prisma/client.js';
import { OpenAiCompatibleAdapter } from '../src/providers/openai-compatible.js';
import type { ProviderRuntime, RouteRequest } from '../src/providers/types.js';

const baseUrl = process.env['LLAMACPP_BASE_URL'] ?? 'http://127.0.0.1:8000';
const timeoutMs = Number(process.env['LLAMACPP_TIMEOUT_MS'] ?? 30000);

const providerRecord = {
  id: 'provider_llamacpp_smoke',
  slug: 'llamacpp-smoke',
  name: 'llama.cpp Smoke',
  kind: ProviderKind.LLAMACPP,
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
  timeoutMs,
  maxRetries: 1,
  concurrency: 4,
  priority: 100,
  weight: 100,
  provider: providerRecord,
};

const requestBody = {
  messages: [
    { role: 'user', content: 'Reply with exactly: hive-router llama.cpp smoke ok' },
  ],
  stream: false,
  temperature: 0,
};

const route: RouteRequest = {
  requestId: 'req_smoke_llamacpp',
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
  requestBodyText: JSON.stringify(requestBody),
  requestBodyJson: requestBody,
  bodyBuffer: new TextEncoder().encode(JSON.stringify(requestBody)),
};

const adapter = new OpenAiCompatibleAdapter(ProviderKind.LLAMACPP);
const health = await adapter.healthCheck(provider);
const execution = await adapter.execute(route, provider);
const responseText = await execution.response.text();

if (!health.healthy || !execution.response.ok) {
  console.error(JSON.stringify({ health, status: execution.response.status, responseText }, null, 2));
  process.exit(1);
}

let responsePreview = responseText;
try {
  const responseJson = JSON.parse(responseText) as { choices?: Array<{ message?: { content?: string } }> };
  responsePreview = responseJson.choices?.[0]?.message?.content ?? responseText;
} catch {
  responsePreview = responseText;
}

console.log(JSON.stringify({
  health,
  baseUrl,
  modelSent: false,
  responsePreview,
}, null, 2));
