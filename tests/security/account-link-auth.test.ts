import { createAdminApp } from '../../src/admin/app.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppVariables } from '../../src/types/app.js';
const identity = vi.hoisted(() => ({
  issuer: 'https://identity.example.com',
  subject: 'fake-user',
  sessionId: 'fake-session',
  displayName: 'Synthetic person',
  roles: ['SUPER_ADMIN'],
  permissions: ['router:providers:read'],
}));
vi.mock('../../src/security/admin-identity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/security/admin-identity.js')>()),
  configuredOathweaveVerifier: () => async () => identity,
}));
import { requireAdminAuth } from '../../src/security/admin-auth.js';
import { prisma } from '../../src/storage/client.js';
const user = {
  id: 'existing-user',
  username: 'existing-operator',
  displayName: 'Existing operator',
  passwordHash: '!externally-managed',
  createdAt: new Date(),
  updatedAt: new Date(),
};
function app() {
  const result = new Hono<{ Variables: AppVariables }>();
  result.get('/api/test', requireAdminAuth, (c) =>
    c.json({
      id: c.get('adminUser')?.id,
      permissions: c.get('adminPermissions'),
    }),
  );
  return result;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  identity.permissions=['router:providers:read'];
});
describe('direct resource account binding', () => {
  it('never invokes retained cross-product proxies or installer coordinators with a resource credential',async()=>{
    identity.permissions=['*'];
    vi.stubEnv('EMBERPATH_OATHWEAVE_IDENTITIES_JSON',JSON.stringify([{issuer:identity.issuer,subject:identity.subject,localId:user.id}]));
    vi.spyOn(prisma.adminUser,'findUnique').mockResolvedValue(user);
    vi.spyOn(prisma.provider,'findMany').mockResolvedValue([]);
    const outbound=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Unexpected outbound request'));
    const app=createAdminApp();
    const headers={Authorization:'Bearer obviously-fake-fixture'};
    for(const path of ['/api/iam/users','/api/memory/dashboard-data','/api/hive/status','/api/hive/actors','/api/hive/upgrades/plan','/api/hive/skills','/api-docs/index','/api-docs/openapi.json','/api-docs/providers/synthetic']) {
      const response=await app.request(path,{method:path.endsWith('/plan')?'POST':'GET',headers});
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({error:'PRODUCT_API_REQUIRED'});
    }
    expect(outbound).not.toHaveBeenCalled();
    expect((await app.request('/api/providers',{headers})).status).toBe(200);
  });
  it('requires documentation permission and returns only documentation provider fields',async()=>{
    vi.stubEnv('EMBERPATH_OATHWEAVE_IDENTITIES_JSON',JSON.stringify([{issuer:identity.issuer,subject:identity.subject,localId:user.id}]));
    vi.spyOn(prisma.adminUser,'findUnique').mockResolvedValue(user);
    const summary={id:'synthetic-provider',slug:'synthetic',name:'Synthetic provider',kind:'OPENAI',baseUrl:'https://provider.example.com',enabled:true};
    const record={...summary,encryptedAuthSecret:'synthetic-ciphertext',defaultHeadersJson:'{"Authorization":"synthetic-provider-credential"}'};
    vi.spyOn(prisma.provider,'findMany').mockResolvedValue([record] as never);
    vi.spyOn(prisma.provider,'findUnique').mockResolvedValue(record as never);
    const app=createAdminApp();
    const headers={Authorization:'Bearer obviously-fake-fixture'};
    for(const path of ['/api/docs/index','/api/docs/providers/synthetic-provider','/api/docs/openapi.json']) {
      expect((await app.request(path,{headers})).status).toBe(403);
    }
    identity.permissions=['router:admin:read'];
    const index=await app.request('/api/docs/index',{headers});
    expect(index.status).toBe(200);
    expect((await index.json()).providers).toEqual([summary]);
    const detail=await app.request('/api/docs/providers/synthetic-provider',{headers});
    expect(detail.status).toBe(200);
    expect((await detail.json()).provider).toEqual(summary);
  });
  it('retains the explicitly linked product ID and exact permissions without writes', async () => {
    vi.stubEnv(
      'EMBERPATH_OATHWEAVE_IDENTITIES_JSON',
      JSON.stringify([
        {
          issuer: identity.issuer,
          subject: identity.subject,
          localId: user.id,
        },
      ]),
    );
    vi.spyOn(prisma.adminUser, 'findUnique').mockResolvedValue(user);
    const create = vi.spyOn(prisma.adminUser, 'upsert');
    const response = await app().request('/api/test', {
      headers: { Authorization: 'Bearer obviously-fake-fixture' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: user.id,
      permissions: ['router:providers:read'],
    });
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects unlinked and deleted accounts without falling back to legacy cookies', async () => {
    const lookup = vi
      .spyOn(prisma.adminUser, 'findUnique')
      .mockResolvedValue(null);
    vi.stubEnv('EMBERPATH_OATHWEAVE_IDENTITIES_JSON', '[]');
    const request = {
      headers: {
        Authorization: 'Bearer obviously-fake-fixture',
        Cookie: 'hive_router_admin=obviously-fake-cookie',
      },
    };
    expect((await app().request('/api/test', request)).status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
    vi.stubEnv(
      'EMBERPATH_OATHWEAVE_IDENTITIES_JSON',
      JSON.stringify([
        {
          issuer: identity.issuer,
          subject: identity.subject,
          localId: 'deleted-user',
        },
      ]),
    );
    expect((await app().request('/api/test', request)).status).toBe(401);
  });
});
