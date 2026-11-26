import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOathweaveServiceToken,
  oathweaveTokenUrl,
  oathweaveTokenUrlProblem,
  type OathweaveTokenEvent,
} from '../../src/security/oathweave-service-token.js';

const client = { clientId: 'fake-emberpath-hivemem', clientSecret: 'fake-hivemem-client-secret-0123456789abcdef', scope: 'hivemem:admin:all' };
const tlsEnv = (caPath?: string, allowInsecure = false) => ({ NODE_ENV: 'test' as const, HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS: allowInsecure, HIVE_ROUTER_IAM_CA_CERT_PATH: caPath });

describe('Oathweave token URLs', () => {
  it('accept HTTPS anywhere and plain HTTP only on loopback', () => {
    for (const url of ['https://oathweave:4200/api/v1/oauth/token', 'https://id.example.com/api/v1/oauth/token', 'http://127.0.0.1:4200/api/v1/oauth/token', 'http://localhost:4200/api/v1/oauth/token', 'http://[::1]:4200/api/v1/oauth/token']) {
      expect(oathweaveTokenUrlProblem(url), url).toBeUndefined();
    }
    for (const url of ['http://oathweave:4200/api/v1/oauth/token', 'http://192.0.2.10:4200/api/v1/oauth/token', 'http://10.0.0.5/api/v1/oauth/token']) {
      expect(oathweaveTokenUrlProblem(url), url).toMatch(/must use HTTPS \(plain HTTP is allowed only for a loopback address/u);
    }
    expect(oathweaveTokenUrlProblem('ftp://oathweave/token')).toMatch(/must use HTTPS/u);
    expect(oathweaveTokenUrlProblem('https://user:pass@oathweave:4200/api/v1/oauth/token')).toMatch(/credentials/u);
    expect(oathweaveTokenUrlProblem('not a url')).toMatch(/valid URL/u);
  });

  it('derive the token endpoint from an Oathweave base URL', () => {
    expect(oathweaveTokenUrl('https://oathweave:4200')).toBe('https://oathweave:4200/api/v1/oauth/token');
    expect(oathweaveTokenUrl('https://hive.example.com/api/oathweave/')).toBe('https://hive.example.com/api/oathweave/api/v1/oauth/token');
  });

  it('refuse to build a client that would send its secret over plain HTTP off loopback', () => {
    const build = (tokenUrl: string) => createOathweaveServiceToken({ tokenUrl, ...client, env: tlsEnv() });
    expect(() => build('http://oathweave:4200/api/v1/oauth/token')).toThrow(/must use HTTPS/u);
    expect(() => build('http://127.0.0.1:4200/api/v1/oauth/token')).not.toThrow();
    expect(() => build('https://oathweave:4200/api/v1/oauth/token')).not.toThrow();
  });
});

describe('Oathweave token requests with a pinned CA', () => {
  let directory = '';
  let server: Server;
  let tokenUrl = '';
  let serverCa = '';
  let otherCa = '';
  let requests = 0;

  function certificate(name: string): { cert: string; key: string } {
    const cert = join(directory, `${name}.crt`);
    const key = join(directory, `${name}.key`);
    const config = join(directory, `${name}.cnf`);
    writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\n');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-config', config], { stdio: 'ignore' });
    return { cert, key };
  }

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'emberpath-oathweave-ca-'));
    const served = certificate('oathweave');
    serverCa = served.cert;
    otherCa = certificate('other').cert;
    server = createServer({ cert: readFileSync(served.cert), key: readFileSync(served.key) }, (request, response) => {
      requests += 1;
      request.resume();
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ access_token: `fake-access-token-${requests}`, token_type: 'Bearer', expires_in: 300 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    tokenUrl = `https://localhost:${(server.address() as AddressInfo).port}/api/v1/oauth/token`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });

  const fetchWith = async (env: ReturnType<typeof tlsEnv>) => {
    const events: OathweaveTokenEvent[] = [];
    const tokens = createOathweaveServiceToken({ tokenUrl, ...client, env, onEvent: (event) => events.push(event) });
    return { token: await tokens.token(), events };
  };

  it('trusts the certificate signed by HIVE_ROUTER_IAM_CA_CERT_PATH', async () => {
    const before = requests;
    const { token, events } = await fetchWith(tlsEnv(serverCa));
    expect(token).toMatch(/^fake-access-token-\d+$/u);
    expect(requests).toBe(before + 1);
    expect(events).toEqual([{ type: 'refreshed', expiresAt: null }]);
  });

  it('refuses the endpoint when the pinned CA did not sign its certificate', async () => {
    const before = requests;
    const { token, events } = await fetchWith(tlsEnv(otherCa));
    expect(token).toBeNull();
    expect(events).toEqual([{ type: 'refresh-failed', reason: 'network' }]);
    expect(requests).toBe(before);
  });

  it('uses the system trust store when no CA is pinned, which does not know a private CA', async () => {
    const { token, events } = await fetchWith(tlsEnv());
    expect(token).toBeNull();
    expect(events).toEqual([{ type: 'refresh-failed', reason: 'network' }]);
  });

  it('reports the retired insecure-TLS switch as a failed request instead of disabling verification', async () => {
    const { token, events } = await fetchWith(tlsEnv(undefined, true));
    expect(token).toBeNull();
    expect(events).toEqual([{ type: 'refresh-failed', reason: 'network' }]);
  });
});
