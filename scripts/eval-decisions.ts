import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { createHash } from 'node:crypto';
import { classifyLlamaEvaluation, evaluationSystemPrompt, evaluationOutputSchema } from './lib/llamacpp-decision-eval.js';
import { classifyTypeSafeDecision, TYPESAFE_DECISION_ENDPOINT, TYPESAFE_DECISION_MODEL } from '../src/routing/typesafe.js';
import { decisionObservations, decisionResponseSchema, decisionQuestions, DECISION_MODEL } from '../src/routing/decisioning.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = process.env.HIVE_ROUTER_EVAL_ENV_FILE ?? resolve(root, '.env');
const env = { ...(existsSync(envFile) ? parse(readFileSync(envFile)) : {}), ...process.env };
const provider = env.EVAL_PROVIDER ?? 'openrouter';
if (!['openrouter', 'llamacpp', 'typesafe'].includes(provider)) throw new Error('EVAL_PROVIDER must be openrouter, llamacpp, or typesafe');
if (provider === 'openrouter' && !env.HIVE_ROUTER_OPENROUTER_KEY) throw new Error('HIVE_ROUTER_OPENROUTER_KEY is required');
if (provider === 'typesafe' && !env.HIVE_TYPESAFE_AI_KEY) throw new Error('HIVE_TYPESAFE_AI_KEY is required');
const llamaBaseUrl = env.LLAMACPP_BASE_URL;
if (provider === 'llamacpp' && !llamaBaseUrl) throw new Error('LLAMACPP_BASE_URL is required (include /v1)');
const thinking = env.LLAMACPP_THINKING ?? 'off';
if (thinking !== 'off' && thinking !== 'low') throw new Error('LLAMACPP_THINKING must be off or low');
const maxTokens = Number(env.EVAL_MAX_TOKENS ?? (thinking === 'low' ? 2048 : 256));
if (!Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > 8192) throw new Error('Invalid output token limit');
const timeoutMs = Number(env.EVAL_TIMEOUT_MS ?? 30_000);
if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 180_000) throw new Error('Invalid timeout');
let model = provider === 'typesafe' ? env.HIVE_TYPESAFE_AI_MODEL ?? TYPESAFE_DECISION_MODEL : env.HIVE_ROUTER_DECISION_MODEL ?? DECISION_MODEL;
let discoveredModels: unknown;
if (provider === 'llamacpp') {
  const response = await fetch(`${llamaBaseUrl!.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(10_000), headers: env.LLAMACPP_API_KEY ? { Authorization: `Bearer ${env.LLAMACPP_API_KEY}` } : {} });
  if (!response.ok) throw new Error(`Model discovery HTTP ${response.status}`);
  const body = await response.json() as { data?: { id: string }[] };
  discoveredModels = body;
  model = env.LLAMACPP_MODEL ?? (body.data?.length === 1 ? body.data[0]!.id : '');
  if (!model || !body.data?.some(item => item.id === model)) throw new Error('Select a discovered LLAMACPP_MODEL');
}
const fixturesPath = resolve(root, process.env.EVAL_FIXTURES ?? 'services/hive-router/tests/fixtures/decisions.json');
const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8')) as Array<{ id: string; group: string; state: unknown; expected: { profile?: string; injection: boolean; nsfw: boolean } }>;
const limit = Number(process.env.EVAL_LIMIT ?? fixtures.length);
const repeats = Number(process.env.EVAL_REPEATS ?? 1);
if (!Number.isInteger(limit) || limit < 1 || limit > fixtures.length || !Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error('Invalid evaluation bounds');
const rows = [];
const evaluationStartedAt = new Date().toISOString();
const evaluationStarted = performance.now();
for (let repeat = 1; repeat <= repeats; repeat++) {
  for (const fixture of fixtures.slice(0, limit)) {
    const started = performance.now();
    try {
      const body = fixture.state && typeof fixture.state === 'object' && 'messages' in fixture.state
        ? fixture.state : { messages: [{ role: 'user', content: typeof fixture.state === 'string' ? fixture.state : JSON.stringify(fixture.state) }] };
      let result;
      let transport;
      if (provider === 'llamacpp') {
        const evaluated = await classifyLlamaEvaluation(body, { baseUrl: llamaBaseUrl!, model, timeoutMs, thinking, maxTokens, apiKey: env.LLAMACPP_API_KEY });
        result = evaluated.result;
        transport = evaluated.transport;
      } else if (provider === 'typesafe') {
        result = await classifyTypeSafeDecision(body, { apiKey: env.HIVE_TYPESAFE_AI_KEY!, model, timeoutMs });
      } else {
        const observations = await decisionObservations({ requestId: fixture.id, method: 'POST', path: '/v1/chat/completions', queryString: '', endpointKind: 'v1.chat.completions', routeKey: 'eval', model: 'standard', stream: false, toolsRequested: false, jsonSchemaRequested: false, modalities: [], headers: {}, requestBodyJson: body }, { apiKey: env.HIVE_ROUTER_OPENROUTER_KEY!, model, timeoutMs });
        const details = JSON.parse(observations[0]?.details ?? '{}') as Record<string, unknown>;
        if (details.status !== 'ok') throw new Error(typeof details.reason === 'string' ? details.reason : 'decision_unavailable');
        result = decisionResponseSchema.parse(details);
      }
      const actual = { profile: result.answers.profile.choice, injection: result.answers.injection.noul >= 0.5, nsfw: result.answers.nsfw.noul >= 0.5 };
      const failures = Object.entries(fixture.expected).filter(([key, value]) => actual[key as keyof typeof actual] !== value).map(([key]) => key);
      rows.push({ ...fixture, repeat, actual, failures, result, transport, durationMs: Math.round(performance.now() - started) });
      console.log(`${fixture.id} ${failures.length ? 'FAIL:' + failures.join(',') : 'PASS'} ${Math.round(performance.now() - started)}ms`);
    } catch (error) {
      const reason = error instanceof Error && /^decision_[a-z_0-9]+$/.test(error.message) ? error.message : 'decision_unavailable';
      rows.push({ ...fixture, repeat, error: reason, durationMs: Math.round(performance.now() - started) });
      console.log(`${fixture.id} ERROR ${reason}`);
    }
  }
}
const durationMs = Math.round(performance.now() - evaluationStarted);
const latencies = rows.map(row => row.durationMs).sort((a, b) => a - b);
const summary = { total: rows.length, errors: rows.filter(r => 'error' in r).length, passed: rows.filter(r => 'failures' in r && !r.failures.length).length, cost: provider !== 'openrouter' ? null : rows.reduce((sum, r) => sum + ('result' in r ? r.result.usage.cost ?? 0 : 0), 0), durationMs, medianMs: latencies.length % 2 ? latencies[Math.floor(latencies.length / 2)] : (latencies[latencies.length / 2 - 1]! + latencies[latencies.length / 2]!) / 2, p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1], maxMs: latencies.at(-1) };
const output = resolve(process.env.EVAL_OUTPUT ?? resolve(root, `output/${provider === 'openrouter' ? 'jev' : provider}-decisions-eval.json`));
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ timestamp: new Date().toISOString(), evaluationStartedAt, provider, path: provider === 'llamacpp' ? 'llama.cpp structured chat evaluation / same normalized messages' : provider === 'typesafe' ? 'TypeSafe systemone / same normalized messages' : 'decisionObservations / chat-completions prompt extraction', model, ...(provider === 'typesafe' ? { endpoint: TYPESAFE_DECISION_ENDPOINT } : {}), ...(provider === 'llamacpp' ? { endpoint: llamaBaseUrl, discoveredModels, generation: { temperature: 0, seed: 42, max_tokens: maxTokens, enable_thinking: thinking === 'low', reasoning_effort: thinking === 'low' ? 'low' : null, reasoning_format: thinking === 'low' ? 'deepseek' : null, timeoutMs }, systemPromptSha256: createHash('sha256').update(evaluationSystemPrompt).digest('hex'), outputSchema: evaluationOutputSchema } : {}), questionsSha256: createHash('sha256').update(JSON.stringify(decisionQuestions)).digest('hex'), fixturesSha256: createHash('sha256').update(readFileSync(fixturesPath)).digest('hex'), threshold: 0.5, summary, rows }, null, 2));
console.log(JSON.stringify({ summary, output }));
process.exitCode = summary.errors || summary.passed !== summary.total ? 1 : 0;
