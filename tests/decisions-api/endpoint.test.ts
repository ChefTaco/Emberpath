// End-to-end POST /v1/decisions against a real SQLite fixture and the real API
// app, with every upstream (OpenAI, TypeSafe, OpenRouter) mocked at fetch.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const directory = mkdtempSync(join(tmpdir(), 'emberpath-decisions-'));
vi.stubEnv('DATABASE_URL', 'file:' + join(directory, 'router.db'));
vi.stubEnv('HIVE_HOME', directory);
vi.stubEnv('DATA_DIR', directory);
vi.stubEnv('TRACE_DIR', join(directory, 'traces'));
vi.stubEnv('HIVE_ROUTER_SECRET', randomBytes(48).toString('hex'));
vi.stubEnv('CAPTURE_REQUEST_BODIES', 'true');
vi.stubEnv('CAPTURE_RESPONSE_BODIES', 'true');
vi.stubEnv('HIVE_TYPESAFE_AI_KEY', 'synthetic-typesafe-key');
vi.stubEnv('HIVE_ROUTER_OPENROUTER_KEY', 'synthetic-openrouter-key');
vi.stubEnv('EMBERPATH_DECISIONS_JEV_ENABLED', 'true');

const { ensureSqliteSchema } = await import('../../src/storage/schema.js');
await ensureSqliteSchema();
const { prisma } = await import('../../src/storage/client.js');
const { bootstrapStorage } = await import('../../src/storage/bootstrap.js');
const { buildProviderCreateData } = await import('../../src/providers/runtime.js');
const { encryptText, hashValue } = await import('../../src/security/crypto.js');
const { quotaLedger } = await import('../../src/security/quota.js');
const { createApiApp } = await import('../../src/api/app.js');
const { ProviderKind } = await import('../../src/generated/prisma/client.js');
const { resetProviderCircuit } = await import('../../src/api/provider-guards.js');

const TYPESAFE = 'https://api.typesafe.ai/v1/systemone';
const OPENROUTER = 'https://openrouter.ai/api/alpha/decisions';
const OPENAI = 'https://api.openai.example/v1/decisions';

const keys = {
  agent: 'ep-dec-agent-0000000000000000000001',
  quiet: 'ep-dec-quiet-0000000000000000000002',
  readOnly: 'ep-dec-read0-0000000000000000000003',
};
const keyIds: Record<string, string> = {};

const question = 'Is this message about billing?';
const body = (overrides: Record<string, unknown> = {}) => ({
  model: 'decision',
  input: 'I was charged twice for my subscription this month.',
  questions: [
    { type: 'predicate', name: 'is_billing', instructions: question },
    { type: 'choice', instructions: 'Which team?', choices: [{ value: 'billing' }, { value: 'support', description: 'Everything else' }] },
    { type: 'score', name: 'urgency', instructions: 'How urgent?', levels: [{ label: 'low' }, { label: 'high' }] },
  ],
  ...overrides,
});
const jevResponse = { model: 'jev-1.13.0', answers: {
  is_billing: { type: 'noul', noul: 0.96 },
  question_2: { type: 'choice', choice: 'billing', confidence: 0.9, probabilities: { billing: 0.9, support: 0.1 } },
  urgency: { type: 'score', score: 0.8, confidence: 0.8, legend: { 0: 'low', 1: 'high' }, probabilities: { 0: 0.2, 1: 0.8 } },
}, usage: { input_tokens: 120, output_tokens: 9 } };
const openAiResponse = { model: 'gpt-6-luna', answers: [
  { type: 'predicate', name: 'is_billing', probability: 0.97 },
  { type: 'choice', name: null, choice: 'billing', confidence: 0.92, probabilities: [{ value: 'billing', probability: 0.92 }, { value: 'support', probability: 0.08 }] },
  { type: 'refusal', name: 'urgency' },
], usage: { input_tokens: 150, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 153 } };

