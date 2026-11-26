// Step-up with a fresh Oathweave ID token instead of a password, and the retired password
// endpoints (EMBERPATH_PASSWORD_RELAY is off by default).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';

const ISSUER = 'https://identity.example.com/api/oathweave';
const JWKS_URL = 'https://identity.example.com/api/oathweave/oauth/jwks';
vi.stubEnv('OATHWEAVE_ISSUER', ISSUER);
vi.stubEnv('OATHWEAVE_JWKS_URL', JWKS_URL);
vi.stubEnv('OATHWEAVE_USERINFO_URL', 'https://identity.example.com/api/oathweave/oauth/userinfo');

const identity = vi.hoisted(() => ({
  issuer: 'https://identity.example.com/api/oathweave',
  subject: 'person-subject',
  sessionId: 'oathweave-session',
  displayName: 'Synthetic person',
  roles: ['SUPER_ADMIN'],
  permissions: ['*'],
  authenticatedAt: undefined as number | undefined,
}));
vi.mock('../../src/security/admin-identity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/security/admin-identity.js')>()),
  configuredOathweaveVerifier: () => async () => ({ ...identity }),
}));

const { createAdminApp } = await import('../../src/admin/app.js');
const { prisma } = await import('../../src/storage/client.js');
const { forgetStepUps, forgetStepUpChallenges } = await import('../../src/security/step-up.js');
const { loadEnv } = await import('../../src/config/env.js');
const app = createAdminApp();

const user = { id: 'existing-user', username: 'admin', displayName: 'Existing operator', passwordHash: '!externally-managed', createdAt: new Date(), updatedAt: new Date() };
const bearer = { Authorization: 'Bearer obviously-fake-fixture', 'content-type': 'application/json' };
const keys = await generateKeyPair('RS256', { extractable: true });
const other = await generateKeyPair('RS256');
const jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid: 'k1', alg: 'RS256', use: 'sig' }] };
let jwksAvailable = true;

