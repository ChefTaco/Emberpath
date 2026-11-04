import { AuthMode, ProviderKind, type Provider } from '../../src/generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { encryptText } from '../../src/security/crypto.js';
import { buildProviderCreateData, parseProviderRuntime } from '../../src/providers/runtime.js';

function buildProvider(overrides: Partial<Provider> = {}): Provider {
  const now = new Date('2026-03-20T00:00:00.000Z');

  return {
    id: 'provider_openai',
    slug: 'openai-primary',
    name: 'OpenAI Primary',
    kind: ProviderKind.OPENAI,
    baseUrl: 'https://api.openai.com/v1',
    authMode: AuthMode.BEARER,
    authHeaderName: 'Authorization',
    encryptedAuthSecret: null,
    defaultHeadersJson: JSON.stringify({ 'x-router': 'hive' }),
    capabilityJson: null,
    passthroughJson: null,
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
    ...overrides,
  };
}

describe('providers/runtime', () => {
  it('builds provider create data with sensible defaults', () => {
    const createData = buildProviderCreateData({
      slug: 'ollama-local',
      name: 'Ollama Local',
      kind: ProviderKind.OLLAMA,
      baseUrl: 'http://localhost:11434',
    });

    expect(createData.authMode).toBe(AuthMode.BEARER);
    expect(createData.timeoutMs).toBe(120000);
    expect(createData.concurrency).toBe(16);
    expect(JSON.parse(createData.passthroughJson ?? '[]')).toContain('/api/tags');
  });

  it('defaults llama.cpp providers to local OpenAI-compatible routing without auth', () => {
    const createData = buildProviderCreateData({
      slug: 'local-llamacpp',
      name: 'Local llama.cpp',
      kind: ProviderKind.LLAMACPP,
      baseUrl: 'http://gpu-host:8000',
    });

    const runtime = parseProviderRuntime(buildProvider({
      kind: ProviderKind.LLAMACPP,
      baseUrl: 'http://gpu-host:8000',
      authMode: createData.authMode,
      capabilityJson: createData.capabilityJson,
      passthroughJson: createData.passthroughJson,
    }));

    expect(createData.authMode).toBe(AuthMode.NONE);
    expect(runtime.capabilities.supportedRoutes).toContain('v1.chat.completions');
    expect(runtime.capabilities.supportedRoutes).not.toContain('ollama.native');
    expect(runtime.capabilities.tags).toContain('local-only');
  });

  it('defaults Codex providers to OAuth subscription routing without streaming', () => {
    const createData = buildProviderCreateData({
      slug: 'openai-codex',
      name: 'OpenAI Codex',
      kind: ProviderKind.CODEX,
      baseUrl: 'https://chatgpt.com/backend-api/codex',
    });

    const runtime = parseProviderRuntime(buildProvider({
      kind: ProviderKind.CODEX,
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      authMode: createData.authMode,
      capabilityJson: createData.capabilityJson,
      passthroughJson: createData.passthroughJson,
    }));

    expect(createData.authMode).toBe(AuthMode.BEARER);
    expect(runtime.capabilities.supportedRoutes).toContain('v1.responses');
    expect(runtime.capabilities.supportedRoutes).toContain('v1.chat.completions');
    expect(runtime.capabilities.streaming).toBe(false);
    expect(runtime.capabilities.tags).toContain('subscription');
  });

  it('parses runtime config, decrypts secrets, and merges capabilities', () => {
    const provider = buildProvider({
      kind: ProviderKind.OPENROUTER,
      encryptedAuthSecret: encryptText('or-secret'),
      capabilityJson: JSON.stringify({
        streaming: false,
        tags: ['cheap', 'policy-reviewed'],
        maxContextWindow: 256000,
        inputCostPerMillionTokens: 0.5,
        outputCostPerMillionTokens: 2,
        qualityScore: 84,
        throughputTokensPerSecond: 120,
      }),
      failoverGroup: 'global-primary',
    });

    const runtime = parseProviderRuntime(provider);

    expect(runtime.authSecret).toBe('or-secret');
    expect(runtime.defaultHeaders).toEqual({ 'x-router': 'hive' });
    expect(runtime.capabilities.reasoning).toBe(true);
    expect(runtime.capabilities.streaming).toBe(false);
    expect(runtime.capabilities.tags).toEqual(['cheap', 'policy-reviewed']);
    expect(runtime.capabilities.maxContextWindow).toBe(256000);
    expect(runtime.capabilities.inputCostPerMillionTokens).toBe(0.5);
    expect(runtime.capabilities.outputCostPerMillionTokens).toBe(2);
    expect(runtime.capabilities.qualityScore).toBe(84);
    expect(runtime.capabilities.throughputTokensPerSecond).toBe(120);
    expect(runtime.failoverGroup).toBe('global-primary');
  });
});
