/**
 * Authorization of the security event exporter (`GET /api/security/events`): an Oathweave
 * client_credentials token of the security-exporter client, verified with HiveCommon's
 * Oathweave verifier (RS256 against the JWKS, exact issuer, exactly one audience, bounded
 * lifetime, `jti`, the service-principal claim rules, `redirect: 'error'`, a request timeout
 * and cached keys with a rotation cooldown).
 *
 * Keys are refreshed every HIVE_ROUTER_IAM_JWKS_REFRESH_MS (the verifier's `jwksCacheMaxAgeMs`).
 * When a refresh fails, the verifier keeps the last good keys while they are at most
 * HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS - HIVE_ROUTER_IAM_JWKS_REFRESH_MS old (`jwksStaleIfErrorMs`)
 * and trusts them for one more refresh interval, so a key set is never trusted longer than
 * HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS after its fetch. Its refresh reports (`onJwksRefresh`,
 * `onJwksError`) feed the refresh and rotation metrics and the key-age status shown by health and
 * metrics.
 *
 * Emberpath adds on top, in the JWKS fetch the verifier uses:
 * - the transport: HIVE_ROUTER_IAM_CA_CERT_PATH, when set, is the only CA trusted for the JWKS
 *   (as for the Oathweave token requests); otherwise the system trust store is used;
 * - a bounded, strictly validated key set (RS256 RSA signing keys with safe key IDs, at most
 *   32), stricter than the verifier's own key-set check.
 *
 * Settings: OATHWEAVE_ISSUER (the https issuer), OATHWEAVE_NATIVE_ISSUERS (Oathweave's native
 * issuer, its JWT_ISSUER, which signs client_credentials tokens) and OATHWEAVE_JWKS_URL. The
 * legacy HIVE_ROUTER_IAM_ISSUER still works in place of the issuer settings (a native name such
 * as the default `hive-iam`, or an https URL), and the JWKS URL defaults to
 * HIVE_IAM_INTERNAL_URL's. HIVE_ROUTER_IAM_AUDIENCE and HIVE_ROUTER_SECURITY_EXPORTER_CLIENT_ID
 * keep their names.
 */
import {
  createOathweaveVerifier,
  isOathweaveError,
  OATHWEAVE_JWKS_MAX_STALE_MS,
  statusForReason,
  type OathweaveVerifier,
} from '@hivemagnus/hive-common/oathweave';
import { isBoundedFetchError, readJsonBounded } from '@hivemagnus/hive-common/fetch';
import type { JWTPayload } from 'jose';
import { loadEnv, type Env } from '../config/env.js';
import { log } from '../telemetry/logger.js';
import {
  reportSecurityExporterTrustedKeys,
  securityExporterJwksRefreshFailures,
  securityExporterRejectedRotations,
} from '../telemetry/metrics.js';
import { oathweaveFetch } from './oathweave-service-token.js';
import { recordSecurityExporterJwksRefresh } from './security-exporter-jwks-status.js';

export const SECURITY_EXPORTER_CLIENT_ID = 'security-exporter';
export const SECURITY_EXPORTER_PERMISSION = 'router:security-events:read';
export const SECURITY_EXPORTER_RETRY_AFTER_SECONDS = 5;
const MAX_JWKS_RESPONSE_BYTES = 256 * 1024;
const MAX_JWKS_KEYS = 32;
const MAX_KID_LENGTH = 128;
const MAX_RSA_PARAMETER_LENGTH = 2_048;
const JWKS_REFRESH_COOLDOWN_MS = 30_000;

/**
 * How long the last good keys may serve a failed refresh: the maximum age less one refresh
 * interval, because the verifier trusts what it gets for another interval. The env check refuses
 * settings where this exceeds HiveCommon's cap (`OATHWEAVE_JWKS_MAX_STALE_MS`, a day).
 */
function securityExporterJwksStaleMs(env: Pick<Env, 'HIVE_ROUTER_IAM_JWKS_REFRESH_MS' | 'HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS'>): number {
  return Math.max(0, env.HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS - env.HIVE_ROUTER_IAM_JWKS_REFRESH_MS);
}

