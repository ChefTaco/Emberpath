/**
 * Streaming-aware failover and partial-trace helpers.
 *
 * Streaming failures are harder to reason about than plain request/response
 * failures: an upstream can return `200 OK` and then immediately emit an error
 * event, or it can fail half-way through after bytes already reached the client.
 * These helpers classify the failure phase and support retry-before-first-token
 * when it is safe (nothing has reached the client yet).
 */

export type StreamFailurePhase = 'pre-first-byte' | 'mid-stream' | 'complete';

export interface StreamOutcomeInput {
  /** Number of bytes/characters observed from the upstream stream. */
  bytesReceived: number;
  /** Whether reading the stream threw or aborted before completing. */
  errored: boolean;
}

export interface StreamOutcomeClassification {
  failed: boolean;
  phase: StreamFailurePhase;
  /** Whether any bytes reached the client before the failure. */
  reachedClient: boolean;
  /** Whether it is safe to transparently retry (no bytes reached the client). */
  retrySafe: boolean;
}

/**
 * Classify how a streaming response ended. A clean read is `complete`. An error
 * before any byte is `pre-first-byte` (safe to retry); an error after bytes is
 * `mid-stream` (not safe to retry — the client already saw a partial answer).
 */
export function classifyStreamOutcome(input: StreamOutcomeInput): StreamOutcomeClassification {
  const reachedClient = input.bytesReceived > 0;
  if (!input.errored) {
    return { failed: false, phase: 'complete', reachedClient, retrySafe: false };
  }
  const phase: StreamFailurePhase = reachedClient ? 'mid-stream' : 'pre-first-byte';
  return { failed: true, phase, reachedClient, retrySafe: phase === 'pre-first-byte' };
}

/**
 * Detect whether the first chunk of an SSE stream is actually an error payload.
 * Conservative on purpose: only an explicit `event: error` or a `data:` line
 * whose JSON body carries a truthy `error` field is treated as a failure, so we
 * never fail over a legitimate response.
 */
export function looksLikeStreamError(chunkText: string): boolean {
  const trimmed = chunkText.trim();
  if (!trimmed) {
    return false;
  }
  if (/^event:\s*error\b/im.test(trimmed)) {
    return true;
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const match = line.match(/^data:\s*(\{.*\})\s*$/);
    if (!match || !match[1]) {
      continue;
    }
    try {
      const parsed = JSON.parse(match[1]) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && 'error' in parsed && Boolean(parsed.error)) {
        return true;
      }
    } catch {
      // Not JSON — ignore and keep scanning.
    }
  }
  return false;
}

export interface PeekedStream {
  firstChunkText: string;
  stream: ReadableStream<Uint8Array>;
}

/**
 * Read the first chunk from a stream and return a rebuilt stream that replays
 * that first chunk followed by the remainder. This lets the router inspect the
 * start of a streamed response (for pre-first-token failover) without losing
 * any bytes for the client.
 */
export async function peekStreamStart(body: ReadableStream<Uint8Array>): Promise<PeekedStream> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  const firstValue = first.value;
  const firstChunkText = firstValue ? decoder.decode(firstValue, { stream: true }) : '';
  const firstDone = first.done;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (firstValue) {
        controller.enqueue(firstValue);
      }
      if (firstDone) {
        controller.close();
      }
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        if (next.value) {
          controller.enqueue(next.value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });

  return { firstChunkText, stream };
}
