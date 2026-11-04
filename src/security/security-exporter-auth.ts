import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';
import { loadEnv, type Env } from '../config/env.js';
import {
  reportSecurityExporterTrustedKeys,
  securityExporterJwksRefreshFailures,
  securityExporterRejectedRotations,
} from '../telemetry/metrics.js';
import { iamTlsOptions } from './iam-tls.js';
import { recordSecurityExporterJwksRefresh } from './security-exporter-jwks-status.js';

export const SECURITY_EXPORTER_CLIENT_ID = 'security-exporter';
export const SECURITY_EXPORTER_PERMISSION = 'router:security-events:read';
export const SECURITY_EXPORTER_TOKEN_TYPE = 'access';
export const SECURITY_EXPORTER_ALGORITHMS = ['RS256'] as const;
export const SECURITY_EXPORTER_RETRY_AFTER_SECONDS = 5;
const MAX_JWKS_RESPONSE_BYTES = 256 * 1024;
const MAX_JWKS_KEYS = 32;
const MAX_KID_LENGTH = 128;
const MAX_RSA_PARAMETER_LENGTH = 2_048;
const JWKS_REFRESH_COOLDOWN_MS = 30_000;

export type SecurityExporterAuthResult =
  | { status: 'authorized'; payload: JWTPayload }
  | { status: 'invalid' }
  | { status: 'unavailable' };

type SecurityExporterEnv = Pick<
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

interface TrustedJwks {
  key: JWTVerifyGetKey;
  keyIds: Set<string>;
  fetchedAt: number;
}

interface SecurityExporterAuthorizerOptions {
  env: SecurityExporterEnv;
  loadJwks?: () => Promise<unknown>;
  now?: () => number;
  reportTrustedKeys?: (refreshedAt: number, keyIds: string[]) => void;
  reportRefreshFailure?: (reason: string) => void;
  reportRejectedRotation?: (reason: string) => void;
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'unknown';
}

function validateJwks(payload: unknown): { jwks: JSONWebKeySet; keyIds: string[] } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw codedError('JWKS payload must be an object', 'ERR_JWKS_INVALID');
  }
  const keys = (payload as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_JWKS_KEYS) {
    throw codedError('JWKS key count is invalid', 'ERR_JWKS_INVALID_KEY_COUNT');
  }

  const trustedKeys: JSONWebKeySet['keys'] = [];
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
    trustedKeys.push(candidate as JSONWebKeySet['keys'][number]);
  }
  return { jwks: { keys: trustedKeys }, keyIds: [...keyIds] };
}

function fetchBoundedJwks(url: URL, env: SecurityExporterEnv): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const handleResponse = (response: import('node:http').IncomingMessage) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(codedError('Expected 200 OK from JWKS endpoint', 'ERR_JWKS_HTTP_STATUS'));
        return;
      }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      response.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_JWKS_RESPONSE_BYTES) {
          request.destroy(codedError(
            'JWKS response exceeded the size limit',
            'ERR_JWKS_RESPONSE_TOO_LARGE',
          ));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        } catch {
          reject(codedError('JWKS response was not valid JSON', 'ERR_JWKS_INVALID'));
        }
      });
    };
    const request = url.protocol === 'https:'
      ? httpsRequest(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          ...iamTlsOptions(url, env),
        }, handleResponse)
      : httpRequest(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
    }, handleResponse);
    request.setTimeout(3_000, () => request.destroy(
      codedError('JWKS request timed out', 'ERR_JWKS_TIMEOUT'),
    ));
    request.on('error', reject);
    request.end();
  });
}

function isJwksInfrastructureFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = errorCode(error);
  return (code.startsWith('ERR_JWKS_') && code !== 'ERR_JWKS_NO_MATCHING_KEY')
    || new Set([
      'ABORT_ERR',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ECONNRESET',
      'ENETUNREACH',
      'ENOTFOUND',
      'ETIMEDOUT',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    ]).has(code)
    || error.name === 'AbortError';
}

function isJwtShaped(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token);
}