export type SecurityExporterAuthResult =
  | { status: 'authorized'; payload: JWTPayload }
  | { status: 'invalid' }
  | { status: 'unavailable' };

export type SecurityExporterEnv = Pick<
  Env,
  | 'NODE_ENV'
  | 'HIVE_IAM_INTERNAL_URL'
  | 'HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS'
  | 'HIVE_ROUTER_IAM_CA_CERT_PATH'
  | 'HIVE_ROUTER_IAM_ISSUER'
  | 'HIVE_ROUTER_IAM_AUDIENCE'
  | 'HIVE_ROUTER_IAM_JWKS_REFRESH_MS'
  | 'HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS'
> & Partial<Pick<Env, 'HIVE_ROUTER_SECURITY_EXPORTER_CLIENT_ID'>>;

/** The raw environment, for the Oathweave settings and to tell a set legacy name from its default. */
export type SettingSource = Readonly<Record<string, string | undefined>>;

export interface SecurityExporterVerifierSettings {
  /** Accepted https issuers. */
  issuers: string[];
  /** Accepted native issuer identifiers (service tokens only). */
  nativeIssuers: string[];
  jwksUrl: string;
  audience: string;
  /** Legacy settings in use without their current name: `[legacy, current]`. */
  legacy: Array<[string, string]>;
}

function setting(source: SettingSource, name: string): string | undefined {
  const value = source[name]?.trim();
  return value ? value : undefined;
}

/** Where the exporter's issuers, keys and audience come from. */
export function securityExporterVerifierSettings(
  env: SecurityExporterEnv,
  source: SettingSource = process.env,
): SecurityExporterVerifierSettings {
  const legacy: Array<[string, string]> = [];
  const legacyIssuer = env.HIVE_ROUTER_IAM_ISSUER;
  const legacyIssuerSet = setting(source, 'HIVE_ROUTER_IAM_ISSUER') !== undefined;
  const issuer = setting(source, 'OATHWEAVE_ISSUER');
  const native = (setting(source, 'OATHWEAVE_NATIVE_ISSUERS') ?? '')
    .split(',').map(item => item.trim()).filter(Boolean);
  const issuers = issuer ? [issuer] : [];
  const nativeIssuers = [...native];
  if (/^[a-z][a-z0-9+.-]*:/iu.test(legacyIssuer)) {
    if (!issuer) {
      issuers.push(legacyIssuer);
      if (legacyIssuerSet) legacy.push(['HIVE_ROUTER_IAM_ISSUER', 'OATHWEAVE_ISSUER']);
    }
  } else if (!native.length) {
    nativeIssuers.push(legacyIssuer);
    if (legacyIssuerSet) legacy.push(['HIVE_ROUTER_IAM_ISSUER', 'OATHWEAVE_NATIVE_ISSUERS']);
  }
  return {
    issuers,
    nativeIssuers,
    jwksUrl: setting(source, 'OATHWEAVE_JWKS_URL')
      ?? `${env.HIVE_IAM_INTERNAL_URL.replace(/\/+$/u, '')}/api/v1/oauth/jwks`,
    audience: env.HIVE_ROUTER_IAM_AUDIENCE,
    legacy,
  };
}

let legacyWarned = false;

/** Log, once per process, each legacy exporter setting that is in use without its current name. */
export function warnLegacySecurityExporterSettings(
  env: SecurityExporterEnv,
  source: SettingSource = process.env,
  warn: (message: string, fields: Record<string, unknown>) => void = (message, fields) => log('warn', message, fields),
): void {
  if (legacyWarned) return;
  const { legacy } = securityExporterVerifierSettings(env, source);
  if (!legacy.length) return;
  legacyWarned = true;
  for (const [name, current] of legacy) {
    warn(`${name} is deprecated for the security exporter; set ${current} instead (the old name keeps working for now)`, { setting: name, replacement: current });
  }
}

