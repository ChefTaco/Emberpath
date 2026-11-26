import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderKind } from '../../src/generated/prisma/client.js';
import { AnthropicAdapter, buildAnthropicRequest } from '../../src/providers/anthropic.js';
import type { EndpointKind, ProviderRuntime, RouteRequest } from '../../src/providers/types.js';
import { buildRuntime } from '../fixtures/routing-runtime.js';

function route(body: Record<string, unknown>, endpointKind: EndpointKind = 'v1.chat.completions'): RouteRequest {
  return {
    requestId: 'request-anthropic',
    method: 'POST',
    path: endpointKind === 'v1.responses' ? '/v1/responses' : '/v1/chat/completions',
    queryString: '',
    endpointKind,
    routeKey: 'POST /v1/chat/completions',
    model: 'claude-test',
    stream: body.stream === true,
    toolsRequested: Array.isArray(body.tools),
    jsonSchemaRequested: false,
    modalities: [],
    headers: { 'content-type': 'application/json' },
    requestBodyJson: body,
    requestBodyText: JSON.stringify(body),
  };
}

const provider = (overrides: Partial<ProviderRuntime> = {}) => buildRuntime(ProviderKind.ANTHROPIC, 'anthropic', { authSecret: 'sk-ant-test', ...overrides });

const weatherTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};

/** A recorded Anthropic Messages stream: text, then one tool call, then the stop. */
const TOOL_STREAM = [
  ['message_start', { type: 'message_start', message: { id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, usage: { input_tokens: 25, cache_read_input_tokens: 5, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['ping', { type: 'ping' }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'check.' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city": "Par' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'is"}' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 40 } }],
  ['message_stop', { type: 'message_stop' }],
] as const;

function sseBody(events: ReadonlyArray<readonly [string, unknown]>, splitAt?: number | 'per-event') {
  const blocks = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const text = blocks.join('');
  const encoder = new TextEncoder();
  // Split mid-event to prove events are reassembled across network chunks.
  const chunks = splitAt === 'per-event' ? blocks : splitAt === undefined ? [text] : [text.slice(0, splitAt), text.slice(splitAt)];
  const state = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk !== undefined) controller.enqueue(encoder.encode(chunk));
      else controller.close();
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, state };
}

function sseResponse(events: ReadonlyArray<readonly [string, unknown]>, splitAt?: number | 'per-event') {
  const body = sseBody(events, splitAt);
  return { response: new Response(body.stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }), state: body.state };
}

function dataEvents(text: string): unknown[] {
  return text.split('\n\n').flatMap((block) => {
    const data = block.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
    if (!data) return [];
    return [data === '[DONE]' ? '[DONE]' : JSON.parse(data) as unknown];
  });
}

function sentBody(fetchMock: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]![1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('providers/anthropic request translation', () => {
  it('turns tool definitions, assistant tool calls and tool results into Anthropic blocks', () => {
    const request = buildAnthropicRequest(route({
      model: 'claude-test',
      max_completion_tokens: 512,
      stop: 'END',
      tools: [weatherTool],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      parallel_tool_calls: false,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Weather in Paris and Rome?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
            { id: 'call_b', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Rome"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_a', content: '18C sunny' },
        { role: 'tool', tool_call_id: 'call_b', content: [{ type: 'text', text: '22C clear' }] },
        { role: 'user', content: 'Thanks' },
      ],
    }));

    expect(request).toEqual({
      model: 'claude-test',
      system: 'Be brief.',
      max_tokens: 512,
      stop_sequences: ['END'],
      tools: [{ name: 'get_weather', description: 'Current weather for a city', input_schema: weatherTool.function.parameters }],
      tool_choice: { type: 'tool', name: 'get_weather', disable_parallel_tool_use: true },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Weather in Paris and Rome?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_a', name: 'get_weather', input: { city: 'Paris' } },
            { type: 'tool_use', id: 'call_b', name: 'get_weather', input: { city: 'Rome' } },
          ],
        },
        {
          // Every result for one assistant turn goes back in a single user message.
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_a', content: '18C sunny' },
            { type: 'tool_result', tool_use_id: 'call_b', content: [{ type: 'text', text: '22C clear' }] },
            { type: 'text', text: 'Thanks' },
          ],
        },
      ],
    });
  });

  it('maps the OpenAI tool_choice values', () => {
    const choice = (tool_choice: unknown) => buildAnthropicRequest(route({ tools: [weatherTool], tool_choice, messages: [{ role: 'user', content: 'hi' }] })).tool_choice;
    expect(choice('auto')).toEqual({ type: 'auto' });
    expect(choice('required')).toEqual({ type: 'any' });
    expect(choice('none')).toEqual({ type: 'none' });
    expect(choice(undefined)).toBeUndefined();
  });

  it('reads Responses API input, instructions, function calls and outputs', () => {
    const request = buildAnthropicRequest(route({
      model: 'claude-test',
      instructions: 'Use tools.',
      max_output_tokens: 300,
      tools: [{ type: 'function', name: 'get_weather', parameters: weatherTool.function.parameters }],
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Weather in Oslo?' }] },
        { type: 'function_call', call_id: 'call_o', name: 'get_weather', arguments: '{"city":"Oslo"}' },
        { type: 'function_call_output', call_id: 'call_o', output: '-2C snow' },
      ],
    }, 'v1.responses'));

    expect(request.system).toBe('Use tools.');
    expect(request.max_tokens).toBe(300);
    expect(request.tools).toEqual([{ name: 'get_weather', input_schema: weatherTool.function.parameters }]);
    expect(request.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Weather in Oslo?' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_o', name: 'get_weather', input: { city: 'Oslo' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_o', content: '-2C snow' }] },
    ]);
  });

  it('accepts a plain string Responses input', () => {
    expect(buildAnthropicRequest(route({ input: 'Hello' }, 'v1.responses')).messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }]);
  });
});

