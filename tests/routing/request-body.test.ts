import { describe, expect, it } from 'vitest';
import type { RouteRequest } from '../../src/providers/types.js';
import { withResolvedRouteModel } from '../../src/routing/request-body.js';

function buildRoute(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    requestId: 'req_model_rewrite_1',
    method: 'POST',
    path: '/v1/chat/completions',
    queryString: '',
    endpointKind: 'v1.chat.completions',
    routeKey: 'POST /v1/chat/completions',
    model: 'standard',
    stream: false,
    toolsRequested: false,
    jsonSchemaRequested: false,
    modalities: [],
    headers: { 'content-type': 'application/json' },
    requestBodyText: JSON.stringify({ model: 'standard', messages: [{ role: 'user', content: 'hello' }] }),
    requestBodyJson: { model: 'standard', messages: [{ role: 'user', content: 'hello' }] },
    bodyBuffer: new TextEncoder().encode(JSON.stringify({ model: 'standard', messages: [{ role: 'user', content: 'hello' }] })),
    ...overrides,
  };
}

describe('routing/request-body', () => {
  it('rewrites JSON request bodies to the resolved upstream model', () => {
    const route = withResolvedRouteModel(buildRoute(), 'deepseek/deepseek-v4-pro');

    expect(route.model).toBe('deepseek/deepseek-v4-pro');
    expect(route.requestBodyJson).toMatchObject({ model: 'deepseek/deepseek-v4-pro' });
    expect(JSON.parse(route.requestBodyText ?? '{}')).toMatchObject({ model: 'deepseek/deepseek-v4-pro' });
    expect(new TextDecoder().decode(route.bodyBuffer)).toContain('deepseek/deepseek-v4-pro');
  });

  it('preserves non-JSON bodies while still updating route metadata', () => {
    const route = buildRoute({
      requestBodyJson: undefined,
      requestBodyText: 'model=standard',
      bodyBuffer: new TextEncoder().encode('model=standard'),
    });

    const resolved = withResolvedRouteModel(route, 'gpt-4.1-mini');

    expect(resolved.model).toBe('gpt-4.1-mini');
    expect(resolved.requestBodyText).toBe('model=standard');
    expect(new TextDecoder().decode(resolved.bodyBuffer)).toBe('model=standard');
  });

  it('omits the upstream model when an alias intentionally resolves to provider-native default', () => {
    const route = withResolvedRouteModel(buildRoute(), '');

    expect(route.model).toBeUndefined();
    expect(route.requestBodyJson).toMatchObject({ messages: [{ role: 'user', content: 'hello' }] });
    expect(JSON.parse(route.requestBodyText ?? '{}')).not.toHaveProperty('model');
  });
});
