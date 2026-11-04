import { AuthMode, ProviderKind, type Provider } from '../generated/prisma/client.js';
import { decryptText } from '../security/crypto.js';
import type { EndpointKind, ProviderCapability, ProviderRuntime } from './types.js';
import { safeJsonParse } from '../utils/json.js';

const sharedOpenAiRoutes: EndpointKind[] = [
  'v1.responses',
  'v1.chat.completions',
  'v1.completions',
  'v1.embeddings',
];

function defaultCapabilities(kind: ProviderKind): ProviderCapability {
  switch (kind) {
    case ProviderKind.OPENAI:
      return {
        reasoning: true,
        tools: true,
        jsonSchema: true,
        vision: true,
        audio: true,
        video: true,
        embeddings: true,
        longContext: true,
        streaming: true,
        passthroughRoutes: [],
        supportedRoutes: [
          'v1.models',
          ...sharedOpenAiRoutes,
          'v1.audio.transcriptions',
          'v1.audio.translations',
          'v1.images.generations',
          'v1.moderations',
        ],
        tags: ['safe-tools', 'long-context'],
        maxContextWindow: 128000,
      };
    case ProviderKind.CODEX:
      return {
        reasoning: true,
        tools: true,
        jsonSchema: true,
        vision: false,
        audio: false,
        video: false,
        embeddings: false,
        longContext: true,
        streaming: false,
        passthroughRoutes: [],
        supportedRoutes: ['v1.models', 'v1.responses', 'v1.chat.completions', 'v1.completions'],
        tags: ['codex', 'subscription', 'long-context', 'safe-tools'],
        maxContextWindow: 200000,
      };
    case ProviderKind.OPENROUTER:
      return {
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
        supportedRoutes: ['v1.models', ...sharedOpenAiRoutes],
        tags: ['cheap', 'long-context'],
        maxContextWindow: 200000,
      };
    case ProviderKind.OPENAI_GENERIC:
      return {
        reasoning: false,
        tools: true,
        jsonSchema: true,
        vision: false,
        audio: false,
        video: false,
        embeddings: true,
        longContext: false,
        streaming: true,
        passthroughRoutes: [],
        supportedRoutes: ['v1.models', ...sharedOpenAiRoutes],
        tags: [],
      };
    case ProviderKind.ANTHROPIC:
      return {
        reasoning: false,
        tools: true,
        jsonSchema: true,
        vision: true,
        audio: false,
        video: false,
        embeddings: false,
        longContext: true,
        streaming: false,
        passthroughRoutes: [],
        supportedRoutes: ['v1.models', 'v1.responses', 'v1.chat.completions'],
        tags: ['safe-tools', 'long-context'],
        maxContextWindow: 200000,
      };
    case ProviderKind.OLLAMA:
      return {
        reasoning: true,
        tools: true,
        jsonSchema: true,
        vision: true,
        audio: false,
        video: false,
        embeddings: true,
        longContext: false,
        streaming: true,
        passthroughRoutes: ['/api/tags', '/api/show', '/api/ps', '/api/embed', '/api/generate', '/api/chat', '/api/pull'],
        supportedRoutes: ['v1.models', 'v1.responses', 'v1.chat.completions', 'v1.completions', 'v1.embeddings', 'ollama.native'],
        tags: ['local-only'],
      };
    case ProviderKind.LLAMACPP:
      return {
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
        supportedRoutes: ['v1.models', ...sharedOpenAiRoutes],
        tags: ['local-only'],
      };
    case ProviderKind.VLLM:
      return {
        reasoning: false,
        tools: true,
        jsonSchema: true,
        vision: false,
        audio: false,
        video: false,
        embeddings: true,
        longContext: true,
        streaming: true,
        passthroughRoutes: ['/tokenize', '/detokenize', '/version'],
        supportedRoutes: ['v1.models', ...sharedOpenAiRoutes, 'vllm.native'],
        tags: ['low-latency'],
      };
  }
}

export function parseProviderRuntime(provider: Provider): ProviderRuntime {
  const defaultCapabilitySet = defaultCapabilities(provider.kind);
  const capabilityJson = safeJsonParse<Partial<ProviderCapability>>(provider.capabilityJson, {});
  const defaultHeaders = safeJsonParse<Record<string, string>>(provider.defaultHeadersJson, {});

  return {
    id: provider.id,
    slug: provider.slug,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    authHeaderName: provider.authHeaderName,
    authMode: provider.authMode as ProviderRuntime['authMode'],
    authSecret: provider.encryptedAuthSecret ? decryptText(provider.encryptedAuthSecret) : undefined,
    defaultHeaders,
    capabilities: {
      ...defaultCapabilitySet,
      ...capabilityJson,
      passthroughRoutes: capabilityJson.passthroughRoutes ?? defaultCapabilitySet.passthroughRoutes,
      supportedRoutes: capabilityJson.supportedRoutes ?? defaultCapabilitySet.supportedRoutes,
      tags: capabilityJson.tags ?? defaultCapabilitySet.tags,
    },
    timeoutMs: provider.timeoutMs,
    maxRetries: provider.maxRetries,
    concurrency: provider.concurrency,
    priority: provider.priority,
    weight: provider.weight,
    failoverGroup: provider.failoverGroup ?? undefined,
    provider,
  };
}

export function buildProviderCreateData(input: {
  slug: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  authMode?: AuthMode | undefined;
  authHeaderName?: string | undefined;
  encryptedAuthSecret?: string | undefined;
  defaultHeaders?: Record<string, string>;
  capabilities?: Partial<ProviderCapability>;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  concurrency?: number | undefined;
  priority?: number | undefined;
  weight?: number | undefined;
  failoverGroup?: string | undefined;
  enabled?: boolean | undefined;
}): Omit<Provider, 'id' | 'createdAt' | 'updatedAt' | 'lastHealthAt' | 'lastHealthStatus' | 'lastHealthError'> {
  return {
    slug: input.slug,
    name: input.name,
    kind: input.kind,
    baseUrl: input.baseUrl,
    authMode: input.authMode ?? (input.kind === ProviderKind.LLAMACPP ? AuthMode.NONE : AuthMode.BEARER),
    authHeaderName: input.authHeaderName ?? 'Authorization',
    encryptedAuthSecret: input.encryptedAuthSecret ?? null,
    defaultHeadersJson: JSON.stringify(input.defaultHeaders ?? {}),
    capabilityJson: JSON.stringify(input.capabilities ?? {}),
    passthroughJson: JSON.stringify((input.capabilities?.passthroughRoutes ?? defaultCapabilities(input.kind).passthroughRoutes)),
    tlsInsecure: false,
    timeoutMs: input.timeoutMs ?? 120000,
    maxRetries: input.maxRetries ?? 1,
    concurrency: input.concurrency ?? 16,
    priority: input.priority ?? 100,
    weight: input.weight ?? 100,
    failoverGroup: input.failoverGroup ?? null,
    enabled: input.enabled ?? true,
  };
}
