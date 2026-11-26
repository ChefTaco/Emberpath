import { ProviderKind } from '../generated/prisma/client.js';
import { peekStreamStart } from '../api/stream-failover.js';
import type { UsageSnapshot } from '../telemetry/tracing.js';
import { prettyJson } from '../utils/json.js';
import { parseAnthropicModels } from './model-parsers.js';
import type { DiscoveredModel, ProviderAdapter, ProviderExecution, ProviderRuntime, RouteRequest } from './types.js';
import { providerFetch } from './upstream-fetch.js';

/**
 * Translation between the OpenAI Chat Completions / Responses APIs and the Anthropic
 * Messages API: text, images, tools and tool results in the request; text, tool calls,
 * finish reasons and usage in the answer, both as one JSON body and as a stream.
 */

type Json = Record<string, unknown>;

type AnthropicImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string };

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: AnthropicImageSource }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | AnthropicBlock[] };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

type AnthropicToolChoice =
  | { type: 'auto' | 'any'; disable_parallel_tool_use?: boolean }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean }
  | { type: 'none' };

export interface AnthropicRequest {
  model: string | undefined;
  system?: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  stream?: true;
}

/** An Anthropic Messages API answer (the fields this adapter reads). */
interface AnthropicAnswer {
  id?: string;
  model?: string;
  content?: Array<{ type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string | null;
  usage?: AnthropicUsage;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Output allowance when the caller names none; matches the quota reservation default. */
const DEFAULT_MAX_TOKENS = 4096;

function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function imageSource(value: unknown): AnthropicImageSource | undefined {
  const url = typeof value === 'string' ? value : isRecord(value) && typeof value.url === 'string' ? value.url : undefined;
  if (!url) return undefined;
  if (url.startsWith('data:')) {
    const [prefix, data] = url.split(',', 2);
    const mediaType = (prefix ?? 'data:image/png;base64').replace('data:', '').replace(';base64', '');
    const declared = isRecord(value) && typeof value.media_type === 'string' ? value.media_type : undefined;
    return { type: 'base64', media_type: declared ?? mediaType, data: data ?? '' };
  }
  return /^https?:\/\//i.test(url) ? { type: 'url', url } : undefined;
}

/** Text and image parts of an OpenAI message or Responses input item. */
function contentBlocks(content: unknown): AnthropicBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: AnthropicBlock[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    const type = typeof part.type === 'string' ? part.type : '';
    if ((type === 'text' || type === 'input_text' || type === 'output_text') && typeof part.text === 'string' && part.text) {
      blocks.push({ type: 'text', text: part.text });
    } else if (type === 'image_url' || type === 'input_image') {
      const source = imageSource(part.image_url);
      if (source) blocks.push({ type: 'image', source });
    }
  }
  return blocks;
}

function plainText(content: unknown): string {
  return contentBlocks(content).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

/** Tool arguments arrive as a JSON string; Anthropic wants the object. */
function toolInput(argumentsValue: unknown): unknown {
  if (isRecord(argumentsValue)) return argumentsValue;
  if (typeof argumentsValue !== 'string' || !argumentsValue.trim()) return {};
  try {
    const parsed = JSON.parse(argumentsValue) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toolResultContent(content: unknown): string | AnthropicBlock[] {
  if (typeof content === 'string') return content;
  const blocks = contentBlocks(content);
  return blocks.length > 0 ? blocks : '';
}

/** Collects messages, merging consecutive turns of one role as Anthropic requires. */
class Conversation {
  readonly messages: AnthropicMessage[] = [];
  readonly system: string[] = [];

  add(role: 'user' | 'assistant', blocks: AnthropicBlock[]): void {
    if (blocks.length === 0) return;
    const last = this.messages.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else this.messages.push({ role, content: [...blocks] });
  }

  addSystem(content: unknown): void {
    const text = typeof content === 'string' ? content : plainText(content);
    if (text) this.system.push(text);
  }
}

function addChatMessages(conversation: Conversation, messages: unknown[]): void {
  for (const entry of messages) {
    if (!isRecord(entry)) continue;
    const role = typeof entry.role === 'string' ? entry.role : 'user';
    if (role === 'system' || role === 'developer') {
      conversation.addSystem(entry.content);
    } else if (role === 'assistant') {
      const blocks = contentBlocks(entry.content);
      for (const call of Array.isArray(entry.tool_calls) ? entry.tool_calls : []) {
        if (!isRecord(call) || !isRecord(call.function) || typeof call.function.name !== 'string') continue;
        blocks.push({
          type: 'tool_use',
          id: typeof call.id === 'string' && call.id ? call.id : `call_${blocks.length}`,
          name: call.function.name,
          input: toolInput(call.function.arguments),
        });
      }
      conversation.add('assistant', blocks);
    } else if (role === 'tool' && typeof entry.tool_call_id === 'string') {
      conversation.add('user', [{ type: 'tool_result', tool_use_id: entry.tool_call_id, content: toolResultContent(entry.content) }]);
    } else {
      conversation.add('user', contentBlocks(entry.content));
    }
  }
}

/** Responses API `input`: messages, function calls and function call outputs. */
function addResponsesInput(conversation: Conversation, input: unknown): void {
  if (typeof input === 'string') {
    conversation.add('user', contentBlocks(input));
    return;
  }
  if (!Array.isArray(input)) return;
  for (const item of input) {
    if (!isRecord(item)) continue;
    const type = typeof item.type === 'string' ? item.type : 'message';
    if (type === 'function_call' && typeof item.name === 'string') {
      const id = typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : 'call_0';
      conversation.add('assistant', [{ type: 'tool_use', id, name: item.name, input: toolInput(item.arguments) }]);
    } else if (type === 'function_call_output' && typeof item.call_id === 'string') {
      conversation.add('user', [{ type: 'tool_result', tool_use_id: item.call_id, content: toolResultContent(item.output) }]);
    } else if (type === 'message') {
      const role = typeof item.role === 'string' ? item.role : 'user';
      if (role === 'system' || role === 'developer') conversation.addSystem(item.content);
      else conversation.add(role === 'assistant' ? 'assistant' : 'user', contentBlocks(item.content));
    }
  }
}

/** Chat Completions (`{type:'function', function:{…}}`) and Responses (`{type:'function', name, …}`) tools. */
function translateTools(tools: unknown): AnthropicTool[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (!isRecord(tool) || (tool.type !== undefined && tool.type !== 'function')) return [];
    const definition = isRecord(tool.function) ? tool.function : tool;
    if (typeof definition.name !== 'string') return [];
    return [{
      name: definition.name,
      ...(typeof definition.description === 'string' ? { description: definition.description } : {}),
      input_schema: isRecord(definition.parameters) ? definition.parameters : { type: 'object', properties: {} },
    }];
  });
}

function translateToolChoice(choice: unknown, parallelToolCalls: unknown): AnthropicToolChoice | undefined {
  const parallel = parallelToolCalls === false ? { disable_parallel_tool_use: true } : {};
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any', ...parallel };
  if (isRecord(choice)) {
    const name = isRecord(choice.function) && typeof choice.function.name === 'string'
      ? choice.function.name
      : typeof choice.name === 'string' ? choice.name : undefined;
    if (name) return { type: 'tool', name, ...parallel };
  }
  if (choice === 'auto' || parallelToolCalls === false) return { type: 'auto', ...parallel };
  return undefined;
}

function firstPositiveInteger(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

/** Build the Anthropic Messages request for an OpenAI Chat Completions or Responses request. */
export function buildAnthropicRequest(route: RouteRequest): AnthropicRequest {
  const body = isRecord(route.requestBodyJson) ? route.requestBodyJson : {};
  const conversation = new Conversation();
  if (typeof body.instructions === 'string') conversation.addSystem(body.instructions);
  if (Array.isArray(body.messages)) addChatMessages(conversation, body.messages);
  else addResponsesInput(conversation, body.input);

  const request: AnthropicRequest = {
    model: route.model,
    messages: conversation.messages,
    max_tokens: firstPositiveInteger(body.max_completion_tokens, body.max_tokens, body.max_output_tokens, body.maxTokens) ?? DEFAULT_MAX_TOKENS,
  };
  if (conversation.system.length > 0) request.system = conversation.system.join('\n\n');
  if (typeof body.temperature === 'number') request.temperature = body.temperature;
  if (typeof body.top_p === 'number') request.top_p = body.top_p;
  const stop = typeof body.stop === 'string' ? [body.stop] : Array.isArray(body.stop) ? body.stop.filter((value): value is string => typeof value === 'string' && value.length > 0) : [];
  if (stop.length > 0) request.stop_sequences = stop;
  const tools = translateTools(body.tools);
  if (tools.length > 0) {
    request.tools = tools;
    const toolChoice = translateToolChoice(body.tool_choice, body.parallel_tool_calls);
    if (toolChoice) request.tool_choice = toolChoice;
  }
  if (route.stream) request.stream = true;
  return request;
}

function finishReason(stopReason: string | null | undefined): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
  if (stopReason === 'tool_use') return 'tool_calls';
  if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') return 'length';
  if (stopReason === 'refusal') return 'content_filter';
  return 'stop';
}

function usageSnapshot(usage: AnthropicUsage | undefined): UsageSnapshot {
  const inputTokens = count(usage?.input_tokens) + count(usage?.cache_creation_input_tokens) + count(usage?.cache_read_input_tokens);
  const outputTokens = count(usage?.output_tokens);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

interface ToolCall { id: string; name: string; arguments: string }

function answerParts(answer: AnthropicAnswer): { text: string; reasoning: string; toolCalls: ToolCall[] } {
  const blocks = answer.content ?? [];
  return {
    text: blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join(''),
    reasoning: blocks.filter((block) => block.type === 'thinking').map((block) => block.thinking ?? '').join(''),
    toolCalls: blocks.flatMap((block) => (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string'
      ? [{ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) }]
      : [])),
  };
}

export function buildChatCompletionBody(model: string, answer: AnthropicAnswer): Json {
  const { text, toolCalls } = answerParts(answer);
  const usage = usageSnapshot(answer.usage);
  return {
    id: answer.id ?? `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      finish_reason: finishReason(answer.stop_reason),
      message: {
        role: 'assistant',
        content: text || (toolCalls.length > 0 ? null : ''),
        ...(toolCalls.length > 0
          ? { tool_calls: toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) }
          : {}),
      },
    }],
    usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens },
  };
}

function responseFunctionCall(call: ToolCall): Json {
  return { type: 'function_call', id: `fc_${call.id}`, call_id: call.id, name: call.name, arguments: call.arguments, status: 'completed' };
}

function responseMessage(id: string, text: string): Json {
  return { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
}

export function buildResponsesBody(model: string, answer: AnthropicAnswer): Json {
  const { text, toolCalls } = answerParts(answer);
  const usage = usageSnapshot(answer.usage);
  const id = answer.id ?? `resp_${Date.now()}`;
  const incomplete = finishReason(answer.stop_reason) === 'length';
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: incomplete ? 'incomplete' : 'completed',
    ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    output_text: text,
    output: [
      ...(text || toolCalls.length === 0 ? [responseMessage(`msg_${id}`, text)] : []),
      ...toolCalls.map(responseFunctionCall),
    ],
    usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.totalTokens },
  };
}

type StreamTrace = Awaited<NonNullable<ProviderExecution['tracePromise']>>;

interface StreamBlock { kind: 'text' | 'tool' | 'thinking' | 'other'; toolIndex: number; outputIndex: number; id: string; name: string; text: string; arguments: string }

/**
 * Turns Anthropic stream events into OpenAI stream events. `handle` returns the SSE text
 * to send for one event; `answer()` is the equivalent complete Anthropic answer so far.
 */
export class AnthropicStreamTranslator {
  private messageId = '';
  private readonly created = Math.floor(Date.now() / 1000);
  private readonly blocks = new Map<number, StreamBlock>();
  private toolCount = 0;
  private outputCount = 0;
  private usage: AnthropicUsage = {};
  private stopReason: string | null = null;
  /** Set once `message_stop` (complete) or an `error` event (failed) has been relayed. */
  state: 'open' | 'complete' | 'failed' = 'open';

  constructor(private readonly format: 'chat' | 'responses', private readonly model: string, private readonly includeUsage: boolean) {}

  private sse(payload: unknown, event?: string): string {
    return `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(payload)}\n\n`;
  }

  private chunk(delta: Json, finish: string | null = null): string {
    return this.sse({
      id: this.messageId || `chatcmpl_${this.created}`,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  }

  private event(type: string, payload: Json): string {
    return this.sse({ type, ...payload }, type);
  }

  private responseId(): string {
    return this.messageId || `resp_${this.created}`;
  }

  answer(): AnthropicAnswer {
    const ordered = [...this.blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
    return {
      id: this.responseId(),
      content: ordered.flatMap((block): NonNullable<AnthropicAnswer['content']> => {
        if (block.kind === 'text') return [{ type: 'text', text: block.text }];
        if (block.kind === 'thinking') return [{ type: 'thinking', thinking: block.text }];
        if (block.kind === 'tool') return [{ type: 'tool_use', id: block.id, name: block.name, input: toolInput(block.arguments) }];
        return [];
      }),
      stop_reason: this.stopReason,
      usage: this.usage,
    };
  }

  usageSnapshot(): UsageSnapshot {
    return usageSnapshot(this.usage);
  }

  /**
   * Usage as Anthropic reported it, or undefined when the stream ended before its final
   * count (`message_delta` usage or `message_stop`): `message_start` carries the input but
   * only a placeholder output count, so a cut-short stream's usage is unknown. Unknown usage
   * keeps the quota reservation instead of refunding it.
   */
  reportedUsage(): UsageSnapshot | undefined {
    return this.state === 'complete' || this.finalUsageSeen ? usageSnapshot(this.usage) : undefined;
  }

  private finalUsageSeen = false;

  /** The events that tell the client a stream ended before Anthropic finished it. */
  truncated(): string {
    if (this.state !== 'open') return '';
    return this.handle({ type: 'error', error: { type: 'upstream_incomplete', message: 'The upstream stream ended before the answer was complete' } });
  }

  handle(data: Json): string {
    const type = typeof data.type === 'string' ? data.type : '';
    if (type === 'message_start' && isRecord(data.message)) {
      if (typeof data.message.id === 'string') this.messageId = data.message.id;
      if (isRecord(data.message.usage)) this.usage = { ...this.usage, ...data.message.usage };
      return this.format === 'chat'
        ? this.chunk({ role: 'assistant', content: '' })
        : this.event('response.created', { response: { id: this.responseId(), object: 'response', status: 'in_progress', model: this.model, output: [] } });
    }
    if (type === 'content_block_start' && typeof data.index === 'number' && isRecord(data.content_block)) {
      return this.startBlock(data.index, data.content_block);
    }
    if (type === 'content_block_delta' && typeof data.index === 'number' && isRecord(data.delta)) {
      return this.deltaBlock(data.index, data.delta);
    }
    if (type === 'content_block_stop' && typeof data.index === 'number') {
      return this.stopBlock(data.index);
    }
    if (type === 'message_delta') {
      if (isRecord(data.delta) && typeof data.delta.stop_reason === 'string') this.stopReason = data.delta.stop_reason;
      if (isRecord(data.usage)) {
        this.usage = { ...this.usage, ...data.usage };
        this.finalUsageSeen = true;
      }
      return '';
    }
    if (type === 'message_stop') {
      this.state = 'complete';
      if (this.format === 'responses') return this.event('response.completed', { response: this.completedResponse() });
      const usage = this.usageSnapshot();
      return this.chunk({}, finishReason(this.stopReason))
        + (this.includeUsage
          ? this.sse({ id: this.messageId, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [], usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens } })
          : '')
        + 'data: [DONE]\n\n';
    }
    if (type === 'error') {
      this.state = 'failed';
      const error = isRecord(data.error) ? data.error : {};
      const message = typeof error.message === 'string' ? error.message : 'Anthropic reported a stream error';
      const errorType = typeof error.type === 'string' ? error.type : 'upstream_error';
      return this.format === 'chat'
        ? this.sse({ error: { message, type: errorType } })
        : this.event('response.failed', { response: { id: this.responseId(), object: 'response', status: 'failed', model: this.model, error: { code: errorType, message } } });
    }
    return '';
  }

  /** The final Responses API object, with the same items (IDs and order) the stream announced. */
  private completedResponse(): Json {
    const body = buildResponsesBody(this.model, this.answer());
    const items = [...this.blocks.values()]
      .filter((block) => block.kind === 'text' || block.kind === 'tool')
      .sort((left, right) => left.outputIndex - right.outputIndex)
      .map((block) => (block.kind === 'text'
        ? responseMessage(this.itemId(block), block.text)
        : responseFunctionCall({ id: block.id, name: block.name, arguments: JSON.stringify(toolInput(block.arguments)) })));
    return { ...body, id: this.responseId(), output: items.length > 0 ? items : body.output };
  }

  private startBlock(index: number, block: Json): string {
    const blockType = typeof block.type === 'string' ? block.type : '';
    const kind: StreamBlock['kind'] = blockType === 'text' ? 'text' : blockType === 'tool_use' ? 'tool' : blockType === 'thinking' ? 'thinking' : 'other';
    const state: StreamBlock = {
      kind,
      toolIndex: kind === 'tool' ? this.toolCount++ : -1,
      outputIndex: kind === 'text' || kind === 'tool' ? this.outputCount++ : -1,
      id: typeof block.id === 'string' ? block.id : `call_${index}`,
      name: typeof block.name === 'string' ? block.name : '',
      text: '',
      arguments: '',
    };
    this.blocks.set(index, state);
    if (kind === 'text') {
      const opening = this.format === 'responses'
        ? this.event('response.output_item.added', { output_index: state.outputIndex, item: { type: 'message', id: this.itemId(state), role: 'assistant', status: 'in_progress', content: [] } })
          + this.event('response.content_part.added', { item_id: this.itemId(state), output_index: state.outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
        : '';
      return opening + (typeof block.text === 'string' && block.text ? this.deltaBlock(index, { type: 'text_delta', text: block.text }) : '');
    }
    if (kind === 'tool') {
      return this.format === 'chat'
        ? this.chunk({ tool_calls: [{ index: state.toolIndex, id: state.id, type: 'function', function: { name: state.name, arguments: '' } }] })
        : this.event('response.output_item.added', { output_index: state.outputIndex, item: { type: 'function_call', id: this.itemId(state), call_id: state.id, name: state.name, arguments: '', status: 'in_progress' } });
    }
    return '';
  }

  private itemId(block: StreamBlock): string {
    return block.kind === 'tool' ? `fc_${block.id}` : `msg_${this.responseId()}_${block.outputIndex}`;
  }

  private deltaBlock(index: number, delta: Json): string {
    const block = this.blocks.get(index);
    if (!block) return '';
    if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text && block.kind === 'text') {
      block.text += delta.text;
      return this.format === 'chat'
        ? this.chunk({ content: delta.text })
        : this.event('response.output_text.delta', { item_id: this.itemId(block), output_index: block.outputIndex, content_index: 0, delta: delta.text });
    }
    if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && delta.partial_json && block.kind === 'tool') {
      block.arguments += delta.partial_json;
      return this.format === 'chat'
        ? this.chunk({ tool_calls: [{ index: block.toolIndex, function: { arguments: delta.partial_json } }] })
        : this.event('response.function_call_arguments.delta', { item_id: this.itemId(block), output_index: block.outputIndex, delta: delta.partial_json });
    }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && block.kind === 'thinking') {
      block.text += delta.thinking;
    }
    return '';
  }

  private stopBlock(index: number): string {
    const block = this.blocks.get(index);
    if (!block || this.format !== 'responses') return '';
    if (block.kind === 'text') {
      return this.event('response.output_text.done', { item_id: this.itemId(block), output_index: block.outputIndex, content_index: 0, text: block.text })
        + this.event('response.content_part.done', { item_id: this.itemId(block), output_index: block.outputIndex, content_index: 0, part: { type: 'output_text', text: block.text, annotations: [] } })
        + this.event('response.output_item.done', { output_index: block.outputIndex, item: responseMessage(this.itemId(block), block.text) });
    }
    if (block.kind === 'tool') {
      const call = { id: block.id, name: block.name, arguments: JSON.stringify(toolInput(block.arguments)) };
      return this.event('response.function_call_arguments.done', { item_id: this.itemId(block), output_index: block.outputIndex, arguments: call.arguments })
        + this.event('response.output_item.done', { output_index: block.outputIndex, item: responseFunctionCall(call) });
    }
    return '';
  }
}

/** The `data:` payloads of one SSE event block, joined as the SSE spec says. */
function eventData(block: string): string | undefined {
  const lines = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(line.startsWith('data: ') ? 6 : 5));
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function translateStream(upstream: ReadableStream<Uint8Array>, translator: AnthropicStreamTranslator): { stream: ReadableStream<Uint8Array>; tracePromise: Promise<StreamTrace> } {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const startedAt = Date.now();
  let buffer = '';
  let firstByteMs: number | undefined;
  let finishTrace!: (trace: StreamTrace) => void;
  const tracePromise = new Promise<StreamTrace>((resolve) => { finishTrace = resolve; });
  let finished = false;
  const finish = (errored: boolean): void => {
    if (finished) return;
    finished = true;
    const answer = translator.answer();
    const { text, reasoning, toolCalls } = answerParts(answer);
    finishTrace({
      responseBody: toolCalls.length > 0 ? `${text}${text ? '\n' : ''}${JSON.stringify({ tool_calls: toolCalls })}` : text,
      reasoningText: reasoning,
      ...(translator.reportedUsage() ? { usage: translator.reportedUsage() } : {}),
      ...(firstByteMs === undefined ? {} : { firstByteMs }),
      ...(errored ? { errored: true } : {}),
    });
  };

  // Pull-driven so a slow client slows the upstream read, and a client that goes away
  // cancels the upstream request.
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (!done) firstByteMs ??= Date.now() - startedAt;
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = done ? '' : events.pop() ?? '';
          let output = '';
          for (const block of events) {
            const data = eventData(block);
            if (!data) continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(data) as unknown;
            } catch {
              continue;
            }
            if (isRecord(parsed)) output += translator.handle(parsed);
            if (translator.state !== 'open') break;
          }
          // An upstream that ends without `message_stop` is reported to the client as a failure.
          if (done) output += translator.truncated();
          if (output) controller.enqueue(encoder.encode(output));
          if (translator.state !== 'open' || done) {
            // A stream that ends without `message_stop` was cut short.
            finish(translator.state !== 'complete');
            if (!done) void reader.cancel().catch(() => undefined);
            controller.close();
            return;
          }
          if (output) return;
        }
      } catch (error) {
        finish(true);
        void reader.cancel(error).catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish(true);
      await reader.cancel(reason);
    },
  });
  return { stream, tracePromise };
}

/** The error in the first event of an Anthropic stream, if that event is an error. */
function openingStreamError(text: string): { type: string; message: string } | undefined {
  const first = text.split(/\r?\n\r?\n/).find((block) => eventData(block) !== undefined);
  const data = first === undefined ? undefined : eventData(first);
  if (data === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.type !== 'error') return undefined;
  const error = isRecord(parsed.error) ? parsed.error : {};
  return {
    type: typeof error.type === 'string' ? error.type : 'upstream_error',
    message: typeof error.message === 'string' ? error.message : 'Anthropic reported a stream error',
  };
}

function errorResponse(status: number, message: string): Response {
  return Response.json({ error: { message, type: 'invalid_request_error' } }, { status });
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly kind = ProviderKind.ANTHROPIC;

  private headers(provider: ProviderRuntime, json: boolean): Headers {
    const headers = new Headers({ 'anthropic-version': '2023-06-01', ...(json ? { 'content-type': 'application/json' } : { accept: 'application/json' }) });
    if (provider.authSecret) headers.set('x-api-key', provider.authSecret);
    for (const [key, value] of Object.entries(provider.defaultHeaders)) headers.set(key, value);
    return headers;
  }

  async execute(route: RouteRequest, provider: ProviderRuntime): Promise<ProviderExecution> {
    const base = provider.baseUrl.replace(/\/$/, '');
    if (route.endpointKind === 'v1.models') {
      // Anthropic's model list already has the OpenAI `data[].id` shape.
      const response = await providerFetch(`${base}/v1/models`, { method: 'GET', headers: this.headers(provider, false), signal: route.signal, timeoutMs: provider.timeoutMs });
      return { response };
    }
    if (route.endpointKind !== 'v1.chat.completions' && route.endpointKind !== 'v1.responses') {
      return { response: errorResponse(400, `Anthropic providers do not serve ${route.endpointKind}`) };
    }

    const payload = buildAnthropicRequest(route);
    const upstream = await providerFetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: this.headers(provider, true),
      body: JSON.stringify(payload),
      signal: route.signal,
      timeoutMs: provider.timeoutMs,
    });

    // An upstream error is never translated: its status drives failover.
    if (!upstream.ok) {
      return { response: upstream };
    }

    const model = route.model ?? 'anthropic';
    const format = route.endpointKind === 'v1.responses' ? 'responses' : 'chat';
    if (route.stream && upstream.body && (upstream.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const body = isRecord(route.requestBodyJson) ? route.requestBodyJson : {};
      const includeUsage = isRecord(body.stream_options) && body.stream_options.include_usage === true;
      // A stream that opens with an error event (Anthropic answers 200 and then reports
      // `overloaded_error`, say) becomes an HTTP error before anything reaches the client,
      // so it counts against the provider's circuit and can fail over.
      const peeked = await peekStreamStart(upstream.body);
      const error = openingStreamError(peeked.firstChunkText);
      if (error) {
        void peeked.stream.cancel().catch(() => undefined);
        return { response: Response.json({ error: { message: error.message, type: error.type } }, { status: error.type === 'overloaded_error' ? 529 : 503 }) };
      }
      const { stream, tracePromise } = translateStream(peeked.stream, new AnthropicStreamTranslator(format, model, includeUsage));
      return {
        response: new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            ...(upstream.headers.get('request-id') ? { 'request-id': upstream.headers.get('request-id')! } : {}),
          },
        }),
        providerModel: route.model,
        tracePromise,
      };
    }

    const answer = (await upstream.json()) as AnthropicAnswer;
    return {
      response: Response.json(format === 'responses' ? buildResponsesBody(model, answer) : buildChatCompletionBody(model, answer)),
      providerModel: route.model,
      usage: usageSnapshot(answer.usage),
      reasoningText: answerParts(answer).reasoning,
    };
  }

  async healthCheck(provider: ProviderRuntime): Promise<{ healthy: boolean; error?: string }> {
    try {
      // No credential or body is sent, so this probe may follow a redirect.
      const response = await fetch(provider.baseUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(Math.min(provider.timeoutMs, 8000)),
      });
      return response.status < 500
        ? { healthy: true }
        : { healthy: false, error: `Health probe returned ${response.status}` };
    } catch (error) {
      return { healthy: false, error: error instanceof Error ? error.message : prettyJson(error) };
    }
  }

  async discoverModels(provider: ProviderRuntime): Promise<DiscoveredModel[]> {
    const response = await providerFetch(`${provider.baseUrl.replace(/\/$/, '')}/v1/models`, {
      method: 'GET',
      headers: this.headers(provider, false),
      signal: AbortSignal.timeout(Math.min(provider.timeoutMs, 15000)),
    });
    if (!response.ok) {
      throw new Error(`Model discovery returned ${response.status}`);
    }
    return parseAnthropicModels(await response.json());
  }
}
