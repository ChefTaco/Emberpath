import { describe, expect, it } from 'vitest';
import { ProviderKind, type Provider } from '../../src/generated/prisma/client.js';
import { parseProviderRuntime } from '../../src/providers/runtime.js';
import type { ProviderRuntime } from '../../src/providers/types.js';
import { decisionsRequestSchema, summarizeDecisionsRequest, type DecisionsRequest } from '../../src/decisions-api/schema.js';
import { translateJevResponse, translateRequestToJev, type JevTranslation } from '../../src/decisions-api/jev-translate.js';
import { decisionsBackendFor, nativeDecisionsModel, planDecisions } from '../../src/decisions-api/backends.js';
import { decisionsUsageSnapshot, jevEndpointFor } from '../../src/decisions-api/execute.js';

const request = (overrides: Partial<DecisionsRequest> = {}): DecisionsRequest => decisionsRequestSchema.parse({
  model: 'decision',
  input: 'I was charged twice for my subscription this month.',
  questions: [
    { type: 'predicate', name: 'is_billing', instructions: 'Is this message about billing?' },
    { type: 'choice', instructions: 'Which team should handle it?', choices: [{ value: 'billing', description: 'Payments and invoices' }, { value: 'support' }] },
    { type: 'score', name: 'urgency', instructions: 'How urgent is it?', levels: [{ label: 'low' }, { label: 'medium', description: 'Needs a reply today' }, { label: 'high' }] },
  ],
  ...overrides,
});

function translated(body: DecisionsRequest): JevTranslation {
  const result = translateRequestToJev(body, 'jev-latest');
  if (!result.ok) throw new Error(result.reason);
  return result.translation;
}

let sequence = 0;
function runtime(kind: ProviderKind, capabilities: Record<string, unknown> = {}, overrides: Partial<Provider> = {}): ProviderRuntime {
  sequence += 1;
  const now = new Date('2026-11-01T00:00:00Z');
  return { ...parseProviderRuntime({
    id: `provider-${sequence}`, slug: `provider-${sequence}`, name: `Provider ${sequence}`, kind, baseUrl: 'https://provider.example.com/v1',
    authMode: 'BEARER', authHeaderName: 'Authorization', encryptedAuthSecret: null, defaultHeadersJson: '{}', capabilityJson: JSON.stringify(capabilities),
    passthroughJson: '[]', tlsInsecure: false, timeoutMs: 1000, maxRetries: 0, concurrency: 4, priority: 100, weight: 100, failoverGroup: null, enabled: true,
    lastHealthStatus: null, lastHealthError: null, lastHealthAt: null, createdAt: now, updatedAt: now, ...overrides,
  }), authSecret: 'synthetic-provider-key' };
}
const typesafe = () => runtime(ProviderKind.OPENAI_GENERIC, { supportedRoutes: ['v1.decisions'], tags: ['jev-decisions'] });
const openrouter = () => runtime(ProviderKind.OPENROUTER, { supportedRoutes: ['v1.decisions'], tags: ['jev-decisions'] });
const openai = () => runtime(ProviderKind.OPENAI);

