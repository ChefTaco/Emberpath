import { RouteRuleKind } from '../generated/prisma/client.js';
import { z } from 'zod';

import {endpointKindSchema, providerCapabilitySchema, providerModelSchema, providerSchema, modelAliasSchema, routeRuleMatchSchema, routeRuleActionSchema, heuristicActionSchema, configImportSchema} from '../contracts/model-admin.js';
export {endpointKindSchema, providerCapabilitySchema, providerModelSchema, providerSchema, modelAliasSchema, routeRuleMatchSchema, routeRuleActionSchema, heuristicActionSchema, configImportSchema} from '../contracts/model-admin.js';

export const routeRuleSchema = z.object({
  name: z.string().min(2),
  kind: z.enum(RouteRuleKind),
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

export type ProviderModelInput = z.infer<typeof providerModelSchema>;
export type ModelAliasInput = z.infer<typeof modelAliasSchema>;
