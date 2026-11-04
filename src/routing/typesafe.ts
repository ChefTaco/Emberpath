import { decisionQuestions, decisionResponseSchema, MAX_DECISION_INPUT_BYTES, type DecisionResponse } from './decisioning.js';

export const TYPESAFE_DECISION_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const TYPESAFE_DECISION_MODEL = 'jev-latest';
export interface TypeSafeDecisionConfig { apiKey: string; model?: string; timeoutMs?: number }

/** Direct TypeSafe transport. Callers supply only the TypeSafe key, never an OpenRouter key. */
export async function classifyTypeSafeDecision(state: unknown, config: TypeSafeDecisionConfig, signal?: AbortSignal): Promise<DecisionResponse> {
  const serialized = JSON.stringify(state);
  if (!serialized || Buffer.byteLength(serialized) > MAX_DECISION_INPUT_BYTES) throw new Error('decision_input_limit');
  const timeout = AbortSignal.timeout(config.timeoutMs ?? 10_000);
  const response = await fetch(TYPESAFE_DECISION_ENDPOINT, {
    method: 'POST', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model ?? TYPESAFE_DECISION_MODEL, state, questions: decisionQuestions }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`decision_http_${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('decision_empty_response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 64_000) { await reader.cancel(); throw new Error('decision_response_limit'); }
    chunks.push(chunk.value);
  }
  let parsed;
  try { parsed = decisionResponseSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch { throw new Error('decision_invalid_response'); }
  if (!parsed.success) throw new Error('decision_invalid_response');
  return { ...parsed.data, provider: 'typesafe' };
}