describe('request validation', () => {
  it('accepts the documented shapes and keeps unknown fields for the OpenAI backend', () => {
    const body = decisionsRequestSchema.parse({ model: 'gpt-6-luna', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], questions: [{ type: 'predicate', instructions: 'x' }], future_field: 1 });
    expect(body).toMatchObject({ future_field: 1 });
  });

  it.each([
    [{ questions: [] }, 'questions'],
    [{ questions: Array.from({ length: 401 }, () => ({ type: 'predicate', instructions: 'x' })) }, 'questions'],
    [{ questions: [{ type: 'choice', instructions: 'x' }] }, 'choices'],
    [{ questions: [{ type: 'choice', instructions: 'x', choices: [{ value: 'only' }] }] }, 'choices'],
    [{ questions: [{ type: 'score', instructions: 'x', levels: Array.from({ length: 11 }, (_, index) => ({ label: `${index}` })) }] }, 'levels'],
    [{ questions: [{ type: 'predicate', instructions: 'x', levels: [{ label: 'a' }, { label: 'b' }] }] }, 'levels'],
    [{ questions: [{ type: 'ranking', instructions: 'x' }] }, 'type'],
    [{ stream: true }, 'stream'],
    [{ model: '' }, 'model'],
  ])('rejects %j', (overrides, path) => {
    const result = decisionsRequestSchema.safeParse({ model: 'decision', input: 'x', questions: [{ type: 'predicate', instructions: 'x' }], ...overrides });
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((issue) => issue.path.join('.')).join(' ')).toContain(path);
  });

  it('summarizes counts and types only, never question or input text', () => {
    const summary = summarizeDecisionsRequest(request({ input: [{ role: 'user', content: 'secret words' }, { type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' }] }));
    expect(summary).toEqual({ questionCount: 3, questionTypes: { predicate: 1, choice: 1, score: 1 }, input: { kind: 'items', items: 2, itemTypes: { message: 1, function_call: 1 } }, promptCache: false, safetyIdentifier: false });
    expect(JSON.stringify(summary)).not.toMatch(/billing|urgent|secret/u);
  });
});

describe('OpenAI to Jev request translation', () => {
  it('builds a name-keyed question map, generating stable names for unnamed questions', () => {
    const { body, mappings } = translated(request());
    expect(body).toEqual({
      model: 'jev-latest',
      state: 'I was charged twice for my subscription this month.',
      questions: {
        is_billing: { type: 'noul', instructions: 'Is this message about billing?' },
        question_2: { type: 'choice', instructions: 'Which team should handle it?', criteria: { billing: 'Payments and invoices', support: null } },
        urgency: { type: 'score', instructions: 'How urgent is it?', criteria: ['low', 'medium: Needs a reply today', 'high'] },
      },
    });
    expect(mappings.map((mapping) => mapping.key)).toEqual(['is_billing', 'question_2', 'urgency']);
    expect(translated(request()).body).toEqual(body);
  });

  it('never drops or merges questions with duplicate, unusable or colliding names', () => {
    const { body, mappings } = translated(request({ questions: [
      { type: 'predicate', name: 'dup', instructions: 'a' },
      { type: 'predicate', name: 'dup', instructions: 'b' },
      { type: 'predicate', name: 'has space', instructions: 'c' },
      { type: 'predicate', name: 'question_4', instructions: 'd' },
      { type: 'predicate', instructions: 'e' },
    ] }));
    expect(Object.keys(body.questions)).toHaveLength(5);
    expect(mappings.map((mapping) => mapping.key)).toEqual(['dup', 'question_2', 'question_3', 'question_4', 'question_5']);
  });

  it('maps boolean choices to string criteria and refuses ambiguous ones', () => {
    const boolean = translated(request({ questions: [{ type: 'choice', instructions: 'ok?', choices: [{ value: true, description: 'yes' }, { value: false }] }] }));
    expect(boolean.body.questions.question_1).toEqual({ type: 'choice', instructions: 'ok?', criteria: { true: 'yes', false: null } });
    const ambiguous = translateRequestToJev(request({ questions: [{ type: 'choice', instructions: 'ok?', choices: [{ value: true }, { value: 'true' }] }] }), 'jev-latest');
    expect(ambiguous).toMatchObject({ ok: false, reason: expect.stringContaining('cannot distinguish') });
  });

  it('turns input items into a message state and keeps input_json data', () => {
    const { body } = translated(request({ input: [
      { role: 'developer', content: 'Classify support mail.' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Invoice attached' }, { type: 'input_json', data: { invoice: 42 } }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Noted.' }], phase: 'final_answer' },
    ] }));
    expect(body.state).toEqual({ messages: [
      { role: 'developer', content: 'Classify support mail.' },
      { role: 'user', content: ['Invoice attached', { type: 'json', data: { invoice: 42 } }] },
      { role: 'assistant', content: 'Noted.', phase: 'final_answer' },
    ] });
  });

  it.each([
    ['input_image', { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://images.example.com/a.png', detail: 'auto' }] }] }, 'input_image'],
    ['function_call', { input: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' }] }, 'function_call'],
    ['function_call_output', { input: [{ type: 'function_call_output', call_id: 'c', output: 'x' }] }, 'function_call_output'],
    ['custom_tool_call', { input: [{ type: 'custom_tool_call', call_id: 'c', name: 'f', input: 'x' }] }, 'custom_tool_call'],
    ['custom_tool_call_output', { input: [{ type: 'custom_tool_call_output', call_id: 'c', output: 'x' }] }, 'custom_tool_call_output'],
    ['prompt_cache_key', { prompt_cache_key: 'tenant-a' }, 'prompt_cache'],
    ['prompt_cache_options', { prompt_cache_options: { mode: 'explicit', ttl: '30m' } }, 'prompt_cache'],
    ['prompt_cache_breakpoint', { input: [{ role: 'user', content: [{ type: 'input_text', text: 'x', prompt_cache_breakpoint: { type: 'ephemeral' } }] }] }, 'prompt_cache_breakpoint'],
    ['safety_identifier', { safety_identifier: 'user-hash' }, 'safety_identifier'],
    ['unknown top-level field', { future_field: 1 }, 'future_field'],
  ])('reports %s as unsupported instead of dropping it', (_label, overrides, feature) => {
    const result = translateRequestToJev(request(overrides as Partial<DecisionsRequest>), 'jev-latest');
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining(feature) });
  });
});

describe('Jev to OpenAI response translation', () => {
  const jevAnswers = {
    model: 'jev-1.13.0',
    answers: {
      urgency: { type: 'score', score: 1.2, confidence: 0.6, legend: { 0: 'low', 1: 'medium', 2: 'high' }, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 } },
      is_billing: { type: 'noul', noul: 0.97 },
      question_2: { type: 'choice', choice: 'billing', confidence: 0.9, probabilities: { billing: 0.9, support: 0.1 } },
    },
    usage: { input_tokens: 120, output_tokens: 9 },
  };

  it('returns answers in question order with OpenAI shapes and usage', () => {
    expect(translateJevResponse(jevAnswers, translated(request()))).toEqual({
      model: 'jev-1.13.0',
      answers: [
        { type: 'predicate', name: 'is_billing', probability: 0.97 },
        { type: 'choice', name: null, choice: 'billing', confidence: 0.9, probabilities: [{ value: 'billing', probability: 0.9 }, { value: 'support', probability: 0.1 }] },
        { type: 'score', name: 'urgency', score: 1.2, confidence: 0.6, probabilities: [{ label: 'low', probability: 0.1, value: 0 }, { label: 'medium', probability: 0.6, value: 1 }, { label: 'high', probability: 0.3, value: 2 }] },
      ],
      usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 129 },
    });
  });

  it('restores boolean choice values', () => {
    const translation = translated(request({ questions: [{ type: 'choice', name: 'ok', instructions: 'ok?', choices: [{ value: true }, { value: false }] }] }));
    const response = translateJevResponse({ model: 'jev', answers: { ok: { type: 'choice', choice: 'false', confidence: 0.8, probabilities: { true: 0.2, false: 0.8 } } }, usage: { input_tokens: 1, output_tokens: 1 } }, translation);
    expect(response.answers[0]).toEqual({ type: 'choice', name: 'ok', choice: false, confidence: 0.8, probabilities: [{ value: true, probability: 0.2 }, { value: false, probability: 0.8 }] });
  });

  it.each([
    ['a missing answer', { ...jevAnswers, answers: { is_billing: jevAnswers.answers.is_billing, question_2: jevAnswers.answers.question_2 } }],
    ['a mismatched type', { ...jevAnswers, answers: { ...jevAnswers.answers, is_billing: jevAnswers.answers.question_2 } }],
    ['a choice that was not offered', { ...jevAnswers, answers: { ...jevAnswers.answers, question_2: { type: 'choice', choice: 'sales', confidence: 1, probabilities: {} } } }],
    ['an out-of-range probability', { ...jevAnswers, answers: { ...jevAnswers.answers, is_billing: { type: 'noul', noul: 2 } } }],
    ['no usage', { model: 'jev', answers: jevAnswers.answers }],
  ])('rejects %s', (_label, raw) => {
    expect(() => translateJevResponse(raw, translated(request()))).toThrow();
  });
});

describe('backend eligibility and fallthrough', () => {
  it('serves decisions from OpenAI by default and from other kinds only when opted in', () => {
    expect(decisionsBackendFor(openai())).toBe('openai');
    expect(decisionsBackendFor(typesafe())).toBe('typesafe-jev');
    expect(decisionsBackendFor(openrouter())).toBe('openrouter-jev');
    expect(decisionsBackendFor(runtime(ProviderKind.OPENAI_GENERIC, { supportedRoutes: ['v1.decisions'] }))).toBe('openai');
    expect(decisionsBackendFor(runtime(ProviderKind.OPENROUTER))).toBeUndefined();
    expect(decisionsBackendFor(runtime(ProviderKind.OPENAI_GENERIC))).toBeUndefined();
    for (const kind of [ProviderKind.CODEX, ProviderKind.ANTHROPIC, ProviderKind.OLLAMA, ProviderKind.LLAMACPP, ProviderKind.VLLM]) {
      expect(decisionsBackendFor(runtime(kind, { supportedRoutes: ['v1.decisions'] })), kind).toBeUndefined();
    }
  });

  it('maps model names per backend', () => {
    expect(nativeDecisionsModel('openai', 'gpt-6-luna')).toBe('gpt-6-luna');
    expect(nativeDecisionsModel('openai', 'jev-latest')).toBeUndefined();
    expect(nativeDecisionsModel('typesafe-jev', 'jev-latest')).toBe('jev-latest');
    expect(nativeDecisionsModel('typesafe-jev', '~typesafe/jev-latest')).toBe('jev-latest');
    expect(nativeDecisionsModel('typesafe-jev', 'gpt-6-luna')).toBeUndefined();
    expect(nativeDecisionsModel('openrouter-jev', 'jev-latest')).toBe('~typesafe/jev-latest');
    expect(nativeDecisionsModel('openrouter-jev', 'jev-1.13.0')).toBeUndefined();
  });

  it('puts Jev first for the decision alias and keeps gpt-6-luna as the alternative', () => {
    const [luna, jev, router] = [openai(), typesafe(), openrouter()];
    const plan = planDecisions(request(), [luna, jev, router], { model: 'jev-latest', viaAlias: true });
    expect(plan.entries.map((entry) => [entry.provider.id, entry.backend, entry.model])).toEqual([
      [jev.id, 'typesafe-jev', 'jev-latest'],
      [router.id, 'openrouter-jev', '~typesafe/jev-latest'],
      [luna.id, 'openai', 'gpt-6-luna'],
    ]);
    expect(plan.rejections).toEqual([]);
  });

  it('serves a direct model name only from backends that know it', () => {
    const [luna, jev] = [openai(), typesafe()];
    expect(planDecisions(request({ model: 'gpt-6-luna' }), [jev, luna], { model: 'gpt-6-luna', viaAlias: false }).entries.map((entry) => entry.provider.id)).toEqual([luna.id]);
    const direct = planDecisions(request({ model: 'jev-latest' }), [luna, jev], { model: 'jev-latest', viaAlias: false });
    expect(direct.entries.map((entry) => entry.provider.id)).toEqual([jev.id]);
    expect(direct.rejections).toEqual([{ provider: luna.slug, backend: 'openai', kind: 'model', reason: expect.stringContaining('jev-latest') }]);
  });

  it('falls through to OpenAI when Jev cannot express a feature, naming the feature', () => {
    const [luna, jev] = [openai(), typesafe()];
    const body = request({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }] });
    const plan = planDecisions(body, [jev, luna], { model: 'jev-latest', viaAlias: true });
    expect(plan.entries.map((entry) => entry.provider.id)).toEqual([luna.id]);
    expect(plan.rejections).toEqual([{ provider: jev.slug, backend: 'typesafe-jev', kind: 'feature', reason: expect.stringContaining('input_image') }]);
  });

  it('rejects CODEX and providers without a stored key', () => {
    const codex = runtime(ProviderKind.CODEX, { supportedRoutes: ['v1.decisions'] });
    const keyless = { ...typesafe(), authSecret: undefined };
    const plan = planDecisions(request(), [codex, keyless], { model: 'jev-latest', viaAlias: true });
    expect(plan.entries).toEqual([]);
    expect(plan.rejections.map((rejection) => rejection.kind)).toEqual(['provider', 'provider']);
  });

  it('derives the Jev endpoints from provider base URLs', () => {
    expect(jevEndpointFor({ backend: 'typesafe-jev', provider: { ...typesafe(), baseUrl: 'https://api.typesafe.ai/v1' } })).toBe('https://api.typesafe.ai/v1/systemone');
    expect(jevEndpointFor({ backend: 'typesafe-jev', provider: { ...typesafe(), baseUrl: 'https://api.typesafe.ai/' } })).toBe('https://api.typesafe.ai/v1/systemone');
    expect(jevEndpointFor({ backend: 'openrouter-jev', provider: { ...openrouter(), baseUrl: 'https://openrouter.ai/api/v1' } })).toBe('https://openrouter.ai/api/alpha/decisions');
  });
});

describe('usage accounting', () => {
  it('maps OpenAI usage, including cache and reasoning details', () => {
    expect(decisionsUsageSnapshot({ input_tokens: 100, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 }, output_tokens: 6, output_tokens_details: { reasoning_tokens: 4 }, total_tokens: 106 }))
      .toEqual({ inputTokens: 100, outputTokens: 6, totalTokens: 106, reasoningTokens: 4, cachedInputTokens: 40, cacheWriteInputTokens: 10 });
    expect(decisionsUsageSnapshot({ input_tokens: 5, output_tokens: 1 })).toMatchObject({ totalTokens: 6 });
    expect(decisionsUsageSnapshot(undefined)).toBeUndefined();
    expect(decisionsUsageSnapshot({ input_tokens: -1 })).toBeUndefined();
  });
});