export function resetLegacySecurityExporterWarningForTests(): void {
  legacyWarned = false;
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** A short, bounded reason for the refresh-failure metric. */
function failureReason(error: unknown): string {
  if (isBoundedFetchError(error, 'response_too_large')) return 'ERR_JWKS_RESPONSE_TOO_LARGE';
  if (isBoundedFetchError(error)) return 'ERR_JWKS_INVALID';
  if (!(error instanceof Error)) return 'unknown';
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'ERR_JWKS_TIMEOUT';
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const cause = error.cause instanceof Error && 'code' in error.cause && typeof error.cause.code === 'string'
    ? error.cause.code
    : undefined;
  const reason = code ?? cause ?? 'unknown';
  return /^[A-Za-z0-9_]{1,64}$/u.test(reason) ? reason : 'unknown';
}

/** Accept only RS256 RSA signing keys with safe key IDs; any other key refuses the whole set. */
export function validateJwks(payload: unknown): { jwks: { keys: Array<Record<string, unknown>> }; keyIds: string[] } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw codedError('JWKS payload must be an object', 'ERR_JWKS_INVALID');
  }
  const keys = (payload as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_JWKS_KEYS) {
    throw codedError('JWKS key count is invalid', 'ERR_JWKS_INVALID_KEY_COUNT');
  }
  const trusted: Array<Record<string, unknown>> = [];
  const keyIds = new Set<string>();
  for (const candidate of keys) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw codedError('JWKS contains a malformed key', 'ERR_JWKS_INVALID_KEY');
    }
    const jwk = candidate as Record<string, unknown>;
    const kid = jwk['kid'];
    if (
      typeof kid !== 'string'
      || kid.length === 0
      || kid.length > MAX_KID_LENGTH
      || !/^[A-Za-z0-9._:-]+$/u.test(kid)
      || keyIds.has(kid)
      || jwk['kty'] !== 'RSA'
      || jwk['alg'] !== 'RS256'
      || (jwk['use'] !== undefined && jwk['use'] !== 'sig')
      || typeof jwk['n'] !== 'string'
      || jwk['n'].length === 0
      || jwk['n'].length > MAX_RSA_PARAMETER_LENGTH
      || !/^[A-Za-z0-9_-]+$/u.test(jwk['n'])
      || typeof jwk['e'] !== 'string'
      || jwk['e'].length === 0
      || jwk['e'].length > 16
      || !/^[A-Za-z0-9_-]+$/u.test(jwk['e'])
    ) {
      throw codedError('JWKS contains an untrusted key descriptor', 'ERR_JWKS_INVALID_KEY');
    }
    keyIds.add(kid);
    trusted.push(jwk);
  }
  return { jwks: { keys: trusted }, keyIds: [...keyIds] };
}

/**
 * The fetch the verifier loads keys with: Emberpath's transport (the pinned CA), a 200 answer,
 * and a bounded, strictly validated key set. A failure throws with a coded error the metrics
 * read; the verifier decides whether the last good keys serve instead. `onKeyIds` gets the key
 * IDs of each accepted set, for the trusted-key metric.
 */
