import { AuthMode, ProviderKind, RouteRuleKind } from '../generated/prisma/client.js';
import { z } from 'zod';

const endpointKindSchema = z.enum([
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
  kind: z.enum(ProviderKind),
  baseUrl: z.url(),
  authMode: z.enum(AuthMode).default(AuthMode.BEARER),
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

export const routeRuleMatchSchema = z.object({
  paths: z.array(z.string().min(1)).optional(),
  models: z.array(z.string().min(1)).optional(),
  endpointKinds: z.array(endpointKindSchema).optional(),
}).strict();

export const routeRuleActionSchema = z.object({
  providerIds: z.array(z.string().min(1)).optional(),
  providerKinds: z.array(z.enum(ProviderKind)).optional(),
  requiredTag: z.string().min(1).optional(),
  deny: z.boolean().optional(),
  denyReason: z.string().min(1).optional(),
}).strict();

export const routeRuleSchema = z.object({
  name: z.string().min(2),
  kind: z.enum(RouteRuleKind),
  priority: z.number().int().default(100),
  enabled: z.boolean().default(true),
  matchJson: routeRuleMatchSchema,
  actionJson: routeRuleActionSchema,
}).strict();

export const heuristicActionSchema = z.object({
  action: z.enum(['rerank', 'trace-detail', 'deny']),
  targetTag: z.string().min(1).optional(),
  detail: z.enum(['low', 'high']).optional(),
  reason: z.string().min(1).optional(),
}).strict();

export const heuristicSchema = z.object({
  name: z.string().min(2),
  category: z.string().min(2),
  pattern: z.string().min(2),
  score: z.number().int().default(10),
  enabled: z.boolean().default(true),
  actionJson: heuristicActionSchema,
}).strict();

export const adaptiveRoutingSchema = z.object({
  enabled: z.boolean(),
  weight: z.number().min(0).max(10).optional(),
  windowMinutes: z.number().int().positive().max(10080).optional(),
  minSamples: z.number().int().min(0).max(100000).optional(),
  latencyTargetMs: z.number().int().positive().max(600000).optional(),
}).strict();

export const routingObjectiveSchema = z.object({
  goal: z.enum(['balanced', 'cheapest', 'fastest', 'highest-quality']),
  costWeight: z.number().min(0).max(10).optional(),
  qualityWeight: z.number().min(0).max(10).optional(),
  throughputWeight: z.number().min(0).max(10).optional(),
  missingPricePenalty: z.number().min(0).max(1000).optional(),
}).strict();

export const clientKeyMetadataSchema = z.object({
  owner: z.string().min(1).optional(),
  purpose: z.string().min(1).optional(),
  scopes: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string().min(1)).optional(),
  environment: z.enum(['dev', 'test', 'staging', 'prod']).optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  rotation: z.object({
    cadenceDays: z.number().int().positive().optional(),
    lastRotatedAt: z.iso.datetime({ offset: true }).optional(),
    nextRotateBy: z.iso.datetime({ offset: true }).optional(),
  }).strict().optional(),
  quota: z.object({
    dailyRequests: z.number().int().positive().optional(),
    monthlyRequests: z.number().int().positive().optional(),
    dailyTokens: z.number().int().positive().optional(),
    monthlyTokens: z.number().int().positive().optional(),
    warnAtPercent: z.number().int().min(1).max(99).optional(),
  }).strict().optional(),
  notes: z.string().max(2000).optional(),
  labels: z.record(z.string(), z.string()).optional(),
}).strict();

export const clientKeySchema = z.object({
  name: z.string().min(2),
  metadata: clientKeyMetadataSchema.default({}),
}).strict();

export const clientKeyUpdateSchema = z.object({
  name: z.string().min(2).optional(),
  enabled: z.boolean().optional(),
  metadata: clientKeyMetadataSchema.optional(),
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

const importProviderModelSchema = z.object({
  model: z.string().min(1),
  displayName: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  maxContextWindow: z.number().int().positive().nullable().optional(),
  capabilityJson: jsonStringMatching('model capabilityJson', providerCapabilitySchema).nullable().optional(),
}).strict();

const importProviderSchema = z.object({
  slug: z.string().min(2),
  name: z.string().min(2),
  kind: z.enum(ProviderKind),
  baseUrl: z.url(),
  authMode: z.enum(AuthMode).optional(),
  authHeaderName: z.string().optional(),
  encryptedAuthSecret: z.string().nullable().optional(),
  defaultHeadersJson: jsonStringMatching('defaultHeadersJson', z.record(z.string(), z.string())).nullable().optional(),
  capabilityJson: jsonStringMatching('capabilityJson', providerCapabilitySchema).nullable().optional(),
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
  alias: z.string().min(1),
  providerId: z.string().nullable().optional(),
  upstreamModel: z.string(),
  enabled: z.boolean().optional(),
  description: z.string().nullable().optional(),
}).strict();

const importRouteRuleSchema = z.object({
  name: z.string().min(2),
  kind: z.enum(RouteRuleKind),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
  matchJson: jsonStringMatching('route matchJson', routeRuleMatchSchema),
  actionJson: jsonStringMatching('route actionJson', routeRuleActionSchema),
}).strict();

const importHeuristicRuleSchema = z.object({
  name: z.string().min(2),
  category: z.string().min(2),
  pattern: z.string().min(2),
  score: z.number().int().optional(),
  enabled: z.boolean().optional(),
  actionJson: jsonStringMatching('heuristic actionJson', heuristicActionSchema),
}).strict();

const importRuntimeSettingSchema = z.object({
  key: z.string().min(1),
  valueJson: jsonStringSchema('runtime setting valueJson'),
}).strict();

export const configImportSchema = z.object({
  data: z.object({
    providers: z.array(importProviderSchema).optional(),
    aliases: z.array(importModelAliasSchema).optional(),
    routeRules: z.array(importRouteRuleSchema).optional(),
    heuristicRules: z.array(importHeuristicRuleSchema).optional(),
    runtimeSettings: z.array(importRuntimeSettingSchema).optional(),
  }).strict().optional(),
}).strict();

export type ProviderModelInput = z.infer<typeof providerModelSchema>;
export type ModelAliasInput = z.infer<typeof modelAliasSchema>;
