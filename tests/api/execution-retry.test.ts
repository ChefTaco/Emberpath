// Gateway retry/backoff (EMBERPATH-02) and execution-linked traces (EMBERPATH-01), driven
// through the real API and admin apps on a SQLite fixture with upstreams mocked at fetch.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import { encodeExecutionHeader, type ExecutionContext } from '@hivemagnus/hive-common/execution';
import { sleepAbortable } from '@hivemagnus/hive-common/retry';

const directory = mkdtempSync(join(tmpdir(), 'emberpath-execution-retry-'));
vi.stubEnv('DATABASE_URL', 'file:' + join(directory, 'router.db'));
vi.stubEnv('HIVE_HOME', directory);
vi.stubEnv('DATA_DIR', directory);
vi.stubEnv('TRACE_DIR', join(directory, 'traces'));
vi.stubEnv('HIVE_ROUTER_SECRET', randomBytes(48).toString('hex'));
vi.stubEnv('HIVE_ROUTER_ADMIN_USERS', 'admin');

const { ensureSqliteSchema } = await import('../../src/storage/schema.js');
await ensureSqliteSchema();
const { prisma } = await import('../../src/storage/client.js');
const { bootstrapStorage } = await import('../../src/storage/bootstrap.js');
const { buildProviderCreateData } = await import('../../src/providers/runtime.js');
const { hashValue } = await import('../../src/security/crypto.js');
const { createApiApp } = await import('../../src/api/app.js');
const { createAdminApp } = await import('../../src/admin/app.js');
const { ProviderKind } = await import('../../src/generated/prisma/client.js');
const { resetProviderCircuit } = await import('../../src/api/provider-guards.js');
const { retryTiming } = await import('../../src/api/retry-budget.js');
const { deriveTraceAttempts } = await import('../../src/telemetry/trace-attempts.js');
const contracts = await import('../../src/contracts/model-admin.js');

const PRIMARY = 'https://primary.example/v1/chat/completions';
const SECONDARY = 'https://secondary.example/v1/chat/completions';
const clientKey = 'ep-retry-000000000000000000000000001';
const actorKey = 'ep-retry-actor-0000000000000000000001';

type Upstream = (init: RequestInit) => Response | Promise<Response>;
const upstreams = new Map<string, Upstream>();
const calls: string[] = [];
const sleeps: number[] = [];
const providerIds: Record<'primary' | 'secondary', string> = { primary: '', secondary: '' };
const realTiming = { ...retryTiming };

const api = createApiApp();
const admin = createAdminApp();
let cookie = '';

