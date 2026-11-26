import { SERVICE_CAPABILITIES } from '../status/capabilities.js';
import { maintenanceActive } from '../release/runtime.js';
import { metadata } from '../release/runtime.js';
import { packageRoot as releasePackageRoot } from '../config/paths.js';
import { sqliteWrite } from '../storage/sqlite-write.js';
import { observeStream } from "./observed-stream.js";
import { TraceOutcome } from '../generated/prisma/client.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { decodeInferenceBody } from './request-body.js';
import { outputAllowance } from './output-allowance.js';
import type { Context } from 'hono';
import { ZodError } from 'zod';
import type { AppVariables } from '../types/app.js';
import { requestIdMiddleware } from '../utils/request.js';
import { requireApiKey } from '../security/api-auth.js';
import { clientResponseHeaderName, parseHeaderNameList, redactHeaders } from '../security/headers.js';
import { listProviderRuntimes, getProviderAdapter } from '../providers/index.js';
import type { EndpointKind, ProviderExecution, ProviderRuntime, RouteDecision, RouteRequest } from '../providers/types.js';
import { resolveRoute } from '../routing/service.js';
import { withResolvedRouteModel } from '../routing/request-body.js';
import { addTraceEvent, finalizeTrace, startTrace, type UsageSnapshot } from '../telemetry/tracing.js';
import { failoverCounter, requestCounter, requestDuration, streamFirstByteDuration, streamFailureCounter } from '../telemetry/metrics.js';
import { classifyStreamOutcome, looksLikeStreamError, peekStreamStart } from './stream-failover.js';
import { enforceClientKeyQuota, readClientKeyQuota, quotaLedger } from '../security/quota.js';
import { prisma } from '../storage/client.js';
import { log } from '../telemetry/logger.js';
import { loadEnv } from '../config/env.js';
import { buildRouterDependencyReport } from '../status/router-health.js';
import { registerHealthProbes } from '../status/health-probes.js';
import { abandonProviderTrial, enterProviderCircuit, getSemaphore, holdUntilBodyDone, isCircuitOpen, markProviderFailure, ProviderSlotUnavailable, resetProviderCircuit, shouldFailoverStatus, shouldRetry } from './provider-guards.js';
import { deadlineReached, retrySignalFor, retryTiming, RETRY_HEADER, sameProviderRetryDelay, upstreamExhausted, upstreamRetryAfterMs } from './retry-budget.js';
import { attemptDeadline, readInboundAttribution, type InboundAttribution } from '../telemetry/execution-attribution.js';
import { decisionsError, decisionsRequestSchema, summarizeDecisionsRequest, type DecisionsErrorBody } from '../decisions-api/schema.js';
import { planDecisions, type DecisionsRejection } from '../decisions-api/backends.js';
import { executeDecisionsPlan } from '../decisions-api/execute.js';

function toHeaderObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

interface AggregatedModelEntry {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  alias_for?: string;
  max_context_window?: number;
}

function createModelsRouteRequest(): RouteRequest {
  return {
    requestId: 'models-enumeration',
    method: 'GET',
    path: '/v1/models',
    queryString: '',
    endpointKind: 'v1.models',
    routeKey: 'GET /v1/models',
    stream: false,
    toolsRequested: false,
    jsonSchemaRequested: false,
    modalities: [],
    headers: { accept: 'application/json' },
  };
}

/**
 * Live model lists by provider, kept for `EMBERPATH_MODELS_CACHE_TTL_MS` so clients polling
 * `GET /v1/models` do not fan out a request to every backend each time. Concurrent callers
 * share one fetch, and a provider whose settings changed is asked again.
 */
const liveModelCache = new Map<string, { version: number; at: number; models: Promise<AggregatedModelEntry[]> }>();

export function clearLiveModelCache(): void {
  liveModelCache.clear();
}

function cachedLiveProviderModels(provider: ProviderRuntime, now = Date.now()): Promise<AggregatedModelEntry[]> {
  const ttl = loadEnv().EMBERPATH_MODELS_CACHE_TTL_MS;
  if (ttl <= 0) return fetchLiveProviderModels(provider);
  const version = provider.provider.updatedAt.getTime();
  const cached = liveModelCache.get(provider.id);
  if (cached && cached.version === version && now - cached.at < ttl) return cached.models;
  const models = fetchLiveProviderModels(provider);
  liveModelCache.set(provider.id, { version, at: now, models });
  return models;
}

