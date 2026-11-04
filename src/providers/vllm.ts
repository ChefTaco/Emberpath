import { ProviderKind } from '../generated/prisma/client.js';
import { OpenAiCompatibleAdapter } from './openai-compatible.js';
import { shouldForwardClientHeader } from '../security/headers.js';
import type { DiscoveredModel, ProviderAdapter, ProviderExecution, ProviderRuntime, RouteRequest } from './types.js';

export class VllmAdapter implements ProviderAdapter {
  readonly kind = ProviderKind.VLLM;
  private readonly openAiAdapter = new OpenAiCompatibleAdapter(ProviderKind.VLLM);

  async execute(route: RouteRequest, provider: ProviderRuntime): Promise<ProviderExecution> {
    if (route.endpointKind !== 'vllm.native') {
      return this.openAiAdapter.execute(route, provider);
    }
    const body = route.method === 'GET'
      ? undefined
      : route.bodyBuffer
        ? Buffer.from(route.bodyBuffer)
        : undefined;

    const headers = new Headers();
    for (const [key, value] of Object.entries(route.headers)) {
      if (shouldForwardClientHeader(key)) {
        headers.set(key, value);
      }
    }

    for (const [key, value] of Object.entries(provider.defaultHeaders)) {
      headers.set(key, value);
    }

    if (provider.authSecret) {
      headers.set(provider.authHeaderName, provider.authMode === 'BEARER' ? `Bearer ${provider.authSecret}` : provider.authSecret);
    }

    const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}${route.path}${route.queryString}`, {
      method: route.method,
      headers,
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(provider.timeoutMs),
    });
    return { response };
  }

  async healthCheck(provider: ProviderRuntime): Promise<{ healthy: boolean; error?: string }> {
    return this.openAiAdapter.healthCheck(provider);
  }

  async discoverModels(provider: ProviderRuntime): Promise<DiscoveredModel[]> {
    return this.openAiAdapter.discoverModels(provider);
  }
}
