import { describe, expect, it } from 'vitest';
import { createHiveMemCredential, refreshPoint, unverifiedJwtExpiry, type ServiceToken } from '../../src/security/hivemem-credential.js';

const jwt = (claims: Record<string, unknown>) =>
  [{ alg: 'none' }, claims].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.fake-signature';

function clock(start = Date.parse('2026-11-23T00:00:00Z')) {
  let at = start;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

/** An Oathweave stand-in that issues numbered tokens with a real `exp` claim. */
function issuer(time: { now: () => number }, lifetimeSeconds = 300) {
  let issued = 0;
  let available = true;
  let pending: Array<() => void> | null = null;
  const fetchServiceToken = async (): Promise<ServiceToken | null> => {
    if (pending) await new Promise<void>((resolve) => pending!.push(resolve));
    if (!available) throw new TypeError('fetch failed');
    issued += 1;
    return { accessToken: jwt({ n: issued, exp: Math.floor(time.now() / 1000) + lifetimeSeconds }), expiresIn: lifetimeSeconds };
  };
  return {
    fetchServiceToken,
    get issued() { return issued; },
    set available(value: boolean) { available = value; },
    hold() { pending = []; },
    release() { const waiting = pending ?? []; pending = null; for (const resolve of waiting) resolve(); },
  };
}

const serial = (token: string | undefined) => token ? (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { n?: number }).n : undefined;

describe('HiveMem credential', () => {
  it('reads expiry claims without trusting them and refreshes at 80% of the lifetime', () => {
    expect(unverifiedJwtExpiry(jwt({ exp: 100 }))).toBe(100_000);
    expect(unverifiedJwtExpiry('not-a-jwt')).toBeNull();
    expect(unverifiedJwtExpiry(jwt({ exp: 'soon' }))).toBeNull();
    expect(refreshPoint(0, 300_000)).toBe(240_000);
    expect(refreshPoint(0, 60_000)).toBe(30_000);
    expect(refreshPoint(0, 20_000)).toBe(0);
  });

  it('fetches once, reuses the token, and renews it before expiry while still serving the current one', async () => {
    const time = clock();
    const oathweave = issuer(time);
    const credential = createHiveMemCredential({ serviceConfigured: true, fetchServiceToken: oathweave.fetchServiceToken, now: time.now });
    const first = await credential.authorization();
    expect(first?.source).toBe('oathweave');
    expect(serial(first?.token)).toBe(1);
    time.advance(200_000);
    expect(serial((await credential.authorization())?.token)).toBe(1);
    expect(oathweave.issued).toBe(1);
    time.advance(50_000); // past the refresh point, before expiry
    expect(serial((await credential.authorization())?.token)).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(oathweave.issued).toBe(2);
    expect(serial((await credential.authorization())?.token)).toBe(2);
  });

  it('shares one in-flight fetch among concurrent callers', async () => {
    const time = clock();
    const oathweave = issuer(time);
    const credential = createHiveMemCredential({ serviceConfigured: true, fetchServiceToken: oathweave.fetchServiceToken, now: time.now });
    oathweave.hold();
    const waiting = Promise.all(Array.from({ length: 6 }, () => credential.authorization()));
    oathweave.release();
    const results = await waiting;
    expect(oathweave.issued).toBe(1);
    expect(new Set(results.map((result) => result?.token)).size).toBe(1);
  });

  it('keeps working for days of continuous use with no outside renewal, never serving an expired token', async () => {
    const time = clock();
    const oathweave = issuer(time);
    const credential = createHiveMemCredential({ serviceConfigured: true, fetchServiceToken: oathweave.fetchServiceToken, now: time.now });
    for (let minute = 0; minute < 3 * 24 * 60; minute += 1) {
      const authorization = await credential.authorization();
      expect(authorization?.source).toBe('oathweave');
      expect(unverifiedJwtExpiry(authorization!.token)! - time.now()).toBeGreaterThan(5_000);
      await new Promise((resolve) => setImmediate(resolve));
      time.advance(60_000);
    }
    // About one fetch per four minutes, not one per request.
    expect(oathweave.issued).toBeGreaterThan(3 * 24 * 60 / 5);
    expect(oathweave.issued).toBeLessThan(3 * 24 * 60 / 3);
  });

  it('rides out a brief identity outage on the current token, then falls back, then recovers on its own', async () => {
    const time = clock();
    const oathweave = issuer(time);
    const staticToken = jwt({ sub: 'fake-router', exp: Math.floor(time.now() / 1000) + 3600 });
    const credential = createHiveMemCredential({ serviceConfigured: true, fetchServiceToken: oathweave.fetchServiceToken, staticToken, now: time.now, failureBackoffMs: 10_000 });
    expect(serial((await credential.authorization())?.token)).toBe(1);
    oathweave.available = false;
    time.advance(250_000);
    expect(serial((await credential.authorization())?.token)).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
    time.advance(60_000); // the service token has expired and Oathweave is still down
    expect(await credential.authorization()).toEqual({ token: staticToken, source: 'static' });
    expect(credential.status()).toMatchObject({ mode: 'oathweave', serviceTokenValid: false, staticTokenExpired: false });
    const attempts = oathweave.issued;
    await credential.authorization();
    expect(oathweave.issued).toBe(attempts); // backoff: no fetch per request during an outage
    oathweave.available = true;
    time.advance(10_001);
    expect((await credential.authorization())?.source).toBe('oathweave');
    expect(credential.status().lastFailureAt).not.toBeNull();
  });

  it('never sends a static token after its own expiry', async () => {
    const time = clock();
    const staticToken = jwt({ sub: 'fake-router', exp: Math.floor(time.now() / 1000) + 60 });
    const unavailable = createHiveMemCredential({ serviceConfigured: true, fetchServiceToken: async () => null, staticToken, now: time.now });
    expect((await unavailable.authorization())?.source).toBe('static');
    time.advance(61_000);
    expect(await unavailable.authorization()).toBeNull();
    expect(unavailable.configured()).toBe(true);
    expect(unavailable.status()).toMatchObject({ staticTokenExpired: true });
    const staticOnly = createHiveMemCredential({ serviceConfigured: false, fetchServiceToken: async () => { throw new Error('must not fetch'); }, staticToken, now: time.now });
    expect(await staticOnly.authorization()).toBeNull();
    expect(createHiveMemCredential({ serviceConfigured: false, fetchServiceToken: async () => null }).configured()).toBe(false);
  });

  it('replaces a token HiveMem refuses, and backs off when a fresh token is refused', async () => {
    const time = clock();
    const oathweave = issuer(time);
    const credential = createHiveMemCredential({ serviceConfigured: true, fetchServiceToken: oathweave.fetchServiceToken, now: time.now, failureBackoffMs: 5_000 });
    const first = await credential.authorization();
    time.advance(60_000);
    credential.reject(first!.token);
    expect(serial((await credential.authorization())?.token)).toBe(2);
    const second = await credential.authorization();
    credential.reject(second!.token); // refused right after issue: configuration, not expiry
    expect(await credential.authorization()).toBeNull();
    expect(oathweave.issued).toBe(2);
    time.advance(5_001);
    expect(serial((await credential.authorization())?.token)).toBe(3);
    credential.reject('an-unrelated-token');
    expect(serial((await credential.authorization())?.token)).toBe(3);
  });

  it('reports failures without response bodies or secrets', async () => {
    const reasons: string[] = [];
    const credential = createHiveMemCredential({
      serviceConfigured: true,
      fetchServiceToken: async () => { throw new Error('client_secret=fake-secret-value rejected'); },
      onEvent: (event) => { if (event.type === 'refresh-failed') reasons.push(event.reason); },
    });
    expect(await credential.authorization()).toBeNull();
    expect(reasons).toEqual(['Error']);
  });

  it('refuses a token that is already expired when issued', async () => {
    const time = clock();
    const credential = createHiveMemCredential({
      serviceConfigured: true,
      now: time.now,
      fetchServiceToken: async () => ({ accessToken: jwt({ exp: Math.floor(time.now() / 1000) - 1 }), expiresIn: 300 }),
    });
    expect(await credential.authorization()).toBeNull();
  });
});