async function fetchLiveProviderModels(provider: ProviderRuntime): Promise<AggregatedModelEntry[]> {
  try {
    const adapter = getProviderAdapter(provider.kind);
    const execution = await adapter.execute(createModelsRouteRequest(), provider);
    if (!execution.response.ok) {
      return [];
    }

    const json = await execution.response.json() as {
      data?: Array<{ id?: unknown }>;
      models?: Array<{ name?: unknown; model?: unknown }>;
    };
    const created = Math.floor(provider.provider.createdAt.getTime() / 1000);

    if (Array.isArray(json.data)) {
      return json.data.flatMap((entry) => {
        const modelId = typeof entry.id === 'string' ? entry.id : null;
        if (!modelId) {
          return [];
        }

        return [{
          id: modelId,
          object: 'model' as const,
          created,
          owned_by: provider.slug,
        }];
      });
    }

    if (Array.isArray(json.models)) {
      return json.models.flatMap((entry) => {
        const modelId = typeof entry.name === 'string'
          ? entry.name
          : typeof entry.model === 'string'
            ? entry.model
            : null;
        if (!modelId) {
          return [];
        }

        return [{
          id: modelId,
          object: 'model' as const,
          created,
          owned_by: provider.slug,
        }];
      });
    }
  } catch (error) {
    log('warn', 'Live model enumeration failed', {
      providerId: provider.id,
      providerKind: provider.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return [];
}

function collectModalities(payload: unknown, contentType: string | undefined, path: string): string[] {
  const modalities = new Set<string>();

  if (contentType?.startsWith('audio/') || path.includes('/audio/')) {
    modalities.add('audio');
  }

  if (contentType?.startsWith('video/')) {
    modalities.add('video');
  }

  if (contentType?.startsWith('image/')) {
    modalities.add('image');
  }

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }

    if (!value || typeof value !== 'object') {
      return;
    }

    if ('type' in value && typeof value.type === 'string') {
      if (value.type === 'image_url' || value.type === 'input_image') {
        modalities.add('image');
      }
      if (value.type === 'input_audio' || value.type === 'audio') {
        modalities.add('audio');
      }
      if (value.type === 'video' || value.type === 'input_video') {
        modalities.add('video');
      }
    }

    for (const nested of Object.values(value)) {
      visit(nested);
    }
  };

  visit(payload);
  return Array.from(modalities);
}

async function buildRouteRequest(
  context: Context<{ Variables: AppVariables }>,
  endpointKind: EndpointKind,
  options: { routingTrait?: string; upstreamPath?: string } = {},
): Promise<RouteRequest> {
  const rawRequest = context.req.raw.clone();
  const method = context.req.method;
  const requestPath = new URL(context.req.url).pathname;
  const path = options.upstreamPath ?? requestPath;
  const queryString = new URL(context.req.url).search;
  const contentType = context.req.header('content-type') ?? undefined;

  let bodyBuffer: Uint8Array | undefined;
  let requestBodyText: string | undefined;
  let requestBodyJson: unknown;

  if (!['GET', 'HEAD'].includes(method)) {
    const arrayBuffer = await rawRequest.arrayBuffer();
    if (arrayBuffer.byteLength > 0) {
      bodyBuffer = await decodeInferenceBody(new Uint8Array(arrayBuffer), context.req.header('content-encoding'), loadEnv().MAX_REQUEST_BODY_BYTES);
    }
  }

  if (bodyBuffer && contentType && (
    contentType.includes('application/json')
      || contentType.startsWith('text/')
      || contentType.includes('application/x-www-form-urlencoded')
      || contentType.includes('multipart/form-data')
  )) {
    requestBodyText = new TextDecoder().decode(bodyBuffer);
  }

  if (requestBodyText && contentType?.includes('application/json')) {
    try {
      requestBodyJson = JSON.parse(requestBodyText) as unknown;
    } catch {
      requestBodyJson = undefined;
    }
  }

  const body = (requestBodyJson ?? {}) as Record<string, unknown>;
  const model = typeof body.model === 'string' ? body.model : undefined;
  const headerTrait = context.req.header('x-hive-routing-trait') ?? context.req.header('x-routing-trait');
  const routingTrait = (options.routingTrait ?? headerTrait)?.trim() || undefined;
  const stream = body.stream === true;
  const toolsRequested = Array.isArray(body.tools) && body.tools.length > 0;
  const jsonSchemaRequested = Boolean(body.response_format || body.format || (body.text && typeof body.text === 'object' && 'format' in body.text));
  const headers = Object.fromEntries(context.req.raw.headers.entries());

  return {
    requestId: context.get('requestId'),
    method,
    path,
    queryString,
    endpointKind,
    routeKey: `${method} ${path}`,
    model,
    routingTrait,
    stream,
    toolsRequested,
    jsonSchemaRequested,
    modalities: collectModalities(requestBodyJson, contentType, path),
    contentType,
    headers,
    requestBodyText,
    requestBodyJson,
    bodyBuffer,
    signal: rawRequest.signal,
  };
}

function estimateUsage(route: RouteRequest, responseBody?: string, reasoningBody?: string): UsageSnapshot {
  const inputText = route.requestBodyText ?? '';
  const outputText = responseBody ?? '';
  const reasoningText = reasoningBody ?? '';

  const countWords = (value: string): number => value.trim() ? value.trim().split(/\s+/).length : 0;
  const roughTokens = (value: string): number => Math.ceil(value.length / 4);

  return {
    inputWords: countWords(inputText),
    outputWords: countWords(outputText),
    totalWords: countWords(inputText) + countWords(outputText),
    inputTokens: roughTokens(inputText),
    outputTokens: roughTokens(outputText),
    totalTokens: roughTokens(inputText) + roughTokens(outputText),
    reasoningTokens: roughTokens(reasoningText),
  };
}

const CLIENT_DISCONNECTED = 'Client disconnected before a provider responded';

/** Cancel a response body that will never be read so its connection is released. */
function discardResponse(response: Response): void {
  if (response.body && !response.bodyUsed) void response.body.cancel().catch(() => undefined);
}

interface FailoverResult {
  provider?: ProviderRuntime;
  execution?: ProviderExecution;
  failureResponse?: Response | undefined;
  failureError?: string | undefined;
  /** Upstream calls made, across retries and providers. More than one means a retry or failover happened. */
  upstreamAttempts: number;
  /** The upstream that produced the final answer said it had already exhausted its own retries. */
  upstreamExhausted: boolean;
}

/**
 * Try the decision's candidate providers in order. A provider that fails with a retryable
 * status, a stream error before the first token, or a network error is retried (only for
 * safe or idempotency-keyed requests) after a jittered backoff that honours the upstream
 * `Retry-After`; when no retry may start before `deadlineMs`, or the upstream asks for a wait
 * longer than the cap, the next candidate is tried immediately. A client disconnect stops
 * every further attempt and does not count against a provider. Nothing here retries a
 * response whose bytes have reached the client.
 */
async function runExecutionWithFailover(
  route: RouteRequest,
  decision: RouteDecision,
  providers: ProviderRuntime[],
  traceId: string,
  deadlineMs: number,
): Promise<FailoverResult> {
  const candidateProviders = decision.candidateProviderIds
    .map((providerId) => providers.find((provider) => provider.id === providerId))
    .filter((provider): provider is ProviderRuntime => Boolean(provider));
  const upstreamRoute = withResolvedRouteModel(route, decision.targetModel);

  let lastFailureResponse: Response | undefined;
  let lastFailureError: string | undefined;
  let upstreamAttempts = 0;
  let lastUpstreamExhausted = false;
  const finish = (result: Omit<FailoverResult, 'upstreamAttempts' | 'upstreamExhausted'>): FailoverResult => ({
    ...result, upstreamAttempts, upstreamExhausted: lastUpstreamExhausted,
  });
  // Only the last failed response is ever read (to answer the client), so every
  // superseded one is cancelled to hand its upstream connection back.
  const keepFailureResponse = (response: Response | undefined): void => {
    if (lastFailureResponse && lastFailureResponse !== response) discardResponse(lastFailureResponse);
    lastFailureResponse = response;
  };
  const nextCandidateAfter = (provider: ProviderRuntime): ProviderRuntime | undefined => {
    const currentIndex = candidateProviders.indexOf(provider);
    return candidateProviders.find((candidate, index) => index > currentIndex && !isCircuitOpen(candidate.id));
  };
  const clientDisconnected = async (provider: ProviderRuntime, attempt: number, duringBackoff: boolean): Promise<FailoverResult> => {
    // The caller went away. That says nothing about the provider, so it must
    // not count towards its circuit breaker, and no other provider is tried.
    keepFailureResponse(undefined);
    lastFailureError = CLIENT_DISCONNECTED;
    await addTraceEvent(traceId, duringBackoff
      ? { type: 'request.aborted', phase: 'execution', message: lastFailureError, data: { during: 'backoff', providerId: provider.id, attempt } }
      : { type: 'provider.error', phase: 'execution', message: lastFailureError, data: { providerId: provider.id, attempt, outcome: 'client_aborted', failover: false } });
    return finish({ failureError: lastFailureError });
  };

  candidates: for (const provider of candidateProviders) {
    if (route.signal?.aborted) break;
    // Failover to a later candidate stops once the request's deadline has passed.
    if (upstreamAttempts > 0 && deadlineReached(deadlineMs)) break;
    if (!enterProviderCircuit(provider.id)) {
      await addTraceEvent(traceId, {
        type: 'provider.skipped',
        phase: 'routing',
        message: `Provider ${provider.slug} skipped because its circuit is open`,
      });
      continue;
    }

    const adapter = getProviderAdapter(provider.kind);
    const semaphore = getSemaphore(provider);
    const attempts = shouldRetry(route) ? Math.max(1, provider.maxRetries + 1) : 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let failure: { type: 'provider.failover' | 'provider.stream_failover' | 'provider.error'; outcome: 'http_error' | 'stream_error' | 'network_error'; message: string; status?: number; retryAfterMs?: number | undefined; noRetry?: boolean } | undefined;
      try {
        await semaphore.acquire(route.signal);
      } catch (error) {
        if (!(error instanceof ProviderSlotUnavailable)) {
          abandonProviderTrial(provider.id);
          return clientDisconnected(provider, attempt, false);
        }
        // A saturated provider is not a failing one: leave its circuit alone and try the next.
        abandonProviderTrial(provider.id);
        lastFailureError = `Provider ${provider.slug} is busy: ${error.message.toLowerCase()}`;
        await addTraceEvent(traceId, {
          type: 'provider.skipped',
          phase: 'execution',
          message: lastFailureError,
          data: { providerId: provider.id, attempt, reason: error.reason },
        });
        continue candidates;
      }
      // The slot is handed to the response body on success and released when it ends.
      let slotReleased = false;
      let slotHandedOff = false;
      const releaseSlot = () => {
        if (slotReleased) return;
        slotReleased = true;
        semaphore.release();
      };
      const holdSlot = (response: Response): Response => {
        slotHandedOff = true;
        return holdUntilBodyDone(response, releaseSlot);
      };
      try {
        upstreamAttempts += 1;
        const execution = await adapter.execute(upstreamRoute, provider);
        lastUpstreamExhausted = upstreamExhausted(execution.response.headers);

        if (shouldFailoverStatus(execution.response.status)) {
          markProviderFailure(provider.id);
          keepFailureResponse(execution.response);
          lastFailureError = `Upstream returned ${execution.response.status}`;
          failure = {
            type: 'provider.failover',
            outcome: 'http_error',
            message: `Provider ${provider.slug} returned ${execution.response.status}`,
            status: execution.response.status,
            retryAfterMs: upstreamRetryAfterMs(execution.response.headers),
            noRetry: lastUpstreamExhausted,
          };
        } else {
          // Streaming-aware, retry-before-first-token failover: for SSE responses
          // with a downstream candidate still available, peek the first chunk to
          // catch upstreams that return 200 then immediately emit an error event.
          // Nothing has reached the client yet, so trying again is safe.
          const hasNextCandidate = nextCandidateAfter(provider) !== undefined;
          const responseContentType = execution.response.headers.get('content-type') ?? '';
          if (
            route.stream &&
            execution.response.ok &&
            execution.response.body &&
            !execution.tracePromise &&
            responseContentType.includes('text/event-stream') &&
            hasNextCandidate
          ) {
            const peeked = await peekStreamStart(execution.response.body);
            if (looksLikeStreamError(peeked.firstChunkText)) {
              // The failed stream is abandoned here; release its upstream connection.
              void peeked.stream.cancel().catch(() => undefined);
              markProviderFailure(provider.id);
              lastFailureError = `Provider ${provider.slug} emitted a stream error before the first token`;
              streamFailureCounter.inc({ route: route.routeKey, provider: provider.slug, phase: 'pre-first-byte' });
              failure = { type: 'provider.stream_failover', outcome: 'stream_error', message: lastFailureError, status: execution.response.status };
            } else {
              resetProviderCircuit(provider.id);
              keepFailureResponse(undefined);
              const rebuiltResponse = new Response(peeked.stream, {
                status: execution.response.status,
                headers: execution.response.headers,
              });
              return finish({ provider, execution: { ...execution, response: holdSlot(rebuiltResponse) } });
            }
          } else {
            resetProviderCircuit(provider.id);
            keepFailureResponse(undefined);
            return finish({ provider, execution: { ...execution, response: holdSlot(execution.response) } });
          }
        }
      } catch (error) {
        if (route.signal?.aborted) {
          abandonProviderTrial(provider.id);
          return clientDisconnected(provider, attempt, false);
        }
        markProviderFailure(provider.id);
        lastUpstreamExhausted = false;
        lastFailureError = error instanceof Error ? error.message : 'Unknown provider execution error';
        failure = { type: 'provider.error', outcome: 'network_error', message: lastFailureError };
      } finally {
        if (!slotHandedOff) releaseSlot();
      }
      if (!failure) break;

      const delayMs = attempt < attempts && !failure.noRetry
        ? sameProviderRetryDelay(attempt, attempts, { retryAfterMs: failure.retryAfterMs, deadlineMs })
        : null;
      const nextProvider = delayMs === null ? nextCandidateAfter(provider) : undefined;
      const data = {
        providerId: provider.id,
        attempt,
        outcome: failure.outcome,
        failover: nextProvider !== undefined,
        ...(failure.status !== undefined ? { status: failure.status } : {}),
        ...(delayMs !== null ? { delayMs } : {}),
        ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
      };
      await addTraceEvent(traceId, failure.type === 'provider.stream_failover'
        ? { type: failure.type, phase: 'execution', message: failure.message, data: { ...data, phase: 'pre-first-byte' } }
        : { type: failure.type, phase: 'execution', message: failure.message, data });
      if (nextProvider && failure.type !== 'provider.error') {
        failoverCounter.inc({
          route: route.routeKey,
          from_provider: provider.slug,
          to_provider: nextProvider.slug,
        });
      }
      if (delayMs === null) break;
      try {
        await retryTiming.sleep(delayMs, route.signal);
      } catch (error) {
        if (route.signal?.aborted) return clientDisconnected(provider, attempt, true);
        throw error;
      }
    }
  }

  return finish({
    ...(lastFailureResponse ? { failureResponse: lastFailureResponse } : {}),
    ...(lastFailureError ? { failureError: lastFailureError } : {}),
  });
}