type Upstream = (init: RequestInit) => Response | Promise<Response>;
const upstreams = new Map<string, Upstream>();
const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
function serve(url: string, handler: Upstream) { upstreams.set(url, handler); }
function resetUpstreams() {
  upstreams.clear(); calls.length = 0;
  serve(TYPESAFE, () => Response.json(jevResponse));
  serve(OPENROUTER, () => Response.json({ ...jevResponse, model: 'typesafe/jev-1.13-20261101' }));
  serve(OPENAI, () => Response.json(openAiResponse));
}

const app = createApiApp();
const post = (payload: unknown, key = keys.agent) => app.request('/v1/decisions', {
  method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(payload),
});
const latestTrace = async () => prisma.trace.findFirstOrThrow({ orderBy: { startedAt: 'desc' }, include: { events: true } });

beforeAll(async () => {
  await bootstrapStorage();
  await prisma.provider.create({ data: buildProviderCreateData({
    slug: 'openai', name: 'OpenAI', kind: ProviderKind.OPENAI, baseUrl: 'https://api.openai.example/v1',
    encryptedAuthSecret: encryptText('synthetic-openai-key'), maxRetries: 0, priority: 50,
    capabilities: { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
  }) });
  const metadata = {
    agent: { actorId: 'decision-agent', quota: { monthlyTokens: 1_000_000 } },
    quiet: { actorId: 'quiet-agent', tracePrivacy: 'metadata-only' },
    readOnly: { scopes: ['models:read'] },
  };
  for (const [name, raw] of Object.entries(keys)) {
    const key = await prisma.clientApiKey.create({ data: { name, keyPrefix: raw.slice(0, 8), keyHash: hashValue(raw), metadataJson: JSON.stringify(metadata[name as keyof typeof metadata]) } });
    keyIds[name] = key.id;
  }
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const handler = upstreams.get(url);
    if (!handler) return realFetch(input, init);
    calls.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return handler(init);
  });
});
afterEach(async () => {
  resetUpstreams();
  for (const provider of await prisma.provider.findMany()) resetProviderCircuit(provider.id);
  await prisma.provider.updateMany({ data: { enabled: true } });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.$disconnect();
  globalThis.__hiveRouterPrisma = undefined;
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
resetUpstreams();

describe('opt-in seeding', () => {
  it('seeds decisions-only Jev provider records and the decision alias on a fresh install', async () => {
    const seeded = await prisma.provider.findMany({ where: { slug: { in: ['typesafe-jev', 'openrouter-jev'] } }, orderBy: { slug: 'asc' } });
    expect(seeded.map((provider) => [provider.slug, provider.kind, provider.priority, JSON.parse(provider.capabilityJson!).supportedRoutes, JSON.parse(provider.capabilityJson!).tags])).toEqual([
      ['openrouter-jev', 'OPENROUTER', 95, ['v1.decisions'], ['jev-decisions']],
      ['typesafe-jev', 'OPENAI_GENERIC', 90, ['v1.decisions'], ['jev-decisions']],
    ]);
    expect(await prisma.modelAlias.findUnique({ where: { alias: 'decision' } })).toMatchObject({ upstreamModel: 'jev-latest', enabled: true, providerId: null });
    expect(await prisma.routeRule.findUnique({ where: { name: 'route-decision-alias' } })).toMatchObject({ enabled: true });
  });

  it('denies the decision alias on chat endpoints', async () => {
    const response = await app.request('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${keys.quiet}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'decision', messages: [{ role: 'user', content: 'hi' }] }) });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain('/v1/decisions only');
  });

  it('never routes chat traffic to the decisions-only Jev records', async () => {
    const response = await app.request('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${keys.quiet}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'jev-latest', messages: [{ role: 'user', content: 'hi' }] }) });
    const trace = await latestTrace();
    const candidates = JSON.parse(trace.decisionJson).candidateProviderIds as string[];
    const jevIds = (await prisma.provider.findMany({ where: { slug: { in: ['typesafe-jev', 'openrouter-jev'] } } })).map((provider) => provider.id);
    expect(candidates.some((id) => jevIds.includes(id))).toBe(false);
    expect(response.status).toBeGreaterThanOrEqual(200);
  });
});

describe('POST /v1/decisions', () => {
  it('serves the decision alias from TypeSafe Jev with translation both ways', async () => {
    const response = await post(body());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      model: 'jev-1.13.0',
      answers: [
        { type: 'predicate', name: 'is_billing', probability: 0.96 },
        { type: 'choice', name: null, choice: 'billing', confidence: 0.9, probabilities: [{ value: 'billing', probability: 0.9 }, { value: 'support', probability: 0.1 }] },
        { type: 'score', name: 'urgency', score: 0.8, confidence: 0.8, probabilities: [{ label: 'low', probability: 0.2, value: 0 }, { label: 'high', probability: 0.8, value: 1 }] },
      ],
      usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 129 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(TYPESAFE);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer synthetic-typesafe-key');
    expect(calls[0]!.body).toEqual({ model: 'jev-latest', state: body().input, questions: {
      is_billing: { type: 'noul', instructions: question },
      question_2: { type: 'choice', instructions: 'Which team?', criteria: { billing: null, support: 'Everything else' } },
      urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'high'] },
    } });

    const trace = await latestTrace();
    expect(trace).toMatchObject({ endpointKind: 'v1.decisions', outcome: 'SUCCEEDED', statusCode: 200, providerModel: 'jev-latest', actorId: 'decision-agent', clientApiKeyId: keyIds.agent, estimatedUsage: false });
    expect(JSON.parse(trace.requestMetaJson!).decisionsApi).toEqual({ questionCount: 3, questionTypes: { predicate: 1, choice: 1, score: 1 }, input: { kind: 'string' }, promptCache: false, safetyIdentifier: false });
    expect(JSON.parse(trace.responseMetaJson!).decisionsApi).toEqual({ backend: 'typesafe-jev', answerTypes: { predicate: 1, choice: 1, score: 1 } });
    expect(trace.requestMetaJson).not.toContain(question);
    expect(trace.responseMetaJson).not.toContain(question);
    expect(JSON.parse(trace.decisionJson).triggeredRuleNames).toContain('route-decision-alias');
  });

  it('counts decisions usage toward the calling client key quota', async () => {
    const before = quotaLedger().usage(keyIds.agent!);
    await post(body());
    const after = quotaLedger().usage(keyIds.agent!);
    expect(after.monthRequests - before.monthRequests).toBe(1);
    expect(after.monthTokens - before.monthTokens).toBe(129);
  });

  it('prices decisions on input tokens only, as OpenAI bills them', async () => {
    expect((await post(body({ model: 'gpt-6-luna' }))).status).toBe(200);
    const trace = await latestTrace();
    const reservation = await prisma.quotaReservation.findUniqueOrThrow({ where: { traceId: trace.id } });
    expect(reservation).toMatchObject({ actualTokens: 153, estimated: false, priceSource: 'operator-declared-provider-prices' });
    expect(reservation.costUsd).toBeCloseTo((150 * 2) / 1_000_000, 12);
  });

  it('fails over from TypeSafe to OpenRouter, then to OpenAI gpt-6-luna', async () => {
    serve(TYPESAFE, () => new Response('{"error":"overloaded"}', { status: 503 }));
    const viaOpenRouter = await post(body());
    expect(viaOpenRouter.status).toBe(200);
    expect((await viaOpenRouter.json()).model).toBe('typesafe/jev-1.13-20261101');
    expect(calls.map((call) => call.url)).toEqual([TYPESAFE, OPENROUTER]);
    expect(calls[1]!.headers.get('authorization')).toBe('Bearer synthetic-openrouter-key');
    expect(calls[1]!.headers.get('x-openrouter-title')).toBe('Emberpath Decisions');
    expect((calls[1]!.body as { model: string }).model).toBe('~typesafe/jev-latest');
    expect((await latestTrace()).events.map((event) => event.type)).toContain('provider.failover');

    calls.length = 0;
    serve(OPENROUTER, () => new Response('{}', { status: 502 }));
    const viaOpenAi = await post(body());
    expect(viaOpenAi.status).toBe(200);
    expect(await viaOpenAi.json()).toEqual(openAiResponse);
    expect(calls.map((call) => call.url)).toEqual([TYPESAFE, OPENROUTER, OPENAI]);
    // Passed through unchanged except for the alias swap.
    expect(calls[2]!.body).toEqual({ ...body(), model: 'gpt-6-luna' });
    expect(calls[2]!.headers.get('authorization')).toBe('Bearer synthetic-openai-key');
    expect((await latestTrace()).providerModel).toBe('gpt-6-luna');
  });

  it('treats an unusable Jev answer as a provider failure and fails over', async () => {
    serve(TYPESAFE, () => Response.json({ ...jevResponse, answers: { is_billing: jevResponse.answers.is_billing } }));
    const response = await post(body());
    expect(response.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([TYPESAFE, OPENROUTER]);
  });

  it('serves features Jev cannot express from OpenAI and records why Jev was skipped', async () => {
    const payload = body({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'see image' }, { type: 'input_image', image_url: 'https://images.example.com/receipt.png', detail: 'auto' }] }] });
    const response = await post(payload);
    expect(response.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([OPENAI]);
    const trace = await latestTrace();
    expect(trace.events.filter((event) => event.type === 'provider.ineligible').map((event) => event.message)).toEqual([
      expect.stringContaining('input_image'), expect.stringContaining('input_image'),
    ]);
    expect(JSON.parse(trace.requestMetaJson!).modalities).toEqual(['image']);
  });

  it('returns 400 naming the feature when no eligible backend remains', async () => {
    await prisma.provider.update({ where: { slug: 'openai' }, data: { enabled: false } });
    const response = await post(body({ input: [{ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' }] }));
    expect(response.status).toBe(400);
    const error = (await response.json()).error;
    expect(error).toMatchObject({ type: 'invalid_request_error', code: 'unsupported_decision_feature' });
    expect(error.message).toContain('function_call');
    expect(calls).toEqual([]);
    expect((await latestTrace()).outcome).toBe('FAILED');
  });

  it('returns 503 when no backend serves the requested model', async () => {
    await prisma.provider.update({ where: { slug: 'openai' }, data: { enabled: false } });
    const response = await post(body({ model: 'gpt-6-luna' }));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatchObject({ code: 'no_decisions_backend', message: expect.stringContaining('gpt-6-luna') });
  });

  it('routes direct model names: gpt-6-luna to OpenAI and jev-latest to Jev', async () => {
    expect((await post(body({ model: 'gpt-6-luna' }))).status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([OPENAI]);
    expect(calls[0]!.body).toEqual(body({ model: 'gpt-6-luna' }));
    calls.length = 0;
    expect((await post(body({ model: 'jev-latest' }))).status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([TYPESAFE]);
  });

  it('passes OpenAI errors through unchanged', async () => {
    const upstreamError = { error: { message: 'Unsupported model', type: 'invalid_request_error', code: 'model_not_found', param: 'model' } };
    serve(OPENAI, () => Response.json(upstreamError, { status: 400 }));
    const response = await post(body({ model: 'gpt-6-luna' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(upstreamError);
  });

  it('validates requests in the OpenAI error format', async () => {
    const response = await post(body({ questions: [{ type: 'choice', instructions: 'x' }] }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({ type: 'invalid_request_error', code: 'invalid_request', param: 'questions.0.choices' });
    const streamed = await post(body({ stream: true }));
    expect(streamed.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('requires a client key with the inference scope', async () => {
    expect((await app.request('/v1/decisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()) })).status).toBe(401);
    expect((await post(body(), keys.readOnly)).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('stores bodies only when the key allows it', async () => {
    await post(body());
    expect((await latestTrace()).requestBodyPath).toBeTruthy();
    await post(body(), keys.quiet);
    const quiet = await latestTrace();
    expect(quiet).toMatchObject({ actorId: 'quiet-agent', requestBodyPath: null, responseBodyPath: null });
    expect(JSON.parse(quiet.requestMetaJson!)).toMatchObject({ captureBodies: false, decisionsApi: { questionCount: 3 } });
  });

  it('never triggers the shadow decision model', async () => {
    await post(body());
    for (const call of calls) expect(JSON.stringify(call.body)).not.toContain('injection');
  });
});
