import { describe, expect, it } from 'vitest';
import { generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { loadOathweaveVectors, runOathweaveConformance } from '@hivemagnus/hive-common/oathweave/conformance';
import { createOathweaveVerifier, linkedLocalId, parseAccountLinks } from '../../src/security/admin-identity.js';

describe('Oathweave admin verifier', () => {
  it('meets the shared Oathweave conformance vectors for user tokens', async () => {
    const vectors = await loadOathweaveVectors();
    const users = vectors.vectors.filter((vector) => vector.principal === 'user').map((vector) => vector.name);
    const report = await runOathweaveConformance(
      (token, ctx) =>
        createOathweaveVerifier(
          { issuer: ctx.issuer, audience: ctx.audience, jwksUrl: ctx.jwksUrl, userinfoUrl: ctx.userinfoUrl },
          { fetch: ctx.fetch, now: () => ctx.nowMs },
        )(token),
      // Emberpath's admin API accepts people only; the service vector is checked below.
      { strictReasons: true, only: users },
    );
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(users.length);
  });

  it('refuses the valid service-account vector', async () => {
    const vectors = await loadOathweaveVectors();
    const service = vectors.vectors.find((vector) => vector.name === 'valid-service')!;
    const report = await runOathweaveConformance(
      (token, ctx) =>
        createOathweaveVerifier(
          { issuer: ctx.issuer, audience: ctx.audience, jwksUrl: ctx.jwksUrl, userinfoUrl: ctx.userinfoUrl },
          { fetch: ctx.fetch, now: () => ctx.nowMs },
        )(token),
      { only: [service.name], throwOnFailure: false, vectors: { ...vectors, vectors: [service] } },
    );
    expect(report.results[0]).toMatchObject({ actual: 'reject' });
  });

  describe('product rules kept from the previous verifier', () => {
    const issuer = 'https://identity.example.com';
    const options = { issuer, audience: 'emberpath', jwksUrl: `${issuer}/jwks`, userinfoUrl: `${issuer}/userinfo` };
    const setup = async (status = 200) => {
      const keys = await generateKeyPair('RS256');
      let calls = 0;
      let active = true;
      const verify = createOathweaveVerifier(options, {
        keys: async () => keys.publicKey,
        fetch: async () => {
          calls += 1;
          if (status !== 200) return new Response('', { status });
          return Response.json(active ? { sub: 'fake-user', name: 'Synthetic person' } : {}, { status: active ? 200 : 401 });
        },
      });
      const sign = (claims: JWTPayload = {}, at = Math.floor(Date.now() / 1000)) =>
        new SignJWT({
          actorType: 'USER',
          clientId: 'hivexui-emberpath',
          sessionId: 'fake-session',
          permissions: ['router:providers:read'],
          roles: ['VIEWER'],
          auth_time: at - 30,
          ...claims,
        })
          .setProtectedHeader({ alg: 'RS256' })
          .setIssuer(issuer)
          .setSubject('fake-user')
          .setAudience('emberpath')
          .setJti('fake-jti')
          .setIssuedAt(at)
          .setExpirationTime(at + 300)
          .sign(keys.privateKey);
      return { verify, sign, calls: () => calls, revoke: () => { active = false; } };
    };

    it('returns the identity with the authentication time in milliseconds', async () => {
      const { verify, sign } = await setup();
      const at = Math.floor(Date.now() / 1000);
      expect(await verify(await sign({}, at))).toEqual({
        subject: 'fake-user',
        issuer,
        sessionId: 'fake-session',
        roles: ['VIEWER'],
        permissions: ['router:providers:read'],
        displayName: 'Synthetic person',
        authenticatedAt: (at - 30) * 1000,
      });
    });

    it('requires the roles and clientId claims', async () => {
      const { verify, sign } = await setup();
      await expect(verify(await sign({ roles: undefined }))).rejects.toMatchObject({ reason: 'invalid_claims' });
      await expect(verify(await sign({ clientId: undefined, client_id: 'hivexui-emberpath' }))).rejects.toMatchObject({
        reason: 'invalid_claims',
      });
    });

    it('tolerates no clock skew', async () => {
      const { verify, sign } = await setup();
      await expect(verify(await sign({}, Math.floor(Date.now() / 1000) + 20))).rejects.toMatchObject({ reason: 'not_yet_valid' });
      await expect(verify(await sign({}, Math.floor(Date.now() / 1000) - 301))).rejects.toMatchObject({ reason: 'expired' });
    });

    it('checks the identity session online on every use', async () => {
      const { verify, sign, calls, revoke } = await setup();
      const token = await sign();
      await verify(token);
      await verify(token);
      expect(calls()).toBe(2);
      revoke();
      await expect(verify(token)).rejects.toMatchObject({ reason: 'session_inactive' });
    });

    it('refuses when the identity service is unavailable', async () => {
      const { verify, sign } = await setup(503);
      await expect(verify(await sign())).rejects.toMatchObject({ reason: 'identity_unavailable' });
    });

    it('refuses plain-http endpoints at startup', () => {
      expect(() => createOathweaveVerifier({ ...options, jwksUrl: 'http://identity.example.com/jwks' })).toThrow(/https/);
    });
  });

  describe('account links', () => {
    const identity = { issuer: 'https://identity.example.com', subject: 'fake-user' };
    it('keeps the existing localId format and refuses other fields', () => {
      const links = parseAccountLinks(JSON.stringify([{ ...identity, localId: 'existing-product-id' }]));
      expect(linkedLocalId(links, identity)).toBe('existing-product-id');
      expect(() => parseAccountLinks(JSON.stringify([{ ...identity, localUserId: 'existing-product-id' }]))).toThrow();
      expect(() => parseAccountLinks(JSON.stringify({ ...identity, localId: 'existing-product-id' }))).toThrow();
    });
  });
});