/** The upstream response headers the client is given (see `clientResponseHeaderName`). */
function copyResponseHeaders(headers: Headers): Headers {
  const env = loadEnv();
  const policy = { mode: env.EMBERPATH_UPSTREAM_RESPONSE_HEADERS, extra: parseHeaderNameList(env.EMBERPATH_UPSTREAM_RESPONSE_HEADER_ALLOW) };
  const copied = new Headers();
  for (const [key, value] of headers.entries()) {
    const name = clientResponseHeaderName(key, policy);
    if (name) copied.set(name, value);
  }
  return copied;
}

/** Headers recorded on the trace (redacted): every upstream header, then what the client got. */
function traceResponseHeaders(upstream: Headers, sent: Headers): Record<string, string> {
  return redactHeaders({ ...toHeaderObject(upstream), ...toHeaderObject(sent) });
}

/**
 * Reserve `tokenReservation` tokens against the calling client key's quota.
 * Returns the response to send when the request must stop here.
 */
async function reserveClientQuota(
  context: Context<{ Variables: AppVariables }>,
  route: RouteRequest,
  tokenReservation: number,
): Promise<Response | { reservationId: string | undefined; warnings: string[] }> {
  const clientKey = context.get('clientApiKey')!;
  const quota = await enforceClientKeyQuota(clientKey, tokenReservation);
  if (quota.unavailable) return context.json({ error: 'Quota accounting unavailable' }, 503, { 'retry-after': '5' });
  if (!quota.allowed) {
    requestCounter.inc({
      plane: 'api',
      route: route.routeKey,
      method: route.method,
      status: '429',
      provider: 'quota',
      outcome: 'quota_exceeded',
    });
    return context.json(
      {
        error: 'Quota exceeded',
        quota: { exceeded: quota.exceeded },
      },
      429,
      { 'retry-after': '3600', 'x-hive-quota-exceeded': quota.exceeded.join(',') },
    );
  }
  return { reservationId: quota.reservationId, warnings: quota.warnings };
}

