import { HTTPException } from 'hono/http-exception';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client.js';
import { z } from 'zod';
import { prisma } from '../storage/client.js';
import { digestText } from '../security/crypto.js';
import { modelAliasSchema, routeRuleSchema, routingObjectiveSchema } from '../admin/schemas.js';
import { ROUTING_OBJECTIVE_SETTING_KEY, parseRoutingObjectiveConfig } from './objective.js';

export const routingPatchSchema = z.object({
  aliases: z.array(modelAliasSchema).max(500).optional(),
  rules: z.array(routeRuleSchema).max(500).optional(),
  objective: routingObjectiveSchema.optional(),
}).strict();
const prefix = 'routing.revision.';
export async function routingSnapshot(db: Pick<Prisma.TransactionClient, 'modelAlias' | 'routeRule' | 'runtimeSetting'> = prisma) {
  const [aliases, rules, objective] = await Promise.all([
    db.modelAlias.findMany({ orderBy: { alias: 'asc' } }),
    db.routeRule.findMany({ orderBy: { name: 'asc' } }),
    db.runtimeSetting.findUnique({ where: { key: ROUTING_OBJECTIVE_SETTING_KEY } }),
  ]);
  const config = { aliases: aliases.map(({ alias, providerId, upstreamModel, enabled, description }) => ({ alias, ...(providerId ? { providerId } : {}), upstreamModel, enabled, ...(description ? { description } : {}) })), rules: rules.map(({ name, kind, priority, enabled, matchJson, actionJson }) => ({ name, kind, priority, enabled, matchJson: JSON.parse(matchJson), actionJson: JSON.parse(actionJson) })), objective: parseRoutingObjectiveConfig(objective ? JSON.parse(objective.valueJson) : {}) };
  return { revision: digestText(JSON.stringify(config)), config };
}
export async function applyRoutingRevision(baseRevision: string, input: unknown, operator: string, database: Pick<typeof prisma, '$transaction'> = prisma) {
  const patch = routingPatchSchema.parse(input);
  return database.$transaction(async (tx) => {
    // Acquire SQLite's writer reservation before reading the compare-and-swap
    // snapshot. A deferred read transaction cannot safely upgrade after an
    // independent actor-journal connection commits a write.
    await tx.$executeRaw`INSERT INTO "RuntimeSetting" ("id", "key", "valueJson", "createdAt", "updatedAt")
      VALUES (${randomUUID()}, 'routing.write-lock', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT("key") DO UPDATE SET "valueJson" = excluded."valueJson"`;
    const current = await routingSnapshot(tx);
    if (current.revision !== baseRevision) throw new HTTPException(409, { message: 'Routing changed; refresh and preview again' });
    await tx.runtimeSetting.upsert({ where: { key: prefix + current.revision }, create: { key: prefix + current.revision, valueJson: JSON.stringify({ ...current, operator, recordedAt: new Date().toISOString() }) }, update: {} });
    if (patch.aliases) {
      for (const alias of patch.aliases) if (alias.providerId && !await tx.provider.findUnique({ where: { id: alias.providerId } })) throw new HTTPException(400, { message: 'Unknown provider in proposed alias' });
      await tx.modelAlias.deleteMany();
      for (const alias of patch.aliases) await tx.modelAlias.create({ data: { ...alias, providerId: alias.providerId ?? null, description: alias.description ?? null } });
    }
    if (patch.rules) {
      await tx.routeRule.deleteMany();
      for (const rule of patch.rules) await tx.routeRule.create({ data: { ...rule, matchJson: JSON.stringify(rule.matchJson), actionJson: JSON.stringify(rule.actionJson) } });
    }
    if (patch.objective) await tx.runtimeSetting.upsert({ where: { key: ROUTING_OBJECTIVE_SETTING_KEY }, create: { key: ROUTING_OBJECTIVE_SETTING_KEY, valueJson: JSON.stringify(patch.objective) }, update: { valueJson: JSON.stringify(patch.objective) } });
    return { previousRevision: current.revision };
  });
}
export async function routingHistory() { return (await prisma.runtimeSetting.findMany({ where: { key: { startsWith: prefix } }, orderBy: { updatedAt: 'desc' }, take: 50 })).map((row) => JSON.parse(row.valueJson) as unknown); }
export async function savedRoutingRevision(revision: string): Promise<unknown> {
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('Invalid revision');
  const record = await prisma.runtimeSetting.findUniqueOrThrow({ where: { key: prefix + revision } });
  return (JSON.parse(record.valueJson) as { config: unknown }).config;
}
