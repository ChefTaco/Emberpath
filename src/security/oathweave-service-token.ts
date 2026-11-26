/**
 * Emberpath's Oathweave machine-client tokens (client_credentials), on HiveCommon's
 * service-token provider, which fetches on first use, caches, refreshes before expiry, shares
 * one request between concurrent callers and backs off after a failure.
 *
 * What Emberpath adds on top:
 * - where a client secret may go: HTTPS, or plain HTTP only to a loopback address;
 * - the transport: HIVE_ROUTER_IAM_CA_CERT_PATH, when set, is the only CA trusted for the token
 *   endpoint; otherwise the system trust store (including NODE_EXTRA_CA_CERTS) is used;
 * - a refused token (the resource answered 401) is replaced, except right after issue, which
 *   points at configuration: then it backs off instead of fetching a token per request;
 * - a status view and refresh events for logs, which never hold tokens, secrets or bodies.
 */
import {
  createServiceTokenProvider,
  endpointProblem,
  isServiceTokenError,
  SERVICE_TOKEN_EXPIRY_MARGIN_MS,
  SERVICE_TOKEN_FAILURE_BACKOFF_MS,
  type ServiceTokenProvider,
} from '@hivemagnus/hive-common/oathweave';
import { createCaFetch } from '@hivemagnus/hive-common/registry';
import { iamTrustedCa, type IamTlsEnv } from './iam-tls.js';

/** Why Emberpath must not send an Oathweave client secret to `url`, or undefined when it may. */
export function oathweaveTokenUrlProblem(url: string): string | undefined {
  const problem = endpointProblem(url, { allowInsecureLoopback: true });
  if (!problem) return undefined;
  return problem.includes('https')
    ? 'must use HTTPS (plain HTTP is allowed only for a loopback address such as 127.0.0.1)'
    : problem;
}

/** The Oathweave token endpoint under an Oathweave base URL. */
export function oathweaveTokenUrl(baseUrl: string): string {
  return new URL('api/v1/oauth/token', `${baseUrl.replace(/\/+$/u, '')}/`).href;
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
}

/**
 * A fetch for Oathweave token requests that trusts only HIVE_ROUTER_IAM_CA_CERT_PATH when it is
 * set. The CA is read on the first HTTPS request, so a configuration problem surfaces as a
 * failed token request rather than at construction.
 */
export function oathweaveFetch(env: IamTlsEnv): typeof fetch {
  let pinned: { ca: Buffer; fetch: typeof fetch } | undefined;
  return (input, init) => {
    if (requestUrl(input).protocol !== 'https:') return fetch(input, init);
    const ca = iamTrustedCa(env);
    if (!ca) return fetch(input, init);
    if (pinned?.ca !== ca) pinned = { ca, fetch: createCaFetch({ ca: ca.toString('utf8') }) };
    return pinned.fetch(input, init);
  };
}

/** `reason` is HiveCommon's `ServiceTokenFailure` (such as `http` or `network`), or `error`. */
export type OathweaveTokenEvent =
  | { type: 'refreshed'; expiresAt: number | null }
  | { type: 'refresh-failed'; reason: string };

export interface OathweaveServiceTokenOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string | undefined;
  /** CA settings for the token endpoint. */
  env: IamTlsEnv;
  /** For tests; defaults to `oathweaveFetch(env)`. */
  fetch?: typeof fetch;
  now?: () => number;
  /** Delay before another fetch after a failure, or after a fresh token is refused. 5000 ms. */
  failureBackoffMs?: number;
  onEvent?: (event: OathweaveTokenEvent) => void;
}

export interface OathweaveServiceTokenStatus {
  /** Whether a token is held and not yet within its expiry margin. */
  tokenValid: boolean;
  tokenExpiresAt: string | null;
  lastRefreshAt: string | null;
  lastFailureAt: string | null;
}

export interface OathweaveServiceToken {
  /** A usable token, or null when none can be had right now (the reason goes to `onEvent`). */
  token(): Promise<string | null>;
  /** The resource refused this token (401): replace it on the next call. */
  reject(token: string): void;
  status(): OathweaveServiceTokenStatus;
}

/** Reads `exp` from a JWT without trusting it. Only used to stop sending a token that has expired. */
export function unverifiedJwtExpiry(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (claims && typeof claims === 'object' && 'exp' in claims && typeof claims.exp === 'number' && Number.isFinite(claims.exp)) {
      return claims.exp * 1000;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * One Oathweave machine client. Throws (a configuration error) when `tokenUrl` is not HTTPS
 * and not a loopback address; `inspectEnv` reports the same at startup.
 */
export function createOathweaveServiceToken(options: OathweaveServiceTokenOptions): OathweaveServiceToken {
  const problem = oathweaveTokenUrlProblem(options.tokenUrl);
  if (problem) throw new TypeError(`The Oathweave token URL ${problem}`);
  const now = options.now ?? (() => Date.now());
  const backoffMs = options.failureBackoffMs ?? SERVICE_TOKEN_FAILURE_BACKOFF_MS;
  const provider: ServiceTokenProvider = createServiceTokenProvider({
    tokenUrl: options.tokenUrl,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    ...(options.scope ? { scope: options.scope } : {}),
    fetch: options.fetch ?? oathweaveFetch(options.env),
    now,
    failureBackoffMs: backoffMs,
    allowInsecureLoopback: true,
  });
  let current: { token: string; obtainedAt: number; expiresAt: number | null } | null = null;
  let refusedUntil = 0;
  let lastRefreshAt: number | null = null;
  let lastFailureAt: number | null = null;

  return {
    async token() {
      if (now() < refusedUntil) return null;
      try {
        const token = await provider.token();
        if (token !== current?.token) {
          current = { token, obtainedAt: now(), expiresAt: unverifiedJwtExpiry(token) };
          lastRefreshAt = current.obtainedAt;
          options.onEvent?.({ type: 'refreshed', expiresAt: current.expiresAt });
        }
        return token;
      } catch (error) {
        // ServiceTokenError messages and reasons never hold the secret, a token or a body.
        const reason = isServiceTokenError(error) ? error.reason : 'error';
        if (reason !== 'backoff') {
          lastFailureAt = now();
          options.onEvent?.({ type: 'refresh-failed', reason });
        }
        return null;
      }
    },
    reject(token) {
      if (current?.token !== token) return;
      if (now() - current.obtainedAt < backoffMs) refusedUntil = now() + backoffMs;
      current = null;
      provider.invalidate();
    },
    status() {
      const at = now();
      const expiresAt = current?.expiresAt ?? null;
      return {
        tokenValid: current !== null && (expiresAt === null || expiresAt - SERVICE_TOKEN_EXPIRY_MARGIN_MS > at),
        tokenExpiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
        lastRefreshAt: lastRefreshAt === null ? null : new Date(lastRefreshAt).toISOString(),
        lastFailureAt: lastFailureAt === null ? null : new Date(lastFailureAt).toISOString(),
      };
    },
  };
}