/** Client-asserted execution attribution for the trace; malformed values are ignored, never rejected. */
function inboundAttribution(route: RouteRequest): InboundAttribution {
  const attribution = readInboundAttribution(route.headers);
  if (attribution.executionIgnored) {
    log('warn', 'Ignored an invalid or oversized x-hive-execution header', { requestId: route.requestId });
  }
  return attribution;
}

async function handleRouteExecution(
  context: Context<{ Variables: AppVariables }>,
  endpointKind: EndpointKind,
  options: { routingTrait?: string; upstreamPath?: string } = {},
): Promise<Response> {
  const startedAt = Date.now();
  const route = await buildRouteRequest(context, endpointKind, options);

  const clientKey = context.get('clientApiKey');
  let quotaWarnings: string[] = [];
  let quotaReservationId: string | undefined;
  if (clientKey) {
    const rawBody = route.requestBodyJson as Record<string, unknown> | undefined;
    const limits = readClientKeyQuota(clientKey.metadataJson);
    const hardTokenLimit = Boolean(limits.dailyTokens || limits.monthlyTokens);
    const allowance = outputAllowance(route);
    if (hardTokenLimit && allowance.kind !== 'none' && (allowance.kind !== 'explicit' || route.modalities.some((mode) => mode !== 'text'))) return context.json({ error: 'Token budgets require a bounded text request with an explicit maximum output token count; multimodal accounting is unavailable' }, 400);
    const maxOutput = allowance.kind === 'none' ? 0 : allowance.kind === 'explicit' ? allowance.tokens : 4096;
    const completions = Number(rawBody?.n ?? 1);
    if (!Number.isSafeInteger(completions) || completions < 1 || completions > 128) return context.json({ error: 'Invalid completion count' }, 400);
    const tokenReservation = Buffer.byteLength(route.requestBodyText ?? "") + maxOutput * completions;
    const quota = await reserveClientQuota(context, route, tokenReservation);
    if (quota instanceof Response) return quota;
    quotaReservationId = quota.reservationId;
    quotaWarnings = quota.warnings;
  }

  const providers = await listProviderRuntimes();
  const decision = await resolveRoute(route, providers);
  const attribution = inboundAttribution(route);

  const trace = await startTrace({
    requestId: route.requestId,
    method: route.method,
    path: route.path,
    endpointKind: route.endpointKind,
    routeKey: route.routeKey,
    requestHeaders: redactHeaders(route.headers),
    requestMeta: {
      contentType: route.contentType,
      model: route.model,
      routingTrait: route.routingTrait,
      stream: route.stream,
      modalities: route.modalities,
    },
    decision,
    requestBody: route.requestBodyText,
    clientApiKeyId: context.get('clientApiKey')?.id,
    attribution,
  });
  if (quotaReservationId) await sqliteWrite(() => quotaLedger().attach(quotaReservationId, trace.traceId));
  context.set('traceContext', { traceId: trace.traceId, requestId: route.requestId });

  if (decision.denialReason) {
    await addTraceEvent(trace.traceId, {
      type: 'route.denied',
      phase: 'routing',
      message: decision.denialReason,
    });
    await finalizeTrace({
      traceId: trace.traceId,
      statusCode: 403,
      outcome: TraceOutcome.DENIED,
      responseMeta: { denialReason: decision.denialReason },
    });
    requestCounter.inc({
      plane: 'api',
      route: route.routeKey,
      method: route.method,
      status: '403',
      provider: 'denied',
      outcome: 'denied',
    });
    // The full decision (candidates, rules, observations) stays in the trace, not with the client.
    return context.json({ error: decision.denialReason }, 403);
  }

  const deadlineMs = attemptDeadline(startedAt, loadEnv().EMBERPATH_REQUEST_DEADLINE_MS, attribution.execution);
  const executionResult = await runExecutionWithFailover(route, decision, providers, trace.traceId, deadlineMs);
  const provider = executionResult.provider;
  const execution = executionResult.execution;
  const retrySignal = (status: number) => retrySignalFor({
    status,
    upstreamAttempts: executionResult.upstreamAttempts,
    upstreamExhausted: executionResult.upstreamExhausted,
  });

  if (!provider || !execution) {
    const fallbackResponse = executionResult.failureResponse;
    const status = fallbackResponse?.status ?? 503;
    const errorText = fallbackResponse ? await fallbackResponse.text() : executionResult.failureError ?? 'No provider available';
    await finalizeTrace({
      traceId: trace.traceId,
      statusCode: status,
      outcome: TraceOutcome.FAILED,
      responseBody: errorText,
      estimatedUsage: true,
      usage: estimateUsage(route, errorText),
      // Nothing reached a model, so the caller's token budget is not charged.
      noProviderAnswer: true,
      responseMeta: executionResult.failureError ? { error: executionResult.failureError } : {},
    });
    requestCounter.inc({
      plane: 'api',
      route: route.routeKey,
      method: route.method,
      status: `${status}`,
      provider: 'none',
      outcome: 'failed',
    });
    return new Response(
      JSON.stringify({ error: executionResult.failureError ?? 'All candidate providers failed' }),
      {
        status,
        headers: { 'content-type': 'application/json', [RETRY_HEADER]: retrySignal(status) },
      },
    );
  }

  const responseHeaders = copyResponseHeaders(execution.response.headers);
  if (quotaWarnings.length > 0) {
    responseHeaders.set('x-hive-quota-warning', quotaWarnings.join(','));
  }
  responseHeaders.set(RETRY_HEADER, retrySignal(execution.response.status));
  const contentType = execution.response.headers.get('content-type') ?? '';
  if (execution.tracePromise) {
    const response = new Response(execution.response.body, {
      status: execution.response.status,
      headers: responseHeaders,
    });

    void execution.tracePromise.then(async (tracePayload) => {
      if (tracePayload.firstByteMs !== undefined) {
        streamFirstByteDuration.observe({ route: route.routeKey, provider: provider.slug }, tracePayload.firstByteMs);
      }
      const usage = execution.usage ?? tracePayload.usage ?? estimateUsage(route, tracePayload.responseBody, tracePayload.reasoningText);
      const streamFailed = tracePayload.errored === true;
      if (streamFailed) {
        streamFailureCounter.inc({ route: route.routeKey, provider: provider.slug, phase: tracePayload.firstByteMs === undefined ? 'pre-first-byte' : 'mid-stream' });
      }
      await finalizeTrace({
        traceId: trace.traceId,
        statusCode: execution.response.status,
        outcome: streamFailed ? TraceOutcome.STREAM_FAILED : TraceOutcome.SUCCEEDED,
        providerId: provider.id,
        providerKind: provider.kind,
        providerModel: execution.providerModel ?? decision.targetModel ?? route.model,
        responseHeaders: traceResponseHeaders(execution.response.headers, responseHeaders),
        usage,
        estimatedUsage: execution.usage === undefined && tracePayload.usage === undefined,
        responseBody: tracePayload.responseBody,
        reasoningBody: execution.reasoningText ?? tracePayload.reasoningText,
        responseMeta: { contentType },
      });
      requestDuration.observe({
        plane: 'api',
        route: route.routeKey,
        method: route.method,
        provider: provider.slug,
      }, Date.now() - startedAt);
      requestCounter.inc({
        plane: 'api',
        route: route.routeKey,
        method: route.method,
        status: `${execution.response.status}`,
        provider: provider.slug,
        outcome: streamFailed ? 'stream_failed' : 'succeeded',
      });
    }).catch((error) => {
      log('error', 'Failed to finalize streaming trace', { error: error instanceof Error ? error.message : String(error) });
    });

    return response;
  }

  if (execution.response.body && contentType.includes('text/event-stream')) {
    const observed = observeStream(execution.response.body, loadEnv().MAX_TRACE_BODY_BYTES);
    void observed.completed.then(async ({ text, firstByteMs, errored, bytesReceived, truncated, usage: streamUsage }) => {
      if (firstByteMs !== undefined) {
        streamFirstByteDuration.observe({ route: route.routeKey, provider: provider.slug }, firstByteMs);
      }
      const classification = classifyStreamOutcome({ bytesReceived, errored });
      if (classification.failed) {
        streamFailureCounter.inc({ route: route.routeKey, provider: provider.slug, phase: classification.phase });
      }
      const usage = execution.usage ?? streamUsage ?? estimateUsage(route, text, execution.reasoningText);
      await finalizeTrace({
        traceId: trace.traceId,
        statusCode: execution.response.status,
        outcome: classification.failed ? TraceOutcome.STREAM_FAILED : TraceOutcome.SUCCEEDED,
        providerId: provider.id,
        providerKind: provider.kind,
        providerModel: execution.providerModel ?? decision.targetModel ?? route.model,
        responseHeaders: traceResponseHeaders(execution.response.headers, responseHeaders),
        usage,
        estimatedUsage: execution.usage === undefined && streamUsage === undefined,
        responseBody: text,
        reasoningBody: execution.reasoningText,
        responseMeta: classification.failed
          ? {
              contentType,
              streamPhase: classification.phase === 'complete' ? 'mid-stream' : classification.phase,
              reachedClient: classification.reachedClient,
              retrySafe: classification.retrySafe,
            }
          : { contentType, truncated, bytesReceived },
      });
      requestDuration.observe({
        plane: 'api',
        route: route.routeKey,
        method: route.method,
        provider: provider.slug,
      }, Date.now() - startedAt);
      requestCounter.inc({
        plane: 'api',
        route: route.routeKey,
        method: route.method,
        status: `${execution.response.status}`,
        provider: provider.slug,
        outcome: classification.failed ? 'stream_failed' : 'succeeded',
      });
    }).catch((error) => {
      log('error', 'Failed to capture SSE trace', { error: error instanceof Error ? error.message : String(error) });
    });

    return new Response(observed.stream, {
      status: execution.response.status,
      headers: responseHeaders,
    });
  }

  const responseText = await execution.response.text();
  const usage = execution.usage ?? estimateUsage(route, responseText, execution.reasoningText);
  await finalizeTrace({
    traceId: trace.traceId,
    statusCode: execution.response.status,
    outcome: execution.response.ok ? TraceOutcome.SUCCEEDED : TraceOutcome.FAILED,
    providerId: provider.id,
    providerKind: provider.kind,
    providerModel: execution.providerModel ?? decision.targetModel ?? route.model,
    responseHeaders: traceResponseHeaders(execution.response.headers, responseHeaders),
    usage,
    estimatedUsage: execution.usage === undefined,
    responseBody: responseText,
    reasoningBody: execution.reasoningText,
    responseMeta: { contentType },
  });

  requestDuration.observe({
    plane: 'api',
    route: route.routeKey,
    method: route.method,
    provider: provider.slug,
  }, Date.now() - startedAt);
  requestCounter.inc({
    plane: 'api',
    route: route.routeKey,
    method: route.method,
    status: `${execution.response.status}`,
    provider: provider.slug,
    outcome: execution.response.ok ? 'succeeded' : 'failed',
  });

  return new Response(responseText, {
    status: execution.response.status,
    headers: responseHeaders,
  });
}

