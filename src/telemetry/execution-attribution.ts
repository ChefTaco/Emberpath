import { isValidTraceparent } from '@hivemagnus/hive-common/context';
import { HIVE_HEADERS, isValidRequestId } from '@hivemagnus/hive-common/contracts';
import { EXECUTION_HEADER, parseExecutionRef, readExecutionHeader, type ExecutionContext } from '@hivemagnus/hive-common/execution';

/**
 * What an inference client says about where a model request comes from: the execution
 * context in `x-hive-execution`, its own `x-request-id` and its W3C `traceparent`.
 *
 * Attribution only. None of it selects a route, a provider, a quota or a credential, and
 * none of it replaces the request ID the gateway generates or the actor that the
 * authenticating client key names. Malformed or oversized values are ignored, never
 * rejected, so older and newer clients keep working.
 */
export interface InboundAttribution {
  execution?: ExecutionContext;
  /** The header was present but is not a valid v1 context (unknown version, malformed, oversized). */
  executionIgnored?: boolean;
  clientRequestId?: string;
  inboundTraceparent?: string;
}

type HeaderRecord = Readonly<Record<string, string | undefined>>;

export function readInboundAttribution(headers: HeaderRecord): InboundAttribution {
  const rawExecution = headers[EXECUTION_HEADER];
  const execution = rawExecution === undefined ? undefined : readExecutionHeader({ [EXECUTION_HEADER]: rawExecution });
  const requestId = headers[HIVE_HEADERS.requestId];
  const traceparent = headers[HIVE_HEADERS.traceparent]?.trim().toLowerCase();
  return {
    ...(execution ? { execution } : {}),
    ...(rawExecution !== undefined && !execution ? { executionIgnored: true } : {}),
    ...(requestId !== undefined && isValidRequestId(requestId) ? { clientRequestId: requestId } : {}),
    ...(traceparent && isValidTraceparent(traceparent) ? { inboundTraceparent: traceparent } : {}),
  };
}

/** Who vouches for the stored execution context: only `client` is recorded, when it conflicts with the key. */
export type ExecutionAssertion = 'client';

export interface StoredExecution extends ExecutionContext {
  /**
   * `client` when the context names an Ardent instance whose profile is not the actor of the
   * authenticating client key (or the key names no actor). The context is still stored.
   */
  asserted_by?: ExecutionAssertion;
}

/**
 * The Ardent profile an execution context claims to come from: the instance of its `self`
 * reference (or, without one, its `parent`) when that reference belongs to Ardent. Instances
 * are `<magnus node>.<profile>` or `local.<profile>`.
 */
function claimedArdentProfile(execution: ExecutionContext): { instance: string; profile: string } | undefined {
  for (const ref of [execution.self, execution.parent]) {
    const parts = ref === undefined ? undefined : parseExecutionRef(ref);
    if (!parts) continue;
    if (parts.product !== 'ardent') return undefined;
    const profile = parts.instance.split('.').at(-1) ?? parts.instance;
    return { instance: parts.instance, profile };
  }
  return undefined;
}

/**
 * The context to store, marked `asserted_by: 'client'` when its Ardent instance disagrees with
 * the key's actor. A disagreement is recorded, never rejected.
 */
export function storedExecution(execution: ExecutionContext, keyActorId: string | null): StoredExecution {
  const claimed = claimedArdentProfile(execution);
  if (!claimed) return execution;
  const agrees = keyActorId !== null && (claimed.profile === keyActorId || claimed.instance === keyActorId);
  return agrees ? execution : { ...execution, asserted_by: 'client' };
}

/** The absolute deadline for starting provider attempts: the earlier of the server budget and the execution deadline. */
export function attemptDeadline(startedAt: number, budgetMs: number, execution: ExecutionContext | undefined): number {
  const serverDeadline = startedAt + budgetMs;
  return execution?.deadline_ms !== undefined ? Math.min(serverDeadline, execution.deadline_ms) : serverDeadline;
}
