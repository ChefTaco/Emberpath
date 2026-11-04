import { ProviderKind } from '../generated/prisma/client.js';
import { prettyJson } from '../utils/json.js';
import { shouldForwardClientHeader } from '../security/headers.js';
import { parseOpenAiModels } from './model-parsers.js';
import type { DiscoveredModel, ProviderAdapter, ProviderExecution, ProviderRuntime, RouteRequest } from './types.js';

function buildUrl(baseUrl: string, path: string, queryString: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const pathWithoutDuplicateV1 = normalizedBase.endsWith('/v1') && normalizedPath.startsWith('/v1/')
    ? normalizedPath.slice(3)
    : normalizedPath;
  const pathWithoutDuplicateApiV1 = normalizedBase.endsWith('/api/v1') && normalizedPath.startsWith('/v1/')
    ? normalizedPath.slice(3)
    : pathWithoutDuplicateV1;

  return `${normalizedBase}${pathWithoutDuplicateApiV1}${queryString}`;
}

function buildHeaders(route: RouteRequest, provider: ProviderRuntime): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(route.headers)) {
    if (!shouldForwardClientHeader(key)) {
      continue;
    }

    headers.set(key, value);
  }

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

async function parseUsage(response: Response): Promise<ProviderExecution['usage']> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return undefined;
  }

  try {
    const payload = (await response.clone().json()) as {
      usage?: {
        prompt_tokens?: number;
        input_tokens?: number;
        completion_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        reasoning_tokens?: number;
      };
    };
    const usage = payload.usage;
    if (!usage) {
      return undefined;
    }

    return {
      inputTokens: usage.prompt_tokens ?? usage.input_tokens,
      outputTokens: usage.completion_tokens ?? usage.output_tokens,
      totalTokens: usage.total_tokens,
      reasoningTokens: usage.reasoning_tokens,
    };
  } catch {
    return undefined;
  }
}

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly kind: ProviderKind;

  constructor(kind: ProviderKind) {
    this.kind = kind;
  }

  async execute(route: RouteRequest, provider: ProviderRuntime): Promise<ProviderExecution> {
    const body = route.method === 'GET' || route.method === 'HEAD'
      ? undefined
      : route.bodyBuffer
        ? Buffer.from(route.bodyBuffer)
        : undefined;
    const response = await fetch(buildUrl(provider.baseUrl, route.path, route.queryString), {
      method: route.method,
      headers: buildHeaders(route, provider),
      ...(body ? { body } : {}),
      signal: route.signal ? AbortSignal.any([route.signal, AbortSignal.timeout(provider.timeoutMs)]) : AbortSignal.timeout(provider.timeoutMs),
    });

    return {
      response,
      providerModel: route.model,
      usage: await parseUsage(response),
    };
  }

  async healthCheck(provider: ProviderRuntime): Promise<{ healthy: boolean; error?: string }> {
    try {
      const response = await fetch(buildUrl(provider.baseUrl, '/v1/models', ''), {
        method: 'GET',
        headers: buildHeaders(
          {
            requestId: 'health',
            method: 'GET',
            path: '/v1/models',
            queryString: '',
            endpointKind: 'v1.models',
            routeKey: 'health',
            stream: false,
            toolsRequested: false,
            jsonSchemaRequested: false,
            modalities: [],
            headers: { accept: 'application/json' },
          },
          provider,
        ),
        signal: AbortSignal.timeout(Math.min(provider.timeoutMs, 10000)),
      });
      if (response.ok || response.status === 401 || response.status === 403) {
        return { healthy: true };
      }

      return { healthy: false, error: `Health probe returned ${response.status}` };
    } catch (error) {
      return { healthy: false, error: error instanceof Error ? error.message : prettyJson(error) };
    }
  }

  async discoverModels(provider: ProviderRuntime): Promise<DiscoveredModel[]> {
    const response = await fetch(buildUrl(provider.baseUrl, '/v1/models', ''), {
      method: 'GET',
      headers: buildHeaders(
        {
          requestId: 'discover',
          method: 'GET',
          path: '/v1/models',
          queryString: '',
          endpointKind: 'v1.models',
          routeKey: 'discover',
          stream: false,
          toolsRequested: false,
          jsonSchemaRequested: false,
          modalities: [],
          headers: { accept: 'application/json' },
        },
        provider,
      ),
      signal: AbortSignal.timeout(Math.min(provider.timeoutMs, 15000)),
    });
    if (!response.ok) {
      throw new Error(`Model discovery returned ${response.status}`);
    }
    return parseOpenAiModels(await response.json());
  }
}