/** Output allowance per question when reserving client quota for a decision. */
const DECISIONS_OUTPUT_TOKENS_PER_QUESTION = 64;

function decisionsJson(body: DecisionsErrorBody, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** 400 when only request features stand in the way, otherwise 503. */
function decisionsUnavailable(rejections: DecisionsRejection[]): { status: number; body: DecisionsErrorBody } {
  const details = rejections.map(({ provider, backend, reason }) => ({ provider, ...(backend ? { backend } : {}), reason }));
  const features = [...new Set(rejections.filter((rejection) => rejection.kind === 'feature').map((rejection) => rejection.reason))];
  if (features.length > 0) {
    return {
      status: 400,
      body: decisionsError(`No configured decisions backend supports this request: ${features.join('; ')}`, 'invalid_request_error', 'unsupported_decision_feature', details),
    };
  }
  return {
    status: 503,
    body: decisionsError(
      rejections.length > 0
        ? `No configured decisions backend can serve this request: ${[...new Set(rejections.map((rejection) => rejection.reason))].join('; ')}`
        : 'No provider is configured for /v1/decisions',
      'service_unavailable', 'no_decisions_backend', details,
    ),
  };
}

/**
 * POST /v1/decisions: the OpenAI Decisions wire format in and out, routed like
 * every other inference call (client key, aliases, rules, failover, traces,
 * quotas), served by OpenAI natively or by Jev through translation.
 */
async function handleDecisionsExecution(context: Context<{ Variables: AppVariables }>): Promise<Response> {
  const startedAt = Date.now();
  // Routing traits are a chat-path feature; a trait header never applies here.
  const route = { ...await buildRouteRequest(context, 'v1.decisions'), routingTrait: undefined };
  if (!route.requestBodyJson || typeof route.requestBodyJson !== 'object' || Array.isArray(route.requestBodyJson)) {
    return decisionsJson(decisionsError('The request body must be a JSON object', 'invalid_request_error', 'invalid_json'), 400);
  }
  const parsed = decisionsRequestSchema.safeParse(route.requestBodyJson);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const param = issue?.path.map(String).join('.') || undefined;
    return decisionsJson(decisionsError(issue ? `${param ? `${param}: ` : ''}${issue.message}` : 'Invalid request', 'invalid_request_error', 'invalid_request', undefined, param), 400);
  }
  const body = parsed.data;
  const summary = summarizeDecisionsRequest(body);

  let quotaWarnings: string[] = [];
  let quotaReservationId: string | undefined;
  if (context.get('clientApiKey')) {
    // Decisions have no max-output parameter; answers are bounded per question.
    const tokenReservation = Buffer.byteLength(route.requestBodyText ?? '') + body.questions.length * DECISIONS_OUTPUT_TOKENS_PER_QUESTION;
    const quota = await reserveClientQuota(context, route, tokenReservation);
    if (quota instanceof Response) return quota;
    quotaReservationId = quota.reservationId;
    quotaWarnings = quota.warnings;
  }

  const providers = await listProviderRuntimes();
  // Images are judged per backend by the planner, which names the feature when
  // a backend cannot take them, so they do not filter candidates here.
  const decision = await resolveRoute({ ...route, modalities: [] }, providers);
  const attribution = inboundAttribution(route);
  const trace = await startTrace({
    requestId: route.requestId,
    method: route.method,
    path: route.path,
    endpointKind: route.endpointKind,
    routeKey: route.routeKey,
    requestHeaders: redactHeaders(route.headers),
    requestMeta: {
      contentType: route.contentType,
      model: route.model,
      routingTrait: undefined,
      stream: false,
      modalities: route.modalities,
      decisionsApi: summary,
    },
    decision,
    requestBody: route.requestBodyText,
    clientApiKeyId: context.get('clientApiKey')?.id,
    attribution,
  });
  if (quotaReservationId) await sqliteWrite(() => quotaLedger().attach(quotaReservationId, trace.traceId));
  context.set('traceContext', { traceId: trace.traceId, requestId: route.requestId });
  let upstreamAttempts = 0;

  const fail = async (status: number, responseBody: DecisionsErrorBody | string, meta: Parameters<typeof finalizeTrace>[0]['responseMeta'], outcome: TraceOutcome = TraceOutcome.FAILED, counterOutcome = 'failed'): Promise<Response> => {
    const text = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
    await finalizeTrace({
      traceId: trace.traceId,
      statusCode: status,
      outcome,
      responseBody: text,
      ...(outcome === TraceOutcome.DENIED ? {} : { estimatedUsage: true, usage: estimateUsage(route, text) }),
      responseMeta: meta,
    });
    requestCounter.inc({ plane: 'api', route: route.routeKey, method: route.method, status: `${status}`, provider: outcome === TraceOutcome.DENIED ? 'denied' : 'none', outcome: counterOutcome });
    return new Response(text, { status, headers: { 'content-type': 'application/json', [RETRY_HEADER]: retrySignalFor({ status, upstreamAttempts }) } });
  };

  if (decision.denialReason) {
    await addTraceEvent(trace.traceId, { type: 'route.denied', phase: 'routing', message: decision.denialReason });
    return fail(403, decisionsError(decision.denialReason, 'permission_error', 'route_denied'), { denialReason: decision.denialReason }, TraceOutcome.DENIED, 'denied');
  }

  const candidates = decision.candidateProviderIds
    .map((providerId) => providers.find((provider) => provider.id === providerId))
    .filter((provider): provider is ProviderRuntime => Boolean(provider));
  const targetModel = decision.targetModel ?? body.model;
  const plan = planDecisions(body, candidates, { model: targetModel, viaAlias: targetModel !== body.model });
  for (const rejection of plan.rejections) {
    await addTraceEvent(trace.traceId, { type: 'provider.ineligible', phase: 'routing', message: `Provider ${rejection.provider} is ineligible: ${rejection.reason}`, data: { provider: rejection.provider, backend: rejection.backend } });
  }
  if (plan.entries.length === 0) {
    const unavailable = decisionsUnavailable(plan.rejections);
    return fail(unavailable.status, unavailable.body, { error: unavailable.body.error.message, decisionsApi: { rejections: plan.rejections.map(({ provider, backend, reason }) => ({ provider, backend, reason })) } });
  }

  const deadlineMs = attemptDeadline(startedAt, loadEnv().EMBERPATH_REQUEST_DEADLINE_MS, attribution.execution);
  const executed = await executeDecisionsPlan(route, plan.entries, trace.traceId, deadlineMs);
  upstreamAttempts = executed.upstreamAttempts;
  if (!executed.result) {
    if (executed.failureResponse) {
      // Upstream error shapes are not documented; pass the last one through.
      return fail(executed.failureResponse.status, executed.failureResponse.text, { error: executed.failureError ?? `Upstream returned ${executed.failureResponse.status}` });
    }
    const error = executed.failureError ?? 'All candidate providers failed';
    return fail(503, decisionsError(error, 'service_unavailable', 'decisions_backend_failed'), { error });
  }

  const { entry, execution, responseText, answerTypes } = executed.result;
  const provider = entry.provider;
  const status = execution.response.status;
  const responseHeaders = copyResponseHeaders(execution.response.headers);
  if (quotaWarnings.length > 0) responseHeaders.set('x-hive-quota-warning', quotaWarnings.join(','));
  responseHeaders.set(RETRY_HEADER, retrySignalFor({ status, upstreamAttempts }));
  const contentType = execution.response.headers.get('content-type') ?? 'application/json';
  await finalizeTrace({
    traceId: trace.traceId,
    statusCode: status,
    outcome: execution.response.ok ? TraceOutcome.SUCCEEDED : TraceOutcome.FAILED,
    providerId: provider.id,
    providerKind: provider.kind,
    providerModel: entry.model,
    responseHeaders: traceResponseHeaders(execution.response.headers, responseHeaders),
    usage: execution.usage ?? estimateUsage(route, responseText),
    estimatedUsage: execution.usage === undefined,
    pricing: 'input-only',
    responseBody: responseText,
    responseMeta: { contentType, decisionsApi: { backend: entry.backend, answerTypes } },
  });
  requestDuration.observe({ plane: 'api', route: route.routeKey, method: route.method, provider: provider.slug }, Date.now() - startedAt);
  requestCounter.inc({ plane: 'api', route: route.routeKey, method: route.method, status: `${status}`, provider: provider.slug, outcome: execution.response.ok ? 'succeeded' : 'failed' });
  return new Response(responseText, { status, headers: responseHeaders });
}

