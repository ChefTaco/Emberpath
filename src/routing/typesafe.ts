import { postJevDecision } from './jev-transport.js';
import { decisionQuestions, decisionResponseSchema, MAX_DECISION_INPUT_BYTES, type DecisionResponse } from './decisioning.js';

export const TYPESAFE_DECISION_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const TYPESAFE_DECISION_MODEL = 'jev-latest';
export interface TypeSafeDecisionConfig { apiKey: string; model?: string; timeoutMs?: number }

/** Direct TypeSafe transport. Callers supply only the TypeSafe key, never an OpenRouter key. */
export async function classifyTypeSafeDecision(state: unknown, config: TypeSafeDecisionConfig, signal?: AbortSignal): Promise<DecisionResponse> {
  const serialized = JSON.stringify(state);
  if (!serialized || Buffer.byteLength(serialized) > MAX_DECISION_INPUT_BYTES) throw new Error('decision_input_limit');
  const { text } = await postJevDecision(TYPESAFE_DECISION_ENDPOINT, { model: config.model ?? TYPESAFE_DECISION_MODEL, state, questions: decisionQuestions }, {
    apiKey: config.apiKey, timeoutMs: config.timeoutMs ?? 10_000, maxResponseBytes: 64_000, signal,
  });
  let parsed;
  try { parsed = decisionResponseSchema.safeParse(JSON.parse(text)); }
  catch { throw new Error('decision_invalid_response'); }
  if (!parsed.success) throw new Error('decision_invalid_response');
  return { ...parsed.data, provider: 'typesafe' };
}
