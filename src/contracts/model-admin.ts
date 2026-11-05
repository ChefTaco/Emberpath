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
// Read native measured/historical values without applying current write-policy limits.
export const providerCapabilityReadSchema = providerCapabilitySchema.extend({
  maxContextWindow: z.number().optional(), inputCostPerMillionTokens: z.number().optional(),
  outputCostPerMillionTokens: z.number().optional(), qualityScore: z.number().optional(),
  throughputTokensPerSecond: z.number().optional(),
});
export const providerReadSchema = z.object({
  id: z.string(), slug: z.string(), name: z.string(), kind: providerSchema.shape.kind,
  baseUrl: z.string(), authMode: z.enum(['NONE', 'BEARER', 'API_KEY', 'HEADER']), authHeaderName: z.string(),
  authSecretMasked: z.string().nullable(), defaultHeaders: z.record(z.string(), z.string()),
  capabilities: providerCapabilityReadSchema, timeoutMs: z.number(), maxRetries: z.number(), concurrency: z.number(),
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


// Recovery downloads describe native stored records, not valid future writes.
// Do not parse/rewrite historical JSON text or impose import-only minimum lengths.
const archiveMetadata = {id: z.string(), createdAt: z.string(), updatedAt: z.string()};
export const configExportSchema = z.object({version: z.literal(1), exportedAt: z.string(), data: z.object({
  providers: z.array(z.object({
    ...archiveMetadata, slug: z.string(), name: z.string(), kind: providerSchema.shape.kind, baseUrl: z.string(),
    authMode: providerSchema.shape.authMode.unwrap(), authHeaderName: z.string(),
    defaultHeadersJson: z.string().nullable(), capabilityJson: z.string().nullable(), passthroughJson: z.string().nullable(),
    lastHealthStatus: z.string().nullable(), lastHealthError: z.string().nullable(), lastHealthAt: z.string().nullable(),
    tlsInsecure: z.boolean(), timeoutMs: z.number(), maxRetries: z.number(), concurrency: z.number(),
    priority: z.number(), weight: z.number(), failoverGroup: z.string().nullable(), enabled: z.boolean(),
    models: z.array(providerModelReadSchema),
  }).strict()),
  aliases: z.array(z.object({...archiveMetadata, alias: z.string(), providerId: z.string().nullable(), upstreamModel: z.string(), enabled: z.boolean(), description: z.string().nullable()}).strict()),
  routeRules: z.array(z.object({...archiveMetadata, name: z.string(), kind: z.enum(['MODEL_ALIAS', 'PROVIDER_PREFERENCE', 'CAPABILITY', 'SAFETY', 'PASSTHROUGH', 'LOCAL_ONLY']), priority: z.number(), enabled: z.boolean(), matchJson: z.string(), actionJson: z.string()}).strict()),
  heuristicRules: z.array(z.object({...archiveMetadata, name: z.string(), category: z.string(), pattern: z.string(), score: z.number(), enabled: z.boolean(), actionJson: z.string()}).strict()),
  runtimeSettings: z.array(z.object({...archiveMetadata, key: z.string(), valueJson: z.string()}).strict()),
}).strict()}).strict();
export type ConfigImportRequest = z.input<typeof configImportSchema>;

// Native admin requests share these exact schemas with browser clients.
export const routeRuleSchema = z.object({
  name: z.string().min(2),
  kind: z.enum(['MODEL_ALIAS', 'PROVIDER_PREFERENCE', 'CAPABILITY', 'SAFETY', 'PASSTHROUGH', 'LOCAL_ONLY']),
  priority: z.number().int().default(100),
  enabled: z.boolean().default(true),
  matchJson: routeRuleMatchSchema,
  actionJson: routeRuleActionSchema,
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


// These two historical request objects strip unknown fields, as their native API did.
export const routingTestRequestSchema = z.object({
  category: z.string().optional(), modelAlias: z.string().min(1), prompt: z.string().min(1),
  maxResponseChars: z.number().int().min(120).max(8192).optional().default(1500),
});
export const codexOAuthCheckSchema = z.object({loginId: z.string().min(1)});
export const routingPatchSchema = z.object({
  aliases: z.array(modelAliasSchema).max(500).optional(), rules: z.array(routeRuleSchema).max(500).optional(),
  objective: routingObjectiveSchema.optional(),
}).strict();
export const routingPreviewRequestSchema = z.object({cases: z.array(routingTestRequestSchema).min(1).max(30), ...routingPatchSchema.shape});
export const routingApplyRequestSchema = z.object({baseRevision: z.string(), patch: routingPatchSchema});
export const routingRollbackRequestSchema = z.object({baseRevision: z.string()});

const timestamp = z.string(); // Wire dates remain strings; legacy records are not rewritten.
const nullableText = z.string().nullable();
const timestamps = {createdAt: timestamp, updatedAt: timestamp};
export const okSchema = z.object({ok: z.boolean()});
export const routeRuleReadSchema = z.object({id: z.string(), name: z.string(), kind: routeRuleSchema.shape.kind,
  priority: z.number(), enabled: z.boolean(), matchJson: z.string(), actionJson: z.string(), ...timestamps});
export const heuristicReadSchema = z.object({id: z.string(), name: z.string(), category: z.string(), pattern: z.string(),
  score: z.number(), enabled: z.boolean(), actionJson: z.string(), ...timestamps});
export const clientKeyReadSchema = z.object({id: z.string(), name: z.string(), keyPrefix: z.string(), enabled: z.boolean(),
  metadataJson: nullableText, lastUsedAt: timestamp.nullable(), expiresAt: timestamp.nullable(), ...timestamps});
// Creation deliberately returns fewer fields than rotation; both reveal a key once.
export const clientKeyCreatedSchema = z.object({id: z.string(), name: z.string(), keyPrefix: z.string(), apiKey: z.string()});
export const clientKeyRotatedSchema = clientKeyReadSchema.extend({apiKey: z.string()});
export const quotaUsageSchema = z.object({dayRequests: z.number(), monthRequests: z.number(), dayTokens: z.number(), monthTokens: z.number()});
export const clientKeyUsageSchema = z.object({clientApiKeyId: z.string(), name: z.string(),
  history: z.object({cutoverAt: z.number(), historicalCoverage: z.string()}).optional(),
  daily: z.array(z.object({day: z.string(), requests: z.number(), tokens: z.number().nullable(), costUsd: z.number().nullable(), estimatedRequests: z.number()})),
  limits: clientKeyMetadataSchema.shape.quota.unwrap().extend({acceptRetainedHistory: z.boolean().optional()}), usage: quotaUsageSchema,
  allowed: z.boolean(), exceeded: z.array(z.string()), warnings: z.array(z.string()),
});
export const traceEventSchema = z.object({id: z.string(), traceId: z.string(), type: z.string(), phase: nullableText,
  message: nullableText, dataJson: nullableText, occurredAt: timestamp});
export const traceReadSchema = z.object({id: z.string(), requestId: z.string(), method: z.string(), path: z.string(),
  endpointKind: z.string(), routeKey: z.string(), statusCode: z.number().nullable(), outcome: z.string(), estimatedUsage: z.boolean(),
  providerId: nullableText, providerKind: nullableText, providerModel: nullableText, clientApiKeyId: nullableText,
  decisionJson: z.string(), requestHeadersJson: nullableText, responseHeadersJson: nullableText, requestMetaJson: nullableText,
  responseMetaJson: nullableText, usageJson: nullableText, retentionJson: nullableText, requestBodyPath: nullableText,
  responseBodyPath: nullableText, reasoningBodyPath: nullableText, startedAt: timestamp, endedAt: timestamp.nullable(),
  durationMs: z.number().nullable(), createdAt: timestamp,
  provider: providerSummarySchema.nullable().optional(), clientApiKey: clientKeyReadSchema.nullable().optional(),
  events: z.array(traceEventSchema).optional(),
});
export const telemetrySchema = z.object({totals: z.object({traces: z.number(), failures: z.number(), failovers: z.number()}), latestTrace: traceReadSchema.nullable()});
export const adminUserReadSchema = z.object({id: z.string(), username: z.string(), displayName: nullableText, ...timestamps});
export const auditReadSchema = z.object({id: z.string(), actorType: z.string(), adminUserId: nullableText, action: z.string(),
  entityType: z.string(), entityId: nullableText, metadataJson: nullableText, createdAt: timestamp, adminUser: adminUserReadSchema.nullable()});
export const runtimeSettingReadSchema = z.object({id: z.string(), key: z.string(), valueJson: z.string(), ...timestamps, parsed: z.unknown()});
export const routeObservationSchema = z.object({name: z.string(), category: z.string(), score: z.number(), action: z.string(), details: z.string().optional()});
export const routeDecisionSchema = z.object({selectedProviderId: z.string().optional(), selectedProviderKind: providerSchema.shape.kind.optional(),
  targetModel: z.string().optional(), candidateProviderIds: z.array(z.string()), fallbackProviderIds: z.array(z.string()),
  observations: z.array(routeObservationSchema), triggeredRuleNames: z.array(z.string()), confidence: z.number(),
  denialReason: z.string().optional(), passthroughTargetPath: z.string().optional()});
export const routingTestResultSchema = z.object({requestId: z.string(), category: z.string(), modelAlias: z.string(), prompt: z.string(),
  requestBody: z.string(), targetModel: z.string().optional(), latencyMs: z.number(), success: z.boolean(), statusCode: z.number(),
  providerError: nullableText, responsePreview: z.string(), decision: routeDecisionSchema, candidates: z.array(providerSummarySchema),
  attempts: z.array(z.object({provider: providerSummarySchema, latencyMs: z.number(), statusCode: z.number(), success: z.boolean(), error: nullableText})),
  selectedProvider: providerSummarySchema.extend({model: z.string().optional()}).nullable()});
export const routingObjectiveReadSchema = z.object({goal: routingObjectiveSchema.shape.goal,
  costWeight: z.number().optional(), qualityWeight: z.number().optional(), throughputWeight: z.number().optional(), missingPricePenalty: z.number().optional()});
const routingAliasSnapshotSchema = z.object({alias: z.string(), providerId: z.string().optional(), upstreamModel: z.string(), enabled: z.boolean(), description: z.string().optional()});
const routingRuleSnapshotSchema = z.object({name: z.string(), kind: routeRuleSchema.shape.kind, priority: z.number(), enabled: z.boolean(), matchJson: z.unknown(), actionJson: z.unknown()});
export const routingSnapshotSchema = z.object({revision: z.string(), config: z.object({aliases: z.array(routingAliasSnapshotSchema),
  rules: z.array(routingRuleSnapshotSchema), objective: routingObjectiveReadSchema})});
export const routingHistorySchema = routingSnapshotSchema.extend({operator: z.string(), recordedAt: timestamp});
export const routingRevisionsSchema = routingSnapshotSchema.extend({history: z.array(routingHistorySchema)});
export const routingAppliedSchema = routingSnapshotSchema.extend({previousRevision: z.string()});
export const routingPreviewSchema = z.object({mode: z.literal('selection-only'), inferenceCalls: z.literal(0),
  results: z.array(z.object({category: z.string(), current: routeDecisionSchema, proposed: routeDecisionSchema, changed: z.boolean(),
    rejectedProviders: z.array(z.object({id: z.string(), reason: z.string()}))}))});
export const codexOAuthStatusSchema = z.object({authorized: z.boolean(), provider: providerReadSchema.nullable(),
  accountIdMasked: nullableText.optional(), planType: nullableText.optional(), lastRefreshAt: nullableText.optional(),
  refreshTokenQuarantined: z.boolean().optional()});
export const codexOAuthStartSchema = z.object({loginId: z.string(), deviceAuthId: z.string(), verificationUrl: z.string(),
  userCode: z.string(), intervalSeconds: z.number(), expiresAt: timestamp});
export const codexOAuthResultSchema = z.object({status: z.enum(['pending', 'authorized', 'expired', 'error']), message: z.string().optional(),
  provider: providerReadSchema.nullable().optional(), accountIdMasked: nullableText.optional(), planType: nullableText.optional(), lastRefreshAt: nullableText.optional()});
export const dataSchema = <T extends z.ZodType>(schema: T) => z.object({data: schema});
export const modelConsoleSchemas = {
  routeRules: dataSchema(z.array(routeRuleReadSchema)), routeRule: dataSchema(routeRuleReadSchema),
  heuristics: dataSchema(z.array(heuristicReadSchema)), heuristic: dataSchema(heuristicReadSchema),
  clientKeys: dataSchema(z.array(clientKeyReadSchema)), clientKey: dataSchema(clientKeyReadSchema),
  createdClientKey: dataSchema(clientKeyCreatedSchema), rotatedClientKey: dataSchema(clientKeyRotatedSchema),
  clientKeyUsage: dataSchema(clientKeyUsageSchema), traces: dataSchema(z.array(traceReadSchema)), telemetry: telemetrySchema,
  audit: dataSchema(z.array(auditReadSchema)), runtimeSettings: dataSchema(z.array(runtimeSettingReadSchema)),
  routingObjective: dataSchema(z.object({config: routingObjectiveReadSchema})), routingTest: dataSchema(routingTestResultSchema),
  routingRevisions: routingRevisionsSchema, routingApplied: routingAppliedSchema, routingSnapshot: routingSnapshotSchema,
  routingPreview: routingPreviewSchema, codexOAuthStatus: dataSchema(codexOAuthStatusSchema),
  codexOAuthStart: dataSchema(codexOAuthStartSchema), codexOAuthCheck: dataSchema(codexOAuthResultSchema),
};
export type RouteRule = z.infer<typeof routeRuleReadSchema>;
export type RouteRuleWriteRequest = z.input<typeof routeRuleSchema>;
export type HeuristicRule = z.infer<typeof heuristicReadSchema>;
export type HeuristicWriteRequest = z.input<typeof heuristicSchema>;
export type ClientKeyMetadataInput = z.input<typeof clientKeyMetadataSchema>;
export type ClientKeyCreateRequest = z.input<typeof clientKeySchema>;
export type ClientKeyUpdateRequest = z.input<typeof clientKeyUpdateSchema>;
export type ClientKey = z.infer<typeof clientKeyReadSchema>;
export type Telemetry = z.infer<typeof telemetrySchema>;
export type Trace = z.infer<typeof traceReadSchema>;
export type AuditEvent = z.infer<typeof auditReadSchema>;
export type RuntimeSetting = z.infer<typeof runtimeSettingReadSchema>;
export type RoutingObjectiveConfig = z.input<typeof routingObjectiveSchema>;
export type RoutingGoal = RoutingObjectiveConfig['goal'];
export type RoutingTestRequest = z.input<typeof routingTestRequestSchema>;
export type RoutingTestResult = z.infer<typeof routingTestResultSchema>;
export type CodexOAuthStatus = z.infer<typeof codexOAuthStatusSchema>;
export type CodexOAuthStart = z.infer<typeof codexOAuthStartSchema>;
export type CodexOAuthCheck = z.infer<typeof codexOAuthResultSchema>;
export type Provider = z.infer<typeof providerReadSchema>;
export type ProviderModel = z.infer<typeof providerModelReadSchema>;
export type ModelAlias = z.infer<typeof modelAliasReadSchema>;
export const apiDocSchema = z.object({scope: z.enum(['router', 'provider']), method: z.string(), route: z.string(),
  title: z.string(), summary: z.string(), implemented: z.boolean(), rationale: z.string().optional(), providerKind: providerSchema.shape.kind.optional()});
export const docsIndexSchema = z.object({docs: z.array(apiDocSchema), providers: z.array(providerSummarySchema.extend({baseUrl: z.string(), enabled: z.boolean()}))});
export type ApiDoc = z.infer<typeof apiDocSchema>;
export const adminPrincipalSchema = adminUserReadSchema.extend({roles: z.array(z.string()), permissions: z.array(z.string())});
export const adminMeSchema = z.object({user: adminPrincipalSchema});