async function listAggregatedModels(): Promise<Response> {
  const [providers, aliases, runtimes] = await Promise.all([
    prisma.providerModel.findMany({
      where: {
        enabled: true,
        provider: { enabled: true },
      },
      include: { provider: true },
      orderBy: [{ provider: { priority: 'asc' } }, { model: 'asc' }],
    }),
    prisma.modelAlias.findMany({
      where: { enabled: true },
      include: { provider: true },
      orderBy: { alias: 'asc' },
    }),
    listProviderRuntimes(),
  ]);

  const providerIdsWithStoredModels = new Set(providers.map((model) => model.providerId));
  const liveProviderModels = (
    await Promise.all(
      runtimes.map((provider) => (
        providerIdsWithStoredModels.has(provider.id)
          ? Promise.resolve([])
          : cachedLiveProviderModels(provider)
      )),
    )
  ).flat();

  const dataMap = new Map<string, AggregatedModelEntry>();

  for (const alias of aliases) {
    dataMap.set(`alias:${alias.alias}`, {
      id: alias.alias,
      object: 'model',
      created: Math.floor(alias.createdAt.getTime() / 1000),
      owned_by: alias.provider?.slug ?? 'alias',
      alias_for: alias.upstreamModel,
    });
  }

  for (const model of liveProviderModels) {
    dataMap.set(`provider:${model.owned_by}:${model.id}`, model);
  }

  for (const model of providers) {
    dataMap.set(`provider:${model.provider.slug}:${model.model}`, {
      id: model.model,
      object: 'model',
      created: Math.floor(model.createdAt.getTime() / 1000),
      owned_by: model.provider.slug,
      ...(model.maxContextWindow === null ? {} : { max_context_window: model.maxContextWindow }),
    });
  }

  const data = [...dataMap.values()];
  return Response.json({ object: 'list', data });
}

