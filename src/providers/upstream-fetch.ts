/**
 * Every request that carries a provider credential goes through here. Redirects are not
 * followed: the HTTP client drops `Authorization` on a cross-origin redirect but forwards any
 * other header (`x-api-key`, a custom auth header, default headers) and, for 307/308, the
 * request body. No supported provider API redirects, so a redirect is a provider failure with
 * a reason the operator can act on, never a second request.
 */
export class ProviderRedirectError extends Error {
  override name = 'ProviderRedirectError';
  constructor(readonly status: number, readonly target: string | undefined) {
    super(`Provider answered with a redirect (HTTP ${status}${target ? ` to ${target}` : ''}). Redirects are not followed, so stored credentials only reach the configured server; set the provider's base URL to the final address.`);
  }
}

/** Scheme, host and port of a redirect target; its path and query may hold tokens and are dropped. */
function redirectTarget(location: string | null, requestUrl: string): string | undefined {
  if (!location) return undefined;
  try {
    const url = new URL(location, requestUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export async function providerFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: 'manual' });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    void response.body?.cancel().catch(() => undefined);
    throw new ProviderRedirectError(response.status, redirectTarget(response.headers.get('location'), url));
  }
  return response;
}
