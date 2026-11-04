import { ProviderKind } from '../generated/prisma/client.js';
import { prettyJson } from '../utils/json.js';
import { parseAnthropicModels } from './model-parsers.js';
import type { DiscoveredModel, ProviderAdapter, ProviderExecution, ProviderRuntime, RouteRequest } from './types.js';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  >;
}

function parseOpenAiMessages(route: RouteRequest): {
  system?: string;
  messages: AnthropicMessage[];
  maxTokens: number;
  temperature?: number;
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
} {
  const body = (route.requestBodyJson ?? {}) as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const anthropicMessages: AnthropicMessage[] = [];
  const systemParts: string[] = [];

  for (const entry of messages) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const role = typeof entry.role === 'string' ? entry.role : 'user';
    const content = entry.content;
    if (role === 'system') {
      if (typeof content === 'string') {
        systemParts.push(content);
      }
      continue;
    }

    const normalized: AnthropicMessage = {
      role: role === 'assistant' ? 'assistant' : 'user',
      content: [],
    };

    if (typeof content === 'string') {
      normalized.content.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') {
          continue;
        }

        const partType = typeof part.type === 'string' ? part.type : '';
        if ((partType === 'text' || partType === 'input_text') && typeof part.text === 'string') {
          normalized.content.push({ type: 'text', text: part.text });
        }

        if ((partType === 'image_url' || partType === 'input_image') && part.image_url && typeof part.image_url === 'object') {
          const imageUrl = part.image_url as { url?: unknown; media_type?: unknown };
          if (typeof imageUrl.url === 'string' && imageUrl.url.startsWith('data:')) {
            const [prefix, data] = imageUrl.url.split(',', 2);
            const mediaType = (prefix ?? 'data:image/png;base64').replace('data:', '').replace(';base64', '');
            normalized.content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: typeof imageUrl.media_type === 'string' ? imageUrl.media_type : mediaType,
                data: data ?? '',
              },
            });
          }
        }
      }
    }

    anthropicMessages.push(normalized);
  }

  const tools = Array.isArray(body.tools)
    ? body.tools.flatMap((tool) => {
        if (!tool || typeof tool !== 'object') {
          return [];
        }

        const functionDef = tool.function;
        if (!functionDef || typeof functionDef !== 'object' || typeof functionDef.name !== 'string') {
          return [];
        }

        return [{
          name: functionDef.name,
          description: typeof functionDef.description === 'string' ? functionDef.description : undefined,
          input_schema: functionDef.parameters,
        }];
      })
    : undefined;

  const result: {
    system?: string;
    messages: AnthropicMessage[];
    maxTokens: number;
    temperature?: number;
    tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
  } = {
    messages: anthropicMessages,
    maxTokens: typeof body.max_tokens === 'number'
      ? body.max_tokens
      : typeof body.max_output_tokens === 'number'
        ? body.max_output_tokens
        : typeof body.maxTokens === 'number'
          ? body.maxTokens
          : 1024,
  };

  if (systemParts.length > 0) {
    result.system = systemParts.join('\n\n');
  }

  if (typeof body.temperature === 'number') {
    result.temperature = body.temperature;
  }

  if (tools && tools.length > 0) {
    result.tools = tools;
  }

  return result;
}

function buildChatCompletionResponse(model: string, payload: {
  id?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}): Response {
  const text = payload.content?.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('') ?? '';
  return Response.json({
    id: payload.id ?? `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: text,
        },
      },
    ],
    usage: {
      prompt_tokens: payload.usage?.input_tokens ?? 0,
      completion_tokens: payload.usage?.output_tokens ?? 0,
      total_tokens: (payload.usage?.input_tokens ?? 0) + (payload.usage?.output_tokens ?? 0),
    },
  });
}

function buildResponsesApiResponse(model: string, payload: {
  id?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}): Response {
  const text = payload.content?.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('') ?? '';
  return Response.json({
    id: payload.id ?? `resp_${Date.now()}`,
    object: 'response',
    model,
    output_text: text,
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text,
          },
        ],
      },
    ],
    usage: {
      input_tokens: payload.usage?.input_tokens ?? 0,
      output_tokens: payload.usage?.output_tokens ?? 0,
      total_tokens: (payload.usage?.input_tokens ?? 0) + (payload.usage?.output_tokens ?? 0),
    },
  });
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly kind = ProviderKind.ANTHROPIC;

  async execute(route: RouteRequest, provider: ProviderRuntime): Promise<ProviderExecution> {
    const headers = new Headers({
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    });

    if (provider.authSecret) {
      headers.set('x-api-key', provider.authSecret);
    }

    for (const [key, value] of Object.entries(provider.defaultHeaders)) {
      headers.set(key, value);
    }

    const normalized = parseOpenAiMessages(route);
    const payload = {
      model: route.model,
      system: normalized.system,
      messages: normalized.messages,
      max_tokens: normalized.maxTokens,
      temperature: normalized.temperature,
      tools: normalized.tools,
    };

    const upstream = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: route.signal ? AbortSignal.any([route.signal, AbortSignal.timeout(provider.timeoutMs)]) : AbortSignal.timeout(provider.timeoutMs),
    });

    if (!upstream.ok) {
      return { response: upstream };
    }

    const upstreamJson = (await upstream.json()) as {
      id?: string;
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    return {
      response: route.endpointKind === 'v1.responses'
        ? buildResponsesApiResponse(route.model ?? 'anthropic', upstreamJson)
        : buildChatCompletionResponse(route.model ?? 'anthropic', upstreamJson),
      providerModel: route.model,
      usage: {
        inputTokens: upstreamJson.usage?.input_tokens,
        outputTokens: upstreamJson.usage?.output_tokens,
        totalTokens: (upstreamJson.usage?.input_tokens ?? 0) + (upstreamJson.usage?.output_tokens ?? 0),
      },
    };
  }

  async healthCheck(provider: ProviderRuntime): Promise<{ healthy: boolean; error?: string }> {
    try {
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
    const headers = new Headers({ 'anthropic-version': '2023-06-01', accept: 'application/json' });
    if (provider.authSecret) {
      headers.set('x-api-key', provider.authSecret);
    }
    for (const [key, value] of Object.entries(provider.defaultHeaders)) {
      headers.set(key, value);
    }
    const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/v1/models`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(Math.min(provider.timeoutMs, 15000)),
    });
    if (!response.ok) {
      throw new Error(`Model discovery returned ${response.status}`);
    }
    return parseAnthropicModels(await response.json());
  }
}
