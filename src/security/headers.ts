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

export function shouldForwardClientHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return !isSensitiveHeaderName(lower)
    && !HOP_BY_HOP_HEADER_NAMES.has(lower)
    && !CLIENT_CONTROLLED_PROXY_HEADER_NAMES.has(lower)
    && lower !== 'host'
    && lower !== 'x-hive-routing-trait'
    && lower !== 'x-routing-trait';
}

export function shouldCopyResponseHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return !HOP_BY_HOP_HEADER_NAMES.has(lower) && lower !== 'set-cookie';
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
