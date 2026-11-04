import type { RouteRequest } from '../providers/types.js';

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function withResolvedRouteModel(route: RouteRequest, targetModel: string | undefined): RouteRequest {
  if (targetModel === '') {
    if (!isJsonObject(route.requestBodyJson)) {
      return {
        ...route,
        model: undefined,
      };
    }

    const requestBodyJson = {
      ...route.requestBodyJson,
    };
    delete requestBodyJson.model;
    const requestBodyText = JSON.stringify(requestBodyJson);

    return {
      ...route,
      model: undefined,
      requestBodyJson,
      requestBodyText,
      bodyBuffer: new TextEncoder().encode(requestBodyText),
    };
  }

  const model = targetModel ?? route.model;
  if (!model) {
    return route;
  }

  if (!isJsonObject(route.requestBodyJson)) {
    return {
      ...route,
      model,
    };
  }

  const requestBodyJson = {
    ...route.requestBodyJson,
    model,
  };
  const requestBodyText = JSON.stringify(requestBodyJson);

  return {
    ...route,
    model,
    requestBodyJson,
    requestBodyText,
    bodyBuffer: new TextEncoder().encode(requestBodyText),
  };
}
