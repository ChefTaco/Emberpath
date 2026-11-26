/**
 * Emberpath's credential for HiveMem.
 *
 * Preferred: an Oathweave machine client (see oathweave-service-token.ts). Emberpath fetches a
 * short-lived client_credentials token (audience `hivemem`) when it first needs one and fetches
 * the next before the current one expires, so the credential renews itself for as long as the
 * process runs. Nothing outside Emberpath has to renew, copy or restart anything.
 *
 * Fallback: the static HIVE_ROUTER_MEMORY_PROXY_TOKEN, used only while the service credential
 * is not configured or cannot be obtained, and never after its own expiry.
 */
import { SERVICE_TOKEN_EXPIRY_MARGIN_MS } from '@hivemagnus/hive-common/oathweave';
import { unverifiedJwtExpiry, type OathweaveServiceToken } from './oathweave-service-token.js';

export { unverifiedJwtExpiry } from './oathweave-service-token.js';

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
  /** The Oathweave machine client, when EMBERPATH_HIVEMEM_CLIENT_ID and _SECRET are set. */
  service?: OathweaveServiceToken | undefined;
  staticToken?: string | undefined;
  now?: () => number;
}

export function createHiveMemCredential(options: HiveMemCredentialOptions) {
  const now = options.now ?? (() => Date.now());
  const { service } = options;
  const staticExpiry = options.staticToken ? unverifiedJwtExpiry(options.staticToken) : null;

  function staticToken(): string | null {
    if (!options.staticToken) return null;
    if (staticExpiry !== null && staticExpiry - SERVICE_TOKEN_EXPIRY_MARGIN_MS <= now()) return null;
    return options.staticToken;
  }

  return {
    /** Whether any HiveMem credential is configured, even if currently unavailable. */
    configured(): boolean {
      return Boolean(service) || Boolean(options.staticToken);
    },
    async authorization(): Promise<HiveMemAuthorization | null> {
      if (service) {
        const token = await service.token();
        if (token) return { token, source: 'oathweave' };
      }
      const fallback = staticToken();
      return fallback ? { token: fallback, source: 'static' } : null;
    },
    /** HiveMem refused this service token (401): fetch a new one on the next call. */
    reject(token: string): void {
      service?.reject(token);
    },
    status(): HiveMemCredentialStatus {
      const at = now();
      const serviceStatus = service?.status();
      return {
        mode: service ? 'oathweave' : options.staticToken ? 'static' : 'none',
        serviceTokenValid: serviceStatus?.tokenValid ?? false,
        serviceTokenExpiresAt: serviceStatus?.tokenExpiresAt ?? null,
        lastRefreshAt: serviceStatus?.lastRefreshAt ?? null,
        lastFailureAt: serviceStatus?.lastFailureAt ?? null,
        staticTokenExpiresAt: staticExpiry === null ? null : new Date(staticExpiry).toISOString(),
        staticTokenExpired: options.staticToken ? staticExpiry !== null && staticExpiry <= at : null,
      };
    },
  };
}

export type HiveMemCredential = ReturnType<typeof createHiveMemCredential>;
