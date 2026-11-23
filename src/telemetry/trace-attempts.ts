import type { TraceAttempt, TraceExecution } from '../contracts/model-admin.js';
import { safeJsonParse } from '../utils/json.js';

/** Trace event types that record one failed upstream provider attempt. */
export const PROVIDER_ATTEMPT_EVENT_TYPES = ['provider.failover', 'provider.stream_failover', 'provider.error'] as const;

const ATTEMPT_OUTCOMES = new Set<TraceAttempt['outcome']>(['http_error', 'stream_error', 'network_error', 'client_aborted']);
const CLIENT_DISCONNECTED_MESSAGE = 'Client disconnected before a provider responded';

interface AttemptEvent {
  type: string;
  message: string | null;
  dataJson: string | null;
}

interface AttemptTrace {
  providerId: string | null;
  statusCode: number | null;
  outcome: string;
  endedAt: Date | null;
}

const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function eventAttempt(event: AttemptEvent): TraceAttempt {
  const data = safeJsonParse<Record<string, unknown> | null>(event.dataJson, null) ?? {};
  const recordedOutcome = data['outcome'];
  const outcome: TraceAttempt['outcome'] = typeof recordedOutcome === 'string' && ATTEMPT_OUTCOMES.has(recordedOutcome as TraceAttempt['outcome'])
    ? recordedOutcome as TraceAttempt['outcome']
    // Events written before attempt data existed carry only their type and message.
    : event.type === 'provider.failover' ? 'http_error'
      : event.type === 'provider.stream_failover' ? 'stream_error'
        : event.message === CLIENT_DISCONNECTED_MESSAGE ? 'client_aborted' : 'network_error';
  const status = nonNegativeInteger(data['status']);
  const delayMs = nonNegativeInteger(data['delayMs']);
  const retryAfterMs = nonNegativeInteger(data['retryAfterMs']);
  const attempt = nonNegativeInteger(data['attempt']);
  return {
    providerId: typeof data['providerId'] === 'string' ? data['providerId'] : null,
    attempt: attempt !== undefined && attempt >= 1 ? attempt : null,
    ...(status !== undefined ? { status } : {}),
    ...(delayMs !== undefined ? { delayMs } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    failover: typeof data['failover'] === 'boolean' ? data['failover'] : event.type !== 'provider.error',
    outcome,
  };
}

function finalOutcome(trace: AttemptTrace): TraceAttempt['outcome'] {
  if (!trace.endedAt) return 'in_progress';
  if (trace.outcome === 'SUCCEEDED') return 'succeeded';
  if (trace.outcome === 'STREAM_FAILED') return 'stream_failed';
  return 'failed';
}

/**
 * Every upstream provider attempt of a trace, in order: one per failed-attempt event, then the
 * attempt whose provider answered (recorded on the trace itself once it is finalized).
 */
export function deriveTraceAttempts(trace: AttemptTrace, events: readonly AttemptEvent[]): TraceAttempt[] {
  const attempts = events
    .filter((event) => (PROVIDER_ATTEMPT_EVENT_TYPES as readonly string[]).includes(event.type))
    .map(eventAttempt);
  if (trace.providerId) {
    const previous = attempts
      .filter((attempt) => attempt.providerId === trace.providerId)
      .reduce((highest, attempt) => Math.max(highest, attempt.attempt ?? 0), 0);
    attempts.push({
      providerId: trace.providerId,
      attempt: previous + 1,
      ...(trace.statusCode !== null ? { status: trace.statusCode } : {}),
      failover: false,
      outcome: finalOutcome(trace),
    });
  }
  return attempts;
}

interface ExecutionColumns {
  executionRootRef: string | null;
  executionSelfRef: string | null;
  executionParentRef: string | null;
  clientRequestId: string | null;
  inboundTraceparent: string | null;
  executionJson: string | null;
}

/** The execution attribution of a trace row, as the admin API returns it. */
export function traceExecution(row: ExecutionColumns): TraceExecution {
  const context = safeJsonParse<Record<string, unknown> | null>(row.executionJson, null);
  const record = context && typeof context === 'object' && !Array.isArray(context) ? context : null;
  const attempt = nonNegativeInteger(record?.['attempt']);
  const deadline = record?.['deadline_ms'];
  return {
    root: row.executionRootRef,
    self: row.executionSelfRef,
    parent: row.executionParentRef,
    clientRequestId: row.clientRequestId,
    inboundTraceparent: row.inboundTraceparent,
    attempt: attempt ?? null,
    deadlineMs: typeof deadline === 'number' && Number.isFinite(deadline) ? deadline : null,
    assertedBy: record?.['asserted_by'] === 'client' ? 'client' : null,
    context: record,
  };
}
