import { describe, expect, it } from 'vitest';
import { ProviderKind, RouteRuleKind } from '../../src/generated/prisma/client.js';
import {
  clientKeyMetadataSchema,
  configImportSchema,
  heuristicActionSchema,
  providerCapabilitySchema,
  routeRuleActionSchema,
  routeRuleMatchSchema,
  routeRuleSchema,
} from '../../src/admin/schemas.js';

describe('admin JSON schemas', () => {
  it('accepts typed provider capabilities and rejects unknown capability flags', () => {
    expect(providerCapabilitySchema.parse({
      tools: true,
      streaming: true,
      supportedRoutes: ['v1.models', 'v1.responses'],
      tags: ['safe-tools'],
      maxContextWindow: 128000,
      inputCostPerMillionTokens: 2.5,
      outputCostPerMillionTokens: 10,
      qualityScore: 92,
      throughputTokensPerSecond: 180,
    })).toEqual({
      tools: true,
      streaming: true,
      supportedRoutes: ['v1.models', 'v1.responses'],
      tags: ['safe-tools'],
      maxContextWindow: 128000,
      inputCostPerMillionTokens: 2.5,
      outputCostPerMillionTokens: 10,
      qualityScore: 92,
      throughputTokensPerSecond: 180,
    });

    expect(() => providerCapabilitySchema.parse({ arbitrary: true })).toThrow();
    expect(() => providerCapabilitySchema.parse({ supportedRoutes: ['v9.imaginary'] })).toThrow();
    expect(() => providerCapabilitySchema.parse({ qualityScore: 120 })).toThrow();
  });

  it('validates route rule match and action payloads as routing contracts', () => {
    const rule = routeRuleSchema.parse({
      name: 'local safety',
      kind: RouteRuleKind.LOCAL_ONLY,
      matchJson: { endpointKinds: ['v1.responses'], models: ['gpt-5'] },
      actionJson: { providerKinds: [ProviderKind.OLLAMA], requiredTag: 'local-only' },
    });

    expect(rule.matchJson.endpointKinds).toEqual(['v1.responses']);
    expect(rule.actionJson.providerKinds).toEqual([ProviderKind.OLLAMA]);
    expect(() => routeRuleMatchSchema.parse({ endpointKinds: ['bad.route'] })).toThrow();
    expect(() => routeRuleActionSchema.parse({ providerKinds: ['NOPE'] })).toThrow();
    expect(() => routeRuleActionSchema.parse({ providerIds: ['provider-a'], unsupported: true })).toThrow();
  });

  it('validates heuristic action payloads without loose JSON blobs', () => {
    expect(heuristicActionSchema.parse({ action: 'deny', reason: 'blocked pattern' })).toEqual({ action: 'deny', reason: 'blocked pattern' });
    expect(() => heuristicActionSchema.parse({ action: 'redirect' })).toThrow();
    expect(() => heuristicActionSchema.parse({ action: 'rerank', provider: 'x' })).toThrow();
  });

  it('keeps client key metadata structured but still useful for operators', () => {
    expect(clientKeyMetadataSchema.parse({
      owner: 'memory-host',
      purpose: 'local model gateway',
      scopes: ['chat:write'],
      tags: ['agent'],
      environment: 'prod',
      labels: { host: 'memory-host' },
    })).toEqual({
      owner: 'memory-host',
      purpose: 'local model gateway',
      scopes: ['chat:write'],
      tags: ['agent'],
      environment: 'prod',
      labels: { host: 'memory-host' },
    });

    expect(() => clientKeyMetadataSchema.parse({ environment: 'production' })).toThrow();
    expect(() => clientKeyMetadataSchema.parse({ nestedFreeform: { unsafe: true } })).toThrow();
  });

  it('validates imported config JSON before storage writes', () => {
    const parsed = configImportSchema.parse({
      data: {
        providers: [{
          slug: 'local-ollama',
          name: 'Local Ollama',
          kind: ProviderKind.OLLAMA,
          baseUrl: 'http://127.0.0.1:11434',
          defaultHeadersJson: '{"x-hive":"router"}',
          capabilityJson: '{"streaming":true,"supportedRoutes":["v1.models","ollama.native"]}',
          models: [{ model: 'llama3.2', capabilityJson: '{"tools":true}' }],
        }],
        routeRules: [{
          name: 'local only',
          kind: RouteRuleKind.LOCAL_ONLY,
          matchJson: '{"endpointKinds":["v1.responses"]}',
          actionJson: '{"providerKinds":["OLLAMA"],"requiredTag":"local-only"}',
        }],
        heuristicRules: [{
          name: 'deny secrets',
          category: 'secrets',
          pattern: 'secret',
          actionJson: '{"action":"deny","reason":"secret-like request"}',
        }],
        runtimeSettings: [{ key: 'router.mode', valueJson: '{"mode":"active"}' }],
      },
    });

    expect(parsed.data?.providers?.[0]?.slug).toBe('local-ollama');
    expect(() => configImportSchema.parse({ data: { routeRules: [{ name: 'bad', kind: RouteRuleKind.SAFETY, matchJson: '{"endpointKinds":["fake"]}', actionJson: '{}' }] } })).toThrow();
    expect(() => configImportSchema.parse({ data: { providers: [{ slug: 'p', name: 'Provider', kind: ProviderKind.OPENAI, baseUrl: 'https://example.com', capabilityJson: '{"unknown":true}' }] } })).toThrow();
    expect(() => configImportSchema.parse({ data: { heuristicRules: [{ name: 'h', category: 'cat', pattern: 'x', actionJson: '{"action":"redirect"}' }] } })).toThrow();
  });

});
