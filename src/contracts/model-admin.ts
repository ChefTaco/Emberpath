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

