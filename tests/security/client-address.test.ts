import { describe, expect, it } from 'vitest';
import { isValidTrustedProxies, normalizeIpAddress, parseTrustedProxies, resolveClientAddress } from '../../src/security/client-address.js';

describe('security/client-address', () => {
  const loopback = parseTrustedProxies('loopback');

  it('uses the socket peer when it is not a trusted proxy, whatever the header says', async () => {
    expect(await resolveClientAddress('198.51.100.9', '203.0.113.5', loopback)).toBe('198.51.100.9');
    expect(await resolveClientAddress('198.51.100.9', undefined, loopback)).toBe('198.51.100.9');
  });

  it('reads X-Forwarded-For from the right behind a trusted proxy, ignoring what the caller wrote', async () => {
    expect(await resolveClientAddress('127.0.0.1', '203.0.113.5', loopback)).toBe('203.0.113.5');
    // The caller put a spoofed address first; the proxy appended the real one.
    expect(await resolveClientAddress('::ffff:127.0.0.1', '10.9.9.9, 203.0.113.5', loopback)).toBe('203.0.113.5');
    // Further trusted hops are skipped.
    const proxies = parseTrustedProxies('loopback, 10.0.0.0/8');
    expect(await resolveClientAddress('127.0.0.1', '192.0.2.7, 203.0.113.5, 10.1.2.3', proxies)).toBe('203.0.113.5');
    // A malformed hop stops the walk at the last vouched-for address.
    expect(await resolveClientAddress('127.0.0.1', 'not-an-ip, 10.1.2.3', proxies)).toBe('10.1.2.3');
  });

  it('trusts nobody with none, and resolves host names', async () => {
    expect(await resolveClientAddress('127.0.0.1', '203.0.113.5', parseTrustedProxies('none'))).toBe('127.0.0.1');
    const byName = parseTrustedProxies('ingress', async (host) => (host === 'ingress' ? ['172.20.0.4'] : []));
    expect(await resolveClientAddress('172.20.0.4', '203.0.113.5', byName)).toBe('203.0.113.5');
    expect(await resolveClientAddress('172.20.0.5', '203.0.113.5', byName)).toBe('172.20.0.5');
  });

  it('validates the setting', () => {
    for (const value of ['loopback', 'none', '10.0.0.0/8 ::1', 'ingress,192.0.2.1', '']) expect(isValidTrustedProxies(value), value).toBe(true);
    for (const value of ['10.0.0.0/33', '1.2.3', 'bad_host!', '::1/129']) expect(isValidTrustedProxies(value), value).toBe(false);
    expect(normalizeIpAddress(' ::ffff:192.0.2.1 ')).toBe('192.0.2.1');
  });
});
