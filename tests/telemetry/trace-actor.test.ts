import {afterAll, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';

const directory = mkdtempSync(join(tmpdir(), 'emberpath-trace-actor-'));
vi.stubEnv('DATABASE_URL', 'file:' + join(directory, 'fixture.db')); vi.stubEnv('HIVE_HOME', directory);
vi.stubEnv('DATA_DIR', directory); vi.stubEnv('TRACE_DIR', join(directory, 'traces'));
vi.stubEnv('HIVE_ROUTER_SECRET', randomBytes(48).toString('hex'));
const {ensureSqliteSchema} = await import('../../src/storage/schema.js'); await ensureSqliteSchema();
const {prisma} = await import('../../src/storage/client.js');
const {startTrace, traceActorIdFromKeyMetadata} = await import('../../src/telemetry/tracing.js');
afterAll(async () => {await prisma.$disconnect(); globalThis.__hiveRouterPrisma = undefined; vi.unstubAllEnvs(); rmSync(directory, {recursive: true, force: true});});

const decision = {candidateProviderIds: [], fallbackProviderIds: [], observations: [], triggeredRuleNames: [], confidence: 1};
let sequence = 0;
async function traceFor(metadata: unknown, spoof = true) {
  const key = await prisma.clientApiKey.create({data: {name: 'Synthetic key ' + ++sequence, keyPrefix: 'synth' + sequence, keyHash: 'synthetic-hash',
    metadataJson: metadata === undefined ? null : typeof metadata === 'string' ? metadata : JSON.stringify(metadata)}});
  const {traceId} = await startTrace({requestId: 'actor-request-' + sequence, method: 'POST', path: '/v1/responses', endpointKind: 'v1.responses', routeKey: 'fixture',
    // Attribution must never come from caller-controlled headers or bodies.
    requestHeaders: spoof ? {'x-actor-id': 'spoofed-agent', 'x-hive-actor-id': 'spoofed-agent', 'x-memory-agent-id': 'spoofed-agent'} : {},
    requestMeta: {contentType: 'application/json', model: 'fixture', routingTrait: undefined, stream: false, modalities: ['text']},
    decision, requestBody: JSON.stringify({actorId: 'spoofed-agent', metadata: {actorId: 'spoofed-agent'}}), clientApiKeyId: key.id});
  return (await prisma.trace.findUniqueOrThrow({where: {id: traceId}})).actorId;
}

describe('trace actor attribution', () => {
  it('reads actorId, then memoryAgentId, from key metadata and ignores invalid values', () => {
    expect(traceActorIdFromKeyMetadata('{"actorId":"build-agent","memoryAgentId":"other"}')).toBe('build-agent');
    expect(traceActorIdFromKeyMetadata('{"memoryAgentId":"memory_agent"}')).toBe('memory_agent');
    expect(traceActorIdFromKeyMetadata('{"actorId":null,"memoryAgentId":"memory_agent"}')).toBe('memory_agent');
    expect(traceActorIdFromKeyMetadata('{"actorId":"Bad Agent","memoryAgentId":"memory_agent"}')).toBeNull();
    for (const value of ['a', 'x'.repeat(33), 'UPPER', 'has space', 'dot.ted', 42, true, ['agent'], {id: 'agent'}])
      expect(traceActorIdFromKeyMetadata(JSON.stringify({actorId: value})), JSON.stringify(value)).toBeNull();
    for (const metadata of [null, undefined, '', 'not json', '[]', '"agent"', '{}', '{"owner":"agent"}'])
      expect(traceActorIdFromKeyMetadata(metadata)).toBeNull();
  });

  it('stores the authenticating key actorId at trace start and never a header or body value', async () => {
    expect(await traceFor({actorId: 'build-agent', memoryAgentId: 'memory-agent'})).toBe('build-agent');
    expect(await traceFor({memoryAgentId: 'memory-agent'})).toBe('memory-agent');
    expect(await traceFor({actorId: 'Not Valid!'})).toBeNull();
    expect(await traceFor({owner: 'synthetic-owner'})).toBeNull();
    expect(await traceFor(undefined)).toBeNull();
    expect(await traceFor('not json')).toBeNull();
    expect(await traceFor({actorId: 'quiet-agent'}, false)).toBe('quiet-agent');
  });

  it('leaves actorId null for unauthenticated traces even when headers claim an actor', async () => {
    const {traceId} = await startTrace({requestId: 'actor-request-anonymous', method: 'POST', path: '/v1/responses', endpointKind: 'v1.responses', routeKey: 'fixture',
      requestHeaders: {'x-actor-id': 'spoofed-agent'}, requestMeta: {contentType: undefined, model: undefined, routingTrait: undefined, stream: false, modalities: []}, decision});
    expect((await prisma.trace.findUniqueOrThrow({where: {id: traceId}})).actorId).toBeNull();
  });
});
