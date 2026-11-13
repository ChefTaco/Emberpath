/**
 * Shared HTTP transport for Jev decision APIs (TypeSafe `systemone` and the
 * OpenRouter decisions API). Both the shadow decision model and the public
 * `/v1/decisions` endpoint use it; each caller keeps its own endpoint, request
 * body, credentials and limits.
 */
export interface JevTransportOptions {
  apiKey?: string | undefined;
  /** Full header set; when given, `apiKey` is ignored and nothing else is added. */
  headers?: Record<string, string> | undefined;
  timeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal | undefined;
  /**
   * When false (the shadow default) a non-2xx response is cancelled unread and
   * reported as `decision_http_<status>`. When true the bounded body is returned
   * so the caller can pass the upstream error through.
   */
  readErrorBody?: boolean | undefined;
}

export interface JevTransportResult {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
}

export async function postJevDecision(endpoint: string, body: unknown, options: JevTransportOptions): Promise<JevTransportResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error',
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    headers: options.headers ?? { Authorization: `Bearer ${options.apiKey ?? ''}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok && !options.readErrorBody) { await response.body?.cancel(); throw new Error(`decision_http_${response.status}`); }
  // Bound upstream output; never log raw provider errors or untrusted response text.
  const reader = response.body?.getReader();
  if (!reader) {
    if (response.ok) throw new Error('decision_empty_response');
    return { status: response.status, ok: false, headers: response.headers, text: '' };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > options.maxResponseBytes) { await reader.cancel(); throw new Error('decision_response_limit'); }
    chunks.push(chunk.value);
  }
  return { status: response.status, ok: response.ok, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') };
}
