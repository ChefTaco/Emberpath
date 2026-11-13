// Executes a planned /v1/decisions request against its eligible backends in
// order, with the same circuit breakers, concurrency limits and failover status
// rules as the other API routes.
import { getProviderAdapter } from '../providers/index.js';
import type { ProviderExecution, ProviderRuntime, RouteRequest } from '../providers/types.js';
import { withResolvedRouteModel } from '../routing/request-body.js';
import { postJevDecision } from '../routing/jev-transport.js';
import { addTraceEvent, type UsageSnapshot } from '../telemetry/tracing.js';
import { failoverCounter } from '../telemetry/metrics.js';
import { getSemaphore, isCircuitOpen, markProviderFailure, resetProviderCircuit, shouldFailoverStatus, shouldRetry } from '../api/provider-guards.js';
import { JevResponseMismatch, translateJevResponse } from './jev-translate.js';
import type { DecisionsPlanEntry } from './backends.js';
import { decisionsError } from './schema.js';

/** Upper bound for a translated Jev response (400 questions with 255 choices each fit easily). */
const MAX_JEV_RESPONSE_BYTES = 16 * 1024 * 1024;

function trimSlash(value: string): string { return value.endsWith('/') ? value.slice(0, -1) : value; }

export function jevEndpointFor(entry: Pick<DecisionsPlanEntry, 'backend' | 'provider'>): string {
  const base = trimSlash(entry.provider.baseUrl);
  if (entry.backend === 'typesafe-jev') return base.endsWith('/v1') ? `${base}/systemone` : `${base}/v1/systemone`;
  // OpenRouter: https://openrouter.ai/api/v1 -> https://openrouter.ai/api/alpha/decisions
  if (base.endsWith('/api/v1')) return `${base.slice(0, -3)}/alpha/decisions`;
  if (base.endsWith('/api')) return `${base}/alpha/decisions`;
  return `${base}/api/alpha/decisions`;
}

function jevHeaders(provider: ProviderRuntime): Record<string, string> {
  const headers: Record<string, string> = { ...provider.defaultHeaders, 'Content-Type': 'application/json' };
  if (provider.authSecret) {
    if (provider.authMode === 'BEARER') headers[provider.authHeaderName] = `Bearer ${provider.authSecret}`;
    else if (provider.authMode === 'API_KEY') headers['x-api-key'] = provider.authSecret;
    else if (provider.authMode === 'HEADER') headers[provider.authHeaderName] = provider.authSecret;
  }
  if (provider.kind === 'OPENROUTER') headers['X-OpenRouter-Title'] = 'Emberpath Decisions';
  return headers;
}

function count(values: Array<{ type?: unknown }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const type = typeof value.type === 'string' && ['predicate', 'choice', 'score', 'refusal'].includes(value.type) ? value.type : 'other';
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Map an OpenAI Decisions `usage` object onto Emberpath's token accounting. */
export function decisionsUsageSnapshot(usage: unknown): UsageSnapshot | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const record = usage as Record<string, unknown>;
  const inputDetails = (record.input_tokens_details ?? {}) as Record<string, unknown>;
  const outputDetails = (record.output_tokens_details ?? {}) as Record<string, unknown>;
  const inputTokens = finite(record.input_tokens);
  const outputTokens = finite(record.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens: finite(record.total_tokens) ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    reasoningTokens: finite(outputDetails.reasoning_tokens),
    cachedInputTokens: finite(inputDetails.cached_tokens),
    cacheWriteInputTokens: finite(inputDetails.cache_write_tokens),
  };
}

export interface DecisionsExecution {
  entry: DecisionsPlanEntry;
  execution: ProviderExecution;
  /** Response body text, already read, to finalize the trace and answer the client. */
  responseText: string;
  answerTypes: Record<string, number>;
}

export interface DecisionsExecutionResult {
  result?: DecisionsExecution;
  failureResponse?: { status: number; text: string; contentType: string } | undefined;
  failureError?: string | undefined;
}

function summarizeAnswers(text: string): Record<string, number> {
  try {
    const parsed = JSON.parse(text) as { answers?: unknown };
    return Array.isArray(parsed.answers) ? count(parsed.answers as Array<{ type?: unknown }>) : {};
  } catch { return {}; }
}

async function attemptOpenAi(route: RouteRequest, entry: DecisionsPlanEntry): Promise<{ status: number; text: string; headers: Headers; usage?: UsageSnapshot | undefined }> {
  const upstream = withResolvedRouteModel(route, entry.model);
  const execution = await getProviderAdapter(entry.provider.kind).execute(upstream, entry.provider);
  const text = await execution.response.text();
  let usage: UsageSnapshot | undefined;
  if (execution.response.ok) {
    try { usage = decisionsUsageSnapshot((JSON.parse(text) as { usage?: unknown }).usage); } catch { usage = undefined; }
  }
  return { status: execution.response.status, text, headers: execution.response.headers, usage };
}