export function createSecurityExporterAuthorizer(
  options: SecurityExporterAuthorizerOptions,
): (token: string) => Promise<SecurityExporterAuthResult> {
  const now = options.now ?? Date.now;
  const jwksUrl = new URL(
    `${options.env.HIVE_IAM_INTERNAL_URL.replace(/\/$/u, '')}/api/v1/oauth/jwks`,
  );
  const loadJwks = options.loadJwks ?? (() => fetchBoundedJwks(jwksUrl, options.env));
  const reportTrustedKeys = options.reportTrustedKeys ?? reportSecurityExporterTrustedKeys;
  const reportRefreshFailure = options.reportRefreshFailure
    ?? ((reason) => securityExporterJwksRefreshFailures.inc({ reason }));
  const reportRejectedRotation = options.reportRejectedRotation
    ?? ((reason) => securityExporterRejectedRotations.inc({ reason }));
  let trusted: TrustedJwks | null = null;
  let refreshInFlight: Promise<TrustedJwks> | null = null;
  let lastRefreshAttemptAt = Number.NEGATIVE_INFINITY;

  const refresh = async (force = false): Promise<TrustedJwks> => {
    if (refreshInFlight) return refreshInFlight;
    if (
      !force
      && trusted
      && now() - lastRefreshAttemptAt < JWKS_REFRESH_COOLDOWN_MS
    ) return trusted;
    lastRefreshAttemptAt = now();
    refreshInFlight = (async () => {
      try {
        const { jwks, keyIds } = validateJwks(await loadJwks());
        const refreshed = {
          key: createLocalJWKSet(jwks),
          keyIds: new Set(keyIds),
          fetchedAt: now(),
        };
        trusted = refreshed;
        recordSecurityExporterJwksRefresh(refreshed.fetchedAt, keyIds.length);
        reportTrustedKeys(refreshed.fetchedAt, keyIds);
        return refreshed;
      } catch (error) {
        const reason = errorCode(error);
        reportRefreshFailure(reason);
        if (reason.startsWith('ERR_JWKS_INVALID')) reportRejectedRotation(reason);
        throw error;
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  };

  const resolveKey: JWTVerifyGetKey = async (protectedHeader, token) => {
    const kid = protectedHeader.kid;
    if (
      protectedHeader.alg !== 'RS256'
      || (
        kid !== undefined
        && (
          typeof kid !== 'string'
          || kid.length === 0
          || kid.length > MAX_KID_LENGTH
        )
      )
    ) {
      throw codedError('JWT key descriptor is invalid', 'ERR_JWKS_NO_MATCHING_KEY');
    }

    let current = trusted;
    const age = current ? now() - current.fetchedAt : Number.POSITIVE_INFINITY;
    if (!current || age >= options.env.HIVE_ROUTER_IAM_JWKS_REFRESH_MS) {
      try {
        current = await refresh(age >= options.env.HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS);
      } catch (error) {
        if (
          !current
          || age >= options.env.HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS
          || (kid !== undefined ? !current.keyIds.has(kid) : current.keyIds.size !== 1)
        ) throw error;
      }
    }

    if (kid === undefined) {
      if (current.keyIds.size !== 1) {
        reportRejectedRotation('ERR_JWKS_AMBIGUOUS_KEY');
        throw codedError('JWT without kid requires exactly one trusted key', 'ERR_JWKS_NO_MATCHING_KEY');
      }
      return current.key(protectedHeader, token);
    }

    if (!current.keyIds.has(kid)) {
      current = await refresh();
      if (!current.keyIds.has(kid)) {
        reportRejectedRotation('ERR_JWKS_NO_MATCHING_KEY');
        throw codedError('No matching key found in JWKS', 'ERR_JWKS_NO_MATCHING_KEY');
      }
    }
    return current.key(protectedHeader, token);
  };

  return async (token: string): Promise<SecurityExporterAuthResult> => {
    if (!isJwtShaped(token)) return { status: 'invalid' };
    try {
      const protectedHeader = decodeProtectedHeader(token);
      if (protectedHeader.alg !== 'RS256') return { status: 'invalid' };
      const { payload } = await jwtVerify(token, resolveKey, {
        issuer: options.env.HIVE_ROUTER_IAM_ISSUER,
        audience: options.env.HIVE_ROUTER_IAM_AUDIENCE,
        algorithms: [...SECURITY_EXPORTER_ALGORITHMS],
        requiredClaims: ['sub', 'iss', 'aud', 'iat', 'exp', 'jti'],
      });
      const clientId = options.env.HIVE_ROUTER_SECURITY_EXPORTER_CLIENT_ID ?? SECURITY_EXPORTER_CLIENT_ID;
      const authorized = payload.sub === clientId
        && payload['clientId'] === clientId
        && payload['actorType'] === 'SERVICE_ACCOUNT'
        && payload['token_type'] === SECURITY_EXPORTER_TOKEN_TYPE
        && Array.isArray(payload['permissions'])
        && payload['permissions'].includes(SECURITY_EXPORTER_PERMISSION);
      return authorized ? { status: 'authorized', payload } : { status: 'invalid' };
    } catch (error) {
      return { status: isJwksInfrastructureFailure(error) ? 'unavailable' : 'invalid' };
    }
  };
}

const exporterEnv = loadEnv();
export const authorizeSecurityExporterToken = createSecurityExporterAuthorizer({
  env: exporterEnv,
});
