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
    AdminMe: contracts.adminMeSchema, DocsIndex: contracts.docsIndexSchema, Trace: contracts.traceReadSchema, TracePage: contracts.tracePageSchema, Telemetry: contracts.telemetrySchema, AuditEvent: contracts.auditReadSchema,
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
  const traces = paths['/api/traces']!.get as {description?: string; parameters?: unknown[]; responses: Record<string, {description: string; content?: unknown}>};
  const traceQuery = z.toJSONSchema(contracts.traceListQuerySchema, {io: 'input'}) as {properties: Record<string, unknown>};
  const traceParameterDescriptions: Record<string, string> = {
    actorId: 'Only traces attributed to this agent ID (from the authenticating client key metadata)',
    clientKeyId: 'Only traces authenticated by this client key ID',
    since: 'Only traces created at or after this ISO 8601 timestamp',
    cursor: 'Opaque nextCursor from the previous page',
    limit: 'Page size; default ' + contracts.traceListDefaultLimit + ', maximum ' + contracts.traceListMaxLimit,
    executionRoot: 'Only traces whose x-hive-execution root is this qualified reference (hx1:<product>:<instance>:<kind>:<id>)',
    executionTask: 'Only traces whose execution self reference starts with this prefix; a task reference also matches its attempts '
      + '(hx1:<product>:<instance>:attempt:<task>/...)',
    executionParent: 'Only traces whose execution parent is this qualified reference',
  };
  traces.description = 'Without any of these query parameters, returns the latest 100 traces as {data}. With at least one, returns '
    + 'a newest-first page as {data, nextCursor}; nextCursor is null on the last page. Invalid parameters return 400. '
    + 'With an execution filter (executionRoot, executionTask or executionParent) each trace also carries execution (client-asserted '
    + 'attribution, never authorization) and attempts (every upstream provider attempt, including retries and failover).';
  traces.parameters = contracts.traceListQueryKeys.map((name) => ({name, in: 'query', required: false,
    description: traceParameterDescriptions[name], schema: name === 'limit'
      ? {type: 'integer', minimum: 1, maximum: contracts.traceListMaxLimit, default: contracts.traceListDefaultLimit}
      : traceQuery.properties[name]}));
  traces.responses['200'] = {...traces.responses['200']!, content: json({anyOf: [data(array('Trace')), ref('TracePage')]})};
  operation('/api/providers/codex-oauth/status', 'get', 'readCodexOAuthStatus', 'router:providers:read', data(ref('CodexOAuthStatus')));
  operation('/api/providers/codex-oauth/start', 'post', 'startCodexOAuth', 'router:providers:write', data(ref('CodexOAuthStart')));
  operation('/api/providers/codex-oauth/check', 'post', 'checkCodexOAuth', 'router:providers:write', data(ref('CodexOAuthResult')), 'CodexOAuthCheck');
  operation('/api/docs/index', 'get', 'readApiDocsIndex', 'router:admin:read', ref('DocsIndex'));
  const stepUpError = {description: 'Step-up proof refused: error is REAUTH_REQUIRED, REAUTH_STALE or REAUTH_INVALID with a reason', content: json({type: 'object', required: ['error'], properties: {error: {type: 'string'}, reason: {type: 'string'}, message: {type: 'string'}}})};
  paths['/api/auth/step-up/challenge'] = {post: {operationId: 'startStepUp', summary: 'Start a step-up: a single-use nonce for a fresh Oathweave authorization',
    description: 'Put the nonce in an authorization request with prompt=login (or max_age) for one of the audiences, then send its ID token to POST /api/auth/step-up within expiresIn seconds. The sign-in must not be older than startedAt.',
    security, responses: {'200': {description: 'Challenge (Cache-Control: no-store)', content: json({type: 'object', required: ['nonce', 'startedAt', 'expiresIn', 'maxAgeSeconds', 'audiences'],
      properties: {nonce: {type: 'string'}, startedAt: {type: 'string', format: 'date-time'}, expiresIn: {type: 'integer'}, maxAgeSeconds: {type: 'integer'}, audiences: {type: 'array', items: {type: 'string'}}}})},
      '401': errors['401'], '503': {description: 'Oathweave is not configured (STEP_UP_UNAVAILABLE)'}}}};
  paths['/api/auth/step-up'] = {post: {operationId: 'stepUpWithIdToken', summary: 'Confirm a recent sign-in with a fresh Oathweave ID token',
    description: 'Send the ID token of a fresh Oathweave authorization (prompt=login or max_age, PKCE, the nonce of POST /api/auth/step-up/challenge) issued to a client in EMBERPATH_STEP_UP_AUDIENCES (default hivexui-emberpath). '
      + 'Emberpath verifies the signature, issuer (OATHWEAVE_ISSUER), audience, lifetime, the challenge nonce (single use), that sub and sid are the caller\'s, and that auth_time is within EMBERPATH_STEP_UP_MAX_AGE_SECONDS (default 300) and not before the challenge. '
      + 'Credential and policy changes of this session then count from that auth_time for 15 minutes. No password is accepted.',
    security, requestBody: {required: true, content: json({type: 'object', required: ['idToken'], additionalProperties: false, properties: {idToken: {type: 'string', minLength: 1, maxLength: 16384}}})},
    responses: {'200': {description: 'Step-up recorded', content: json({type: 'object', required: ['ok', 'authTime', 'recentUntil'], properties: {ok: {const: true}, authTime: {type: 'string', format: 'date-time'}, recentUntil: {type: 'string', format: 'date-time'}}})},
      '400': {description: 'No ID token in the body (REAUTH_REQUIRED)'}, '401': stepUpError, '503': {description: 'Oathweave is not configured (STEP_UP_UNAVAILABLE) or its keys are unavailable (REAUTH_UNAVAILABLE)'}}}};
  const retired = {'410': {description: 'In iam-oidc mode, gone unless EMBERPATH_PASSWORD_RELAY=true: error PASSWORD_RELAY_DISABLED, with stepUp and docs links'}};
  const deprecation = {Deprecation: {description: 'RFC 9745 deprecation date', schema: {type: 'string'}}, Sunset: {description: 'RFC 8594 sunset date', schema: {type: 'string'}}};
  paths['/api/auth/login'] = {post: {operationId: 'passwordSignIn', summary: 'Password sign-in: OS (PAM) mode; the iam-oidc Oathweave relay is deprecated',
    description: 'OS mode (HIVE_ROUTER_AUTH_MODE=os) checks the OS password through PAM and is unchanged. In iam-oidc mode this relayed the password to Oathweave: that relay is deprecated (Deprecation and Sunset headers), off by default (410 Gone) and removed in the next major; EMBERPATH_PASSWORD_RELAY=true keeps it for now. Sign in through Oathweave instead.',
    requestBody: {required: true, content: json({type: 'object', required: ['username', 'password'], properties: {username: {type: 'string'}, password: {type: 'string'}, mfaCode: {type: 'string'}}})},
    responses: {'200': {description: 'Signed in', headers: deprecation}, '401': {description: 'Invalid credentials or MFA_REQUIRED'}, ...retired}}};
  paths['/api/auth/reauthenticate'] = {post: {operationId: 'passwordReauthenticate', summary: 'Confirm the password of an admin session: OS mode; the iam-oidc relay is deprecated',
    description: 'As POST /api/auth/login: unchanged in OS mode; in iam-oidc mode deprecated, 410 Gone unless EMBERPATH_PASSWORD_RELAY=true, removed in the next major. Use POST /api/auth/step-up instead.', security: [{adminSession: []}],
    requestBody: {required: true, content: json({type: 'object', required: ['password'], properties: {password: {type: 'string'}, mfaCode: {type: 'string'}}})},
    responses: {'200': {description: 'Re-authenticated', headers: deprecation}, '401': {description: 'Re-authentication failed or MFA_REQUIRED'}, ...retired}}};
  paths['/api/auth/me'] = {get: {operationId: 'readAuthenticatedPrincipal', summary: 'Read this authenticated product principal and permissions', security, responses: {'200': {description: 'Public product principal without credential storage', content: json(ref('AdminMe'))}, '401': errors['401']}}};
  return {paths, schemas};
}