describe('providers/anthropic adapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('translates a tool_use answer into OpenAI tool_calls', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      id: 'msg_02',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'toolu_02', name: 'get_weather', input: { city: 'Paris' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 30, output_tokens: 12 },
    }));

    const execution = await new AnthropicAdapter().execute(route({ messages: [{ role: 'user', content: 'Weather?' }], tools: [weatherTool] }), provider());

    expect(fetchMock.mock.calls[0]![0]).toBe('https://anthropic.example.com/v1/messages');
    expect((fetchMock.mock.calls[0]![1] as RequestInit & { headers: Headers }).headers.get('x-api-key')).toBe('sk-ant-test');
    expect(sentBody(fetchMock).stream).toBeUndefined();
    expect(execution.usage).toEqual({ inputTokens: 30, outputTokens: 12, totalTokens: 42 });
    const body = await execution.response.json() as { choices: Array<{ finish_reason: string; message: unknown }> };
    expect(body.choices[0]!.finish_reason).toBe('tool_calls');
    expect(body.choices[0]!.message).toEqual({
      role: 'assistant',
      content: 'Checking.',
      tool_calls: [{ id: 'toolu_02', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
    });
  });

  it('answers the Responses API with function_call output items', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      id: 'msg_03',
      content: [{ type: 'tool_use', id: 'toolu_03', name: 'get_weather', input: { city: 'Rome' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    }));

    const execution = await new AnthropicAdapter().execute(route({ input: 'Weather in Rome?', tools: [weatherTool] }, 'v1.responses'), provider());
    const body = await execution.response.json() as { status: string; output: unknown[]; usage: unknown };

    expect(body.status).toBe('completed');
    expect(body.output).toEqual([{ type: 'function_call', id: 'fc_toolu_03', call_id: 'toolu_03', name: 'get_weather', arguments: '{"city":"Rome"}', status: 'completed' }]);
    expect(body.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });

  it('relays a recorded Anthropic stream as chat.completion.chunk events with tool calls', async () => {
    const upstream = sseResponse(TOOL_STREAM, 333);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(upstream.response);

    const execution = await new AnthropicAdapter().execute(route({
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'Weather in Paris?' }],
      tools: [weatherTool],
    }), provider());

    expect(sentBody(fetchMock).stream).toBe(true);
    expect(execution.response.headers.get('content-type')).toContain('text/event-stream');
    const events = dataEvents(await execution.response.text()) as Array<any>;
    const deltas = events.filter((event) => event !== '[DONE]' && event.choices?.length).map((event) => event.choices[0]);

    expect(deltas[0]).toEqual({ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null });
    expect(deltas.flatMap((choice) => (choice.delta.content ? [choice.delta.content] : [])).join('')).toBe('Let me check.');
    const toolDeltas = deltas.flatMap((choice) => choice.delta.tool_calls ?? []);
    expect(toolDeltas[0]).toEqual({ index: 0, id: 'toolu_01', type: 'function', function: { name: 'get_weather', arguments: '' } });
    expect(toolDeltas.slice(1).map((call: any) => call.function.arguments).join('')).toBe('{"city": "Paris"}');
    expect(toolDeltas.slice(1).every((call: any) => call.index === 0 && call.id === undefined)).toBe(true);
    expect(deltas.at(-1)).toEqual({ index: 0, delta: {}, finish_reason: 'tool_calls' });
    expect(events.at(-2)).toMatchObject({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 40, total_tokens: 70 } });
    expect(events.at(-1)).toBe('[DONE]');

    const trace = await execution.tracePromise!;
    expect(trace.errored).toBeUndefined();
    expect(trace.usage).toEqual({ inputTokens: 30, outputTokens: 40, totalTokens: 70 });
    expect(trace.responseBody).toContain('Let me check.');
    expect(trace.responseBody).toContain('get_weather');
  });

  it('omits the usage chunk unless the client asks for it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(TOOL_STREAM).response);
    const execution = await new AnthropicAdapter().execute(route({ stream: true, messages: [{ role: 'user', content: 'hi' }] }), provider());
    const events = dataEvents(await execution.response.text()) as Array<any>;
    expect(events.some((event) => event !== '[DONE]' && event.usage)).toBe(false);
  });

  it('streams Responses API events and finishes with the complete response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(TOOL_STREAM).response);
    const execution = await new AnthropicAdapter().execute(route({ stream: true, input: 'Weather in Paris?', tools: [weatherTool] }, 'v1.responses'), provider());
    const events = dataEvents(await execution.response.text()) as Array<any>;
    const types = events.map((event) => event.type);

    expect(types[0]).toBe('response.created');
    expect(types).toContain('response.output_text.delta');
    expect(types).toContain('response.function_call_arguments.delta');
    const completed = events.at(-1)!;
    expect(completed.type).toBe('response.completed');
    expect(completed.response.output_text).toBe('Let me check.');
    expect(completed.response.output[1]).toEqual({ type: 'function_call', id: 'fc_toolu_01', call_id: 'toolu_01', name: 'get_weather', arguments: '{"city":"Paris"}', status: 'completed' });
    expect(completed.response.usage).toEqual({ input_tokens: 30, output_tokens: 40, total_tokens: 70 });
  });

  it('relays a mid-stream error event and marks the trace as failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse([
      TOOL_STREAM[0],
      TOOL_STREAM[1],
      TOOL_STREAM[3],
      ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
    ]).response);

    const execution = await new AnthropicAdapter().execute(route({ stream: true, messages: [{ role: 'user', content: 'hi' }] }), provider());
    const events = dataEvents(await execution.response.text());

    expect(events.at(-1)).toEqual({ error: { message: 'Overloaded', type: 'overloaded_error' } });
    expect(events).not.toContain('[DONE]');
    expect((await execution.tracePromise!).errored).toBe(true);
  });

  it('marks a stream that ends without message_stop as failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(TOOL_STREAM.slice(0, 5)).response);
    const execution = await new AnthropicAdapter().execute(route({ stream: true, messages: [{ role: 'user', content: 'hi' }] }), provider());
    expect(dataEvents(await execution.response.text())).not.toContain('[DONE]');
    expect((await execution.tracePromise!).errored).toBe(true);
  });

  it('cancels the upstream stream when the client goes away', async () => {
    const upstream = sseResponse(TOOL_STREAM, 'per-event');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(upstream.response);
    const execution = await new AnthropicAdapter().execute(route({ stream: true, messages: [{ role: 'user', content: 'hi' }] }), provider());
    const reader = execution.response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect((await execution.tracePromise!).errored).toBe(true);
    expect(upstream.state.cancelled).toBe(true);
  });

  it('returns an upstream error status untranslated so failover can act on it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { status: 529 }));
    const execution = await new AnthropicAdapter().execute(route({ stream: true, messages: [{ role: 'user', content: 'hi' }] }), provider());
    expect(execution.response.status).toBe(529);
    expect(execution.tracePromise).toBeUndefined();
  });
});