const now = () => Math.floor(Date.now() / 1000);
let nonce = '';
/** Start a step-up as HiveXUI does: the nonce goes into the authorization request. */
async function challenge(headers: Record<string, string> = bearer): Promise<Response> {
  const response = await app.request('/api/auth/step-up/challenge', { method: 'POST', headers });
  if (response.status === 200) nonce = ((await response.clone().json()) as { nonce: string }).nonce;
  return response;
}
function claims(extra: JWTPayload = {}): JWTPayload {
  return { iss: ISSUER, aud: 'hivexui-emberpath', sub: identity.subject, sid: identity.sessionId, iat: now(), exp: now() + 300, auth_time: now(), nonce, jti: 'id-1', ...extra };
}
function idToken(payload: JWTPayload = claims(), key: CryptoKey = keys.privateKey): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).sign(key);
}
const send = (body: unknown, headers: Record<string, string> = bearer) => app.request('/api/auth/step-up', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
/** A challenge, then the proof (built after the challenge, so it carries its nonce). */
async function stepUp(body: unknown | (() => Promise<unknown>), headers: Record<string, string> = bearer): Promise<Response> {
  await challenge(headers);
  return send(typeof body === 'function' ? await (body as () => Promise<unknown>)() : body, headers);
}
const proof = (payload?: () => JWTPayload, key?: CryptoKey) => async () => ({ idToken: await idToken(payload ? payload() : claims(), key) });
const sensitiveWrite = () => app.request('/api/client-keys', { method: 'POST', headers: bearer, body: JSON.stringify({ name: 'x' }) });

beforeAll(() => {
  vi.stubEnv('EMBERPATH_OATHWEAVE_IDENTITIES_JSON', JSON.stringify([{ issuer: identity.issuer, subject: identity.subject, localId: user.id }]));
});
beforeEach(() => {
  forgetStepUps();
  forgetStepUpChallenges();
  nonce = '';
  jwksAvailable = true;
  identity.authenticatedAt = Date.now() - 60 * 60_000; // signed in an hour ago
  vi.spyOn(prisma.adminUser, 'findUnique').mockResolvedValue(user);
  vi.spyOn(prisma.auditEvent, 'create').mockResolvedValue({} as never);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === JWKS_URL && jwksAvailable) return Response.json(jwks);
    throw new Error('Unexpected outbound request to ' + url);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/auth/step-up', () => {
  it('turns a fresh ID token into a recent sign-in for the same session', async () => {
    const before = await sensitiveWrite();
    expect(before.status).toBe(403);
    expect(await before.json()).toMatchObject({ error: 'STEP_UP_REQUIRED' });

    const response = await stepUp(proof());
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; authTime: string; recentUntil: string };
    expect(body.ok).toBe(true);
    expect(Date.parse(body.recentUntil) - Date.parse(body.authTime)).toBe(15 * 60_000);
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'auth.step_up' }) }));

    // The protected endpoint now runs (and refuses only the invalid body).
    const after = await sensitiveWrite();
    expect(after.status).not.toBe(403);
  });

  it('does not carry a step-up over to another Oathweave session of the same person', async () => {
    expect((await stepUp(proof())).status).toBe(200);
    identity.sessionId = 'another-session';
    try {
      expect((await sensitiveWrite()).status).toBe(403);
    } finally {
      identity.sessionId = 'oathweave-session';
    }
  });

  it('refuses a stale sign-in', async () => {
    const response = await stepUp(proof(() => claims({ auth_time: now() - 301 })));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'REAUTH_STALE', reason: 'stale' });
    expect((await sensitiveWrite()).status).toBe(403);
  });

  it('honours EMBERPATH_STEP_UP_MAX_AGE_SECONDS', async () => {
    const env = loadEnv();
    env.EMBERPATH_STEP_UP_MAX_AGE_SECONDS = 30;
    try {
      expect(await (await stepUp(proof(() => claims({ auth_time: now() - 60 })))).json()).toMatchObject({ error: 'REAUTH_STALE' });
    } finally {
      env.EMBERPATH_STEP_UP_MAX_AGE_SECONDS = 300;
    }
  });

  it('refuses forged, wrong-audience, other-person, other-session and access tokens', async () => {
    const cases: Array<[() => JWTPayload, string, CryptoKey?]> = [
      [() => claims(), 'invalid_signature', other.privateKey],
      [() => claims({ aud: 'hivexui-magnus' }), 'invalid_audience'],
      [() => claims({ aud: 'emberpath' }), 'invalid_audience'],
      [() => claims({ iss: 'https://elsewhere.example.com' }), 'invalid_issuer'],
      [() => claims({ sub: 'someone-else' }), 'subject_mismatch'],
      [() => claims({ sid: 'another-session' }), 'session_mismatch'],
      [() => claims({ actorType: 'USER', clientId: 'hivexui-emberpath' }), 'not_an_id_token'],
      [() => claims({ exp: now() - 60, iat: now() - 400, auth_time: now() - 400 }), 'expired'],
      [() => claims({ nonce: 'another-nonce-0123456789' }), 'unknown_challenge'],
    ];
    for (const [payload, reason, key] of cases) {
      const response = await stepUp(proof(payload, key));
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'REAUTH_INVALID', reason });
    }
    expect((await sensitiveWrite()).status).toBe(403);
  });

  it('refuses a sign-in from before the challenge (prompt=login), even inside the window', async () => {
    const response = await stepUp(proof(() => claims({ auth_time: now() - 120 })));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'REAUTH_STALE', reason: 'before_request' });
  });

  it('uses a challenge once, and only for the user who started it', async () => {
    await challenge();
    const token = await idToken();
    expect((await send({ idToken: token })).status).toBe(200);
    expect(await (await send({ idToken: token })).json()).toMatchObject({ reason: 'unknown_challenge' });
    // A proof without any challenge.
    expect(await (await send({ idToken: await idToken(claims({ nonce: undefined })) })).json()).toMatchObject({ reason: 'unknown_challenge' });
    expect(await (await send({ idToken: 'not-a-jwt' })).json()).toMatchObject({ reason: 'unknown_challenge' });
  });

  it('describes the challenge it hands out', async () => {
    const response = await challenge();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ expiresIn: 600, maxAgeSeconds: 300, audiences: ['hivexui-emberpath'] });
    expect(String(body['nonce'])).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await app.request('/api/auth/step-up/challenge', { method: 'POST' })).status).toBe(401);
  });

  it('asks for a sign-in when the token has no auth_time', async () => {
    const payload = claims();
    delete payload['auth_time'];
    expect(await (await stepUp(async () => ({ idToken: await idToken({ ...payload, nonce }) }))).json()).toMatchObject({ error: 'REAUTH_REQUIRED', reason: 'missing_auth_time' });
  });

  it('accepts only the configured step-up clients', async () => {
    const env = loadEnv();
    env.EMBERPATH_STEP_UP_AUDIENCES = 'hivexui-partner';
    try {
      expect(await (await stepUp(proof())).json()).toMatchObject({ reason: 'invalid_audience' });
      expect((await stepUp(proof(() => claims({ aud: 'hivexui-partner' })))).status).toBe(200);
    } finally {
      delete env.EMBERPATH_STEP_UP_AUDIENCES;
    }
  });

  it('needs a body with an ID token and nothing else', async () => {
    for (const body of ['not json', {}, { idToken: '' }, { idToken: 'a.b.c', password: 'x' }]) {
      const response = await stepUp(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'REAUTH_REQUIRED' });
    }
  });

  it('needs a signed-in caller', async () => {
    const response = await app.request('/api/auth/step-up', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: await idToken() }) });
    expect(response.status).toBe(401);
  });

  it('answers 503, never an accept, when the keys are unavailable', async () => {
    jwksAvailable = false;
    const response = await stepUp(proof(undefined, other.privateKey));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'REAUTH_UNAVAILABLE' });
  });

  it('does not lock a person out after refused proofs', async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) expect((await stepUp(proof(undefined, other.privateKey))).status).toBe(401);
    expect((await stepUp(proof())).status).toBe(200);
  });
});

