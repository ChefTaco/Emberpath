// Public browser-safe Emberpath model administration contracts.
// Apache-2.0; no persistence, signing, credential storage or backend imports.
import {z} from 'zod';
export const modelAdminContractVersion = 1;

export const endpointKindSchema = z.enum([
  'v1.models',
  'v1.responses',
  'v1.chat.completions',
  'v1.completions',
  'v1.embeddings',
  'v1.audio.transcriptions',
  'v1.audio.translations',
  'v1.images.generations',
  'v1.moderations',
  'ollama.native',
  'vllm.native',
]);

export const providerCapabilitySchema = z.object({
  reasoning: z.boolean().optional(),
  tools: z.boolean().optional(),
  jsonSchema: z.boolean().optional(),
  vision: z.boolean().optional(),
  audio: z.boolean().optional(),
  video: z.boolean().optional(),
  embeddings: z.boolean().optional(),
  longContext: z.boolean().optional(),
  streaming: z.boolean().optional(),
  passthroughRoutes: z.array(z.string().min(1)).optional(),
  supportedRoutes: z.array(endpointKindSchema).optional(),
  tags: z.array(z.string().min(1)).optional(),
  maxContextWindow: z.number().int().positive().optional(),
  inputCostPerMillionTokens: z.number().min(0).optional(),
  outputCostPerMillionTokens: z.number().min(0).optional(),
  qualityScore: z.number().min(0).max(100).optional(),
  throughputTokensPerSecond: z.number().positive().optional(),
}).strict();

export const providerModelSchema = z.object({
  model: z.string().min(1),
  displayName: z.string().optional(),
  enabled: z.boolean().default(true),
  maxContextWindow: z.number().int().positive().optional(),
  capabilityJson: providerCapabilitySchema.default({}),
}).strict();

export const providerSchema = z.object({
  slug: z.string().min(2),
  name: z.string().min(2),
  kind: z.enum(['OPENAI', 'CODEX', 'OPENAI_GENERIC', 'OPENROUTER', 'ANTHROPIC', 'OLLAMA', 'LLAMACPP', 'VLLM']),
  baseUrl: z.url(),
  authMode: z.enum(['NONE', 'BEARER', 'API_KEY', 'HEADER']).default('BEARER'),
  authHeaderName: z.string().default('Authorization'),
  authSecret: z.string().optional(),
  defaultHeaders: z.record(z.string(), z.string()).default({}),
  capabilities: providerCapabilitySchema.default({}),
  timeoutMs: z.number().int().positive().default(120000),
  maxRetries: z.number().int().min(0).default(1),
  concurrency: z.number().int().positive().default(16),
  priority: z.number().int().default(100),
  weight: z.number().int().positive().default(100),
  failoverGroup: z.string().optional(),
  enabled: z.boolean().default(true),
  models: z.array(providerModelSchema).default([]),
}).strict();

export const modelAliasSchema = z.object({
  alias: z.string().min(1),
  providerId: z.string().optional(),
  upstreamModel: z.string().default(''),
  enabled: z.boolean().default(true),
  description: z.string().optional(),
}).strict();

// Native read records intentionally differ from strict write requests.
export const providerModelReadSchema = z.object({
  id: z.string(), providerId: z.string(), model: z.string(), displayName: z.string().nullable(),
  enabled: z.boolean(), maxContextWindow: z.number().nullable(), capabilityJson: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
});
export const providerReadSchema = z.object({
  id: z.string(), slug: z.string(), name: z.string(), kind: providerSchema.shape.kind,
  baseUrl: z.string(), authMode: z.enum(['NONE', 'BEARER', 'API_KEY', 'HEADER']), authHeaderName: z.string(),
  authSecretMasked: z.string().nullable(), defaultHeaders: z.record(z.string(), z.string()),
  capabilities: providerCapabilitySchema, timeoutMs: z.number(), maxRetries: z.number(), concurrency: z.number(),
  priority: z.number(), weight: z.number(), failoverGroup: z.string().nullable(), enabled: z.boolean(),
  lastHealthStatus: z.string().nullable(), lastHealthError: z.string().nullable(), lastHealthAt: z.string().nullable(),
  models: z.array(providerModelReadSchema),
});
export const providerSummarySchema = z.object({id: z.string(), slug: z.string(), name: z.string(), kind: providerSchema.shape.kind});
export const modelAliasReadSchema = z.object({
  id: z.string(), alias: z.string(), providerId: z.string().nullable(), upstreamModel: z.string(),
  enabled: z.boolean(), description: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
  provider: providerSummarySchema.nullable().optional(),
});
export const modelAdminErrorSchema = z.object({error: z.string(), issues: z.array(z.unknown()).optional()});
export type ProviderWriteRequest = z.input<typeof providerSchema>;
export type ProviderModelWriteRequest = z.input<typeof providerModelSchema>;
export type ModelAliasWriteRequest = z.input<typeof modelAliasSchema>;


export const routeRuleMatchSchema = z.object({
  paths: z.array(z.string().min(1)).optional(),
  models: z.array(z.string().min(1)).optional(),
  endpointKinds: z.array(endpointKindSchema).optional(),
}).strict();

