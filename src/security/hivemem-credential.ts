/**
 * Emberpath's credential for HiveMem.
 *
 * Preferred: an Oathweave machine client. Emberpath fetches a short-lived
 * client_credentials token (audience `hivemem`) when it first needs one and
 * fetches the next before the current one expires, so the credential renews
 * itself for as long as the process runs. Nothing outside Emberpath has to
 * renew, copy or restart anything.
 *
 * Fallback: the static HIVE_ROUTER_MEMORY_PROXY_TOKEN, used only while the
 * service credential is not configured or cannot be obtained, and never after
 * its own expiry.
 */

export interface ServiceToken {
  accessToken: string;
  /** Lifetime in seconds, as reported by the token endpoint. */
  expiresIn: number;
}

export type HiveMemCredentialSource = 'oathweave' | 'static';

export interface HiveMemAuthorization {
  token: string;
  source: HiveMemCredentialSource;
}

export interface HiveMemCredentialStatus {
  mode: 'oathweave' | 'static' | 'none';
  /** Whether a service token is cached and still usable. */
  serviceTokenValid: boolean;
  serviceTokenExpiresAt: string | null;
  lastRefreshAt: string | null;
  lastFailureAt: string | null;
  staticTokenExpiresAt: string | null;
  staticTokenExpired: boolean | null;
}

export interface HiveMemCredentialOptions {
  /** True when an Oathweave client ID and secret are configured. */
  serviceConfigured: boolean;
  /** Fetches a service token. Resolve null or throw when none is issued. */
  fetchServiceToken: () => Promise<ServiceToken | null>;
  staticToken?: string | undefined;
  now?: () => number;
  /** Delay before retrying after a failed fetch, so outages do not flood Oathweave. */
  failureBackoffMs?: number;
  onEvent?: (event: { type: 'refreshed'; expiresAt: number } | { type: 'refresh-failed'; reason: string }) => void;
}

const MIN_LIFETIME_MS = 10_000;
const MAX_LIFETIME_MS = 24 * 3600_000;
const EXPIRY_MARGIN_MS = 5_000;

/** Reads `exp` from a JWT without trusting it. Only used to stop sending a token HiveMem would reject. */
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

/** Refresh when 80% of the lifetime has passed, and at least 30 seconds before expiry. */
export function refreshPoint(issuedAt: number, lifetimeMs: number): number {
  return issuedAt + Math.max(0, Math.min(lifetimeMs * 0.8, lifetimeMs - 30_000));
}

export function createHiveMemCredential(options: HiveMemCredentialOptions) {
  const now = options.now ?? Date.now;
  const backoff = options.failureBackoffMs ?? 5_000;
  const staticExpiry = options.staticToken ? unverifiedJwtExpiry(options.staticToken) : null;
  let cached: { token: string; fetchedAt: number; refreshAt: number; expiresAt: number } | null = null;
  let inFlight: Promise<string | null> | null = null;
  let retryAfter = 0;
  let lastRefreshAt: number | null = null;
  let lastFailureAt: number | null = null;

  const usable = (entry: typeof cached, at: number): entry is NonNullable<typeof cached> =>
    entry !== null && entry.expiresAt - EXPIRY_MARGIN_MS > at;

  const fail = (reason: string): null => {
    lastFailureAt = now();
    retryAfter = lastFailureAt + backoff;
    options.onEvent?.({ type: 'refresh-failed', reason });
    return null;
  };

  const refresh = (): Promise<string | null> => {
    inFlight ??= (async () => {
      const startedAt = now();
      try {
        const token = await options.fetchServiceToken();
        if (!token || !token.accessToken) return fail('no token issued');
        const lifetimeMs = Math.min(MAX_LIFETIME_MS, Math.max(MIN_LIFETIME_MS, Math.floor(token.expiresIn * 1000)));
        // The token's own exp, when readable, wins over a longer reported lifetime.
        const claimed = unverifiedJwtExpiry(token.accessToken);
        const expiresAt = Math.min(startedAt + lifetimeMs, claimed ?? Number.POSITIVE_INFINITY);
        if (expiresAt - EXPIRY_MARGIN_MS <= now()) return fail('issued token is already expired');
        cached = { token: token.accessToken, fetchedAt: now(), refreshAt: refreshPoint(startedAt, expiresAt - startedAt), expiresAt };
        lastRefreshAt = now();
        retryAfter = 0;
        options.onEvent?.({ type: 'refreshed', expiresAt });
        return cached.token;
      } catch (error) {
        // Never include response bodies or secrets in the reason.
        return fail(error instanceof Error ? error.name : 'request failed');
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  async function serviceToken(): Promise<string | null> {
    const at = now();
    if (usable(cached, at) && cached.refreshAt > at) return cached.token;
    if (inFlight) {
      // Callers keep using a still-valid token while one refresh runs.
      if (usable(cached, at)) return cached.token;
      return inFlight;
    }
    if (at < retryAfter) return usable(cached, at) ? cached.token : null;
    if (usable(cached, at)) {
      void refresh();
      return cached.token;
    }
    return refresh();
  }

  function staticToken(): string | null {
    if (!options.staticToken) return null;
    if (staticExpiry !== null && staticExpiry - EXPIRY_MARGIN_MS <= now()) return null;
    return options.staticToken;
  }

  return {
    /** Whether any HiveMem credential is configured, even if currently unavailable. */
    configured(): boolean {
      return options.serviceConfigured || Boolean(options.staticToken);
    },
    async authorization(): Promise<HiveMemAuthorization | null> {
      if (options.serviceConfigured) {
        const token = await serviceToken();
        if (token) return { token, source: 'oathweave' };
      }
      const fallback = staticToken();
      return fallback ? { token: fallback, source: 'static' } : null;
    },
    /** HiveMem refused this token (401): fetch a new one on the next call. */
    reject(token: string): void {
      if (cached?.token !== token) return;
      // A token refused right after issue points at configuration, not expiry:
      // back off instead of fetching a new one for every request.
      if (now() - cached.fetchedAt < backoff) retryAfter = now() + backoff;
      cached = null;
    },
    status(): HiveMemCredentialStatus {
      const at = now();
      return {
        mode: options.serviceConfigured ? 'oathweave' : options.staticToken ? 'static' : 'none',
        serviceTokenValid: usable(cached, at),
        serviceTokenExpiresAt: cached ? new Date(cached.expiresAt).toISOString() : null,
        lastRefreshAt: lastRefreshAt === null ? null : new Date(lastRefreshAt).toISOString(),
        lastFailureAt: lastFailureAt === null ? null : new Date(lastFailureAt).toISOString(),
        staticTokenExpiresAt: staticExpiry === null ? null : new Date(staticExpiry).toISOString(),
        staticTokenExpired: options.staticToken ? staticExpiry !== null && staticExpiry <= at : null,
      };
    },
  };
}

export type HiveMemCredential = ReturnType<typeof createHiveMemCredential>;
