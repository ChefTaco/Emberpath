import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createOathweaveVerifier } from '../../src/security/admin-identity.js';

describe('Oathweave resource authentication', () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  const config = {
    issuer: 'https://identity.example.com',
    jwksUrl: 'https://identity.example.com/jwks',
    userinfoUrl: 'https://identity.example.com/userinfo',
    audience: 'emberpath',
  };
  beforeAll(async () => {
    keys = await generateKeyPair('RS256');
  });
  async function fixture(
    audience: string | string[] = 'emberpath',
    permissions = ['router:providers:read'],
    lifetime = '5m',
  ) {
    return new SignJWT({
      actorType: 'USER',
      sessionId: 'fake-session',
      clientId: 'hivexui-emberpath',
      permissions,
      roles: ['SUPER_ADMIN'],
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(config.issuer)
      .setSubject('fake-user')
      .setAudience(audience)
      .setIssuedAt()
      .setJti('fake-jti')
      .setExpirationTime(lifetime)
      .sign(keys.privateKey);
  }
  async function verifier(response: Response) {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    const verify = createOathweaveVerifier(config, {
      keys: createLocalJWKSet({
        keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'test' }],
      }),
      fetch: request,
    });
    return { verify, request };
  }
  it('retains exact permissions without promoting identity roles', async () => {
    const { verify } = await verifier(
      Response.json({ sub: 'fake-user', name: 'Test User' }),
    );
    const result = await verify(await fixture());
    expect(result.permissions).toEqual(['router:providers:read']);
    expect(result.authenticatedAt).toBeUndefined();
  });
  it('rejects another resource before sending the bearer anywhere', async () => {
    const { verify, request } = await verifier(
      Response.json({ sub: 'fake-user' }),
    );
    await expect(verify(await fixture('hivemem'))).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects revoked sessions, identity mismatch and offline identity services', async () => {
    for (const response of [
      new Response('', { status: 401 }),
      Response.json({ sub: 'other-user' }),
      new Response('', { status: 503 }),
    ]) {
      const { verify } = await verifier(response);
      await expect(verify(await fixture())).rejects.toThrow();
    }
  });
  it('rejects multi-resource audiences and excessive token lifetimes before online validation', async () => {
    const { verify, request } = await verifier(
      Response.json({ sub: 'fake-user' }),
    );
    await expect(
      verify(await fixture(['emberpath', 'hivemem'])),
    ).rejects.toThrow();
    await expect(
      verify(await fixture('emberpath', [], '1h')),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('does not allow cleartext identity endpoints', () => {
    expect(() =>
      createOathweaveVerifier({
        ...config,
        jwksUrl: 'http://identity.example.com/jwks',
      }),
    ).toThrow();
  });
});
