import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSecurityExporterAuthorizer,
  resetLegacySecurityExporterWarningForTests,
  securityExporterVerifierSettings,
  SECURITY_EXPORTER_CLIENT_ID,
  SECURITY_EXPORTER_PERMISSION,
  warnLegacySecurityExporterSettings,
  type SecurityExporterAuthorizerOptions,
} from '../../src/security/security-exporter-auth.js';
import {
  getSecurityExporterJwksStatus,
  resetSecurityExporterJwksStatusForTests,
} from '../../src/security/security-exporter-jwks-status.js';

const expectedClaims = {
  actorType: 'SERVICE_ACCOUNT',
  clientId: SECURITY_EXPORTER_CLIENT_ID,
  token_type: 'access',
  roles: [],
  permissions: [SECURITY_EXPORTER_PERMISSION],
};

const baseEnv = {
  NODE_ENV: 'test' as const,
  HIVE_IAM_INTERNAL_URL: 'https://127.0.0.1:4200',
  HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS: false,
  HIVE_ROUTER_IAM_CA_CERT_PATH: undefined,
  HIVE_ROUTER_IAM_ISSUER: 'hive-iam',
  HIVE_ROUTER_IAM_AUDIENCE: 'hive-router',
  HIVE_ROUTER_IAM_JWKS_REFRESH_MS: 100,
  HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS: 200,
};

const BROWSER_ISSUER = 'https://id.example.test';

async function signingFixture(kid = 'test-key') {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const jwks: JSONWebKeySet = { keys: [jwk] };
  const sign = async (
    claims: Record<string, unknown> = expectedClaims,
    options: {
      issuer?: string;
      audience?: string | string[];
      subject?: string;
      expiresIn?: number;
      includeKid?: boolean;
    } = {},
  ) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', ...(options.includeKid === false ? {} : { kid }) })
      .setSubject(options.subject ?? SECURITY_EXPORTER_CLIENT_ID)
      .setIssuer(options.issuer ?? 'hive-iam')
      .setAudience(options.audience ?? 'hive-router')
      .setIssuedAt(now)
      .setExpirationTime(now + (options.expiresIn ?? 300))
      .setJti('test-jti')
      .sign(privateKey);
  };
  return { jwks, sign };
}

/** A JWKS endpoint: a key set (or a thrown error) per request, with the requests recorded. */
function jwksEndpoint(...answers: Array<unknown>) {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  let index = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input instanceof Request ? input.url : input), init });
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (answer instanceof Error) throw answer;
    if (answer instanceof Response) return answer;
    return Response.json(answer);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

function authorizer(fetch: typeof globalThis.fetch, overrides: Partial<SecurityExporterAuthorizerOptions> = {}) {
  return createSecurityExporterAuthorizer({
    env: baseEnv,
    source: {},
    fetch,
    reportTrustedKeys: vi.fn(),
    reportRefreshFailure: vi.fn(),
    reportRejectedRotation: vi.fn(),
    onConfigurationProblem: vi.fn(),
    ...overrides,
  });
}

