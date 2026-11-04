import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import {
  createSecurityExporterAuthorizer,
  SECURITY_EXPORTER_CLIENT_ID,
  SECURITY_EXPORTER_PERMISSION,
} from '../../src/security/security-exporter-auth.js';

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
      audience?: string;
      subject?: string;
      expiresIn?: number;
      algorithm?: 'RS256';
      includeKid?: boolean;
    } = {},
  ) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({
        alg: options.algorithm ?? 'RS256',
        ...(options.includeKid === false ? {} : { kid }),
      })
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

function authorizer(loadJwks: () => Promise<unknown>) {
  return createSecurityExporterAuthorizer({
    env: baseEnv,
    loadJwks,
    reportTrustedKeys: vi.fn(),
    reportRefreshFailure: vi.fn(),
    reportRejectedRotation: vi.fn(),
  });
}

describe('Security exporter exporter IAM authorization', () => {
  it('accepts a fully claimed RS256 exporter token', async () => {
    const { jwks, sign } = await signingFixture();
    await expect(authorizer(async () => jwks)(await sign())).resolves.toMatchObject({
      status: 'authorized',
    });
  });

  it('accepts only the configured exporter client id', async () => {
    const { jwks, sign } = await signingFixture();
    const custom = createSecurityExporterAuthorizer({
      env: { ...baseEnv, HIVE_ROUTER_SECURITY_EXPORTER_CLIENT_ID: 'legacy-exporter' },
      loadJwks: async () => jwks,
      reportTrustedKeys: vi.fn(),
      reportRefreshFailure: vi.fn(),
      reportRejectedRotation: vi.fn(),
    });
    await expect(custom(await sign(
      { ...expectedClaims, clientId: 'legacy-exporter' },
      { subject: 'legacy-exporter' },
    ))).resolves.toMatchObject({ status: 'authorized' });
    await expect(custom(await sign())).resolves.not.toMatchObject({ status: 'authorized' });
  });

  it('accepts a legacy IAM token without kid when exactly one key is trusted', async () => {
    const { jwks, sign } = await signingFixture();
    await expect(authorizer(async () => jwks)(await sign(expectedClaims, {
      includeKid: false,
    }))).resolves.toMatchObject({ status: 'authorized' });
  });

  it.each([
    ['wrong issuer', { issuer: 'other-iam' }, expectedClaims],
    ['wrong audience', { audience: 'other-service' }, expectedClaims],
    ['wrong subject', { subject: 'other-client' }, expectedClaims],
    ['expired', { expiresIn: -1 }, expectedClaims],
    ['wrong client', {}, { ...expectedClaims, clientId: 'other-client' }],
    ['wrong token type', {}, { ...expectedClaims, token_type: 'refresh' }],
    ['missing exact permission', {}, { ...expectedClaims, permissions: ['router:*'] }],
  ])('rejects %s tokens as invalid credentials', async (_name, options, claims) => {
    const { jwks, sign } = await signingFixture();
    await expect(authorizer(async () => jwks)(await sign(claims, options))).resolves.toEqual({
      status: 'invalid',
    });
  });

  it('rejects opaque credentials without consulting JWKS', async () => {
    const loadJwks = vi.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(authorizer(loadJwks)('not-a-jwt')).resolves.toEqual({ status: 'invalid' });
    expect(loadJwks).not.toHaveBeenCalled();
  });

  it('keeps JWT-shaped but undecodable credentials in the invalid class', async () => {
    const loadJwks = vi.fn(async () => { throw new Error('must not load'); });
    await expect(authorizer(loadJwks)('invalid.jwt.value')).resolves.toEqual({
      status: 'invalid',
    });
    expect(loadJwks).not.toHaveBeenCalled();
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
    const loadJwks = vi.fn(async () => { throw new Error('must not load'); });
    await expect(authorizer(loadJwks)(token)).resolves.toEqual({ status: 'invalid' });
    expect(loadJwks).not.toHaveBeenCalled();
  });

  it('uses a stale known key only inside the maximum cached-key age', async () => {
    const { jwks, sign } = await signingFixture();
    let now = 1_000;
    const loadJwks = vi.fn()
      .mockResolvedValueOnce(jwks)
      .mockRejectedValue(Object.assign(new Error('connection refused'), {
        code: 'ECONNREFUSED',
      }));
    const authorize = createSecurityExporterAuthorizer({
      env: {
        ...baseEnv,
        HIVE_ROUTER_IAM_JWKS_REFRESH_MS: 10_000,
        HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS: 60_000,
      },
      loadJwks,
      now: () => now,
      reportTrustedKeys: vi.fn(),
      reportRefreshFailure: vi.fn(),
      reportRejectedRotation: vi.fn(),
    });
    const token = await sign();
    await expect(authorize(token)).resolves.toMatchObject({ status: 'authorized' });
    now += 31_000;
    await expect(authorize(token)).resolves.toMatchObject({ status: 'authorized' });
    now += 31_000;
    await expect(authorize(token)).resolves.toEqual({ status: 'unavailable' });
  });

  it('accepts a newly published bounded rotation and reports trusted key IDs', async () => {
    const first = await signingFixture('first-key');
    const second = await signingFixture('second-key');
    const reportTrustedKeys = vi.fn();
    let now = 1_000;
    const loadJwks = vi.fn()
      .mockResolvedValueOnce(first.jwks)
      .mockResolvedValueOnce(second.jwks);
    const authorize = createSecurityExporterAuthorizer({
      env: baseEnv,
      loadJwks,
      now: () => now,
      reportTrustedKeys,
      reportRefreshFailure: vi.fn(),
      reportRejectedRotation: vi.fn(),
    });
    await expect(authorize(await first.sign())).resolves.toMatchObject({ status: 'authorized' });
    now += 31_000;
    await expect(authorize(await second.sign())).resolves.toMatchObject({ status: 'authorized' });
    expect(reportTrustedKeys).toHaveBeenLastCalledWith(expect.any(Number), ['second-key']);
  });

  it('accepts old and new keyed tokens during a published overlap', async () => {
    const oldKey = await signingFixture('old-key');
    const activeKey = await signingFixture('active-key');
    const overlap: JSONWebKeySet = {
      keys: [...activeKey.jwks.keys, ...oldKey.jwks.keys],
    };
    const authorize = authorizer(async () => overlap);
    await expect(authorize(await activeKey.sign())).resolves.toMatchObject({ status: 'authorized' });
    await expect(authorize(await oldKey.sign())).resolves.toMatchObject({ status: 'authorized' });
  });

  it('rejects legacy no-kid tokens once an overlap contains multiple keys', async () => {
    const oldKey = await signingFixture('old-key');
    const activeKey = await signingFixture('active-key');
    const overlap: JSONWebKeySet = {
      keys: [...activeKey.jwks.keys, ...oldKey.jwks.keys],
    };
    await expect(authorizer(async () => overlap)(await oldKey.sign(expectedClaims, {
      includeKid: false,
    }))).resolves.toEqual({ status: 'invalid' });
  });

  it('rejects malformed or unbounded rotations and emits both failure metrics', async () => {
    const { sign } = await signingFixture();
    const reportRefreshFailure = vi.fn();
    const reportRejectedRotation = vi.fn();
    const authorize = createSecurityExporterAuthorizer({
      env: baseEnv,
      loadJwks: async () => ({
        keys: Array.from({ length: 33 }, (_, index) => ({
          kid: `key-${index}`,
          kty: 'RSA',
          alg: 'RS256',
        })),
      }),
      reportTrustedKeys: vi.fn(),
      reportRefreshFailure,
      reportRejectedRotation,
    });
    await expect(authorize(await sign())).resolves.toEqual({ status: 'unavailable' });
    expect(reportRefreshFailure).toHaveBeenCalledWith('ERR_JWKS_INVALID_KEY_COUNT');
    expect(reportRejectedRotation).toHaveBeenCalledWith('ERR_JWKS_INVALID_KEY_COUNT');
  });

  it.each(['ECONNREFUSED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'])(
    'classifies %s JWKS transport failures as unavailable',
    async (code) => {
      const { sign } = await signingFixture();
      const authorize = authorizer(async () => {
        throw Object.assign(new Error('JWKS transport failed'), { code });
      });
      await expect(authorize(await sign())).resolves.toEqual({ status: 'unavailable' });
    },
  );

  it('keeps a missing signing key in the invalid-credential class', async () => {
    const signer = await signingFixture('requested-key');
    const other = await signingFixture('trusted-key');
    await expect(authorizer(async () => other.jwks)(await signer.sign())).resolves.toEqual({
      status: 'invalid',
    });
  });
});
