import { sqliteWrite } from '../storage/sqlite-write.js';
import { quotaLedger } from "../security/quota.js";
import { TraceOutcome, type Prisma } from '../generated/prisma/client.js';
import { prisma } from '../storage/client.js';
import { prettyJson, safeJsonParse } from '../utils/json.js';
import { storeBody } from '../storage/bodies.js';
import { loadEnv } from '../config/env.js';
import type { RouteDecision } from '../providers/types.js';
import type { DecisionsRequestSummary } from '../decisions-api/schema.js';

export interface UsageSnapshot {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  inputWords?: number | undefined;
  outputWords?: number | undefined;
  totalWords?: number | undefined;
  reasoningTokens?: number | undefined;
  /** Input tokens served from the provider's prompt cache (Decisions API). */
  cachedInputTokens?: number | undefined;
  /** Input tokens written to the provider's prompt cache (Decisions API). */
  cacheWriteInputTokens?: number | undefined;
}

export interface TraceRequestMeta {
  contentType: string | undefined;
  model: string | undefined;
  routingTrait: string | undefined;
  stream: boolean;
  modalities: string[];
  /** Decisions API only: counts and types, never question or input text. */
  decisionsApi?: DecisionsRequestSummary | undefined;
}

export interface DecisionsResponseSummary {
  backend: string;
  answerTypes: Record<string, number>;
}

export type TraceResponseMeta =
  | { contentType: string; truncated?: boolean; bytesReceived?: number }
  | { contentType: string; streamPhase: 'pre-first-byte' | 'mid-stream'; reachedClient: boolean; retrySafe: boolean }
  | { denialReason: string }
  | { error: string }
  | { contentType: string; decisionsApi: DecisionsResponseSummary }
  | { error: string; decisionsApi: { rejections: Array<{ provider: string; backend?: string | undefined; reason: string }> } }
  | Record<string, never>;

export type TraceEventInput =
  | { type: 'provider.skipped'; phase: 'routing'; message: string }
  | { type: 'provider.failover'; phase: 'execution'; message: string }
  | { type: 'provider.stream_failover'; phase: 'execution'; message: string; data: { phase: string } }
  | { type: 'provider.error'; phase: 'execution'; message: string; data: { providerId: string; attempt: number } }
  | { type: 'route.denied'; phase: 'routing'; message: string }
  | { type: 'provider.ineligible'; phase: 'routing'; message: string; data: { provider: string; backend?: string | undefined } };

export interface FinalizeTraceInput {
  traceId: string;
  statusCode?: number | undefined;
  outcome: TraceOutcome;
  providerId?: string | undefined;
  providerKind?: string | undefined;
  providerModel?: string | undefined;
  responseHeaders?: Record<string, string> | undefined;
  responseMeta?: TraceResponseMeta | undefined;
  usage?: UsageSnapshot | undefined;
  estimatedUsage?: boolean | undefined;
  responseBody?: string | undefined;
  reasoningBody?: string | undefined;
  /**
   * `input-only` prices input tokens alone (the Decisions API bills only input
   * tokens), so only the provider's declared input price is required.
   */
  pricing?: 'input-and-output' | 'input-only' | undefined;
}

export function shouldCaptureTraceBodies(metadataJson: string | null | undefined): boolean {
  return safeJsonParse<{ tracePrivacy?: string }>(metadataJson, {}).tracePrivacy !== 'metadata-only';
}

const ACTOR_ID_PATTERN = /^[a-z0-9_-]{2,32}$/u;

/**
 * Resolve the actor a trace belongs to from the authenticating client key's
 * stored metadata only (`actorId`, or `memoryAgentId` when the key has no
 * `actorId`). Request headers and bodies are never consulted, so callers cannot
 * claim another actor's traffic. Values outside the agent ID format are ignored.
 */
export function traceActorIdFromKeyMetadata(metadataJson: string | null | undefined): string | null {
  const metadata = safeJsonParse<unknown>(metadataJson, null);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  // memoryAgentId is only a fallback when the key has no actorId at all; an
  // invalid actorId is not silently replaced by a different identifier.
  const value = record['actorId'] !== undefined && record['actorId'] !== null ? record['actorId'] : record['memoryAgentId'];
  return typeof value === 'string' && ACTOR_ID_PATTERN.test(value) ? value : null;
}

export async function startTrace(input: {
  requestId: string;
  method: string;
  path: string;
  endpointKind: string;
  routeKey: string;
  requestHeaders: Record<string, string>;
  requestMeta: TraceRequestMeta;
  decision: RouteDecision;
  requestBody?: string | undefined;
  clientApiKeyId?: string | undefined;
}): Promise<{ traceId: string }> {
  const env = loadEnv();
  const key = input.clientApiKeyId ? await prisma.clientApiKey.findUnique({ where: { id: input.clientApiKeyId }, select: { metadataJson: true } }) : null;
  const captureBodies = shouldCaptureTraceBodies(key?.metadataJson);
  const requestBodyHandle = captureBodies && env.CAPTURE_REQUEST_BODIES && input.requestBody
    ? await storeBody(input.requestId, 'request', 'text/plain', input.requestBody)
    : undefined;

  const trace = await prisma.trace.create({
    data: {
      requestId: input.requestId,
      method: input.method,
      path: input.path,
      endpointKind: input.endpointKind,
      routeKey: input.routeKey,
      requestHeadersJson: prettyJson(input.requestHeaders),
      requestMetaJson: prettyJson({ ...input.requestMeta, captureBodies }),
      decisionJson: prettyJson(input.decision),
      requestBodyPath: requestBodyHandle?.path ?? null,
      clientApiKeyId: input.clientApiKeyId ?? null,
      actorId: traceActorIdFromKeyMetadata(key?.metadataJson),
    } satisfies Prisma.TraceUncheckedCreateInput,
  });

  return { traceId: trace.id };
}