const chat = (options: { payload?: Record<string, unknown>; headers?: Record<string, string>; signal?: AbortSignal; key?: string } = {}) => api.request('/v1/chat/completions', {
  method: 'POST',
  headers: { authorization: `Bearer ${options.key ?? clientKey}`, 'content-type': 'application/json', ...options.headers },
  body: JSON.stringify({ model: 'synthetic-model', messages: [{ role: 'user', content: 'hello' }], ...options.payload }),
  ...(options.signal ? { signal: options.signal } : {}),
});
const completion = (text: string) => Response.json({ id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
const unavailable = (headers: Record<string, string> = {}) => new Response('{"error":"overloaded"}', { status: 503, headers: { 'content-type': 'application/json', ...headers } });
const execution = (context: Partial<ExecutionContext> & { root: string }) => encodeExecutionHeader({ v: 1, ...context })!;
const latestTrace = () => prisma.trace.findFirstOrThrow({ orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], include: { events: { orderBy: { occurredAt: 'asc' } } } });
const eventData = (dataJson: string | null) => JSON.parse(dataJson ?? '{}') as Record<string, unknown>;
const setRetries = (name: 'primary' | 'secondary', maxRetries: number) => prisma.provider.update({ where: { id: providerIds[name] }, data: { maxRetries } });

beforeAll(async () => {
  await bootstrapStorage();
  await prisma.provider.updateMany({ data: { enabled: false } });
  for (const [name, priority] of [['primary', 10], ['secondary', 20]] as const) {
    const provider = await prisma.provider.create({ data: buildProviderCreateData({
      slug: name, name, kind: ProviderKind.OPENAI_GENERIC, baseUrl: `https://${name}.example/v1`, maxRetries: 0, priority,
    }) });
    providerIds[name] = provider.id;
  }
  await prisma.clientApiKey.create({ data: { name: 'retry', keyPrefix: clientKey.slice(0, 8), keyHash: hashValue(clientKey), metadataJson: '{}' } });
  await prisma.clientApiKey.create({ data: { name: 'agent-a', keyPrefix: actorKey.slice(0, 8), keyHash: hashValue(actorKey), metadataJson: '{"actorId":"agent-a"}' } });
  const user = await prisma.adminUser.upsert({ where: { username: 'admin' }, update: {}, create: { username: 'admin', passwordHash: 'obviously-fake-password-hash' } });
  await prisma.adminSession.create({ data: { sessionId: 'fixture', userId: user.id, expiresAt: new Date(Date.now() + 600000) } });
  cookie = 'hive_router_admin=' + await new SignJWT({ sid: 'fixture', username: 'admin', roles: [], permissions: ['router:admin:read'], authMode: 'iam-oidc' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuedAt().setExpirationTime('10m').sign(new TextEncoder().encode(process.env.HIVE_ROUTER_SECRET));
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const handler = upstreams.get(url);
    if (!handler) return realFetch(input, init);
    calls.push(url);
    return handler(init);
  });
  // Deterministic jitter: full jitter with random 0.2 waits 20% of the exponential step.
  retryTiming.random = () => 0.2;
  retryTiming.sleep = (ms, signal) => { sleeps.push(ms); return sleepAbortable(ms, signal); };
});
afterEach(async () => {
  upstreams.clear();
  calls.length = 0;
  sleeps.length = 0;
  for (const id of Object.values(providerIds)) resetProviderCircuit(id);
  await prisma.provider.updateMany({ where: { id: { in: Object.values(providerIds) } }, data: { maxRetries: 0 } });
});
afterAll(async () => {
  Object.assign(retryTiming, realTiming);
  vi.unstubAllGlobals();
  await prisma.$disconnect();
  globalThis.__hiveRouterPrisma = undefined;
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('same-provider backoff', () => {
  it('waits a jittered backoff between 503 retries and succeeds on the fourth attempt', async () => {
    await setRetries('primary', 3);
    let count = 0;
    upstreams.set(PRIMARY, () => (++count <= 3 ? unavailable() : completion('fourth time lucky')));

    const started = Date.now();
    const response = await chat({ headers: { 'idempotency-key': 'retry-1' } });
    const elapsed = Date.now() - started;

    expect(response.status).toBe(200);
    expect(response.headers.get('x-hive-retry')).toBe('none');
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: 'fourth time lucky' } }] });
    expect(calls).toEqual([PRIMARY, PRIMARY, PRIMARY, PRIMARY]);
    // baseMs 250 doubling, full jitter at 0.2: 50, 100, 200 (each at or above the jitter floor of 0).
    expect(sleeps).toEqual([50, 100, 200]);
    expect(elapsed).toBeGreaterThanOrEqual(350);

    const trace = await latestTrace();
    const failovers = trace.events.filter((event) => event.type === 'provider.failover').map((event) => eventData(event.dataJson));
    expect(failovers).toEqual([1, 2, 3].map((attempt, index) => ({
      providerId: providerIds.primary, attempt, outcome: 'http_error', failover: false, status: 503, delayMs: sleeps[index],
    })));
    const attempts = deriveTraceAttempts(trace, trace.events);
    expect(attempts).toHaveLength(4);
    expect(attempts.at(-1)).toEqual({ providerId: providerIds.primary, attempt: 4, status: 200, failover: false, outcome: 'succeeded' });
  });

  it('accepts the legacy x-idempotency-key and never retries a POST without one', async () => {
    await setRetries('primary', 1);
    upstreams.set(PRIMARY, () => unavailable());
    upstreams.set(SECONDARY, () => completion('from secondary'));

    expect((await chat({ headers: { 'x-idempotency-key': 'legacy' } })).status).toBe(200);
    expect(calls).toEqual([PRIMARY, PRIMARY, SECONDARY]);

    calls.length = 0;
    resetProviderCircuit(providerIds.primary);
    expect((await chat()).status).toBe(200);
    expect(calls).toEqual([PRIMARY, SECONDARY]);
  });

  it('moves to the next provider immediately when Retry-After exceeds the cap', async () => {
    await setRetries('primary', 3);
    upstreams.set(PRIMARY, () => unavailable({ 'retry-after': '30' }));
    upstreams.set(SECONDARY, () => completion('from secondary'));

    const response = await chat({ headers: { 'idempotency-key': 'retry-after' } });

    expect(response.status).toBe(200);
    expect(calls).toEqual([PRIMARY, SECONDARY]);
    expect(sleeps).toEqual([]);
    const trace = await latestTrace();
    const failover = trace.events.find((event) => event.type === 'provider.failover')!;
    expect(eventData(failover.dataJson)).toEqual({ providerId: providerIds.primary, attempt: 1, outcome: 'http_error', failover: true, status: 503, retryAfterMs: 30_000 });
    expect(deriveTraceAttempts(trace, trace.events).map((attempt) => [attempt.providerId, attempt.outcome])).toEqual([
      [providerIds.primary, 'http_error'], [providerIds.secondary, 'succeeded'],
    ]);
  });

  it('honours a short Retry-After as the minimum wait', async () => {
    await setRetries('primary', 1);
    let count = 0;
    upstreams.set(PRIMARY, () => (++count === 1 ? unavailable({ 'retry-after': '1' }) : completion('after waiting')));

    const response = await chat({ headers: { 'idempotency-key': 'short-wait' } });

    expect(response.status).toBe(200);
    expect(sleeps).toEqual([1000]);
  });

  it('fails over instead of waiting when the backoff would cross the execution deadline', async () => {
    await setRetries('primary', 3);
    retryTiming.random = () => 1; // a 250 ms wait, which would end after the 200 ms deadline
    try {
      upstreams.set(PRIMARY, () => unavailable());
      upstreams.set(SECONDARY, () => completion('from secondary'));

      const response = await chat({ headers: {
        'idempotency-key': 'deadline',
        'x-hive-execution': execution({ root: 'hx1:studio:lab:request:deadline', deadline_ms: Date.now() + 200 }),
      } });

      expect(response.status).toBe(200);
      expect(calls).toEqual([PRIMARY, SECONDARY]);
      expect(sleeps).toEqual([]);
    } finally {
      retryTiming.random = () => 0.2;
    }
  });

  it('starts no retry or failover once the execution deadline has passed', async () => {
    await setRetries('primary', 3);
    upstreams.set(PRIMARY, () => unavailable());
    upstreams.set(SECONDARY, () => completion('from secondary'));

    const response = await chat({ headers: {
      'idempotency-key': 'expired',
      'x-hive-execution': execution({ root: 'hx1:studio:lab:request:expired', deadline_ms: Date.now() - 1000 }),
    } });

    expect(response.status).toBe(503);
    expect(response.headers.get('x-hive-retry')).toBe('none');
    expect(calls).toEqual([PRIMARY]);
  });
});

