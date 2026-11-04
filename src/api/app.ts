import { maintenanceActive } from '../release/runtime.js';
import { metadata } from '../release/runtime.js';
import { packageRoot as releasePackageRoot } from '../config/paths.js';
import { sqliteWrite } from '../storage/sqlite-write.js';
import { observeStream } from "./observed-stream.js";
import { TraceOutcome, type Provider as ProviderRecord } from '../generated/prisma/client.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Context } from 'hono';
import { ZodError } from 'zod';
import type { AppVariables } from '../types/app.js';
import { requestIdMiddleware } from '../utils/request.js';
import { requireApiKey } from '../security/api-auth.js';
import { redactHeaders, shouldCopyResponseHeader } from '../security/headers.js';
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

class Semaphore {
  private current = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.capacity) {
      this.current += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current += 1;
        resolve();
      });
    });
  }

  release(): void {
    this.current = Math.max(0, this.current - 1);
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

const semaphores = new Map<string, Semaphore>();
const circuitBreakers = new Map<string, { failures: number; openUntil?: number }>();

function getSemaphore(provider: ProviderRuntime): Semaphore {
  const existing = semaphores.get(provider.id);
  if (existing) {
    return existing;
  }

  const semaphore = new Semaphore(Math.max(1, provider.concurrency));
  semaphores.set(provider.id, semaphore);
  return semaphore;
}

function isCircuitOpen(providerId: string): boolean {
  const state = circuitBreakers.get(providerId);
  return state?.openUntil !== undefined && state.openUntil > Date.now();
}

function markProviderFailure(providerId: string): void {
  const state = circuitBreakers.get(providerId) ?? { failures: 0 };
  state.failures += 1;
  if (state.failures >= 3) {
    state.openUntil = Date.now() + 30_000;
  }
  circuitBreakers.set(providerId, state);
}

function resetProviderCircuit(providerId: string): void {
  circuitBreakers.delete(providerId);
}

function shouldRetry(route: RouteRequest): boolean {
  return ['GET', 'HEAD', 'OPTIONS'].includes(route.method) || Boolean(route.headers['x-idempotency-key']);
}

function shouldFailoverStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

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
      bodyBuffer = new Uint8Array(arrayBuffer);
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

async function runExecutionWithFailover(
  route: RouteRequest,
  decision: RouteDecision,
  providers: ProviderRuntime[],
  traceId: string,
): Promise<{ provider?: ProviderRuntime; execution?: ProviderExecution; failureResponse?: Response | undefined; failureError?: string | undefined }> {
  const candidateProviders = decision.candidateProviderIds
    .map((providerId) => providers.find((provider) => provider.id === providerId))
    .filter((provider): provider is ProviderRuntime => Boolean(provider));
  const upstreamRoute = withResolvedRouteModel(route, decision.targetModel);

  let lastFailureResponse: Response | undefined;
  let lastFailureError: string | undefined;

  for (const provider of candidateProviders) {
    if (isCircuitOpen(provider.id)) {
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
      await semaphore.acquire();
      try {
        const execution = await adapter.execute(upstreamRoute, provider);

        if (shouldFailoverStatus(execution.response.status)) {
          markProviderFailure(provider.id);
          lastFailureResponse = execution.response;
          lastFailureError = `Upstream returned ${execution.response.status}`;
          await addTraceEvent(traceId, {
            type: 'provider.failover',
            phase: 'execution',
            message: `Provider ${provider.slug} returned ${execution.response.status}`,
          });

          const nextProvider = candidateProviders.find((candidate) => candidate.id !== provider.id);
          if (nextProvider) {
            failoverCounter.inc({
              route: route.routeKey,
              from_provider: provider.slug,
              to_provider: nextProvider.slug,
            });
          }
          continue;
        }

        // Streaming-aware, retry-before-first-token failover: for SSE responses
        // with a downstream candidate still available, peek the first chunk to
        // catch upstreams that return 200 then immediately emit an error event.
        const currentIndex = candidateProviders.indexOf(provider);
        const hasNextCandidate = candidateProviders.some(
          (candidate, index) => index > currentIndex && !isCircuitOpen(candidate.id),
        );
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
            markProviderFailure(provider.id);
            lastFailureError = `Provider ${provider.slug} emitted a stream error before the first token`;
            await addTraceEvent(traceId, {
              type: 'provider.stream_failover',
              phase: 'execution',
              message: lastFailureError,
              data: { phase: 'pre-first-byte' },
            });
            streamFailureCounter.inc({ route: route.routeKey, provider: provider.slug, phase: 'pre-first-byte' });
            const nextProvider = candidateProviders.find(
              (candidate, index) => index > currentIndex && !isCircuitOpen(candidate.id),
            );
            if (nextProvider) {
              failoverCounter.inc({
                route: route.routeKey,
                from_provider: provider.slug,
                to_provider: nextProvider.slug,
              });
            }
            continue;
          }

          resetProviderCircuit(provider.id);
          const rebuiltResponse = new Response(peeked.stream, {
            status: execution.response.status,
            headers: execution.response.headers,
          });
          return { provider, execution: { ...execution, response: rebuiltResponse } };
        }

        resetProviderCircuit(provider.id);
        return { provider, execution };
      } catch (error) {
        markProviderFailure(provider.id);
        lastFailureError = error instanceof Error ? error.message : 'Unknown provider execution error';
        await addTraceEvent(traceId, {
          type: 'provider.error',
          phase: 'execution',
          message: lastFailureError,
          data: { providerId: provider.id, attempt },
        });
      } finally {
        semaphore.release();
      }
    }
  }

  return {
    ...(lastFailureResponse ? { failureResponse: lastFailureResponse } : {}),
    ...(lastFailureError ? { failureError: lastFailureError } : {}),
  };
}