export const routeRuleActionSchema = z.object({
  providerIds: z.array(z.string().min(1)).optional(),
  providerKinds: z.array(providerSchema.shape.kind).optional(),
  requiredTag: z.string().min(1).optional(),
  deny: z.boolean().optional(),
  denyReason: z.string().min(1).optional(),
}).strict();


export const heuristicActionSchema = z.object({
  action: z.enum(['rerank', 'trace-detail', 'deny']),
  targetTag: z.string().min(1).optional(),
  detail: z.enum(['low', 'high']).optional(),
  reason: z.string().min(1).optional(),
}).strict();


function parseJsonString(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function jsonStringSchema(label: string): z.ZodType<string> {
  return z.string().superRefine((value, context) => {
    try {
      parseJsonString(value);
    } catch {
      context.addIssue({ code: 'custom', message: `${label} must be valid JSON` });
    }
  });
}

function jsonStringMatching<T>(label: string, schema: z.ZodType<T>): z.ZodType<string> {
  return z.string().superRefine((value, context) => {
    let parsed: unknown;
    try {
      parsed = parseJsonString(value);
    } catch {
      context.addIssue({ code: 'custom', message: `${label} must be valid JSON` });
      return;
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      context.addIssue({ code: 'custom', message: `${label} does not match the expected shape` });
    }
  });
}

const recordMetadata = {
  id: z.string().min(1).optional(), createdAt: z.iso.datetime({offset: true}).optional(), updatedAt: z.iso.datetime({offset: true}).optional(),
};
const importProviderModelSchema = z.object({
  ...recordMetadata, providerId: z.string().min(1).optional(),
  model: z.string().min(1),
  displayName: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  maxContextWindow: z.number().int().positive().nullable().optional(),
  capabilityJson: jsonStringMatching('model capabilityJson', providerCapabilitySchema).nullable().optional(),
}).strict();

const importProviderSchema = z.object({
  ...recordMetadata,
  slug: z.string().min(2),
  name: z.string().min(2),
  kind: providerSchema.shape.kind,
  baseUrl: z.url(),
  authMode: z.enum(['NONE', 'BEARER', 'API_KEY', 'HEADER']).optional(),
  authHeaderName: z.string().optional(),
  encryptedAuthSecret: z.string().nullable().optional(),
  defaultHeadersJson: jsonStringMatching('defaultHeadersJson', z.record(z.string(), z.string())).nullable().optional(),
  capabilityJson: jsonStringMatching('capabilityJson', providerCapabilitySchema).nullable().optional(),
  passthroughJson: jsonStringMatching('passthroughJson', z.array(z.string())).nullable().optional(),
  lastHealthStatus: z.string().nullable().optional(), lastHealthError: z.string().nullable().optional(),
  lastHealthAt: z.iso.datetime({offset: true}).nullable().optional(),
  tlsInsecure: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).optional(),
  concurrency: z.number().int().positive().optional(),
  priority: z.number().int().optional(),
  weight: z.number().int().positive().optional(),
  failoverGroup: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  models: z.array(importProviderModelSchema).optional(),
}).strict();

const importModelAliasSchema = z.object({
  ...recordMetadata,
  alias: z.string().min(1),
  providerId: z.string().nullable().optional(),
  upstreamModel: z.string(),
  enabled: z.boolean().optional(),
  description: z.string().nullable().optional(),
}).strict();

const importRouteRuleSchema = z.object({
  ...recordMetadata,
  name: z.string().min(2),
  kind: z.enum(['MODEL_ALIAS', 'PROVIDER_PREFERENCE', 'CAPABILITY', 'SAFETY', 'PASSTHROUGH', 'LOCAL_ONLY']),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
  matchJson: jsonStringMatching('route matchJson', routeRuleMatchSchema),
  actionJson: jsonStringMatching('route actionJson', routeRuleActionSchema),
}).strict();

const importHeuristicRuleSchema = z.object({
  ...recordMetadata,
  name: z.string().min(2),
  category: z.string().min(2),
  pattern: z.string().min(2),
  score: z.number().int().optional(),
  enabled: z.boolean().optional(),
  actionJson: jsonStringMatching('heuristic actionJson', heuristicActionSchema),
}).strict();

const importRuntimeSettingSchema = z.object({
  ...recordMetadata,
  key: z.string().min(1),
  valueJson: jsonStringSchema('runtime setting valueJson'),
}).strict();

export const configImportSchema = z.object({
  version: z.literal(1).optional(), exportedAt: z.iso.datetime({offset: true}).optional(),
  data: z.object({
    providers: z.array(importProviderSchema).optional(),
    aliases: z.array(importModelAliasSchema).optional(),
    routeRules: z.array(importRouteRuleSchema).optional(),
    heuristicRules: z.array(importHeuristicRuleSchema).optional(),
    runtimeSettings: z.array(importRuntimeSettingSchema).optional(),
  }).strict(),
}).strict();


export const configExportSchema = configImportSchema.extend({version: z.literal(1), exportedAt: z.iso.datetime({offset: true}),
  data: configImportSchema.shape.data.extend({providers: z.array(importProviderSchema.omit({encryptedAuthSecret: true})),
    aliases: z.array(importModelAliasSchema), routeRules: z.array(importRouteRuleSchema),
    heuristicRules: z.array(importHeuristicRuleSchema), runtimeSettings: z.array(importRuntimeSettingSchema)})});
export type ConfigImportRequest = z.input<typeof configImportSchema>;
