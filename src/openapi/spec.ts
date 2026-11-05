import type { ProviderKind } from '../generated/prisma/client.js';
import { packageInfo } from '../config/paths.js';
import { z } from 'zod';
import { actorCredentialSchema } from '../admin/actor-credentials.js';
import {modelAdminOpenApi} from './model-admin.js';

export interface BuiltinApiDocEntry {
  scope: 'router' | 'provider';
  method: string;
  route: string;
  title: string;
  summary: string;
  implemented: boolean;
  rationale?: string;
  providerKind?: ProviderKind;
}

export const builtinApiDocs: BuiltinApiDocEntry[] = [
  { scope: 'router', method: 'GET', route: '/v1/models', title: 'List models', summary: 'Aggregated model registry across configured providers', implemented: true },
  { scope: 'router', method: 'POST', route: '/v1/responses', title: 'Responses API', summary: 'OpenAI-compatible responses proxy endpoint', implemented: true },
  { scope: 'router', method: 'POST', route: '/v1/chat/completions', title: 'Chat Completions', summary: 'OpenAI-compatible chat proxy endpoint', implemented: true },
  { scope: 'router', method: 'POST', route: '/v1/completions', title: 'Completions', summary: 'OpenAI-compatible completions proxy endpoint', implemented: true },
  { scope: 'router', method: 'POST', route: '/v1/embeddings', title: 'Embeddings', summary: 'OpenAI-compatible embeddings proxy endpoint', implemented: true },
  { scope: 'router', method: 'POST', route: '/v1/audio/transcriptions', title: 'Audio Transcriptions', summary: 'OpenAI-compatible audio transcription proxy endpoint', implemented: true },
  { scope: 'router', method: 'POST', route: '/v1/audio/translations', title: 'Audio Translations', summary: 'OpenAI-compatible audio translation proxy endpoint', implemented: true },
  { scope: 'router', method: 'POST', route: '/v1/images/generations', title: 'Image Generations', summary: 'OpenAI-compatible image generation proxy endpoint', implemented: true },
  { scope: 'router', method: 'POST', route: '/v1/moderations', title: 'Moderations', summary: 'OpenAI-compatible moderation proxy endpoint', implemented: true },
  { scope: 'provider', method: 'GET', route: '/api/tags', title: 'Ollama Tags', summary: 'Enumerate Ollama models', implemented: true, providerKind: 'OLLAMA' },
  { scope: 'provider', method: 'POST', route: '/api/show', title: 'Ollama Show', summary: 'Show Ollama model metadata', implemented: true, providerKind: 'OLLAMA' },
  { scope: 'provider', method: 'GET', route: '/api/ps', title: 'Ollama Running Models', summary: 'List active Ollama model runners', implemented: true, providerKind: 'OLLAMA' },
  { scope: 'provider', method: 'POST', route: '/api/embed', title: 'Ollama Embed', summary: 'Native Ollama embedding route', implemented: true, providerKind: 'OLLAMA' },
  { scope: 'provider', method: 'POST', route: '/api/generate', title: 'Ollama Generate', summary: 'Native Ollama completion route', implemented: true, providerKind: 'OLLAMA' },
  { scope: 'provider', method: 'POST', route: '/api/chat', title: 'Ollama Chat', summary: 'Native Ollama chat route', implemented: true, providerKind: 'OLLAMA' },
  { scope: 'provider', method: 'POST', route: '/api/pull', title: 'Ollama Pull', summary: 'Policy-gated Ollama model pull', implemented: true, providerKind: 'OLLAMA', rationale: 'Disabled unless an operator explicitly enables native pull operations.' },
  { scope: 'provider', method: 'POST', route: '/tokenize', title: 'vLLM Tokenize', summary: 'Native vLLM tokenize route', implemented: true, providerKind: 'VLLM' },
  { scope: 'provider', method: 'POST', route: '/detokenize', title: 'vLLM Detokenize', summary: 'Native vLLM detokenize route', implemented: true, providerKind: 'VLLM' },
  { scope: 'provider', method: 'GET', route: '/version', title: 'vLLM Version', summary: 'Native vLLM version route', implemented: true, providerKind: 'VLLM' },
  { scope: 'provider', method: 'POST', route: '/pooling', title: 'vLLM Pooling', summary: 'Deferred native pooling route', implemented: false, providerKind: 'VLLM', rationale: 'Deferred from v1 because the initial router scope focuses on tokenize/detokenize/version as the highest-value non-standard calls.' },
];

