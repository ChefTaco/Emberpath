import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { verifyHash } from '../../src/security/crypto.js';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { ActorCredentials } from '../../src/admin/actor-credentials.js';
import { schemaStatements } from '../../src/storage/generated-sqlite-schema.js';
const input = { action: 'enroll', actorId: 'fixture-agent', displayName: 'Fixture Agent', expiresAt: new Date(Date.now() + 3600_000).toISOString(), workspaceId: 'default' };
function open() { const database = new Database(':memory:'); for (const statement of schemaStatements) database.exec(statement); return database; }
it('atomically returns the exact encrypted native key receipt across retries and rejects another owner or policy', () => {
  const database = open(); try {
    const credentials = new ActorCredentials(database), id = 'a'.repeat(64), first = credentials.apply('operator', id, input);
    expect(credentials.apply('operator', id, input)).toEqual(first);
    expect(database.prepare('SELECT count(*) AS n FROM ClientApiKey').get()).toEqual({ n: 1 });
    expect(JSON.stringify(database.prepare('SELECT * FROM ActorLifecycleOperation').all())).not.toContain(first.apiKey);
    expect(() => credentials.apply('other', id, input)).toThrow(/another/);
    expect(() => credentials.apply('operator', id, { ...input, displayName: 'Changed' })).toThrow(/another/);
    credentials.acknowledge('operator', id); expect(() => credentials.apply('operator', id, input)).toThrow(/expired or acknowledged/);
  } finally { database.close(); }
});
it('does not extend a key lifetime during rotation; containment clears every superseded receipt', () => {
  const database = open(); try {
    const credentials = new ActorCredentials(database), original = credentials.apply('operator', 'a'.repeat(64), input);
    const rotation = { ...input, action: 'rotate', resourceId: original.resourceId, expiresAt: new Date(Date.now() + 7200_000).toISOString() };
    const rotated = credentials.apply('operator', 'b'.repeat(64), rotation);
    expect(rotated.apiKey).not.toBe(original.apiKey);
    expect(database.prepare('SELECT expiresAt FROM ClientApiKey').get()).toEqual({ expiresAt: input.expiresAt.replace('Z', '+00:00') });
    expect(() => credentials.apply('operator', 'a'.repeat(64), input)).toThrow(/expired or acknowledged/);
    credentials.apply('operator', 'c'.repeat(64), { ...rotation, action: 'disable' });
    expect(database.prepare('SELECT enabled FROM ClientApiKey').get()).toEqual({ enabled: 0 });
    expect(() => credentials.apply('operator', 'b'.repeat(64), rotation)).toThrow(/expired or acknowledged/);
    expect(() => credentials.apply('operator', 'd'.repeat(64), rotation)).toThrow(/Disabled/);
  } finally { database.close(); }
});
it('rolls back credential writes if receipt storage fails', () => {
  const database = open(); try {
    const credentials = new ActorCredentials(database, { encrypt() { throw new Error('fixture write failure'); }, decrypt: value => value });
    expect(() => credentials.apply('operator', 'a'.repeat(64), input)).toThrow('fixture write failure');
    expect(database.prepare('SELECT count(*) AS n FROM ClientApiKey').get()).toEqual({ n: 0 });
  } finally { database.close(); }
});

it('makes atomic native keys usable through real Prisma expiry queries and rejects expired or disabled generations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'emberpath-credential-'));
  const path = join(directory, 'fixture.db'), database = new Database(path);
  for (const statement of schemaStatements) database.exec(statement);
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: 'file:' + path }) });
  let now = Date.now();
  try {
    const credentials = new ActorCredentials(database, undefined, () => now);
    const first = credentials.apply('operator', 'a'.repeat(64), input);
    const candidates = () => prisma.clientApiKey.findMany({ where: { enabled: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(now) } }], keyPrefix: String(first.apiKey).slice(0, 8) } });
    const rows = await candidates();
    expect(rows).toHaveLength(1);
    expect(verifyHash(String(first.apiKey), rows[0]!.keyHash)).toBe(true);
    expect(rows[0]!.expiresAt!.toISOString()).toBe(input.expiresAt);
    expect(rows[0]!.createdAt.getTime()).toBe(now);
    now = Date.parse(input.expiresAt) + 1;
    expect(await candidates()).toEqual([]);
    expect(() => credentials.apply('operator', 'b'.repeat(64), { ...input, action: 'rotate', resourceId: first.resourceId, expiresAt: new Date(now + 3600_000).toISOString() })).toThrow(/expired/);
    credentials.apply('operator', 'c'.repeat(64), { ...input, action: 'disable', resourceId: first.resourceId });
    expect((await prisma.clientApiKey.findUniqueOrThrow({ where: { id: String(first.resourceId) } })).enabled).toBe(false);
  } finally { await prisma.$disconnect(); database.close(); rmSync(directory, { recursive: true }); }
});
