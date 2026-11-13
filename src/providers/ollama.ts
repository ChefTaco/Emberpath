import { ProviderKind } from '../generated/prisma/client.js';
import type { DiscoveredModel, ProviderAdapter, ProviderExecution, ProviderRuntime, RouteRequest } from './types.js';
import type { UsageSnapshot } from '../telemetry/tracing.js';
import { parseOllamaTags } from './model-parsers.js';
import { shouldForwardClientHeader } from '../security/headers.js';

function baseUrl(provider: ProviderRuntime): string {
  return provider.baseUrl.replace(/\/$/, '');
}

/**
 * The provider's configured default headers and credential. Ollama itself needs
 * neither, but a hosted Ollama endpoint or one behind an authenticating reverse
 * proxy does, and a secret the operator stored must reach it on every call.
 */
function applyProviderHeaders(headers: Headers, provider: ProviderRuntime): Headers {
  for (const [key, value] of Object.entries(provider.defaultHeaders)) {
    headers.set(key, value);
  }

  if (provider.authSecret) {
    if (provider.authMode === 'BEARER') {
      headers.set(provider.authHeaderName, `Bearer ${provider.authSecret}`);
    } else if (provider.authMode === 'API_KEY') {
      headers.set('x-api-key', provider.authSecret);
    } else if (provider.authMode === 'HEADER') {
      headers.set(provider.authHeaderName, provider.authSecret);
    }
  }

  return headers;
}

function buildNativeHeaders(route: RouteRequest, provider: ProviderRuntime): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(route.headers)) {
    if (shouldForwardClientHeader(key)) {
      headers.set(key, value);
    }
  }

  return applyProviderHeaders(headers, provider);
}

/** Headers for calls this adapter builds itself (translated OpenAI routes, probes). */
function buildTranslatedHeaders(provider: ProviderRuntime, json = true): Headers {
  return applyProviderHeaders(new Headers(json ? { 'content-type': 'application/json' } : {}), provider);
}

function normalizeMessages(messages: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const role = typeof entry.role === 'string' ? entry.role : 'user';
    const content = entry.content;
    const normalized: Record<string, unknown> = { role, content: '' };
    if (typeof content === 'string') {
      normalized.content = content;
    } else if (Array.isArray(content)) {
      const textParts: string[] = [];
      const images: string[] = [];
      for (const part of content) {
        if (!part || typeof part !== 'object') {
          continue;
        }

        const partType = typeof part.type === 'string' ? part.type : '';
        if ((partType === 'text' || partType === 'input_text') && typeof part.text === 'string') {
          textParts.push(part.text);
        }

        if ((partType === 'image_url' || partType === 'input_image') && part.image_url && typeof part.image_url === 'object') {
          const imageUrl = part.image_url as { url?: unknown };
          if (typeof imageUrl.url === 'string' && imageUrl.url.startsWith('data:')) {
            const [, data] = imageUrl.url.split(',', 2);
            images.push(data ?? '');
          }
        }
      }

      normalized.content = textParts.join('');
      if (images.length > 0) {
        normalized.images = images;
      }
    }

    return [normalized];
  });
}

function createSseResponse(
  stream: ReadableStream<Uint8Array>,
): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}

export class OllamaAdapter implements ProviderAdapter {
  readonly kind = ProviderKind.OLLAMA;