describe('x-hive-retry', () => {
  it('is exhausted when every provider failed after a failover', async () => {
    upstreams.set(PRIMARY, () => unavailable());
    upstreams.set(SECONDARY, () => new Response('slow down', { status: 429 }));

    const response = await chat();

    expect(response.status).toBe(429);
    expect(response.headers.get('x-hive-retry')).toBe('exhausted');
    expect(calls).toEqual([PRIMARY, SECONDARY]);
  });

  it('is none when the only attempt failed, so the caller may retry', async () => {
    await prisma.provider.update({ where: { id: providerIds.secondary }, data: { enabled: false } });
    try {
      upstreams.set(PRIMARY, () => unavailable());
      const response = await chat();
      expect(response.status).toBe(503);
      expect(response.headers.get('x-hive-retry')).toBe('none');
    } finally {
      await prisma.provider.update({ where: { id: providerIds.secondary }, data: { enabled: true } });
    }
  });

  it('is none on early answers such as authentication failures', async () => {
    const response = await api.request('/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
    expect(response.headers.get('x-hive-retry')).toBe('none');
  });

  it('is exhausted when the upstream itself reports exhausted, and that provider is not retried', async () => {
    await setRetries('primary', 3);
    await prisma.provider.update({ where: { id: providerIds.secondary }, data: { enabled: false } });
    try {
      upstreams.set(PRIMARY, () => unavailable({ 'x-hive-retry': 'exhausted' }));
      const response = await chat({ headers: { 'idempotency-key': 'nested' } });
      expect(response.status).toBe(503);
      expect(response.headers.get('x-hive-retry')).toBe('exhausted');
      expect(calls).toEqual([PRIMARY]);
    } finally {
      await prisma.provider.update({ where: { id: providerIds.secondary }, data: { enabled: true } });
    }
  });
});

describe('cancellation and streams', () => {
  it('stops every further upstream call when the client disconnects during backoff', async () => {
    await setRetries('primary', 3);
    retryTiming.random = () => 1; // 250 ms first wait: ample time to abort inside it.
    try {
      upstreams.set(PRIMARY, () => unavailable());
      upstreams.set(SECONDARY, () => completion('from secondary'));
      const controller = new AbortController();
      const pending = chat({ headers: { 'idempotency-key': 'abort' }, signal: controller.signal });
      await vi.waitFor(() => expect(sleeps).toHaveLength(1));
      controller.abort();
      const response = await pending;

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Client disconnected before a provider responded' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(calls).toEqual([PRIMARY]);
      const trace = await latestTrace();
      expect(trace.events.map((event) => event.type)).toEqual(['provider.failover', 'request.aborted']);
    } finally {
      retryTiming.random = () => 0.2;
    }
  });

  it('never retries a stream that failed after its first byte reached the client', async () => {
    await setRetries('primary', 3);
    upstreams.set(PRIMARY, () => {
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) { controller.error(new Error('upstream reset')); return; }
          sent = true;
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    upstreams.set(SECONDARY, () => completion('must not be used'));

    const response = await chat({ payload: { stream: true }, headers: { 'idempotency-key': 'stream' } });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('partial');
    await reader.read().catch(() => undefined);

    await vi.waitFor(async () => expect((await latestTrace()).outcome).toBe('STREAM_FAILED'));
    const trace = await latestTrace();
    expect(JSON.parse(trace.responseMetaJson ?? '{}')).toMatchObject({ streamPhase: 'mid-stream', reachedClient: true, retrySafe: false });
    expect(calls).toEqual([PRIMARY]);
    expect(sleeps).toEqual([]);
    expect(deriveTraceAttempts(trace, trace.events)).toEqual([{ providerId: providerIds.primary, attempt: 1, status: 200, failover: false, outcome: 'stream_failed' }]);
  });
});

describe('execution-linked traces', () => {
  const traces = (query: string) => admin.request('/api/traces' + query, { headers: { cookie } });
  const root = 'hx1:studio:lab:request:req-1';
  const task = 'hx1:ardent:node1.agent-a:task:task-1';
  const self = 'hx1:ardent:node1.agent-a:attempt:task-1/2/1';

  it('records the execution, the client request id and traceparent, and returns failover attempts by executionRoot', async () => {
    upstreams.set(PRIMARY, () => unavailable());
    upstreams.set(SECONDARY, () => completion('from secondary'));
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

    const response = await chat({ key: actorKey, headers: {
      'x-hive-execution': execution({ request_id: 'studio-req-1', root, parent: task, self, attempt: 1 }),
      'x-request-id': 'ardent-call-7',
      traceparent,
    } });
    expect(response.status).toBe(200);
    // The gateway still generates its own request id.
    expect(response.headers.get('x-request-id')).not.toBe('ardent-call-7');

    const stored = await latestTrace();
    expect(stored).toMatchObject({
      actorId: 'agent-a', executionRootRef: root, executionSelfRef: self, executionParentRef: task,
      clientRequestId: 'ardent-call-7', inboundTraceparent: traceparent,
    });
    expect(JSON.parse(stored.executionJson!)).toEqual({ v: 1, request_id: 'studio-req-1', root, parent: task, self, attempt: 1 });

    const listed = await traces('?executionRoot=' + encodeURIComponent(root));
    expect(listed.status).toBe(200);
    const page = contracts.tracePageSchema.parse(await listed.json());
    expect(page.nextCursor).toBeNull();
    expect(page.data).toHaveLength(1);
    const row = page.data[0]!;
    expect(row.requestId).toBe(stored.requestId);
    expect(row).not.toHaveProperty('executionRootRef');
    expect(row.execution).toEqual({ root, self, parent: task, clientRequestId: 'ardent-call-7', inboundTraceparent: traceparent,
      attempt: 1, deadlineMs: null, assertedBy: null, context: { v: 1, request_id: 'studio-req-1', root, parent: task, self, attempt: 1 } });
    expect(row.attempts).toEqual([
      { providerId: providerIds.primary, attempt: 1, status: 503, failover: true, outcome: 'http_error' },
      { providerId: providerIds.secondary, attempt: 1, status: 200, failover: false, outcome: 'succeeded' },
    ]);

    for (const query of ['?executionTask=' + encodeURIComponent(task), '?executionTask=' + encodeURIComponent('hx1:ardent:node1.agent-a:attempt:task-1/'),
      '?executionParent=' + encodeURIComponent(task)]) {
      const body = contracts.tracePageSchema.parse(await (await traces(query)).json());
      expect(body.data.map((trace) => trace.id), query).toEqual([stored.id]);
    }
    const other = contracts.tracePageSchema.parse(await (await traces('?executionTask=' + encodeURIComponent('hx1:ardent:node1.agent-a:task:task-10'))).json());
    expect(other.data).toEqual([]);
  });

  it('records a disagreeing Ardent instance as client-asserted without rejecting the request', async () => {
    upstreams.set(PRIMARY, () => completion('ok'));
    const response = await chat({ key: actorKey, headers: {
      'x-hive-execution': execution({ root: 'hx1:studio:lab:request:req-2', self: 'hx1:ardent:node1.agent-b:attempt:task-2/1/1' }),
    } });
    expect(response.status).toBe(200);
    const stored = await latestTrace();
    expect(stored.actorId).toBe('agent-a');
    expect(JSON.parse(stored.executionJson!)).toMatchObject({ asserted_by: 'client' });
  });

  it('ignores an invalid execution header and stores null columns without headers; the actor view is unchanged', async () => {
    upstreams.set(PRIMARY, () => completion('ok'));
    expect((await chat({ key: actorKey, headers: { 'x-hive-execution': 'not-base64-json', 'x-request-id': 'has spaces' } })).status).toBe(200);
    const invalid = await latestTrace();
    expect((await chat({ key: actorKey })).status).toBe(200);
    const plain = await latestTrace();
    for (const trace of [invalid, plain]) {
      expect(trace).toMatchObject({ executionRootRef: null, executionSelfRef: null, executionParentRef: null, clientRequestId: null, inboundTraceparent: null, executionJson: null });
    }

    for (const query of ['?actorId=agent-a', '']) {
      const body = await (await traces(query)).json() as { data: Record<string, unknown>[] };
      const row = body.data.find((trace) => trace.id === plain.id)!;
      expect(row).toBeDefined();
      for (const key of ['execution', 'attempts', 'executionRootRef', 'executionSelfRef', 'executionParentRef', 'clientRequestId', 'inboundTraceparent', 'executionJson']) {
        expect(row, query + ' ' + key).not.toHaveProperty(key);
      }
      expect(row).toMatchObject({ actorId: 'agent-a', requestId: plain.requestId });
    }
  });

  it('rejects malformed execution filters with the existing validation error', async () => {
    for (const query of ['?executionRoot=not-a-ref', '?executionParent=hx1:ardent', '?executionTask=' + 'x'.repeat(20)]) {
      expect((await traces(query)).status, query).toBe(400);
    }
  });
});

describe('capabilities', () => {
  it('advertises execution traces and the retry signal on both planes', async () => {
    for (const app of [api, admin]) {
      const body = await (await app.request('/health')).json() as { capabilities?: string[] };
      expect(body.capabilities).toEqual(['emberpath.execution-trace.v1', 'retry-signal.v1']);
    }
  });
});
