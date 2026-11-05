import {z} from 'zod';
import * as contracts from '../contracts/model-admin.js';

/** Browser-consumed native console operations. Each request uses its native runtime schema. */
export function consoleAdminOpenApi() {
  const named = {
    RouteRuleWrite: contracts.routeRuleSchema, RouteRule: contracts.routeRuleReadSchema,
    HeuristicWrite: contracts.heuristicSchema, Heuristic: contracts.heuristicReadSchema,
    ClientKeyWrite: contracts.clientKeySchema, ClientKeyUpdate: contracts.clientKeyUpdateSchema,
    ClientKey: contracts.clientKeyReadSchema, ClientKeyCreated: contracts.clientKeyCreatedSchema,
    ClientKeyRotated: contracts.clientKeyRotatedSchema, ClientKeyUsage: contracts.clientKeyUsageSchema,
    RoutingObjective: contracts.routingObjectiveSchema, RoutingObjectiveRead: contracts.routingObjectiveReadSchema, RoutingTestRequest: contracts.routingTestRequestSchema,
    RoutingTestResult: contracts.routingTestResultSchema, RoutingPreviewRequest: contracts.routingPreviewRequestSchema,
    RoutingApplyRequest: contracts.routingApplyRequestSchema, RoutingRollbackRequest: contracts.routingRollbackRequestSchema,
    RoutingPreview: contracts.routingPreviewSchema, RoutingRevisions: contracts.routingRevisionsSchema,
    RoutingApplied: contracts.routingAppliedSchema, RoutingSnapshot: contracts.routingSnapshotSchema,
    AdminMe: contracts.adminMeSchema, DocsIndex: contracts.docsIndexSchema, Trace: contracts.traceReadSchema, Telemetry: contracts.telemetrySchema, AuditEvent: contracts.auditReadSchema,
    RuntimeSetting: contracts.runtimeSettingReadSchema, CodexOAuthStatus: contracts.codexOAuthStatusSchema,
    CodexOAuthStart: contracts.codexOAuthStartSchema, CodexOAuthCheck: contracts.codexOAuthCheckSchema,
    CodexOAuthResult: contracts.codexOAuthResultSchema, ConsoleOk: contracts.okSchema,
  };
  const schemas = Object.fromEntries(Object.entries(named).map(([name, schema]) => [name, z.toJSONSchema(schema, {io: 'input'})]));
  const ref = (name: string) => ({$ref: '#/components/schemas/' + name});
  const json = (schema: unknown) => ({'application/json': {schema}});
  const data = (schema: unknown) => ({type: 'object', required: ['data'], properties: {data: schema}});
  const array = (name: string) => ({type: 'array', items: ref(name)});
  const security = [{resourceBearer: []}, {adminSession: []}];
  const id = [{name: 'id', in: 'path', required: true, schema: {type: 'string', minLength: 1}}];
  const errors = {'400': {description: 'Invalid request', content: json(ref('ModelAdminError'))},
    '401': {description: 'Authentication required'}, '403': {description: 'Product permission required; client key operations also require recent interactive authentication'},
    '409': {description: 'Unique record or routing revision conflict', content: json(ref('ModelAdminError'))}};
  const paths: Record<string, Record<string, unknown>> = {};
  function operation(path: string, method: string, operationId: string, permission: string, response: unknown, request?: string, status = '200') {
    paths[path] ??= {};
    paths[path][method] = {operationId, summary: operationId.replace(/([A-Z])/g, ' $1').trim(), security,
      'x-permission': permission, ...(path.includes('{id}') ? {parameters: id} : {}),
      ...(request ? {requestBody: {required: true, content: json(ref(request))}} : {}),
      responses: {[status]: {description: 'Native response; credential creation and rotation reveal a new API key once with Cache-Control: no-store', content: json(response)}, ...errors}};
  }
  for (const [path, label, schema] of [['/api/route-rules', 'RouteRule', 'RouteRule'], ['/api/heuristics', 'Heuristic', 'Heuristic']] as const) {
    operation(path, 'get', 'list' + label + 's', 'router:routing:read', data(array(schema)));
    operation(path, 'post', 'create' + label, 'router:routing:write', data(ref(schema)), schema + 'Write', '201');
    operation(path + '/{id}', 'put', 'update' + label, 'router:routing:write', data(ref(schema)), schema + 'Write');
    operation(path + '/{id}', 'delete', 'delete' + label, 'router:routing:write', ref('ConsoleOk'));
  }
  operation('/api/client-keys', 'get', 'listClientKeys', 'router:keys:read', data(array('ClientKey')));
  operation('/api/client-keys', 'post', 'createClientKey', 'router:keys:write', data(ref('ClientKeyCreated')), 'ClientKeyWrite', '201');
  operation('/api/client-keys/{id}', 'put', 'updateClientKey', 'router:keys:write', data(ref('ClientKey')), 'ClientKeyUpdate');
  operation('/api/client-keys/{id}', 'delete', 'deleteClientKey', 'router:keys:write', ref('ConsoleOk'));
  operation('/api/client-keys/{id}/rotate', 'post', 'rotateClientKey', 'router:keys:write', data(ref('ClientKeyRotated')));
  operation('/api/client-keys/{id}/usage', 'get', 'readClientKeyUsage', 'router:keys:read', data(ref('ClientKeyUsage')));
  const usage = paths['/api/client-keys/{id}/usage']!.get as {responses: Record<string, unknown>};
  usage.responses['404'] = {description: 'Client key not found'};
  operation('/api/routing/objective', 'get', 'readRoutingObjective', 'router:routing:read', data({type: 'object', required: ['config'], properties: {config: ref('RoutingObjectiveRead')}}));
  operation('/api/routing/objective', 'put', 'updateRoutingObjective', 'router:routing:write', data({type: 'object', required: ['config'], properties: {config: ref('RoutingObjectiveRead')}}), 'RoutingObjective');
  operation('/api/testing/run', 'post', 'runRoutingTest', 'router:testing:write', data(ref('RoutingTestResult')), 'RoutingTestRequest');
  operation('/api/testing/preview', 'post', 'previewRoutingSelection', 'router:testing:read', ref('RoutingPreview'), 'RoutingPreviewRequest');
  operation('/api/routing/revisions', 'get', 'listRoutingRevisions', 'router:routing:read', ref('RoutingRevisions'));
  operation('/api/routing/revisions', 'post', 'applyRoutingRevision', 'router:routing:write', ref('RoutingApplied'), 'RoutingApplyRequest');
  operation('/api/routing/revisions/{id}/rollback', 'post', 'rollbackRoutingRevision', 'router:routing:write', ref('RoutingSnapshot'), 'RoutingRollbackRequest');
  for (const [path, name, result] of [['/api/telemetry', 'Telemetry', ref('Telemetry')], ['/api/traces', 'Traces', data(array('Trace'))],
    ['/api/audit', 'Audit', data(array('AuditEvent'))], ['/api/runtime-settings', 'RuntimeSettings', data(array('RuntimeSetting'))]] as const)
    operation(path, 'get', 'read' + name, path === '/api/runtime-settings' ? 'router:settings:read' : 'router:admin:read', result);
  operation('/api/providers/codex-oauth/status', 'get', 'readCodexOAuthStatus', 'router:providers:read', data(ref('CodexOAuthStatus')));
  operation('/api/providers/codex-oauth/start', 'post', 'startCodexOAuth', 'router:providers:write', data(ref('CodexOAuthStart')));
  operation('/api/providers/codex-oauth/check', 'post', 'checkCodexOAuth', 'router:providers:write', data(ref('CodexOAuthResult')), 'CodexOAuthCheck');
  operation('/api/docs/index', 'get', 'readApiDocsIndex', 'router:admin:read', ref('DocsIndex'));
  paths['/api/auth/me'] = {get: {operationId: 'readAuthenticatedPrincipal', summary: 'Read this authenticated product principal and permissions', security, responses: {'200': {description: 'Public product principal without credential storage', content: json(ref('AdminMe'))}, '401': errors['401']}}};
  return {paths, schemas};
}
