import {expect, it} from 'vitest';
import {z} from 'zod';
import {modelAdminOpenApi} from '../../src/openapi/model-admin.js';
import {providerSchema, modelAliasSchema} from '../../src/admin/schemas.js';
import {providerSchema as browserProvider, modelAliasSchema as browserAlias} from '../../src/contracts/model-admin.js';

it('uses the same strict public schemas for native requests and OpenAPI without persistence or nullable write fields', () => {
  expect(browserProvider).toBe(providerSchema); expect(browserAlias).toBe(modelAliasSchema);
  const document = modelAdminOpenApi();
  expect(document.schemas.ProviderWrite).toEqual(z.toJSONSchema(providerSchema, {io: 'input'}));
  expect(document.schemas.ModelAliasWrite).toEqual(z.toJSONSchema(modelAliasSchema, {io: 'input'}));
  for (const path of ['/api/providers', '/api/providers/{id}', '/api/providers/{id}/discover', '/api/model-aliases', '/api/model-aliases/{id}']) expect(document.paths).toHaveProperty(path);
  const paths = document.paths as Record<string, Record<string, {responses: Record<string, unknown>}>>;
  expect(paths['/api/providers']!.post!.responses).toHaveProperty('409');
  expect(paths['/api/model-aliases/{id}']!.put!.responses).toHaveProperty('409');
  const base = {slug: 'fixture', name: 'Fixture', kind: 'OPENAI_GENERIC', baseUrl: 'https://provider.example.com/v1'};
  for (const model of [{model: 'fixture', id: 'row'}, {model: 'fixture', displayName: null}, {model: 'fixture', capabilityJson: '{}'}])
    expect(browserProvider.safeParse({...base, models: [model]}).success).toBe(false);
});