function copyResponseHeaders(headers: Headers): Headers {
  const copied = new Headers();
  for (const [key, value] of headers.entries()) {
    if (!shouldCopyResponseHeader(key)) {
      continue;
    }
    copied.set(key, value);
  }
  return copied;
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
    const explicitMax = rawBody?.max_completion_tokens ?? rawBody?.max_tokens ?? rawBody?.max_output_tokens;
    if (hardTokenLimit && endpointKind !== 'v1.embeddings' && (typeof explicitMax !== 'number' || !Number.isSafeInteger(explicitMax) || explicitMax <= 0 || route.modalities.some((mode) => mode !== 'text'))) return context.json({ error: 'Token budgets require a bounded text request with an explicit maximum output token count; multimodal accounting is unavailable' }, 400);
    const maxOutput = Number(explicitMax ?? (endpointKind === 'v1.embeddings' ? 0 : 4096));
    const completions = Number(rawBody?.n ?? 1);
    if (!Number.isSafeInteger(completions) || completions < 1 || completions > 128) return context.json({ error: 'Invalid completion count' }, 400);
    const tokenReservation = Buffer.byteLength(route.requestBodyText ?? "") + (Number.isSafeInteger(maxOutput) && maxOutput >= 0 ? maxOutput * completions : 4096);
    const quota = await enforceClientKeyQuota(clientKey, tokenReservation);
    if (quota.unavailable) return context.json({ error: 'Quota accounting unavailable' }, 503, { 'retry-after': '5' });
    quotaReservationId = quota.reservationId;
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
    quotaWarnings = quota.warnings;
  }

  const providers = await listProviderRuntimes();
  const decision = await resolveRoute(route, providers);

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
    return context.json({ error: decision.denialReason, route_decision: decision }, 403);
  }

  const executionResult = await runExecutionWithFailover(route, decision, providers, trace.traceId);
  const provider = executionResult.provider;
  const execution = executionResult.execution;

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
        headers: { 'content-type': 'application/json' },
      },
    );
  }

  const responseHeaders = copyResponseHeaders(execution.response.headers);
  if (quotaWarnings.length > 0) {
    responseHeaders.set('x-hive-quota-warning', quotaWarnings.join(','));
  }
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
      await finalizeTrace({
        traceId: trace.traceId,
        statusCode: execution.response.status,
        outcome: TraceOutcome.SUCCEEDED,
        providerId: provider.id,
        providerKind: provider.kind,
        providerModel: execution.providerModel ?? decision.targetModel ?? route.model,
        responseHeaders: redactHeaders(toHeaderObject(responseHeaders)),
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
        outcome: 'succeeded',
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
        responseHeaders: redactHeaders(toHeaderObject(responseHeaders)),
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
    responseHeaders: redactHeaders(toHeaderObject(responseHeaders)),
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
          : fetchLiveProviderModels(provider)
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

  app.use('*', requestIdMiddleware);
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
  app.get('/health', (context) => context.json({ ...metadata(releasePackageRoot), status: 'ok', plane: 'api' }));
  app.get('/health/live', (context) => context.json({ ...metadata(releasePackageRoot), status: 'ok', plane: 'api', checks: [{ name: 'process', status: 'pass', message: 'running' }] }));
  app.get('/health/dependencies', async (context) => {
    const report = await buildRouterDependencyReport();
    return context.json(report, report.status === 'ready' ? 200 : 503);
  });
  app.get('/health/ready', async (context) => {
    const report = await buildRouterDependencyReport();
    return context.json(report, report.status === 'ready' ? 200 : 503);
  });

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
