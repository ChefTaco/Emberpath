import {z} from 'zod';
import {providerSchema, providerModelSchema, providerCapabilitySchema, providerReadSchema, providerModelReadSchema,
  modelAliasSchema, modelAliasReadSchema, modelAdminErrorSchema} from '../contracts/model-admin.js';

const json = (schema: unknown) => ({'application/json': {schema}});
const ref = (name: string) => ({$ref: '#/components/schemas/' + name});
const id = [{name: 'id', in: 'path', required: true, schema: {type: 'string', minLength: 1}}];
const data = (schema: unknown) => ({type: 'object', required: ['data'], properties: {data: schema}});
const security = [{resourceBearer: []}, {adminSession: []}];
const errors = {
  '400': {description: 'Request validation or selected model is invalid', content: json(ref('ModelAdminError'))},
  '401': {description: 'Authentication required'}, '403': {description: 'Product permission required'},
  '409': {description: 'A unique record conflicts with existing state; no stored value is disclosed', content: json(ref('ModelAdminError'))},
};

export function modelAdminOpenApi() {
  const schemas = Object.fromEntries(Object.entries({ProviderWrite: providerSchema, ProviderModelWrite: providerModelSchema,
    ProviderCapability: providerCapabilitySchema, Provider: providerReadSchema, ProviderModel: providerModelReadSchema,
    ModelAliasWrite: modelAliasSchema, ModelAlias: modelAliasReadSchema, ModelAdminError: modelAdminErrorSchema})
    .map(([name, schema]) => [name, z.toJSONSchema(schema, {io: 'input'})]));
  const paths: Record<string, unknown> = {};
  for (const [path, label, schema, readPermission, writePermission] of [
    ['/api/providers', 'Provider', 'Provider', 'router:providers:read', 'router:providers:write'],
    ['/api/model-aliases', 'ModelAlias', 'ModelAlias', 'router:routing:read', 'router:routing:write'],
  ] as const) {
    paths[path] = {
      get: {operationId: 'list' + label + 's', summary: 'List ' + label + ' records', security,
        'x-permission': readPermission, responses: {'200': {description: 'Sanitized native records', content: json(data({type: 'array', items: ref(schema)}))}, '401': errors['401'], '403': errors['403']}},
      post: {operationId: 'create' + label, summary: 'Create a ' + label + ' record', security, 'x-permission': writePermission,
        requestBody: {required: true, content: json(ref(schema + 'Write'))},
        responses: {'201': {description: 'Created record', content: json(data(ref(schema)))}, ...errors}},
    };
    paths[path + '/{id}'] = {
      put: {operationId: 'update' + label, summary: 'Replace writable ' + label + ' settings', security, parameters: id,
        'x-permission': writePermission, requestBody: {required: true, content: json(ref(schema + 'Write'))},
        responses: {'200': {description: 'Updated record', content: json(data(ref(schema)))}, ...errors}},
      delete: {operationId: 'delete' + label, summary: 'Delete a ' + label + ' record', security, parameters: id,
        'x-permission': writePermission, responses: {'200': {description: 'Deleted', content: json({type: 'object', required: ['ok'], properties: {ok: {type: 'boolean'}}})}, ...errors}},
    };
  }
  paths['/api/providers/{id}/discover'] = {post: {operationId: 'discoverProviderModels',
    summary: 'Discover models from a configured external provider and reconcile its registry', security, parameters: id,
    'x-permission': 'router:providers:write', responses: {
      '200': {description: 'Refreshed provider and discovery reconciliation; detailed discovery response schema is not yet exported'},
      ...errors, '404': {description: 'Provider not found'}, '502': {description: 'External provider discovery failed'},
    }}};
  return {paths, schemas};
}
