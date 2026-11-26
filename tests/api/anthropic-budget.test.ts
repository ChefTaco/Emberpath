// A hard-budget key that streams from an Anthropic provider and goes away early keeps its
// token reservation: a cut-short stream's usage is unknown, never a refund.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const directory = mkdtempSync(join(tmpdir(), 'emberpath-anthropic-budget-'));
vi.stubEnv('DATABASE_URL', 'file:' + join(directory, 'router.db'));
vi.stubEnv('HIVE_HOME', directory);
vi.stubEnv('DATA_DIR', directory);
vi.stubEnv('TRACE_DIR', join(directory, 'traces'));
vi.stubEnv('HIVE_ROUTER_SECRET', randomBytes(48).toString('hex'));

const { ensureSqliteSchema } = await import('../../src/storage/schema.js');
await ensureSqliteSchema();
const { prisma } = await import('../../src/storage/client.js');
const { bootstrapStorage } = await import('../../src/storage/bootstrap.js');
const { buildProviderCreateData } = await import('../../src/providers/runtime.js');
const { hashValue } = await import('../../src/security/crypto.js');
const { createApiApp } = await import('../../src/api/app.js');
const { ProviderKind } = await import('../../src/generated/prisma/client.js');
const { quotaLedger } = await import('../../src/security/quota.js');

const clientKey = 'ep-anthro-0000000000000000000000001';
let keyId = '';
const sse = (events: Array<[string, unknown]>) => events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const OPENING: Array<[string, unknown]> = [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }],
];

beforeAll(async () => {
  await bootstrapStorage();
  await prisma.provider.updateMany({ data: { enabled: false } });
  await prisma.provider.create({ data: buildProviderCreateData({ slug: 'claude', name: 'claude', kind: ProviderKind.ANTHROPIC, baseUrl: 'https://anthropic.example', maxRetries: 0, priority: 10 }) });
  keyId = (await prisma.clientApiKey.create({ data: { name: 'budget', keyPrefix: clientKey.slice(0, 8), keyHash: hashValue(clientKey), metadataJson: JSON.stringify({ quota: { dailyTokens: 1_000_000 } }) } })).id;
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== 'https://anthropic.example/v1/messages') return realFetch(input, init);
    let sent = false;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(sse(OPENING))); return undefined; }
        // Then nothing more: the client gives up.
        return new Promise<void>(() => undefined);
      },
    }, { highWaterMark: 0 }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.$disconnect();
  globalThis.__hiveRouterPrisma = undefined;
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('Anthropic streams under token budgets', () => {
  it('keep the reservation when the client disconnects before the final usage', async () => {
    const body = JSON.stringify({ model: 'claude-test', stream: true, max_tokens: 500, messages: [{ role: 'user', content: 'hello' }] });
    const response = await createApiApp().request('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' }, body });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    const reserved = Buffer.byteLength(body) + 500;
    await vi.waitFor(async () => {
      const trace = await prisma.trace.findFirstOrThrow({ orderBy: { startedAt: 'desc' } });
      expect(trace.outcome).toBe('STREAM_FAILED');
    });
    expect(quotaLedger().usage(keyId).dayTokens).toBe(reserved);
  });
});