describe('Security exporter Oathweave authorization', () => {
  afterEach(() => vi.useRealTimers());

  it('accepts a fully claimed RS256 exporter token on the native issuer', async () => {
    const { jwks, sign } = await signingFixture();
    const endpoint = jwksEndpoint(jwks);
    await expect(authorizer(endpoint.fetch)(await sign())).resolves.toMatchObject({ status: 'authorized' });
    expect(endpoint.requests[0]?.url).toBe('https://127.0.0.1:4200/api/v1/oauth/jwks');
    // The verifier never follows a redirect for the keys.
    expect(endpoint.requests[0]?.init?.redirect).toBe('error');
  });

  it('accepts only the configured exporter client id', async () => {
    const { jwks, sign } = await signingFixture();
    const custom = authorizer(jwksEndpoint(jwks).fetch, {
      env: { ...baseEnv, HIVE_ROUTER_SECURITY_EXPORTER_CLIENT_ID: 'legacy-exporter' },
    });
    await expect(custom(await sign(
      { ...expectedClaims, clientId: 'legacy-exporter' },
      { subject: 'legacy-exporter' },
    ))).resolves.toMatchObject({ status: 'authorized' });
    await expect(custom(await sign())).resolves.toEqual({ status: 'invalid' });
  });

  it('accepts a legacy IAM token without kid when exactly one key is trusted', async () => {
    const { jwks, sign } = await signingFixture();
    await expect(authorizer(jwksEndpoint(jwks).fetch)(await sign(expectedClaims, {
      includeKid: false,
    }))).resolves.toMatchObject({ status: 'authorized' });
  });

  it.each([
    ['wrong issuer', { issuer: 'other-iam' }, expectedClaims],
    ['wrong audience', { audience: 'other-service' }, expectedClaims],
    ['several audiences', { audience: ['hive-router', 'other-service'] }, expectedClaims],
    ['wrong subject', { subject: 'other-client' }, expectedClaims],
    ['expired', { expiresIn: -1 }, expectedClaims],
    ['too long-lived', { expiresIn: 3_600 }, expectedClaims],
    ['wrong client', {}, { ...expectedClaims, clientId: 'other-client' }],
    ['client only as client_id', {}, { ...expectedClaims, clientId: undefined, client_id: SECURITY_EXPORTER_CLIENT_ID }],
    ['wrong token type', {}, { ...expectedClaims, token_type: 'refresh' }],
    ['user actor', {}, { ...expectedClaims, actorType: 'USER' }],
    ['session-bound', {}, { ...expectedClaims, sessionId: 'session-1' }],
    ['missing exact permission', {}, { ...expectedClaims, permissions: ['router:*'] }],
    ['non-string permissions', {}, { ...expectedClaims, permissions: [SECURITY_EXPORTER_PERMISSION, 1] }],
  ])('rejects %s tokens as invalid credentials', async (_name, options, claims) => {
    const { jwks, sign } = await signingFixture();
    await expect(authorizer(jwksEndpoint(jwks).fetch)(await sign(claims, options))).resolves.toEqual({
      status: 'invalid',
    });
  });

  it('rejects opaque and undecodable credentials without consulting JWKS', async () => {
    const endpoint = jwksEndpoint(new TypeError('must not load'));
    const authorize = authorizer(endpoint.fetch);
    await expect(authorize('not-a-jwt')).resolves.toEqual({ status: 'invalid' });
    await expect(authorize('invalid.jwt.value')).resolves.toEqual({ status: 'invalid' });
    expect(endpoint.requests).toHaveLength(0);
  });

  it('rejects tokens signed with an unapproved algorithm before JWKS resolution', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT(expectedClaims)
      .setProtectedHeader({ alg: 'HS256', kid: 'test-key' })
      .setSubject(SECURITY_EXPORTER_CLIENT_ID)
      .setIssuer('hive-iam')
      .setAudience('hive-router')
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .setJti('test-jti')
      .sign(new TextEncoder().encode('test-secret-that-is-long-enough-for-hs256'));
    const endpoint = jwksEndpoint(new TypeError('must not load'));
    await expect(authorizer(endpoint.fetch)(token)).resolves.toEqual({ status: 'invalid' });
    expect(endpoint.requests).toHaveLength(0);
  });

  it('uses the last good keys after a failed refresh only inside the maximum cached-key age', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { jwks, sign } = await signingFixture();
    const endpoint = jwksEndpoint(jwks, Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }));
    const reportRefreshFailure = vi.fn();
    const authorize = authorizer(endpoint.fetch, {
      env: { ...baseEnv, HIVE_ROUTER_IAM_JWKS_REFRESH_MS: 10_000, HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS: 60_000 },
      reportRefreshFailure,
    });
    const token = await sign();
    await expect(authorize(token)).resolves.toMatchObject({ status: 'authorized' });
    vi.setSystemTime(Date.now() + 31_000);
    await expect(authorize(token)).resolves.toMatchObject({ status: 'authorized' });
    expect(reportRefreshFailure).toHaveBeenLastCalledWith('ECONNREFUSED');
    vi.setSystemTime(Date.now() + 31_000);
    await expect(authorize(token)).resolves.toEqual({ status: 'unavailable' });
  });

  it('keeps working with the production JWKS timings and issuers, and never trusts keys past the maximum age', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    resetSecurityExporterJwksStatusForTests();
    const { jwks, sign } = await signingFixture();
    const down = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    const endpoint = jwksEndpoint(jwks, down);
    const reportRefreshFailure = vi.fn();
    const reportTrustedKeys = vi.fn();
    const onConfigurationProblem = vi.fn();
    const production = { ...baseEnv, HIVE_ROUTER_IAM_JWKS_REFRESH_MS: 300_000, HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS: 900_000 };
    const authorize = authorizer(endpoint.fetch, {
      env: production,
      source: { HIVE_ROUTER_IAM_ISSUER: 'hive-iam', OATHWEAVE_ISSUER: BROWSER_ISSUER },
      reportRefreshFailure,
      reportTrustedKeys,
      onConfigurationProblem,
    });
    const start = Date.now();
    await expect(authorize(await sign())).resolves.toMatchObject({ status: 'authorized' });
    await expect(authorize(await sign(expectedClaims, { issuer: BROWSER_ISSUER }))).resolves.toMatchObject({ status: 'authorized' });
    expect(reportTrustedKeys).toHaveBeenCalledWith(start, ['test-key']);
    expect(getSecurityExporterJwksStatus(production.HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS)).toMatchObject({ trustedKeyCount: 1, fetchedAt: new Date(start).toISOString() });
    expect(endpoint.requests).toHaveLength(1);
    // A refresh that fails 599 s after the fetch keeps the keys (599 + 300 <= 900)...
    vi.setSystemTime(start + 599_000);
    // Tokens live five minutes, so each step signs a fresh one.
    await expect(authorize(await sign())).resolves.toMatchObject({ status: 'authorized' });
    expect(reportRefreshFailure).toHaveBeenLastCalledWith('ECONNREFUSED');
    expect(endpoint.requests).toHaveLength(2);
    // ...for one more refresh interval, without another request; the key age keeps growing.
    vi.setSystemTime(start + 898_000);
    await expect(authorize(await sign())).resolves.toMatchObject({ status: 'authorized' });
    expect(endpoint.requests).toHaveLength(2);
    expect(getSecurityExporterJwksStatus(production.HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS, start + 898_000)).toMatchObject({ state: 'critical', fetchedAt: new Date(start).toISOString() });
    // At the maximum age the exporter fails closed.
    vi.setSystemTime(start + 900_000);
    await expect(authorize(await sign())).resolves.toEqual({ status: 'unavailable' });
    expect(reportTrustedKeys).toHaveBeenCalledTimes(1);
    expect(onConfigurationProblem).not.toHaveBeenCalled();
  });

  it('refuses a first failed refresh later than the maximum age less one refresh interval', async () => {
    // With sparse traffic the first refresh after the keys expire can come late: 650 s after the
    // fetch is past 900 - 300 s, so the keys are not used, though they are younger than 900 s.
    vi.useFakeTimers({ toFake: ['Date'] });
    const { jwks, sign } = await signingFixture();
    const endpoint = jwksEndpoint(jwks, new TypeError('fetch failed'));
    const authorize = authorizer(endpoint.fetch, {
      env: { ...baseEnv, HIVE_ROUTER_IAM_JWKS_REFRESH_MS: 300_000, HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS: 900_000 },
    });
    await expect(authorize(await sign())).resolves.toMatchObject({ status: 'authorized' });
    vi.setSystemTime(Date.now() + 650_000);
    await expect(authorize(await sign())).resolves.toEqual({ status: 'unavailable' });
  });

  it('answers unavailable and names the settings when the stale window would exceed a day', async () => {
    const { jwks, sign } = await signingFixture();
    const endpoint = jwksEndpoint(jwks);
    const onConfigurationProblem = vi.fn();
    const authorize = authorizer(endpoint.fetch, {
      env: { ...baseEnv, HIVE_ROUTER_IAM_JWKS_REFRESH_MS: 300_000, HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS: 300_000 + 86_400_001 },
      onConfigurationProblem,
    });
    await expect(authorize(await sign())).resolves.toEqual({ status: 'unavailable' });
    expect(endpoint.requests).toHaveLength(0);
    expect(onConfigurationProblem).toHaveBeenCalledWith(expect.stringMatching(/HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS less HIVE_ROUTER_IAM_JWKS_REFRESH_MS/u));
  });

  it('verifies native-issuer service tokens without any https issuer', async () => {
    const { jwks, sign } = await signingFixture();
    const onConfigurationProblem = vi.fn();
    const authorize = authorizer(jwksEndpoint(jwks).fetch, { onConfigurationProblem });
    await expect(authorize(await sign())).resolves.toMatchObject({ status: 'authorized' });
    // No placeholder issuer stands in: an https-issued token is not accepted.
    for (const issuer of [BROWSER_ISSUER, 'https://oathweave.invalid/']) {
      await expect(authorize(await sign(expectedClaims, { issuer }))).resolves.toEqual({ status: 'invalid' });
    }
    expect(onConfigurationProblem).not.toHaveBeenCalled();
  });

  it('accepts a newly published rotation and reports trusted key IDs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await signingFixture('first-key');
    const second = await signingFixture('second-key');
    const reportTrustedKeys = vi.fn();
    const authorize = authorizer(jwksEndpoint(first.jwks, second.jwks).fetch, { reportTrustedKeys });
    await expect(authorize(await first.sign())).resolves.toMatchObject({ status: 'authorized' });
    vi.setSystemTime(Date.now() + 31_000);
    await expect(authorize(await second.sign())).resolves.toMatchObject({ status: 'authorized' });
    expect(reportTrustedKeys).toHaveBeenLastCalledWith(expect.any(Number), ['second-key']);
  });

  it('accepts old and new keyed tokens during a published overlap', async () => {
    const oldKey = await signingFixture('old-key');
    const activeKey = await signingFixture('active-key');
    const overlap: JSONWebKeySet = { keys: [...activeKey.jwks.keys, ...oldKey.jwks.keys] };
    const authorize = authorizer(jwksEndpoint(overlap).fetch);
    await expect(authorize(await activeKey.sign())).resolves.toMatchObject({ status: 'authorized' });
    await expect(authorize(await oldKey.sign())).resolves.toMatchObject({ status: 'authorized' });
  });

  it('rejects legacy no-kid tokens once an overlap contains multiple keys', async () => {
    const oldKey = await signingFixture('old-key');
    const activeKey = await signingFixture('active-key');
    const overlap: JSONWebKeySet = { keys: [...activeKey.jwks.keys, ...oldKey.jwks.keys] };
    await expect(authorizer(jwksEndpoint(overlap).fetch)(await oldKey.sign(expectedClaims, {
      includeKid: false,
    }))).resolves.toEqual({ status: 'invalid' });
  });

  it('rejects malformed or unbounded rotations and emits both failure metrics', async () => {
    const { sign } = await signingFixture();
    const reportRefreshFailure = vi.fn();
    const reportRejectedRotation = vi.fn();
    const authorize = authorizer(jwksEndpoint({
      keys: Array.from({ length: 33 }, (_, index) => ({ kid: `key-${index}`, kty: 'RSA', alg: 'RS256' })),
    }).fetch, { reportRefreshFailure, reportRejectedRotation });
    await expect(authorize(await sign())).resolves.toEqual({ status: 'unavailable' });
    expect(reportRefreshFailure).toHaveBeenCalledWith('ERR_JWKS_INVALID_KEY_COUNT');
    expect(reportRejectedRotation).toHaveBeenCalledWith('ERR_JWKS_INVALID_KEY_COUNT');
  });

  it('refuses a key set with a non-RS256 key as a whole', async () => {
    const { jwks, sign } = await signingFixture();
    const reportRejectedRotation = vi.fn();
    const mixed = { keys: [...jwks.keys, { kid: 'ec-key', kty: 'EC', alg: 'ES256', crv: 'P-256', x: 'AA', y: 'AA' }] };
    await expect(authorizer(jwksEndpoint(mixed).fetch, { reportRejectedRotation })(await sign()))
      .resolves.toEqual({ status: 'unavailable' });
    expect(reportRejectedRotation).toHaveBeenCalledWith('ERR_JWKS_INVALID_KEY');
  });

  it('refuses an oversized key set without parsing it', async () => {
    const { sign } = await signingFixture();
    const reportRefreshFailure = vi.fn();
    const huge = new Response('x'.repeat(256 * 1024 + 1), { status: 200 });
    await expect(authorizer(jwksEndpoint(huge).fetch, { reportRefreshFailure })(await sign()))
      .resolves.toEqual({ status: 'unavailable' });
    expect(reportRefreshFailure).toHaveBeenCalledWith('ERR_JWKS_RESPONSE_TOO_LARGE');
  });

  it('classifies a non-200 JWKS answer as unavailable', async () => {
    const { sign } = await signingFixture();
    const reportRefreshFailure = vi.fn();
    await expect(authorizer(jwksEndpoint(new Response('nope', { status: 502 })).fetch, { reportRefreshFailure })(await sign()))
      .resolves.toEqual({ status: 'unavailable' });
    expect(reportRefreshFailure).toHaveBeenCalledWith('ERR_JWKS_HTTP_STATUS');
  });

  it.each(['ECONNREFUSED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'])(
    'classifies %s JWKS transport failures as unavailable',
    async (code) => {
      const { sign } = await signingFixture();
      const authorize = authorizer(jwksEndpoint(Object.assign(new Error('JWKS transport failed'), { code })).fetch);
      await expect(authorize(await sign())).resolves.toEqual({ status: 'unavailable' });
    },
  );

  it('keeps a missing signing key in the invalid-credential class', async () => {
    const signer = await signingFixture('requested-key');
    const other = await signingFixture('trusted-key');
    await expect(authorizer(jwksEndpoint(other.jwks).fetch)(await signer.sign())).resolves.toEqual({ status: 'invalid' });
  });

  it('accepts the https issuer and the native issuer from the Oathweave settings, and OATHWEAVE_JWKS_URL', async () => {
    const { jwks, sign } = await signingFixture();
    const endpoint = jwksEndpoint(jwks);
    const authorize = authorizer(endpoint.fetch, {
      env: { ...baseEnv, HIVE_ROUTER_IAM_ISSUER: 'legacy-ignored' },
      source: {
        OATHWEAVE_ISSUER: BROWSER_ISSUER,
        OATHWEAVE_NATIVE_ISSUERS: 'oathweave-native',
        OATHWEAVE_JWKS_URL: 'https://oathweave:4200/api/v1/oauth/jwks',
      },
    });
    await expect(authorize(await sign(expectedClaims, { issuer: BROWSER_ISSUER }))).resolves.toMatchObject({ status: 'authorized' });
    await expect(authorize(await sign(expectedClaims, { issuer: 'oathweave-native' }))).resolves.toMatchObject({ status: 'authorized' });
    // OATHWEAVE_NATIVE_ISSUERS replaces the legacy name.
    await expect(authorize(await sign(expectedClaims, { issuer: 'legacy-ignored' }))).resolves.toEqual({ status: 'invalid' });
    expect(endpoint.requests[0]?.url).toBe('https://oathweave:4200/api/v1/oauth/jwks');
  });

  it('keeps the legacy native issuer next to OATHWEAVE_ISSUER while OATHWEAVE_NATIVE_ISSUERS is unset', async () => {
    const { jwks, sign } = await signingFixture();
    const authorize = authorizer(jwksEndpoint(jwks).fetch, { source: { OATHWEAVE_ISSUER: BROWSER_ISSUER } });
    await expect(authorize(await sign())).resolves.toMatchObject({ status: 'authorized' });
    await expect(authorize(await sign(expectedClaims, { issuer: BROWSER_ISSUER }))).resolves.toMatchObject({ status: 'authorized' });
  });

  it('accepts a legacy https HIVE_ROUTER_IAM_ISSUER as the https issuer', async () => {
    const { jwks, sign } = await signingFixture();
    const authorize = authorizer(jwksEndpoint(jwks).fetch, { env: { ...baseEnv, HIVE_ROUTER_IAM_ISSUER: BROWSER_ISSUER } });
    await expect(authorize(await sign(expectedClaims, { issuer: BROWSER_ISSUER }))).resolves.toMatchObject({ status: 'authorized' });
    await expect(authorize(await sign())).resolves.toEqual({ status: 'invalid' });
  });

  it('answers unavailable, without fetching, when the JWKS URL is not HTTPS, and reports it once', async () => {
    const { sign } = await signingFixture();
    for (const url of ['http://oathweave:4200', 'http://127.0.0.1:4200']) {
      const endpoint = jwksEndpoint(new TypeError('must not load'));
      const onConfigurationProblem = vi.fn();
      const authorize = authorizer(endpoint.fetch, { env: { ...baseEnv, HIVE_IAM_INTERNAL_URL: url }, onConfigurationProblem });
      await expect(authorize(await sign())).resolves.toEqual({ status: 'unavailable' });
      await expect(authorize(await sign())).resolves.toEqual({ status: 'unavailable' });
      expect(endpoint.requests).toHaveLength(0);
      expect(onConfigurationProblem).toHaveBeenCalledTimes(1);
      expect(onConfigurationProblem.mock.calls[0]?.[0]).toMatch(/jwksUrl must use https/u);
      expect(onConfigurationProblem.mock.calls[0]?.[0]).not.toContain(url);
    }
  });
});