export async function addTraceEvent(
  traceId: string,
  event: TraceEventInput,
): Promise<void> {
  await prisma.traceEvent.create({
    data: {
      traceId,
      type: event.type,
      phase: event.phase ?? null,
      message: event.message ?? null,
      dataJson: 'data' in event ? prettyJson(event.data) : null,
    } satisfies Prisma.TraceEventUncheckedCreateInput,
  });
}

export async function finalizeTrace(input: FinalizeTraceInput): Promise<void> {
  const tracePolicy = await prisma.trace.findUniqueOrThrow({ where: { id: input.traceId }, select: { requestMetaJson: true } });
  const captureBodies = safeJsonParse<{ captureBodies?: boolean }>(tracePolicy.requestMetaJson, {}).captureBodies !== false;
  const provider = input.providerId ? await prisma.provider.findUnique({ where: { id: input.providerId }, select: { capabilityJson: true } }) : null;
  const prices = safeJsonParse<{ inputCostPerMillionTokens?: number; outputCostPerMillionTokens?: number }>(provider?.capabilityJson, {});
  const known = !input.estimatedUsage && [prices.inputCostPerMillionTokens, prices.outputCostPerMillionTokens, input.usage?.inputTokens, input.usage?.outputTokens].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0) && typeof prices.inputCostPerMillionTokens === 'number' && typeof prices.outputCostPerMillionTokens === 'number' && typeof input.usage?.inputTokens === 'number' && typeof input.usage?.outputTokens === 'number';
  const inputOnlyKnown = input.pricing === 'input-only' && !input.estimatedUsage && typeof prices.inputCostPerMillionTokens === 'number' && Number.isFinite(prices.inputCostPerMillionTokens) && prices.inputCostPerMillionTokens >= 0 && typeof input.usage?.inputTokens === 'number' && Number.isFinite(input.usage.inputTokens) && input.usage.inputTokens >= 0;
  const costUsd = input.pricing === 'input-only'
    ? inputOnlyKnown ? (input.usage!.inputTokens! * prices.inputCostPerMillionTokens!) / 1_000_000 : undefined
    : known ? (input.usage!.inputTokens! * prices.inputCostPerMillionTokens! + input.usage!.outputTokens! * prices.outputCostPerMillionTokens!) / 1_000_000 : undefined;
  await sqliteWrite(() => quotaLedger().settle(input.traceId, input.outcome === TraceOutcome.DENIED ? 0 : input.estimatedUsage ? undefined : input.usage?.totalTokens, { ...(costUsd !== undefined ? { costUsd, source: 'operator-declared-provider-prices' } : {}), estimated: input.estimatedUsage ?? input.usage?.totalTokens === undefined }));
  const env = loadEnv();
  const responseBodyHandle = captureBodies && env.CAPTURE_RESPONSE_BODIES && input.responseBody
    ? await storeBody(input.traceId, 'response', 'text/plain', input.responseBody)
    : undefined;
  const reasoningBodyHandle = captureBodies && env.CAPTURE_RESPONSE_BODIES && input.reasoningBody
    ? await storeBody(input.traceId, 'reasoning', 'text/plain', input.reasoningBody)
    : undefined;

  const updateData: Prisma.TraceUncheckedUpdateInput = {
    outcome: input.outcome,
    providerId: input.providerId ?? null,
    providerKind: input.providerKind ?? null,
    providerModel: input.providerModel ?? null,
    responseHeadersJson: input.responseHeaders ? prettyJson(input.responseHeaders) : null,
    responseMetaJson: input.responseMeta ? prettyJson(input.responseMeta) : null,
    usageJson: input.usage ? prettyJson(input.usage) : null,
    estimatedUsage: input.estimatedUsage ?? false,
    responseBodyPath: responseBodyHandle?.path ?? null,
    reasoningBodyPath: reasoningBodyHandle?.path ?? null,
    endedAt: new Date(),
  };

  if (input.statusCode !== undefined) {
    updateData.statusCode = input.statusCode;
  }

  const trace = await prisma.trace.findUniqueOrThrow({
    where: { id: input.traceId },
    select: { startedAt: true },
  });

  updateData.durationMs = Math.max(0, Date.now() - trace.startedAt.getTime());

  await prisma.trace.update({
    where: { id: input.traceId },
    data: updateData,
  });
}