  async execute(route: RouteRequest, provider: ProviderRuntime): Promise<ProviderExecution> {
    if (route.endpointKind === 'ollama.native') {
      const body = route.method === 'GET'
        ? undefined
        : route.bodyBuffer
          ? Buffer.from(route.bodyBuffer)
          : undefined;
      const response = await fetch(`${baseUrl(provider)}${route.path}${route.queryString}`, {
        method: route.method,
        headers: buildNativeHeaders(route, provider),
        ...(body ? { body } : {}),
        signal: route.signal ? AbortSignal.any([route.signal, AbortSignal.timeout(provider.timeoutMs)]) : AbortSignal.timeout(provider.timeoutMs),
      });
      return { response };
    }

    if (route.endpointKind === 'v1.models') {
      const response = await fetch(`${baseUrl(provider)}/api/tags`, {
        method: 'GET',
        headers: buildTranslatedHeaders(provider, false),
        signal: route.signal ? AbortSignal.any([route.signal, AbortSignal.timeout(provider.timeoutMs)]) : AbortSignal.timeout(provider.timeoutMs),
      });
      return { response };
    }

    const requestBody = (route.requestBodyJson ?? {}) as Record<string, unknown>;

    if (route.endpointKind === 'v1.embeddings') {
      const payload = {
        model: route.model,
        input: requestBody.input,
      };
      const upstream = await fetch(`${baseUrl(provider)}/api/embed`, {
        method: 'POST',
        headers: buildTranslatedHeaders(provider),
        body: JSON.stringify(payload),
        signal: route.signal ? AbortSignal.any([route.signal, AbortSignal.timeout(provider.timeoutMs)]) : AbortSignal.timeout(provider.timeoutMs),
      });
      if (!upstream.ok) {
        return { response: upstream };
      }

      const json = (await upstream.json()) as { embeddings?: unknown[] };
      return {
        response: Response.json({
          object: 'list',
          data: Array.isArray(json.embeddings)
            ? json.embeddings.map((embedding, index) => ({
                object: 'embedding',
                index,
                embedding,
              }))
            : [],
          model: route.model,
        }),
      };
    }

    if (route.endpointKind === 'v1.completions') {
      const prompt = typeof requestBody.prompt === 'string'
        ? requestBody.prompt
        : Array.isArray(requestBody.prompt)
          ? requestBody.prompt.join('\n')
          : '';
      const stream = requestBody.stream === true;
      const upstream = await fetch(`${baseUrl(provider)}/api/generate`, {
        method: 'POST',
        headers: buildTranslatedHeaders(provider),
        body: JSON.stringify({ model: route.model, prompt, stream }),
        signal: route.signal ? AbortSignal.any([route.signal, AbortSignal.timeout(provider.timeoutMs)]) : AbortSignal.timeout(provider.timeoutMs),
      });
      return { response: upstream };
    }

    const messages = normalizeMessages(requestBody.messages ?? requestBody.input);
    const stream = route.stream;

    const upstream = await fetch(`${baseUrl(provider)}/api/chat`, {
      method: 'POST',
      headers: buildTranslatedHeaders(provider),
      body: JSON.stringify({
        model: route.model,
        messages,
        stream,
        tools: requestBody.tools,
        format: route.jsonSchemaRequested ? (requestBody.response_format ?? requestBody.format ?? undefined) : undefined,
      }),
      signal: route.signal ? AbortSignal.any([route.signal, AbortSignal.timeout(provider.timeoutMs)]) : AbortSignal.timeout(provider.timeoutMs),
    });

    // An upstream error is never a stream: hand it back as is so the status
    // drives failover instead of becoming an empty 200 event stream.
    if (!upstream.ok) {
      return { response: upstream };
    }

    if (!stream || !upstream.body) {

      const json = (await upstream.json()) as {
        model?: string;
        message?: { content?: string; thinking?: string };
        eval_count?: number;
      };
      const text = json.message?.content ?? '';
      const usage: UsageSnapshot = json.eval_count === undefined
        ? {}
        : {
            outputTokens: json.eval_count,
            totalTokens: json.eval_count,
          };

      if (route.endpointKind === 'v1.responses') {
        return {
          response: Response.json({
            id: `resp_${Date.now()}`,
            object: 'response',
            model: json.model ?? route.model,
            output_text: text,
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text }],
              },
            ],
            usage: {
              input_tokens: 0,
              output_tokens: json.eval_count ?? 0,
              total_tokens: json.eval_count ?? 0,
            },
          }),
          providerModel: json.model ?? route.model ?? undefined,
          usage,
          reasoningText: json.message?.thinking ?? '',
        };
      }

      return {
        response: Response.json({
          id: `chatcmpl_${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: json.model ?? route.model,
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
            prompt_tokens: 0,
            completion_tokens: json.eval_count ?? 0,
            total_tokens: json.eval_count ?? 0,
          },
        }),
        providerModel: json.model ?? route.model ?? undefined,
        usage,
        reasoningText: json.message?.thinking ?? '',
      };
    }

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const reader = upstream.body.getReader();
    let buffer = '';
    let responseText = '';
    let reasoningText = '';
    let firstByteMs: number | undefined;
    const startedAt = Date.now();

    // The trace is written when the stream ends, not when it starts, so it holds
    // the text that was actually relayed and how the stream finished.
    type StreamTrace = Awaited<NonNullable<ProviderExecution['tracePromise']>>;
    let finishTrace!: (trace: StreamTrace) => void;
    const tracePromise = new Promise<StreamTrace>((resolve) => { finishTrace = resolve; });
    let finished = false;
    const finish = (errored: boolean): void => {
      if (finished) return;
      finished = true;
      finishTrace({
        responseBody: responseText,
        reasoningText,
        ...(firstByteMs === undefined ? {} : { firstByteMs }),
        ...(errored ? { errored: true } : {}),
      });
    };

    /** Translate one NDJSON line. Returns 'error' when Ollama reported a failure. */
    const relayLine = (controller: ReadableStreamDefaultController<Uint8Array>, line: string): 'sent' | 'none' | 'error' => {
      if (!line.trim()) {
        return 'none';
      }

      const json = JSON.parse(line) as {
        message?: { content?: string; thinking?: string };
        done?: boolean;
        error?: unknown;
      };

      if (json.error) {
        const message = typeof json.error === 'string' ? json.error : 'Ollama reported a stream error';
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`));
        return 'error';
      }

      let sent = false;
      if (json.message?.thinking) {
        reasoningText += json.message.thinking;
      }

      if (json.message?.content) {
        responseText += json.message.content;
        const payload = route.endpointKind === 'v1.responses'
          ? `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: json.message.content })}\n\n`
          : `data: ${JSON.stringify({
              id: `chatcmpl_${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: route.model,
              choices: [{ index: 0, delta: { content: json.message.content }, finish_reason: null }],
            })}\n\n`;
        controller.enqueue(encoder.encode(payload));
        sent = true;
      }

      if (json.done) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        sent = true;
      }

      return sent ? 'sent' : 'none';
    };

    // Pull-driven so a slow client slows the upstream read instead of buffering
    // the whole answer, and a client that goes away cancels the upstream request.
    const transformStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (firstByteMs === undefined && !done) {
              firstByteMs = Date.now() - startedAt;
            }

            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = done ? '' : lines.pop() ?? '';

            let sent = false;
            for (const line of lines) {
              const outcome = relayLine(controller, line);
              if (outcome === 'error') {
                finish(true);
                void reader.cancel().catch(() => undefined);
                controller.close();
                return;
              }
              sent ||= outcome === 'sent';
            }

            if (done) {
              finish(false);
              controller.close();
              return;
            }
            if (sent) {
              return;
            }
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

    return {
      response: createSseResponse(transformStream),
      providerModel: route.model,
      tracePromise,
    };
  }

  async healthCheck(provider: ProviderRuntime): Promise<{ healthy: boolean; error?: string }> {
    try {
      const response = await fetch(`${baseUrl(provider)}/api/tags`, {
        method: 'GET',
        headers: buildTranslatedHeaders(provider, false),
        signal: AbortSignal.timeout(Math.min(provider.timeoutMs, 8000)),
      });
      return response.ok
        ? { healthy: true }
        : { healthy: false, error: `Health probe returned ${response.status}` };
    } catch (error) {
      return { healthy: false, error: error instanceof Error ? error.message : 'Unknown health check error' };
    }
  }

  async discoverModels(provider: ProviderRuntime): Promise<DiscoveredModel[]> {
    const response = await fetch(`${baseUrl(provider)}/api/tags`, {
      method: 'GET',
      headers: buildTranslatedHeaders(provider, false),
      signal: AbortSignal.timeout(Math.min(provider.timeoutMs, 15000)),
    });
    if (!response.ok) {
      throw new Error(`Model discovery returned ${response.status}`);
    }
    return parseOllamaTags(await response.json());
  }
}
