// Oathweave refuses writes made with the Router's own client token unless they carry the
// operator (x-hive-operator). Actor containment (disable) must send it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';

const seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders }> = [];
const server: Server = createServer((request, response) => {
  seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers });
  request.resume();
  request.on('end', () => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/v1/oauth/token') return response.end(JSON.stringify({ access_token: 'synthetic-proxy-token', expires_in: 300, token_type: 'Bearer' }));
    return response.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const directory = mkdtempSync(join(tmpdir(), 'emberpath-actor-operator-'));
const secret = randomBytes(48).toString('hex');
vi.stubEnv('DATABASE_URL', 'file:' + join(directory, 'router.db'));
vi.stubEnv('HIVE_HOME', directory);
vi.stubEnv('DATA_DIR', directory);
vi.stubEnv('TRACE_DIR', join(directory, 'traces'));
vi.stubEnv('HIVE_ROUTER_SECRET', secret);
vi.stubEnv('HIVE_IAM_INTERNAL_URL', baseUrl);
vi.stubEnv('HIVEMEM_INTERNAL_URL', baseUrl);
vi.stubEnv('HIVE_ROUTER_IAM_CLIENT_SECRET', 'synthetic-router-client-secret-0123456789');
vi.stubEnv('HIVE_ROUTER_MEMORY_PROXY_TOKEN', 'synthetic-memory-proxy-token');

const { ensureSqliteSchema } = await import('../../src/storage/schema.js');
await ensureSqliteSchema();
const { prisma } = await import('../../src/storage/client.js');
const { createAdminApp } = await import('../../src/admin/app.js');

let cookie = '';
let userId = '';
beforeAll(async () => {
  const user = await prisma.adminUser.create({ data: { username: 'admin', passwordHash: 'obviously-fake-password-hash' } });
  userId = user.id;
  await prisma.adminSession.create({ data: { sessionId: 'operator-session', userId, expiresAt: new Date(Date.now() + 600_000) } });
  cookie = 'hive_router_admin=' + await new SignJWT({ sid: 'operator-session', username: 'admin', roles: [], permissions: ['*'], authMode: 'os' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime('10m').sign(new TextEncoder().encode(secret));
  await prisma.actorEnrollment.create({ data: { actorId: 'agent-1', ownerId: userId, requestHash: 'synthetic', requestJson: '{}', iamId: 'sa-1', memoryId: 'agent-1', status: 'active' } });
});
afterAll(async () => {
  server.close();
  await prisma.$disconnect();
  globalThis.__hiveRouterPrisma = undefined;
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('actor lifecycle writes to Oathweave', () => {
  it('name the operator on the service-account disable', async () => {
    const app = createAdminApp();
    const response = await app.request('/api/hive/actors/agent-1/disable', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBeLessThan(500);
    const disable = seen.find((entry) => entry.method === 'PATCH' && entry.url === '/api/v1/service-accounts/sa-1');
    expect(disable, JSON.stringify(seen.map((entry) => `${entry.method} ${entry.url}`))).toBeDefined();
    expect(disable!.headers.authorization).toBe('Bearer synthetic-proxy-token');
    expect(JSON.parse(String(disable!.headers['x-hive-operator']))).toMatchObject({ id: userId, sessionId: 'operator-session', authMode: 'os' });
  });
});
