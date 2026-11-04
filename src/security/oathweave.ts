import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';

export interface OathweaveOptions {
  issuer: string;
  jwksUrl: string;
  userinfoUrl: string;
  audience: string;
}
export interface OathweaveIdentity {
  subject: string;
  issuer: string;
  sessionId: string;
  roles: string[];
  permissions: string[];
  displayName: string;
  authenticatedAt?: number;
}

/** Resource JWT validation plus online session revocation. Failure is closed. */
export function createOathweaveVerifier(
  options: OathweaveOptions,
  overrides: { keys?: JWTVerifyGetKey; fetch?: typeof fetch } = {},
) {
  for (const value of [options.issuer, options.jwksUrl, options.userinfoUrl]) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new Error('Oathweave endpoints require verified HTTPS');
  }
  const request = overrides.fetch ?? fetch;
  const keys =
    overrides.keys ??
    createRemoteJWKSet(new URL(options.jwksUrl), {
      [customFetch]: (url, init) =>
        request(url, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.timeout(3000),
        }),
    });
  return async (token: string): Promise<OathweaveIdentity> => {
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'],
      issuer: options.issuer,
      audience: options.audience,
      requiredClaims: ['sub', 'iat', 'exp', 'jti'],
      maxTokenAge: '15m',
    });
    if (
      payload.aud !== options.audience ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > 900
    )
      throw new Error('Invalid resource token audience or lifetime');
    if (
      payload.actorType !== 'USER' ||
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      typeof payload.sessionId !== 'string' ||
      !payload.sessionId ||
      typeof payload.clientId !== 'string' ||
      !Array.isArray(payload.permissions) ||
      !payload.permissions.every((value) => typeof value === 'string') ||
      !Array.isArray(payload.roles) ||
      !payload.roles.every((value) => typeof value === 'string')
    )
      throw new Error('Invalid resource identity');
    const result = await request(options.userinfoUrl, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
    if (!result.ok) throw new Error('Identity session is inactive');
    const user: unknown = await result.json();
    if (
      !user ||
      typeof user !== 'object' ||
      (user as JWTPayload).sub !== payload.sub
    )
      throw new Error('Identity subject mismatch');
    const displayName =
      'name' in user && typeof user.name === 'string' ? user.name : payload.sub;
    return {
      subject: payload.sub,
      issuer: options.issuer,
      sessionId: payload.sessionId,
      permissions: payload.permissions as string[],
      roles: payload.roles as string[],
      displayName,
      ...(typeof payload.auth_time === 'number'
        ? { authenticatedAt: payload.auth_time * 1000 }
        : {}),
    };
  };
}

let verifier: ReturnType<typeof createOathweaveVerifier> | undefined;
export function configuredOathweaveVerifier() {
  if (
    !process.env.OATHWEAVE_ISSUER &&
    !process.env.OATHWEAVE_JWKS_URL &&
    !process.env.OATHWEAVE_USERINFO_URL
  )
    return undefined;
  if (!verifier) {
    if (
      !process.env.OATHWEAVE_ISSUER ||
      !process.env.OATHWEAVE_JWKS_URL ||
      !process.env.OATHWEAVE_USERINFO_URL
    )
      throw new Error('Oathweave configuration is incomplete');
    verifier = createOathweaveVerifier({
      issuer: process.env.OATHWEAVE_ISSUER,
      jwksUrl: process.env.OATHWEAVE_JWKS_URL,
      userinfoUrl: process.env.OATHWEAVE_USERINFO_URL,
      audience: 'emberpath',
    });
  }
  return verifier;
}
