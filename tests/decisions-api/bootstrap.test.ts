// Serving /v1/decisions with the shadow decision keys is opt-in, and the
// `decision` alias is seeded on fresh installs only.
import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const directory = mkdtempSync(join(tmpdir(), 'emberpath-decisions-bootstrap-'));
vi.stubEnv('DATABASE_URL', 'file:' + join(directory, 'router.db'));
vi.stubEnv('HIVE_HOME', directory);
vi.stubEnv('DATA_DIR', directory);
vi.stubEnv('TRACE_DIR', join(directory, 'traces'));
vi.stubEnv('HIVE_ROUTER_SECRET', randomBytes(48).toString('hex'));
// Shadow keys are present, but EMBERPATH_DECISIONS_JEV_ENABLED is not set.
vi.stubEnv('HIVE_TYPESAFE_AI_KEY', 'synthetic-typesafe-key');
vi.stubEnv('HIVE_ROUTER_OPENROUTER_KEY', 'synthetic-openrouter-key');

const { ensureSqliteSchema } = await import('../../src/storage/schema.js');
await ensureSqliteSchema();
const { prisma } = await import('../../src/storage/client.js');
const { bootstrapStorage } = await import('../../src/storage/bootstrap.js');
const { loadEnv } = await import('../../src/config/env.js');
afterAll(async () => {
  await prisma.$disconnect();
  globalThis.__hiveRouterPrisma = undefined;
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it('does not serve /v1/decisions with the shadow keys unless opted in', async () => {
  expect(loadEnv()).toMatchObject({ EMBERPATH_DECISIONS_JEV_ENABLED: false, HIVE_ROUTER_DECISION_MODE: 'shadow', HIVE_ROUTER_DECISION_MODEL: '~typesafe/jev-latest', HIVE_TYPESAFE_AI_MODEL: 'jev-latest' });
  await bootstrapStorage();
  expect(await prisma.provider.findMany({ where: { slug: { in: ['typesafe-jev', 'openrouter-jev'] } } })).toEqual([]);
});

it('seeds the decision alias on a fresh install only and never re-creates it', async () => {
  expect(await prisma.modelAlias.findUnique({ where: { alias: 'decision' } })).not.toBeNull();
  await prisma.modelAlias.delete({ where: { alias: 'decision' } });
  await prisma.routeRule.delete({ where: { name: 'route-decision-alias' } });
  await bootstrapStorage();
  expect(await prisma.modelAlias.findUnique({ where: { alias: 'decision' } })).toBeNull();
  expect(await prisma.routeRule.findUnique({ where: { name: 'route-decision-alias' } })).toBeNull();
  // The shadow profile aliases keep their existing behaviour.
  expect(await prisma.modelAlias.findUnique({ where: { alias: 'standard' } })).not.toBeNull();
});

it('seeds alias and rules that round-trip through a routing revision patch', async () => {
  const { DECISIONS_API_ALIASES, DECISIONS_API_RULES } = await import('../../src/routing/defaults.js');
  const { routingPatchSchema } = await import('../../src/contracts/model-admin.js');
  const patch = routingPatchSchema.parse({
    aliases: DECISIONS_API_ALIASES.map((alias) => ({ ...alias, enabled: true })),
    rules: DECISIONS_API_RULES.map((rule) => ({ name: rule.name, kind: rule.kind, priority: rule.priority, enabled: true, matchJson: JSON.parse(rule.matchJson), actionJson: JSON.parse(rule.actionJson) })),
  });
  expect(patch.rules!.map((rule) => rule.matchJson.endpointKinds)).toEqual([['v1.decisions'], ['v1.chat.completions', 'v1.responses', 'v1.completions']]);
});
