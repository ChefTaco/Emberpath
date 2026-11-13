import {z} from 'zod';
import {providerSchema, providerModelSchema, providerCapabilitySchema, providerReadSchema, providerModelReadSchema,
  modelAliasSchema, modelAliasReadSchema, modelAdminErrorSchema, configImportSchema, configExportSchema, configImportResultSchema,
  providerRedactedValue, providerWriteErrorCodes} from '../contracts/model-admin.js';

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
const codes = providerWriteErrorCodes;
const redaction = 'Default header values that may carry a credential are returned as "' + providerRedactedValue + '" and named in redactedDefaultHeaders; '
  + 'sending that value back keeps the stored one, and it is never stored itself.';
const originRule = 'A stored auth secret or credential default header is bound to the origin (scheme, host and port) of baseUrl. '
  + 'When a write changes the origin, the secret must be sent again in the same request (or authMode set to NONE, which discards it) and each credential header must be sent with its real value or left out; '
  + 'otherwise the write is refused with 422 and code ' + codes.originChangeRequiresSecret + ' (' + codes.originChangeRequiresReauthorization + ' for an OAuth-authorized CODEX provider), nothing is changed and the attempt is audited. '
  + 'A path change on the same origin keeps stored credentials.';
const providerWriteErrors = {
  '404': {description: 'Provider not found', content: json(ref('ModelAdminError'))},
  '409': {description: 'A unique record conflicts with existing state, or the provider changed while the request was checked (code ' + codes.changedConcurrently + '); no stored value is disclosed', content: json(ref('ModelAdminError'))},
  '422': {description: 'The base URL moved to another origin without the stored credentials being supplied again (code ' + codes.originChangeRequiresSecret + ' or ' + codes.originChangeRequiresReauthorization + '); nothing was changed', content: json(ref('ModelAdminError'))},
};

export function modelAdminOpenApi() {
  const schemas = Object.fromEntries(Object.entries({ProviderWrite: providerSchema, ProviderModelWrite: providerModelSchema,
    ProviderCapability: providerCapabilitySchema, Provider: providerReadSchema, ProviderModel: providerModelReadSchema,
    ModelAliasWrite: modelAliasSchema, ModelAlias: modelAliasReadSchema, ModelAdminError: modelAdminErrorSchema,
    ConfigImport: configImportSchema, ConfigExport: configExportSchema, ConfigImportResult: configImportResultSchema})
    .map(([name, schema]) => [name, z.toJSONSchema(schema, {io: 'input'})]));
  const paths: Record<string, unknown> = {};
  for (const [path, label, schema, readPermission, writePermission] of [
    ['/api/providers', 'Provider', 'Provider', 'router:providers:read', 'router:providers:write'],
    ['/api/model-aliases', 'ModelAlias', 'ModelAlias', 'router:routing:read', 'router:routing:write'],
  ] as const) {
    paths[path] = {
      get: {operationId: 'list' + label + 's', summary: 'List ' + label + ' records', security, ...(label === 'Provider' ? {description: redaction} : {}),
        'x-permission': readPermission, responses: {'200': {description: 'Sanitized native records', content: json(data({type: 'array', items: ref(schema)}))}, '401': errors['401'], '403': errors['403']}},
      post: {operationId: 'create' + label, summary: 'Create a ' + label + ' record', security, 'x-permission': writePermission,
        ...(label === 'Provider' ? {description: 'A default header sent as "' + providerRedactedValue + '" is refused with 400 and code ' + codes.redactedValueNotStored + '.'} : {}),
        requestBody: {required: true, content: json(ref(schema + 'Write'))},
        responses: {'201': {description: 'Created record', content: json(data(ref(schema)))}, ...errors}},
    };
    paths[path + '/{id}'] = {
      put: {operationId: 'update' + label, summary: 'Replace writable ' + label + ' settings', security, parameters: id,
        ...(label === 'Provider' ? {description: originRule + ' ' + redaction + ' An omitted authSecret keeps the stored secret.'} : {}),
        'x-permission': writePermission, requestBody: {required: true, content: json(ref(schema + 'Write'))},
        responses: {'200': {description: 'Updated record', content: json(data(ref(schema)))}, ...errors, ...(label === 'Provider' ? providerWriteErrors : {})}},
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
  paths['/api/config/export'] = {get: {operationId: 'exportConfiguration', summary: 'Download a native version-1 configuration archive without provider credentials',
    description: 'The archive holds no auth secret, no user name or password from a base URL, and "' + providerRedactedValue + '" in place of credential default header values. Stored header text that is not a JSON object is exported as null.',
    security, 'x-permission': 'router:settings:write', responses: {'200': {description: 'Version-1 archive; source IDs and read metadata are retained for recovery and reference mapping', content: json(ref('ConfigExport'))},
      '401': errors['401'], '403': errors['403']}}};
  paths['/api/config/import'] = {post: {operationId: 'importConfiguration', summary: 'Atomically reconcile a version-1 archive or legacy bare data envelope',
    description: 'Only known archive metadata is accepted. Provider source IDs map through slugs to local IDs; unknown references fail. Omitted credentials and optional provider state stay unchanged. Historical runtime-setting JSON is preserved as opaque data. '
      + 'A default header whose value is "' + providerRedactedValue + '" keeps the value stored at the destination; where none is stored the header is left out and listed in redactedHeadersNotImported. '
      + 'For a provider that already exists (matched by slug) the origin rule of PUT /api/providers/{id} applies: an archive that moves it to another origin must set encryptedAuthSecret (a new value, or null to discard the stored secret) and must not rely on stored credential headers, or the whole import is refused with 422.',
    security, 'x-permission': 'router:settings:write', requestBody: {required: true, content: json(ref('ConfigImport'))}, responses: {
      '200': {description: 'Configuration and audit committed atomically', content: json(ref('ConfigImportResult'))}, ...errors, '422': providerWriteErrors['422'],
      '500': {description: 'Import failed and all configuration writes were rolled back', content: json(ref('ModelAdminError'))},
    }}};
  return {paths, schemas};
}
