import { ProviderKind } from '../../src/generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { buildRouterOpenApiDocument, builtinApiDocs } from '../../src/openapi/spec.js';

describe('openapi/spec', () => {
  it('documents the required native provider routes', () => {
    expect(
      builtinApiDocs.filter((entry) => entry.providerKind === ProviderKind.OLLAMA).map((entry) => entry.route),
    ).toEqual(
      expect.arrayContaining(['/api/tags', '/api/show', '/api/ps', '/api/embed', '/api/generate', '/api/chat', '/api/pull']),
    );

    expect(
      builtinApiDocs.filter((entry) => entry.providerKind === ProviderKind.VLLM).map((entry) => entry.route),
    ).toEqual(expect.arrayContaining(['/tokenize', '/detokenize', '/version']));
  });

  it('builds an OpenAPI document for the admin plane', () => {
    const document = buildRouterOpenApiDocument('https://router-admin.example.com');

    expect(document).toMatchObject({
      openapi: '3.1.0',
      servers: [{ url: 'https://router-admin.example.com' }],
    });

    const paths = (document.paths ?? {}) as Record<string, Record<string, unknown>>;
    expect(paths['/v1/responses']).toHaveProperty('post');
    expect(paths['/api/tags']).toHaveProperty('get');
    expect(paths['/version']).toHaveProperty('get');
  });
});
