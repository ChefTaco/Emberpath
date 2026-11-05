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
    expect(database.prepare('SELECT expiresAt FROM ClientApiKey').get()).toEqual({ expiresAt: Date.parse(input.expiresAt) });
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
