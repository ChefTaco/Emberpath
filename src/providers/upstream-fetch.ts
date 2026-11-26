/**
 * Every request that carries a provider credential goes through here. Redirects are not
 * followed: the HTTP client drops `Authorization` on a cross-origin redirect but forwards any
 * other header (`x-api-key`, a custom auth header, default headers) and, for 307/308, the
 * request body. No supported provider API redirects, so a redirect is a provider failure with
 * a reason the operator can act on, never a second request.
 */
export class ProviderRedirectError extends Error {
  override name = 'ProviderRedirectError';
  constructor(readonly status: number, readonly target: string | undefined) {
    super(`Provider answered with a redirect (HTTP ${status}${target ? ` to ${target}` : ''}). Redirects are not followed, so stored credentials only reach the configured server; set the provider's base URL to the final address.`);
  }
}

/** Scheme, host and port of a redirect target; its path and query may hold tokens and are dropped. */
function redirectTarget(location: string | null, requestUrl: string): string | undefined {
  if (!location) return undefined;
  try {
    const url = new URL(location, requestUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export type ProviderFetchInit = Omit<RequestInit, 'signal'> & {
  /** The caller's own cancellation (for example the client going away). */
  signal?: AbortSignal | undefined;
  /**
   * The provider's timeout. It bounds the wait for the response headers and then each wait
   * for the next body chunk, never the whole body: a stream that keeps producing tokens runs
   * as long as it needs to, and one that goes silent for this long is cut.
   */
  timeoutMs?: number | undefined;
};

function upstreamTimeout(timeoutMs: number, phase: 'response' | 'next chunk'): DOMException {
  return new DOMException(`Provider sent no ${phase === 'response' ? 'response' : 'data'} within ${timeoutMs} ms`, 'TimeoutError');
}

/**
 * Wrap a response body so each wait for the next chunk is bounded by `timeoutMs`. The timer
 * only runs while the consumer is waiting for data, so a slow client never trips it.
 */
function withIdleTimeout(response: Response, timeoutMs: number, abort: (reason: DOMException) => void): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      timer = setTimeout(() => abort(upstreamTimeout(timeoutMs, 'next chunk')), timeoutMs);
      timer.unref?.();
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      } finally {
        stop();
      }
    },
    cancel(reason) {
      stop();
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export async function providerFetch(url: string, init: ProviderFetchInit = {}): Promise<Response> {
  const { timeoutMs, signal: callerSignal, ...rest } = init;
  const controller = timeoutMs !== undefined ? new AbortController() : undefined;
  const signal = controller
    ? callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal
    : callerSignal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (controller && timeoutMs !== undefined) {
    timer = setTimeout(() => controller.abort(upstreamTimeout(timeoutMs, 'response')), timeoutMs);
    timer.unref?.();
  }
  let response: Response;
  try {
    response = await fetch(url, { ...rest, ...(signal ? { signal } : {}), redirect: 'manual' });
  } finally {
    if (timer) clearTimeout(timer);
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    void response.body?.cancel().catch(() => undefined);
    throw new ProviderRedirectError(response.status, redirectTarget(response.headers.get('location'), url));
  }
  return controller && timeoutMs !== undefined
    ? withIdleTimeout(response, timeoutMs, (reason) => controller.abort(reason))
    : response;
}