describe('Security exporter settings', () => {
  beforeEach(() => resetLegacySecurityExporterWarningForTests());

  it('default to the native hive-iam issuer and the HIVE_IAM_INTERNAL_URL key set, without a warning', () => {
    expect(securityExporterVerifierSettings(baseEnv, {})).toEqual({
      issuers: [],
      nativeIssuers: ['hive-iam'],
      jwksUrl: 'https://127.0.0.1:4200/api/v1/oauth/jwks',
      audience: 'hive-router',
      legacy: [],
    });
    const warn = vi.fn();
    warnLegacySecurityExporterSettings(baseEnv, {}, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warn once when only the legacy issuer name is set', () => {
    const warn = vi.fn();
    const source = { HIVE_ROUTER_IAM_ISSUER: 'hive-iam', OATHWEAVE_ISSUER: BROWSER_ISSUER };
    warnLegacySecurityExporterSettings(baseEnv, source, warn);
    warnLegacySecurityExporterSettings(baseEnv, source, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^HIVE_ROUTER_IAM_ISSUER is deprecated .* set OATHWEAVE_NATIVE_ISSUERS instead/u),
      { setting: 'HIVE_ROUTER_IAM_ISSUER', replacement: 'OATHWEAVE_NATIVE_ISSUERS' },
    );
    const httpsLegacy = { ...baseEnv, HIVE_ROUTER_IAM_ISSUER: BROWSER_ISSUER };
    expect(securityExporterVerifierSettings(httpsLegacy, { HIVE_ROUTER_IAM_ISSUER: BROWSER_ISSUER }).legacy)
      .toEqual([['HIVE_ROUTER_IAM_ISSUER', 'OATHWEAVE_ISSUER']]);
  });

  it('do not warn when the current name is set too', () => {
    const warn = vi.fn();
    warnLegacySecurityExporterSettings(baseEnv, { HIVE_ROUTER_IAM_ISSUER: 'hive-iam', OATHWEAVE_NATIVE_ISSUERS: 'hive-iam' }, warn);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('Security exporter JWKS with a pinned CA', () => {
  let directory = '';
  let server: Server;
  let jwksBase = '';
  let serverCa = '';
  let otherCa = '';
  let fixture: Awaited<ReturnType<typeof signingFixture>>;

  function certificate(name: string): { cert: string; key: string } {
    const cert = join(directory, `${name}.crt`);
    const key = join(directory, `${name}.key`);
    const config = join(directory, `${name}.cnf`);
    writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\n');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-config', config], { stdio: 'ignore' });
    return { cert, key };
  }

  beforeAll(async () => {
    fixture = await signingFixture();
    directory = mkdtempSync(join(tmpdir(), 'emberpath-exporter-ca-'));
    const served = certificate('oathweave');
    serverCa = served.cert;
    otherCa = certificate('other').cert;
    server = createServer({ cert: readFileSync(served.cert), key: readFileSync(served.key) }, (_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(fixture.jwks));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    jwksBase = `https://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });

  const authorizeWith = (caPath: string) => createSecurityExporterAuthorizer({
    env: { ...baseEnv, HIVE_IAM_INTERNAL_URL: jwksBase, HIVE_ROUTER_IAM_CA_CERT_PATH: caPath },
    source: {},
    reportTrustedKeys: vi.fn(),
    reportRefreshFailure: vi.fn(),
    reportRejectedRotation: vi.fn(),
  });

  it('trusts the JWKS endpoint signed by HIVE_ROUTER_IAM_CA_CERT_PATH', async () => {
    await expect(authorizeWith(serverCa)(await fixture.sign())).resolves.toMatchObject({ status: 'authorized' });
  });

  it('answers unavailable when the pinned CA did not sign the JWKS certificate', async () => {
    await expect(authorizeWith(otherCa)(await fixture.sign())).resolves.toEqual({ status: 'unavailable' });
  });
});