export function createApiApp(): Hono<{ Variables: AppVariables }> {
  const env = loadEnv();
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', async (c,next)=>{if(maintenanceActive(new URL(c.req.url).pathname))return c.json({error:'Hive is undergoing maintenance'},503);await next();});

  app.use('*', requestIdMiddleware({ trustInbound: false }));
  // Every inference-plane answer says whether the gateway already retried it (D8 cross-layer
  // retry budget). Handlers that retried set `exhausted`; everything else answers `none`.
  app.use('*', async (context, next) => {
    await next();
    if (context.res.headers.has(RETRY_HEADER)) return;
    try {
      context.res.headers.set(RETRY_HEADER, 'none');
    } catch {
      // Immutable headers (a response passed through as-is): copy it once.
      const response = new Response(context.res.body, context.res);
      response.headers.set(RETRY_HEADER, 'none');
      context.res = response;
    }
  });
  app.use('*', bodyLimit({
    maxSize: env.MAX_REQUEST_BODY_BYTES,
    onError: (context) => context.json({ error: 'Request body too large' }, 413),
  }));
  app.use('/v1/*', requireApiKey);
  app.use('/api/*', requireApiKey);
  app.use('/tokenize', requireApiKey);
  app.use('/detokenize', requireApiKey);
  app.use('/version', requireApiKey);

  app.get('/', (context) => context.json({ service: 'hive-router-api', status: 'ok' }));
  app.get('/health', (context) => context.json({ ...metadata(releasePackageRoot), status: 'ok', plane: 'api', capabilities: SERVICE_CAPABILITIES }));
  app.get('/health/dependencies', async (context) => {
    const report = await buildRouterDependencyReport();
    return context.json(report, report.status === 'ready' ? 200 : 503);
  });
  registerHealthProbes(app);

  app.get('/v1/models', async () => listAggregatedModels());
  app.post('/v1/responses', (context) => handleRouteExecution(context, 'v1.responses'));
  app.post('/v1/chat/completions', (context) => handleRouteExecution(context, 'v1.chat.completions'));
  app.post('/v1/completions', (context) => handleRouteExecution(context, 'v1.completions'));
  app.post('/v1/traits/:trait/responses', (context) => handleRouteExecution(context, 'v1.responses', {
    routingTrait: context.req.param('trait'),
    upstreamPath: '/v1/responses',
  }));
  app.post('/v1/traits/:trait/chat/completions', (context) => handleRouteExecution(context, 'v1.chat.completions', {
    routingTrait: context.req.param('trait'),
    upstreamPath: '/v1/chat/completions',
  }));
  app.post('/v1/traits/:trait/completions', (context) => handleRouteExecution(context, 'v1.completions', {
    routingTrait: context.req.param('trait'),
    upstreamPath: '/v1/completions',
  }));
  app.post('/v1/embeddings', (context) => handleRouteExecution(context, 'v1.embeddings'));
  app.post('/v1/audio/transcriptions', (context) => handleRouteExecution(context, 'v1.audio.transcriptions'));
  app.post('/v1/audio/translations', (context) => handleRouteExecution(context, 'v1.audio.translations'));
  app.post('/v1/images/generations', (context) => handleRouteExecution(context, 'v1.images.generations'));
  app.post('/v1/moderations', (context) => handleRouteExecution(context, 'v1.moderations'));
  app.post('/v1/decisions', (context) => handleDecisionsExecution(context));

  app.get('/api/tags', (context) => handleRouteExecution(context, 'ollama.native'));
  app.post('/api/show', (context) => handleRouteExecution(context, 'ollama.native'));
  app.get('/api/ps', (context) => handleRouteExecution(context, 'ollama.native'));
  app.post('/api/embed', (context) => handleRouteExecution(context, 'ollama.native'));
  app.post('/api/generate', (context) => handleRouteExecution(context, 'ollama.native'));
  app.post('/api/chat', (context) => handleRouteExecution(context, 'ollama.native'));
  app.post('/api/pull', (context) => handleRouteExecution(context, 'ollama.native'));
  app.post('/tokenize', (context) => handleRouteExecution(context, 'vllm.native'));
  app.post('/detokenize', (context) => handleRouteExecution(context, 'vllm.native'));
  app.get('/version', (context) => handleRouteExecution(context, 'vllm.native'));

  app.onError((err, context) => {
    if (err instanceof HTTPException) return context.json({ error: err.message }, err.status);
    if (err instanceof ZodError) {
      return context.json({ error: 'Validation error', issues: err.issues }, 400);
    }
    log('error', 'API request failed', {
      requestId: context.get('requestId'),
      path: context.req.path,
      error: err instanceof Error ? err.message : String(err),
    });
    return context.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