async function attemptJev(route: RouteRequest, entry: DecisionsPlanEntry): Promise<{ status: number; text: string; headers: Headers; usage?: UsageSnapshot | undefined }> {
  const translation = entry.jev!;
  const upstream = await postJevDecision(jevEndpointFor(entry), translation.body, {
    headers: jevHeaders(entry.provider), timeoutMs: entry.provider.timeoutMs, maxResponseBytes: MAX_JEV_RESPONSE_BYTES,
    signal: route.signal, readErrorBody: true,
  });
  const headers = new Headers({ 'content-type': 'application/json' });
  if (!upstream.ok) {
    let detail: unknown;
    try { detail = JSON.parse(upstream.text); } catch { detail = upstream.text.slice(0, 4096) || undefined; }
    const body = decisionsError(`The ${entry.backend} decisions backend returned HTTP ${upstream.status}`, 'upstream_error', `upstream_${upstream.status}`, detail);
    return { status: upstream.status, text: JSON.stringify(body), headers };
  }
  let raw: unknown;
  try { raw = JSON.parse(upstream.text); } catch { throw new JevResponseMismatch('Jev returned a response that is not JSON'); }
  const translated = translateJevResponse(raw, translation);
  return { status: 200, text: JSON.stringify(translated), headers, usage: decisionsUsageSnapshot(translated.usage) };
}

export async function executeDecisionsPlan(route: RouteRequest, entries: DecisionsPlanEntry[], traceId: string): Promise<DecisionsExecutionResult> {
  let failureResponse: DecisionsExecutionResult['failureResponse'];
  let failureError: string | undefined;
  for (const [index, entry] of entries.entries()) {
    if (route.signal?.aborted) break;
    const provider = entry.provider;
    if (isCircuitOpen(provider.id)) {
      await addTraceEvent(traceId, { type: 'provider.skipped', phase: 'routing', message: `Provider ${provider.slug} skipped because its circuit is open` });
      continue;
    }
    const semaphore = getSemaphore(provider);
    const attempts = shouldRetry(route) ? Math.max(1, provider.maxRetries + 1) : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await semaphore.acquire();
      try {
        const outcome = entry.backend === 'openai' ? await attemptOpenAi(route, entry) : await attemptJev(route, entry);
        if (shouldFailoverStatus(outcome.status)) {
          markProviderFailure(provider.id);
          failureResponse = { status: outcome.status, text: outcome.text, contentType: outcome.headers.get('content-type') ?? 'application/json' };
          failureError = `Upstream returned ${outcome.status}`;
          await addTraceEvent(traceId, { type: 'provider.failover', phase: 'execution', message: `Provider ${provider.slug} returned ${outcome.status}` });
          const next = entries.slice(index + 1).find((candidate) => !isCircuitOpen(candidate.provider.id));
          if (next) failoverCounter.inc({ route: route.routeKey, from_provider: provider.slug, to_provider: next.provider.slug });
          continue;
        }
        resetProviderCircuit(provider.id);
        const response = new Response(outcome.text, { status: outcome.status, headers: outcome.headers });
        return {
          result: {
            entry,
            execution: { response, providerModel: entry.model, usage: outcome.usage },
            responseText: outcome.text,
            answerTypes: outcome.status < 400 ? summarizeAnswers(outcome.text) : {},
          },
        };
      } catch (error) {
        if (route.signal?.aborted) {
          // A caller that went away is not a provider failure: leave the circuit
          // breaker alone and stop trying other backends.
          failureError = 'Client disconnected before a provider responded';
          await addTraceEvent(traceId, { type: 'provider.error', phase: 'execution', message: failureError, data: { providerId: provider.id, attempt } });
          return { failureError };
        }
        markProviderFailure(provider.id);
        failureError = error instanceof JevResponseMismatch ? error.message
          : error instanceof Error && error.name === 'TimeoutError' ? `Provider ${provider.slug} timed out`
          : error instanceof Error && /^decision_[a-z_0-9]+$/u.test(error.message) ? error.message
          : 'Provider request failed';
        await addTraceEvent(traceId, { type: 'provider.error', phase: 'execution', message: failureError, data: { providerId: provider.id, attempt } });
      } finally {
        semaphore.release();
      }
    }
  }
  return { failureResponse, failureError };
}
