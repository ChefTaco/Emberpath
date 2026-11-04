import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
const temporary = mkdtempSync(join(tmpdir(), 'emberpath-bootstrap-'));
vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('DATABASE_URL', 'file:' + join(temporary, 'router.db'));
vi.stubEnv('HIVE_HOME', temporary);
vi.stubEnv('HIVE_ROUTER_SECRET', randomBytes(32).toString('hex'));
vi.stubEnv('HIVE_ROUTER_ADMIN_USERS', 'admin');
vi.stubEnv('EMBERPATH_INITIAL_ADMIN_IDENTITIES_JSON', JSON.stringify([{username:'admin',localId:'synthetic-stable-model-account'}]));
vi.stubEnv('OPENROUTER_API_KEY', 'obviously-fake-test-provider-key');
const { ensureSqliteSchema } = await import('../../src/storage/schema.js');
await ensureSqliteSchema();
const { prisma } = await import('../../src/storage/client.js');
const { bootstrapStorage } = await import('../../src/storage/bootstrap.js');
afterAll(async () => {
  await prisma.$disconnect();
  globalThis.__hiveRouterPrisma = undefined;
  vi.unstubAllEnvs();
  rmSync(temporary, { recursive: true, force: true });
});
it('repeated startup retains operator route edits, disabled models, credentials and display names', async () => {
  await bootstrapStorage();
  expect((await prisma.adminUser.findUniqueOrThrow({where:{username:'admin'}})).id).toBe('synthetic-stable-model-account');
  const rule = await prisma.routeRule.findFirstOrThrow();
  await prisma.routeRule.update({
    where: { id: rule.id },
    data: {
      priority: 999,
      enabled: false,
      actionJson: '{"model":"fixture-custom-alias"}',
    },
  });
  await prisma.adminUser.update({
    where: { username: 'admin' },
    data: { displayName: 'Example Operator' },
  });
  await prisma.provider.update({
    where: { slug: 'openrouter' },
    data: {
      baseUrl: 'https://provider.example.com/custom',
      encryptedAuthSecret: 'obviously-fake-retained-ciphertext',
    },
  });
  await prisma.providerModel.updateMany({
    data: { enabled: false, maxContextWindow: 1024 },
  });
  const before = {
    providers: await prisma.provider.findMany(),
    models: await prisma.providerModel.findMany(),
    routes: await prisma.routeRule.findMany(),
    aliases: await prisma.modelAlias.findMany(),
    users: await prisma.adminUser.findMany(),
  };
  await bootstrapStorage();
  const after = {
    providers: await prisma.provider.findMany(),
    models: await prisma.providerModel.findMany(),
    routes: await prisma.routeRule.findMany(),
    aliases: await prisma.modelAlias.findMany(),
    users: await prisma.adminUser.findMany(),
  };
  expect(after).toEqual(before);
});

it('documentation synchronization is idempotent for an unchanged generated contract', async () => {
  const { syncBuiltinApiDocs } = await import('../../src/storage/api-docs.js');
  await syncBuiltinApiDocs('https://models.example.com');
  const before = {
    docs: await prisma.apiDocEntry.findMany(),
    settings: await prisma.runtimeSetting.findMany(),
  };
  await syncBuiltinApiDocs('https://models.example.com');
  expect({
    docs: await prisma.apiDocEntry.findMany(),
    settings: await prisma.runtimeSetting.findMany(),
  }).toEqual(before);
});

it('refuses a changed initial identity instead of relinking the existing username', async () => {
  const retained = 'synthetic-retained-model-account';
  await prisma.adminUser.update({ where: { username: 'admin' }, data: { id: retained } });
  const before = await prisma.adminUser.findMany();
  await expect(bootstrapStorage()).rejects.toThrow(/conflicts with an existing identity/);
  expect(await prisma.adminUser.findMany()).toEqual(before);
});