describe('step-up without Oathweave, and for a password session', () => {
  it('answers 503 STEP_UP_UNAVAILABLE without Oathweave configuration', async () => {
    vi.stubEnv('OATHWEAVE_JWKS_URL', '');
    try {
      for (const path of ['/api/auth/step-up/challenge', '/api/auth/step-up']) {
        const response = await app.request(path, { method: 'POST', headers: bearer, body: JSON.stringify({ idToken: 'a.b.c' }) });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: 'STEP_UP_UNAVAILABLE' });
      }
    } finally {
      vi.stubEnv('OATHWEAVE_JWKS_URL', JWKS_URL);
    }
  });

  it('steps up an OS-mode session only with a proof linked to its account', async () => {
    const { SignJWT: Sign } = await import('jose');
    const secret = new TextEncoder().encode(loadEnv().HIVE_ROUTER_SECRET);
    const cookieToken = await new Sign({ sid: 'emberpath-session', username: 'admin', roles: ['router-admin'], permissions: ['*'], authMode: 'os' })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuedAt().setExpirationTime('1h').sign(secret);
    vi.spyOn(prisma.adminSession, 'findFirst').mockResolvedValue({ sessionId: 'emberpath-session', userId: user.id, createdAt: new Date(Date.now() - 60 * 60_000), user } as never);
    const cookie = { cookie: 'hive_router_admin=' + cookieToken, 'content-type': 'application/json' };
    expect((await app.request('/api/client-keys', { method: 'POST', headers: cookie, body: '{}' })).status).toBe(403);

    vi.stubEnv('EMBERPATH_OATHWEAVE_IDENTITIES_JSON', '[]');
    expect(await (await stepUp(proof(() => claims({ sid: undefined })), cookie)).json()).toMatchObject({ error: 'REAUTH_INVALID', reason: 'not_linked' });
    vi.stubEnv('EMBERPATH_OATHWEAVE_IDENTITIES_JSON', JSON.stringify([{ issuer: identity.issuer, subject: identity.subject, localId: user.id }]));
    expect((await stepUp(proof(() => claims({ sid: undefined })), cookie)).status).toBe(200);
    expect((await app.request('/api/client-keys', { method: 'POST', headers: cookie, body: '{}' })).status).not.toBe(403);
  });
});

describe('retired password endpoints (EMBERPATH_PASSWORD_RELAY off)', () => {
  it('answer 410 Gone with a pointer to the docs, deprecated, without checking any password', async () => {
    for (const [path, headers] of [['/api/auth/login', { 'content-type': 'application/json' }], ['/api/auth/reauthenticate', bearer]] as const) {
      const response = await app.request(path, { method: 'POST', headers, body: JSON.stringify({ username: 'admin', password: 'obviously-fake-password' }) });
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ error: 'PASSWORD_RELAY_DISABLED', stepUp: '/api/auth/step-up', docs: expect.stringContaining('docs/OATHWEAVE.md') });
      expect(response.headers.get('deprecation')).toMatch(/^@\d+$/);
      expect(response.headers.get('sunset')).toMatch(/GMT$/);
      expect(response.headers.get('link')).toContain('rel="deprecation"');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
