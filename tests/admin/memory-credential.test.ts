import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';

// Emberpath's console Memory routes against a stand-in Oathweave token endpoint and
// a stand-in HiveMem that, like the real one, refuses expired or revoked tokens.
const clientId = 'fake-emberpath-hivemem';
const clientSecret = 'fake-hivemem-client-secret-0123456789abcdef';
const jwt = (claims: Record<string, unknown>) =>
  [{ alg: 'none' }, claims].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.fake-signature';
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { n?: number; exp?: number; sub?: string };

let lifetimeSeconds = 300;
let oathweaveUp = true;
let issued = 0;
const revoked = new Set<number>();
const seen: string[] = [];
const servers: Server[] = [];

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
let cookie = '';
const staticToken = jwt({ sub: 'fake-router', role: 'admin', exp: Math.floor(Date.now() / 1000) - 60 });

beforeAll(async () => {
  const oathweave = await listen(createServer(async (request, response) => {
    const form = new URLSearchParams(await body(request));
    response.setHeader('content-type', 'application/json');
    if (!oathweaveUp) { response.statusCode = 503; response.end('{}'); return; }
    if (request.url !== '/api/v1/oauth/token' || form.get('grant_type') !== 'client_credentials' || form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret || form.get('scope') !== 'hivemem:admin:all') {
      response.statusCode = 401; response.end(JSON.stringify({ error: 'invalid_client' })); return;
    }
    issued += 1;
    response.end(JSON.stringify({ access_token: jwt({ n: issued, sub: clientId, aud: 'hivemem', exp: Math.floor(Date.now() / 1000) + lifetimeSeconds }), token_type: 'Bearer', expires_in: lifetimeSeconds }));
  }));
  const hivemem = await listen(createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    const token = String(request.headers.authorization ?? '').replace(/^Bearer /u, '');
    seen.push(token);
    const claims = (() => { try { return claimsOf(token); } catch { return {}; } })();
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now() || (claims.n !== undefined && revoked.has(claims.n))) {
      response.statusCode = 401; response.end(JSON.stringify({ error: 'JWT has expired' })); return;
    }
    response.end(JSON.stringify({ jobs: [], served: claims.n ?? 'static' }));
  }));
  Object.assign(process.env, {
    HIVEMEM_INTERNAL_URL: hivemem,
    HIVE_IAM_INTERNAL_URL: oathweave,
    EMBERPATH_HIVEMEM_CLIENT_ID: clientId,
    EMBERPATH_HIVEMEM_CLIENT_SECRET: clientSecret,
    HIVE_ROUTER_MEMORY_PROXY_TOKEN: staticToken,
  });
  vi.resetModules();
  const { createAdminApp } = await import('../../src/admin/app.js');
  const { prisma } = await import('../../src/storage/client.js');
  vi.spyOn(prisma.adminSession, 'findFirst').mockResolvedValue({
    id: 'row-1', sessionId: 'session-1', userId: 'user-1', createdAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000), revokedAt: null, ipAddress: null, userAgent: null,
    user: { id: 'user-1', username: 'operator', displayName: 'Operator', passwordHash: '!externally-managed', createdAt: new Date(), updatedAt: new Date() },
  } as never);
  app = createAdminApp();
  const session = await new SignJWT({ sid: 'session-1', username: 'operator', roles: [], permissions: ['memory:read', 'memory:write'], authMode: 'iam-oidc' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject('user-1').setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.HIVE_ROUTER_SECRET));
  cookie = `hive_router_admin=${session}`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  for (const name of ['HIVEMEM_INTERNAL_URL', 'HIVE_IAM_INTERNAL_URL', 'EMBERPATH_HIVEMEM_CLIENT_ID', 'EMBERPATH_HIVEMEM_CLIENT_SECRET', 'HIVE_ROUTER_MEMORY_PROXY_TOKEN']) delete process.env[name];
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const queue = async () => {
  const response = await app.request('/api/memory/queue', { headers: { cookie } });
  return { status: response.status, body: await response.json() as { served?: number | string; error?: string } };
};

describe('console Memory routes with the self-renewing HiveMem credential', () => {
  it('work after the static token has expired, using an Oathweave service token', async () => {
    expect(claimsOf(staticToken).exp! * 1000).toBeLessThan(Date.now());
    const first = await queue();
    expect(first).toMatchObject({ status: 200, body: { served: 1 } });
    expect(await queue()).toMatchObject({ status: 200, body: { served: 1 } });
    expect(issued).toBe(1);
    expect(seen).not.toContain(staticToken);
  });

  it('fetch the next token on their own, and retry once with a new token when HiveMem refuses the current one', async () => {
    await pause(5_100); // past the window in which a refused token counts as misconfiguration
    lifetimeSeconds = 6;
    revoked.add(1);
    expect(await queue()).toMatchObject({ status: 200, body: { served: 2 } });
    await pause(1_500); // token 2 is now within its expiry margin
    expect(await queue()).toMatchObject({ status: 200, body: { served: 3 } });
    lifetimeSeconds = 300;
    await pause(1_500);
    expect(await queue()).toMatchObject({ status: 200, body: { served: 4 } });
  }, 15_000);

  it('back off instead of fetching per request when a fresh token is refused, then recover', async () => {
    await pause(5_100);
    const current = Number((await queue()).body.served);
    revoked.add(current);
    expect(await queue()).toMatchObject({ status: 200, body: { served: current + 1 } });
    revoked.add(current + 1); // refused right after issue
    const refused = await queue();
    expect(refused.status).toBe(503);
    expect(refused.body.error).toMatch(/unavailable/u);
    const fetched = issued;
    expect((await queue()).status).toBe(503);
    expect(issued).toBe(fetched);
    await pause(5_100);
    expect(await queue()).toMatchObject({ status: 200, body: { served: current + 2 } });
  }, 20_000);

  it('ride out an Oathweave outage on the current token and recover without intervention', async () => {
    oathweaveUp = false;
    const current = Number((await queue()).body.served);
    await pause(5_100);
    expect(await queue()).toMatchObject({ status: 200, body: { served: current } });
    revoked.add(current);
    const down = await queue();
    expect(down.status).toBe(503);
    expect(down.body.error).toMatch(/unavailable/u);
    oathweaveUp = true;
    await pause(5_100);
    expect(await queue()).toMatchObject({ status: 200, body: { served: current + 1 } });
  }, 20_000);
});