export function buildRouterOpenApiDocument(adminBaseUrl: string): Record<string, unknown> {
  const modelAdmin = modelAdminOpenApi();
  const paths: Record<string, unknown> = Object.fromEntries(
    builtinApiDocs.map((entry) => [
      entry.route,
      {
        [entry.method.toLowerCase()]: {
          summary: entry.summary,
          operationId: `${entry.method.toLowerCase()}_${entry.route.replace(/[\/{}]/g, '_')}`,
          responses: {
            '200': {
              description: 'Success',
            },
          },
        },
      },
    ]),
  );

  for (const [path,method,summary] of [
    ['/api/hive/updates','get','Available same-major Hive release and configuration changes'],
    ['/api/hive/upgrades/status','get','Durable upgrade coordinator outcome'],
    ['/api/hive/upgrades/plan','post','Prepare a reviewed release upgrade plan'],
    ['/api/hive/upgrades/apply','post','Apply the exact reviewed plan with recent operator authentication'],
  ]) paths[path!] = {[method!]:{summary,security:[{adminSession:[]}],responses:{'200':{description:'Success'},...(path?.endsWith('/apply')?{'202':{description:'Upgrade accepted'}}:{}),'401':{description:'Authentication required'},'403':{description:'Permission, recent authentication or origin check failed'},'409':{description:'Upgrade plan changed or coordinator is unavailable'}}}};
  for (const path of ['/api/docs/index','/api/docs/openapi.json','/api/docs/providers/{providerId}']) paths[path]={get:{summary:'Authenticated API documentation',security:[{resourceBearer:[]},{adminSession:[]}],...(path.includes('{providerId}')?{parameters:[{name:'providerId',in:'path',required:true,schema:{type:'string'}}]}:{}),responses:{'200':{description:'Documentation'},'401':{description:'Authentication required'}}}};
  for (const [path, method] of [['/api/client-keys/operations/{operationId}', 'post'], ['/api/client-keys/operations/{operationId}/receipt', 'delete']] as const) paths[path] = { [method]: {
    summary: method === 'post' ? 'Apply or replay an owned, idempotent native credential operation' : 'Acknowledge an owned credential receipt',
    security: [{ resourceBearer: [] }, { adminSession: [] }],
    parameters: [{ name: 'operationId', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } }],
    ...(method === 'post' ? { requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(actorCredentialSchema) } } } } : {}),
    responses: { '200': { description: 'Exact receipt; Cache-Control: no-store', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, resourceId: { type: 'string' }, operationId: { type: 'string' }, apiKey: { type: 'string', writeOnly: true } }, required: ['ok'] } } } }, '401': { description: 'Authentication required' }, '403': { description: 'router:keys:write and recent interactive authentication required' }, '409': { description: 'Operation owner, policy or resource conflict' }, '410': { description: 'Receipt expired or acknowledged; no automatic rotation' } },
  } };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Emberpath API',
      version: packageInfo().version,
      description: 'Model routing and administration baseline. Complete request/response schema coverage remains pending.',
    },
    servers: [{ url: adminBaseUrl }],
    paths: {...paths, ...modelAdmin.paths},
    components:{schemas: modelAdmin.schemas, securitySchemes:{resourceBearer:{type:'http',scheme:'bearer',bearerFormat:'JWT'},adminSession:{type:'apiKey',in:'cookie',name:'hive_router_admin'}}},
  };
}
