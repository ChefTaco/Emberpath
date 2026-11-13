import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderKind } from '../../src/generated/prisma/client.js';
import { OllamaAdapter } from '../../src/providers/ollama.js';
import type { ProviderRuntime, RouteRequest } from '../../src/providers/types.js';
import { buildRuntime } from '../fixtures/routing-runtime.js';

function route(overrides: Partial<RouteRequest> = {}): RouteRequest {
  const body = { model: 'llama', stream: true, messages: [{ role: 'user', content: 'hello' }] };
  return {
    requestId: 'request-ollama',
    method: 'POST',
    path: '/v1/chat/completions',
    queryString: '',
    endpointKind: 'v1.chat.completions',
    routeKey: 'POST /v1/chat/completions',
    model: 'llama',
    stream: true,
    toolsRequested: false,
    jsonSchemaRequested: false,
    modalities: [],
    headers: { 'content-type': 'application/json' },
    requestBodyJson: body,
    requestBodyText: JSON.stringify(body),
    ...overrides,
  };
}

const provider = (overrides: Partial<ProviderRuntime> = {}) => buildRuntime(ProviderKind.OLLAMA, 'ollama', overrides);
const line = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);

/** An upstream NDJSON body fed one chunk per pull, recording reads and cancellation. */
function upstreamBody(chunks: Uint8Array[]) {
  const state = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, state };
}

describe('providers/ollama', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns an upstream error to a streaming caller instead of an empty event stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'model "llama" not found' }, { status: 404 }));

    const execution = await new OllamaAdapter().execute(route(), provider());

    expect(execution.response.status).toBe(404);
    expect(execution.tracePromise).toBeUndefined();
    expect(await execution.response.json()).toEqual({ error: 'model "llama" not found' });
  });

  it('lets a retryable upstream status reach the failover logic for streams', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('overloaded', { status: 503 }));

    expect((await new OllamaAdapter().execute(route(), provider())).response.status).toBe(503);
  });

  it('records the relayed text once the stream has finished, not when it starts', async () => {
    const body = upstreamBody([
      line({ message: { thinking: 'hmm' } }),
      line({ message: { content: 'Hel' } }),
      line({ message: { content: 'lo' } }),
      line({ done: true }),
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body.stream, { status: 200 }));

    const execution = await new OllamaAdapter().execute(route(), provider());
    let settled = false;
    void execution.tracePromise!.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    const text = await execution.response.text();
    expect(text.match(/"content":"(Hel|lo)"/g)).toHaveLength(2);
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
    const trace = await execution.tracePromise!;
    expect(trace).toMatchObject({ responseBody: 'Hello', reasoningText: 'hmm' });
    expect(trace.firstByteMs).toBeTypeOf('number');
    expect(trace.errored).toBeUndefined();
  });

  it('reads upstream only as fast as the client reads, and cancels it when the client leaves', async () => {
    const chunks = Array.from({ length: 50 }, (_, index) => line({ message: { content: `chunk-${index} ` } }));
    const body = upstreamBody(chunks);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body.stream, { status: 200 }));

    const execution = await new OllamaAdapter().execute(route(), provider());
    const reader = execution.response.body!.getReader();
    await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Without backpressure the adapter would have drained all 50 chunks by now.
    expect(body.state.pulls).toBeLessThan(10);

    await reader.cancel();
    expect(body.state.cancelled).toBe(true);
    const trace = await execution.tracePromise!;
    expect(trace.errored).toBe(true);
    // Only what was read before the client left, not the whole answer.
    expect(trace.responseBody!.startsWith('chunk-0 ')).toBe(true);
    expect(trace.responseBody!.length).toBeLessThan(100);
  });

  it('relays an error Ollama reports mid-stream and marks the trace as failed', async () => {
    const body = upstreamBody([line({ message: { content: 'partial' } }), line({ error: 'out of memory' }), line({ message: { content: 'never' } })]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body.stream, { status: 200 }));

    const execution = await new OllamaAdapter().execute(route(), provider());
    const text = await execution.response.text();

    expect(text).toContain('"content":"partial"');
    expect(text).toContain('data: {"error":{"message":"out of memory","type":"upstream_error"}}');
    expect(text).not.toContain('never');
    expect(await execution.tracePromise!).toMatchObject({ responseBody: 'partial', errored: true });
  });

  it('sends the configured credential and default headers on translated and native calls', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ message: { content: 'hi' } }));
    const secured = provider({ authMode: 'BEARER', authHeaderName: 'Authorization', authSecret: 'synthetic-ollama-credential', defaultHeaders: { 'x-team': 'synthetic' } });
    const adapter = new OllamaAdapter();

    await adapter.execute(route({ stream: false }), secured);
    await adapter.execute(route({ endpointKind: 'ollama.native', path: '/api/chat', headers: { authorization: 'Bearer client-key' } }), secured);
    await adapter.healthCheck(secured);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers((init as RequestInit).headers);
      expect(headers.get('authorization')).toBe('Bearer synthetic-ollama-credential');
      expect(headers.get('x-team')).toBe('synthetic');
    }
  });

  it('sends no credential header when the provider has no secret', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ message: { content: 'hi' } }));

    await new OllamaAdapter().execute(route({ stream: false }), provider());

    expect(new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers).has('authorization')).toBe(false);
  });
});
