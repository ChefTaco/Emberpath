const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-hive-router-token',
]);

const HOP_BY_HOP_HEADER_NAMES = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const CLIENT_CONTROLLED_PROXY_HEADER_NAMES = new Set([
  'cf-connecting-ip',
  'client-ip',
  'forwarded',
  'true-client-ip',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
]);

/**
 * Suite-internal headers that stay inside the gateway. Upstreams can be third-party model APIs,
 * and `x-hive-execution` carries internal node, profile and task references; `x-hive-retry`
 * is a response signal between suite layers. The inbound copy is still recorded (redacted)
 * on the trace.
 */
const SUITE_INTERNAL_HEADER_NAMES = new Set([
  'x-hive-execution',
  'x-hive-retry',
]);

export function shouldForwardClientHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return !isSensitiveHeaderName(lower)
    && !HOP_BY_HOP_HEADER_NAMES.has(lower)
    && !CLIENT_CONTROLLED_PROXY_HEADER_NAMES.has(lower)
    && !SUITE_INTERNAL_HEADER_NAMES.has(lower)
    && lower !== 'host'
    && lower !== 'x-hive-routing-trait'
    && lower !== 'x-routing-trait';
}

export function shouldCopyResponseHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return !HOP_BY_HOP_HEADER_NAMES.has(lower) && lower !== 'set-cookie';
}

/** Upstream response headers a client sees as they are. */
const UPSTREAM_RESPONSE_HEADER_ALLOWLIST = new Set([
  'cache-control',
  'content-disposition',
  'content-language',
  'content-type',
  'retry-after',
  'retry-after-ms',
]);

/** Prefix for upstream headers that are relayed under a name of their own. */
export const UPSTREAM_HEADER_PREFIX = 'x-emberpath-upstream-';

export interface UpstreamHeaderPolicy {
  /** `allowlist` relays only known-safe headers; `passthrough` relays all but hop-by-hop and cookies. */
  mode: 'allowlist' | 'passthrough';
  /** Extra header names (lowercase) relayed as they are in `allowlist` mode. */
  extra?: ReadonlySet<string>;
}

/**
 * The name a client sees for an upstream response header, or undefined to drop it. Hop-by-hop
 * headers and cookies are always dropped. In `allowlist` mode the upstream's request ID and
 * rate-limit headers (which describe the provider account, not the caller) are renamed under
 * `x-emberpath-upstream-`, and everything else that is not allowed (`server`, `cf-ray`,
 * `openai-organization`, ...) stays behind.
 */
export function clientResponseHeaderName(name: string, policy: UpstreamHeaderPolicy): string | undefined {
  const lower = name.toLowerCase();
  if (!shouldCopyResponseHeader(lower)) return undefined;
  if (policy.mode === 'passthrough') return lower;
  if (UPSTREAM_RESPONSE_HEADER_ALLOWLIST.has(lower) || policy.extra?.has(lower)) return lower;
  if (lower === 'x-request-id' || lower === 'request-id') return `${UPSTREAM_HEADER_PREFIX}request-id`;
  if (lower.startsWith('x-ratelimit-')) return `${UPSTREAM_HEADER_PREFIX}ratelimit-${lower.slice('x-ratelimit-'.length)}`;
  return undefined;
}

/** Parse a comma-separated list of header names into a lowercase set. */
export function parseHeaderNameList(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter((entry) => /^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(entry)));
}

function isSensitiveHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_HEADER_NAMES.has(lower)
    || lower.includes('secret')
    || lower.includes('token')
    || lower.includes('credential')
    || lower.includes('password')
    || /(?:^|[-_])api[-_]?key(?:$|[-_])/.test(lower);
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      isSensitiveHeaderName(key) ? '[redacted]' : value,
    ]),
  );
}

export function applyAdminSecurityHeaders(headers: Headers, production: boolean): void {
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'SAMEORIGIN');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  headers.set(
    'content-security-policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; '),
  );

  if (production) {
    headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
}
