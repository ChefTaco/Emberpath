import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { jevDecisionObservations } from '../src/routing/jev.js';
import { TYPESAFE_DECISION_ENDPOINT } from '../src/routing/typesafe.js';
import type { RouteRequest } from '../src/providers/types.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const env = { ...parse(readFileSync(resolve(process.env.HIVE_ROUTER_EVAL_ENV_FILE ?? resolve(root, '.env')))), ...process.env };
if (!env.HIVE_TYPESAFE_AI_KEY || !env.HIVE_ROUTER_OPENROUTER_KEY) throw new Error('Both Jev provider keys required');
const config = {
  typesafe: { apiKey: env.HIVE_TYPESAFE_AI_KEY, model: env.HIVE_TYPESAFE_AI_MODEL ?? 'jev-latest', timeoutMs: 10_000 },
  openrouter: { apiKey: env.HIVE_ROUTER_OPENROUTER_KEY, model: env.HIVE_ROUTER_DECISION_MODEL ?? '~typesafe/jev-latest', timeoutMs: 10_000 },
};
const route: RouteRequest = { requestId: 'jev-smoke', method: 'POST', path: '/v1/responses', queryString: '', endpointKind: 'v1.responses', routeKey: 'POST /v1/responses', model: 'standard', stream: false, toolsRequested: false, jsonSchemaRequested: false, modalities: [], headers: {}, requestBodyText: JSON.stringify({ input: 'Write a TypeScript function that sorts an array of numbers ascending.' }) };
const originalFetch = globalThis.fetch;
const results = [];
try {
  for (const forcedDirectFailure of [false, true]) {
    // A local synthetic 503 exercises failover; the fallback call is real and authenticated.
    globalThis.fetch = (input, init) => forcedDirectFailure && String(input) === TYPESAFE_DECISION_ENDPOINT
      ? Promise.resolve(new Response(null, { status: 503 })) : originalFetch(input, init);
    const observations = await jevDecisionObservations(route, config);
    const details = JSON.parse(observations[0]!.details!);
    results.push({ forcedDirectFailure, ...details });
    if (details.status !== 'ok' || details.decisionProvider !== (forcedDirectFailure ? 'openrouter' : 'typesafe')) process.exitCode = 1;
  }
} finally { globalThis.fetch = originalFetch; }
const output = resolve(root, 'output/jev-provider-fallback-smoke.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2) + '\n');
console.log(JSON.stringify({ output, results }, null, 2));