function securityExporterJwksFetch(base: typeof fetch, onKeyIds: (keyIds: string[]) => void): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw codedError('Expected 200 OK from JWKS endpoint', 'ERR_JWKS_HTTP_STATUS');
    }
    const signal = init?.signal ?? undefined;
    const { jwks, keyIds } = validateJwks(await readJsonBounded(response, MAX_JWKS_RESPONSE_BYTES, signal ? { signal } : {}));
    onKeyIds(keyIds);
    return new Response(JSON.stringify(jwks), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

export interface SecurityExporterAuthorizerOptions {
  env: SecurityExporterEnv;
  /** The raw environment for the Oathweave settings; defaults to `process.env`. */
  source?: SettingSource;
  /** The transport for JWKS requests; defaults to `oathweaveFetch(env)` (HIVE_ROUTER_IAM_CA_CERT_PATH). */
  fetch?: typeof fetch;
  reportTrustedKeys?: (refreshedAt: number, keyIds: string[]) => void;
  reportRefreshFailure?: (reason: string) => void;
  reportRejectedRotation?: (reason: string) => void;
  /** Called once when the settings cannot make a verifier (the exporter then answers 503). */
  onConfigurationProblem?: (message: string) => void;
}

export function createSecurityExporterAuthorizer(
  options: SecurityExporterAuthorizerOptions,
): (token: string) => Promise<SecurityExporterAuthResult> {
  const { env } = options;
  const settings = securityExporterVerifierSettings(env, options.source);
  const clientId = env.HIVE_ROUTER_SECURITY_EXPORTER_CLIENT_ID ?? SECURITY_EXPORTER_CLIENT_ID;
  const reportTrustedKeys = options.reportTrustedKeys ?? reportSecurityExporterTrustedKeys;
  const reportRefreshFailure = options.reportRefreshFailure
    ?? ((reason: string) => securityExporterJwksRefreshFailures.inc({ reason }));
  const reportRejectedRotation = options.reportRejectedRotation
    ?? ((reason: string) => securityExporterRejectedRotations.inc({ reason }));
  // The key IDs of the set the fetch just accepted, read by the refresh report that follows it.
  let acceptedKeyIds: string[] = [];
  let verifier: OathweaveVerifier | undefined;
  let problem: string | undefined;
  try {
    const staleMs = securityExporterJwksStaleMs(env);
    if (staleMs > OATHWEAVE_JWKS_MAX_STALE_MS) {
      throw new Error('HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS less HIVE_ROUTER_IAM_JWKS_REFRESH_MS must be at most one day');
    }
    verifier = createOathweaveVerifier({
      // Without an https issuer (a standalone Emberpath that only knows the native issuer) the
      // verifier is service-only for native-issuer tokens.
      ...(settings.issuers.length ? { issuer: settings.issuers } : {}),
      nativeIssuers: settings.nativeIssuers,
      nativeIssuerAccept: 'service',
      audience: settings.audience,
      jwksUrl: settings.jwksUrl,
      accept: 'service',
      // The exporter has never tolerated clock skew, and needs Oathweave's own `clientId` claim.
      clockToleranceSec: 0,
      clientIdClaim: 'clientId',
      jwksCacheMaxAgeMs: env.HIVE_ROUTER_IAM_JWKS_REFRESH_MS,
      jwksCooldownMs: JWKS_REFRESH_COOLDOWN_MS,
      jwksStaleIfErrorMs: staleMs,
      onJwksRefresh: ({ keys, fetchedAt }) => {
        const keyIds = acceptedKeyIds.length === keys ? acceptedKeyIds : [];
        recordSecurityExporterJwksRefresh(fetchedAt, keys);
        reportTrustedKeys(fetchedAt, keyIds);
      },
      onJwksError: ({ error }) => {
        const reason = failureReason(error);
        reportRefreshFailure(reason);
        if (reason.startsWith('ERR_JWKS_INVALID')) reportRejectedRotation(reason);
      },
      fetch: securityExporterJwksFetch(options.fetch ?? oathweaveFetch(env), (keyIds) => { acceptedKeyIds = keyIds; }),
    });
  } catch (error) {
    // HiveCommon's configuration errors name the setting's role, never its value.
    problem = error instanceof Error ? error.message : 'invalid configuration';
  }
  let problemReported = false;

  return async (token: string): Promise<SecurityExporterAuthResult> => {
    if (!verifier) {
      if (!problemReported) {
        problemReported = true;
        (options.onConfigurationProblem ?? ((message) => log('warn', 'Security exporter authorization is unavailable', { problem: message })))(problem ?? 'invalid configuration');
      }
      return { status: 'unavailable' };
    }
    try {
      const principal = await verifier.verifyService(token);
      const authorized = principal.subject === clientId
        && principal.clientId === clientId
        && principal.permissions.includes(SECURITY_EXPORTER_PERMISSION);
      return authorized ? { status: 'authorized', payload: principal.claims } : { status: 'invalid' };
    } catch (error) {
      return isOathweaveError(error) && statusForReason(error.reason) === 503
        ? { status: 'unavailable' }
        : { status: 'invalid' };
    }
  };
}

let defaultAuthorizer: { env: Env; authorize: (token: string) => Promise<SecurityExporterAuthResult> } | undefined;

/** The exporter check for the loaded configuration, made on first use. */
export function authorizeSecurityExporterToken(token: string): Promise<SecurityExporterAuthResult> {
  const env = loadEnv();
  if (defaultAuthorizer?.env !== env) {
    defaultAuthorizer = { env, authorize: createSecurityExporterAuthorizer({ env }) };
  }
  return defaultAuthorizer.authorize(token);
}
